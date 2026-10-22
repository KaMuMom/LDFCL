const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const compiledRoot =
  process.env.LDFCL_TEST_COMPILED_ROOT ||
  path.join(__dirname, "..", "core", "dist");
const {
  ContentStore,
  sha256File,
  storagePath,
  ensurePrivateFile,
  withInstanceStorageLock,
} = require(path.join(compiledRoot, "core/services/content-store.js"));
const { InstanceStorageService, validateInstanceManifest } = require(
  path.join(compiledRoot, "core/services/instance-manifest.js"),
);
const { SnapshotService } = require(
  path.join(compiledRoot, "core/services/snapshots.js"),
);

async function put(root, relative, value) {
  const target = path.join(root, ...relative.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, value);
  return target;
}
async function fixture(t, id = "测试实例") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ldfcl-storage-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "LDFCL-data"),
    minecraftRoot = path.join(root, ".minecraft"),
    dir = path.join(minecraftRoot, "versions", id);
  await fs.mkdir(dir, { recursive: true });
  const instance = {
    id: "instance-uuid",
    name: "测试实例",
    version: "1.21.1",
    loader: "vanilla",
    createdAt: new Date().toISOString(),
    versionDirectory: id,
    gameSettings: { gamma: 0.5 },
  };
  await put(
    dir,
    `${id}.json`,
    JSON.stringify({
      id,
      mainClass: "net.minecraft.client.main.Main",
      libraries: [
        {
          name: "example:patched:1",
          downloads: { artifact: { path: "example/patched/1/patched-1.jar" } },
        },
      ],
    }),
  );
  await put(dir, `${id}.jar`, "client");
  await put(dir, "instance.json", JSON.stringify(instance));
  await put(dir, ".ldfcl/launch.json", JSON.stringify({ version: id }));
  await put(
    minecraftRoot,
    "libraries/example/patched/1/patched-1.jar",
    "offline-patched-library",
  );
  return {
    root,
    dataDir,
    minecraftRoot,
    dir,
    instance,
    storage: new InstanceStorageService({ dataDir, minecraftRoot }),
    snapshots: new SnapshotService({ dataDir, minecraftRoot }),
  };
}

test("CAS deduplicates verified bytes; config/options materializations stay independently writable", async (t) => {
  const f = await fixture(t),
    source = await put(f.root, "source.txt", "same-config");
  const cas = new ContentStore({ dataDir: f.dataDir });
  const first = await cas.putFile(source),
    second = await cas.putFile(source);
  assert.equal(first.sha256, second.sha256);
  const entry = { ...first, mutable: true };
  const a = path.join(f.root, "a.txt"),
    b = path.join(f.root, "b.txt");
  assert.equal((await cas.materialize(entry, a)).materialization, "copy");
  await cas.materialize(entry, b);
  await fs.writeFile(a, "changed");
  assert.equal(await fs.readFile(b, "utf8"), "same-config");
  await cas.verify(first.sha256);
  assert.equal((await cas.objects()).length, 1);
});

test("read-only archive hardlinks can be privatized before editing without corrupting CAS", async (t) => {
  const f = await fixture(t),
    source = await put(f.root, "mod.jar", "immutable-mod");
  const cas = new ContentStore(f.dataDir),
    digest = await cas.putFile(source),
    target = path.join(f.root, "materialized.jar");
  const result = await cas.materialize({ ...digest, mutable: false }, target);
  assert.ok(["hardlink", "copy"].includes(result.materialization));
  await ensurePrivateFile(target);
  await fs.writeFile(target, "updated-mod");
  assert.equal(
    await fs.readFile(await cas.verify(digest.sha256), "utf8"),
    "immutable-mod",
  );
});

test("CAS supports filesystems lacking hardlink support and records materialization fallback", async (t) => {
  const f = await fixture(t),
    source = await put(f.root, "archive.jar", "archive");
  const cas = new ContentStore(f.dataDir),
    original = fs.link;
  fs.link = async () => {
    const error = new Error("unsupported");
    error.code = "EPERM";
    throw error;
  };
  try {
    const digest = await cas.putFile(source),
      target = path.join(f.root, "fallback.jar");
    assert.deepEqual(
      await cas.materialize({ ...digest, mutable: false }, target),
      { materialization: "copy", fallbackReason: "hardlink-EPERM" },
    );
    assert.equal(await sha256File(target), digest.sha256);
  } finally {
    fs.link = original;
  }
});

