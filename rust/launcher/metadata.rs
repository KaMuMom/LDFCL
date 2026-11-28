use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;
use std::{env, fs};

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GameLayout {
    #[default]
    Automatic,
    Shared,
    Isolated,
}

pub(super) const OS_NAME: &str = if cfg!(windows) {
    "windows"
} else if cfg!(target_os = "macos") {
    "osx"
} else {
    "linux"
};

pub fn default_game_directory() -> PathBuf {
    let home_key = if cfg!(windows) { "APPDATA" } else { "HOME" };
    if let Some(home) = env::var_os(home_key).filter(|path| !path.is_empty()) {
        return PathBuf::from(home).join(if cfg!(target_os = "macos") {
            "Library/Application Support/minecraft"
        } else {
            ".minecraft"
        });
    }
    env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".minecraft")
}

pub fn resolve_game_directory(directory: &Path) -> Result<PathBuf> {
    // Keep the game's selected path, including junctions and symlinks. Existing
    // Java arguments use the normal absolute spelling instead of a device path.
    let absolute = std::path::absolute(directory)
        .with_context(|| format!("Cannot resolve game directory: {}", directory.display()))?;
    let mut root = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                root.pop();
            }
            other => root.push(other.as_os_str()),
        }
    }
    let nested = root.join(".minecraft");
    if !root.join("versions").is_dir() && nested.join("versions").is_dir() {
        Ok(nested)
    } else {
        Ok(root)
    }
}

pub fn installed_versions(game_directory: &Path) -> Result<Vec<String>> {
    let root = resolve_game_directory(game_directory)?;
    let versions = root.join("versions");
    if !versions.is_dir() {
        return Ok(Vec::new());
    }
    let entries = fs::read_dir(&versions)
        .with_context(|| format!("Cannot read installed versions: {}", versions.display()))?;
    let mut result = Vec::new();
    for entry in entries {
        let entry = entry?;
        let Ok(id) = entry.file_name().into_string() else {
            continue;
        };
        if !valid_segment(&id) || !entry.path().is_dir() {
            continue;
        }
        if let Ok(version) = load_version(&root, &id)
            && version.metadata.get("mainClass").is_some()
            && version.jar.is_file()
        {
            result.push(id);
        }
    }
    result.sort_unstable_by(|left, right| right.cmp(left));
    Ok(result)
}

/// Returns zero when the metadata and version name do not identify a Java major.
pub fn required_java_major(game_directory: &Path, id: &str) -> Result<u32> {
    Ok(load_version(&resolve_game_directory(game_directory)?, id)?.java_major)
}

pub(super) fn valid_segment(value: &str) -> bool {
    !value.is_empty()
        && !value.ends_with(['.', ' '])
        && !value
            .bytes()
            .any(|byte| byte < 32 || b"/\\:\"*?<>|".contains(&byte))
        && (!cfg!(windows) || !windows_device_name(value))
}

fn windows_device_name(value: &str) -> bool {
    // These names resolve to devices on Windows even when followed by an extension.
    let base = value.split_once('.').map_or(value, |(base, _)| base);
    let base = base.trim_end_matches(' ').to_ascii_uppercase();
    ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&base.as_str())
        || matches!(
            base.strip_prefix("COM")
                .or_else(|| base.strip_prefix("LPT")),
            Some("1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³")
        )
}

pub(super) fn require_file(file: &Path) -> Result<()> {
    ensure!(
        file.is_file(),
        "Missing local game file: {}",
        file.display()
    );
    Ok(())
}

fn read_json(file: &Path) -> Result<Value> {
    require_file(file)?;
    let bytes = fs::read(file).with_context(|| format!("Cannot read {}", file.display()))?;
    let json = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes);
    serde_json::from_slice(json)
        .with_context(|| format!("Invalid version JSON ({})", file.display()))
}

pub(super) struct LocalVersion {
    pub(super) metadata: Value,
    pub(super) jar: PathBuf,
    pub(super) java_major: u32,
}

pub(super) fn load_version(root: &Path, id: &str) -> Result<LocalVersion> {
    load_with_parents(root, id, Vec::new())
}

