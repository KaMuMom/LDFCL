const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createLauncherCore } = require("@ldfcl/core/launcher");

function host() {
  return {
    chooseFiles: async () => ({ canceled: true, filePaths: [] }),
    chooseSaveFile: async () => ({ canceled: true }),
    openPath: async () => "",
    openExternal: async () => {},
    trashItem: async () => {},
    imageDataUrl: () => {
      throw Error("Unexpected native image operation");
    },
    focusWindow: () => {},
    minimizeWindow: () => {},
  };
}

async function importedProfile(root, item) {
  const target = path.join(root, "versions", item.importedVersionId);
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(
    path.join(target, `${item.importedVersionId}.json`),
    JSON.stringify({
      id: item.importedVersionId,
      minecraftVersion: item.version,
      mainClass:
        item.loader === "fabric"
          ? "net.fabricmc.loader.impl.launch.knot.KnotClient"
          : "cpw.mods.bootstraplauncher.BootstrapLauncher",
      libraries: [],
    }),
  );
  await fs.writeFile(
    path.join(target, `${item.importedVersionId}.jar`),
    "client-jar",
  );
  await fs.writeFile(
    path.join(target, "options.txt"),
    "native-profile-settings",
  );
}

async function fixture(t, availableProfiles) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "LDFCL-association-core-"),
  );
  const dataDir = path.join(root, "LDFCL-data");
  const defaultGameRoot = path.join(root, ".minecraft");
  const cores = [];
  t.after(async () => {
    for (const core of cores) core.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  t.mock.method(global, "fetch", async () => {
    throw Error("Unexpected network request");
  });
  const directory = {
    id: "fixture-root",
    name: "测试目录",
    path: defaultGameRoot,
    layout: "standard",
    isDefault: true,
  };
  const instances = ["fabric", "forge"].map((loader) => ({
    id: `saved-${loader}`,
    name: `旧 ${loader} 实例`,
    version: "1.21.4",
    loader,
    importedVersionId: `original-${loader}`,
    gameDirectoryId: directory.id,
    createdAt: "2026-10-28T00:00:00.000Z",
    gameSettings: { renderDistance: 10 },
  }));
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(defaultGameRoot);
  for (const item of instances) {
    const source = path.join(defaultGameRoot, "instances", item.id);
    await fs.mkdir(path.join(source, "saves", "Existing World"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(source, "saves", "Existing World", "level.dat"),
      `world-${item.id}`,
    );
    await fs.writeFile(
      path.join(source, "options.txt"),
      "lang:en_us\nrenderDistance:10\n",
    );
    if (availableProfiles) await importedProfile(defaultGameRoot, item);
  }
  await fs.writeFile(
    path.join(dataDir, "launcher.json"),
    JSON.stringify({
      gameDirectories: [directory],
      selectedGameDirectoryId: directory.id,
      selectedInstanceId: instances[1].id,
      selectedInstancesByDirectory: { [directory.id]: instances[1].id },
      instances,
      settings: {},
    }),
  );
  const options = { dataDir, defaultGameRoot, host: host() };
  async function open() {
    const core = await createLauncherCore(options);
    cores.push(core);
    return core;
  }
  return { root, dataDir, defaultGameRoot, instances, open };
}

for (const trigger of ["initialization", "rescan"]) {
  test(`core ${trigger} restores explicit legacy imports, persists associations, and avoids duplicate copies`, async (t) => {
    const f = await fixture(t, trigger === "initialization");
    const core = await f.open();
    if (trigger === "rescan") {
      const before = await core.state();
      assert.equal(
        before.system.gameDirectoryWarnings.length,
        f.instances.length,
      );
      assert(before.instances.every((item) => !item.versionDirectory));
      for (const item of f.instances)
        await importedProfile(f.defaultGameRoot, item);
      await core.call("game-directory:scan");
    }
    const state = await core.state();
    assert.equal(state.system.gameDirectoryError, undefined);
    assert.deepEqual(state.system.gameDirectoryWarnings, []);
    assert.equal(state.instances.length, f.instances.length);
    assert.equal(state.selectedInstanceId, f.instances[1].id);
    const persisted = JSON.parse(
      await fs.readFile(path.join(f.dataDir, "launcher.json"), "utf8"),
    );
    for (const original of f.instances) {
      const item = state.instances.find((entry) => entry.id === original.id);
      assert.equal(item.versionDirectory, original.name);
      assert.equal(item.importedVersionId, original.importedVersionId);
      assert.deepEqual(item.gameSettings, original.gameSettings);
      assert.equal(
        persisted.instances.find((entry) => entry.id === original.id)
          .versionDirectory,
        item.versionDirectory,
      );
      const target = path.join(
        f.defaultGameRoot,
        "versions",
        item.versionDirectory,
      );
      const source = path.join(f.defaultGameRoot, "instances", item.id);
      for (const base of [target, source]) {
        assert.equal(
          await fs.readFile(
            path.join(base, "saves", "Existing World", "level.dat"),
            "utf8",
          ),
          `world-${item.id}`,
        );
        assert.equal(
          await fs.readFile(path.join(base, "options.txt"), "utf8"),
          "lang:en_us\nrenderDistance:10\n",
        );
      }
      assert.equal(
        await fs.readFile(
          path.join(
            f.defaultGameRoot,
            "versions",
            item.importedVersionId,
            "options.txt",
          ),
          "utf8",
        ),
        "native-profile-settings",
      );
      await fs.writeFile(
        path.join(target, "options.txt"),
        "lang:zh_cn\nnewer-setting:true\n",
      );
    }
    const directories = (
      await fs.readdir(path.join(f.defaultGameRoot, "versions"))
    ).sort();
    const rescanned = await core.call("game-directory:scan");
    assert.equal(rescanned.discovered, 0);
    assert.equal(rescanned.instances.length, f.instances.length);
    core.dispose();
    const reloaded = await f.open();
    const restored = await reloaded.state();
    assert.deepEqual(restored.system.gameDirectoryWarnings, []);
    assert.equal(restored.instances.length, f.instances.length);
    assert.equal(restored.selectedInstanceId, f.instances[1].id);
    assert.deepEqual(
      (await fs.readdir(path.join(f.defaultGameRoot, "versions"))).sort(),
      directories,
    );
    for (const item of restored.instances) {
      assert.equal(
        await fs.readFile(
          path.join(
            f.defaultGameRoot,
            "versions",
            item.versionDirectory,
            "options.txt",
          ),
          "utf8",
        ),
        "lang:zh_cn\nnewer-setting:true\n",
      );
    }
  });
}
