const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const compiledRoot =
  process.env.LDFCL_TEST_COMPILED_ROOT ||
  path.join(__dirname, "..", "core", "dist");
const {
  instanceVersionDirectoryId,
  instanceGameDirectory,
  assertInstanceGameDirectory,
  allocateVersionDirectory,
  prepareInstanceDirectories,
} = require(path.join(compiledRoot, "core", "instance-paths.js"));
const { scanGameDirectory } = require(
  path.join(compiledRoot, "core", "game-directories.js"),
);
const { GameService } = require(
  path.join(compiledRoot, "core", "services", "game.js"),
);

function directory(root, layout = "standard") {
  return { id: "directory", name: "目录", path: root, layout };
}
function instance(extra = {}) {
  return {
    id: "uuid-one",
    name: "我的世界",
    version: "1.21.1",
    loader: "vanilla",
    createdAt: new Date().toISOString(),
    gameSettings: {},
    ...extra,
  };
}
async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "LDFCL-paths-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function profile(root, id, extra = {}) {
  const dir = path.join(root, "versions", id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      id,
      mainClass: "net.minecraft.client.main.Main",
      libraries: [],
      ...extra,
    }),
  );
  return dir;
}
async function legacy(root, item, sourceId) {
  const dir = path.join(root, "instances", item.id);
  await fs.mkdir(path.join(dir, "mods"), { recursive: true });
  await fs.mkdir(path.join(dir, "saves", "World"), { recursive: true });
  await fs.writeFile(path.join(dir, "mods", "example.jar"), "user-mod");
  await fs.writeFile(
    path.join(dir, "saves", "World", "level.dat"),
    "user-world",
  );
  await fs.writeFile(path.join(dir, "options.txt"), "fullscreen:true\n");
  if (sourceId) {
    await fs.mkdir(path.join(dir, ".ldfcl"));
    await fs.writeFile(
      path.join(dir, ".ldfcl", "launch.json"),
      JSON.stringify({ version: sourceId }),
    );
  }
  return dir;
}

test("version paths select prepared directory before import provenance and state identity", () => {
  const root = path.join(os.tmpdir(), "minecraft");
  assert.equal(
    instanceVersionDirectoryId(
      instance({ versionDirectory: "实际 版本", importedVersionId: "source" }),
    ),
    "实际 版本",
  );
  assert.equal(
    instanceGameDirectory(root, instance({ versionDirectory: "实际 版本" })),
    path.join(root, "versions", "实际 版本"),
  );
  assert.throws(
    () =>
      instanceGameDirectory(root, instance({ versionDirectory: "../outside" })),
    /版本标识/,
  );
});

test("unique readable allocation preserves files, directories and case aliases", async (t) => {
  const root = await temporary(t);
  await fs.mkdir(path.join(root, "versions"));
  await fs.writeFile(path.join(root, "versions", "MY WORLD"), "occupied");
  const first = await allocateVersionDirectory(root, "My World");
  const second = await allocateVersionDirectory(root, "My World");
  assert.equal(first.id, "My World-2");
  assert.equal(second.id, "My World-3");
  assert.equal(
    await fs.readFile(path.join(root, "versions", "MY WORLD"), "utf8"),
    "occupied",
  );
});

test("legacy migration copies all user data into versions with same-name JSON and parent JAR", async (t) => {
  const root = await temporary(t);
  const item = instance({ loader: "fabric" });
  const parent = await profile(root, "1.21.1");
  await fs.writeFile(path.join(parent, "1.21.1.jar"), "vanilla-client");
  await profile(root, "fabric-source", {
    inheritsFrom: "1.21.1",
    libraries: [{ name: "net.fabricmc:fabric-loader:0.16.1" }],
  });
  const source = await legacy(root, item, "fabric-source");
  const result = await prepareInstanceDirectories(directory(root), [item]);
  assert.deepEqual(result, { prepared: 1, migrated: 1, warnings: [] });
  assert.equal(item.versionDirectory, "我的世界");
  const target = instanceGameDirectory(root, item);
  for (const relative of [
    "mods/example.jar",
    "saves/World/level.dat",
    "options.txt",
  ])
    assert.deepEqual(
      await fs.readFile(path.join(target, relative)),
      await fs.readFile(path.join(source, relative)),
    );
  const own = JSON.parse(
    await fs.readFile(
      path.join(target, `${item.versionDirectory}.json`),
      "utf8",
    ),
  );
  assert.equal(own.id, item.versionDirectory);
  assert.equal(own.jar, item.versionDirectory);
  assert.equal(own.minecraftVersion, "1.21.1");
  assert.equal(
    await fs.readFile(
      path.join(target, `${item.versionDirectory}.jar`),
      "utf8",
    ),
    "vanilla-client",
  );
});

