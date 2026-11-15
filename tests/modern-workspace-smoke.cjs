const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright-core");
(async () => {
  const root = path.resolve(__dirname, ".."),
    output = path.join(root, "test-results", "modern-workspace");
  await fs.mkdir(output, { recursive: true });
  const { createServer } = await import("vite");
  const server = await createServer({
    root,
    server: { host: "127.0.0.1", port: 0, watch: { ignored: ["**/*"] } },
  });
  let browser, page;
  const report = {
    passed: false,
    checks: [],
    screenshots: [],
    pageErrors: [],
    unexpected: [],
    overflows: [],
  };
  try {
    await server.listen();
    browser = await chromium.launch({
      executablePath:
        process.env.LDFCL_TEST_BROWSER ||
        "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      headless: true,
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    });
    page = await browser.newPage({ viewport: { width: 1120, height: 760 } });
    page.setDefaultTimeout(12000);
    page.on("pageerror", (e) => report.pageErrors.push(e.message));
    await page.route("**/*", (r) =>
      new URL(r.request().url()).hostname === "127.0.0.1"
        ? r.continue()
        : r.abort(),
    );
    await page.addInitScript(() => {
      const listeners = new Set();
      const state = {
        gameDirectories: [
          {
            id: "default",
            name: "我的游戏目录",
            path: "C:/Fixture/.minecraft",
            layout: "standard",
            isDefault: true,
          },
          {
            id: "travel",
            name: "移动硬盘",
            path: "D:/Fixture/Minecraft",
            layout: "standard",
          },
        ],
        selectedGameDirectoryId: "default",
        selectedInstanceId: "fabric",
        selectedAccountId: "alex",
        instances: [
          {
            id: "fabric",
            name: "林间漫游",
            version: "1.21.1",
            loader: "fabric",
            loaderVersion: "0.16.14",
            gameDirectoryId: "default",
            versionDirectory: "1.21.1-fabric",
            createdAt: "2026-11-01",
            gameSettings: { lang: "zh_cn" },
          },
          {
            id: "vanilla",
            name: "原版生存",
            version: "1.21.4",
            loader: "vanilla",
            gameDirectoryId: "default",
            createdAt: "2026-10-12",
            gameSettings: {},
          },
          {
            id: "forge",
            name: "机械与远方",
            version: "1.20.1",
            loader: "forge",
            gameDirectoryId: "default",
            createdAt: "2026-10-20",
            gameSettings: {},
          },
        ],
        accounts: [
          { id: "alex", name: "Alex", type: "offline", uuid: "synthetic" },
          { id: "steve", name: "Steve", type: "offline", uuid: "synthetic2" },
        ],
        settings: {
          theme: "light",
          interfacePerformance: "efficient",
          interfaceMotion: "system",
          downloadConcurrency: 8,
          memoryMode: "auto",
          memoryMb: 2048,
          javaPath: "",
          microsoftClientId: "",
          closeOnLaunch: false,
          gameDefaults: { lang: "zh_cn" },
          downloadSource: "official",
        },
        system: {
          totalMemoryMb: 4096,
          freeMemoryMb: 2048,
          platform: "Windows · x64",
          version: "0.7.0",
          dataDir: "C:/Fixture/LDFCL-data",
          gameRoot: "C:/Fixture/.minecraft",
          defaultGameRoot: "C:/Fixture/.minecraft",
        },
      };
      const qa = (window.__modern = {
        state,
        calls: [],
        unexpected: [],
        emit: (e) => {
          for (const cb of listeners) cb(structuredClone(e));
        },
      });
      const mods = [
        {
          id: "sodium",
          name: "Sodium",
          displayName: "钠 · Sodium",
          version: "0.6.13",
          file: "sodium.jar",
          enabled: true,
          size: 1234567,
        },
        {
          id: "iris",
          name: "Iris",
          displayName: "Iris 光影",
          version: "1.8.8",
          file: "iris.jar",
          enabled: true,
          size: 2323456,
        },
      ];
      window.launcher = {
        onEvent: (cb) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
        window: () => {},
        async call(method, payload) {
          qa.calls.push({ method, payload: structuredClone(payload) });
          if (method === "state") return structuredClone(state);
          if (method === "update:state")
            return {
              status: "current",
              currentVersion: "0.7.0",
              supported: true,
            };
          if (method === "health:latest") return null;
          if (method === "mods:list")
            return payload.id === "vanilla" ? [] : mods;
          if (
            [
              "diagnosis:list",
              "mod-favorites:list",
              "snapshot:list",
              "skin-library:list",
            ].includes(method)
          )
            return [];
          if (method === "skin:profile")
            return { skins: [], capes: [], editable: false };
          if (method === "store:stats")
            return { objects: 128, bytes: 134217728 };
          if (method === "settings") {
            Object.assign(state.settings, payload);
            qa.emit({ type: "state" });
            return structuredClone(state.settings);
          }
          if (method === "select") {
            Object.assign(state, {
              selectedAccountId: payload.accountId || state.selectedAccountId,
              selectedInstanceId:
                payload.instanceId || state.selectedInstanceId,
            });
            return true;
          }
          if (method === "account:cancel") return true;
          if (method === "account:remove") {
            state.accounts = state.accounts.filter((a) => a.id !== payload.id);
            return true;
          }
          if (method === "account:offline") {
            state.accounts.push({
              id: "new",
              name: payload.name,
              type: "offline",
              uuid: "new-synthetic",
            });
            return true;
          }
          if (method === "versions")
            return [
              { id: "1.21.4", type: "release" },
              { id: "1.21.1", type: "release" },
              { id: "1.20.1", type: "release" },
            ];
          if (method === "content-packs:list")
            return { packs: [], shaderAvailable: true };
          if (method === "content:search")
            return {
              total_hits: 2,
              hits: [
                {
                  project_id: "sodium",
                  slug: "sodium",
                  title: "Sodium",
                  displayName: "钠 · Sodium",
                  description: "为你的世界带来更流畅的渲染表现。",
                  author: "CaffeineMC",
                  categories: [],
                  downloads: 18000000,
                },
                {
                  project_id: "iris",
                  slug: "iris",
                  title: "Iris Shaders",
                  description: "探索光影的更多可能。",
                  author: "IrisShaders",
                  categories: [],
                  downloads: 12000000,
                },
              ],
            };
          if (method === "folder") return true;
          qa.unexpected.push(method);
          throw new Error("Unexpected fixture call: " + method);
        },
      };
    });
    await page.goto("http://127.0.0.1:" + server.httpServer.address().port);
    const nav = (name) =>
      page
        .locator("aside.sidebar")
        .getByRole("button", { name, exact: true })
        .click();
    async function shot(name) {
      await page.waitForTimeout(300);
      const overflow = await page.evaluate(() =>
        Array.from(
          document.querySelectorAll(
            ".main-content,.settings-content,.instance-details,.home-station,.ui-tabs",
          ),
        )
          .filter(
            (e) =>
              e.getClientRects().length && e.scrollWidth > e.clientWidth + 2,
          )
          .map((e) => ({
            class: e.className,
            width: e.clientWidth,
            scroll: e.scrollWidth,
          })),
      );
      if (overflow.length) report.overflows.push({ name, overflow });
      await page.screenshot({ path: path.join(output, name + ".png") });
      report.screenshots.push(name + ".png");
    }
    await page
      .getByRole("heading", { name: "开始游戏", exact: true })
      .waitFor();
    await page.waitForFunction(() =>
      document.querySelector(".home-skin-viewport canvas"),
    );
    await shot("01-home-light");
    await nav("游戏实例");
    for (const [label, name] of [
      ["概览", "02-instances-overview"],
      ["Mod 管理", "03-instances-mods"],
      ["资源与光影", "04-instance-packs"],
      ["游戏设置", "05-instance-game"],
      ["健康与快照", "06-instance-health"],
      ["实例设置", "07-instance-options"],
    ]) {
      await page.getByRole("tab", { name: label, exact: true }).click();
      await shot(name);
    }
    await nav("资源下载");
    await page.getByLabel("实例名称", { exact: true }).waitFor();
    await shot("08-download-minecraft");
    await page.getByRole("tab", { name: "Mod 模组", exact: true }).click();
    await page.getByLabel("搜索内容", { exact: true }).fill("Sodium");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await shot("09-download-mod");
    await nav("账号管理");
    await shot("10-accounts");
    await page.getByRole("button", { name: "添加账号", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await shot("11-account-login");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("dialog[open]").count(), 0);
    assert.equal(
      await page
        .getByRole("button", { name: "添加账号", exact: true })
        .evaluate((e) => e === document.activeElement),
      true,
    );
    await page
      .locator(".identity-card")
      .filter({ hasText: "Steve" })
      .getByRole("button", { name: "使用此账号" })
      .click();
    await page.waitForFunction(
      () => window.__modern.state.selectedAccountId === "steve",
    );
    await page.getByRole("button", { name: "移除 Alex", exact: true }).click();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    assert.equal(await page.locator(".identity-card").count(), 2);
    report.checks.push(
      "account selection calls backend, removal is confirmed, native dialog Escape restores trigger focus",
    );
    await nav("下载任务");
    await page.evaluate(() => {
      for (const [id, status] of [
        ["pack", "downloading"],
        ["done", "completed"],
        ["failed", "error"],
        ["pause", "paused"],
      ])
        window.__modern.emit({
          type: "task",
          task: {
            id,
            title: "Minecraft · " + id,
            status,
            progress: status === "completed" ? 100 : 42,
            detail:
              status === "error" ? "测试连接失败，请重试" : "正在处理文件",
          },
        });
    });
    await page.waitForTimeout(200);
    await shot("12-download-tasks");
    await page.getByRole("tab", { name: /需处理/ }).click();
    assert.equal(await page.locator(".download-task-card").count(), 1);
    await page.getByRole("tab", { name: /全部/ }).click();
    await page.getByRole("button", { name: "清除已完成", exact: true }).click();
    assert.equal(await page.locator(".download-task-card").count(), 3);
    report.checks.push(
      "task filtering and clear-completed retain active, paused and failed work",
    );
    await nav("皮肤与披风");
    await page.locator(".wardrobe-stage canvas").waitFor();
    await shot("13-wardrobe");
    await page.getByRole("button", { name: /图形编辑/ }).click();
    await page.getByRole("dialog", { name: "皮肤像素编辑器" }).waitFor();
    await shot("14-skin-editor");
    await page.keyboard.press("Escape");
    await page.getByRole("tab", { name: "我的皮肤库", exact: true }).click();
    await shot("15-skin-library");
    await nav("启动器设置");
    await page.getByLabel("主题", { exact: true }).selectOption("dark");
    await page.getByRole("button", { name: /Java 与内存/ }).click();
    await page.getByRole("button", { name: /外观与动效/ }).click();
    assert.equal(
      await page.getByLabel("主题", { exact: true }).inputValue(),
      "dark",
    );
    await nav("关于与致谢");
    await nav("启动器设置");
    assert.equal(
      await page.getByLabel("主题", { exact: true }).inputValue(),
      "dark",
    );
    await page.evaluate(() => {
      window.__modern.state.settings.downloadConcurrency = 6;
      window.__modern.emit({ type: "state" });
    });
    await page.waitForTimeout(150);
    assert.equal(
      await page.getByLabel("主题", { exact: true }).inputValue(),
      "dark",
    );
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    await page.waitForFunction(
      () => document.documentElement.dataset.theme === "dark",
    );
    assert.equal(
      await page.evaluate(
        () => window.__modern.state.settings.downloadConcurrency,
      ),
      6,
    );
    report.checks.push(
      "settings drafts survive section/page navigation and background refresh; save sends only changed fields",
    );
    await page.getByLabel("动态效果", { exact: true }).selectOption("reduced");
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    await page.waitForFunction(
      () => document.documentElement.dataset.motion === "reduced",
    );
    assert.equal(
      await page
        .locator(".motion-sample span")
        .first()
        .evaluate((e) => getComputedStyle(e).animationName),
      "none",
    );
    await page.getByLabel("动态效果", { exact: true }).selectOption("full");
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForFunction(
      () => document.documentElement.dataset.motion === "reduced",
    );
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.waitForFunction(
      () => document.documentElement.dataset.motion === "full",
    );
    report.checks.push(
      "reduced motion disables animations; OS reduced-motion preference wins over user full-motion setting",
    );
    await page.getByLabel("主题", { exact: true }).selectOption("light");
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    await page.waitForFunction(
      () => document.documentElement.dataset.theme === "light",
    );
    for (const [label, name] of [
      ["外观与动效", "16-settings-appearance"],
      ["游戏默认项", "17-settings-game"],
      ["Java 与内存", "18-settings-runtime"],
      ["下载与网络", "19-settings-network"],
      ["游戏目录", "20-settings-directories"],
      ["数据与存储", "21-settings-storage"],
      ["检查更新", "22-settings-updates"],
    ]) {
      await page
        .locator(".settings-navigation")
        .getByRole("button", { name: new RegExp(label) })
        .click();
      await shot(name);
    }
    await nav("运行日志");
    await shot("23-logs");
    await nav("关于与致谢");
    await shot("24-about");
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox", { name: "搜索功能名称" }).fill("内存");
    await shot("25-command-search");
    await page.keyboard.press("Enter");
    await page
      .getByRole("heading", { name: "内存分配", exact: true })
      .waitFor();
    report.checks.push(
      "Ctrl+K searches settings, keyboard Enter navigates directly to the selected section",
    );
    await nav("资源下载");
    await page.getByRole("tab", { name: "Mod 模组", exact: true }).waitFor();
    assert.equal(
      await page.getByLabel("搜索内容", { exact: true }).inputValue(),
      "Sodium",
    );
    report.checks.push(
      "resource search and selected category persist across other pages",
    );
    await page.getByRole("tab", { name: "Mod 模组", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(
      await page
        .getByRole("tab", { name: "整合包", exact: true })
        .getAttribute("aria-selected"),
      "true",
    );
    report.checks.push(
      "shared tabs support arrow-key roving focus and selection",
    );
    await page.setViewportSize({ width: 960, height: 640 });
    await page.evaluate(() => {
      window.__modern.state.settings.theme = "dark";
      window.__modern.emit({ type: "state" });
    });
    await page.waitForFunction(
      () => document.documentElement.dataset.theme === "dark",
    );
    for (const [label, name] of [
      ["开始游戏", "26-home-dark-compact"],
      ["游戏实例", "27-instances-dark-compact"],
      ["资源下载", "28-resources-dark-compact"],
      ["账号管理", "29-accounts-dark-compact"],
      ["启动器设置", "30-settings-dark-compact"],
      ["皮肤与披风", "31-wardrobe-dark-compact"],
    ]) {
      await nav(label);
      await shot(name);
    }
    report.unexpected = await page.evaluate(() => window.__modern.unexpected);
    assert.deepEqual(report.unexpected, []);
    assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.overflows, []);
    report.passed = true;
  } catch (e) {
    report.error = { message: e.message, stack: e.stack };
    await page
      ?.screenshot({ path: path.join(output, "failure.png") })
      .catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser?.close();
    await server.close();
    await fs.writeFile(
      path.join(output, "report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
  }
})();
