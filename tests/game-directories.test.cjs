const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { captureJavaStdin, decodedJavaInvocation, physicalPath } = require("./helpers/java-invocation.cjs");
const compiledRoot =
  process.env.LDFCL_TEST_COMPILED_ROOT ||
  path.join(__dirname, "..", "core", "dist");
const {
  resolveDefaultGameDirectoryPath,
  canonicalGameDirectoryPath,
  gameDirectoryPathKey,
  gameDirectoryRoots,
  scanGameDirectory,
  safeGameVersionId,
} = require(path.join(compiledRoot, "core", "game-directories.js"));
const { GameService, tokenizeArguments } = require(
  path.join(compiledRoot, "core", "services", "game.js"),
);

const base = {
  isPackaged: false,
  execPath: path.join(os.tmpdir(), "electron", "electron.exe"),
  appPath: path.join(os.tmpdir(), "LDFCL 项目"),
};
function directory(root, id = "directory-one", layout = "standard") {
  return { id, name: "测试游戏目录", path: root, layout };
}
async function temporary(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "LDFCL-directory-test-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function profile(root, id, extra = {}) {
  const folder = path.join(root, "versions", id);
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, `${id}.json`);
  await fs.writeFile(file, JSON.stringify({ id, ...extra }));
  return file;
}
function vanilla() {
  return { mainClass: "net.minecraft.client.main.Main", libraries: [] };
}
async function snapshot(root) {
  const result = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) {
        const stat = await fs.stat(file);
        result.push({
          name: path.relative(root, file),
          mtime: stat.mtimeMs,
          hash: createHash("sha256")
            .update(await fs.readFile(file))
            .digest("hex"),
        });
      }
    }
  }
  await walk(root);
  return result;
}

test("default .minecraft follows development, unpacked and external portable executable locations", () => {
  assert.equal(
    resolveDefaultGameDirectoryPath(base),
    path.join(base.appPath, ".minecraft"),
  );
  assert.equal(
    resolveDefaultGameDirectoryPath({ ...base, isPackaged: true }),
    path.join(path.dirname(base.execPath), ".minecraft"),
  );
  const portable = path.join(os.tmpdir(), "可移动 启动器");
  assert.equal(
    resolveDefaultGameDirectoryPath({
      ...base,
      isPackaged: true,
      portableExecutableDir: portable,
    }),
    path.join(portable, ".minecraft"),
  );
});

test("isolated data directory cannot leak into the user's default folder and explicit root wins", () => {
  const isolated = path.join(os.tmpdir(), "isolated-test-data");
  const explicit = path.join(os.tmpdir(), "自定义 Minecraft");
  assert.equal(
    resolveDefaultGameDirectoryPath({
      ...base,
      isPackaged: true,
      dataDirOverride: isolated,
    }),
    path.join(isolated, ".minecraft"),
  );
  assert.equal(
    resolveDefaultGameDirectoryPath({
      ...base,
      isPackaged: true,
      dataDirOverride: isolated,
      gameRootOverride: explicit,
    }),
    explicit,
  );
  assert.throws(
    () =>
      resolveDefaultGameDirectoryPath({
        ...base,
        gameRootOverride: "relative/.minecraft",
      }),
    /绝对路径/,
  );
});

test("standard and legacy layouts resolve resources while keeping instance/cache/runtime ownership", () => {
  const root = path.join(os.tmpdir(), "Minecraft 目录");
  assert.deepEqual(gameDirectoryRoots(directory(root)), {
    dataDir: root,
    minecraftRoot: root,
  });
  assert.deepEqual(gameDirectoryRoots(directory(root, "old", "legacy")), {
    dataDir: root,
    minecraftRoot: path.join(root, "minecraft"),
  });
});