test("legacy migration backs up original bytes, excludes secrets/private state and is idempotent", async (t) => {
  const f = await fixture(t);
  await put(f.dir, "mods/中文.jar", "mod");
  await put(f.dir, "config/options.json", "config");
  await put(f.dir, "accounts.json", "secret-account-data");
  await put(f.dir, ".ldfcl/snapshots/old.json", "must-not-export");
  const first = await f.storage.migrate(f.dir, { instance: f.instance });
  assert.equal(first.migrated, true);
  assert.equal(
    await fs.readFile(
      path.join(
        f.dir,
        ".ldfcl/migration-backups",
        first.backupId,
        "files/mods/中文.jar",
      ),
      "utf8",
    ),
    "mod",
  );
  assert.equal(
    first.manifest.files.some((x) =>
      /accounts|snapshots|migration-backups/.test(x.path),
    ),
    false,
  );
  assert.equal((await f.storage.migrate(f.dir)).migrated, false);
  assert.equal(
    first.manifest.sharedFiles.some((x) => x.path.includes("patched-1.jar")),
    true,
  );
  await fs.writeFile(path.join(f.dir, "config/options.json"), "new-config");
  await f.storage.rollbackMigration(f.dir);
  assert.equal(
    await fs.readFile(path.join(f.dir, "config/options.json"), "utf8"),
    "new-config",
  );
  assert.equal(
    await fs.readFile(path.join(f.dir, "mods/中文.jar"), "utf8"),
    "mod",
  );
});

test("standalone bundle restores custom libraries in a fresh store and game root", async (t) => {
  const f = await fixture(t);
  await put(f.dir, "mods/离线.jar", "custom-mod");
  await put(f.dir, "config/game.json", "custom-config");
  await put(f.dir, "saves/世界/level.dat", "world");
  const bundle = path.join(f.root, "bundle");
  const exported = await f.storage.exportBundle(f.dir, bundle);
  assert.equal(
    exported.manifest.instance.versionDirectory,
    path.basename(f.dir),
  );
  const newRoot = path.join(f.root, "clean-minecraft"),
    newData = path.join(f.root, "clean-data"),
    target = path.join(newRoot, "versions", path.basename(f.dir));
  const restore = new InstanceStorageService({
    dataDir: newData,
    minecraftRoot: newRoot,
  });
  await restore.rebuildFromBundle(bundle, target);
  assert.equal(
    await fs.readFile(path.join(target, "mods/离线.jar"), "utf8"),
    "custom-mod",
  );
  assert.equal(
    await fs.readFile(path.join(target, "saves/世界/level.dat"), "utf8"),
    "world",
  );
  assert.equal(
    await fs.readFile(
      path.join(newRoot, "libraries/example/patched/1/patched-1.jar"),
      "utf8",
    ),
    "offline-patched-library",
  );
  assert.equal(
    JSON.parse(
      await fs.readFile(path.join(target, ".ldfcl/launch.json"), "utf8"),
    ).version,
    path.basename(target),
  );
  await assert.rejects(
    restore.reconstruct(exported.manifest, target),
    /已存在/,
  );
});

