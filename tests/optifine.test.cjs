const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const AdmZip = require("adm-zip");
const compiled =
  process.env.LDFCL_TEST_COMPILED_ROOT ||
  path.join(__dirname, "..", "core", "dist");
const optifine = require(path.join(compiled, "core/services/optifine.js"));
const java = require(path.join(compiled, "core/services/java.js"));
const { GameService } = require(path.join(compiled, "core/services/game.js"));
const { DownloadManager } = require(path.join(compiled, "core/services/downloads.js"));
const { scanGameDirectory } = require(
  path.join(compiled, "core/game-directories.js"),
);
const { OPTIFINE_BRIDGE } = require(
  path.join(compiled, "core/services/optifine-bridge.js"),
);
const mc = "1.12.2";
const raw = (patch = "G5", extra = {}) => ({
  mcversion: mc,
  type: "HD_U",
  patch,
  filename: `OptiFine_${mc}_HD_U_${patch}.jar`,
  ...extra,
});
const release = optifine.normalizeOptifineVersions([raw()], mc)[0];
async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "LDFCL-optifine-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function write(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data);
}
function fixtureJar(entries) {
  const zip = new AdmZip();
  for (const entry of entries) zip.addFile(entry, Buffer.from("fixture"));
  return zip.toBuffer();
}
function metadata(t, body = [raw()]) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  });
  return calls;
}
async function generated(root, extra = {}) {
  const id = `${mc}-OptiFine_HD_U_G5`;
  const profile = {
    id,
    inheritsFrom: mc,
    mainClass: "net.minecraft.launchwrapper.Launch",
    minecraftArguments: "--tweakClass optifine.OptiFineTweaker",
    libraries: [
      { name: `optifine:OptiFine:${mc}_HD_U_G5` },
      { name: "optifine:launchwrapper-of:2.2" },
    ],
    ...extra,
  };
  await write(
    path.join(root, "versions", id, `${id}.json`),
    JSON.stringify(profile),
  );
  for (const [relative, entries] of [
    [
      `optifine/OptiFine/${mc}_HD_U_G5/OptiFine-${mc}_HD_U_G5.jar`,
      [
        "optifine/OptiFineTweaker.class",
        "net/optifine/Config.class",
        "bib.class",
      ],
    ],
    [
      "optifine/launchwrapper-of/2.2/launchwrapper-of-2.2.jar",
      ["net/minecraft/launchwrapper/Launch.class"],
    ],
  ])
    await write(path.join(root, "libraries", relative), fixtureJar(entries));
  return id;
}

test("OptiFine metadata selects stable newest first and rejects foreign versions, paths, malformed names and duplicates", () => {
  const items = [
    raw("F5"),
    raw(),
    raw(),
    raw("pre1", {
      type: "HD_U_G6",
      filename: `preview_OptiFine_${mc}_HD_U_G6_pre1.jar`,
    }),
    raw("G5", { mcversion: "1.8.9" }),
    raw("../../evil"),
    raw("G5", { filename: "wrong.jar" }),
    raw("G5", { filename: 123 }),
    null,
  ];
  assert.deepEqual(
    optifine.normalizeOptifineVersions(items, mc).map((item) => item.id),
    ["HD_U_G5", "HD_U_F5", "HD_U_G6_pre1"],
  );
  assert.equal(
    optifine.normalizeOptifineVersions(items, mc).at(-1).preview,
    true,
  );
  assert.deepEqual(optifine.normalizeOptifineVersions([], "26.1"), []);
  assert.throws(() => optifine.normalizeOptifineVersions({}, mc), /无效数据/);
  assert.equal(
    optifine.optifineDownloadUrl(release),
    `https://bmclapi2.bangbang93.com/optifine/${mc}/HD_U/G5`,
  );
  assert.throws(
    () => optifine.optifineDownloadUrl({ ...release, patch: "../G5" }),
    /无效/,
  );
  assert.throws(
    () => optifine.optifineDownloadUrl({ ...release, id: "other" }),
    /无效/,
  );
});

