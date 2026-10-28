const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createLauncherCore } = require("@ldfcl/core/launcher");
const { allocateVersionDirectory } = require("@ldfcl/core/instance-paths");

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
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "LDFCL-directory-recovery-"),
  );
  const dataDir = path.join(root, "data");
  const gameRoot = path.join(root, ".minecraft");
  const cores = [];
  const open = async () => {
    const core = await createLauncherCore({
      dataDir,
      defaultGameRoot: gameRoot,
      host,
    });
    cores.push(core);
    return core;
  };
  t.after(async () => {
    for (const core of cores) core.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  const custom = path.join(root, "#测试 哈哈😄", ".minecraft");
  const dir = path.join(custom, "versions", "1.21.1");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "1.21.1.json"),
    JSON.stringify({
      id: "1.21.1",
      mainClass: "net.minecraft.client.main.Main",
      libraries: [],
    }),
  );
  await fs.writeFile(
    path.join(dir, "keep.txt"),
    "worlds and user data stay here",
  );
  const core = await open();
  const defaultId = (await core.state()).selectedGameDirectoryId;
  const added = await core.call("game-directory:add", { path: custom });
  return {
    root,
    dataDir,
    gameRoot,
    custom,
    core,
    open,
    defaultId,
    customId: added.selectedGameDirectoryId,
    instanceId: added.selectedInstanceId,
    config: path.join(dataDir, "launcher.json"),
  };
}

test("selecting a moved registration never recreates it or changes configuration; relocation keeps instance identity", async (t) => {
  const f = await fixture(t);
  await f.core.call("game-directory:select", { id: f.defaultId });
  const moved = path.join(f.root, "new location 中文😄");
  await fs.rename(path.dirname(f.custom), moved);
  const newPath = path.join(moved, ".minecraft");
  const before = await fs.readFile(f.config);
  await assert.rejects(
    f.core.call("game-directory:select", { id: f.customId }),
    /移动或删除/,
  );
  assert.deepEqual(await fs.readFile(f.config), before);
  await assert.rejects(fs.access(path.dirname(f.custom)), { code: "ENOENT" });
  const state = await f.core.state();
  assert.equal(state.selectedGameDirectoryId, f.defaultId);
  assert.equal(
    state.gameDirectories.find((dir) => dir.id === f.customId).available,
    false,
  );
  assert.equal(
    await f.core.call("game-directory:relocate", { id: f.customId }),
    null,
  );
  assert.deepEqual(await fs.readFile(f.config), before);
  await f.core.call("game-directory:relocate", {
    id: f.customId,
    path: newPath,
  });
  await f.core.call("game-directory:select", { id: f.customId });
  const relocated = await f.core.state();
  assert.equal(relocated.selectedInstanceId, f.instanceId);
  assert.equal(
    relocated.gameDirectories.find((dir) => dir.id === f.customId).path,
    newPath,
  );
  assert.equal(
    await fs.readFile(path.join(newPath, "versions/1.21.1/keep.txt"), "utf8"),
    "worlds and user data stay here",
  );
  await assert.rejects(fs.access(f.custom), { code: "ENOENT" });
});

test("restart with a deleted selected custom root keeps the missing registration without creating any directories", async (t) => {
  const f = await fixture(t);
  await fs.rm(path.dirname(f.custom), { recursive: true, force: true });
  f.core.dispose();
  const reopened = await f.open();
  const state = await reopened.state();
  assert.equal(state.selectedGameDirectoryId, f.customId);
  assert.equal(
    state.gameDirectories.find((dir) => dir.id === f.customId).available,
    false,
  );
  assert.match(state.system.gameDirectoryError, /移动或删除/);
  await assert.rejects(fs.access(path.dirname(f.custom)), { code: "ENOENT" });
  await reopened.call("game-directory:remove", { id: f.customId });
  assert.equal((await reopened.state()).selectedGameDirectoryId, f.defaultId);
  await assert.rejects(fs.access(f.custom), { code: "ENOENT" });
});

test("relocation to another registration is rejected without altering its old path or selection", async (t) => {
  const f = await fixture(t);
  const before = await fs.readFile(f.config);
  await assert.rejects(
    f.core.call("game-directory:relocate", {
      id: f.customId,
      path: f.gameRoot,
    }),
    /已登记/,
  );
  assert.deepEqual(await fs.readFile(f.config), before);
  assert.equal((await f.core.state()).selectedGameDirectoryId, f.customId);
});

test("a missing previously registered default root is created only by the explicit create action", async (t) => {
  const f = await fixture(t);
  await f.core.call("game-directory:select", { id: f.defaultId });
  await fs.rm(f.gameRoot, { recursive: true, force: true });
  f.core.dispose();
  const reopened = await f.open();
  assert.equal(
    (await reopened.state()).gameDirectories.find(
      (dir) => dir.id === f.defaultId,
    ).available,
    false,
  );
  await assert.rejects(fs.access(f.gameRoot), { code: "ENOENT" });
  await assert.rejects(
    allocateVersionDirectory(f.gameRoot, "do-not-resurrect"),
    /移动或删除/,
  );
  await assert.rejects(fs.access(f.gameRoot), { code: "ENOENT" });
  await reopened.call("game-directory:create-default");
  assert.equal(
    (await reopened.state()).gameDirectories.find(
      (dir) => dir.id === f.defaultId,
    ).available,
    true,
  );
  assert.deepEqual(await fs.readdir(f.gameRoot), []);
});

test("a prepared legacy registration does not recreate a moved minecraft child on restart or selection", async (t) => {
  const f = await fixture(t);
  f.core.dispose();
  const legacy = path.join(f.root, "legacy");
  await fs.mkdir(legacy);
  const persisted = JSON.parse(await fs.readFile(f.config, "utf8"));
  persisted.gameDirectories.push({
    id: "legacy-root",
    name: "legacy",
    path: legacy,
    layout: "legacy",
  });
  persisted.instances.push({
    id: "legacy-instance",
    gameDirectoryId: "legacy-root",
    name: "legacy",
    version: "1.21.1",
    loader: "vanilla",
    versionDirectory: "1.21.1",
    gameSettings: {},
    createdAt: "2026-10-28T00:00:00Z",
  });
  persisted.selectedGameDirectoryId = "legacy-root";
  await fs.writeFile(f.config, JSON.stringify(persisted));
  const core = await f.open();
  assert.equal(
    (await core.state()).gameDirectories.find((dir) => dir.id === "legacy-root")
      .available,
    false,
  );
  await assert.rejects(fs.access(path.join(legacy, "minecraft")), {
    code: "ENOENT",
  });
  await core.call("game-directory:select", { id: f.defaultId });
  const before = await fs.readFile(f.config);
  await assert.rejects(
    core.call("game-directory:select", { id: "legacy-root" }),
    /移动或删除/,
  );
  assert.deepEqual(await fs.readFile(f.config), before);
  await assert.rejects(fs.access(path.join(legacy, "minecraft")), {
    code: "ENOENT",
  });
});