test("completed migration is recovered after store-save failure without another suffix or recopy", async (t) => {
  const root = await temporary(t);
  const original = instance();
  await profile(root, "1.21.1");
  const source = await legacy(root, original, "1.21.1");
  const lostStoreRecord = structuredClone(original);
  await prepareInstanceDirectories(directory(root), [original]);
  const target = instanceGameDirectory(root, original);
  await fs.writeFile(path.join(target, "options.txt"), "newer-user-setting");
  await fs.writeFile(path.join(source, "options.txt"), "old-source-changed");
  const before = (await fs.readdir(path.join(root, "versions"))).sort();
  const result = await prepareInstanceDirectories(directory(root), [
    lostStoreRecord,
  ]);
  assert.equal(lostStoreRecord.versionDirectory, original.versionDirectory);
  assert.deepEqual(result, { prepared: 1, migrated: 0, warnings: [] });
  assert.deepEqual(
    (await fs.readdir(path.join(root, "versions"))).sort(),
    before,
  );
  assert.equal(
    await fs.readFile(path.join(target, "options.txt"), "utf8"),
    "newer-user-setting",
  );
});

test("old imported instance data gets a unique copy without mixing native profile worlds", async (t) => {
  const root = await temporary(t);
  const item = instance({ name: "native", importedVersionId: "native" });
  const native = await profile(root, "native", { minecraftVersion: "1.21.1" });
  await fs.writeFile(path.join(native, "options.txt"), "native-settings");
  await legacy(root, item, "native");
  const result = await prepareInstanceDirectories(directory(root), [item]);
  assert.equal(result.warnings.length, 0);
  assert.equal(item.versionDirectory, "native-2");
  assert.equal(item.importedVersionId, "native");
  assert.equal(
    await fs.readFile(path.join(native, "options.txt"), "utf8"),
    "native-settings",
  );
  assert.equal(
    await fs.readFile(
      path.join(instanceGameDirectory(root, item), "options.txt"),
      "utf8",
    ),
    "fullscreen:true\n",
  );
});

test("new native import uses exact version directory without copying root user data", async (t) => {
  const root = await temporary(t);
  const item = instance({ importedVersionId: "现有版本" });
  await profile(root, "现有版本", { minecraftVersion: "1.21.1" });
  const result = await prepareInstanceDirectories(directory(root), [item]);
  assert.deepEqual(result, { prepared: 1, migrated: 0, warnings: [] });
  assert.equal(item.versionDirectory, "现有版本");
  await assert.rejects(fs.access(path.join(root, "instances")));
});

test("missing loader provenance fails safely, preserving source and leaving record unprepared", async (t) => {
  const root = await temporary(t);
  const item = instance({ loader: "forge" });
  const source = await legacy(root, item);
  await profile(root, "1.21.1-forge-random");
  const result = await prepareInstanceDirectories(directory(root), [item]);
  assert.equal(result.prepared, 0);
  assert.match(result.warnings.join(" "), /加载器原始版本/);
  assert.equal(item.versionDirectory, undefined);
  assert.equal(
    await fs.readFile(path.join(source, "mods", "example.jar"), "utf8"),
    "user-mod",
  );
  assert.deepEqual(await fs.readdir(path.join(root, "versions")), [
    "1.21.1-forge-random",
  ]);
});

