use std::ffi::OsString;
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, ensure};
use serde_json::Value;
use tempfile::{Builder, TempDir};
use zip::ZipArchive;

use super::metadata::{OS_NAME, permitted, require_file, valid_segment};
use super::string_field;

#[cfg(windows)]
pub(super) const CLASSPATH_SEPARATOR: &str = ";";
#[cfg(not(windows))]
pub(super) const CLASSPATH_SEPARATOR: &str = ":";
const ARCHITECTURE_BITS: &str = if usize::BITS == 64 { "64" } else { "32" };

pub(super) fn temporary_natives(cache: Option<&Path>) -> Result<TempDir> {
    let mut builder = Builder::new();
    builder.prefix("ldfcl-native-");
    let directory = match cache {
        Some(cache) => {
            fs::create_dir_all(cache).with_context(|| {
                format!("Cannot create native library cache: {}", cache.display())
            })?;
            builder.tempdir_in(cache)
        }
        None => builder.tempdir(),
    };
    directory.context("Cannot create a temporary directory for native libraries")
}

fn relative_path(value: &str) -> Result<PathBuf> {
    let mut path = PathBuf::new();
    for segment in value.split('/') {
        ensure!(valid_segment(segment), "Invalid relative path: {value}");
        path.push(segment);
    }
    Ok(path)
}

fn maven_path(name: &str, native: Option<&str>) -> Result<String> {
    let (coordinates, extension) = name.split_once('@').unwrap_or((name, "jar"));
    let mut parts = coordinates.split(':');
    let (Some(group), Some(artifact), Some(version)) = (parts.next(), parts.next(), parts.next())
    else {
        anyhow::bail!("Invalid library: {name}");
    };
    let classifier = parts.next();
    ensure!(parts.next().is_none(), "Invalid library: {name}");
    let classifier = native.filter(|value| !value.is_empty()).or(classifier);
    let classifier = classifier.filter(|value| !value.is_empty());
    let classifier = classifier.map_or_else(String::new, |value| format!("-{value}"));
    let group = group.replace('.', "/");
    Ok(format!(
        "{group}/{artifact}/{version}/{artifact}-{version}{classifier}.{extension}"
    ))
}

fn extract_natives(archive: &Path, target: &Path, exclusions: &[&str]) -> Result<()> {
    require_file(archive)?;
    let source = File::open(archive)
        .with_context(|| format!("Cannot read native archive: {}", archive.display()))?;
    let mut zip = ZipArchive::new(source)
        .with_context(|| format!("Invalid native archive: {}", archive.display()))?;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).with_context(|| {
            format!("Cannot read native entry {index} in {}", archive.display())
        })?;
        let name = entry.name().to_owned();
        if entry.is_dir()
            || name.starts_with("META-INF/")
            || exclusions.iter().any(|prefix| name.starts_with(prefix))
        {
            continue;
        }
        ensure!(
            !entry.is_symlink(),
            "Invalid symbolic link in native archive: {name}"
        );
        let output = target.join(relative_path(&name)?);
        fs::create_dir_all(output.parent().context("Missing native entry directory")?)?;
        let mut file = File::create(&output)
            .with_context(|| format!("Cannot write native library: {}", output.display()))?;
        io::copy(&mut entry, &mut file)
            .with_context(|| format!("Cannot extract native library: {name}"))?;
    }
    Ok(())
}

fn native_exclusions(library: &Value) -> Result<Vec<&str>> {
    let Some(exclusions) = library["extract"].get("exclude") else {
        return Ok(Vec::new());
    };
    exclusions
        .as_array()
        .context("Expected native extraction exclusions")?
        .iter()
        .map(|value| {
            value
                .as_str()
                .context("Expected a native extraction exclusion string")
        })
        .collect()
}

pub(super) fn prepare_classpath(
    version: &Value,
    root: &Path,
    jar: &Path,
    natives: &Path,
) -> Result<OsString> {
    let mut classpath = OsString::new();
    let libraries = root.join("libraries");
    let mut add = |file: &Path| -> Result<()> {
        require_file(file)?;
        if !classpath.is_empty() {
            classpath.push(CLASSPATH_SEPARATOR);
        }
        classpath.push(file.as_os_str());
        Ok(())
    };
    for library in version["libraries"]
        .as_array()
        .context("Expected a library list")?
    {
        if !permitted(library)? {
            continue;
        }
        let downloads = library.get("downloads");
        match downloads {
            Some(downloads) => {
                if let Some(artifact) = downloads.get("artifact") {
                    add(&libraries.join(relative_path(string_field(artifact, "path")?)?))?;
                }
            }
            None => {
                let path = maven_path(string_field(library, "name")?, None)?;
                add(&libraries.join(relative_path(&path)?))?;
            }
        }
        let Some(classifier) = library["natives"].get(OS_NAME) else {
            continue;
        };
        let classifier = classifier
            .as_str()
            .context("Expected a native classifier string")?
            .replacen("${arch}", ARCHITECTURE_BITS, 1);
        let native = match downloads {
            Some(downloads) => {
                string_field(&downloads["classifiers"][classifier.as_str()], "path")?.to_owned()
            }
            None => maven_path(string_field(library, "name")?, Some(&classifier))?,
        };
        extract_natives(
            &libraries.join(relative_path(&native)?),
            natives,
            &native_exclusions(library)?,
        )?;
    }
    add(jar)?;
    Ok(classpath)
}
