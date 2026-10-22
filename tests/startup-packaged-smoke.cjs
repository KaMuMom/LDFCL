const { _electron: electron } = require("playwright-core");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");

// Exercise the real packaged executable. Only synthetic TEMP data is used;
// the failure is an actual invalid configuration path, without core hooks.
(async () => {
  const project = path.resolve(__dirname, ".."),
    executable =
      process.env.LDFCL_TEST_EXE || process.env.LDFCL_TEST_EXECUTABLE;
  assert(
    executable && path.isAbsolute(executable),
    "Set the final packaged executable through LDFCL_TEST_EXE",
  );
  const workspace = await fs.mkdtemp(
    path.join(os.tmpdir(), "LDFCL-packaged-startup-qa-"),
  );
  const pageErrors = [],
    checks = [],
    runtime = [];
  let active;
  async function launch(mode, blocked) {
    const directory = path.join(workspace, mode),
      dataDir = path.join(directory, "LDFCL-data");
    await fs.mkdir(directory, { recursive: true });
    if (blocked) await fs.writeFile(dataDir, "synthetic-invalid-directory");
    const env = {
      ...process.env,
      LDFCL_DATA_DIR: dataDir,
      LDFCL_GAME_ROOT: path.join(directory, ".minecraft"),
    };
    for (const name of [
      "ELECTRON_RUN_AS_NODE",
      "NODE_OPTIONS",
      "LDFCL_DEV_URL",
    ])
      delete env[name];
    active = await electron.launch({
      executablePath: executable,
      args: [`--user-data-dir=${path.join(directory, "electron-profile")}`],
      env,
      timeout: 30000,
    });
    const page = await active.firstWindow({ timeout: 15000 });
    page.on("pageerror", (error) =>
      pageErrors.push(`${mode}: ${error.message}`),
    );
    assert.equal(
      await active.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isVisible(),
      ),
      true,
    );
    runtime.push(
      await active.evaluate(({ app }) => ({
        appVersion: app.getVersion(),
        electronVersion: process.versions.electron,
        isPackaged: app.isPackaged,
      })),
    );
    assert.equal(runtime.at(-1).isPackaged, true);
    assert.equal(runtime.at(-1).appVersion, require("../package.json").version);
    return { page, dataDir };
  }
  async function home(run) {
    await run.page
      .getByRole("heading", { name: "开始游戏", exact: true })
      .waitFor({ timeout: 30000 });
    const state = await run.page.evaluate(() => window.launcher.call("state"));
    assert.equal(state.system.dataDir, run.dataDir);
    assert.deepEqual(state.accounts, []);
    assert.deepEqual(state.instances, []);
  }
  try {
    let run = await launch("normal", false);
    await home(run);
    checks.push(
      "the actual packaged EXE exposes a visible window and reaches the real homepage with working state IPC using isolated TEMP data",
    );
    await active.close();
    active = undefined;

    run = await launch("invalid-config", true);
    await run.page
      .getByRole("heading", { name: "启动失败", exact: true })
      .waitFor({ timeout: 30000 });
    assert((await run.page.getByRole("alert").innerText()).trim());
    assert.equal(
      await active.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isVisible(),
      ),
      true,
    );
    await run.page.getByText("诊断信息", { exact: true }).click();
    await run.page.locator("pre").filter({ hasText: run.dataDir }).waitFor();
    assert.equal(
      await fs.readFile(run.dataDir, "utf8"),
      "synthetic-invalid-directory",
    );
    await fs.unlink(run.dataDir);
    await run.page.getByRole("button", { name: "重试", exact: true }).click();
    await home(run);
    checks.push(
      "an actual invalid configuration path yields a visible error and diagnostics without changing the blocking file; removing the synthetic blocker and Retry reaches the real homepage",
    );
    await active.close();
    active = undefined;
    assert.deepEqual(pageErrors, []);
    const report = {
      passed: true,
      checks,
      pageErrors,
      executable,
      executableSha256: createHash("sha256")
        .update(await fs.readFile(executable))
        .digest("hex"),
      runtime,
      controlledCore: false,
      gameLaunched: false,
      realAccountsUsed: false,
    };
    await fs.mkdir(path.join(project, "test-results"), { recursive: true });
    await fs.writeFile(
      path.join(project, "test-results/startup-packaged-smoke.json"),
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
