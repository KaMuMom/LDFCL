use anyhow::{Context, Result, ensure};
use ldfcl::launcher::{GameLayout, launch, required_java_major};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    env, fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Output},
};
use zip::{ZipWriter, write::SimpleFileOptions};

const CLASS: &str = "fixture.Main";
const LITERAL: &str = "with space \"quote\" \\";
const RECORD: &str = "launch-record.json";
const NATIVE_ARGUMENT: &str = "-Djava.library.path=";
const MODERN_VERSIONS: [&str; 4] = ["modern", "pcl-fabric", "pcl-shared", "hmcl-local"];

#[derive(Debug, PartialEq, Serialize, Deserialize)]
struct Invocation {
    cwd: PathBuf,
    args: Vec<String>,
}

fn main() -> Result<()> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    if args.first().is_some_and(|arg| arg == "-Xmx2G") {
        let cwd = env::current_dir()?;
        let natives = native_path(&args)?;
        ensure!(natives.join("native.bin").is_file(), "missing native");
        ensure!(
            !natives.join("META-INF").exists(),
            "included excluded native metadata"
        );
        let failed = args.iter().any(|arg| arg == "--fail-fixture");
        fs::write(
            cwd.join(RECORD),
            serde_json::to_vec(&Invocation { cwd, args })?,
        )?;
        println!("Java fixture ran");
        if failed {
            std::process::exit(37);
        }
        return Ok(());
    }

    let fixture = tempfile::tempdir()?;
    let parent = fixture.path().join("启动测试 with space");
    let root = parent.join(".minecraft");
    create_game(&root)?;
    let java = fixture
        .path()
        .join(format!("fake java{}", env::consts::EXE_SUFFIX));
    fs::copy(env::current_exe()?, &java)?;
    let cli = Path::new(env!("CARGO_BIN_EXE_ldfcl-cli"));
    let original_cli = env::var_os("LDFCL_BASELINE_CLI").map(PathBuf::from);

    let expected = "pcl-shared\npcl-fabric\nmodern\nlegacy\nhmcl-local\nfailure\n";
    for command in std::iter::once(cli).chain(original_cli.as_deref()) {
        let output = Command::new(command)
            .arg("list")
            .arg("--game-dir")
            .arg(&parent)
            .output()?;
        checked(&output)?;
        ensure!(
            String::from_utf8(output.stdout)?.replace("\r\n", "\n") == expected,
            "incorrect version list from {}",
            command.display()
        );
    }
    for version in MODERN_VERSIONS.into_iter().chain(["legacy"]) {
        let isolated = matches!(version, "pcl-fabric" | "hmcl-local");
        let instance = if isolated {
            root.join("versions").join(version)
        } else {
            root.clone()
        };
        let invocation = run_cli(cli, &parent, &java, version, &instance)?;
        verify_arguments(&invocation, &root, &instance, version)?;
        if let Some(original_cli) = original_cli.as_deref() {
            let original = run_cli(original_cli, &parent, &java, version, &instance)?;
            ensure!(
                normalized(original) == normalized(invocation),
                "Rust and C++ produced different launch arguments for {version}"
            );
        }
    }

    ensure!(
        required_java_major(&parent, "pcl-fabric")? == 21,
        "Java inheritance failed"
    );
    ensure!(
        required_java_major(&parent, "legacy")? == 8,
        "legacy Java selection failed"
    );

    let cache = fixture.path().join("cache/natives");
    let log = fixture.path().join("launch.log");
    let code = launch(
        &parent,
        "failure",
        &java,
        Some(&log),
        GameLayout::Isolated,
        Some(&cache),
    )?;
    ensure!(code == 37, "wrong Java exit code: {code}");
    ensure!(
        fs::read_to_string(log)?.contains("Java fixture ran"),
        "missing Java output in log"
    );
    ensure!(
        fs::read_dir(&cache)?.next().is_none(),
        "native cache was not cleaned on exit"
    );
    let failed_dir = root.join("versions/failure");
    let invocation: Invocation = serde_json::from_slice(&fs::read(failed_dir.join(RECORD))?)?;
    ensure!(
        equivalent(&invocation.cwd, &failed_dir)?,
        "explicit isolated layout ignored"
    );

    let native_jar = root.join("libraries/com/fixture/base/1.0/base-1.0-natives.jar");
    let mut zip = ZipWriter::new(fs::File::create(native_jar)?);
    zip.start_file("../escape.bin", SimpleFileOptions::default())?;
    zip.write_all(b"escape")?;
    zip.finish()?;
    ensure!(
        launch(
            &root,
            "modern",
            &java,
            None,
            GameLayout::Automatic,
            Some(&cache)
        )
        .is_err(),
        "unsafe archive name was accepted"
    );
    ensure!(
        fs::read_dir(&cache)?.next().is_none(),
        "native cache was not cleaned on error"
    );

    fs::remove_file(root.join("libraries/com/fixture/base/1.0/base-1.0.jar"))?;
    let output = Command::new(cli)
        .args(["launch", "modern", "--game-dir"])
        .arg(&parent)
        .arg("--java")
        .arg(&java)
        .output()?;
    ensure!(
        !output.status.success()
            && String::from_utf8_lossy(&output.stderr).contains("base-1.0.jar"),
        "missing local dependency did not report its path"
    );
    Ok(())
}

