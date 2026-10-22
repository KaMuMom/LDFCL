const { _electron: electron } = require("playwright-core");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");

// Intercept the core only inside a synthetic Electron entrypoint. Production
// startup has no delay/failure switches, and every writable path stays in TEMP.
(async () => {
  const project = path.resolve(__dirname, "..");
  let main = path.resolve(
    process.env.LDFCL_TEST_STARTUP_MAIN ||
      path.join(project, "dist-electron/electron/main.js"),
  );
  const workspace = await fs.mkdtemp(
    path.join(os.tmpdir(), "LDFCL-startup-qa-"),
  );
  let productionSourceArchive;
  if (process.env.LDFCL_TEST_STARTUP_ASAR) {
    const archive = path.resolve(process.env.LDFCL_TEST_STARTUP_ASAR),
      extracted = path.join(workspace, "packaged-source"),
      asar = require("@electron/asar"),
      sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
    await fs.mkdir(extracted, { recursive: true });
    asar.extractAll(archive, extracted);
    const files = [];
    for (const relative of [
      "dist-electron/electron/main.js",
      "dist-electron/electron/preload.js",
      "node_modules/@ldfcl/core/dist/core/launcher.js",
      "dist/index.html",
    ]) {
      const original = asar.extractFile(archive, path.normalize(relative)),
        materialized = await fs.readFile(path.join(extracted, relative));
      assert.deepEqual(
        materialized,
        original,
        `production archive bytes: ${relative}`,
      );
      files.push({ path: relative, sha256: sha256(original) });
    }
    main = path.join(extracted, "dist-electron/electron/main.js");
    productionSourceArchive = {
      path: archive,
      sha256: sha256(await fs.readFile(archive)),
      verifiedFiles: files,
      note: "Controlled scenarios run unchanged extracted production sources in the development Electron runtime; direct packaged-EXE checks are separate.",
    };
  }
  const checks = [],
    pageErrors = [],
    scenarios = [];
  let active;

  async function launch(mode) {
    const directory = path.join(workspace, mode),
      harness = path.join(directory, "harness"),
      dataDir = path.join(directory, "data"),
      gate = path.join(directory, "release-core"),
      started = path.join(directory, "core-started");
    await fs.mkdir(harness, { recursive: true });
    await fs.writeFile(
      path.join(harness, "package.json"),
      JSON.stringify({
        name: "ldfcl-startup-regression",
        version: "1.0.0",
        main: "bootstrap.cjs",
      }),
    );
    await fs.writeFile(
      path.join(harness, "bootstrap.cjs"),
      `
      const fs = require('node:fs');
      const Module = require('node:module');
      const mode = ${JSON.stringify(mode)};
      const gate = ${JSON.stringify(gate)};
      const started = ${JSON.stringify(started)};
      let calls = 0;
      const originalLoad = Module._load;
      Module._load = function(request, parent, isMain) {
        const exports = originalLoad.call(this, request, parent, isMain);
        if (request !== '@ldfcl/core/launcher') return exports;
        return { ...exports, createLauncherCore: async function(options) {
          calls++;
          fs.writeFileSync(started, String(calls));
          const deadline = Date.now() + 30000;
          while (!fs.existsSync(gate)) {
            if (Date.now() >= deadline) throw Error('Controlled core gate timed out');
            await new Promise(resolve => setTimeout(resolve, 25));
          }
          if (mode === 'core-failure' && calls === 1)
            throw Error('Controlled core initialization failure');
          return exports.createLauncherCore(options);
        }};
      };
      if (mode === 'renderer-failure') {
        const { BrowserWindow } = require('electron');
        const original = BrowserWindow.prototype.loadFile;
        let failed = false;
        BrowserWindow.prototype.loadFile = function(...args) {
          if (!failed) { failed = true; return Promise.reject(Error('Controlled renderer load failure')); }
          return original.apply(this, args);
        };
      }
      require(${JSON.stringify(main)});
    `,
    );
    const env = {
      ...process.env,
      LDFCL_DATA_DIR: dataDir,
      LDFCL_GAME_ROOT: path.join(directory, ".minecraft"),
    };
    for (const key of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "LDFCL_DEV_URL"])
      delete env[key];
    active = await electron.launch({
      executablePath: require("electron"),
      args: [
        harness,
        `--user-data-dir=${path.join(directory, "electron-profile")}`,
      ],
      env,
      timeout: 30000,
    });
    const page = await active.firstWindow({ timeout: 15000 });
    page.on("pageerror", (error) =>
      pageErrors.push(`${mode}: ${error.message}`),
    );
    await page
      .getByRole("heading", { name: "正在启动 LDFCL", exact: true })
      .waitFor({ timeout: 15000 });
    await page
      .getByRole("button", { name: "关闭启动器", exact: true })
      .waitFor();
    await page.waitForFunction(
      () => typeof window.launcher?.call === "function",
    );
    const initializationDeadline = Date.now() + 10000;
    while (true) {
      try {
        await fs.access(started);
        break;
      } catch (error) {
        if (error.code !== "ENOENT" || Date.now() >= initializationDeadline)
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    await assert.rejects(fs.access(gate), { code: "ENOENT" });
    await assert.rejects(fs.access(path.join(dataDir, "launcher.json")), {
      code: "ENOENT",
    });
    const visible = await active.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const preferences = window.webContents.getLastWebPreferences();
      return {
        visible: window.isVisible(),
        sandbox: preferences.sandbox,
        contextIsolation: preferences.contextIsolation,
        nodeIntegration: preferences.nodeIntegration,
      };
    });
    assert.deepEqual(visible, {
      visible: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    });
    const electronVersion = await active.evaluate(
      () => process.versions.electron,
    );
    scenarios.push({ mode, visibleBeforeCoreReady: true, electronVersion });
    return { app: active, page, gate, started, dataDir };
  }
  async function finish(run) {
    await run.app.close();
    active = undefined;
  }
  async function assertHome(run) {
    await run.page
      .getByRole("heading", { name: "开始游戏", exact: true })
      .waitFor({ timeout: 30000 });
    const state = await run.page.evaluate(() => window.launcher.call("state"));
    assert.equal(state.system.dataDir, run.dataDir);
    assert.equal(state.instances.length, 0);
    assert.equal(state.accounts.length, 0);
    assert.equal(
      await run.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isVisible(),
      ),
      true,
    );
  }
  try {
    let run = await launch("slow-core");
    await fs.writeFile(run.gate, "release");
    await assertHome(run);
    checks.push(
      "controlled pending core leaves a visible, sandboxed loading window; released core reaches the real homepage and working state IPC",
    );
    await finish(run);

    run = await launch("core-failure");
    await fs.writeFile(run.gate, "release");
    await run.page
      .getByRole("heading", { name: "启动失败", exact: true })
      .waitFor();
    await run.page
      .getByRole("alert")
      .filter({ hasText: "Controlled core initialization failure" })
      .waitFor();
    assert.equal(
      await run.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isVisible(),
      ),
      true,
    );
    await run.page.getByText("诊断信息", { exact: true }).click();
    await run.page.locator("pre").filter({ hasText: run.dataDir }).waitFor();
    await run.page.getByRole("button", { name: "重试", exact: true }).click();
    await assertHome(run);
    assert.equal(await fs.readFile(run.started, "utf8"), "2");
    checks.push(
      "controlled core rejection shows a visible error and local diagnostics; Retry initializes the core again and reaches the real homepage",
    );
    await finish(run);

    run = await launch("renderer-failure");
    await fs.writeFile(run.gate, "release");
    await run.page
      .getByRole("heading", { name: "启动失败", exact: true })
      .waitFor();
    await run.page
      .getByRole("alert")
      .filter({ hasText: "Controlled renderer load failure" })
      .waitFor();
    assert.equal(
      await run.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isVisible(),
      ),
      true,
    );
    await run.page.getByRole("button", { name: "重试", exact: true }).click();
    await assertHome(run);
    assert.equal(
      await fs.readFile(run.started, "utf8"),
      "1",
      "renderer Retry must reuse the initialized core",
    );
    checks.push(
      "a rejected interface load cannot hide the window; the visible error can retry the interface without duplicating the initialized core",
    );
    await finish(run);

    run = await launch("close-while-loading");
    const closed = run.app.waitForEvent("close", { timeout: 15000 });
    await run.page
      .getByRole("button", { name: "关闭启动器", exact: true })
      .click();
    await closed;
    active = undefined;
    checks.push(
      "Close remains usable while the core is pending and exits the Electron application without waiting for core initialization",
    );

    assert.deepEqual(pageErrors, []);
    const report = {
      passed: true,
      checks,
      pageErrors,
      scenarios,
      controlledCore: true,
      ...(productionSourceArchive ? { productionSourceArchive } : {}),
      gameLaunched: false,
      realAccountsUsed: false,
    };
    await fs.mkdir(path.join(project, "test-results"), { recursive: true });
    await fs.writeFile(
      path.join(project, "test-results/startup-smoke.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  } finally {
    if (active) await active.close().catch(() => {});
    await fs.rm(workspace, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