test("canonical selection accepts existing Chinese spaced paths and leaves no write-probe files", async (t) => {
  const temporaryRoot = await temporary(t);
  const selected = path.join(temporaryRoot, "中文 游戏目录", ".minecraft");
  await fs.mkdir(selected, { recursive: true });
  await fs.writeFile(path.join(selected, "options.txt"), "fullscreen:true\n");
  const before = await snapshot(selected);
  assert.equal(
    await canonicalGameDirectoryPath(selected),
    path.resolve(await fs.realpath(selected)),
  );
  assert.deepEqual(await snapshot(selected), before);
  assert.deepEqual(await fs.readdir(selected), ["options.txt"]);
});

test("canonical selection rejects missing, relative and regular-file paths", async (t) => {
  const root = await temporary(t);
  await fs.writeFile(path.join(root, "file"), "existing file");
  await assert.rejects(
    canonicalGameDirectoryPath("relative/.minecraft"),
    /绝对路径/,
  );
  await assert.rejects(
    canonicalGameDirectoryPath(path.join(root, "missing")),
    /不存在/,
  );
  await assert.rejects(
    canonicalGameDirectoryPath(path.join(root, "file")),
    /不是文件夹/,
  );
});

test("canonical selection reports write denial without changing existing files", async (t) => {
  const root = await temporary(t);
  await fs.writeFile(path.join(root, "options.txt"), "keep-this\n");
  const before = await snapshot(root);
  t.mock.method(fs, "open", async () => {
    const error = new Error("controlled permission failure");
    error.code = "EACCES";
    throw error;
  });
  await assert.rejects(canonicalGameDirectoryPath(root), /无法读写/);
  assert.deepEqual(await snapshot(root), before);
});

