const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { Store } = require("@ldfcl/core/store");
const { LauncherFeatures } = require("@ldfcl/core/features");
const {
  pathReference,
  resolvePathReference,
} = require("@ldfcl/core/portable-paths");
const { CORE_COMMANDS } = require("@ldfcl/contracts/commands");
const { createCommandRouter } = require("@ldfcl/core/commands");
const {
  javaSearchRoots,
  windowsPowerShellPath,
} = require("@ldfcl/core/platform-paths");

async function fixture(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "LDFCL-portable-paths-"),
  );
  assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const program = path.join(root, "原程序 中文 空格");
  const bases = (program) => ({
    program,
    data: path.join(program, "LDFCL-data"),
    game: path.join(program, ".minecraft"),
  });
  const storeAt = (program) => {
    const b = bases(program);
    return new Store(b.data, { programDir: program, defaultGameRoot: b.game });
  };
  const b = bases(program);
  await fs.mkdir(path.join(b.game, "versions", "fixture", "saves"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(b.game, "versions", "fixture", "saves", "world.dat"),
    "world sentinel",
  );
  const store = storeAt(program);
  await store.load();
  store.instances.push({
    id: "fixture",
    name: "合成实例",
    version: "1.21.1",
    loader: "vanilla",
    versionDirectory: "fixture",
    gameDirectoryId: store.selectedGameDirectoryId,
    createdAt: new Date().toISOString(),
    gameSettings: { renderDistance: 9 },
    javaPath: path.join(b.data, "runtime", "test-java", "bin", "java.exe"),
  });
  store.selectedInstanceId = "fixture";
  store.settings.javaPath = store.instances[0].javaPath;
  store.selectedAccountId = "offline-identity";
  await fs.writeFile(
    path.join(b.data, "accounts.json"),
    '[{"id":"offline-identity","type":"offline","name":"Steve"}]',
  );
  await store.save();
  return { root, program, bases, storeAt, store };
}

test("portable folder moves preserve directory and account identities, owned Java paths, external roots and world bytes", async (t) => {
  const f = await fixture(t),
    external = path.join(f.root, "external-game");
  f.store.registerGameDirectory({
    id: "external",
    name: "External",
    path: external,
    layout: "standard",
  });
  const extra = path.join(f.program, "other-games", "custom");
  f.store.registerGameDirectory({
    id: "bundled",
    name: "Bundled",
    path: extra,
    layout: "standard",
  });
  const id = f.store.selectedGameDirectoryId;
  await f.store.save();
  const moved = path.join(f.root, "任意位置 新程序");
  await fs.rename(f.program, moved);
  const next = f.storeAt(moved);
  await next.load();
  assert.equal(next.selectedGameDirectoryId, id);
  assert.equal(next.selectedInstanceId, "fixture");
  assert.equal(next.selectedAccountId, "offline-identity");
  assert.equal(next.currentGameDirectory.path, f.bases(moved).game);
  assert.equal(
    next.gameDirectories.find((d) => d.id === "bundled").path,
    path.join(moved, "other-games", "custom"),
  );
  assert.equal(
    next.gameDirectories.find((d) => d.id === "external").path,
    external,
  );
  assert.equal(
    next.settings.javaPath,
    path.join(f.bases(moved).data, "runtime", "test-java", "bin", "java.exe"),
  );
  assert.equal(next.instances[0].javaPath, next.settings.javaPath);
  assert.equal(
    await fs.readFile(
      path.join(
        f.bases(moved).game,
        "versions",
        "fixture",
        "saves",
        "world.dat",
      ),
      "utf8",
    ),
    "world sentinel",
  );
  assert.equal(
    await fs.readFile(path.join(f.bases(moved).data, "accounts.json"), "utf8"),
    '[{"id":"offline-identity","type":"offline","name":"Steve"}]',
  );
  await assert.rejects(fs.access(f.program), /ENOENT/);
});

test("copying a portable installation selects its copy even while the original remains available", async (t) => {
  const f = await fixture(t),
    copy = path.join(f.root, "copy");
  await fs.cp(f.program, copy, { recursive: true });
  const copied = f.storeAt(copy);
  await copied.load();
  assert.equal(copied.currentGameDirectory.path, f.bases(copy).game);
  const original = f.storeAt(f.program);
  await original.load();
  assert.equal(original.currentGameDirectory.path, f.bases(f.program).game);
});

