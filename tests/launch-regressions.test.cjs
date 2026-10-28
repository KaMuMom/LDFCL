const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createLauncherCore } = require("@ldfcl/core/launcher");
const { GameService } = require("@ldfcl/core/services/game");
const { LauncherFeatures } = require("@ldfcl/core/features");
const { Store } = require("@ldfcl/core/store");
const { HealthScanner } = require("@ldfcl/core/services/health");

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
async function fixture(t, loader = "vanilla") {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "LDFCL-launch-regression-"),
  );
  const gameRoot = path.join(root, ".minecraft");
  const id = loader === "vanilla" ? "1.21.1" : loader + "-1.21.1";
  const dir = path.join(gameRoot, "versions", id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, id + ".json"),
    JSON.stringify({
      id,
      mainClass:
        loader === "fabric"
          ? "net.fabricmc.loader.impl.launch.knot.KnotClient"
          : "net.minecraft.client.main.Main",
      javaVersion: { majorVersion: 21 },
      libraries: [],
      minecraftVersion: "1.21.1",
    }),
  );
  const events = [];
  const core = await createLauncherCore({
    dataDir: path.join(root, "data"),
    defaultGameRoot: gameRoot,
    host,
    emit: (event) => events.push(event),
  });
  t.after(async () => {
    core.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  const instance = (await core.state()).instances[0];
  const account = await core.call("account:offline", { name: "Regression" });
  return { root, gameRoot, dir, instance, account, core, events };
}
function healthyScanner(root) {
  return new HealthScanner({
    minecraftRoot: root,
    java: {
      inspect: async () => null,
      discover: async () => [
        { major: 21, architecture: process.arch, path: "fixture-java" },
      ],
    },
    totalMemoryMb: () => 8192,
    freeMemoryMb: () => 4096,
  });
}

test("vanilla and empty loader instances stay healthy with absent or empty mods and harmless historical logs", async (t) => {
  for (const loader of ["vanilla", "fabric", "forge", "neoforge", "quilt"]) {
    const f = await fixture(t, loader);
    const scanner = healthyScanner(f.gameRoot);
    for (const directoryPresent of [false, true]) {
      if (directoryPresent)
        await fs.mkdir(path.join(f.dir, "mods"), { recursive: true });
      else
        await fs.rm(path.join(f.dir, "mods"), { recursive: true, force: true });
      await fs.mkdir(path.join(f.dir, "logs"), { recursive: true });
      await fs.writeFile(
        path.join(f.dir, "logs", "latest.log"),
        "[Render thread/WARN]: Optional support was not found\n[ERROR] A recoverable resource warning\n",
      );
      const report = await scanner.scan(
        { ...f.instance, loader },
        {
          memoryMode: "manual",
          memoryMb: 4096,
          javaPath: "",
        },
      );
      assert.equal(
        report.status,
        "healthy",
        loader + " empty=" + directoryPresent,
      );
      assert.equal(report.score, 100);
      assert.equal(
        report.issues.find((issue) => issue.id === "logs:historical").severity,
        "info",
      );
      assert.ok(
        !report.issues.some((issue) => issue.category === "dependency"),
      );
    }
  }
});

test("full launch preparation accepts missing mods; saving the launch record after spawn cannot report a failed launch", async (t) => {
  const f = await fixture(t, "fabric");
  await fs.rm(path.join(f.dir, "mods"), { recursive: true, force: true });
  let spawned = false;
  const save = Store.prototype.save;
  t.mock.method(Store.prototype, "save", function (...args) {
    if (spawned)
      return Promise.reject(new Error("controlled record write failure"));
    return save.apply(this, args);
  });
  t.mock.method(GameService.prototype, "launch", async function (instance) {
    spawned = true;
    this.emit({
      type: "game",
      status: "started",
      instanceId: instance.id,
      pid: 12345,
    });
    return { pid: 12345 };
  });
  const result = await f.core.call("launch", {
    instanceId: f.instance.id,
    accountId: f.account.id,
  });
  assert.equal(result.pid, 12345);
  assert.equal(result.running, true);
  assert.match(result.warnings.join(" "), /启动记录未能保存/);
  assert.deepEqual((await f.core.state()).runningInstanceIds, [f.instance.id]);
  assert.ok(
    !f.events.some(
      (event) => event.type === "game" && event.status === "error",
    ),
  );
  assert.ok((await fs.stat(path.join(f.dir, "options.txt"))).isFile());
});

test("optional health report failure does not block launch, but a real spawn failure still rejects", async (t) => {
  const f = await fixture(t);
  t.mock.method(LauncherFeatures.prototype, "scan", async () => {
    throw new Error("controlled health report write failure");
  });
  t.mock.method(GameService.prototype, "launch", async function (instance) {
    this.emit({
      type: "game",
      status: "started",
      instanceId: instance.id,
      pid: 123,
    });
    return { pid: 123 };
  });
  const result = await f.core.call("launch", {
    instanceId: f.instance.id,
    accountId: f.account.id,
  });
  assert.equal(result.running, true);
  assert.match(result.warnings.join(" "), /健康报告/);
  await f.core.call("stop", { id: f.instance.id });
  t.mock.method(GameService.prototype, "launch", async function (instance) {
    this.emit({ type: "game", status: "error", instanceId: instance.id });
    throw new Error("actual spawn failure");
  });
  await assert.rejects(
    f.core.call("launch", {
      instanceId: f.instance.id,
      accountId: f.account.id,
    }),
    /actual spawn failure/,
  );
});

test("a process that exits before launch metadata is saved is not resurrected as running", async (t) => {
  const f = await fixture(t);
  t.mock.method(GameService.prototype, "launch", async function (instance) {
    this.emit({
      type: "game",
      status: "started",
      instanceId: instance.id,
      pid: 123,
    });
    this.emit({
      type: "game",
      status: "exited",
      instanceId: instance.id,
      exitCode: 0,
    });
    return { pid: 123 };
  });
  const result = await f.core.call("launch", {
    instanceId: f.instance.id,
    accountId: f.account.id,
  });
  assert.equal(result.running, false);
  assert.deepEqual((await f.core.state()).runningInstanceIds, []);
});
