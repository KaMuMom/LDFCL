use crate::launcher::GameLayout;
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use tempfile::NamedTempFile;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default)]
pub struct Settings {
    #[serde(skip)]
    pub game_directory: Option<PathBuf>,
    pub java_executable: Option<PathBuf>,
    pub added_java_paths: Vec<PathBuf>,
    pub automatic_java: bool,
    pub layout: GameLayout,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            game_directory: None,
            java_executable: None,
            added_java_paths: Vec::new(),
            automatic_java: true,
            layout: GameLayout::Automatic,
        }
    }
}

#[derive(Debug)]
pub struct SettingsStore {
    root: PathBuf,
}

impl SettingsStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn for_current_installation() -> Result<Self> {
        let executable = std::env::current_exe().context("Cannot locate LDFCL executable")?;
        let root = executable
            .parent()
            .context("LDFCL executable has no parent directory")?;
        Ok(Self::new(root))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn load(&self) -> Result<Settings> {
        let config = self.root.join("config");
        let settings_file = config.join("settings.json");
        let game_file = config.join("game-directory.txt");
        let stored = match read_json(&settings_file)? {
            Some(settings) => settings,
            None => self.migrate(&config, &settings_file, &game_file)?,
        };
        Ok(Settings {
            game_directory: read_text(&game_file)?
                .and_then(|value| nonempty_path(value.trim_end_matches(['\r', '\n'])))
                .map(|path| self.resolve(&path)),
            java_executable: stored.java_executable.map(|path| self.resolve(&path)),
            added_java_paths: stored
                .added_java_paths
                .iter()
                .map(|path| self.resolve(path))
                .collect(),
            ..stored
        })
    }

    pub fn save(&self, settings: &Settings) -> Result<()> {
        let config = self.root.join("config");
        let settings_file = config.join("settings.json");
        let game_file = config.join("game-directory.txt");
        let previous = match read_json(&settings_file)? {
            Some(settings) => settings,
            None => self.migrate(&config, &settings_file, &game_file)?,
        };
        let previous_game = read_text(&game_file)?;
        let current_game = previous_game
            .as_deref()
            .and_then(|value| nonempty_path(value.trim_end_matches(['\r', '\n'])))
            .map(|path| self.resolve(&path));
        let stored = self.encode(settings);

        if previous != stored {
            let data =
                serde_json::to_vec_pretty(&stored).context("Cannot encode launcher settings")?;
            atomic_write(&settings_file, &data, true)?;
        }
        if current_game
            != settings
                .game_directory
                .as_deref()
                .map(|path| self.resolve(path))
        {
            write_game_file(&game_file, self, settings.game_directory.as_deref(), true)?;
        }
        Ok(())
    }

    fn migrate(&self, config: &Path, settings_file: &Path, game_file: &Path) -> Result<Settings> {
        let legacy = match read_qt_ini(&config.join("settings.ini"))? {
            Some(settings) => settings,
            None => read_native_settings()?.unwrap_or_default(),
        };
        if let Some(game) = legacy.game_directory.as_deref() {
            if read_text(game_file)?.is_none() {
                write_game_file(game_file, self, Some(game), false)?;
            }
        }

        let stored = self.encode(&legacy);
        let data = serde_json::to_vec_pretty(&stored).context("Cannot encode launcher settings")?;
        if atomic_write(settings_file, &data, false)? {
            Ok(stored)
        } else {
            // Another process completed migration first.
            read_json(settings_file)?.context("Launcher settings disappeared after migration")
        }
    }

    fn resolve(&self, path: &Path) -> PathBuf {
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            self.root.join(path)
        }
    }

    fn encode_path(&self, path: &Path) -> PathBuf {
        if !path.is_absolute() {
            return path.to_path_buf();
        }
        let cleaned = clean_path(path);
        let mut parts = cleaned.components();
        for root in clean_path(&self.root).components() {
            if !parts
                .next()
                .is_some_and(|part| path_component_matches(part, root))
            {
                return path.to_path_buf();
            }
        }
        let relative = parts.as_path();
        if relative.as_os_str().is_empty() {
            PathBuf::from(".")
        } else {
            relative.to_path_buf()
        }
    }

    fn encode(&self, settings: &Settings) -> Settings {
        Settings {
            game_directory: None,
            java_executable: settings
                .java_executable
                .as_deref()
                .map(|path| self.encode_path(path)),
            added_java_paths: settings
                .added_java_paths
                .iter()
                .map(|path| self.encode_path(path))
                .collect(),
            automatic_java: settings.automatic_java,
            layout: settings.layout,
        }
    }
}