test("manual path changes override saved bindings; external Java remains explicit", async (t) => {
  const f = await fixture(t),
    b = f.bases(f.program),
    file = path.join(b.data, "launcher.json");
  const data = JSON.parse(await fs.readFile(file, "utf8"));
  const external = path.join(f.root, "chosen-game"),
    java = path.join(f.root, "chosen-jvm", "bin", "java.exe");
  data.gameDirectories[0].path = external;
  data.settings.javaPath = java;
  data.instances[0].javaPath = java;
  await fs.writeFile(file, JSON.stringify(data));
  const moved = path.join(f.root, "moved");
  await fs.rename(f.program, moved);
  const next = f.storeAt(moved);
  await next.load();
  assert.equal(next.currentGameDirectory.path, external);
  assert.equal(next.settings.javaPath, java);
  assert.equal(next.instances[0].javaPath, java);
});

test("legacy 0.7 configuration follows a real copied default folder without losing selections", async (t) => {
  const f = await fixture(t),
    file = path.join(f.bases(f.program).data, "launcher.json");
  const data = JSON.parse(await fs.readFile(file, "utf8"));
  delete data.pathBindings;
  await fs.writeFile(file, JSON.stringify(data));
  const moved = path.join(f.root, "legacy copy");
  await fs.rename(f.program, moved);
  const next = f.storeAt(moved);
  await next.load();
  assert.equal(next.currentGameDirectory.path, f.bases(moved).game);
  assert.equal(next.selectedInstanceId, "fixture");
  assert.equal(
    next.settings.javaPath,
    path.join(f.bases(moved).data, "runtime", "test-java", "bin", "java.exe"),
  );
});

test("relative bindings cannot escape their anchor or silently override an edited value", () => {
  const bases = {
    program: path.join(os.tmpdir(), "app"),
    data: path.join(os.tmpdir(), "app", "data"),
    game: path.join(os.tmpdir(), "app", "game"),
  };
  const value = path.join(bases.game, "versions", "x"),
    reference = pathReference(value, bases);
  for (const relative of [
    "../outside",
    "/absolute",
    "x/../../escape",
    "C:/outside",
    "x\\..\\outside",
    "\0bad",
  ])
    assert.equal(
      resolvePathReference(value, { ...reference, relative }, bases),
      value,
    );
  assert.equal(
    resolvePathReference(value + "-edited", reference, bases),
    value + "-edited",
  );
});

test("snapshot restoration after a second move resolves bundled Java and preserves game worlds", async (t) => {
  const f = await fixture(t);
  const features = new LauncherFeatures({
    store: f.store,
    host: {},
    emit: () => {},
  });
  const snapshot = await features.createSnapshot(
    f.store.instances[0],
    "Before move",
  );
  const moved = path.join(f.root, "move-one");
  await fs.rename(f.program, moved);
  const once = f.storeAt(moved);
  await once.load();
  await once.save();
  const twicePath = path.join(f.root, "move-two");
  await fs.rename(moved, twicePath);
  const twice = f.storeAt(twicePath);
  await twice.load();
  twice.instances[0].javaPath = "";
  twice.instances[0].gameSettings.renderDistance = 2;
  const final = new LauncherFeatures({
    store: twice,
    host: {},
    emit: () => {},
  });
  await final.restore(twice.instances[0], snapshot.id);
  assert.equal(
    twice.instances[0].javaPath,
    path.join(
      f.bases(twicePath).data,
      "runtime",
      "test-java",
      "bin",
      "java.exe",
    ),
  );
  assert.equal(twice.instances[0].gameSettings.renderDistance, 9);
  assert.equal(
    await fs.readFile(
      path.join(
        f.bases(twicePath).game,
        "versions",
        "fixture",
        "saves",
        "world.dat",
      ),
      "utf8",
    ),
    "world sentinel",
  );
});

test("all original command names are registered exactly once and prototype names are rejected", () => {
  const router = createCommandRouter({});
  assert.equal(router.size, 79);
  assert.deepEqual([...router.keys()].sort(), [...CORE_COMMANDS].sort());
  assert.equal(router.get("__proto__"), undefined);
  assert.equal(router.get("constructor"), undefined);
});

test("platform discovery follows supplied system roots and never assumes the C drive", () => {
  const program = path.join(os.tmpdir(), "custom-programs"),
    system = path.join(os.tmpdir(), "custom-os");
  const env = { ProgramFiles: program, SystemRoot: system };
  assert(
    javaSearchRoots(path.join(os.tmpdir(), "data"), os.homedir(), env).includes(
      path.join(program, "Java"),
    ),
  );
  assert.equal(
    windowsPowerShellPath(env),
    path.join(
      system,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
  );
  assert.equal(windowsPowerShellPath({}), "powershell.exe");
});