test("realpath aliases and Windows casing produce one duplicate identity", async (t) => {
  const root = await temporary(t);
  const selected = path.join(root, "Real 游戏目录");
  const alias = path.join(root, "alias");
  await fs.mkdir(selected);
  await fs.symlink(
    selected,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const actual = await canonicalGameDirectoryPath(selected);
  const linked = await canonicalGameDirectoryPath(alias);
  assert.equal(gameDirectoryPathKey(actual), gameDirectoryPathKey(linked));
  assert.equal(
    gameDirectoryPathKey(actual, "win32"),
    gameDirectoryPathKey(actual.toUpperCase(), "win32"),
  );
  assert.notEqual(
    gameDirectoryPathKey(path.join(root, "A"), "linux"),
    gameDirectoryPathKey(path.join(root, "a"), "linux"),
  );
});

test("read-only scan recognizes vanilla/Fabric/Quilt/Forge and stable source identities", async (t) => {
  const root = await temporary(t);
  await profile(root, "1.21.1", vanilla());
  await profile(root, "Fabric 中文版本", {
    inheritsFrom: "1.21.1",
    libraries: [{ name: "net.fabricmc:fabric-loader:0.16.14" }],
  });
  await profile(root, "Quilt 版本", {
    inheritsFrom: "1.21.1",
    libraries: [{ name: "org.quiltmc:quilt-loader:0.29.1" }],
  });
  await profile(root, "Forge 版本", {
    inheritsFrom: "1.21.1",
    libraries: [{ name: "net.minecraftforge:forge:1.21.1-52.0.28" }],
  });
  await fs.mkdir(path.join(root, "saves", "原有世界"), { recursive: true });
  await fs.writeFile(
    path.join(root, "saves", "原有世界", "level.dat"),
    "untouched-world",
  );
  await fs.writeFile(path.join(root, "options.txt"), "fullscreen:false\n");
  const before = await snapshot(root);
  const source = directory(root);
  const first = await scanGameDirectory(source);
  const second = await scanGameDirectory(source);
  assert.deepEqual(first, second);
  assert.deepEqual(first.warnings, []);
  assert.equal(first.instances.length, 4);
  assert.deepEqual(first.instances.map((instance) => instance.loader).sort(), [
    "fabric",
    "forge",
    "quilt",
    "vanilla",
  ]);
  assert.equal(
    first.instances.find((instance) => instance.loader === "forge")
      .loaderVersion,
    "52.0.28",
  );
  assert(
    first.instances.every(
      (instance) =>
        instance.version === "1.21.1" &&
        instance.gameDirectoryId === source.id &&
        instance.importedVersionId === instance.name &&
        /^local-[a-f0-9]{24}$/.test(instance.id),
    ),
  );
  assert(
    first.instances.every(
      (instance) => Object.keys(instance.gameSettings).length === 0,
    ),
  );
  assert.deepEqual(await snapshot(root), before);
  assert.equal((await fs.readdir(root)).includes("instances"), false);
  const otherSource = await scanGameDirectory(directory(root, "directory-two"));
  assert(
    first.instances.every(
      (instance) =>
        !otherSource.instances.some((other) => other.id === instance.id),
    ),
  );
});

test("scan permits missing official base metadata and reports that launch must complete it", async (t) => {
  const root = await temporary(t);
  await profile(root, "fabric-local", {
    inheritsFrom: "1.20.1",
    libraries: [{ name: "net.fabricmc:fabric-loader:0.15.11" }],
  });
  const result = await scanGameDirectory(directory(root));
  assert.equal(result.instances.length, 1);
  assert.equal(result.instances[0].version, "1.20.1");
  assert.equal(result.instances[0].loader, "fabric");
  assert(
    result.warnings.some((warning) => /缺少基础版本 1.20.1/.test(warning)),
  );
  await assert.rejects(fs.access(path.join(root, "versions", "1.20.1")));
});

test("scan rejects malformed JSON, mismatched IDs, traversal, invalid libraries and unknown base versions", async (t) => {
  const root = await temporary(t);
  const badJson = await profile(root, "bad-json", vanilla());
  await fs.writeFile(badJson, "{invalid");
  await profile(root, "wrong-id", { id: "1.21.1", ...vanilla() });
  await profile(root, "traversal", { inheritsFrom: "../outside" });
  await profile(root, "bad-libraries", { ...vanilla(), libraries: {} });
  await profile(root, "unknown-game-version", vanilla());
  const result = await scanGameDirectory(directory(root));
  assert.equal(result.instances.length, 0);
  assert.equal(result.warnings.length, 5);
  for (const name of [
    "bad-json",
    "wrong-id",
    "traversal",
    "bad-libraries",
    "unknown-game-version",
  ])
    assert(result.warnings.some((warning) => warning.startsWith(name + "：")));
});

test("scan stops cyclic and excessively deep inheritance without hanging", async (t) => {
  const root = await temporary(t);
  await profile(root, "cycle-a", { inheritsFrom: "cycle-b" });
  await profile(root, "cycle-b", { inheritsFrom: "cycle-a" });
  await profile(root, "1.21.1", vanilla());
  for (let index = 9; index >= 0; index--)
    await profile(root, `chain-${index}`, {
      inheritsFrom: index === 9 ? "1.21.1" : `chain-${index + 1}`,
    });
  const result = await scanGameDirectory(directory(root));
  assert(
    !result.instances.some((instance) =>
      instance.importedVersionId.startsWith("cycle-"),
    ),
  );
  assert(
    !result.instances.some(
      (instance) => instance.importedVersionId === "chain-0",
    ),
  );
  assert(result.warnings.some((warning) => /继承存在循环/.test(warning)));
  assert(result.warnings.some((warning) => /超过 8 层/.test(warning)));
});

test("scan skips linked version folders and refuses a versions root outside the selected directory", async (t) => {
  const root = await temporary(t);
  const selected = path.join(root, ".minecraft");
  const outside = path.join(root, "outside");
  await fs.mkdir(selected);
  await profile(outside, "1.21.1", vanilla());
  await fs.mkdir(path.join(selected, "versions"));
  await fs.symlink(
    path.join(outside, "versions", "1.21.1"),
    path.join(selected, "versions", "1.21.1"),
    process.platform === "win32" ? "junction" : "dir",
  );
  let result = await scanGameDirectory(directory(selected));
  assert.equal(result.instances.length, 0);
  assert(result.warnings.some((warning) => /链接版本文件夹/.test(warning)));
  const otherSelected = path.join(root, "other-minecraft");
  await fs.mkdir(otherSelected);
  await fs.symlink(
    path.join(outside, "versions"),
    path.join(otherSelected, "versions"),
    process.platform === "win32" ? "junction" : "dir",
  );
  result = await scanGameDirectory(directory(otherSelected));
  assert.equal(result.instances.length, 0);
  assert(result.warnings.some((warning) => /所选游戏目录之外/.test(warning)));
});

test("legacy registrations and empty standard folders do not import or create files", async (t) => {
  const root = await temporary(t);
  await profile(path.join(root, "minecraft"), "1.21.1", vanilla());
  const before = await snapshot(root);
  assert.deepEqual(
    await scanGameDirectory(directory(root, "legacy", "legacy")),
    { instances: [], warnings: [] },
  );
  assert.deepEqual(await scanGameDirectory(directory(root)), {
    instances: [],
    warnings: [],
  });
  assert.deepEqual(await snapshot(root), before);
});

test("scan limits oversized metadata before parsing it", async (t) => {
  const root = await temporary(t);
  const file = await profile(root, "too-large", vanilla());
  await fs.writeFile(file, Buffer.alloc(8 * 1024 * 1024 + 1, 32));
  const result = await scanGameDirectory(directory(root));
  assert.equal(result.instances.length, 0);
  assert(result.warnings.some((warning) => /超过 8 MB/.test(warning)));
});

test("version segments accept Chinese/spaces while rejecting traversal and Windows unsafe paths", () => {
  assert.equal(safeGameVersionId("我的 Fabric 1.21.1"), "我的 Fabric 1.21.1");
  for (const id of [
    "..",
    ".",
    "../evil",
    "x\\evil",
    "C:evil",
    "NUL",
    "COM1.json",
    "trailing.",
    "trailing ",
    "bad\nname",
    "x".repeat(181),
  ])
    assert.throws(() => safeGameVersionId(id), /版本标识/);
});

test("GameService keeps old layout compatibility and accepts an explicit standard resource root", async (t) => {
  const root = await temporary(t);
  const legacy = new GameService(root, () => {});
  assert.equal(legacy.root, path.join(root, "minecraft"));
  assert.equal(legacy.dataDir, root);
  const selected = path.join(root, "选定 .minecraft");
  const service = new GameService(selected, () => {}, {
    minecraftRoot: selected,
  });
  assert.equal(service.root, selected);
  assert.equal(service.dataDir, selected);
  assert.equal(
    service.libraryPath("org/example/library.jar"),
    path.join(selected, "libraries", "org", "example", "library.jar"),
  );
  assert.throws(
    () => new GameService(root, () => {}, { minecraftRoot: "relative" }),
    /绝对路径/,
  );
});

test("imported version directory wins over legacy launch.json and leaves root saves untouched", async (t) => {
  const root = await temporary(t);
  const selected = path.join(root, "游戏 文件夹", ".minecraft");
  await profile(selected, "1.21.1", vanilla());
  await profile(selected, "我的 Fabric 版本", {
    inheritsFrom: "1.21.1",
    libraries: [{ name: "net.fabricmc:fabric-loader:0.16.14" }],
  });
  await fs.mkdir(path.join(selected, "saves", "ExistingWorld"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(selected, "saves", "ExistingWorld", "level.dat"),
    "do-not-move",
  );
  const { instances } = await scanGameDirectory(directory(selected));
  const instance = instances.find((entry) => entry.loader === "fabric");
  const isolated = path.join(selected, "instances", instance.id);
  await fs.mkdir(path.join(isolated, ".ldfcl"), { recursive: true });
  await fs.writeFile(
    path.join(isolated, ".ldfcl", "launch.json"),
    JSON.stringify({ version: "wrong-managed-version" }),
  );
  const before = await snapshot(selected);
  const service = new GameService(selected, () => {}, {
    minecraftRoot: selected,
  });
  assert.equal(await service.launchVersion(instance), "我的 Fabric 版本");
  const metadata = await service.metadata(
    await service.launchVersion(instance),
  );
  assert.equal(metadata.id, "我的 Fabric 版本");
  assert.equal(metadata.mainClass, "net.minecraft.client.main.Main");
  assert.equal(metadata._clientId, "1.21.1");
  assert.deepEqual(await snapshot(selected), before);
  assert.notEqual(isolated, selected);
  assert.equal(
    await fs.readFile(
      path.join(selected, "saves", "ExistingWorld", "level.dat"),
      "utf8",
    ),
    "do-not-move",
  );
});

test("missing imported source reports a rescan instead of guessing another installed loader", async (t) => {
  const root = await temporary(t);
  await profile(root, "1.21.1", vanilla());
  await profile(root, "fabric-other-1.21.1", { inheritsFrom: "1.21.1" });
  const service = new GameService(root, () => {}, { minecraftRoot: root });
  await assert.rejects(
    service.launchVersion({
      id: "local-source",
      version: "1.21.1",
      loader: "fabric",
      importedVersionId: "fabric-removed",
    }),
    /重新扫描/,
  );
  await assert.rejects(
    service.launchVersion({
      id: "local-source",
      version: "1.21.1",
      loader: "vanilla",
      importedVersionId: "../outside",
    }),
    /版本标识/,
  );
});

test("imported launch rechecks that versions was not replaced by an outside junction after scanning", async (t) => {
  const root = await temporary(t);
  const selected = path.join(root, "selected");
  const outside = path.join(root, "outside");
  await profile(selected, "1.21.1", vanilla());
  await profile(outside, "1.21.1", vanilla());
  const { instances } = await scanGameDirectory(directory(selected));
  await fs.rename(
    path.join(selected, "versions"),
    path.join(selected, "original-versions"),
  );
  await fs.symlink(
    path.join(outside, "versions"),
    path.join(selected, "versions"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const service = new GameService(selected, () => {}, {
    minecraftRoot: selected,
  });
  await assert.rejects(service.launchVersion(instances[0]), /重新扫描/);
});

test("imported launch uses selected libraries/assets and an isolated gameDir without touching original world/settings", async (t) => {
  const root = await temporary(t);
  const selected = path.join(root, "含中文 和空格", ".minecraft");
  await profile(selected, "1.21.1", {
    ...vanilla(),
    arguments: {
      jvm: ["-Djava.library.path=${natives_directory}", "-cp", "${classpath}"],
      game: [
        "--username",
        "${auth_player_name}",
        "--version",
        "${version_name}",
        "--gameDir",
        "${game_directory}",
        "--assetsDir",
        "${assets_root}",
        "--libraries",
        "${library_directory}",
      ],
    },
  });
  await fs.writeFile(
    path.join(selected, "versions", "1.21.1", "1.21.1.jar"),
    "fixture-client",
  );
  await fs.mkdir(path.join(selected, "saves", "ExistingWorld"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(selected, "saves", "ExistingWorld", "level.dat"),
    "original-world",
  );
  await fs.writeFile(path.join(selected, "options.txt"), "fullscreen:false\n");
  const { instances } = await scanGameDirectory(directory(selected));
  const instance = { ...instances[0], gameSettings: { fullscreen: true } };
  const service = new GameService(selected, () => {}, {
    minecraftRoot: selected,
  });
  service.java.ensure = async () =>
    path.join(selected, "runtime", "fixture-java.exe");
  let invocation, child;
  t.mock.method(
    require("node:child_process"),
    "spawn",
    (file, args, options) => {
      invocation = { file, args, options };
      child = new EventEmitter();
      captureJavaStdin(child, invocation);
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.pid = 54321;
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  );
  const launched = await service.launch(
    instance,
    {
      id: "offline-qa",
      type: "offline",
      name: "Directory_QA",
      uuid: "0123456789abcdef0123456789abcdef",
    },
    {
      downloadConcurrency: 2,
      memoryMode: "manual",
      memoryMb: 1024,
      javaPath: "",
      microsoftClientId: "",
      closeOnLaunch: false,
    },
  );
  assert.equal(launched.pid, 54321);
  const gameDir = path.join(selected, "versions", instance.versionDirectory);
  const launchedArguments = decodedJavaInvocation(invocation);
  assert.equal(await fs.realpath(invocation.options.cwd), await fs.realpath(gameDir));
  assert.equal(
    await fs.realpath(launchedArguments.args[launchedArguments.args.indexOf("--gameDir") + 1]),
    await fs.realpath(gameDir),
  );
  assert.equal(
    await physicalPath(launchedArguments.args[launchedArguments.args.indexOf("--assetsDir") + 1]),
    await physicalPath(path.join(selected, "assets")),
  );
  assert.equal(
    await physicalPath(launchedArguments.args[launchedArguments.args.indexOf("--libraries") + 1]),
    await physicalPath(path.join(selected, "libraries")),
  );
  assert.equal(
    await fs.realpath(launchedArguments.classpath),
    await fs.realpath(path.join(selected, "versions", "1.21.1", "1.21.1.jar")),
  );
  assert.equal(
    await fs.realpath(invocation.args.find((argument) => argument.startsWith("-Djava.library.path=")).slice("-Djava.library.path=".length)),
    await fs.realpath(path.join(gameDir, ".ldfcl", "natives")),
  );
  assert.match(
    await fs.readFile(path.join(gameDir, "options.txt"), "utf8"),
    /fullscreen:true/,
  );
  assert.equal(
    await fs.readFile(path.join(selected, "options.txt"), "utf8"),
    "fullscreen:false\n",
  );
  assert.equal(
    await fs.readFile(
      path.join(selected, "saves", "ExistingWorld", "level.dat"),
      "utf8",
    ),
    "original-world",
  );
  await assert.rejects(fs.access(path.join(gameDir, "saves")));
  child.emit("close", 0);
});

test("argument tokenizer preserves inline quoted values and Windows paths", () => {
  assert.deepEqual(
    tokenizeArguments(
      '--gameDir="C:\\我的 游戏\\.minecraft" --username Alex --label=\'a b\' --empty ""',
    ),
    [
      "--gameDir=C:\\我的 游戏\\.minecraft",
      "--username",
      "Alex",
      "--label=a b",
      "--empty",
      "",
    ],
  );
});

test("inherited client downloads never overwrite an imported version's existing custom JAR", async (t) => {
  const root = await temporary(t);
  await profile(root, "1.21.1", {
    ...vanilla(),
    downloads: {
      client: {
        url: "https://example.invalid/parent.jar",
        sha1: "0".repeat(40),
      },
    },
  });
  const own = "Custom Fabric";
  await profile(root, own, { inheritsFrom: "1.21.1" });
  await fs.writeFile(
    path.join(root, "versions", "1.21.1", "1.21.1.jar"),
    "parent-client",
  );
  const ownFile = path.join(root, "versions", own, `${own}.jar`);
  await fs.writeFile(ownFile, "custom-client-do-not-replace");
  const service = new GameService(root, () => {}, { minecraftRoot: root });
  service.java.ensure = async () => "fixture-java.exe";
  let queuedClient = false;
  service.downloads.downloadMany = async (files) => {
    queuedClient ||= files.some((file) => file.path === ownFile);
    if (queuedClient) await fs.writeFile(ownFile, "incorrectly-replaced");
  };
  let child;
  t.mock.method(require("node:child_process"), "spawn", () => {
    child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 12345;
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  await service.launch(
    {
      id: "custom",
      version: "1.21.1",
      loader: "fabric",
      versionDirectory: own,
      gameSettings: {},
    },
    { type: "offline", name: "Alex", uuid: "0123456789abcdef0123456789abcdef" },
    { downloadConcurrency: 2, memoryMode: "manual", memoryMb: 1024 },
  );
  assert.equal(queuedClient, false);
  assert.equal(
    await fs.readFile(ownFile, "utf8"),
    "custom-client-do-not-replace",
  );
  child.emit("close", 0);
});

test("modern and legacy hardcoded gameDir flags cannot override per-instance isolation", async (t) => {
  const root = await temporary(t);
  const selected = path.join(root, "独立 游戏根", ".minecraft");
  const external = path.join(root, "原来的 游戏目录");
  await profile(selected, "1.21.1", vanilla());
  await fs.writeFile(
    path.join(selected, "versions", "1.21.1", "1.21.1.jar"),
    "fixture-client",
  );
  await fs.mkdir(path.join(external, "saves", "World"), { recursive: true });
  await fs.writeFile(
    path.join(external, "saves", "World", "level.dat"),
    "external-world",
  );
  await fs.writeFile(path.join(external, "options.txt"), "fullscreen:false\n");
  const originalExternal = await snapshot(external);
  const { instances } = await scanGameDirectory(directory(selected));
  const service = new GameService(selected, () => {}, {
    minecraftRoot: selected,
  });
  service.java.ensure = async () =>
    path.join(selected, "runtime", "fixture-java.exe");
  let invocation, child;
  t.mock.method(
    require("node:child_process"),
    "spawn",
    (file, args, options) => {
      invocation = { file, args, options };
      child = new EventEmitter();
      captureJavaStdin(child, invocation);
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.pid = 54321;
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  );
  const previousInstances = [];
  for (const format of ["modern", "legacy", "legacy-without-gameDir"]) {
    const versionId = `1.21.1-${format}`;
    const instance = {
      ...instances[0],
      id: instances[0].id + "-" + format,
      importedVersionId: versionId,
      versionDirectory: versionId,
      gameSettings: { fullscreen: format === "modern" },
    };
    const isolated = path.join(selected, "versions", instance.versionDirectory);
    const previousSnapshots = await Promise.all(
      previousInstances.map(snapshot),
    );
    await profile(selected, versionId, {
      ...vanilla(),
      jar: "1.21.1",
      ...(format === "modern"
        ? {
            arguments: {
              game: [
                "--gameDir",
                external,
                "--username",
                "${auth_player_name}",
                `--gameDir=${external}`,
                "--gameDir",
                "${game_directory}",
                "--server",
                "example.invalid",
              ],
            },
          }
        : {
            minecraftArguments:
              format === "legacy"
                ? `--gameDir "${external}" --gameDir="${external}" --username Alex --server example.invalid`
                : "Alex 0",
          }),
    });
    await service.launch(
      instance,
      {
        id: "account",
        type: "offline",
        name: "Alex",
        uuid: "0123456789abcdef0123456789abcdef",
      },
      {
        downloadConcurrency: 2,
        memoryMode: "manual",
        memoryMb: 1024,
        javaPath: "",
        microsoftClientId: "",
        closeOnLaunch: false,
      },
    );
    const launchedArguments = decodedJavaInvocation(invocation);
    assert.equal(await fs.realpath(invocation.options.cwd), await fs.realpath(isolated));
    const flags = launchedArguments.args.filter(
      (argument) =>
        argument === "--gameDir" || argument.startsWith("--gameDir="),
    );
    assert.equal(flags.length, format === "legacy-without-gameDir" ? 0 : 1);
    if (format !== "legacy-without-gameDir") {
      assert.equal(
        await fs.realpath(launchedArguments.args[launchedArguments.args.indexOf("--gameDir") + 1]),
        await fs.realpath(isolated),
      );
      assert.equal(
        launchedArguments.args[launchedArguments.args.indexOf("--server") + 1],
        "example.invalid",
      );
    }
    assert(!launchedArguments.args.some((argument) => argument.includes(external)));
    assert.match(
      await fs.readFile(path.join(isolated, "options.txt"), "utf8"),
      new RegExp(`fullscreen:${format === "modern"}`),
    );
    assert.deepEqual(await snapshot(external), originalExternal);
    assert.deepEqual(
      await Promise.all(previousInstances.map(snapshot)),
      previousSnapshots,
    );
    previousInstances.push(isolated);
    child.emit("close", 0);
  }
});
