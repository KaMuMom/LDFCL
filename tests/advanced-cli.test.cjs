const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const project = path.resolve(__dirname, "..");
const bin = path.join(project, "bin", "ldfcl-cli.cjs");

async function put(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value);
}
async function fixture(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "LDFCL advanced CLI 中文 "),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "配置"),
    gameRoot = path.join(root, "游戏", ".minecraft"),
    versionDirectory = "测试版本 1.21.1",
    directory = path.join(gameRoot, "versions", versionDirectory);
  const instance = {
    id: "cli-test-instance",
    name: "CLI 测试实例",
    version: "1.21.1",
    loader: "vanilla",
    versionDirectory,
    gameDirectoryId: "cli-root",
    createdAt: "2026-10-22T00:00:00.000Z",
    gameSettings: {},
    memoryMb: 512,
    javaPath: path.join(root, "不存在的Java", "java.exe"),
  };
  await put(
    path.join(directory, `${versionDirectory}.json`),
    JSON.stringify({
      id: versionDirectory,
      minecraftVersion: "1.21.1",
      mainClass: "net.minecraft.client.main.Main",
      javaVersion: { majorVersion: 21 },
      libraries: [],
    }),
  );
  await put(
    path.join(directory, `${versionDirectory}.jar`),
    "synthetic client; never launched",
  );
  await put(
    path.join(directory, ".ldfcl/launch.json"),
    JSON.stringify({ version: versionDirectory }),
  );
  await put(
    path.join(directory, "options.txt"),
    "renderDistance:8\ncustomUnmanaged:keep\n",
  );
  await put(path.join(directory, "config", "设置.json"), "initial-config");
  await put(
    path.join(directory, "saves", "世界", "level.dat"),
    "preserve-world",
  );
  await put(
    path.join(dataDir, "launcher.json"),
    JSON.stringify({
      instances: [instance],
      gameDirectories: [
        {
          id: "cli-root",
          name: "测试游戏根",
          path: gameRoot,
          layout: "standard",
        },
      ],
      selectedGameDirectoryId: "cli-root",
      selectedInstanceId: instance.id,
      settings: {
        memoryMode: "manual",
        memoryMb: 512,
        javaPath: instance.javaPath,
      },
    }),
  );
  return { root, dataDir, gameRoot, directory, instance };
}
function run(f, args, extra = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (
        [
          "node_options",
          "ldfcl_data_dir",
          "ldfcl_game_root",
          "electron_run_as_node",
        ].includes(key.toLowerCase())
      )
        delete env[key];
    const child = spawn(
      process.execPath,
      [
        bin,
        ...args,
        "--json",
        "--data-dir",
        extra.dataDir || f.dataDir,
        "--game-root",
        extra.gameRoot || f.gameRoot,
      ],
      {
        cwd: project,
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (value) => {
      stdout += value;
    });
    child.stderr.on("data", (value) => {
      stderr += value;
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(Error("Advanced CLI timed out"));
    }, 45000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let value;
      try {
        value = stdout ? JSON.parse(stdout) : undefined;
      } catch {
        reject(Error(`CLI stdout is not JSON: ${stdout}`));
        return;
      }
      resolve({ code, stdout, stderr, value });
    });
  });
}
async function success(f, args, extra) {
  const result = await run(f, args, extra);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  return result.value;
}

