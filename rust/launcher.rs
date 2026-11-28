mod artifacts;
mod metadata;

use std::collections::HashMap;
use std::ffi::OsString;
use std::fs::OpenOptions;
use std::path::{self, Path};
use std::process::{Command, Stdio};

use anyhow::{Context, Result, bail, ensure};
use serde_json::Value;

use artifacts::{CLASSPATH_SEPARATOR, prepare_classpath, temporary_natives};
use metadata::{load_version, permitted, require_file, uses_instance_directory, valid_segment};

pub use metadata::{
    GameLayout, default_game_directory, installed_versions, required_java_major,
    resolve_game_directory,
};

fn string_field<'a>(object: &'a Value, field: &str) -> Result<&'a str> {
    object[field]
        .as_str()
        .with_context(|| format!("Expected a string for {field}"))
}

fn string_or<'a>(object: &'a Value, field: &str, default: &'a str) -> Result<&'a str> {
    if object.get(field).is_some() {
        string_field(object, field)
    } else {
        Ok(default)
    }
}

fn append_arguments(arguments: &mut Vec<String>, entries: &Value) -> Result<()> {
    let entries = entries.as_array().context("Expected an argument list")?;
    for entry in entries {
        if let Some(literal) = entry.as_str() {
            arguments.push(literal.into());
        } else if permitted(entry)? {
            match &entry["value"] {
                Value::String(literal) => arguments.push(literal.clone()),
                Value::Array(values) => {
                    for value in values {
                        arguments.push(
                            value
                                .as_str()
                                .context("Expected an argument string")?
                                .into(),
                        );
                    }
                }
                _ => bail!("Expected an argument string or list"),
            }
        }
    }
    Ok(())
}

fn expand(input: &str, values: &HashMap<&str, OsString>) -> Result<OsString> {
    let mut remaining = input;
    let mut expanded = OsString::new();
    while let Some((literal, variable)) = remaining.split_once("${") {
        expanded.push(literal);
        let (key, after) = variable
            .split_once('}')
            .context("Unclosed argument variable")?;
        let value = values
            .get(key)
            .with_context(|| format!("Unsupported version argument: ${{{key}}}"))?;
        expanded.push(value);
        remaining = after;
    }
    expanded.push(remaining);
    Ok(expanded)
}

pub fn launch(
    root: &Path,
    id: &str,
    java: &Path,
    log: Option<&Path>,
    layout: GameLayout,
    native_cache: Option<&Path>,
) -> Result<i32> {
    ensure!(valid_segment(id), "Invalid version ID");
    ensure!(
        !java.as_os_str().is_empty(),
        "Choose an installed Java executable"
    );
    let executable = path::absolute(java)?;
    ensure!(
        executable.is_file(),
        "Java executable not found: {}",
        executable.display()
    );
    let root = resolve_game_directory(root)?;
    let instance_folder = root.join("versions").join(id);
    let instance = if uses_instance_directory(&instance_folder, layout) {
        &instance_folder
    } else {
        &root
    };
    let local = load_version(&root, id)?;
    let version = &local.metadata;
    let assets = root.join("assets");
    let index_id = string_or(
        &version["assetIndex"],
        "id",
        string_or(version, "assets", "legacy")?,
    )?;
    ensure!(valid_segment(index_id), "Invalid asset index ID");
    if version.get("assetIndex").is_some() {
        require_file(&assets.join("indexes").join(format!("{index_id}.json")))?;
    }

    let natives = temporary_natives(native_cache)?;
    let search_path = path::absolute(natives.path())?;
    let classpath = prepare_classpath(version, &root, &local.jar, &search_path)?;
    let virtual_assets = assets.join("virtual").join(index_id);
    let game_assets = if virtual_assets.is_dir() {
        &virtual_assets
    } else {
        &assets
    };
    let mut values = HashMap::from([
        ("auth_player_name", "Player".into()),
        ("auth_uuid", "a01e3843e5213998958af459800e4d11".into()),
        ("auth_access_token", "0".into()),
        ("auth_session", "0".into()),
        ("auth_xuid", "0".into()),
        ("clientid", "0".into()),
        ("user_type", "legacy".into()),
        ("user_properties", "{}".into()),
        ("profile_properties", "{}".into()),
        ("version_name", id.into()),
        (
            "version_type",
            string_or(version, "type", "release")?.into(),
        ),
        ("game_directory", instance.as_os_str().into()),
        ("assets_root", assets.as_os_str().into()),
        ("game_assets", game_assets.as_os_str().into()),
        ("assets_index_name", index_id.into()),
        ("natives_directory", search_path.into_os_string()),
        ("library_directory", root.join("libraries").into_os_string()),
        ("classpath", classpath),
        ("classpath_separator", CLASSPATH_SEPARATOR.into()),
        ("launcher_name", "LDFCL".into()),
        ("launcher_version", env!("CARGO_PKG_VERSION").into()),
    ]);

    let mut args = vec!["-Xmx2G".into()];
    #[cfg(target_os = "macos")]
    args.push("-XstartOnFirstThread".into());
    if let Some(jvm) = version["arguments"].get("jvm") {
        append_arguments(&mut args, jvm)?;
    } else {
        args.extend(
            [
                "-Djava.library.path=${natives_directory}",
                "-cp",
                "${classpath}",
            ]
            .map(str::to_owned),
        );
    }
    if let Some(client) = version["logging"].get("client") {
        let name = string_field(&client["file"], "id")?;
        ensure!(valid_segment(name), "Invalid logging configuration name");
        let config = assets.join("log_configs").join(name);
        if config.is_file() {
            values.insert("path", config.into_os_string());
            args.push(string_field(client, "argument")?.into());
        }
    }
    args.push(string_field(version, "mainClass")?.into());
    if let Some(game) = version["arguments"].get("game") {
        append_arguments(&mut args, game)?;
    } else if version.get("minecraftArguments").is_some() {
        args.extend(
            string_field(version, "minecraftArguments")?
                .split_ascii_whitespace()
                .map(str::to_owned),
        );
    }
    let args = args
        .iter()
        .map(|arg| expand(arg, &values))
        .collect::<Result<Vec<_>>>()?;
    run_process(&executable, &args, instance, log)
}

