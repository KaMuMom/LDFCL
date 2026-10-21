const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const {
  validateGameOptions,
  effectiveGameOptions,
} = require("../dist-electron/shared/game-settings.js");
const {
  Store,
  validateSettings,
} = require("../dist-electron/electron/store.js");
const { GameService } = require("../dist-electron/electron/services/game.js");

async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "LDFCL-game-settings-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test("general game options validate types, bounds and language without allowing arbitrary options or line injection", () => {
  const valid = {
    renderDistance: 16,
    maxFps: 144,
    gamma: 0.7,
    fullscreen: false,
    lang: "EN_US",
    unknown: "ignored",
  };
  assert.deepEqual(validateGameOptions(valid), {
    renderDistance: 16,
    maxFps: 144,
    gamma: 0.7,
    fullscreen: false,
    lang: "en_us",
  });
  for (const invalid of [
    null,
    [],
    "text",
    { renderDistance: 1 },
    { renderDistance: 12.5 },
    { maxFps: Infinity },
    { gamma: 2 },
    { fullscreen: "true" },
    { lang: "zh_cn\rmaxFps:1" },
  ])
    assert.throws(() => validateGameOptions(invalid));
  assert.deepEqual(
    validateSettings({ gameDefaults: valid }).gameDefaults,
    validateGameOptions(valid),
  );
});

test("instance presets override general defaults without mutating them; empty presets inherit future changes", () => {
  const settings = {
    gameDefaults: { renderDistance: 14, fullscreen: true, lang: "zh_cn" },
  };
  const instance = { gameSettings: { fullscreen: false, maxFps: 90 } };
  assert.deepEqual(effectiveGameOptions(settings, instance), {
    renderDistance: 14,
    fullscreen: false,
    lang: "zh_cn",
    maxFps: 90,
  });
  const merged = effectiveGameOptions(settings, instance);
  merged.renderDistance = 2;
  assert.equal(settings.gameDefaults.renderDistance, 14);
  assert.deepEqual(effectiveGameOptions({}, instance), instance.gameSettings);
  instance.gameSettings = {};
  settings.gameDefaults.renderDistance = 20;
  assert.equal(effectiveGameOptions(settings, instance).renderDistance, 20);
});

test("general settings persist across Store restart, old installs remain opt-in, and invalid saved defaults cannot inject options", async (t) => {
  const dir = await temporary(t);
  let store = new Store(dir);
  await store.load();
  assert.deepEqual(store.settings.gameDefaults, {});
  store.settings = {
    ...store.settings,
    ...validateSettings({
      gameDefaults: { renderDistance: 22, enableVsync: false, lang: "zh_cn" },
    }),
  };
  await store.save();
  store = new Store(dir);
  await store.load();
  assert.equal(store.settings.gameDefaults.renderDistance, 22);
  const file = path.join(dir, "launcher.json");
  const saved = JSON.parse(await fs.readFile(file, "utf8"));
  saved.settings.gameDefaults = { lang: "zh_cn\nmalicious:true" };
  await fs.writeFile(file, JSON.stringify(saved));
  store = new Store(dir);
  await store.load();
  assert.deepEqual(store.settings.gameDefaults, {});
  assert.equal(store.settings.downloadConcurrency, 8);
});

test("actual launch preparation writes general and per-instance options to only the chosen version directory", async (t) => {
  const dir = await temporary(t);
  const root = path.join(dir, ".minecraft");
  const selected = path.join(root, "versions", "selected");
  const other = path.join(root, "versions", "other");
  await fs.mkdir(selected, { recursive: true });
  await fs.mkdir(other, { recursive: true });
  const otherOptions = "renderDistance:4\nlang:en_us\n";
  await fs.writeFile(path.join(other, "options.txt"), otherOptions);
  await fs.writeFile(
    path.join(selected, "options.txt"),
    'resourcePacks:["keep.zip"]\nrenderDistance:6\n',
  );
  await fs.writeFile(
    path.join(selected, "selected.json"),
    JSON.stringify({
      id: "selected",
      mainClass: "net.minecraft.client.main.Main",
      libraries: [],
      arguments: { game: ["--gameDir", "${game_directory}"], jvm: [] },
    }),
  );
  await fs.writeFile(path.join(selected, "selected.jar"), "fixture");
  const service = new GameService(dir, () => {}, { minecraftRoot: root });
  service.java.ensure = async () => "fixture-java.exe";
  let child;
  t.mock.method(require("node:child_process"), "spawn", () => {
    child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 54321;
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  const instance = {
    id: "chosen",
    name: "selected",
    version: "1.21.1",
    loader: "vanilla",
    versionDirectory: "selected",
    gameSettings: { maxFps: 90, fullscreen: false },
  };
  const settings = {
    downloadConcurrency: 2,
    memoryMode: "manual",
    memoryMb: 1024,
    gameDefaults: {
      renderDistance: 18,
      lang: "zh_cn",
      maxFps: 144,
      fullscreen: true,
    },
  };
  const account = {
    type: "offline",
    name: "Alex",
    uuid: "0123456789abcdef0123456789abcdef",
  };
  await service.launch(instance, account, settings);
  let result = await fs.readFile(path.join(selected, "options.txt"), "utf8");
  assert.match(result, /renderDistance:18\n/);
  assert.match(result, /maxFps:90\n/);
  assert.match(result, /fullscreen:false\n/);
  assert.match(result, /resourcePacks:\["keep.zip"\]/);
  assert.equal(
    await fs.readFile(path.join(other, "options.txt"), "utf8"),
    otherOptions,
  );
  child.emit("close", 0);
  instance.gameSettings = {};
  await service.launch(instance, account, settings);
  result = await fs.readFile(path.join(selected, "options.txt"), "utf8");
  assert.match(result, /maxFps:144\n/);
  assert.match(result, /fullscreen:true\n/);
  assert.equal(
    await fs.readFile(path.join(other, "options.txt"), "utf8"),
    otherOptions,
  );
  child.emit("close", 0);
});
