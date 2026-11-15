"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const { chromium } = require("playwright-core");
const AdmZip = require("adm-zip");
const { isolateDesktop } = require("./helpers/isolated-desktop.cjs");
const project = path.resolve(__dirname, "..");
const version = require("../package.json").version;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = {
  passed: false,
  version,
  checks: [],
  pageErrors: [],
  runs: [],
  realAccountsUsed: false,
  gameLaunched: false,
};
let workspace, session;
async function port() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}
async function start(program, cwd) {
  const inspectorPort = await port(),
    cdpPort = await port();
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (
      key.startsWith("LDFCL_") ||
      key.startsWith("PORTABLE_EXECUTABLE_") ||
      ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_PATH"].includes(key)
    )
      delete env[key];
  const run = { program, cwd, exited: false, stderr: "" };
  report.runs.push({ program, cwd });
  session = run;
  run.child = spawn(
    path.join(program, report.executable.name),
    [
      `--inspect-brk=127.0.0.1:${inspectorPort}`,
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${path.join(workspace, "isolated-browser")}`,
    ],
    { cwd, env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
  );
  run.child.stderr.on("data", (bytes) => {
    run.stderr = (run.stderr + bytes.toString()).slice(-16000);
  });
  run.child.once("exit", (code) => {
    run.exited = true;
    run.exitCode = code;
  });
  run.child.once("error", (error) => {
    run.error = error;
    run.exited = true;
  });
  await isolateDesktop(inspectorPort, path.join(workspace, "isolated-desktop"));
  const deadline = Date.now() + 60000;
  let endpoint;
  while (Date.now() < deadline) {
    if (run.exited)
      throw (
        run.error || Error(`Portable exited ${run.exitCode}: ${run.stderr}`)
      );
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, {
        signal: AbortSignal.timeout(1000),
      });
      endpoint = (await response.json()).webSocketDebuggerUrl;
      if (endpoint) break;
    } catch {}
    await pause(150);
  }
  assert(endpoint, "Portable renderer did not become available");
  run.browser = await chromium.connectOverCDP(endpoint);
  const context = run.browser.contexts()[0];
  run.page = context.pages()[0] || (await context.waitForEvent("page"));
  run.page.on("pageerror", (e) => report.pageErrors.push(e.message));
  await run.page
    .getByRole("heading", { name: "开始游戏", exact: true })
    .waitFor({ timeout: 60000 });
  return run;
}
const call = (run, method, payload) =>
  run.page.evaluate(
    ({ method, payload }) => window.launcher.call(method, payload),
    { method, payload },
  );
async function stop(run) {
  await run.page.evaluate(() => window.launcher.window("close"));
  const deadline = Date.now() + 15000;
  while (!run.exited && Date.now() < deadline) await pause(100);
  assert(run.exited, "Portable did not close normally");
  assert.equal(run.exitCode, 0);
  await run.browser.close().catch(() => {});
  session = undefined;
}
async function write(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data);
}
async function seed(root, id) {
  const directory = path.join(root, "versions", id);
  const jar = new AdmZip();
  jar.addFile(
    "fixture.txt",
    Buffer.from("synthetic relocation fixture; never launched"),
  );
  await write(
    path.join(directory, `${id}.json`),
    JSON.stringify({
      id,
      type: "release",
      mainClass: "net.minecraft.client.main.Main",
      arguments: { game: [] },
      libraries: [],
    }),
  );
  await write(path.join(directory, `${id}.jar`), jar.toBuffer());
  await write(
    path.join(directory, "saves", "World", "level.dat"),
    Buffer.from("relocation-world-sentinel-\x00\xff", "latin1"),
  );
  await write(
    path.join(directory, "options.txt"),
    "lang:zh_cn\nrenderDistance:9\ncustomModOption:keep\n",
  );
}
async function main() {
  const source = path.resolve(
    process.env.LDFCL_TEST_PORTABLE_EXE ||
      path.join(
        project,
        "release",
        version,
        `LDFCL-${version}-Windows-x64.exe`,
      ),
  );
  const executable = await fs.readFile(source);
  report.executable = {
    name: path.basename(source),
    sha256: sha(executable),
    bytes: executable.length,
  };
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "LDFCL-relocation-"));
  report.temporaryRoot = workspace;
  const locations = [
    "原位置 中文 空格",
    "新位置 搬迁一次",
    "另一个位置 再次搬迁",
  ].map((name) => path.join(workspace, name));
  const cwdA = path.join(workspace, "unrelated-cwd-A"),
    cwdB = path.join(workspace, "unrelated-cwd-B");
  await fs.mkdir(cwdA);
  await fs.mkdir(cwdB);
  const external = path.join(workspace, "外部游戏文件夹");
  const bundled = path.join("other-games", "随程序游戏");
  await seed(path.join(locations[0], ".minecraft"), "1.21.1");
  await seed(path.join(locations[0], bundled), "1.20.1");
  await seed(external, "1.19.4");
  await fs.writeFile(
    path.join(locations[0], report.executable.name),
    executable,
  );
  const globalJava = path.join("portable-java", "bin", "java.exe");
  const instanceJava = path.join(
    "LDFCL-data",
    "runtime",
    "fixture-java",
    "bin",
    "java.exe",
  );
  await write(path.join(locations[0], globalJava), "not executed by this test");
  await write(
    path.join(locations[0], instanceJava),
    "not executed by this test",
  );
  const worldRelative = path.join(
    ".minecraft",
    "versions",
    "1.21.1",
    "saves",
    "World",
    "level.dat",
  );
  const world = await fs.readFile(path.join(locations[0], worldRelative));
  let run = await start(locations[0], cwdA);
  let current = await call(run, "state");
  assert.equal(current.system.dataDir, path.join(locations[0], "LDFCL-data"));
  assert.equal(current.system.gameRoot, path.join(locations[0], ".minecraft"));
  assert.equal(current.accounts.length, 0);
  assert.equal(current.instances.length, 1);
  const defaultId = current.selectedGameDirectoryId,
    instanceId = current.instances[0].id;
  const account = await call(run, "account:offline", { name: "RelocateQA" });
  await call(run, "settings", {
    javaPath: path.join(locations[0], globalJava),
    theme: "dark",
    gameDefaults: { lang: "zh_cn", maxFps: 90 },
  });
  await call(run, "instance:save", {
    id: instanceId,
    name: "搬迁验证实例",
    javaPath: path.join(locations[0], instanceJava),
    gameSettings: { lang: "zh_cn", renderDistance: 7 },
  });
  const skinData = `data:image/png;base64,${(await fs.readFile(path.join(project, "public", "skins", "steve.png"))).toString("base64")}`;
  await call(run, "skin-library:save", {
    name: "搬迁皮肤",
    variant: "classic",
    dataUrl: skinData,
  });
  await call(run, "mod-favorites:set", {
    project: {
      projectId: "fixture-mod",
      slug: "fixture-mod",
      title: "搬迁收藏",
    },
    saved: true,
  });
  current = await call(run, "game-directory:add", { path: external });
  const externalId = current.selectedGameDirectoryId;
  current = await call(run, "game-directory:add", {
    path: path.join(locations[0], bundled),
  });
  const bundledId = current.selectedGameDirectoryId;
  await call(run, "game-directory:select", { id: defaultId });
  await call(run, "select", { instanceId, accountId: account.id });
  const favorites = await call(run, "mod-favorites:list");
  const skins = await call(run, "skin-library:list");
  await stop(run);
  const preservedFiles = ["accounts.json", "mod-favorites.json"];
  const before = new Map(
    await Promise.all(
      preservedFiles.map(async (file) => [
        file,
        await fs.readFile(path.join(locations[0], "LDFCL-data", file)),
      ]),
    ),
  );
  report.checks.push(
    "Unmodified EXE starts from an unrelated cwd; defaults are beside the outer portable EXE and original UI/IPC saves real fixture records",
  );
  for (let index = 1; index < locations.length; index++) {
    const previous = locations[index - 1],
      destination = locations[index];
    assert(
      path.dirname(previous) === workspace &&
        path.dirname(destination) === workspace,
    );
    await fs.rename(previous, destination);
    run = await start(destination, index === 1 ? cwdB : cwdA);
    current = await call(run, "state");
    assert.equal(current.system.version, version);
    assert.equal(current.system.dataDir, path.join(destination, "LDFCL-data"));
    assert.equal(current.system.gameRoot, path.join(destination, ".minecraft"));
    assert.equal(current.system.gameDirectoryError, undefined);
    assert.equal(current.selectedGameDirectoryId, defaultId);
    assert.equal(current.selectedInstanceId, instanceId);
    assert.equal(current.selectedAccountId, account.id);
    assert.equal(current.accounts[0].name, "RelocateQA");
    assert.equal(current.settings.javaPath, path.join(destination, globalJava));
    assert.equal(current.settings.theme, "dark");
    assert.equal(current.settings.gameDefaults.maxFps, 90);
    const instance = current.instances.find((item) => item.id === instanceId);
    assert.equal(instance.name, "搬迁验证实例");
    assert.equal(instance.javaPath, path.join(destination, instanceJava));
    assert.equal(instance.gameSettings.renderDistance, 7);
    assert.equal(
      current.gameDirectories.find((d) => d.id === bundledId).path,
      path.join(destination, bundled),
    );
    assert.equal(
      current.gameDirectories.find((d) => d.id === externalId).path,
      external,
    );
    assert.deepEqual(await call(run, "mod-favorites:list"), favorites);
    assert.deepEqual(await call(run, "skin-library:list"), skins);
    assert.deepEqual(
      await fs.readFile(path.join(destination, worldRelative)),
      world,
    );
    assert.match(
      await fs.readFile(
        path.join(
          destination,
          ".minecraft",
          "versions",
          "1.21.1",
          "options.txt",
        ),
        "utf8",
      ),
      /customModOption:keep/,
    );
    for (const [file, bytes] of before)
      assert.deepEqual(
        await fs.readFile(path.join(destination, "LDFCL-data", file)),
        bytes,
      );
    current = await call(run, "game-directory:select", { id: bundledId });
    assert.equal(current.system.gameRoot, path.join(destination, bundled));
    assert.equal(current.instances.length, 1);
    current = await call(run, "game-directory:select", { id: externalId });
    assert.equal(current.system.gameRoot, external);
    assert.equal(current.instances.length, 1);
    await call(run, "game-directory:select", { id: defaultId });
    await run.page.screenshot({
      path: path.join(
        project,
        "test-results",
        `portable-relocation-${index}.png`,
      ),
    });
    await stop(run);
    await assert.rejects(fs.access(previous), /ENOENT/);
    assert.equal(
      sha(await fs.readFile(path.join(destination, report.executable.name))),
      report.executable.sha256,
    );
    report.checks.push(
      `Move ${index}: stable account/instance/directory IDs, Java paths, library PNGs, favorites, settings and byte-identical world; bundled/external directories switch correctly; old location stays absent`,
    );
  }
  assert.deepEqual(await fs.readdir(cwdA), []);
  assert.deepEqual(await fs.readdir(cwdB), []);
  assert.deepEqual(report.pageErrors, []);
  report.checks.push(
    "Three clean startups/normal closes; neither unrelated cwd receives files; no renderer errors, no real credentials or games",
  );
  report.passed = true;
}
main()
  .catch((error) => {
    report.error = error.stack;
    process.exitCode = 1;
  })
  .finally(async () => {
    if (session?.child?.pid && !session.exited) {
      const target = session.child.pid;
      await new Promise((resolve) => {
        const child = spawn("taskkill", ["/PID", String(target), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        child.once("exit", resolve);
        child.once("error", resolve);
      });
    }
    report.finishedAt = new Date().toISOString();
    const file = path.join(
      project,
      "test-results",
      "portable-relocation-smoke.json",
    );
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  });