fn load_with_parents(root: &Path, id: &str, mut chain: Vec<String>) -> Result<LocalVersion> {
    ensure!(
        valid_segment(id) && chain.len() < 32 && !chain.iter().any(|parent| parent == id),
        "Invalid or cyclic version inheritance: {id}"
    );
    chain.push(id.to_owned());
    let folder = root.join("versions").join(id);
    let json_path = folder.join(format!("{id}.json"));
    let Value::Object(child) = read_json(&json_path)? else {
        anyhow::bail!(
            "Version metadata must be an object: {}",
            json_path.display()
        );
    };
    let explicit_jar = child.get("jar");
    let mut jar = match explicit_jar {
        Some(value) => {
            let jar_id = value.as_str().context("Invalid client JAR ID")?;
            ensure!(valid_segment(jar_id), "Invalid client JAR: {jar_id}");
            root.join("versions")
                .join(jar_id)
                .join(format!("{jar_id}.jar"))
        }
        None => folder.join(format!("{id}.jar")),
    };
    let declared_major = child
        .get("javaVersion")
        .and_then(|version| version.get("majorVersion"))
        .and_then(Value::as_u64)
        .filter(|&major| (1..=i32::MAX as u64).contains(&major))
        .map(|major| major as u32);

    let Some(parent_id) = child.get("inheritsFrom") else {
        let java_major = declared_major.unwrap_or_else(|| inferred_java_major(&child, id));
        return Ok(LocalVersion {
            metadata: Value::Object(child),
            jar,
            java_major,
        });
    };
    let parent_id = parent_id
        .as_str()
        .context("Invalid inheritsFrom version ID")?;
    let parent = load_with_parents(root, parent_id, chain)?;
    if explicit_jar.is_none() && !jar.is_file() {
        jar = parent.jar;
    }
    let java_major = declared_major.unwrap_or_else(|| {
        if parent.java_major != 0 {
            parent.java_major
        } else {
            inferred_java_major(&child, id)
        }
    });
    let Value::Object(mut metadata) = parent.metadata else {
        unreachable!("version loading always returns a metadata object");
    };

    let libraries = merge_libraries(&child, &metadata)?;
    let arguments = merge_arguments(&child, &metadata)?;
    metadata.extend(child);
    metadata.insert("libraries".into(), Value::Array(libraries));
    if arguments.is_empty() {
        metadata.remove("arguments");
    } else {
        metadata.insert("arguments".into(), Value::Object(arguments));
    }
    Ok(LocalVersion {
        metadata: Value::Object(metadata),
        jar,
        java_major,
    })
}

fn inferred_java_major(metadata: &Map<String, Value>, id: &str) -> u32 {
    for key in ["clientVersion", "jar", "id"] {
        if let Some(major) = metadata
            .get(key)
            .and_then(Value::as_str)
            .and_then(vanilla_java_major)
        {
            return major;
        }
    }
    if matches!(
        metadata.get("type").and_then(Value::as_str),
        Some("old_alpha" | "old_beta")
    ) {
        return 8;
    }
    vanilla_java_major(id).unwrap_or(0)
}

fn vanilla_java_major(id: &str) -> Option<u32> {
    fn number(part: &str) -> Option<u16> {
        if part.len() > 3 || !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        part.parse().ok()
    }

    let components = id.strip_prefix("1.")?.split(['-', '_']).next()?;
    let (minor, patch) = match components.split_once('.') {
        Some((minor, patch)) => (number(minor)?, number(patch)?),
        None => (number(components)?, 0),
    };
    match (minor, patch) {
        (0..=16, _) => Some(8),
        (17, _) => Some(16),
        (18..=19, _) | (20, 0..=4) => Some(17),
        (20..=21, _) => Some(21),
        _ => None,
    }
}

fn merge_libraries(child: &Map<String, Value>, parent: &Map<String, Value>) -> Result<Vec<Value>> {
    let mut libraries = Vec::new();
    let mut child_keys = HashSet::new();
    for library in array_field(child, "libraries")? {
        child_keys.insert(library_key(library)?);
        libraries.push(library.clone());
    }
    for library in array_field(parent, "libraries")? {
        if !child_keys.contains(&library_key(library)?) {
            libraries.push(library.clone());
        }
    }
    Ok(libraries)
}

fn library_key(library: &Value) -> Result<(&str, &str, &str, &str)> {
    let name = library
        .get("name")
        .and_then(Value::as_str)
        .context("Invalid library name")?;
    let (coordinate, extension) = name.split_once('@').unwrap_or((name, "jar"));
    let mut parts = coordinate.split(':');
    let (Some(group), Some(artifact), Some(_version)) = (parts.next(), parts.next(), parts.next())
    else {
        anyhow::bail!("Invalid library: {name}");
    };
    Ok((group, artifact, parts.next().unwrap_or(""), extension))
}