fn create_game(root: &Path) -> Result<()> {
    let os = match env::consts::OS {
        "macos" => "osx",
        name => name,
    };
    let base = "com/fixture/base/1.0";
    fs::create_dir_all(root.join("libraries").join(base))?;
    fs::write(
        root.join("libraries").join(base).join("base-1.0.jar"),
        b"fixture",
    )?;
    fs::create_dir_all(root.join("libraries/com/fixture/loader/1.0"))?;
    fs::write(
        root.join("libraries/com/fixture/loader/1.0/loader-1.0.jar"),
        b"fixture",
    )?;
    let native_jar = root
        .join("libraries")
        .join(base)
        .join("base-1.0-natives.jar");
    let mut archive = ZipWriter::new(fs::File::create(native_jar)?);
    for entry in ["native.bin", "META-INF/ignored.txt"] {
        archive.start_file(entry, SimpleFileOptions::default())?;
        archive.write_all(b"native fixture")?;
    }
    archive.finish()?;
    fs::create_dir_all(root.join("assets/indexes"))?;
    fs::write(root.join("assets/indexes/fixture.json"), b"{}")?;

    let libraries = json!([
        {"name":"com.fixture:base:1.0", "natives":{(os):"natives"},
         "downloads":{"artifact":{"path":format!("{base}/base-1.0.jar")},
                      "classifiers":{"natives":{"path":format!("{base}/base-1.0-natives.jar")}}}},
        {"name":"fixture:irrelevant:1", "rules":[{"action":"allow","os":{"name":"unrelated-platform"}}]}
    ]);
    version(
        root,
        "modern",
        json!({
            "mainClass":CLASS, "assetIndex":{"id":"fixture"}, "libraries":libraries,
            "javaVersion":{"majorVersion":21},
            "arguments":{
                "jvm":["-Djava.library.path=${natives_directory}","-cp","${classpath}",
                       {"rules":[{"action":"allow","os":{"name":os}}],"value":"-Dplatform=matched"}],
                "game":["--username","${auth_player_name}","--accessToken","${auth_access_token}",
                        "--gameDir","${game_directory}","--version","${version_name}","--literal",LITERAL,
                        {"rules":[{"action":"allow","features":{"is_demo_user":true}}],"value":"--demo"}]
            }
        }),
        true,
    )?;
    version(
        root,
        "legacy",
        json!({
            "id":"1.16.5", "mainClass":CLASS, "libraries":libraries,
            "minecraftArguments":"--username ${auth_player_name} --accessToken ${auth_access_token} --gameDir ${game_directory} --version ${version_name}"
        }),
        true,
    )?;
    version(
        root,
        "pcl-fabric",
        json!({"inheritsFrom":"modern","libraries":[{"name":"com.fixture:loader:1.0"}],
        "arguments":{"game":["--loader","fabric"]}}),
        false,
    )?;
    version(root, "pcl-shared", json!({"inheritsFrom":"modern"}), false)?;
    version(root, "hmcl-local", json!({"inheritsFrom":"modern"}), false)?;
    version(root, "loop", json!({"inheritsFrom":"loop"}), false)?;
    version(
        root,
        "failure",
        json!({"inheritsFrom":"modern","arguments":{"game":["--fail-fixture"]}}),
        false,
    )?;
    for (id, value) in [("pcl-fabric", "True"), ("pcl-shared", "False")] {
        let pcl = root.join("versions").join(id).join("PCL");
        fs::create_dir_all(&pcl)?;
        fs::write(
            pcl.join("Setup.ini"),
            format!("VersionArgumentIndieV2:{value}\r\n"),
        )?;
    }
    fs::create_dir_all(root.join("versions/pcl-shared/saves"))?;
    let hmcl = root.join("versions/hmcl-local/.hmcl/config");
    fs::create_dir_all(&hmcl)?;
    fs::write(
        hmcl.join("instance-game-settings.json"),
        r#"{"overrideProperties":["runningDirectory"],"runningDirectory":""}"#,
    )?;
    Ok(())
}

