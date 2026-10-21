const { _electron: electron } = require("playwright-core");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const AdmZip = require("adm-zip");
(async () => {
  const root = path.resolve(__dirname, "..");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "LDFCL-desktop-qa-"));
  const output = path.join(root, "test-results");
  await fs.mkdir(output, { recursive: true });
  const instance = {
    id: "ui-test-fixture",
    name: "界面验证实例",
    version: "1.21.1",
    loader: "fabric",
    gameDirectoryId: "desktop-qa-standard",
    versionDirectory: "1.21.1-fabric-ui-test",
    createdAt: new Date().toISOString(),
    gameSettings: {},
  };
  const fixtureGameRoot = path.join(dir, ".minecraft");
  await fs.writeFile(
    path.join(dir, "launcher.json"),
    JSON.stringify({
      instances: [instance],
      gameDirectories: [
        {
          id: instance.gameDirectoryId,
          name: "桌面验证游戏目录",
          path: fixtureGameRoot,
          layout: "standard",
        },
      ],
      selectedGameDirectoryId: instance.gameDirectoryId,
      selectedInstanceId: instance.id,
    }),
  );
  const instanceDir = path.join(
    fixtureGameRoot,
    "versions",
    instance.versionDirectory,
  );
  const mods = path.join(instanceDir, "mods");
  await fs.mkdir(mods, { recursive: true });
  await fs.writeFile(
    path.join(instanceDir, `${instance.versionDirectory}.json`),
    JSON.stringify({
      id: instance.versionDirectory,
      type: "release",
      clientVersion: instance.version,
      mainClass: "net.minecraft.client.main.Main",
      libraries: [],
    }),
  );
  for (const version of ["1.0.0", "2.0.0"]) {
    const zip = new AdmZip();
    zip.addFile(
      "fabric.mod.json",
      Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          id: "qa_fixture",
          version,
          name: "QA Fixture Mod",
        }),
      ),
    );
    await fs.writeFile(
      path.join(mods, `fixture-${version}.jar`),
      zip.toBuffer(),
    );
  }
  const sodium = new AdmZip();
  sodium.addFile(
    "fabric.mod.json",
    Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        id: "sodium",
        name: "Sodium",
        version: "0.6.0",
      }),
    ),
  );
  await fs.writeFile(
    path.join(mods, "sodium-translation-fixture.jar"),
    sodium.toBuffer(),
  );
  const errors = [];
  const environment = { ...process.env, LDFCL_DATA_DIR: dir };
  delete environment.ELECTRON_RUN_AS_NODE;
  const executable =
    process.env.LDFCL_TEST_EXECUTABLE || process.env.LDFCL_TEST_EXE;
  const app = await electron.launch({
    executablePath: executable || require("electron"),
    args: executable ? [] : [root],
    env: environment,
    timeout: 45000,
  });
  try {
    const page = await app.firstWindow();
    page.on("pageerror", (e) => errors.push(e.message));
    await page
      .getByRole("heading", { name: "开始游戏", exact: true })
      .waitFor();
    await page.screenshot({ path: path.join(output, "home.png") });
    assert.equal(
      await page.evaluate(() => typeof window.launcher.call),
      "function",
    );
    await page.getByRole("button", { name: "管理账号", exact: true }).click();
    await page.getByRole("button", { name: "离线账号", exact: true }).click();
    await page.getByPlaceholder("Steve").fill("LDFCL_QA");
    await page.getByRole("button", { name: "添加账号", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    const state = await page.evaluate(() => window.launcher.call("state"));
    assert.equal(state.system.gameRoot, fixtureGameRoot);
    assert.equal(state.system.defaultGameRoot, path.join(dir, ".minecraft"));
    assert.equal(state.system.gameDirectoryError, undefined);
    assert.equal(state.instances.length, 1);
    assert.equal(state.accounts[0].name, "LDFCL_QA");
    assert.equal("accessToken" in state.accounts[0], false);
    await page.getByRole("button", { name: "游戏实例", exact: true }).click();
    assert.equal(
      await page.locator(".instance-path").getAttribute("title"),
      instanceDir,
    );
    await page.getByRole("button", { name: "游戏预设", exact: true }).click();
    await page.getByRole("button", { name: "全屏显示", exact: true }).click();
    await page
      .getByRole("button", { name: "保存游戏预设", exact: true })
      .click();
    await page
      .getByRole("status")
      .filter({ hasText: "游戏预设已保存" })
      .waitFor();
    assert.match(
      await fs.readFile(path.join(instanceDir, "options.txt"), "utf8"),
      /fullscreen:true/,
    );
    await page.getByRole("button", { name: "Mod 管理", exact: true }).click();
    await page.locator(".mod-list").getByText("钠", { exact: true }).waitFor();
    await page
      .locator(".mod-list")
      .getByText("Sodium", { exact: true })
      .waitFor();
    await page.getByRole("button", { name: "重复检测", exact: true }).click();
    await page.getByText("发现 1 组重复项", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("禁用 QA Fixture Mod").count(), 2);
    await page.getByLabel("禁用 QA Fixture Mod").first().click();
    await page.getByLabel("启用 QA Fixture Mod").waitFor();
    assert((await fs.readdir(mods)).some((f) => f.endsWith(".disabled")));
    await page.getByRole("button", { name: "皮肤与披风", exact: true }).click();
    await page.locator(".wardrobe-stage canvas").waitFor();
    await page.screenshot({ path: path.join(output, "wardrobe.png") });
    await page.getByRole("button", { name: /编辑/ }).first().click();
    await page.locator(".wardrobe-editor").waitFor();
    await page.screenshot({ path: path.join(output, "skin-editor.png") });
    await page.locator(".wardrobe-editor header button").click();
    await page.getByRole("button", { name: "资源下载", exact: true }).click();
    await page.getByRole("tab", { name: "Mod 模组", exact: true }).click();
    await page.getByLabel("搜索内容", { exact: true }).fill("钠");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await page
      .locator(".content-card:not(.content-skeleton)")
      .first()
      .waitFor({ timeout: 60000 });
    await page
      .locator(".content-card")
      .getByRole("heading", { name: "钠", exact: true })
      .waitFor();
    await page.screenshot({ path: path.join(output, "discover.png") });
    await page.getByRole("tab", { name: "Minecraft", exact: true }).click();
    await page.getByRole("tab", { name: "Mod 模组", exact: true }).click();
    assert.equal(
      await page.getByLabel("搜索内容", { exact: true }).inputValue(),
      "钠",
    );
    await page.getByRole("button", { name: "启动器设置", exact: true }).click();
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    await page
      .getByRole("status")
      .filter({ hasText: "启动器设置已保存" })
      .waitFor();
    await page.screenshot({ path: path.join(output, "settings.png") });
    await page.getByRole("button", { name: "开始游戏", exact: true }).click();
    assert.equal(
      await page
        .getByRole("button", { name: "安装新版本", exact: true })
        .count(),
      0,
    );
    await page.getByRole("button", { name: "资源下载", exact: true }).click();
    await page.getByRole("tab", { name: "Minecraft", exact: true }).click();
    await page
      .locator(".version-list button")
      .first()
      .waitFor({ timeout: 60000 });
    assert((await page.locator(".version-list button").count()) > 0);
    await page.screenshot({ path: path.join(output, "install.png") });
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(
      await page
        .getByRole("tab", { name: "Minecraft", exact: true })
        .getAttribute("aria-selected"),
      "true",
    );
    await page.getByRole("button", { name: "关于与致谢", exact: true }).click();
    await page
      .getByRole("heading", { name: "关于与致谢", exact: true })
      .waitFor();
    await page.getByText("MSAL.js / LoopbackClient", { exact: true }).waitFor();
    await page.getByText("KAMUCL", { exact: true }).waitFor();
    await page.getByText(/参考提交 30874ab/).waitFor();
    await page
      .getByRole("button", { name: "微软设备代码文档", exact: true })
      .waitFor();
    await page.screenshot({ path: path.join(output, "credits.png") });
    const geometry = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const [width, height] = window.getSize();
      return { width, height, background: window.getBackgroundColor() };
    });
    assert(geometry.width <= 1120 && geometry.height <= 760);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(960, 640),
    );
    for (const name of [
      "开始游戏",
      "资源下载",
      "游戏实例",
      "启动器设置",
      "关于与致谢",
    ]) {
      await page.getByRole("button", { name, exact: true }).click();
      const size = await page.evaluate(() => ({
        width: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
        mainWidth: document.querySelector(".main-content").clientWidth,
        mainScroll: document.querySelector(".main-content").scrollWidth,
      }));
      assert(
        size.scroll <= size.width + 1 && size.mainScroll <= size.mainWidth + 1,
        name + " horizontal overflow: " + JSON.stringify(size),
      );
    }
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1120, 760),
    );
    await page.getByRole("button", { name: "开始游戏", exact: true }).click();
    // A saved account list makes the authorization dialog exceed a compact viewport.
    await page.evaluate(async () => {
      await window.launcher.call("account:offline", { name: "Dialog_QA_A" });
      await window.launcher.call("account:offline", { name: "Dialog_QA_B" });
    });
    await page.getByRole("button", { name: "管理账号", exact: true }).click();
    await page.getByRole("button", { name: "正版登录", exact: true }).click();
    await page
      .getByLabel("Microsoft 应用 Client ID", { exact: true })
      .fill("11111111-2222-3333-4444-555555555555");
    await app.evaluate(({ shell }) => {
      globalThis.__ldfclDeviceQA = { opened: [], polls: 0 };
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        const json = (body, status = 200) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          });
        if (url.endsWith("/devicecode"))
          return json({
            device_code: "desktop-fixture-private-device-code",
            user_code: "ABCD-EFGH",
            verification_uri: "https://microsoft.com/devicelogin",
            expires_in: 600,
            interval: 1,
          });
        if (url.endsWith("/token")) {
          globalThis.__ldfclDeviceQA.polls++;
          return json({ error: "authorization_pending" }, 400);
        }
        return originalFetch(input, init);
      };
      shell.openExternal = async (url) => {
        globalThis.__ldfclDeviceQA.opened.push(url);
      };
    });
    await page
      .getByRole("button", { name: "开始微软登录", exact: true })
      .click();
    await page.getByText("等待微软授权", { exact: true }).waitFor();
    assert.equal(
      await page.locator(".device-code-value").innerText(),
      "ABCD-EFGH",
    );
    assert.deepEqual(
      await app.evaluate(() => globalThis.__ldfclDeviceQA.opened),
      ["https://microsoft.com/devicelogin"],
    );
    assert.equal(
      (await page.locator("body").innerText()).includes(
        "desktop-fixture-private-device-code",
      ),
      false,
    );
    await page.screenshot({ path: path.join(output, "device-login.png") });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(960, 640),
    );
    await page.waitForFunction(() => innerHeight <= 640);
    const materialFollowsScroll = await page
      .locator(".modal")
      .evaluate(async (modal) => {
        const contentHeight = modal.scrollHeight;
        modal.scrollTop = modal.scrollHeight;
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
        const layer = modal.querySelector(".glass-backdrop");
        const frame = modal.getBoundingClientRect();
        const material = layer.getBoundingClientRect();
        return {
          scroll: modal.scrollTop,
          top: Math.abs(material.top - frame.top),
          bottom: Math.abs(material.bottom - frame.bottom),
          extraOverflow: modal.scrollHeight - contentHeight,
        };
      });
    assert(
      materialFollowsScroll.scroll > 0,
      "compact authorization dialog should scroll",
    );
    assert(
      materialFollowsScroll.top <= 2 && materialFollowsScroll.bottom <= 2,
      `glass should stay over dialog viewport: ${JSON.stringify(materialFollowsScroll)}`,
    );
    assert(
      materialFollowsScroll.extraOverflow <= 1,
      `glass must not extend the scroll area: ${JSON.stringify(materialFollowsScroll)}`,
    );
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1120, 760),
    );
    await page
      .getByRole("button", { name: "取消本次登录", exact: true })
      .click();
    await page
      .getByText("等待微软授权", { exact: true })
      .waitFor({ state: "hidden" });
    const assertPollingStopped = async () => {
      const polls = await app.evaluate(() => globalThis.__ldfclDeviceQA.polls);
      await page.waitForTimeout(1250);
      assert.equal(
        await app.evaluate(() => globalThis.__ldfclDeviceQA.polls),
        polls,
      );
    };
    await assertPollingStopped();
    await page
      .getByRole("button", { name: "开始微软登录", exact: true })
      .click();
    await page.getByText("等待微软授权", { exact: true }).waitFor();
    await page.getByRole("button", { name: "离线账号", exact: true }).click();
    await page.getByPlaceholder("Steve").waitFor();
    await assertPollingStopped();
    await page.getByRole("button", { name: "正版登录", exact: true }).click();
    await page
      .getByRole("button", { name: "开始微软登录", exact: true })
      .click();
    await page.getByText("等待微软授权", { exact: true }).waitFor();
    await page.getByRole("button", { name: "关闭弹窗", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await assertPollingStopped();
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        passed: true,
        dataDir: dir,
        screenshots: output,
        checks: [
          "sandboxed preload bridge",
          "offline account creation/redaction",
          "options.txt write",
          "duplicate detection",
          "mod disable",
          "WebGL wardrobe",
          "pixel editor",
          "Modrinth browse",
          "Chinese mod names, original names and Chinese search",
          "settings persistence",
          "official version list within resource downloads",
          "1120x760 default and 960x640 layout",
          "credits and source references",
          "Microsoft device code, browser dispatch (intercepted) and cancellation",
          "resource category state preservation",
          "Microsoft auth cancelled on account switch and dialog close",
        ],
        pageErrors: errors,
      }),
    );
  } finally {
    await app.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
