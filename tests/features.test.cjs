const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const AdmZip = require("adm-zip");
const { createLauncherCore } = require("@ldfcl/core/launcher");
const {
  InstanceStorageService,
} = require("@ldfcl/core/services/instance-manifest");

const host = {
  chooseFiles: async () => ({ canceled: true, filePaths: [] }),
  chooseSaveFile: async () => ({ canceled: true }),
  openPath: async () => "",
  openExternal: async () => {},
  trashItem: async () => {},
  imageDataUrl: () => "",
  focusWindow() {},
  minimizeWindow() {},
};
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "LDFCL-features-"));
  let core;
  t.after(async () => {
    core?.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  const gameRoot = path.join(root, ".minecraft"),
    directory = path.join(gameRoot, "versions", "1.21.1");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "1.21.1.json"),
    JSON.stringify({
      id: "1.21.1",
      mainClass: "net.minecraft.client.main.Main",
      javaVersion: { majorVersion: 21 },
      libraries: [],
    }),
  );
  await fs.writeFile(
    path.join(directory, "options.txt"),
    "renderDistance:12\ncustomUnmanaged:value\n",
  );
  await fs.mkdir(path.join(directory, "saves", "keep"), { recursive: true });
  await fs.writeFile(
    path.join(directory, "saves", "keep", "level.dat"),
    "world",
  );
  core = await createLauncherCore({
    dataDir: path.join(root, "LDFCL-data"),
    defaultGameRoot: gameRoot,
    host,
  });
  const instance = (await core.state()).instances[0];
  return { root, gameRoot, directory, core, instance };
}

test("opening and browsing game roots do not migrate all instance content; first mutation preserves originals", async (t) => {
  const migrate = InstanceStorageService.prototype.migrate;
  let attempted = 0;
  InstanceStorageService.prototype.migrate = async () => {
    attempted++;
    throw Error("Startup must not migrate or hash worlds");
  };
  let f;
  try {
    f = await fixture(t);
    const current = await f.core.state();
    const otherRoot = path.join(f.root, "other-root");
    await fs.mkdir(otherRoot);
    await f.core.call("game-directory:add", { path: otherRoot });
    await f.core.call("game-directory:select", {
      id: current.selectedGameDirectoryId,
    });
    await f.core.call("game-directory:scan");
    assert.equal(attempted, 0, "Browsing must leave CAS migration lazy");
    await assert.rejects(
      fs.access(path.join(f.directory, ".ldfcl/cas-migration.json")),
      { code: "ENOENT" },
    );
  } finally {
    InstanceStorageService.prototype.migrate = migrate;
  }
  await f.core.call("instance:save", {
    id: f.instance.id,
    gameSettings: { renderDistance: 6 },
  });
  const marker = JSON.parse(
    await fs.readFile(
      path.join(f.directory, ".ldfcl/cas-migration.json"),
      "utf8",
    ),
  );
  const original = await fs.readFile(
    path.join(
      f.directory,
      ".ldfcl/migration-backups",
      marker.backupId,
      "files/options.txt",
    ),
    "utf8",
  );
  assert.match(original, /renderDistance:12/);
  assert.match(
    await fs.readFile(path.join(f.directory, "options.txt"), "utf8"),
    /renderDistance:6/,
  );
  assert.equal(
    await fs.readFile(path.join(f.directory, "saves/keep/level.dat"), "utf8"),
    "world",
  );
});

