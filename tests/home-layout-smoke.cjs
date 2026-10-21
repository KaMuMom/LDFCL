const { _electron: electron } = require("playwright-core");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");

// Exercises real Electron IPC and renderer layout. All profiles/accounts are
// isolated fixtures; this test never clicks launch after an account is present.
(async () => {
  const root = path.resolve(__dirname, "..");
  const output = path.join(root, "test-results");
  await fs.mkdir(output, { recursive: true });
  const workspaces = [];
  const errors = [];
  const checks = [];
  let active;

  async function waitForState(page, predicate, label, timeout = 10000) {
    const deadline = Date.now() + timeout;
    let last;
    do {
      last = await page.evaluate(() => window.launcher.call("state"));
      if (predicate(last)) return last;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    assert.fail(`${label}: ${JSON.stringify(last)}`);
  }

  async function launch(instances = []) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "LDFCL-home-qa-"));
    const gameRoot = path.join(dir, ".minecraft");
    const gameDirectoryId = "home-qa-standard";
    const fixtureInstances = instances.map((instance) => ({
      ...instance,
      gameDirectoryId,
      versionDirectory: instance.versionDirectory || instance.id,
    }));
    workspaces.push(dir);
    for (const instance of fixtureInstances) {
      await fs.mkdir(
        path.join(gameRoot, "versions", instance.versionDirectory),
        {
          recursive: true,
        },
      );
      await fs.writeFile(
        path.join(
          gameRoot,
          "versions",
          instance.versionDirectory,
          `${instance.versionDirectory}.json`,
        ),
        JSON.stringify({
          id: instance.versionDirectory,
          type: "release",
          clientVersion: instance.version,
          mainClass: "net.minecraft.client.main.Main",
          libraries: [],
        }),
      );
    }
    await fs.writeFile(
      path.join(dir, "launcher.json"),
      JSON.stringify({
        instances: fixtureInstances,
        gameDirectories: [
          {
            id: gameDirectoryId,
            name: "首页验证游戏目录",
            path: gameRoot,
            layout: "standard",
          },
        ],
        selectedGameDirectoryId: gameDirectoryId,
        selectedInstanceId: fixtureInstances[0]?.id,
      }),
    );
    const env = { ...process.env, LDFCL_DATA_DIR: dir };
    delete env.ELECTRON_RUN_AS_NODE;
    active = await electron.launch({
      executablePath: process.env.LDFCL_TEST_EXE || require("electron"),
      args: process.env.LDFCL_TEST_EXE ? [] : [root],
      env,
      timeout: 45000,
    });
    const page = await active.firstWindow();
    page.on("pageerror", (e) => errors.push(e.message));
    await home(page);
    const state = await page.evaluate(() => window.launcher.call("state"));
    assert.equal(state.system.defaultGameRoot, path.join(dir, ".minecraft"));
    assert.equal(state.system.gameRoot, gameRoot);
    assert.equal(state.system.gameDirectoryError, undefined);
    assert.equal(state.instances.length, fixtureInstances.length);
    return { page, dir, gameRoot: state.system.gameRoot, app: active };
  }
  async function home(page) {
    await page
      .getByRole("heading", { name: "开始游戏", exact: true })
      .waitFor();
    await page.getByLabel("首页角色皮肤预览", { exact: true }).waitFor();
    await page.waitForFunction(() => {
      const c = document.querySelector('canvas[aria-label="首页角色皮肤预览"]');
      return c && c.width > 100 && c.height > 200;
    });
  }
  async function goHome(page) {
    await page
      .locator("aside.sidebar")
      .getByRole("button", { name: "开始游戏", exact: true })
      .click();
    await home(page);
  }
  async function size(app, width, height) {
    await app.evaluate(
      ({ BrowserWindow }, value) =>
        BrowserWindow.getAllWindows()[0].setContentSize(
          value.width,
          value.height,
        ),
      { width, height },
    );
  }
  async function onscreen(page, locator, name) {
    await locator.waitFor();
    const box = await locator.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(
        r.x + r.width / 2,
        r.y + r.height / 2,
      );
      return {
        x: r.x,
        y: r.y,
        right: r.right,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
        hittable: !!hit && (el === hit || el.contains(hit)),
      };
    });
    assert(
      box.width > 0 &&
        box.height > 0 &&
        box.x >= -1 &&
        box.y >= -1 &&
        box.right <= box.viewportWidth + 1 &&
        box.bottom <= box.viewportHeight + 1 &&
        box.hittable,
      `${name} is clipped or covered: ${JSON.stringify(box)}`,
    );
  }
  async function layout(page, app, width, height, launchName, image) {
    await size(app, width, height);
    await home(page);
    await page.waitForFunction(
      ({ width, height }) =>
        Math.abs(innerWidth - width) <= 2 &&
        Math.abs(innerHeight - height) <= 2,
      { width, height },
    );
    for (const name of [
      "开始游戏",
      "游戏实例",
      "资源下载",
      "皮肤与披风",
      "下载任务",
      "启动器设置",
      "运行日志",
      "关于与致谢",
    ]) {
      const button = page
        .locator("aside.sidebar")
        .getByRole("button", { name, exact: true });
      assert.equal(await button.getAttribute("title"), name);
      assert.equal(await button.getAttribute("data-tooltip"), name);
      await onscreen(page, button, `dock ${name}`);
    }
    await onscreen(
      page,
      page.getByLabel("首页角色皮肤预览", { exact: true }),
      "skin preview",
    );
    await onscreen(
      page,
      page.getByLabel("首页账号", { exact: true }),
      "account selector",
    );
    await onscreen(
      page,
      page.getByRole("button", { name: "管理账号", exact: true }),
      "account manager",
    );
    await onscreen(
      page,
      page.getByRole("region", { name: "当前游戏版本", exact: true }),
      "version card",
    );
    for (const name of ["切换版本", "版本设置", "Mod 管理", launchName])
      await onscreen(
        page,
        page.getByRole("button", { name, exact: true }),
        name,
      );
    const overflow = await page.evaluate(() => {
      const main = document.querySelector(".home-main");
      return {
        width: innerWidth,
        document: document.documentElement.scrollWidth,
        main: main.clientWidth,
        mainScroll: main.scrollWidth,
      };
    });
    assert(
      overflow.document <= overflow.width + 1 &&
        overflow.mainScroll <= overflow.main + 1,
      `home horizontal overflow: ${JSON.stringify(overflow)}`,
    );
    const materials = await page
      .locator(".glass-backdrop")
      .evaluateAll((layers) =>
        layers
          .filter((layer) => layer.getBoundingClientRect().width > 0)
          .map((layer) => {
            const warp = layer.querySelector(".glass__warp");
            const host = layer.getBoundingClientRect();
            const rect = warp?.getBoundingClientRect();
            const filter = layer.querySelector("filter");
            const image = filter?.querySelector("feImage");
            return {
              inert: layer.inert,
              hidden: layer.getAttribute("aria-hidden") === "true",
              fullSize:
                !!rect &&
                Math.abs(rect.width - host.width) <= 2 &&
                Math.abs(rect.height - host.height) <= 2 &&
                host.width > 30 &&
                host.height > 30,
              blur:
                warp && getComputedStyle(warp).backdropFilter.includes("blur("),
              filterLinked:
                !!filter && !!warp?.style.filter.includes(filter.id),
              localMap: !!image
                ?.getAttribute("href")
                ?.startsWith("data:image/"),
              pointerEvents: getComputedStyle(layer).pointerEvents,
              host: [host.width, host.height, layer.parentElement.className],
            };
          }),
      );
    assert(materials.length >= 4, "real upstream glass layers should render");
    assert(
      materials.every(
        (m) =>
          m.inert &&
          m.hidden &&
          m.fullSize &&
          m.blur &&
          m.filterLinked &&
          m.localMap &&
          m.pointerEvents === "none",
      ),
      `glass must resize and remain decorative: ${JSON.stringify(materials)}`,
    );
    await page.screenshot({ path: path.join(output, image) });
  }
  async function addOffline(page, name) {
    const dialog = page.getByRole("dialog", {
      name: "你的冒险身份",
      exact: true,
    });
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "离线账号", exact: true }).click();
    await dialog.getByPlaceholder("Steve").fill(name);
    await dialog.getByRole("button", { name: "添加账号", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.waitForFunction(
      (value) =>
        document
          .querySelector('select[aria-label="首页账号"]')
          ?.selectedOptions[0]?.textContent.includes(value),
      name,
    );
  }

  try {
    // Empty workspace: the 3D model is local, and install is routed to downloads.
    let session = await launch();
    await layout(
      session.page,
      session.app,
      1120,
      760,
      "安装游戏",
      "empty-home.png",
    );
    assert.equal(
      await session.page
        .getByRole("button", { name: "版本设置", exact: true })
        .isEnabled(),
      false,
    );
    assert.equal(
      await session.page
        .getByRole("button", { name: "Mod 管理", exact: true })
        .isEnabled(),
      false,
    );
    assert.equal(
      await session.page.getByLabel("首页账号", { exact: true }).inputValue(),
      "",
    );
    await session.page
      .getByRole("button", { name: "安装游戏", exact: true })
      .click();
    await session.page
      .getByRole("heading", { name: "资源下载", exact: true })
      .waitFor();
    checks.push(
      "empty workspace local 3D/default account and install-to-downloads guard",
    );
    await session.app.close();
    active = undefined;

    const instances = [
      {
        id: "home-fixture-a",
        name: "首页验证 Fabric",
        version: "1.21.1",
        loader: "fabric",
        versionDirectory: "1.21.1-fabric-home-a",
        createdAt: new Date().toISOString(),
        gameSettings: {},
      },
      {
        id: "home-fixture-b",
        name: "首页验证原版",
        version: "26.3",
        loader: "vanilla",
        versionDirectory: "26.3-home-b",
        createdAt: new Date().toISOString(),
        gameSettings: {},
      },
    ];
    session = await launch(instances);
    const { page, app } = session;
    // With an installed fixture and no account, launch opens identity selection
    // before attempting any game installation or process creation.
    await page.getByRole("button", { name: "启动游戏", exact: true }).click();
    await addOffline(page, "Home_QA_A");
    await page.getByRole("button", { name: "管理账号", exact: true }).click();
    await addOffline(page, "Home_QA_B");
    const state = await page.evaluate(() => window.launcher.call("state"));
    assert.equal(state.accounts.length, 2);
    const first = state.accounts.find((a) => a.name === "Home_QA_A");
    await page.getByLabel("首页账号", { exact: true }).selectOption(first.id);
    await waitForState(
      page,
      (value) => value.selectedAccountId === first.id,
      "Home account selection did not persist",
    );
    assert.equal(
      await page.getByLabel("首页账号", { exact: true }).inputValue(),
      first.id,
    );
    const toastClose = page.getByRole("button", {
      name: "关闭提示",
      exact: true,
    });
    if (await toastClose.count()) await toastClose.click();
    checks.push(
      "launch-without-account guard; two offline identities and persisted account switching",
    );

    await page
      .getByRole("button", { name: "开启自动旋转", exact: true })
      .click();
    await page
      .getByRole("button", { name: "暂停自动旋转", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "暂停自动旋转", exact: true })
      .click();
    await page
      .getByRole("button", { name: "开启自动旋转", exact: true })
      .waitFor();

    await layout(page, app, 1120, 760, "启动游戏", "home-layout.png");
    await layout(page, app, 960, 640, "启动游戏", "home-compact.png");
    checks.push(
      "1120x760 and 960x640: visible hit targets, no horizontal overflow, local preview, version card and launch button; real upstream SVG filters/blur resize and stay inert",
    );

    await page.getByRole("button", { name: "切换版本", exact: true }).click();
    const picker = page.getByRole("dialog", {
      name: "切换游戏版本",
      exact: true,
    });
    await picker.waitFor();
    await picker.getByRole("button", { name: /首页验证原版/ }).click();
    await picker.waitFor({ state: "hidden" });
    await page
      .getByRole("region", { name: "当前游戏版本", exact: true })
      .getByRole("heading", { name: "首页验证原版", exact: true })
      .waitFor();
    assert.equal(
      (await page.evaluate(() => window.launcher.call("state")))
        .selectedInstanceId,
      instances[1].id,
    );
    await page.getByRole("button", { name: "版本设置", exact: true }).click();
    await page.getByRole("button", { name: "游戏预设", exact: true }).waitFor();
    assert.equal(
      await page.locator(".instance-path").getAttribute("title"),
      path.join(session.gameRoot, "versions", instances[1].versionDirectory),
    );
    assert.match(
      await page
        .getByRole("button", { name: "游戏预设", exact: true })
        .getAttribute("class"),
      /selected/,
    );
    await goHome(page);
    await page.getByRole("button", { name: "Mod 管理", exact: true }).click();
    await page.getByRole("button", { name: "Mod 管理", exact: true }).waitFor();
    assert.match(
      await page
        .getByRole("button", { name: "Mod 管理", exact: true })
        .getAttribute("class"),
      /selected/,
    );
    await goHome(page);
    checks.push(
      "switch-version dialog/persistence and direct game-preset/mod-management routing",
    );

    const dock = page
      .locator("aside.sidebar")
      .getByRole("button", { name: "资源下载", exact: true });
    await dock.focus();
    // A programmatic focus after mouse clicks does not necessarily activate
    // :focus-visible. Traverse with the keyboard before checking its indicator.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    const focus = await dock.evaluate((el) => ({
      active: document.activeElement === el,
      outline: getComputedStyle(el).outlineStyle,
      tooltip: getComputedStyle(el, "::after").content,
      tooltipVisible: getComputedStyle(el, "::after").visibility,
    }));
    assert(
      focus.active && focus.outline !== "none",
      "dock icon needs visible keyboard focus: " + JSON.stringify(focus),
    );
    assert(
      focus.tooltip.includes("资源下载") && focus.tooltipVisible === "visible",
      "dock tooltip must also be available for keyboard focus",
    );
    await dock.press("Enter");
    await page
      .getByRole("heading", { name: "资源下载", exact: true })
      .waitFor();
    await goHome(page);
    checks.push(
      "dock accessible names/title/tooltip metadata, visible keyboard focus and Enter routing",
    );
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        passed: true,
        checks,
        pageErrors: errors,
        screenshots: output,
        dataDirs: workspaces,
      }),
    );
  } finally {
    if (active) await active.close();
    for (const dir of workspaces)
      await fs.rm(dir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
