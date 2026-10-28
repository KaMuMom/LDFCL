const { chromium } = require("playwright-core");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const AdmZip = require("adm-zip");

// Runs the real, unmodified portable wrapper against synthetic TEMP data. It
// never calls launch, downloads an update, or touches a real account/game root.
// GitHub checks are live network observations, reported separately from local
// recovery/language/UI assertions so an unavailable service cannot hide them.
(async () => {
  const project = path.resolve(__dirname, "..");
  const version = require("../package.json").version;
  const source = path.resolve(
    process.env.LDFCL_TEST_PORTABLE_EXE ||
      path.join(
        project,
        "release",
        version,
        `LDFCL-${version}-Windows-x64.exe`,
      ),
  );
  await fs.access(source);
  const output = path.join(project, "test-results");
  const reportFile = path.join(
    output,
    `${version}-recovery-updates-smoke.json`,
  );
  await fs.mkdir(output, { recursive: true });
  const workspace = await fs.mkdtemp(
    path.join(os.tmpdir(), "LDFCL-recovery-updates-qa-"),
  );
  const portableDir = path.join(workspace, "中文 空格 便携启动器");
  const chromiumDir = path.join(workspace, "隔离浏览器配置");
  const dataDir = path.join(portableDir, "LDFCL-data");
  const gameRoot = path.join(portableDir, ".minecraft");
  const executable = path.join(portableDir, path.basename(source));
  const directory = {
    id: "recovery-root",
    name: "合成旧版游戏目录",
    path: gameRoot,
    layout: "standard",
  };
  const fixtures = [
    {
      id: "old-fabric-chinese",
      name: "旧版 Fabric 自动关联",
      profile: "1.21.1-fabric-旧版",
      options: "gamma:0.7\ncustomModOption:keep\n",
      expectedLanguage: "zh_cn",
    },
    {
      id: "old-fabric-japanese",
      name: "保留原有日语设置",
      profile: "1.21.1-fabric-日本語",
      options: "lang:ja_jp\ngamma:0.6\ncustomModOption:keep\n",
      expectedLanguage: "ja_jp",
    },
  ];
  const instances = fixtures.map((item) => ({
    id: item.id,
    name: item.name,
    version: "1.21.1",
    loader: "fabric",
    loaderVersion: "0.16.14",
    createdAt: "2026-10-20T00:00:00.000Z",
    gameDirectoryId: directory.id,
    importedVersionId: item.profile,
    gameSettings: {},
  }));
  const originalFiles = new Map();
  const checks = [],
    pageErrors = [],
    screenshots = [],
    layout = [];
  const liveUpdates = {};
  let session, failure;

  async function write(file, bytes, preserve = false) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
    if (preserve) originalFiles.set(file, Buffer.from(bytes));
  }
  async function port() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const number = server.address().port;
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    return number;
  }
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const call = (run, method, payload) =>
    run.page.evaluate(
      ({ method, payload }) => window.launcher.call(method, payload),
      { method, payload },
    );
  const state = (run) => call(run, "state");

  async function start() {
    const cdpPort = await port();
    const env = { ...process.env };
    for (const key of [
      "LDFCL_DATA_DIR",
      "LDFCL_GAME_ROOT",
      "LDFCL_DEV_URL",
      "PORTABLE_EXECUTABLE_DIR",
      "PORTABLE_EXECUTABLE_FILE",
      "PORTABLE_EXECUTABLE_FILENAME",
      "PORTABLE_EXECUTABLE_APP_FILENAME",
      "ELECTRON_RUN_AS_NODE",
    ])
      delete env[key];
    const run = {
      cdpPort,
      child: null,
      browser: null,
      page: null,
      exited: false,
      exitCode: undefined,
      spawnError: null,
    };
    session = run;
    run.child = spawn(
      executable,
      [`--user-data-dir=${chromiumDir}`, `--remote-debugging-port=${cdpPort}`],
      { env, windowsHide: true, stdio: "ignore" },
    );
    run.child.once("error", (error) => {
      run.spawnError = error;
      run.exited = true;
    });
    run.child.once("exit", (code) => {
      run.exitCode = code;
      run.exited = true;
    });
    const deadline = Date.now() + 60000;
    let endpoint;
    while (Date.now() < deadline) {
      if (run.spawnError) throw run.spawnError;
      if (run.exited)
        throw Error(`Portable wrapper exited before startup: ${run.exitCode}`);
      try {
        const response = await fetch(
          `http://127.0.0.1:${cdpPort}/json/version`,
          { signal: AbortSignal.timeout(1500) },
        );
        if (response.ok) {
          endpoint = await response.json();
          break;
        }
      } catch {}
      await pause(200);
    }
    assert(
      endpoint?.webSocketDebuggerUrl,
      "Portable wrapper did not expose CDP",
    );
    run.browser = await chromium.connectOverCDP(endpoint.webSocketDebuggerUrl);
    const context = run.browser.contexts()[0];
    run.page =
      context.pages()[0] ||
      (await context.waitForEvent("page", { timeout: 60000 }));
    run.page.on("pageerror", (error) => pageErrors.push(error.message));
    await run.page.waitForFunction(
      () => typeof window.launcher?.call === "function",
      undefined,
      { timeout: 60000 },
    );
    await run.page
      .getByRole("heading", { name: "开始游戏", exact: true })
      .waitFor({ timeout: 60000 });
    await run.page.evaluate(() => {
      window.__recoveryUpdateEvents = [];
      window.launcher.onEvent((event) => {
        if (event.type === "launcher-update")
          window.__recoveryUpdateEvents.push(event.state);
      });
    });
    return run;
  }
  async function stop(run) {
    await run.page.evaluate(() => window.launcher.window("close"));
    const deadline = Date.now() + 15000;
    while (!run.exited && Date.now() < deadline) await pause(200);
    assert(run.exited, "Portable wrapper did not exit after normal close");
    assert.equal(run.exitCode, 0, "Portable wrapper exit code");
    await run.browser.close().catch(() => {});
    session = undefined;
  }
  async function kill(run) {
    if (!run || run.exited || !run.child?.pid) return;
    await new Promise((resolve) => {
      const killer = spawn(
        "taskkill",
        ["/PID", String(run.child.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" },
      );
      killer.once("exit", resolve);
      killer.once("error", resolve);
    });
  }
  async function preserved() {
    for (const [file, expected] of originalFiles)
      assert.deepEqual(
        await fs.readFile(file),
        expected,
        `Original file changed: ${path.relative(workspace, file)}`,
      );
  }
  async function registered(run, associations) {
    const current = await state(run);
    assert.equal(current.system.version, version);
    assert.equal(current.system.dataDir, dataDir);
    assert.equal(current.system.gameRoot, gameRoot);
    assert.equal(current.system.defaultGameRoot, gameRoot);
    assert.equal(current.system.gameDirectoryError, undefined);
    assert.deepEqual(current.system.gameDirectoryWarnings || [], []);
    assert.equal(
      current.instances.length,
      fixtures.length,
      "A source profile was imported a second time",
    );
    assert.deepEqual(
      current.instances.map((item) => item.id).sort(),
      fixtures.map((item) => item.id).sort(),
    );
    const persisted = JSON.parse(
      await fs.readFile(path.join(dataDir, "launcher.json"), "utf8"),
    );
    for (const fixture of fixtures) {
      const item = current.instances.find((entry) => entry.id === fixture.id);
      assert(
        item.versionDirectory,
        "Explicit import record must automatically recover its version association",
      );
      assert.equal(item.importedVersionId, fixture.profile);
      if (associations)
        assert.equal(item.versionDirectory, associations[fixture.id]);
      assert.equal(
        persisted.instances.find((entry) => entry.id === fixture.id)
          .versionDirectory,
        item.versionDirectory,
      );
      const target = path.join(gameRoot, "versions", item.versionDirectory);
      const marker = JSON.parse(
        await fs.readFile(
          path.join(target, ".ldfcl", "directory-migration.json"),
          "utf8",
        ),
      );
      assert.equal(marker.completed, true);
      assert.equal(marker.instanceId, fixture.id);
      assert.equal(marker.sourceVersion, fixture.profile);
      for (const relative of [
        path.join("mods", "fixture.jar"),
        path.join("saves", "World", "level.dat"),
      ]) {
        assert.deepEqual(
          await fs.readFile(path.join(target, relative)),
          originalFiles.get(
            path.join(gameRoot, "instances", fixture.id, relative),
          ),
        );
      }
    }
    await preserved();
    return current;
  }
  async function screenshot(run, name) {
    const file = path.join(output, `${version}-recovery-updates-${name}.png`);
    await run.page.evaluate(() => document.fonts.ready);
    await run.page.screenshot({ path: file });
    screenshots.push(file);
  }
  async function size(run, width, height) {
    // Electron's CDP endpoint does not expose Chromium's Browser window domain.
    // Match only this run's unique debugging port; never resize another LDFCL
    // session by title. SetWindowPos changes the real window, not emulation.
    const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class LdfclQaWindow { [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint flags); }'
$Candidates = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('--remote-debugging-port=${run.cdpPort}') } | ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } | Where-Object { $_.MainWindowHandle -ne 0 })
if ($Candidates.Count -ne 1) { throw 'Could not uniquely identify the isolated portable test window' }
if (-not [LdfclQaWindow]::SetWindowPos($Candidates[0].MainWindowHandle, [IntPtr]::Zero, 0, 0, ${width}, ${height}, 22)) { throw 'SetWindowPos failed' }
`;
    await new Promise((resolve, reject) => {
      const helper = spawn(
        path.join(
          process.env.SystemRoot || "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
        [
          "-NoProfile",
          "-NonInteractive",
          "-WindowStyle",
          "Hidden",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      helper.stdout.on("data", (bytes) => {
        output += bytes.toString();
      });
      helper.stderr.on("data", (bytes) => {
        output += bytes.toString();
      });
      helper.once("error", reject);
      helper.once("exit", (code) =>
        code === 0
          ? resolve()
          : reject(Error(`Isolated test-window resize failed: ${output}`)),
      );
    });
    await run.page.waitForFunction(
      ({ width, height }) =>
        Math.abs(innerWidth - width) <= 2 &&
        Math.abs(innerHeight - height) <= 2,
      { width, height },
    );
  }
  async function updateLayout(run, name) {
    const panel = run.page.locator(".launcher-update-panel");
    await panel.scrollIntoViewIfNeeded();
    const result = await panel.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const buttons = [...element.querySelectorAll("button")].map((button) => {
        const r = button.getBoundingClientRect();
        return {
          name: button.textContent.trim(),
          x: r.x,
          y: r.y,
          right: r.right,
          bottom: r.bottom,
        };
      });
      return {
        width: innerWidth,
        height: innerHeight,
        documentWidth: document.documentElement.scrollWidth,
        panel: { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom },
        buttons,
      };
    });
    assert(
      result.documentWidth <= result.width + 1,
      "Settings page has horizontal overflow",
    );
    assert(
      result.panel.x >= -1 && result.panel.right <= result.width + 1,
      "Update card is clipped horizontally",
    );
    for (const button of result.buttons) {
      assert(
        button.x >= result.panel.x - 1 &&
          button.right <= result.panel.right + 1,
        `Update button outside its card: ${button.name}`,
      );
      assert(
        button.y >= 0 && button.bottom <= result.height + 1,
        `Update button is not reachable: ${button.name}`,
      );
    }
    layout.push({ name, ...result });
    await screenshot(run, name);
  }
  async function waitUpdate(run, previousCheckedAt, automatic) {
    const deadline = Date.now() + 55000;
    let current;
    while (Date.now() < deadline) {
      current = await call(run, "update:state");
      if (
        current.status === "error" ||
        (current.checkedAt &&
          (automatic || current.checkedAt !== previousCheckedAt) &&
          current.status !== "checking")
      )
        break;
      await pause(250);
    }
    assert.equal(current.currentVersion, version);
    assert.equal(
      current.supported,
      true,
      "Real portable wrapper must support in-app updates",
    );
    if (
      current.checkedAt &&
      current.status !== "checking" &&
      current.status !== "error"
    ) {
      assert(
        !Number.isNaN(Date.parse(current.checkedAt)),
        "Update checkedAt must be an ISO date",
      );
      assert.equal(
        current.status,
        "current",
        "The not-yet-published build must not offer an older release as an update",
      );
      assert.equal(current.hasUpdate, false);
      assert(current.latestVersion);
      return { passed: true, live: true, state: current };
    }
    return {
      passed: false,
      live: true,
      state: current,
      boundary:
        "Live GitHub check unavailable or timed out; local packaged UI/recovery checks are independent.",
    };
  }

  try {
    await fs.mkdir(portableDir, { recursive: true });
    await fs.mkdir(chromiumDir, { recursive: true });
    await fs.copyFile(source, executable);
    await write(
      path.join(dataDir, "launcher.json"),
      JSON.stringify(
        {
          instances,
          gameDirectories: [directory],
          selectedGameDirectoryId: directory.id,
          selectedInstanceId: fixtures[0].id,
          selectedInstancesByDirectory: { [directory.id]: fixtures[0].id },
          settings: {
            gameDefaults: {},
            downloadConcurrency: 2,
            memoryMode: "manual",
            memoryMb: 1024,
            closeOnLaunch: false,
          },
        },
        null,
        2,
      ),
    );
    const mod = new AdmZip();
    mod.addFile(
      "fabric.mod.json",
      Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          id: "recovery_fixture",
          name: "Synthetic Recovery Fixture",
          version: "1.0.0",
        }),
      ),
    );
    const client = new AdmZip();
    client.addFile(
      "SYNTHETIC-NOT-A-REAL-GAME.txt",
      Buffer.from("Never launch this fixture"),
    );
    for (const fixture of fixtures) {
      const profile = path.join(gameRoot, "versions", fixture.profile);
      await write(
        path.join(profile, fixture.profile + ".json"),
        JSON.stringify({
          id: fixture.profile,
          minecraftVersion: "1.21.1",
          clientVersion: "1.21.1",
          mainClass: "net.fabricmc.loader.impl.launch.knot.KnotClient",
          type: "release",
          libraries: [{ name: "net.fabricmc:fabric-loader:0.16.14" }],
        }),
        true,
      );
      await write(
        path.join(profile, fixture.profile + ".jar"),
        client.toBuffer(),
        true,
      );
      const old = path.join(gameRoot, "instances", fixture.id);
      await write(path.join(old, "mods", "fixture.jar"), mod.toBuffer(), true);
      await write(
        path.join(old, "saves", "World", "level.dat"),
        Buffer.from(`Synthetic world to preserve: ${fixture.id}`),
        true,
      );
      await write(
        path.join(old, "options.txt"),
        Buffer.from(fixture.options),
        true,
      );
      await assert.rejects(fs.access(path.join(old, ".ldfcl", "launch.json")), {
        code: "ENOENT",
      });
    }
    let run = await start();
    let current = await registered(run);
    const associations = Object.fromEntries(
      current.instances.map((item) => [item.id, item.versionDirectory]),
    );
    checks.push(
      "Real portable startup automatically associates two legacy Fabric instances using explicit importedVersionId despite absent launch.json; persists associations without warnings or duplicate imports",
    );
    await size(run, 1120, 760);
    await screenshot(run, "home-1120x760");
    for (const fixture of fixtures) {
      await call(run, "instance:save", {
        id: fixture.id,
        gameSettings: {},
        replaceGameSettings: true,
      });
      const file = path.join(
        gameRoot,
        "versions",
        associations[fixture.id],
        "options.txt",
      );
      const options = await fs.readFile(file, "utf8");
      assert.equal(
        options.match(/^lang:(.*)$/m)?.[1],
        fixture.expectedLanguage,
      );
      assert.match(options, /^customModOption:keep$/m);
    }
    checks.push(
      "Real preload instance:save applies zh_cn when language is absent and preserves an existing ja_jp preference; other option fields remain intact",
    );
    current = await registered(run, associations);
    assert.deepEqual(current.runningInstanceIds || [], []);
    const initialUpdate = await call(run, "update:state");
    assert.equal(initialUpdate.currentVersion, version);
    assert.equal(initialUpdate.supported, true);
    liveUpdates.automatic = await waitUpdate(run, undefined, true);
    liveUpdates.automatic.events = await run.page.evaluate(
      () => window.__recoveryUpdateEvents,
    );
    checks.push(
      "Real wrapper update:state exposes the packaged current version and supported=true; startup's automatic update check is observed without issuing update:check",
    );
    await run.page
      .getByRole("button", { name: "启动器设置", exact: true })
      .click();
    const panel = run.page.locator(".launcher-update-panel");
    await panel.waitFor();
    await panel
      .getByText(`当前版本 ${version} · 启动时自动检查 GitHub Latest`, {
        exact: true,
      })
      .waitFor();
    const checkButton = panel.getByRole("button", {
      name: "检查更新",
      exact: true,
    });
    await checkButton.waitFor();
    await checkButton.waitFor({ state: "visible" });
    const beforeManual = await call(run, "update:state");
    await checkButton.click({ timeout: 15000 });
    liveUpdates.manual = await waitUpdate(run, beforeManual.checkedAt, false);
    checks.push(
      "Settings page renders the automatic-update card and its real manual-check button; both use the protected preload/main updater",
    );
    await updateLayout(run, "settings-1120x760");
    await size(run, 960, 640);
    await updateLayout(run, "settings-960x640");
    checks.push(
      "Update card, version text and action buttons fit both actual 1120x760 and 960x640 windows without horizontal overflow",
    );
    const versionFolders = (
      await fs.readdir(path.join(gameRoot, "versions"))
    ).sort();
    await stop(run);
    run = await start();
    current = await registered(run, associations);
    assert.deepEqual(
      (await fs.readdir(path.join(gameRoot, "versions"))).sort(),
      versionFolders,
      "Restart created another recovery copy",
    );
    for (const fixture of fixtures) {
      const options = await fs.readFile(
        path.join(
          gameRoot,
          "versions",
          associations[fixture.id],
          "options.txt",
        ),
        "utf8",
      );
      assert.equal(
        options.match(/^lang:(.*)$/m)?.[1],
        fixture.expectedLanguage,
      );
    }
    assert.deepEqual(current.runningInstanceIds || [], []);
    await stop(run);
    checks.push(
      "Second real portable startup reuses the same persisted instance IDs and directories; no duplicate import/copy, preserved mods/worlds/original files, and language choices persist",
    );
    assert.deepEqual(pageErrors, []);
    checks.push(
      "Both portable sessions close normally with exit code 0 and no renderer pageerror; no real game or updater installer was started",
    );
  } catch (error) {
    failure = error;
    if (session?.page) await screenshot(session, "failure").catch(() => {});
  } finally {
    if (session) {
      await kill(session);
      await session.browser?.close().catch(() => {});
    }
    const report = {
      passed: !failure,
      version,
      portable: true,
      executable: source,
      executableSha256: createHash("sha256")
        .update(await fs.readFile(source))
        .digest("hex"),
      checks,
      screenshots,
      layout,
      liveUpdates,
      pageErrors,
      gameLaunched: false,
      updateDownloaded: false,
      updateInstalled: false,
      fixtureScope:
        "Synthetic TEMP game files and EXE-side data only; real user files and accounts were not used.",
      error: failure
        ? { message: failure.message, stack: failure.stack }
        : undefined,
    };
    await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + "\n");
    console.log(
      JSON.stringify({
        passed: report.passed,
        checks: checks.length,
        report: reportFile,
        liveAutomatic: liveUpdates.automatic?.passed,
        liveManual: liveUpdates.manual?.passed,
        screenshots,
      }),
    );
    assert.equal(path.dirname(workspace), path.resolve(os.tmpdir()));
    assert(path.basename(workspace).startsWith("LDFCL-recovery-updates-qa-"));
    await fs.rm(workspace, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  }
  if (failure) throw failure;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