test("OptiFine listing queries the selected Minecraft version, preserves empty results and gives retryable network feedback", async (t) => {
  const calls = metadata(t);
  assert.equal((await optifine.optifineVersions(mc))[0].id, "HD_U_G5");
  assert.deepEqual(calls, [`https://bmclapi2.bangbang93.com/optifine/${mc}`]);
  t.mock.restoreAll();
  metadata(t, []);
  assert.deepEqual(await optifine.optifineVersions("26.1"), []);
  t.mock.restoreAll();
  metadata(t, { error: "wrong data" });
  await assert.rejects(
    optifine.optifineVersions(mc),
    /无法获取.*检查网络后重试/,
  );
});

test("OptiFine bridge is Java 8 bytecode and invokes the official installer's actual version check and install entry", () => {
  const bytes = Buffer.from(OPTIFINE_BRIDGE, "base64");
  assert.equal(bytes.readUInt32BE(0), 0xcafebabe);
  assert.equal(bytes.readUInt16BE(6), 52);
  for (const value of [
    "getOptiFineVersion",
    "doInstall",
    "java.awt.headless",
    "Installer version mismatch",
    "LDFCL_OPTIFINE_INSTALLED",
  ])
    assert(bytes.includes(Buffer.from(value)), value);
});

test("OptiFine installation runs headless with exact version, automatic Java and validated real generated libraries", async (t) => {
  const root = await temporary(t);
  metadata(t);
  const events = [],
    ensured = [],
    transfers = [];
  const input = {
    dataDir: root,
    minecraftRoot: path.join(root, "staging"),
    version: mc,
    requested: "HD_U_G5",
    javaMajor: 8,
    java: {
      ensure: async (major) => {
        ensured.push(major);
        return "controlled-java";
      },
    },
    downloads: {
      downloadVerified: async (file) => {
        transfers.push(file);
        await write(
          file.path,
          fixtureJar(["optifine/Installer.class", "optifine/Patcher.class"]),
        );
      },
    },
    emit: (event) => events.push(event),
  };
  t.mock.method(java, "runProcess", async (executable, args, cwd) => {
    assert.equal(executable, "controlled-java");
    assert.equal(cwd, input.minecraftRoot);
    assert.deepEqual(args.slice(-4), [
      "OptiFineBridge",
      input.minecraftRoot,
      mc,
      "HD_U_G5",
    ]);
    assert(args.includes("-Djava.awt.headless=true"));
    assert(args[args.indexOf("-cp") + 1].includes(path.delimiter));
    const bridge = await fs.readFile(
      path.join(
        input.minecraftRoot,
        ".ldfcl-optifine-installer",
        "OptiFineBridge.class",
      ),
    );
    assert.equal(bridge.readUInt32BE(0), 0xcafebabe);
    await generated(input.minecraftRoot);
    return {
      stdout: `LDFCL_OPTIFINE_INSTALLED OptiFine_${mc}_HD_U_G5`,
      stderr: "",
    };
  });
  assert.deepEqual(await optifine.installOptifine(input), {
    id: `${mc}-OptiFine_HD_U_G5`,
    loaderVersion: "HD_U_G5",
  });
  assert.deepEqual(ensured, [8]);
  assert.equal(transfers[0].requireHttps, true);
  assert.equal(transfers[0].maxBytes, 64 * 1024 * 1024);
  const profile = JSON.parse(
    await fs.readFile(
      path.join(
        input.minecraftRoot,
        "versions",
        `${mc}-OptiFine_HD_U_G5`,
        `${mc}-OptiFine_HD_U_G5.json`,
      ),
      "utf8",
    ),
  );
  assert(
    profile.libraries.every(
      (item) =>
        /^[a-f0-9]{40}$/.test(item.downloads.artifact.sha1) &&
        item.downloads.artifact.size > 0,
    ),
  );
  assert(events.some((event) => event.task?.status === "completed"));
});

