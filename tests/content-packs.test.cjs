const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const AdmZip = require("adm-zip");
const { ContentPacksService } = require("@ldfcl/core/services/content-packs");
const {
  neoforgeVersionMatches,
  neoforgeArtifact,
  neoforgeVersions,
} = require("@ldfcl/core/services/neoforge");
const {
  GAME_PRESETS,
  gamePreset,
} = require("../dist-electron/shared/game-presets.js");
const {
  validateGameOptions,
} = require("../dist-electron/shared/game-settings.js");
async function fixture(t, loader = "fabric") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "LDFCL-packs-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const instance = {
    id: "selected",
    versionDirectory: "selected",
    name: "Selected",
    version: "1.21.1",
    loader,
    createdAt: "",
    gameSettings: {},
  };
  const directory = path.join(root, "versions", "selected");
  await fs.mkdir(directory, { recursive: true });
  return { root, instance, directory, service: new ContentPacksService(root) };
}
async function archive(filename, entries) {
  const zip = new AdmZip();
  for (const [name, data] of Object.entries(entries))
    zip.addFile(name, Buffer.from(data));
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, zip.toBuffer());
}
test("resource enable/reorder/disable writes actual pack selection and preserves other settings and instance", async (t) => {
  const { root, instance, directory, service } = await fixture(t);
  for (const name of ["a.zip", "b.zip"])
    await archive(path.join(directory, "resourcepacks", name), {
      "pack.mcmeta": "{}",
    });
  const options = path.join(directory, "options.txt"),
    other = path.join(root, "versions", "other", "options.txt");
  const original =
    'unknownOption:keep\nresourcePacks:["vanilla"]\nlang:zh_cn\n';
  await fs.writeFile(options, original);
  await fs.mkdir(path.dirname(other));
  await fs.writeFile(other, original);
  await service.setEnabled(instance, "resourcepack", "a.zip", true);
  await service.setEnabled(instance, "resourcepack", "b.zip", true);
  await service.reorder(instance, ["b.zip", "a.zip"]);
  assert.match(
    await fs.readFile(options, "utf8"),
    /resourcePacks:\["vanilla","file\/b.zip","file\/a.zip"\]/,
  );
  assert.deepEqual(
    (await service.list(instance, "resourcepack")).packs.map((pack) => [
      pack.name,
      pack.enabled,
    ]),
    [
      ["b.zip", true],
      ["a.zip", true],
    ],
  );
  await service.setEnabled(instance, "resourcepack", "a.zip", false);
  assert.match(await fs.readFile(options, "utf8"), /unknownOption:keep/);
  assert.match(
    await fs.readFile(options, "utf8"),
    /resourcePacks:\["vanilla","file\/b.zip"\]/,
  );
  assert.equal(await fs.readFile(other, "utf8"), original);
  await assert.rejects(service.reorder(instance, ["a.zip"]), /已启用/);
  await service.remove(instance, "resourcepack", "b.zip");
  assert(
    (await fs.readdir(path.join(directory, ".trash"))).some((name) =>
      name.endsWith("-b.zip"),
    ),
  );
  assert.match(
    await fs.readFile(options, "utf8"),
    /resourcePacks:\["vanilla"\]/,
  );
});
test("Iris/Oculus/OptiFine use their real selection files, support unicode names and preserve unknown properties", async (t) => {
  for (const renderer of ["iris", "oculus", "optifine"]) {
    await t.test(renderer, async (sub) => {
      const { directory, instance, service } = await fixture(
        sub,
        renderer === "optifine"
          ? "optifine"
          : renderer === "oculus"
            ? "forge"
            : "fabric",
      );
      if (renderer === "iris")
        await archive(path.join(directory, "mods", "iris.jar"), {
          "fabric.mod.json": JSON.stringify({ id: "iris" }),
        });
      if (renderer === "oculus")
        await archive(path.join(directory, "mods", "oculus.jar"), {
          "META-INF/mods.toml": '[[mods]]\nmodId="oculus"\n',
        });
      const name = "中文光影.zip";
      await archive(path.join(directory, "shaderpacks", name), {
        "shaders/main.fsh": "void main(){}",
      });
      const config =
        renderer === "optifine"
          ? path.join(directory, "optionsshaders.txt")
          : path.join(directory, "config", `${renderer}.properties`);
      await fs.mkdir(path.dirname(config), { recursive: true });
      await fs.writeFile(config, "customProperty=keep\n");
      await service.setEnabled(instance, "shader", name, true);
      let result = await service.list(instance, "shader");
      assert.equal(result.renderer, renderer);
      assert.equal(result.packs[0].enabled, true);
      assert.match(await fs.readFile(config, "utf8"), /customProperty=keep/);
      await service.setEnabled(instance, "shader", name, false);
      assert.equal(
        (await service.list(instance, "shader")).packs[0].enabled,
        false,
      );
      assert.match(
        await fs.readFile(config, "utf8"),
        renderer === "optifine" ? /shaderPack=OFF/ : /enableShaders=false/,
      );
      await assert.rejects(
        fs.access(path.join(directory, "options.txt")),
        /ENOENT/,
      );
    });
  }
});
test("missing shader renderer blocks enabling but permits recovering a downloaded archive through trash", async (t) => {
  const { directory, instance, service } = await fixture(t);
  await archive(path.join(directory, "shaderpacks", "plain.zip"), {
    "shaders/main.fsh": "",
  });
  assert.equal((await service.list(instance, "shader")).shaderAvailable, false);
  await assert.rejects(
    service.setEnabled(instance, "shader", "plain.zip", true),
    /尚未安装/,
  );
  await service.remove(instance, "shader", "plain.zip");
  assert.equal((await service.list(instance, "shader")).packs.length, 0);
  assert(
    (await fs.readdir(path.join(directory, ".trash"))).some((name) =>
      name.endsWith("-plain.zip"),
    ),
  );
});
test("invalid names/options and linked settings cannot overwrite unrelated files", async (t) => {
  const { root, directory, instance, service } = await fixture(t);
  await archive(path.join(directory, "resourcepacks", "valid.zip"), {
    "pack.mcmeta": "{}",
  });
  for (const name of [
    "../escape.zip",
    "CON.zip",
    "a:b.zip",
    "x?.zip",
    "x.zip ",
  ])
    await assert.rejects(
      service.setEnabled(instance, "resourcepack", name, true),
      /无效/,
    );
  const options = path.join(directory, "options.txt");
  await fs.writeFile(options, "resourcePacks:invalid\nkeep:true\n");
  await assert.rejects(
    service.setEnabled(instance, "resourcepack", "valid.zip", true),
    /列表/,
  );
  assert.equal(
    await fs.readFile(options, "utf8"),
    "resourcePacks:invalid\nkeep:true\n",
  );
  await fs.rm(options);
  const original = 'resourcePacks:["vanilla"]\nkeep:true\n',
    external = path.join(root, "external.txt");
  await fs.writeFile(external, original);
  await fs.link(external, options);
  await service.setEnabled(instance, "resourcepack", "valid.zip", true);
  assert.equal(
    await fs.readFile(external, "utf8"),
    original,
    "atomic rename must not edit linked contents in place",
  );
});
test("NeoForge matches 1.21/1.21.1 and legacy 1.20.1 without cross-version selection", async () => {
  assert.equal(neoforgeVersionMatches("1.21", "21.0.100"), true);
  assert.equal(neoforgeVersionMatches("1.21.1", "21.1.100"), true);
  assert.equal(neoforgeVersionMatches("1.21.1", "21.0.100"), false);
  assert.equal(neoforgeVersionMatches("1.20.1", "1.20.1-47.1.106"), true);
  assert.equal(neoforgeVersionMatches("26.3", "26.3.0.95"), true);
  assert.equal(neoforgeVersionMatches("26.1.2", "26.1.2.4-beta"), true);
  assert.equal(neoforgeVersionMatches("1.19.4", "21.1.100"), false);
  assert.equal(neoforgeArtifact("1.20.1"), "forge");
  assert.equal(neoforgeArtifact("1.21"), "neoforge");
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    assert.match(url, /maven\.neoforged\.net\/api\/maven\/versions/);
    return new Response(
      JSON.stringify({ versions: ["21.1.1-beta", "21.1.8", "21.0.99"] }),
    );
  };
  try {
    assert.deepEqual(await neoforgeVersions("1.21.1"), [
      "21.1.8",
      "21.1.1-beta",
    ]);
  } finally {
    global.fetch = realFetch;
  }
});
test("all four real game presets pass option validation and return independent copies", () => {
  assert.equal(Object.keys(GAME_PRESETS).length, 4);
  for (const id of Object.keys(GAME_PRESETS))
    assert.deepEqual(validateGameOptions(gamePreset(id)), gamePreset(id));
  const first = gamePreset("balanced");
  first.lang = "en_us";
  assert.equal(gamePreset("balanced").lang, "zh_cn");
  assert.throws(() => gamePreset("unknown"), /未知/);
});
test("NeoForge runs the official verified client installer with matching Java and validates its generated profile", async (t) => {
  const { root } = await fixture(t);
  const { GameService } = require("@ldfcl/core/services/game");
  const javaModule = require("@ldfcl/core/services/java");
  const realFetch = global.fetch,
    originalRun = javaModule.runProcess;
  const stage = path.join(root, "fresh-stage");
  const service = new GameService(root, () => {}, { minecraftRoot: stage });
  const downloads = [],
    invocations = [],
    selectedJava = [];
  service.downloads = {
    download: async (...args) => {
      downloads.push(args);
    },
  };
  service.java = {
    ensure: async (major) => {
      selectedJava.push(major);
      return "fixture-java";
    },
  };
  global.fetch = async (url) =>
    String(url).endsWith(".sha1")
      ? new Response("a".repeat(40))
      : new Response(JSON.stringify({ versions: ["21.1.8", "21.0.9"] }));
  javaModule.runProcess = async (java, args, cwd) => {
    invocations.push({ java, args, cwd });
    const id = "neoforge-21.1.8";
    await fs.mkdir(path.join(stage, "versions", id), { recursive: true });
    await fs.writeFile(
      path.join(stage, "versions", id, `${id}.json`),
      JSON.stringify({
        id,
        inheritsFrom: "1.21.1",
        libraries: [{ name: "net.neoforged:neoforge:21.1.8" }],
      }),
    );
    return { stdout: "", stderr: "" };
  };
  try {
    const profile = await service.loaderProfile("1.21.1", "neoforge");
    assert.deepEqual(profile, {
      id: "neoforge-21.1.8",
      loaderVersion: "21.1.8",
    });
    assert.deepEqual(selectedJava, [21]);
    assert.match(
      downloads[0][0],
      /^https:\/\/maven\.neoforged\.net\/releases\/net\/neoforged\/neoforge\/21\.1\.8\/neoforge-21\.1\.8-installer\.jar$/,
    );
    assert.equal(downloads[0][2], "a".repeat(40));
    assert.deepEqual(invocations[0].args.slice(-2), ["--installClient", stage]);
    assert.equal(invocations[0].cwd, stage);
    await assert.rejects(
      service.loaderProfile("1.21.1", "neoforge", "21.0.9"),
      /对应的指定版本/,
    );
    javaModule.runProcess = async () => {};
    await fs.rm(path.join(stage, "versions"), { recursive: true });
    await fs.mkdir(path.join(stage, "versions"));
    await assert.rejects(
      service.loaderProfile("1.21.1", "neoforge"),
      /未生成匹配/,
    );
  } finally {
    global.fetch = realFetch;
    javaModule.runProcess = originalRun;
  }
});