fn version(root: &Path, id: &str, metadata: Value, client: bool) -> Result<()> {
    let folder = root.join("versions").join(id);
    fs::create_dir_all(&folder)?;
    fs::write(
        folder.join(format!("{id}.json")),
        serde_json::to_vec(&metadata)?,
    )?;
    if client {
        fs::write(folder.join(format!("{id}.jar")), b"fixture client")?;
    }
    Ok(())
}

fn checked(output: &Output) -> Result<()> {
    ensure!(
        output.status.success(),
        "launcher failed: {}\n{}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(())
}

fn run_cli(
    cli: &Path,
    parent: &Path,
    java: &Path,
    version: &str,
    instance: &Path,
) -> Result<Invocation> {
    let record = instance.join(RECORD);
    if record.is_file() {
        fs::remove_file(&record)?;
    }
    let output = Command::new(cli)
        .args(["launch", version, "--game-dir"])
        .arg(parent)
        .arg("--java")
        .arg(java)
        .output()?;
    checked(&output).with_context(|| format!("{} launch {version}", cli.display()))?;
    let invocation: Invocation = serde_json::from_slice(
        &fs::read(&record).with_context(|| format!("missing launch record for {version}"))?,
    )?;
    ensure!(
        !native_path(&invocation.args)?.exists(),
        "native libraries were not cleaned up"
    );
    Ok(invocation)
}

fn native_path(args: &[String]) -> Result<PathBuf> {
    args.iter()
        .find_map(|arg| arg.strip_prefix(NATIVE_ARGUMENT))
        .map(PathBuf::from)
        .context("missing Java native path")
}

fn parameter<'a>(args: &'a [String], name: &str) -> Result<&'a str> {
    args.windows(2)
        .find(|window| window[0] == name)
        .map(|window| window[1].as_str())
        .with_context(|| format!("missing {name} argument"))
}

fn equivalent(left: &Path, right: &Path) -> Result<bool> {
    Ok(left.canonicalize()? == right.canonicalize()?)
}

fn verify_arguments(
    invocation: &Invocation,
    root: &Path,
    instance: &Path,
    version: &str,
) -> Result<()> {
    let args = &invocation.args;
    ensure!(
        equivalent(&invocation.cwd, instance)?,
        "wrong working directory for {version}"
    );
    ensure!(
        equivalent(Path::new(parameter(args, "--gameDir")?), instance)?,
        "wrong gameDir"
    );
    ensure!(parameter(args, "--version")? == version, "wrong version");
    ensure!(
        parameter(args, "--username")? == "Player" && parameter(args, "--accessToken")? == "0",
        "wrong offline identity"
    );
    ensure!(
        args.iter().any(|arg| arg == CLASS) && !args.iter().any(|arg| arg == "--demo"),
        "wrong class or rules"
    );
    let base = if version == "legacy" {
        "legacy"
    } else {
        "modern"
    };
    let mut jars = Vec::new();
    if version == "pcl-fabric" {
        jars.push(root.join("libraries/com/fixture/loader/1.0/loader-1.0.jar"));
        ensure!(
            parameter(args, "--loader")? == "fabric",
            "missing Fabric argument"
        );
    }
    jars.push(root.join("libraries/com/fixture/base/1.0/base-1.0.jar"));
    jars.push(root.join("versions").join(base).join(format!("{base}.jar")));
    let classpath = env::split_paths(parameter(args, "-cp")?).collect::<Vec<_>>();
    ensure!(classpath.len() == jars.len(), "wrong classpath size");
    for (actual, expected) in classpath.iter().zip(jars) {
        ensure!(
            equivalent(actual, &expected)?,
            "wrong classpath ordering or artifact"
        );
    }
    if version != "legacy" {
        ensure!(
            args.iter().any(|arg| arg == "-Dplatform=matched"),
            "platform rule didn't match"
        );
        ensure!(
            parameter(args, "--literal")? == LITERAL,
            "argument boundary was broken"
        );
    }
    Ok(())
}

fn normalized(mut invocation: Invocation) -> Invocation {
    for arg in &mut invocation.args {
        if arg.starts_with(NATIVE_ARGUMENT) {
            *arg = NATIVE_ARGUMENT.to_string();
        }
    }
    invocation
}
