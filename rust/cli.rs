use std::env;
use std::ffi::{OsStr, OsString};
use std::path::PathBuf;
use std::process;

use anyhow::{Context, Result, bail};
use ldfcl::{java, launcher};

fn usage() {
    println!("LDFCL - Offline Minecraft launcher");
    println!("  ldfcl-cli list [--game-dir DIRECTORY]");
    println!("  ldfcl-cli launch VERSION [--game-dir DIRECTORY] [--java EXECUTABLE]");
}

fn looks_like_option(value: &OsStr) -> bool {
    value.as_encoded_bytes().starts_with(b"--")
}

fn run(mut args: impl Iterator<Item = OsString>) -> Result<i32> {
    let Some(command) = args.next() else {
        usage();
        return Ok(0);
    };
    let version = match command.to_str() {
        Some("--help" | "-h") => {
            usage();
            return Ok(0);
        }
        Some("list") => None,
        Some("launch") => Some(
            args.next()
                .filter(|value| !looks_like_option(value))
                .context("Specify an installed Minecraft version")?,
        ),
        _ => bail!("Unknown command: {}", command.to_string_lossy()),
    };

    let mut root = launcher::default_game_directory();
    let mut java = None;
    while let Some(option) = args.next() {
        let path = match option.to_str() {
            Some("--game-dir") => &mut root,
            Some("--java") if version.is_some() => java.get_or_insert_with(PathBuf::new),
            _ => bail!("Unknown option: {}", option.to_string_lossy()),
        };
        *path = args
            .next()
            .filter(|value| !value.is_empty() && !looks_like_option(value))
            .with_context(|| format!("Missing value for {}", option.to_string_lossy()))?
            .into();
    }

    if let Some(version) = version {
        let version = version.to_str().context("Invalid version ID")?;
        let java = java.or_else(java::default_java).unwrap_or_default();
        launcher::launch(
            &root,
            version,
            &java,
            None,
            launcher::GameLayout::Automatic,
            None,
        )
    } else {
        for version in launcher::installed_versions(&root)? {
            println!("{version}");
        }
        Ok(0)
    }
}

fn main() {
    let code = match run(env::args_os().skip(1)) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("LDFCL: {error:#}");
            1
        }
    };
    process::exit(code);
}