test("known loader profile migrates when its official vanilla parent still needs download", async (t) => {
  const root = await temporary(t);
  const item = instance({ loader: "fabric" });
  await profile(root, "fabric-1.21.1", {
    inheritsFrom: "1.21.1",
    libraries: [{ name: "net.fabricmc:fabric-loader:0.16.1" }],
  });
  await legacy(root, item, "fabric-1.21.1");
  const result = await prepareInstanceDirectories(directory(root), [item]);
  assert.equal(result.warnings.length, 0);
  assert.equal(result.migrated, 1);
  const own = JSON.parse(
    await fs.readFile(
      path.join(
        instanceGameDirectory(root, item),
        `${item.versionDirectory}.json`,
      ),
      "utf8",
    ),
  );
  assert.equal(own.inheritsFrom, "1.21.1");
  assert.equal(own.jar, item.versionDirectory);
});

test("legacy vanilla data migrates even before minecraft resource root exists", async (t) => {
  const root = await temporary(t);
  const item = instance();
  await legacy(root, item);
  const result = await prepareInstanceDirectories(directory(root, "legacy"), [
    item,
  ]);
  assert.equal(result.warnings.length, 0);
  assert.equal(result.migrated, 1);
  const target = instanceGameDirectory(path.join(root, "minecraft"), item);
  assert.equal(
    await fs.readFile(path.join(target, "mods", "example.jar"), "utf8"),
    "user-mod",
  );
  const metadata = JSON.parse(
    await fs.readFile(
      path.join(target, `${item.versionDirectory}.json`),
      "utf8",
    ),
  );
  assert.equal(metadata._ldfclVanillaSource, "1.21.1");
});