fn merge_arguments(
    child: &Map<String, Value>,
    parent: &Map<String, Value>,
) -> Result<Map<String, Value>> {
    let mut arguments = parent
        .get("arguments")
        .map(|value| value.as_object().context("Invalid parent arguments"))
        .transpose()?
        .cloned()
        .unwrap_or_default();
    if let Some(child_args) = child.get("arguments") {
        let child_args = child_args.as_object().context("Invalid child arguments")?;
        for part in ["jvm", "game"] {
            let tokens = array_field(child_args, part)?;
            if !tokens.is_empty() {
                arguments
                    .entry(part)
                    .or_insert_with(|| Value::Array(Vec::new()))
                    .as_array_mut()
                    .with_context(|| format!("Invalid parent {part} arguments"))?
                    .extend_from_slice(tokens);
            }
        }
    } else if child.contains_key("minecraftArguments") {
        arguments.remove("game");
    }
    Ok(arguments)
}

fn array_field<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a [Value]> {
    match object.get(key) {
        None => Ok(&[]),
        Some(value) => value
            .as_array()
            .map(Vec::as_slice)
            .with_context(|| format!("Invalid {key}: expected a list")),
    }
}

fn pcl_layout(folder: &Path) -> GameLayout {
    let Ok(bytes) = fs::read(folder.join("PCL").join("Setup.ini")) else {
        return GameLayout::Automatic;
    };
    let mut legacy = GameLayout::Automatic;
    // PCL's keys are ASCII even if other lines use a local Windows code page.
    for line in String::from_utf8_lossy(&bytes).lines() {
        let Some((key, value)) = line.trim_start_matches('\u{feff}').split_once([':', '=']) else {
            continue;
        };
        match (
            key,
            value
                .trim_matches([' ', '\t', '\r'])
                .to_ascii_lowercase()
                .as_str(),
        ) {
            ("VersionArgumentIndieV2", "true" | "1") => return GameLayout::Isolated,
            ("VersionArgumentIndieV2", "false" | "0") => return GameLayout::Shared,
            ("VersionArgumentIndie", "1") => legacy = GameLayout::Isolated,
            ("VersionArgumentIndie", "2") => legacy = GameLayout::Shared,
            _ => {}
        }
    }
    legacy
}

pub(super) fn uses_instance_directory(folder: &Path, layout: GameLayout) -> bool {
    let layout = match layout {
        GameLayout::Automatic => pcl_layout(folder),
        explicit => explicit,
    };
    match layout {
        GameLayout::Isolated => return true,
        GameLayout::Shared => return false,
        GameLayout::Automatic => {}
    }

    let hmcl_instance = folder
        .join(".hmcl")
        .join("config")
        .join("instance-game-settings.json");
    if let Ok(settings) = read_json(&hmcl_instance) {
        let instance_folder = settings
            .get("runningDirectory")
            .is_none_or(|value| value.as_str() == Some(""));
        if instance_folder
            && settings
                .get("overrideProperties")
                .and_then(Value::as_array)
                .is_some_and(|keys| {
                    keys.iter()
                        .any(|name| name.as_str() == Some("runningDirectory"))
                })
        {
            return true;
        }
    }
    if let Ok(settings) = read_json(&folder.join("hmclversion.cfg"))
        && settings
            .get("usesGlobal")
            .is_none_or(|value| value.as_bool() == Some(false))
        && let Some(mode) = settings.get("gameDirType")
    {
        if mode.as_f64() == Some(1.0) || mode.as_str() == Some("VERSION_FOLDER") {
            return true;
        }
        if mode.as_f64() == Some(0.0) || mode.as_str() == Some("ROOT_FOLDER") {
            return false;
        }
    }
    ["saves", "mods", "resourcepacks", "shaderpacks"]
        .iter()
        .any(|name| folder.join(name).is_dir())
        || folder.join("options.txt").is_file()
}

pub(super) fn permitted(entry: &Value) -> Result<bool> {
    let Some(rules) = entry.get("rules") else {
        return Ok(true);
    };
    let rules = rules.as_array().context("Invalid rules: expected a list")?;
    let mut allowed = false;
    for rule in rules {
        if matches_rule(rule)? {
            allowed = rule.get("action").context("Missing rule action")?.as_str() == Some("allow");
        }
    }
    Ok(allowed)
}

