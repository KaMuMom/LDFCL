const { _electron: electron } = require("playwright-core");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");

(async () => {
  const root = path.resolve(__dirname, "..");
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "LDFCL-general-settings-qa-"),
  );
  const gameRoot = path.join(dir, ".minecraft");
  const instance = {
    id: "settings-a",
    name: "预设验证实例",
    version: "1.21.1",
    loader: "vanilla",
    gameDirectoryId: "settings-root",
    versionDirectory: "settings-a",
    createdAt: new Date().toISOString(),
    gameSettings: { renderDistance: 8, maxFps: 60 },
  };
  const other = {
    ...instance,
    id: "settings-b",
    name: "独立版本",
    versionDirectory: "settings-b",
    gameSettings: {},
  };
  await fs.writeFile(
    path.join(dir, "launcher.json"),
    JSON.stringify({
      instances: [instance, other],
      gameDirectories: [
        {
          id: "settings-root",
          name: "测试目录",
          path: gameRoot,
          layout: "standard",
        },
      ],
      selectedGameDirectoryId: "settings-root",
      selectedInstanceId: instance.id,
    }),
  );
  for (const i of [instance, other]) {
    const folder = path.join(gameRoot, "versions", i.versionDirectory);
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(
      path.join(folder, `${i.versionDirectory}.json`),
      JSON.stringify({
        id: i.versionDirectory,
        clientVersion: "1.21.1",
        mainClass: "net.minecraft.client.main.Main",
        type: "release",
        libraries: [],
      }),
    );
    await fs.writeFile(
      path.join(folder, "options.txt"),
      'renderDistance:4\nresourcePacks:["keep.zip"]\n',
    );
  }
  const executable =
    process.env.LDFCL_TEST_EXE || process.env.LDFCL_TEST_EXECUTABLE;
  const env = { ...process.env, LDFCL_DATA_DIR: dir };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  const checks = [],
    errors = [];
  const launch = async () => {
    app = await electron.launch({
      ...(executable ? { executablePath: executable } : {}),
      args: executable ? [] : [root],
      cwd: root,
      env,
    });
    const page = await app.firstWindow();
    page.on("pageerror", (e) => errors.push(e.message));
    await page
      .getByRole("heading", { name: "开始游戏", exact: true })
      .waitFor();
    return page;
  };
  const until = async (page, predicate) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const state = await page.evaluate(() => window.launcher.call("state"));
      if (predicate(state)) return state;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    throw Error("State did not settle");
  };
  const openSettings = (page) =>
    page
      .locator("aside.sidebar")
      .getByRole("button", { name: "启动器设置", exact: true })
      .click();
  try {
    let page = await launch();
    await openSettings(page);
    const section = page.getByRole("region", {
      name: "通用游戏设置",
      exact: true,
    });
    const enabled = section.getByRole("button", {
      name: "启用通用游戏设置",
      exact: true,
    });
    assert.equal(await enabled.getAttribute("aria-pressed"), "false");
    await enabled.click();
    const render = page.getByLabel("渲染距离", { exact: false });
    await render.focus();
    await page.keyboard.press("Home");
    for (let i = 0; i < 16; i++) await page.keyboard.press("ArrowRight");
    assert.equal(await render.inputValue(), "18");
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    await until(page, (s) => s.settings.gameDefaults?.renderDistance === 18);
    const selectedOptions = path.join(
      gameRoot,
      "versions",
      "settings-a",
      "options.txt",
    );
    const otherOptions = path.join(
      gameRoot,
      "versions",
      "settings-b",
      "options.txt",
    );
    assert.equal(
      await fs.readFile(selectedOptions, "utf8"),
      'renderDistance:4\nresourcePacks:["keep.zip"]\n',
    );
    checks.push(
      "general options are opt-in, editable by keyboard and persist without modifying a running or unlaunched game",
    );

    await app.evaluate(({ app }) => {
      const path = process.getBuiltinModule("path");
      const requireApp = process
        .getBuiltinModule("module")
        .createRequire(path.join(app.getAppPath(), "package.json"));
      const { GameService } = requireApp(
        "./dist-electron/electron/services/game.js",
      );
      GameService.prototype.launch = async function (
        instance,
        account,
        settings,
      ) {
        globalThis.__settingsLaunch = {
          instance,
          settings,
          accountType: account.type,
        };
        setTimeout(
          () =>
            this.emit({
              type: "game",
              instanceId: instance.id,
              status: "exited",
            }),
          20,
        );
        return { pid: 12345 };
      };
    });
    const accountState = await page.evaluate(() =>
      window.launcher.call("account:offline", { name: "SettingsQA" }),
    );
    const accountId = accountState.id;
    await page.evaluate(
      ({ instanceId, accountId }) =>
        window.launcher.call("launch", { instanceId, accountId }),
      { instanceId: instance.id, accountId },
    );
    let text = await fs.readFile(selectedOptions, "utf8");
    assert.match(text, /renderDistance:8\n/);
    assert.match(text, /maxFps:60\n/);
    assert.match(text, /lang:zh_cn\n/);
    assert.match(text, /resourcePacks:\["keep.zip"\]/);
    assert.equal(
      await fs.readFile(otherOptions, "utf8"),
      'renderDistance:4\nresourcePacks:["keep.zip"]\n',
    );
    checks.push(
      "real launch IPC writes general settings with per-instance precedence and preserves the other version and unrelated options",
    );

    await page
      .locator("aside.sidebar")
      .getByRole("button", { name: "游戏实例", exact: true })
      .click();
    await page.getByRole("button", { name: "游戏预设", exact: true }).click();
    assert.equal(
      await page.getByLabel("渲染距离", { exact: false }).inputValue(),
      "8",
    );
    await page
      .getByRole("button", { name: "恢复通用设置", exact: true })
      .click();
    await until(
      page,
      (s) =>
        !Object.keys(s.instances.find((i) => i.id === instance.id).gameSettings)
          .length,
    );
    assert.equal(
      await page.getByLabel("渲染距离", { exact: false }).inputValue(),
      "18",
    );
    text = await fs.readFile(selectedOptions, "utf8");
    assert.match(text, /renderDistance:18\n/);
    assert.match(text, /maxFps:120\n/);
    checks.push(
      "instance presets display inherited values and can clear local overrides to resume general defaults",
    );

    await openSettings(page);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(960, 640),
    );
    await section.scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await fs.mkdir(path.join(root, "release"), { recursive: true });
    await page.screenshot({
      path: path.join(root, "release", "general-game-settings-960x640.png"),
    });
    await app.close();
    app = null;
    page = await launch();
    const restarted = await page.evaluate(() => window.launcher.call("state"));
    assert.equal(restarted.settings.gameDefaults.renderDistance, 18);
    assert.deepEqual(
      restarted.instances.find((i) => i.id === instance.id).gameSettings,
      {},
    );
    await openSettings(page);
    await page
      .getByRole("button", { name: "启用通用游戏设置", exact: true })
      .click();
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    await until(
      page,
      (s) => !Object.keys(s.settings.gameDefaults || {}).length,
    );
    assert.equal(await fs.readFile(selectedOptions, "utf8"), text);
    checks.push(
      "960x640 layout, settings/released overrides survive restart, and disabling general settings leaves game files intact",
    );
    assert.deepEqual(errors, []);
    const report = {
      passed: true,
      checks,
      pageErrors: errors,
      dataDir: dir,
      gameLaunched: false,
    };
    await fs.writeFile(
      path.join(root, "release", "general-settings-smoke.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  } finally {
    if (app) await app.close().catch(() => {});
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
