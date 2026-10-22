const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Store, validateSettings } = require("@ldfcl/core/store");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ldfcl-directories-"));
  const dataDir = path.join(root, "profile");
  const defaultGameRoot = path.join(root, "portable", ".minecraft");
  await fs.mkdir(dataDir, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, dataDir, defaultGameRoot };
}

function instance(id, directoryId, extras = {}) {
  return {
    id,
    name: id,
    version: "1.21.4",
    loader: "vanilla",
    createdAt: "2026-10-20T00:00:00.000Z",
    gameSettings: { renderDistance: 12 },
    ...(directoryId ? { gameDirectoryId: directoryId } : {}),
    ...extras,
  };
}

function directory(root, id = "external") {
  return {
    id,
    name: "外部游戏目录",
    path: path.join(root, id, ".minecraft"),
    layout: "standard",
  };
}

async function stored(dataDir) {
  return JSON.parse(
    await fs.readFile(path.join(dataDir, "launcher.json"), "utf8"),
  );
}

test("new installations register the supplied portable standard root and persist it without touching game files", async (t) => {
  const { dataDir, defaultGameRoot } = await fixture(t);
  const store = new Store(dataDir, { defaultGameRoot });
  await store.load();
  assert.equal(store.gameDirectories.length, 1);
  assert.equal(store.currentGameDirectory.isDefault, true);
  assert.equal(store.currentGameDirectory.layout, "standard");
  assert.equal(store.currentGameDirectory.path, defaultGameRoot);
  assert.equal(store.selectedGameDirectoryId, store.currentGameDirectory.id);
  assert.equal(store.settings.gameRoot, defaultGameRoot);
  assert.deepEqual(store.currentInstances, []);
  assert.equal(store.selectedInstanceId, undefined);
  assert.equal(store.system().gameRoot, defaultGameRoot);
  assert.equal(store.system().defaultGameRoot, defaultGameRoot);
  assert.equal(store.system().dataDir, dataDir);
  const disk = await stored(dataDir);
  assert.deepEqual(disk.gameDirectories, store.gameDirectories);
  assert.equal(disk.selectedGameDirectoryId, store.currentGameDirectory.id);
  await assert.rejects(fs.access(defaultGameRoot), /ENOENT/);
});

test("the legacy one-argument Store constructor remains usable", async (t) => {
  const { dataDir } = await fixture(t);
  const store = new Store(dataDir);
  await store.load();
  assert.equal(
    store.currentGameDirectory.path,
    path.join(dataDir, ".minecraft"),
  );
  assert.equal(
    store.system().defaultGameRoot,
    path.join(dataDir, ".minecraft"),
  );
});

test("old instances migrate to their existing legacy layout and keep selection, settings and files", async (t) => {
  const { dataDir, defaultGameRoot } = await fixture(t);
  const before = {
    instances: [
      instance("old-a"),
      instance("old-b", undefined, { importedVersionId: "1.21.4" }),
    ],
    selectedInstanceId: "old-b",
    selectedAccountId: "saved-account",
    settings: {
      memoryMb: 6144,
      javaPath: "C:\\Java\\bin\\javaw.exe",
      gameRoot: "obsolete-setting",
    },
  };
  await fs.writeFile(
    path.join(dataDir, "launcher.json"),
    JSON.stringify(before),
  );
  const resourceFile = path.join(dataDir, "minecraft", "versions", "old.json");
  const instanceFile = path.join(dataDir, "instances", "old-b", "options.txt");
  await fs.mkdir(path.dirname(resourceFile), { recursive: true });
  await fs.mkdir(path.dirname(instanceFile), { recursive: true });
  await fs.writeFile(resourceFile, "legacy resources stay in place");
  await fs.writeFile(instanceFile, "renderDistance:12\n");
  const store = new Store(dataDir, { defaultGameRoot });
  await store.load();
  const legacy = store.currentGameDirectory;
  assert.equal(legacy.layout, "legacy");
  assert.equal(legacy.path, dataDir);
  assert.equal(legacy.isDefault, undefined);
  assert.equal(store.gameDirectories.length, 2);
  assert.equal(
    store.gameDirectories.find((root) => root.isDefault).path,
    defaultGameRoot,
  );
  assert(store.instances.every((item) => item.gameDirectoryId === legacy.id));
  assert.equal(store.currentInstances.length, 2);
  assert.equal(store.selectedInstanceId, "old-b");
  assert.equal(store.selectedAccountId, "saved-account");
  assert.equal(store.settings.memoryMb, 6144);
  assert.equal(store.settings.javaPath, before.settings.javaPath);
  assert.equal(store.settings.gameRoot, dataDir);
  assert.equal(store.instances[1].importedVersionId, "1.21.4");
  assert.equal(
    await fs.readFile(resourceFile, "utf8"),
    "legacy resources stay in place",
  );
  assert.equal(await fs.readFile(instanceFile, "utf8"), "renderDistance:12\n");
  const migrated = await stored(dataDir);
  assert.equal(migrated.selectedInstancesByDirectory[legacy.id], "old-b");
  const reloaded = new Store(dataDir, { defaultGameRoot });
  await reloaded.load();
  assert.equal(reloaded.gameDirectories.length, 2);
  assert.equal(reloaded.currentGameDirectory.id, legacy.id);
  assert.equal(reloaded.selectedInstanceId, "old-b");
  assert.deepEqual(reloaded.instances, store.instances);
});