test("migration rejects nested source junctions and leaves outside data untouched", async (t) => {
  const root = await temporary(t);
  const item = instance();
  const source = await legacy(root, item);
  const outside = path.join(root, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "keep"), "keep");
  await fs.symlink(
    outside,
    path.join(source, "config"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const result = await prepareInstanceDirectories(directory(root), [item]);
  assert.equal(result.prepared, 0);
  assert.match(result.warnings.join(" "), /符号链接|目录联接/);
  assert.equal(await fs.readFile(path.join(outside, "keep"), "utf8"), "keep");
});

test("directory assertions reject linked versions roots and immediate game data directories", async (t) => {
  const root = await temporary(t);
  const selected = path.join(root, "selected");
  const outside = path.join(root, "outside");
  await fs.mkdir(selected);
  await fs.mkdir(outside);
  await fs.symlink(
    outside,
    path.join(selected, "versions"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    assertInstanceGameDirectory(
      selected,
      instance({ versionDirectory: "target" }),
    ),
    /链接|普通文件夹/,
  );
  const safe = path.join(root, "safe");
  const target = await profile(safe, "target");
  await fs.symlink(
    outside,
    path.join(target, "mods"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    assertInstanceGameDirectory(safe, instance({ versionDirectory: "target" })),
    /链接/,
  );
});

test("migration never overwrites a copied user file whose name matches the new profile", async (t) => {
  const root = await temporary(t);
  const item = instance();
  await profile(root, "1.21.1");
  const source = await legacy(root, item);
  await fs.writeFile(path.join(source, "我的世界.json"), "user-file");
  const result = await prepareInstanceDirectories(directory(root), [item]);
  assert.equal(result.warnings.length, 0);
  assert.notEqual(item.versionDirectory, "我的世界");
  assert.equal(
    await fs.readFile(
      path.join(instanceGameDirectory(root, item), "我的世界.json"),
      "utf8",
    ),
    "user-file",
  );
});

test("custom-name installations retain scanable base version and never overwrite an existing profile", async (t) => {
  const root = await temporary(t);
  const existing = await profile(root, "我的存档", { custom: "keep" });
  await fs.writeFile(path.join(existing, "options.txt"), "native-settings");
  t.mock.method(GameService.prototype, "vanilla", async () => ({
    id: "1.21.1",
    mainClass: "net.minecraft.client.main.Main",
    libraries: [],
    downloads: { client: { url: "https://example.invalid/client.jar" } },
  }));
  const service = new GameService(root, () => {}, { minecraftRoot: root });
  service.downloads.downloadMany = async (files) => {
    for (const file of files) {
      await fs.mkdir(path.dirname(file.path), { recursive: true });
      await fs.writeFile(file.path, "downloaded-client");
    }
  };
  const a = await service.install({ version: "1.21.1", name: "我的存档" });
  const b = await service.install({ version: "1.21.1", name: "我的存档" });
  assert.equal(a.versionDirectory, "我的存档-2");
  assert.equal(b.versionDirectory, "我的存档-3");
  assert.notEqual(a.id, b.id);
  assert.equal(
    await fs.readFile(path.join(existing, "options.txt"), "utf8"),
    "native-settings",
  );
  assert.equal(
    JSON.parse(await fs.readFile(path.join(existing, "我的存档.json"), "utf8"))
      .custom,
    "keep",
  );
  for (const item of [a, b]) {
    const target = instanceGameDirectory(root, item);
    assert.equal(
      await fs.readFile(
        path.join(target, `${item.versionDirectory}.jar`),
        "utf8",
      ),
      "downloaded-client",
    );
  }
  const scanned = await scanGameDirectory(directory(root));
  for (const item of [a, b])
    assert.equal(
      scanned.instances.find(
        (entry) => entry.versionDirectory === item.versionDirectory,
      )?.version,
      "1.21.1",
    );
  await assert.rejects(fs.access(path.join(root, "instances")));
});

test("Forge staging publishes processor libraries and flattened profile without touching native versions", async (t) => {
  const root = await temporary(t);
  const old = await profile(root, "1.21.1-forge-1.0", { custom: "native" });
  t.mock.method(GameService.prototype, "vanilla", async () => ({
    id: "1.21.1",
    mainClass: "net.minecraft.client.main.Main",
    libraries: [],
    downloads: { client: { url: "https://example.invalid/client.jar" } },
  }));
  let installerRoot;
  t.mock.method(
    GameService.prototype,
    "loaderProfile",
    async function (version, loader) {
      installerRoot = this.root;
      assert.notEqual(this.root, root);
      await profile(this.root, "1.21.1-forge-1.0", {
        inheritsFrom: "1.21.1",
        mainClass: "cpw.mods.bootstraplauncher.BootstrapLauncher",
        libraries: [
          {
            name: "net.minecraftforge:forge:1.0",
            downloads: { artifact: { path: "net/forge/patched.jar", url: "" } },
          },
        ],
      });
      await fs.mkdir(path.join(this.root, "libraries", "net", "forge"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(this.root, "libraries", "net", "forge", "patched.jar"),
        "processor-output",
      );
      return { id: "1.21.1-forge-1.0", loaderVersion: "1.0" };
    },
  );
  const service = new GameService(root, () => {}, { minecraftRoot: root });
  service.downloads.download = async (_url, file) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "client");
  };
  service.downloads.downloadMany = async () => {};
  const item = await service.install({
    version: "1.21.1",
    loader: "forge",
    name: "Forge 生存",
  });
  const metadata = JSON.parse(
    await fs.readFile(
      path.join(
        instanceGameDirectory(root, item),
        `${item.versionDirectory}.json`,
      ),
      "utf8",
    ),
  );
  assert.equal(metadata.inheritsFrom, undefined);
  assert.equal(metadata.minecraftVersion, "1.21.1");
  assert.equal(metadata.jar, item.versionDirectory);
  assert.equal(
    metadata.mainClass,
    "cpw.mods.bootstraplauncher.BootstrapLauncher",
  );
  assert.equal(
    await fs.readFile(
      path.join(root, "libraries", "net", "forge", "patched.jar"),
      "utf8",
    ),
    "processor-output",
  );
  assert.equal(
    JSON.parse(
      await fs.readFile(path.join(old, "1.21.1-forge-1.0.json"), "utf8"),
    ).custom,
    "native",
  );
  assert.equal(
    await fs.readFile(
      path.join(
        instanceGameDirectory(root, item),
        `${item.versionDirectory}.jar`,
      ),
      "utf8",
    ),
    "client",
  );
  await assert.rejects(fs.access(installerRoot));
});