fn run_process(
    executable: &Path,
    args: &[OsString],
    directory: &Path,
    log: Option<&Path>,
) -> Result<i32> {
    let mut command = Command::new(executable);
    command.current_dir(directory);
    #[cfg(unix)]
    set_direct_exec(&mut command, executable, args)?;
    #[cfg(windows)]
    {
        // Rust's Windows process API handles batch files by invoking cmd.exe.
        let name = executable.file_name().unwrap_or_default().to_string_lossy();
        let name = name.trim_end_matches([' ', '.']).to_ascii_lowercase();
        ensure!(
            !name.ends_with(".bat") && !name.ends_with(".cmd"),
            "Choose a Java executable instead of a batch file"
        );
        command.args(args);
    }
    if let Some(log) = log {
        #[cfg(unix)]
        let log = directory.join(log);
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        use std::os::unix::fs::OpenOptionsExt;
        #[cfg(unix)]
        options.mode(0o600);
        let output = options
            .open(&log)
            .with_context(|| format!("Cannot open game output log: {}", log.display()))?;
        command
            .stdout(Stdio::from(output.try_clone()?))
            .stderr(Stdio::from(output));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            command
                .stdin(Stdio::null())
                .creation_flags(CREATE_NO_WINDOW);
        }
    }
    let status = command
        .status()
        .with_context(|| format!("Cannot start Java: {}", executable.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return Ok(128 + signal);
        }
    }
    status.code().context("Cannot read Java process result")
}

#[cfg(unix)]
fn set_direct_exec(command: &mut Command, executable: &Path, args: &[OsString]) -> Result<()> {
    use std::ffi::{CString, c_char};
    use std::os::unix::{ffi::OsStrExt, process::CommandExt};

    struct Arguments {
        strings: Vec<CString>,
        argv: Vec<*const c_char>,
    }

    // argv references immutable storage owned by strings, which stays allocated when moved.
    unsafe impl Send for Arguments {}
    unsafe impl Sync for Arguments {}

    impl Arguments {
        fn exec(&self) -> ! {
            // Only async-signal-safe calls are allowed in the child before exec.
            unsafe {
                libc::execv(self.strings[0].as_ptr(), self.argv.as_ptr());
                libc::_exit(126);
            }
        }
    }

    let strings = std::iter::once(executable.as_os_str())
        .chain(args.iter().map(OsString::as_os_str))
        .map(|argument| CString::new(argument.as_bytes()))
        .collect::<std::result::Result<Vec<_>, _>>()
        .context("NUL byte in Java executable or argument")?;
    let argv = strings
        .iter()
        .map(|argument| argument.as_ptr())
        .chain(std::iter::once(std::ptr::null()))
        .collect();
    let arguments = Arguments { strings, argv };
    // execv avoids execvp's fallback to interpreting an unrecognized file using a shell.
    unsafe { command.pre_exec(move || arguments.exec()) };
    Ok(())
}

#[cfg(all(test, unix))]
#[test]
fn rejects_unrecognized_executable_without_a_shell() -> Result<()> {
    use std::{fs, os::unix::fs::PermissionsExt};

    let directory = tempfile::tempdir()?;
    let executable = directory.path().join("java");
    fs::write(&executable, "exit 73\n")?;
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700))?;
    assert_eq!(run_process(&executable, &[], directory.path(), None)?, 126);
    Ok(())
}