test("directory switching scopes instance lookup and restores each root's selected version across reloads", async (t) => {
  const { dataDir, defaultGameRoot, root } = await fixture(t);
  const store = new Store(dataDir, { defaultGameRoot });
  await store.load();
  const first = store.currentGameDirectory;
  const second = store.registerGameDirectory(directory(root));
  const a1 = instance("same-id", first.id, { name: "默认目录中的版本" });
  const a2 = instance("default-second", first.id);
  const b1 = instance("same-id", second.id, { name: "外部目录中的版本" });
  const b2 = instance("external-second", second.id);
  store.instances.push(a1, a2, b1, b2);
  store.selectedInstanceId = a2.id;
  assert.equal(store.instance("same-id").name, a1.name);
  assert.throws(() => store.instance(b2.id), /找不到/);
  store.selectGameDirectory(second.id);
  assert.equal(store.selectedInstanceId, b1.id);
  assert.equal(store.instance("same-id").name, b1.name);
  assert.deepEqual(store.currentInstances, [b1, b2]);
  assert.equal(store.settings.gameRoot, second.path);
  assert.equal(store.system().gameRoot, second.path);
  store.selectedInstanceId = b2.id;
  store.selectGameDirectory(first.id);
  assert.equal(store.selectedInstanceId, a2.id);
  store.selectedInstanceId = a1.id;
  store.selectGameDirectory(second.id);
  assert.equal(store.selectedInstanceId, b2.id);
  await store.save();
  const reloaded = new Store(dataDir, { defaultGameRoot });
  await reloaded.load();
  assert.equal(reloaded.selectedGameDirectoryId, second.id);
  assert.equal(reloaded.selectedInstanceId, b2.id);
  assert.equal(reloaded.instances.length, 4);
  assert.equal(reloaded.currentInstances.length, 2);
  reloaded.selectGameDirectory(first.id);
  assert.equal(reloaded.selectedInstanceId, a1.id);
});

test("removing a root unregisters it, restores the default selection and preserves files and instance metadata", async (t) => {
  const { dataDir, defaultGameRoot, root } = await fixture(t);
  const store = new Store(dataDir, { defaultGameRoot });
  await store.load();
  const first = store.currentGameDirectory;
  const external = store.registerGameDirectory(directory(root));
  store.instances.push(
    instance("default-version", first.id),
    instance("external-version", external.id),
  );
  store.selectedInstanceId = "default-version";
  store.selectGameDirectory(external.id);
  await fs.mkdir(external.path, { recursive: true });
  const marker = path.join(external.path, "keep-me.txt");
  await fs.writeFile(marker, "existing Minecraft files");
  store.removeGameDirectory(external.id);
  assert.equal(store.selectedGameDirectoryId, first.id);
  assert.equal(store.selectedInstanceId, "default-version");
  assert.equal(store.settings.gameRoot, defaultGameRoot);
  assert(!store.gameDirectories.some((item) => item.id === external.id));
  assert.equal(store.instances.length, 2);
  assert.throws(() => store.instance("external-version"), /找不到/);
  assert.equal(await fs.readFile(marker, "utf8"), "existing Minecraft files");
  await store.save();
  const reloaded = new Store(dataDir, { defaultGameRoot });
  await reloaded.load();
  assert.equal(reloaded.instances.length, 2);
  assert(!reloaded.gameDirectories.some((item) => item.id === external.id));
  reloaded.registerGameDirectory(external);
  reloaded.selectGameDirectory(external.id);
  assert.equal(reloaded.selectedInstanceId, "external-version");
  assert.equal(reloaded.currentInstances.length, 1);
  assert.equal(await fs.readFile(marker, "utf8"), "existing Minecraft files");
});