test("bundle preserves NeoForge generated runtime JARs absent from declared libraries", async (t) => {
  const f = await fixture(t),
    id = path.basename(f.dir),
    mc = "1.21",
    neoForm = "20240613.152323",
    neoForge = "21.0.167";
  const profileFile = path.join(f.dir, `${id}.json`),
    profile = JSON.parse(await fs.readFile(profileFile, "utf8"));
  profile.inheritsFrom = "base";
  profile.arguments = {
    game: [
      "--fml.neoForgeVersion",
      neoForge,
      { value: ["--fml.neoFormVersion", neoForm] },
    ],
  };
  await fs.writeFile(profileFile, JSON.stringify(profile));
  await put(
    f.minecraftRoot,
    "versions/base/base.json",
    JSON.stringify({
      id: "base",
      arguments: { game: ["--fml.mcVersion", mc] },
    }),
  );
  const generated = [
    ...["extra", "slim", "srg"].map(
      (kind) =>
        `libraries/net/minecraft/client/${mc}-${neoForm}/client-${mc}-${neoForm}-${kind}.jar`,
    ),
    ...["client", "universal"].map(
      (kind) =>
        `libraries/net/neoforged/neoforge/${neoForge}/neoforge-${neoForge}-${kind}.jar`,
    ),
  ];
  for (const relative of generated)
    await put(f.minecraftRoot, relative, `generated-runtime:${relative}`);
  const excluded = [
    `libraries/net/minecraft/client/${mc}-${neoForm}/client-${mc}-${neoForm}-extra.jar.cache`,
    `libraries/net/neoforged/neoforge/${neoForge}/neoforge-${neoForge}-installer.jar`,
    "libraries/net/neoforged/neoforge/21.0.999/neoforge-21.0.999-universal.jar",
  ];
  for (const relative of excluded)
    await put(f.minecraftRoot, relative, "unrelated-or-build-only");
  const bundle = path.join(f.root, "neo-bundle"),
    exported = await f.storage.exportBundle(f.dir, bundle),
    shared = new Set(exported.manifest.sharedFiles.map((entry) => entry.path));
  for (const relative of generated) assert.equal(shared.has(relative), true);
  for (const relative of excluded) assert.equal(shared.has(relative), false);
  const freshRoot = path.join(f.root, "rebuilt-minecraft"),
    importer = new InstanceStorageService({
      dataDir: path.join(f.root, "rebuilt-data"),
      minecraftRoot: freshRoot,
    });
  await importer.rebuildFromBundle(
    bundle,
    path.join(freshRoot, "versions", id),
  );
  for (const relative of generated)
    assert.equal(
      await fs.readFile(path.join(freshRoot, relative), "utf8"),
      `generated-runtime:${relative}`,
    );
});

test("manifest rejects traversal, writable hardlink spoofing, private files and path aliases", async (t) => {
  const f = await fixture(t),
    original = await f.storage.rebuildManifest(f.dir, { instance: f.instance });
  for (const badPath of [
    "../outside",
    "C:/outside",
    "mods/a:stream",
    "mods/CON.jar",
    "mods/a\\b.jar",
    ".ldfcl/snapshots/a.json",
    "accounts.json",
  ]) {
    const bad = structuredClone(original);
    bad.files[0].path = badPath;
    assert.throws(() => validateInstanceManifest(bad));
  }
  const mutable = structuredClone(original);
  mutable.files[0] = {
    ...mutable.files[0],
    path: "config/a.json",
    mutable: false,
    role: "mod",
  };
  assert.throws(() => validateInstanceManifest(mutable), /可写策略/);
  const duplicate = structuredClone(original);
  duplicate.files.push({
    ...duplicate.files[0],
    path: duplicate.files[0].path.toUpperCase(),
  });
  assert.throws(() => validateInstanceManifest(duplicate), /重复/);
  assert.throws(() => storagePath(f.dir, "../outside"), /不安全/);
});

test("corrupt CAS and bundle bytes are rejected before destination publication", async (t) => {
  const f = await fixture(t),
    manifest = await f.storage.rebuildManifest(f.dir, { instance: f.instance });
  const blob = f.storage.contentStore.objectPath(manifest.files[0].sha256);
  await fs.chmod(blob, 0o600);
  await fs.writeFile(blob, "corrupt");
  const target = path.join(f.root, "new", "versions", manifest.directoryName);
  const restore = new InstanceStorageService({ dataDir: f.dataDir });
  await assert.rejects(restore.reconstruct(manifest, target), /校验失败/);
  await assert.rejects(fs.lstat(target), { code: "ENOENT" });
});