test("core instance mutations create snapshots and rollback synchronizes registry without touching worlds", async (t) => {
  const f = await fixture(t);
  await f.core.call("instance:save", {
    id: f.instance.id,
    gameSettings: { renderDistance: 6 },
  });
  const snapshots = await f.core.call("snapshot:list", { id: f.instance.id });
  assert.ok(snapshots.length);
  assert.equal(
    (await f.core.state()).instances[0].gameSettings.renderDistance,
    6,
  );
  const preview = await f.core.call("snapshot:preview", {
    id: f.instance.id,
    snapshotId: snapshots[0].id,
  });
  assert.ok(preview);
  await assert.rejects(
    f.core.call("snapshot:restore", {
      id: f.instance.id,
      snapshotId: snapshots[0].id,
    }),
    /确认/,
  );
  await f.core.call("snapshot:restore", {
    id: f.instance.id,
    snapshotId: snapshots[0].id,
    expectedPreviewId: preview.previewId,
    apply: true,
  });
  assert.deepEqual((await f.core.state()).instances[0].gameSettings, {});
  assert.match(
    await fs.readFile(path.join(f.directory, "options.txt"), "utf8"),
    /renderDistance:12/,
  );
  assert.equal(
    await fs.readFile(
      path.join(f.directory, "saves", "keep", "level.dat"),
      "utf8",
    ),
    "world",
  );
  assert.ok(
    (await f.core.call("snapshot:list", { id: f.instance.id })).length >
      snapshots.length,
  );
});
test("health fix records actual changes, enables a disabled required mod and leaves unsupported findings visible", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.directory, "mods"));
  // Vanilla does not hide arbitrary local mod metadata; the presence scan is local.
  for (const [file, id, depends] of [
    ["needs.jar", "needs", { api: "*" }],
    ["api.jar.disabled", "api", {}],
  ]) {
    const zip = new AdmZip();
    zip.addFile(
      "fabric.mod.json",
      Buffer.from(JSON.stringify({ id, version: "1", depends })),
    );
    zip.writeZip(path.join(f.directory, "mods", file));
  }
  await f.core.call("instance:save", {
    id: f.instance.id,
    memoryMb: 512,
    javaPath: path.join(f.root, "does-not-exist", "java.exe"),
  });
  const before = await f.core.call("health:scan", { id: f.instance.id });
  assert.ok(before.issues.some((issue) => issue.id === "java:mismatch"));
  assert.ok(
    before.issues.some((issue) => issue.autoFix === "enable-dependency"),
  );
  await assert.rejects(
    f.core.call("health:fix", { id: f.instance.id }),
    /自动修复/,
  );
  const result = await f.core.call("health:fix", {
    id: f.instance.id,
    auto: true,
  });
  assert.ok(
    result.changes.filter((change) => change.status === "fixed").length >= 3,
  );
  assert.equal((await f.core.state()).instances[0].memoryMb, undefined);
  assert.equal((await f.core.state()).settings.javaPath, "");
  await fs.access(path.join(f.directory, "mods", "api.jar"));
  const logs = await fs.readdir(path.join(f.directory, ".ldfcl", "health"));
  assert.ok(logs.some((name) => name.startsWith("fix-")));
});
test("core manifest export and rebuild from bundle register an isolated new instance in a clean game root", async (t) => {
  const f = await fixture(t);
  const bundle = path.join(f.root, "portable-bundle");
  const exported = await f.core.call("instance:manifest", {
    id: f.instance.id,
    bundle,
  });
  assert.equal(exported.path, bundle);
  const other = path.join(f.root, "clean-root");
  await fs.mkdir(other);
  await f.core.call("game-directory:add", { path: other });
  const rebuilt = await f.core.call("instance:rebuild", { bundle });
  assert.notEqual(rebuilt.id, f.instance.id);
  assert.equal((await f.core.state()).selectedInstanceId, rebuilt.id);
  await fs.access(
    path.join(
      other,
      "versions",
      rebuilt.versionDirectory,
      rebuilt.versionDirectory + ".json",
    ),
  );
  await assert.rejects(f.core.call("instance:rebuild", { bundle }), /同名版本/);
  assert.equal(
    await fs.readFile(
      path.join(f.directory, "saves", "keep", "level.dat"),
      "utf8",
    ),
    "world",
  );
});
test("advanced JVM arguments cannot gain executable, classpath or authentication control", async (t) => {
  const f = await fixture(t);
  for (const jvmArgs of [
    ["-javaagent:evil.jar"],
    ["-cp", "evil.jar"],
    ["-Xmx100G"],
    ["-Dauth=secret"],
  ])
    await assert.rejects(
      f.core.call("instance:save", { id: f.instance.id, jvmArgs }),
      /JVM/,
    );
  await f.core.call("instance:save", {
    id: f.instance.id,
    jvmArgs: ["-XX:+UseG1GC", "-XX:MaxGCPauseMillis=200"],
  });
  assert.deepEqual((await f.core.state()).instances[0].jvmArgs, [
    "-XX:+UseG1GC",
    "-XX:MaxGCPauseMillis=200",
  ]);
});