test("default roots cannot be removed and external registrations cannot claim default status", async (t) => {
  const { dataDir, defaultGameRoot, root } = await fixture(t);
  const store = new Store(dataDir, { defaultGameRoot });
  await store.load();
  const original = store.currentGameDirectory;
  assert.throws(
    () => store.removeGameDirectory(original.id),
    /默认游戏目录不能移除/,
  );
  const external = store.registerGameDirectory({
    ...directory(root),
    isDefault: true,
  });
  assert.equal(external.isDefault, undefined);
  store.removeGameDirectory(external.id);
  assert.equal(store.currentGameDirectory.id, original.id);
});

test("registration deduplicates equivalent canonical roots and rejects colliding IDs without changing selection", async (t) => {
  const { dataDir, defaultGameRoot, root } = await fixture(t);
  const store = new Store(dataDir, { defaultGameRoot });
  await store.load();
  const first = store.currentGameDirectory;
  const external = store.registerGameDirectory(directory(root));
  const duplicate = store.registerGameDirectory({
    ...directory(root, "another-id"),
    path: external.path + path.sep,
  });
  assert.equal(duplicate.id, external.id);
  assert.equal(store.gameDirectories.length, 2);
  assert.throws(
    () =>
      store.registerGameDirectory({
        ...directory(root, "new"),
        id: external.id,
      }),
    /标识已被其他路径使用/,
  );
  assert.throws(() => store.selectGameDirectory("does-not-exist"), /找不到/);
  assert.throws(() => store.removeGameDirectory("does-not-exist"), /找不到/);
  assert.equal(store.selectedGameDirectoryId, first.id);
});

test("invalid persisted selection falls back only to a version in its selected root", async (t) => {
  const { dataDir, defaultGameRoot, root } = await fixture(t);
  const store = new Store(dataDir, { defaultGameRoot });
  await store.load();
  const first = store.currentGameDirectory;
  const external = store.registerGameDirectory(directory(root));
  store.instances.push(
    instance("default-only", first.id),
    instance("external-only", external.id),
  );
  store.selectGameDirectory(external.id);
  await store.save();
  const disk = await stored(dataDir);
  disk.selectedInstanceId = "default-only";
  disk.selectedInstancesByDirectory[external.id] = "default-only";
  await fs.writeFile(path.join(dataDir, "launcher.json"), JSON.stringify(disk));
  const reloaded = new Store(dataDir, { defaultGameRoot });
  await reloaded.load();
  assert.equal(reloaded.selectedGameDirectoryId, external.id);
  assert.equal(reloaded.selectedInstanceId, "external-only");
  assert.throws(() => reloaded.instance("default-only"), /找不到/);
});

test("relocating the portable default root keeps the previous root and existing instances without moving data", async (t) => {
  const { dataDir, defaultGameRoot, root } = await fixture(t);
  const store = new Store(dataDir, { defaultGameRoot });
  await store.load();
  const oldDefault = store.currentGameDirectory;
  store.instances.push(instance("old-portable-version", oldDefault.id));
  store.selectedInstanceId = "old-portable-version";
  await store.save();
  const nextDefault = path.join(root, "moved-launcher", ".minecraft");
  const relocated = new Store(dataDir, { defaultGameRoot: nextDefault });
  await relocated.load();
  assert.equal(relocated.gameDirectories.length, 2);
  assert.equal(
    relocated.gameDirectories.filter((item) => item.isDefault).length,
    1,
  );
  assert.equal(
    relocated.gameDirectories.find((item) => item.isDefault).path,
    nextDefault,
  );
  assert.equal(relocated.currentGameDirectory.id, oldDefault.id);
  assert.equal(relocated.currentGameDirectory.isDefault, undefined);
  assert.equal(relocated.currentGameDirectory.path, defaultGameRoot);
  assert.equal(relocated.selectedInstanceId, "old-portable-version");
  assert.equal(relocated.system().defaultGameRoot, nextDefault);
});

test("malformed registry entries do not discard valid registrations or orphaned instance metadata", async (t) => {
  const { dataDir, defaultGameRoot, root } = await fixture(t);
  const external = directory(root);
  await fs.writeFile(
    path.join(dataDir, "launcher.json"),
    JSON.stringify({
      gameDirectories: [
        null,
        { id: "invalid", path: "relative", layout: "standard" },
        external,
      ],
      selectedGameDirectoryId: "missing-root",
      instances: [instance("orphaned", "removed-root")],
    }),
  );
  const store = new Store(dataDir, { defaultGameRoot });
  await store.load();
  assert.equal(store.gameDirectories.length, 2);
  assert.equal(
    store.gameDirectories.find((item) => item.id === external.id).path,
    external.path,
  );
  assert.equal(store.currentGameDirectory.isDefault, true);
  assert.equal(store.instances.length, 1);
  assert.deepEqual(store.currentInstances, []);
});