test("snapshot restore includes instance/source metadata and preserves progressed saves/logs", async (t) => {
  const f = await fixture(t);
  await put(f.dir, "mods/one.jar", "one");
  await put(f.dir, "config/设置.json", "old-config");
  await put(f.dir, "options.txt", "gamma:0.5\n");
  await put(f.dir, ".ldfcl-content.json", "old-source");
  await fs.mkdir(path.join(f.dir, "shaderpacks/空目录"), { recursive: true });
  await put(f.dir, "saves/世界/level.dat", "old-world");
  await put(f.dir, "logs/latest.log", "old-log");
  const snapshot = await f.snapshots.create(f.dir, { name: "稳定版本" });
  assert.equal(
    snapshot.files.some(
      (x) => x.path.startsWith("saves/") || x.path.startsWith("logs/"),
    ),
    false,
  );
  await put(f.dir, "mods/two.jar", "two");
  await fs.unlink(path.join(f.dir, "mods/one.jar"));
  await put(f.dir, "options.txt", "gamma:1\n");
  await put(
    f.dir,
    "instance.json",
    JSON.stringify({ ...f.instance, gameSettings: { gamma: 1 } }),
  );
  await put(f.dir, ".ldfcl-content.json", "new-source");
  await put(f.dir, "saves/世界/level.dat", "progressed-world");
  await put(f.dir, "logs/latest.log", "progressed-log");
  const preview = await f.snapshots.previewRestore(f.dir, snapshot.id);
  assert.equal(
    preview.diff.added.some((x) => x.path === "mods/one.jar"),
    true,
  );
  assert.equal(
    preview.diff.removed.some((x) => x.path === "mods/two.jar"),
    true,
  );
  const result = await f.snapshots.restore(f.dir, snapshot.id, {
    expectedPreviewId: preview.previewId,
  });
  assert.ok(result.preRestoreSnapshotId);
  assert.equal(
    await fs.readFile(path.join(f.dir, "mods/one.jar"), "utf8"),
    "one",
  );
  await assert.rejects(fs.lstat(path.join(f.dir, "mods/two.jar")), {
    code: "ENOENT",
  });
  assert.equal(
    await fs.readFile(path.join(f.dir, "saves/世界/level.dat"), "utf8"),
    "progressed-world",
  );
  assert.equal(
    await fs.readFile(path.join(f.dir, "logs/latest.log"), "utf8"),
    "progressed-log",
  );
  assert.equal(
    await fs.readFile(path.join(f.dir, ".ldfcl-content.json"), "utf8"),
    "old-source",
  );
  assert.equal(
    JSON.parse(await fs.readFile(path.join(f.dir, "instance.json")))
      .gameSettings.gamma,
    0.5,
  );
  assert.equal((await f.snapshots.list(f.dir)).length, 2);
  await f.snapshots.restore(f.dir, result.preRestoreSnapshotId);
  assert.equal(
    await fs.readFile(path.join(f.dir, "mods/two.jar"), "utf8"),
    "two",
  );
});

test("a stale rollback preview cannot overwrite changes made after review", async (t) => {
  const f = await fixture(t);
  await put(f.dir, "options.txt", "gamma:0.5");
  const snapshot = await f.snapshots.create(f.dir),
    preview = await f.snapshots.previewRestore(f.dir, snapshot.id);
  await put(f.dir, "options.txt", "gamma:1");
  await assert.rejects(
    f.snapshots.restore(f.dir, snapshot.id, {
      expectedPreviewId: preview.previewId,
    }),
    /重新预览/,
  );
  assert.equal(
    await fs.readFile(path.join(f.dir, "options.txt"), "utf8"),
    "gamma:1",
  );
});

test("failed mid-publish rollback restores every original path and retains a protection snapshot", async (t) => {
  const f = await fixture(t);
  await put(f.dir, "mods/mod.jar", "old-mod");
  await put(f.dir, "config/config.json", "old-config");
  const snapshot = await f.snapshots.create(f.dir);
  await put(f.dir, "mods/mod.jar", "new-mod");
  await put(f.dir, "config/config.json", "new-config");
  const failing = new SnapshotService({
    dataDir: f.dataDir,
    minecraftRoot: f.minecraftRoot,
    onTransactionStep: async (step) => {
      if (step === 2) throw Error("simulated filesystem failure");
    },
  });
  await assert.rejects(failing.restore(f.dir, snapshot.id), /simulated/);
  assert.equal(
    await fs.readFile(path.join(f.dir, "mods/mod.jar"), "utf8"),
    "new-mod",
  );
  assert.equal(
    await fs.readFile(path.join(f.dir, "config/config.json"), "utf8"),
    "new-config",
  );
  assert.equal((await f.snapshots.list(f.dir)).length, 2);
  assert.deepEqual(
    await fs.readdir(path.join(f.dir, ".ldfcl/transactions")),
    [],
  );
});

test("instance storage locks exclude concurrent writes and release after failure", async (t) => {
  const f = await fixture(t);
  await withInstanceStorageLock(f.dir, async () => {
    await assert.rejects(f.snapshots.create(f.dir), /正在执行/);
  });
  await assert.rejects(
    withInstanceStorageLock(f.dir, async () => {
      throw Error("failed");
    }),
    /failed/,
  );
  await f.snapshots.create(f.dir);
});