test("OptiFine exact requested release never falls back to a latest or unsupported Minecraft version", async (t) => {
  const root = await temporary(t);
  metadata(t);
  const input = {
    dataDir: root,
    minecraftRoot: root,
    version: mc,
    requested: "HD_U_WRONG",
    javaMajor: 8,
    java: { ensure: () => assert.fail("must not provision Java") },
    downloads: {
      downloadVerified: () =>
        assert.fail("must not download an arbitrary release"),
    },
    emit() {},
  };
  await assert.rejects(
    optifine.installOptifine(input),
    /没有可用的 OptiFine HD_U_WRONG/,
  );
  t.mock.restoreAll();
  metadata(t, []);
  await assert.rejects(
    optifine.installOptifine({ ...input, requested: undefined }),
    /暂不支持.*可选择原版/,
  );
});

test("OptiFine rejects non-installer downloads and failed or mismatched installation output", async (t) => {
  const root = await temporary(t);
  metadata(t);
  const events = [];
  const input = {
    dataDir: root,
    minecraftRoot: root,
    version: mc,
    requested: "HD_U_G5",
    javaMajor: 8,
    java: { ensure: async () => "java" },
    downloads: {
      downloadVerified: async (file) =>
        write(file.path, fixtureJar(["not-an-installer.txt"])),
    },
    emit: (event) => events.push(event),
  };
  const runner = t.mock.method(java, "runProcess", async () =>
    assert.fail("non-installer may not execute"),
  );
  await assert.rejects(optifine.installOptifine(input), /不是受支持.*安装器/);
  await assert.rejects(
    fs.access(path.join(root, "cache/optifine", release.filename)),
    /ENOENT/,
  );
  assert.equal(runner.mock.callCount(), 0);
  input.downloads.downloadVerified = async (file) =>
    write(
      file.path,
      fixtureJar(["optifine/Installer.class", "optifine/Patcher.class"]),
    );
  runner.mock.mockImplementation(async () => ({
    stdout: "installer returned without confirmation",
    stderr: "",
  }));
  await assert.rejects(optifine.installOptifine(input), /未确认安装成功/);
  runner.mock.mockImplementation(async () => {
    await generated(root, { inheritsFrom: "1.8.9" });
    return {
      stdout: `LDFCL_OPTIFINE_INSTALLED OptiFine_${mc}_HD_U_G5`,
      stderr: "",
    };
  });
  await assert.rejects(
    optifine.installOptifine(input),
    /没有生成匹配的启动配置/,
  );
  assert(events.some((event) => event.task?.status === "failed"));
});

test("OptiFine output requires actual patched and launchwrapper jars, not an installer renamed as a version", async (t) => {
  const root = await temporary(t);
  await generated(root);
  const patched = path.join(
    root,
    "libraries",
    `optifine/OptiFine/${mc}_HD_U_G5/OptiFine-${mc}_HD_U_G5.jar`,
  );
  await fs.writeFile(
    patched,
    fixtureJar(["optifine/Installer.class", "optifine/Patcher.class"]),
  );
  await assert.rejects(
    optifine.validateOptifineProfile(root, release),
    /未生成完整的已修补运行库/,
  );
  await generated(root);
  await fs.rm(
    path.join(
      root,
      "libraries/optifine/launchwrapper-of/2.2/launchwrapper-of-2.2.jar",
    ),
  );
  await assert.rejects(
    optifine.validateOptifineProfile(root, release),
    /ENOENT/,
  );
});