test("corrupt configuration is backed up before rebuilding the default directory registry", async (t) => {
  const { dataDir, defaultGameRoot } = await fixture(t);
  await fs.writeFile(path.join(dataDir, "launcher.json"), "null");
  const store = new Store(dataDir, { defaultGameRoot });
  await store.load();
  assert.equal(store.currentGameDirectory.path, defaultGameRoot);
  const backup = (await fs.readdir(dataDir)).find((name) =>
    /^launcher\.corrupt-\d+\.json$/.test(name),
  );
  assert(backup);
  assert.equal(await fs.readFile(path.join(dataDir, backup), "utf8"), "null");
  assert.equal((await stored(dataDir)).gameDirectories.length, 1);
});

test("generic settings updates cannot directly override the active game root", () => {
  const settings = validateSettings({
    gameRoot: "C:\\unregistered-game-root",
    javaPath: "C:\\Java\\bin\\javaw.exe",
    downloadConcurrency: 999,
    unexpected: "ignored",
  });
  assert.equal(settings.gameRoot, undefined);
  assert.equal(settings.javaPath, "C:\\Java\\bin\\javaw.exe");
  assert.equal(settings.downloadConcurrency, 32);
  assert.equal(settings.unexpected, undefined);
});

test("failed directory persistence can restore roots and selections without reverting concurrent account or other setting changes", async (t) => {
  const { dataDir, defaultGameRoot, root } = await fixture(t);
  const store = new Store(dataDir, { defaultGameRoot });
  await store.load();
  const first = store.currentGameDirectory;
  store.instances.push(
    instance("original-a", first.id),
    instance("original-b", first.id),
  );
  store.selectedInstanceId = "original-b";
  store.selectedAccountId = "initial-account";
  await store.save();
  const before = store.captureGameDirectoryState();
  const external = store.registerGameDirectory(directory(root));
  store.instances.push(instance("external-new", external.id));
  store.selectGameDirectory(external.id);
  store.selectedAccountId = "concurrently-signed-in-account";
  store.settings.memoryMb = 8192;
  const originalWrite = fs.writeFile;
  let fail = true;
  fs.writeFile = async function (file, ...args) {
    if (fail && String(file) === path.join(dataDir, "launcher.json.tmp")) {
      fail = false;
      const error = new Error("simulated config write failure");
      error.code = "EACCES";
      throw error;
    }
    return originalWrite.call(this, file, ...args);
  };
  t.after(() => {
    fs.writeFile = originalWrite;
  });
  await assert.rejects(store.save(), /simulated config write failure/);
  store.restoreGameDirectoryState(before);
  assert.deepEqual(store.captureGameDirectoryState(), before);
  assert.equal(store.currentGameDirectory.id, first.id);
  assert.equal(store.selectedInstanceId, "original-b");
  assert.equal(store.settings.gameRoot, defaultGameRoot);
  assert.equal(store.selectedAccountId, "concurrently-signed-in-account");
  assert.equal(store.settings.memoryMb, 8192);
  assert.throws(() => store.instance("external-new"), /找不到/);
  await store.save();
  const disk = await stored(dataDir);
  assert.equal(disk.gameDirectories.length, 1);
  assert.equal(disk.instances.length, 2);
  assert.equal(disk.selectedInstanceId, "original-b");
  assert.equal(disk.selectedAccountId, "concurrently-signed-in-account");
  assert.equal(disk.settings.memoryMb, 8192);
  assert.equal(disk.settings.gameRoot, defaultGameRoot);
});

test("directory snapshots preserve nested instance settings and can be reused without sharing mutable arrays", async (t) => {
  const { dataDir, defaultGameRoot } = await fixture(t);
  const store = new Store(dataDir, { defaultGameRoot });
  await store.load();
  store.instances.push(instance("existing", store.currentGameDirectory.id));
  store.selectedInstanceId = "existing";
  await store.save();
  const snapshot = store.captureGameDirectoryState();
  store.instances[0].gameSettings.renderDistance = 64;
  store.currentGameDirectory.name = "changed name";
  store.restoreGameDirectoryState(snapshot);
  assert.equal(store.instances[0].gameSettings.renderDistance, 12);
  assert.equal(store.currentGameDirectory.name, "默认游戏目录");
  store.instances[0].gameSettings.renderDistance = 32;
  assert.equal(snapshot.instances[0].gameSettings.renderDistance, 12);
  store.restoreGameDirectoryState(snapshot);
  assert.equal(store.instances[0].gameSettings.renderDistance, 12);
});