test("symbolic link and junction data are refused without reading outside the instance", async (t) => {
  const f = await fixture(t),
    outside = path.join(f.root, "outside");
  await put(outside, "secret.txt", "outside-secret");
  try {
    await fs.symlink(
      outside,
      path.join(f.dir, "config"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error.code)) {
      t.skip("symlink creation unavailable");
      return;
    }
    throw error;
  }
  await assert.rejects(f.snapshots.create(f.dir), /链接/);
  await assert.rejects(f.storage.rebuildManifest(f.dir), /链接/);
  assert.equal(
    await fs.readFile(path.join(outside, "secret.txt"), "utf8"),
    "outside-secret",
  );
});

test("a killed restore process recovers its durable journal before the next operation", async (t) => {
  const f = await fixture(t);
  await put(f.dir, "mods/mod.jar", "old-mod");
  await put(f.dir, "config/config.json", "old-config");
  const snapshot = await f.snapshots.create(f.dir);
  await put(f.dir, "mods/mod.jar", "current-mod");
  await put(f.dir, "config/config.json", "current-config");
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const {SnapshotService}=require(${JSON.stringify(path.join(compiledRoot, "core/services/snapshots.js"))});
    const service=new SnapshotService({dataDir:${JSON.stringify(f.dataDir)},minecraftRoot:${JSON.stringify(f.minecraftRoot)},onTransactionStep:async step=>{if(step===1)process.exit(73)}});
    service.restore(${JSON.stringify(f.dir)},${JSON.stringify(snapshot.id)}).catch(error=>{console.error(error);process.exitCode=1});
  `,
    ],
    { encoding: "utf8", windowsHide: true, timeout: 15000 },
  );
  assert.equal(child.status, 73, child.stderr);
  await f.snapshots.create(f.dir, { name: "恢复后" });
  assert.equal(
    await fs.readFile(path.join(f.dir, "mods/mod.jar"), "utf8"),
    "current-mod",
  );
  assert.equal(
    await fs.readFile(path.join(f.dir, "config/config.json"), "utf8"),
    "current-config",
  );
  assert.deepEqual(
    await fs.readdir(path.join(f.dir, ".ldfcl/transactions")),
    [],
  );
});

test("migration rollback repairs a corrupted shared CAS object from independent original bytes", async (t) => {
  const f = await fixture(t);
  await put(f.dir, "mods/mod.jar", "original-mod");
  const migration = await f.storage.migrate(f.dir, { instance: f.instance }),
    entry = migration.manifest.files.find((f) => f.path === "mods/mod.jar");
  const blob = f.storage.contentStore.objectPath(entry.sha256);
  await fs.chmod(blob, 0o600);
  await fs.writeFile(blob, "externally-corrupted");
  await assert.rejects(f.storage.contentStore.verify(entry.sha256), /校验失败/);
  await f.storage.rollbackMigration(f.dir);
  assert.equal(
    await fs.readFile(
      await f.storage.contentStore.verify(entry.sha256),
      "utf8",
    ),
    "original-mod",
  );
  assert.equal(
    await fs.readFile(path.join(f.dir, "mods/mod.jar"), "utf8"),
    "original-mod",
  );
  await f.storage.rebuildManifest(f.dir, { instance: f.instance });
});

test("an interrupted migration restores its original materialization before retrying", async (t) => {
  const f = await fixture(t);
  await put(f.dir, "mods/mod.jar", "original-mod");
  const migration = await f.storage.migrate(f.dir, { instance: f.instance });
  // State immediately after archive replacement, before the completed marker.
  await fs.unlink(path.join(f.dir, ".ldfcl/cas-migration.json"));
  await put(
    f.dir,
    ".ldfcl/migration-pending.json",
    JSON.stringify({ schemaVersion: 1, backupId: migration.backupId }),
  );
  await put(f.dir, "config/current.json", "preserve-later-config");
  const retried = await f.storage.migrate(f.dir, { instance: f.instance });
  assert.equal(retried.migrated, true);
  assert.equal(
    await fs.readFile(path.join(f.dir, "mods/mod.jar"), "utf8"),
    "original-mod",
  );
  assert.equal(
    await fs.readFile(path.join(f.dir, "config/current.json"), "utf8"),
    "preserve-later-config",
  );
  await assert.rejects(
    fs.lstat(path.join(f.dir, ".ldfcl/migration-pending.json")),
    { code: "ENOENT" },
  );
});
