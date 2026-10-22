const { chromium } = require("playwright-core");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
(async () => {
  const root = path.resolve(__dirname, "..");
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "LDFCL-portable-qa-"),
  );
  const env = { ...process.env, LDFCL_DATA_DIR: dataDir };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    process.env.LDFCL_TEST_PORTABLE_EXE ||
      path.join(
        root,
        "release",
        `LDFCL-${require("../package.json").version}-Windows-x64.exe`,
      ),
    ["--remote-debugging-port=19349"],
    { env, windowsHide: true, stdio: "ignore" },
  );
  let exited = false;
  let exitCode;
  child.on("exit", (code) => {
    exited = true;
    exitCode = code;
  });
  let browser;
  try {
    const deadline = Date.now() + 60000;
    let endpoint;
    while (Date.now() < deadline) {
      try {
        const response = await fetch("http://127.0.0.1:19349/json/version");
        if (response.ok) {
          endpoint = await response.json();
          break;
        }
      } catch {}
      if (exited)
        throw Error(`Portable executable exited before startup: ${exitCode}`);
      await new Promise((r) => setTimeout(r, 500));
    }
    assert(
      endpoint?.webSocketDebuggerUrl,
      "Portable CDP endpoint not available",
    );
    browser = await chromium.connectOverCDP(endpoint.webSocketDebuggerUrl);
    const context = browser.contexts()[0];
    const page =
      context.pages()[0] ||
      (await context.waitForEvent("page", { timeout: 60000 }));
    await page
      .getByRole("heading", { name: "开始游戏", exact: true })
      .waitFor();
    await page.getByLabel("首页角色皮肤预览", { exact: true }).waitFor();
    await page.getByRole("button", { name: "切换版本", exact: true }).waitFor();
    await page.getByRole("button", { name: "安装游戏", exact: true }).waitFor();
    assert.equal(
      await page.getByLabel("首页账号", { exact: true }).isDisabled(),
      true,
    );
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: path.join(root, "release", "LDFCL-preview.png"),
    });
    const state = await page.evaluate(() => window.launcher.call("state"));
    assert.equal(state.instances.length, 0);
    assert.equal(state.accounts.length, 0);
    assert.equal(state.system.dataDir, dataDir);
    assert.equal(state.system.gameRoot, path.join(dataDir, ".minecraft"));
    assert.equal(
      state.system.defaultGameRoot,
      path.join(dataDir, ".minecraft"),
    );
    await page.evaluate(() =>
      window.launcher.call("account:offline", { name: "Portable_QA" }),
    );
    const result = await page.evaluate(() => window.launcher.call("state"));
    assert.equal(result.accounts[0].name, "Portable_QA");
    assert.equal("accessToken" in result.accounts[0], false);
    const versions = await page.evaluate(() =>
      window.launcher.call("versions"),
    );
    assert(versions.length > 100);
    assert.equal(state.system.version, require("../package.json").version);
    await page.getByRole("button", { name: "资源下载", exact: true }).click();
    await page.locator(".version-list button").first().waitFor();
    assert.equal(
      await page
        .getByRole("tab", { name: "Minecraft", exact: true })
        .getAttribute("aria-selected"),
      "true",
    );
    await page.screenshot({
      path: path.join(root, "release", "LDFCL-downloads.png"),
    });
    await page.getByRole("button", { name: "关于与致谢", exact: true }).click();
    await page
      .getByRole("heading", { name: "关于与致谢", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "皮肤与披风", exact: true }).click();
    await page.locator(".wardrobe-stage canvas").waitFor();
    console.log(
      JSON.stringify({
        passed: true,
        portable: true,
        isolatedDataDir: dataDir,
        isolatedGameRoot: state.system.gameRoot,
        officialVersions: versions.length,
        screenshot: "release/LDFCL-preview.png",
        checks: [
          "self extraction",
          "packaged UI",
          "Dock, home 3D preview, account selector and version card",
          "preload IPC",
          "empty first-run data",
          "isolated default .minecraft game directory",
          "offline account",
          "official network request",
          "3D wardrobe",
        ],
      }),
    );
    await page.evaluate(() => window.launcher.window("close"));
    for (let i = 0; i < 40 && !exited; i++)
      await new Promise((r) => setTimeout(r, 250));
    assert(exited, "Portable wrapper did not exit");
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (!exited && child.pid)
      await new Promise((resolve) => {
        const killer = spawn(
          "taskkill",
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" },
        );
        killer.on("exit", resolve);
        killer.on("error", resolve);
      });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