fn matches_rule(rule: &Value) -> Result<bool> {
    if let Some(os) = rule.get("os") {
        let os = os.as_object().context("Invalid platform rule")?;
        if os
            .get("name")
            .is_some_and(|name| name.as_str() != Some(OS_NAME))
        {
            return Ok(false);
        }
        if let Some(arch) = os.get("arch") {
            let arch = arch.as_str().context("Invalid architecture rule")?;
            let host = match std::env::consts::ARCH {
                "x86_64" => "amd64",
                "aarch64" => "aarch64",
                "x86" => "x86",
                _ => "unknown",
            };
            if arch != host && !matches!((arch, host), ("x86_64", "amd64") | ("arm64", "aarch64")) {
                return Ok(false);
            }
        }
        if let Some(pattern) = os.get("version") {
            let pattern = pattern.as_str().context("Invalid OS version rule")?;
            let regex = regress::Regex::new(pattern).map_err(|error| {
                anyhow::anyhow!("Invalid OS version pattern {pattern:?}: {error}")
            })?;
            static RELEASE: OnceLock<String> = OnceLock::new();
            if regex.find(RELEASE.get_or_init(os_release)).is_none() {
                return Ok(false);
            }
        }
    }
    if let Some(features) = rule.get("features") {
        let features = features.as_object().context("Invalid feature rule")?;
        // An offline launch supplies no quick-play, demo, resolution or account features.
        for feature in features.values() {
            if feature.as_bool().context("Invalid feature flag")? {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

#[cfg(unix)]
fn os_release() -> String {
    // uname initializes the structure on success, including its C string fields.
    unsafe {
        let mut name = std::mem::MaybeUninit::<libc::utsname>::uninit();
        if libc::uname(name.as_mut_ptr()) != 0 {
            return String::new();
        }
        std::ffi::CStr::from_ptr(name.assume_init_ref().release.as_ptr())
            .to_string_lossy()
            .into_owned()
    }
}

#[cfg(windows)]
fn os_release() -> String {
    use windows_sys::Win32::System::{
        LibraryLoader::{GetModuleHandleW, GetProcAddress},
        SystemInformation::OSVERSIONINFOW,
    };

    type GetVersion = unsafe extern "system" fn(*mut OSVERSIONINFOW) -> i32;
    let ntdll: Vec<u16> = "ntdll.dll\0".encode_utf16().collect();
    // The loaded ntdll entry point uses this calling convention and structure.
    unsafe {
        let module = GetModuleHandleW(ntdll.as_ptr());
        if module.is_null() {
            return String::new();
        }
        let Some(proc) = GetProcAddress(module, c"RtlGetVersion".as_ptr().cast()) else {
            return String::new();
        };
        let get_version: GetVersion = std::mem::transmute(proc);
        let mut info = OSVERSIONINFOW {
            dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
            ..Default::default()
        };
        if get_version(&mut info) != 0 {
            return String::new();
        }
        format!(
            "{}.{}.{}",
            info.dwMajorVersion, info.dwMinorVersion, info.dwBuildNumber
        )
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    fn write_version(root: &Path, id: &str, metadata: Value, has_client: bool) {
        let folder = root.join("versions").join(id);
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join(format!("{id}.json")), metadata.to_string()).unwrap();
        if has_client {
            fs::write(folder.join(format!("{id}.jar")), "fixture").unwrap();
        }
    }

    #[test]
    fn finds_java_requirement_through_metadata_inheritance_and_version_names() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        for (id, expected) in [
            ("1.16.5", 8),
            ("1.17", 16),
            ("1.18", 17),
            ("1.20.4", 17),
            ("1.20.5", 21),
            ("1.21.1", 21),
            ("1.21.6-fabric", 21),
            ("unknown", 0),
            ("26.1", 0),
        ] {
            write_version(root, id, json!({ "id": id }), false);
            assert_eq!(required_java_major(root, id).unwrap(), expected, "{id}");
        }
        write_version(
            root,
            "26.1",
            json!({ "javaVersion": { "majorVersion": 25 } }),
            false,
        );
        write_version(root, "modded", json!({ "inheritsFrom": "26.1" }), false);
        write_version(
            root,
            "override",
            json!({ "inheritsFrom": "modded", "javaVersion": { "majorVersion": 21 } }),
            false,
        );
        assert_eq!(required_java_major(root, "modded").unwrap(), 25);
        assert_eq!(required_java_major(root, "override").unwrap(), 21);
    }

    #[test]
    fn merges_inherited_libraries_arguments_and_client_jars() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        write_version(
            root,
            "base",
            json!({
                "mainClass": "fixture.Base",
                "libraries": [{"name":"g:a:1"}, {"name":"g:a:1:natives"}],
                "arguments": {"jvm": ["-Dbase=1"], "game": ["--base"]}
            }),
            true,
        );
        write_version(
            root,
            "child",
            json!({
                "inheritsFrom": "base", "mainClass": "fixture.Child",
                "libraries": [{"name":"g:a:2"}, {"name":"g:a:2@zip"}],
                "arguments": {"jvm": ["-Dchild=1"], "game": ["--child"]}
            }),
            false,
        );
        write_version(
            root,
            "legacy",
            json!({
                "inheritsFrom": "child", "jar": "child", "minecraftArguments": "--legacy"
            }),
            false,
        );
        write_version(root, "cycle", json!({"inheritsFrom": "cycle"}), true);
        let child = load_version(root, "child").unwrap();
        assert_eq!(child.jar, root.join("versions/base/base.jar"));
        assert_eq!(child.metadata["mainClass"], "fixture.Child");
        assert_eq!(
            child.metadata["arguments"],
            json!({
                "jvm": ["-Dbase=1", "-Dchild=1"], "game": ["--base", "--child"]
            })
        );
        assert_eq!(
            child.metadata["libraries"],
            json!([
                {"name":"g:a:2"}, {"name":"g:a:2@zip"}, {"name":"g:a:1:natives"}
            ])
        );
        let legacy = load_version(root, "legacy").unwrap();
        assert_eq!(legacy.jar, root.join("versions/child/child.jar"));
        assert!(legacy.metadata["arguments"].get("game").is_none());
        assert_eq!(installed_versions(root).unwrap(), ["child", "base"]);
        assert!(load_version(root, "cycle").is_err());
        assert!(load_version(root, "../base").is_err());
    }

    #[test]
    fn resolves_nested_game_directories_and_preserves_explicit_isolation() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(".minecraft");
        let instance = root.join("versions/instance");
        fs::create_dir_all(instance.join("saves")).unwrap();
        assert_eq!(
            resolve_game_directory(&temp.path().join("unused/..")).unwrap(),
            root
        );
        assert!(uses_instance_directory(&instance, GameLayout::Automatic));

        fs::create_dir_all(instance.join("PCL")).unwrap();
        fs::write(
            instance.join("PCL/Setup.ini"),
            b"\xef\xbb\xbfVersionArgumentIndie:1\r\n\xc4\xe3\r\nVersionArgumentIndieV2=false\r\n",
        )
        .unwrap();
        assert!(!uses_instance_directory(&instance, GameLayout::Automatic));
        assert!(uses_instance_directory(&instance, GameLayout::Isolated));

        let standalone = root.join("versions/standalone");
        fs::create_dir_all(standalone.join(".hmcl/config")).unwrap();
        fs::write(
            standalone.join(".hmcl/config/instance-game-settings.json"),
            r#"{"overrideProperties":["runningDirectory"],"runningDirectory":""}"#,
        )
        .unwrap();
        assert!(uses_instance_directory(&standalone, GameLayout::Automatic));
        assert!(!uses_instance_directory(&standalone, GameLayout::Shared));
    }

    #[test]
    fn evaluates_rules_in_order_with_os_regex_and_offline_feature_flags() {
        assert!(permitted(&json!({})).unwrap());
        let entry = json!({ "rules": [
            {"action": "allow"},
            {"action": "disallow", "os": {"name": OS_NAME, "version": "^(?=.*$)"}},
            {"action": "allow", "features": {"is_demo_user": true}}
        ] });
        assert!(!permitted(&entry).unwrap());
        assert!(
            permitted(&json!({ "rules": [
            {"action": "allow", "features": {"is_demo_user": false}},
            {"action": "disallow", "os": {"name": "other"}}
        ] }))
            .unwrap()
        );
    }

    #[test]
    fn validates_archived_path_segments() {
        for invalid in [
            "",
            ".",
            "..",
            "x/y",
            "x\\y",
            "main:stream",
            "file.",
            "file ",
            "line\nbreak",
        ] {
            assert!(!valid_segment(invalid), "{invalid:?}");
        }
        for device in [
            "CON",
            "NuL.dll",
            "com1 .txt",
            "LPT².ext",
            "CONIN$",
            "CONOUT$.",
        ] {
            assert!(windows_device_name(device), "{device:?}");
        }
        assert!(valid_segment("普通文件-1.21.dll"));
        assert!(!windows_device_name("components.jar"));
    }
}