test("GameService OptiFine staging keeps native profiles intact and publishes an isolated launchable profile, client and generated jars", async (t) => {
  const root = await temporary(t);
  const gameRoot = path.join(root, "game");
  await write(
    path.join(gameRoot, "launcher_profiles.json"),
    "native profiles must survive",
  );
  t.mock.method(GameService.prototype, "vanilla", async () => ({
    id: mc,
    mainClass: "net.minecraft.client.main.Main",
    minecraftArguments: "--username ${auth_player_name}",
    libraries: [],
    downloads: { client: { url: "https://qa.invalid/client.jar" } },
  }));
  let stage;
  t.mock.method(optifine, "installOptifine", async (input) => {
    stage = input.minecraftRoot;
    assert.notEqual(stage, gameRoot);
    assert.equal(input.requested, "HD_U_G5");
    assert.equal(input.javaMajor, 8);
    assert.equal(
      await fs.readFile(path.join(stage, "versions", mc, `${mc}.jar`), "utf8"),
      "verified vanilla client",
    );
    const id = await generated(stage);
    await optifine.validateOptifineProfile(stage, release);
    return { id, loaderVersion: "HD_U_G5" };
  });
  const service = new GameService(root, () => {}, { minecraftRoot: gameRoot });
  t.mock.method(DownloadManager.prototype, "download", async (_url, target) =>
    write(target, "verified vanilla client"));
  service.downloads.downloadMany = async () => {};
  const instance = await service.install({
    version: mc,
    loader: "optifine",
    loaderVersion: "HD_U_G5",
    name: "OptiFine 生存",
  });
  const target = path.join(gameRoot, "versions", instance.versionDirectory);
  const profile = JSON.parse(
    await fs.readFile(
      path.join(target, `${instance.versionDirectory}.json`),
      "utf8",
    ),
  );
  assert.equal(instance.loader, "optifine");
  assert.equal(instance.loaderVersion, "HD_U_G5");
  assert.equal(profile.inheritsFrom, undefined);
  assert.equal(profile.mainClass, "net.minecraft.launchwrapper.Launch");
  assert.equal(profile.minecraftVersion, mc);
  assert(profile.minecraftArguments.includes("optifine.OptiFineTweaker"));
  assert.equal(
    await fs.readFile(
      path.join(target, `${instance.versionDirectory}.jar`),
      "utf8",
    ),
    "verified vanilla client",
  );
  await fs.access(
    path.join(
      gameRoot,
      "libraries/optifine/OptiFine",
      `${mc}_HD_U_G5`,
      `OptiFine-${mc}_HD_U_G5.jar`,
    ),
  );
  assert.equal(
    await fs.readFile(path.join(gameRoot, "launcher_profiles.json"), "utf8"),
    "native profiles must survive",
  );
  await assert.rejects(fs.access(stage), /ENOENT/);
  const scanned = await scanGameDirectory({
    id: "qa",
    name: "QA",
    path: gameRoot,
    layout: "standard",
  });
  assert.equal(scanned.instances.length, 1);
  assert.equal(scanned.instances[0].loader, "optifine");
  assert.equal(scanned.instances[0].loaderVersion, "HD_U_G5");
});

test("failed OptiFine installations remove only their newly allocated instance and staging", async (t) => {
  const root = await temporary(t);
  const gameRoot = path.join(root, "game");
  await write(
    path.join(gameRoot, "versions", "existing", "keep.txt"),
    "user data",
  );
  t.mock.method(GameService.prototype, "vanilla", async () => ({
    id: mc,
    downloads: { client: { url: "https://qa.invalid/client.jar" } },
  }));
  t.mock.method(optifine, "installOptifine", async () => {
    throw new Error("controlled patch failure");
  });
  const service = new GameService(root, () => {}, { minecraftRoot: gameRoot });
  t.mock.method(DownloadManager.prototype, "download", async (_url, target) => write(target, "client"));
  await assert.rejects(
    service.install({
      version: mc,
      loader: "optifine",
      loaderVersion: "HD_U_G5",
    }),
    /controlled patch failure/,
  );
  assert.deepEqual(await fs.readdir(path.join(gameRoot, "versions")), [
    "existing",
  ]);
  assert.equal(
    await fs.readFile(
      path.join(gameRoot, "versions/existing/keep.txt"),
      "utf8",
    ),
    "user data",
  );
  assert.deepEqual(await fs.readdir(path.join(root, "cache")), []);
});