test("advanced CLI exports/diffs manifests and rebuilds a standalone bundle in a fresh store", async (t) => {
  const f = await fixture(t),
    before = path.join(f.root, "before.json"),
    after = path.join(f.root, "after.json"),
    bundle = path.join(f.root, "portable bundle");
  const exported = await success(f, [
    "instance",
    "manifest",
    f.instance.id,
    "--output",
    before,
  ]);
  assert.equal(exported.manifest.instance.id, f.instance.id);
  await put(path.join(f.directory, "config", "设置.json"), "updated-config");
  await success(f, ["instance", "manifest", f.instance.id, "--output", after]);
  const diff = await success(f, ["instance", "diff", before, after]);
  assert.equal(
    diff.changed.some((change) => change.before.path === "config/设置.json"),
    true,
  );
  await success(f, ["instance", "manifest", f.instance.id, "--bundle", bundle]);
  await fs.access(path.join(bundle, "manifest.json"));
  const other = {
    dataDir: path.join(f.root, "干净配置"),
    gameRoot: path.join(f.root, "干净游戏"),
  };
  const rebuilt = await success(
    f,
    ["instance", "rebuild", "--bundle", bundle],
    other,
  );
  assert.notEqual(rebuilt.id, f.instance.id);
  assert.equal(rebuilt.javaPath, "");
  const target = path.join(
    other.gameRoot,
    "versions",
    rebuilt.versionDirectory,
  );
  assert.equal(
    await fs.readFile(path.join(target, "config", "设置.json"), "utf8"),
    "updated-config",
  );
  assert.equal(
    await fs.readFile(path.join(target, "saves", "世界", "level.dat"), "utf8"),
    "preserve-world",
  );
  const stats = await success(f, ["store", "stats"], other);
  assert.ok(stats.objects > 0);
  assert.ok(stats.logicalBytes > 0);
  const duplicate = await run(
    f,
    ["instance", "rebuild", "--bundle", bundle],
    other,
  );
  assert.equal(duplicate.code, 1);
  assert.match(duplicate.stderr, /同名版本/);
});

test("advanced CLI snapshot restore previews by default and --apply restores settings while preserving worlds", async (t) => {
  const f = await fixture(t),
    created = await success(f, [
      "snapshot",
      "create",
      f.instance.id,
      "--name",
      "CLI 稳定状态",
    ]);
  await put(
    path.join(f.directory, "options.txt"),
    "renderDistance:20\ncustomUnmanaged:keep\n",
  );
  await put(
    path.join(f.directory, "saves", "世界", "level.dat"),
    "new-world-progress",
  );
  const preview = await success(f, [
    "snapshot",
    "restore",
    f.instance.id,
    "--snapshot",
    created.id,
  ]);
  assert.ok(preview.previewId);
  assert.equal(
    preview.diff.changed.some((change) => change.before.path === "options.txt"),
    true,
  );
  assert.match(
    await fs.readFile(path.join(f.directory, "options.txt"), "utf8"),
    /renderDistance:20/,
  );
  const applied = await success(f, [
    "snapshot",
    "restore",
    f.instance.id,
    "--snapshot",
    created.id,
    "--apply",
  ]);
  assert.ok(applied.preRestoreSnapshotId);
  assert.match(
    await fs.readFile(path.join(f.directory, "options.txt"), "utf8"),
    /renderDistance:8/,
  );
  assert.equal(
    await fs.readFile(
      path.join(f.directory, "saves", "世界", "level.dat"),
      "utf8",
    ),
    "new-world-progress",
  );
  const snapshots = await success(f, ["snapshot", "list", f.instance.id]);
  assert.equal(
    snapshots.some((snapshot) => snapshot.id === applied.preRestoreSnapshotId),
    true,
  );
});

test("advanced CLI health fix requires --auto and persists actual memory/Java corrections", async (t) => {
  const f = await fixture(t),
    report = await success(f, ["health", "scan", f.instance.id]);
  assert.equal(report.instanceId, f.instance.id);
  assert.equal(
    report.issues.some((issue) => issue.autoFix === "java-auto"),
    true,
  );
  const blocked = await run(f, ["health", "fix", f.instance.id]);
  assert.equal(blocked.code, 1);
  assert.match(blocked.stderr, /--auto/);
  const result = await success(f, ["health", "fix", f.instance.id, "--auto"]);
  assert.equal(
    result.changes.some(
      (change) =>
        change.issueId === "java:mismatch" && change.status === "fixed",
    ),
    true,
  );
  assert.equal(
    result.changes.some(
      (change) =>
        change.issueId === "memory:allocation" && change.status === "fixed",
    ),
    true,
  );
  const config = JSON.parse(
    await fs.readFile(path.join(f.dataDir, "launcher.json"), "utf8"),
  );
  assert.equal(config.settings.memoryMode, "auto");
  assert.equal(config.settings.javaPath, "");
  assert.equal(
    config.instances.find((i) => i.id === f.instance.id).memoryMb,
    undefined,
  );
  assert.equal(
    await fs.readFile(
      path.join(f.directory, "saves", "世界", "level.dat"),
      "utf8",
    ),
    "preserve-world",
  );
});