fn clean_path(path: &Path) -> PathBuf {
    let mut clean = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir
                if matches!(clean.components().next_back(), Some(Component::Normal(_))) =>
            {
                clean.pop();
            }
            Component::ParentDir if clean.has_root() => {}
            _ => clean.push(part.as_os_str()),
        }
    }
    clean
}

fn path_component_matches(left: Component<'_>, right: Component<'_>) -> bool {
    #[cfg(windows)]
    {
        use std::path::Prefix;

        if let (Component::Prefix(left), Component::Prefix(right)) = (left, right) {
            return match (left.kind(), right.kind()) {
                (
                    Prefix::Disk(a) | Prefix::VerbatimDisk(a),
                    Prefix::Disk(b) | Prefix::VerbatimDisk(b),
                ) => a.eq_ignore_ascii_case(&b),
                (
                    Prefix::UNC(a, b) | Prefix::VerbatimUNC(a, b),
                    Prefix::UNC(c, d) | Prefix::VerbatimUNC(c, d),
                ) => a.eq_ignore_ascii_case(c) && b.eq_ignore_ascii_case(d),
                _ => left == right,
            };
        }
        left.as_os_str().eq_ignore_ascii_case(right.as_os_str())
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

fn nonempty_path(value: &str) -> Option<PathBuf> {
    (!value.is_empty()).then(|| value.into())
}

fn read_text(path: &Path) -> Result<Option<String>> {
    match fs::read_to_string(path) {
        Ok(data) => Ok(Some(
            data.strip_prefix('\u{feff}').unwrap_or(&data).to_owned(),
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error).with_context(|| format!("Cannot read {}", path.display())),
    }
}

fn read_json(path: &Path) -> Result<Option<Settings>> {
    read_text(path)?
        .map(|text| {
            serde_json::from_str(&text)
                .with_context(|| format!("Invalid launcher settings at {}", path.display()))
        })
        .transpose()
}

fn write_game_file(
    path: &Path,
    store: &SettingsStore,
    game: Option<&Path>,
    replace: bool,
) -> Result<()> {
    let encoded = game.map(|path| store.encode_path(path));
    let text = match encoded.as_deref() {
        Some(path) => path
            .to_str()
            .context("Game directory is not valid Unicode")?,
        None => "",
    };
    ensure!(
        !text.ends_with(['\r', '\n']),
        "Game directory cannot end with a line break"
    );
    atomic_write(path, text.as_bytes(), replace)?;
    Ok(())
}

fn atomic_write(path: &Path, data: &[u8], replace: bool) -> Result<bool> {
    let parent = path
        .parent()
        .context("Settings file has no parent directory")?;
    fs::create_dir_all(parent).with_context(|| format!("Cannot create {}", parent.display()))?;
    let mut temp = NamedTempFile::new_in(parent)
        .with_context(|| format!("Cannot create a temporary file in {}", parent.display()))?;
    temp.write_all(data)
        .and_then(|()| temp.as_file().sync_all())
        .with_context(|| format!("Cannot write {}", path.display()))?;
    let saved = if replace {
        temp.persist(path)
    } else {
        temp.persist_noclobber(path)
    };
    match saved {
        Ok(_) => Ok(true),
        Err(error) if !replace && error.error.kind() == io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => {
            Err(error.error).with_context(|| format!("Cannot replace {}", path.display()))
        }
    }
}

fn read_qt_ini(path: &Path) -> Result<Option<Settings>> {
    read_text(path)?
        .map(|data| {
            parse_qt_ini(&data)
                .with_context(|| format!("Cannot migrate settings from {}", path.display()))
        })
        .transpose()
}

fn parse_qt_ini(data: &str) -> Result<Settings> {
    let mut settings = Settings::default();
    let mut automatic_java = None;
    let mut general = true;
    for line in data.lines() {
        let line = line.trim_start_matches([' ', '\t']);
        if let Some(group) = line.strip_prefix('[').and_then(|line| line.split_once(']')) {
            general = group.0.eq_ignore_ascii_case("General");
            continue;
        }
        if !general || line.starts_with([';', '#']) {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key == "addedJavaPaths" {
            settings.added_java_paths = parse_qt_value(value)?
                .into_iter()
                .filter_map(|value| nonempty_path(&value))
                .collect();
            continue;
        }
        if !matches!(
            key,
            "gameDirectory" | "javaExecutable" | "gameLayout" | "automaticJava"
        ) {
            continue;
        }
        let mut parts = parse_qt_value(value)?.into_iter();
        let first = parts.next().unwrap_or_default();
        ensure!(parts.next().is_none(), "Expected a single value for {key}");
        match key {
            "gameDirectory" => settings.game_directory = nonempty_path(&first),
            "javaExecutable" => settings.java_executable = nonempty_path(&first),
            "gameLayout" => settings.layout = qt_layout(&first),
            "automaticJava" => automatic_java = Some(qt_bool(&first)),
            _ => unreachable!(),
        }
    }
    settings.automatic_java = automatic_java.unwrap_or(settings.java_executable.is_none());
    Ok(settings)
}

fn qt_layout(value: &str) -> GameLayout {
    match value {
        "1" => GameLayout::Shared,
        "2" => GameLayout::Isolated,
        _ => GameLayout::Automatic,
    }
}

fn qt_bool(value: &str) -> bool {
    !value.is_empty() && value != "0" && !value.eq_ignore_ascii_case("false")
}

fn parse_qt_value(value: &str) -> Result<Vec<String>> {
    let mut values = Vec::new();
    let mut start = 0;
    let mut end = value.len();
    let mut quoted = false;
    let mut escaped = false;
    for (index, ch) in value.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match ch {
            '\\' => escaped = true,
            '"' => quoted = !quoted,
            ',' if !quoted => {
                values.push(decode_qt_string(&value[start..index])?);
                start = index + 1;
            }
            ';' if !quoted => {
                end = index;
                break;
            }
            _ => {}
        }
    }
    ensure!(!escaped && !quoted, "Unterminated Qt setting string");
    values.push(decode_qt_string(&value[start..end])?);
    Ok(values)
}

fn decode_qt_string(value: &str) -> Result<String> {
    let value = value.trim_matches([' ', '\t']);
    let mut decoded = Vec::new();
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '"' {
            continue;
        }
        if ch != '\\' {
            decoded.extend_from_slice(ch.encode_utf16(&mut [0; 2]));
            continue;
        }
        let escaped = chars.next().context("Incomplete escape in Qt setting")?;
        let code = match escaped {
            'a' => 7,
            'b' => 8,
            't' => 9,
            'n' => 10,
            'v' => 11,
            'f' => 12,
            'r' => 13,
            '"' | '\\' | '?' | '\'' => escaped as u16,
            'x' | '0'..='7' => {
                let (radix, start) = if escaped == 'x' {
                    (16, 0u16)
                } else {
                    (8, escaped as u16 - '0' as u16)
                };
                ensure!(
                    radix == 8 || chars.peek().is_some_and(|ch| ch.is_ascii_hexdigit()),
                    "Invalid hex escape in Qt setting"
                );
                let mut number = start;
                while let Some(digit) = chars.peek().and_then(|ch| ch.to_digit(radix)) {
                    chars.next();
                    number = number
                        .checked_mul(radix as u16)
                        .and_then(|n| n.checked_add(digit as u16))
                        .context("Qt setting escape out of range")?;
                }
                number
            }
            _ => bail!("Unsupported Qt setting escape: \\{escaped}"),
        };
        decoded.push(code);
    }
    qt_string_variant(String::from_utf16(&decoded).context("Invalid Unicode escape in Qt setting")?)
}

fn qt_string_variant(value: String) -> Result<String> {
    if value.starts_with("@@") {
        return Ok(value[1..].to_owned());
    }
    if value == "@Invalid()" {
        return Ok(String::new());
    }
    if let Some(inner) = value
        .strip_prefix("@String(")
        .and_then(|str| str.strip_suffix(')'))
    {
        ensure!(
            !inner.contains('\0'),
            "Qt setting contains a null character"
        );
        return Ok(inner.to_owned());
    }
    ensure!(
        !value.contains('\0'),
        "Qt setting contains a null character"
    );
    Ok(value)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn read_native_settings() -> Result<Option<Settings>> {
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")));
    let Some(config) = config else {
        return Ok(None);
    };
    let Some(mut settings) = read_qt_ini(&config.join("LDFCL/LDFCL.conf"))? else {
        return Ok(None);
    };
    if settings.added_java_paths.is_empty() {
        settings.added_java_paths = settings.java_executable.iter().cloned().collect();
    }
    Ok(Some(settings))
}

#[cfg(target_os = "macos")]
fn read_native_settings() -> Result<Option<Settings>> {
    let Some(home) = std::env::var_os("HOME") else {
        return Ok(None);
    };
    let file = PathBuf::from(home).join("Library/Preferences/com.ldfcl.LDFCL.plist");
    if !file.try_exists()? {
        return Ok(None);
    }
    let output = std::process::Command::new("/usr/bin/plutil")
        .args(["-convert", "json", "-o", "-", "--"])
        .arg(&file)
        .output()
        .with_context(|| format!("Cannot read {}", file.display()))?;
    ensure!(
        output.status.success(),
        "Cannot read {}: {}",
        file.display(),
        String::from_utf8_lossy(&output.stderr)
    );
    let data: serde_json::Value = serde_json::from_slice(&output.stdout)
        .with_context(|| format!("Cannot migrate settings from {}", file.display()))?;
    let java = data["javaExecutable"].as_str().and_then(nonempty_path);
    let layout = data["gameLayout"]
        .as_i64()
        .map(|value| qt_layout(&value.to_string()))
        .or_else(|| data["gameLayout"].as_str().map(qt_layout))
        .unwrap_or_default();
    Ok(Some(Settings {
        game_directory: data["gameDirectory"].as_str().and_then(nonempty_path),
        added_java_paths: java.iter().cloned().collect(),
        automatic_java: data["automaticJava"]
            .as_bool()
            .or_else(|| data["automaticJava"].as_str().map(qt_bool))
            .unwrap_or(java.is_none()),
        java_executable: java,
        layout,
    }))
}

#[cfg(windows)]
fn read_native_settings() -> Result<Option<Settings>> {
    let game = read_registry_value("gameDirectory")?.and_then(|value| nonempty_path(&value));
    let java = read_registry_value("javaExecutable")?.and_then(|value| nonempty_path(&value));
    let automatic = read_registry_value("automaticJava")?;
    let layout = read_registry_value("gameLayout")?;
    if game.is_none() && java.is_none() && automatic.is_none() && layout.is_none() {
        return Ok(None);
    }
    Ok(Some(Settings {
        game_directory: game,
        added_java_paths: java.iter().cloned().collect(),
        automatic_java: automatic.as_deref().map(qt_bool).unwrap_or(java.is_none()),
        java_executable: java,
        layout: layout.as_deref().map(qt_layout).unwrap_or_default(),
    }))
}

#[cfg(windows)]
fn read_registry_value(name: &str) -> Result<Option<String>> {
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::{
        ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS,
    };
    use windows_sys::Win32::System::Registry::{
        HKEY_CURRENT_USER, REG_DWORD, RRF_RT_REG_DWORD, RRF_RT_REG_SZ, RegGetValueW,
    };

    let key: Vec<u16> = r"Software\LDFCL\LDFCL"
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let value_name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
    let flags = RRF_RT_REG_SZ | RRF_RT_REG_DWORD;
    let mut size = 0;
    let mut kind = 0;
    // Query the byte length before allocating a UTF-16 buffer.
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            value_name.as_ptr(),
            flags,
            &mut kind,
            null_mut(),
            &mut size,
        )
    };
    if matches!(status, ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND) {
        return Ok(None);
    }
    ensure!(
        status == ERROR_SUCCESS,
        "Cannot read legacy setting {name}: Windows error {status}"
    );
    ensure!(size <= 1024 * 1024, "Legacy setting {name} is too large");
    // Leave space for an extra terminator in a malformed REG_SZ value.
    let mut buffer = vec![0u16; size.div_ceil(2) as usize + 1];
    size = (buffer.len() * 2) as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            value_name.as_ptr(),
            flags,
            &mut kind,
            buffer.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if matches!(status, ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND) {
        return Ok(None);
    }
    ensure!(
        status == ERROR_SUCCESS,
        "Cannot read legacy setting {name}: Windows error {status}"
    );
    if kind == REG_DWORD {
        ensure!(size == 4, "Malformed numeric legacy setting {name}");
        return Ok(Some(
            (u32::from(buffer[0]) | (u32::from(buffer[1]) << 16)).to_string(),
        ));
    }
    ensure!(size % 2 == 0, "Malformed UTF-16 legacy setting {name}");
    let mut length = (size / 2) as usize;
    while length > 0 && buffer[length - 1] == 0 {
        length -= 1;
    }
    let value = String::from_utf16(&buffer[..length])
        .with_context(|| format!("Invalid Unicode in legacy setting {name}"))?;
    qt_string_variant(value).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_qt_single_and_multi_value_formats() -> Result<()> {
        let settings = parse_qt_ini(concat!(
            "[General]\r\n",
            "addedJavaPaths=\"局部 Java, x/bin/java\", \"D:\\\\外部; Java\\\\bin\\\\java.exe\", @@目录/bin/java\r\n",
            "automaticJava=false\r\n",
            "gameDirectory=\"我的, 世界\"\r\n",
            "gameLayout=2\r\n",
            "javaExecutable=\"局部 Java, x/bin/java\"\r\n",
            "[Unrelated]\r\njavaExecutable=ignored\r\n",
        ))?;
        assert_eq!(settings.game_directory, Some(PathBuf::from("我的, 世界")));
        assert_eq!(
            settings.java_executable,
            Some(PathBuf::from("局部 Java, x/bin/java"))
        );
        assert_eq!(
            settings.added_java_paths,
            [
                PathBuf::from("局部 Java, x/bin/java"),
                PathBuf::from(r"D:\外部; Java\bin\java.exe"),
                PathBuf::from("@目录/bin/java"),
            ]
        );
        assert!(!settings.automatic_java);
        assert_eq!(settings.layout, GameLayout::Isolated);
        let missing_auto =
            parse_qt_ini("[General]\njavaExecutable=chosen\naddedJavaPaths=@Invalid()\n")?;
        assert!(!missing_auto.automatic_java);
        assert!(missing_auto.added_java_paths.is_empty());
        Ok(())
    }

    #[test]
    fn migrates_once_and_relocates_internal_paths() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let root = temp.path().join("原 安装");
        let moved = temp.path().join("新 安装");
        let external = temp.path().join("外部 Java").join("java.exe");
        let config = root.join("config");
        fs::create_dir_all(&config)?;
        fs::write(config.join("game-directory.txt"), "\u{feff}新的 世界\r\n")?;
        fs::write(
            config.join("settings.ini"),
            "[General]\ngameDirectory=陈旧\njavaExecutable=\"目录, Java/bin/java\"\ngameLayout=1\n",
        )?;
        let store = SettingsStore::new(&root);
        let mut settings = store.load()?;
        assert_eq!(settings.game_directory, Some(root.join("新的 世界")));
        assert_eq!(
            settings.java_executable,
            Some(root.join("目录, Java/bin/java"))
        );
        assert!(!settings.automatic_java);
        settings.added_java_paths = vec![root.join("Java 21/bin/java"), external.clone()];
        store.save(&settings)?;
        assert_eq!(
            fs::read_to_string(config.join("game-directory.txt"))?,
            "\u{feff}新的 世界\r\n"
        );
        fs::write(
            config.join("settings.ini"),
            "[General]\njavaExecutable=changed old file\n",
        )?;
        fs::rename(&root, &moved)?;
        let settings = SettingsStore::new(&moved).load()?;
        assert_eq!(settings.game_directory, Some(moved.join("新的 世界")));
        assert_eq!(
            settings.java_executable,
            Some(moved.join("目录, Java/bin/java"))
        );
        assert_eq!(
            settings.added_java_paths,
            [moved.join("Java 21/bin/java"), external]
        );
        assert_eq!(settings.layout, GameLayout::Shared);
        Ok(())
    }

    #[test]
    fn preserves_unreadable_settings() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let config = temp.path().join("config");
        fs::create_dir(&config)?;
        let settings = config.join("settings.json");
        fs::write(&settings, "{invalid JSON")?;
        let store = SettingsStore::new(temp.path());
        assert!(store.load().is_err());
        assert!(store.save(&Settings::default()).is_err());
        assert_eq!(fs::read_to_string(settings)?, "{invalid JSON");
        Ok(())
    }

    #[test]
    fn leaves_malformed_legacy_preferences_for_recovery() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let config = temp.path().join("config");
        fs::create_dir(&config)?;
        fs::write(
            config.join("settings.ini"),
            "[General]\njavaExecutable=\"open quote\n",
        )?;
        let store = SettingsStore::new(temp.path());
        assert!(store.load().is_err());
        assert!(store.save(&Settings::default()).is_err());
        assert!(!config.join("settings.json").exists());
        Ok(())
    }
}
