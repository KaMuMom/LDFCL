const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const {
  resolveLauncherDataDirectory,
} = require("../dist-electron/electron/application-paths.js");
const { Store } = require("../dist-electron/electron/store.js");

test("launcher configuration follows the outer portable EXE instead of the extracted executable or cwd", () => {
  const outer = path.join(os.tmpdir(), "中文 空格", "便携启动器");
  const options = {
    isPackaged: true,
    appPath: path.join(os.tmpdir(), "extract", "resources", "app.asar"),
    execPath: path.join(os.tmpdir(), "extract", "LDFCL.exe"),
    portableExecutableDir: outer,
  };
  assert.equal(
    resolveLauncherDataDirectory(options),
    path.join(outer, "LDFCL-data"),
  );
  assert.equal(
    resolveLauncherDataDirectory({
      ...options,
      portableExecutableDir: undefined,
    }),
    path.join(path.dirname(options.execPath), "LDFCL-data"),
  );
  assert.equal(
    resolveLauncherDataDirectory({
      ...options,
      isPackaged: false,
      appPath: outer,
    }),
    path.join(outer, "LDFCL-data"),
  );
  const override = path.join(os.tmpdir(), "isolated-config");
  assert.equal(
    resolveLauncherDataDirectory({ ...options, dataDirOverride: override }),
    override,
  );
  assert.throws(
    () =>
      resolveLauncherDataDirectory({
        ...options,
        dataDirOverride: "relative-dir",
      }),
    /绝对路径/,
  );
  assert.throws(
    () =>
      resolveLauncherDataDirectory({
        ...options,
        portableExecutableDir: "relative-dir",
      }),
    /绝对路径/,
  );
});

test("moving configuration preserves the old game root for instances without a directory ID", async (t) => {
  const workspace = await fs.mkdtemp(
    path.join(os.tmpdir(), "LDFCL-legacy-config-"),
  );
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const legacyDataDir = path.join(workspace, "old-AppData");
  const destination = path.join(workspace, "portable", "LDFCL-data");
  const defaultGameRoot = path.join(workspace, "portable", ".minecraft");
  await fs.mkdir(destination, { recursive: true });
  await fs.mkdir(path.join(legacyDataDir, "instances", "old-instance"), {
    recursive: true,
  });
  const world = path.join(
    legacyDataDir,
    "instances",
    "old-instance",
    "world.txt",
  );
  await fs.writeFile(world, "preserved source world");
  await fs.writeFile(
    path.join(destination, "launcher.json"),
    JSON.stringify({
      instances: [
        {
          id: "old-instance",
          version: "1.16.5",
          loader: "vanilla",
          name: "Old instance",
          gameSettings: {},
        },
      ],
      selectedInstanceId: "old-instance",
    }),
  );
  const store = new Store(destination, { defaultGameRoot, legacyDataDir });
  await store.load();
  assert.equal(store.currentGameDirectory.path, legacyDataDir);
  assert.equal(store.currentGameDirectory.layout, "legacy");
  assert.equal(store.currentInstances[0].id, "old-instance");
  assert.equal(store.system().dataDir, destination);
  assert.equal(await fs.readFile(world, "utf8"), "preserved source world");
  const reloaded = new Store(destination, { defaultGameRoot });
  await reloaded.load();
  assert.equal(reloaded.currentGameDirectory.path, legacyDataDir);
  assert.equal(reloaded.currentInstances[0].id, "old-instance");
});
