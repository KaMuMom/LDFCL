const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright-core");

// Real React/Vite with synthetic IPC only. Outbound HTTP is blocked; this
// checks navigation and event delivery, not service/network/game behavior.
(async () => {
  const root = path.resolve(__dirname, "..");
  const output = path.join(root, "test-results", "ui-event-navigation");
  await fs.mkdir(output, { recursive: true });
  const { createServer } = await import("vite");
  const server = await createServer({
    root,
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
      watch: { ignored: ["**/*"] },
    },
  });
  const report = { passed: false, checks: [], pageErrors: [], blockedUrls: [] };
  let browser, page;
  try {
    await server.listen();
    browser = await chromium.launch({
      executablePath:
        process.env.LDFCL_TEST_BROWSER ||
        "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      headless: true,
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    });
    page = await browser.newPage({
      viewport: { width: 1120, height: 760 },
    });
    page.on("pageerror", (error) => report.pageErrors.push(error.message));
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (new URL(url).hostname === "127.0.0.1") return route.continue();
      report.blockedUrls.push(url);
      return route.abort();
    });
    await page.addInitScript(() => {
      const listeners = new Set();
      const state = {
        gameDirectories: [
          { id: "fixture-root", name: "Synthetic root", path: "fixture-only" },
        ],
        selectedGameDirectoryId: "fixture-root",
        selectedInstanceId: "fixture-target",
        instances: [
          {
            id: "fixture-decoy",
            name: "Unselected fixture",
            version: "1.20.1",
            loader: "vanilla",
            versionDirectory: "fixture-decoy",
            gameDirectoryId: "fixture-root",
            gameSettings: {},
          },
          {
            id: "fixture-target",
            name: "Synthetic selected target",
            version: "1.21.1",
            loader: "fabric",
            loaderVersion: "0.16.14",
            versionDirectory: "fixture-target",
            gameDirectoryId: "fixture-root",
            gameSettings: {},
          },
        ],
        accounts: [],
        settings: {
          theme: "light",
          interfacePerformance: "efficient",
          downloadConcurrency: 8,
          memoryMode: "auto",
          memoryMb: 2048,
          javaPath: "",
          microsoftClientId: "",
          closeOnLaunch: false,
        },
        system: {
          totalMemoryMb: 4096,
          freeMemoryMb: 2048,
          platform: "Synthetic Windows · x64",
          version: "navigation-test",
          dataDir: "fixture-only",
          gameRoot: "fixture-only",
          defaultGameRoot: "fixture-only",
        },
      };
      const qa = (window.__navigationQa = {
        state,
        calls: [],
        unexpectedCalls: [],
        emit(event) {
          for (const listener of listeners) listener(structuredClone(event));
        },
      });
      window.launcher = {
        async call(method, payload) {
          qa.calls.push({ method, payload: structuredClone(payload) });
          if (method === "state") return structuredClone(state);
          if (method === "update:state")
            return { status: "current", currentVersion: "navigation-test" };
          if (method === "health:latest") return null;
          if (method === "diagnosis:list" || method === "mod-favorites:list")
            return [];
          if (method === "store:stats") return { objects: 0, bytes: 0 };
          if (method === "settings") {
            state.settings = { ...state.settings, ...structuredClone(payload) };
            qa.emit({ type: "state" });
            return structuredClone(state.settings);
          }
          if (method === "versions")
            return [
              { id: "1.21.1", type: "release" },
              { id: "1.20.1", type: "release" },
            ];
          if (method === "content:search")
            return {
              total_hits: 1,
              hits: [
                {
                  project_id: `fixture-${payload.type}`,
                  slug: `fixture-${payload.type}`,
                  title: `Synthetic ${payload.type} result: ${payload.query || "all"}`,
                  description: "Only synthetic content, never installed",
                  author: "Fixture",
                  categories: [],
                  downloads: 0,
                },
              ],
            };
          qa.unexpectedCalls.push(method);
          throw Error(`Unexpected synthetic IPC call: ${method}`);
        },
        onEvent(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
    await page
      .getByRole("heading", { name: "开始游戏", exact: true })
      .waitFor();
    await page.waitForFunction(() =>
      window.__navigationQa.calls.some((c) => c.method === "state"),
    );
    assert.equal(await page.locator(".resource-downloads").count(), 0);
    assert.deepEqual(
      await page.evaluate(() =>
        window.__navigationQa.calls.filter((c) =>
          ["versions", "content:search"].includes(c.method),
        ),
      ),
      [],
    );
    report.checks.push(
      "unvisited resource route mounts nothing and requests no versions/content",
    );

    await page.evaluate(() => {
      for (let index = 0; index < 1200; index++)
        window.__navigationQa.emit({
          type: "log",
          instanceId: "fixture-target",
          line: `background-${index}`,
        });
      window.__navigationQa.emit({
        type: "log",
        instanceId: "other-instance",
        line: "foreign-log-must-not-leak",
      });
    });
    await page.waitForTimeout(180);
    await page.getByRole("button", { name: "运行日志", exact: true }).click();
    const consoleBox = page.getByLabel("最近500行游戏日志", { exact: true });
    await consoleBox.waitFor();
    assert.deepEqual(
      (await consoleBox.innerText()).split("\n"),
      Array.from({ length: 500 }, (_, i) => `background-${i + 700}`),
    );
    await page.evaluate(() =>
      window.__navigationQa.emit({
        type: "log",
        instanceId: "fixture-target",
        line: "live-1200\r\nlive-1201",
      }),
    );
    await page.waitForFunction(() =>
      document
        .querySelector(".diagnostic-console")
        ?.textContent.endsWith("live-1200\nlive-1201"),
    );
    const liveLines = (await consoleBox.innerText()).split("\n");
    assert.equal(liveLines.length, 500);
    assert.equal(liveLines[0], "background-702");
    report.checks.push(
      "1200 hidden-page log events retain exactly final 500 lines per instance; live CRLF increment preserves order and bound",
    );

    await page.getByRole("button", { name: "下载任务", exact: true }).click();
    await page
      .getByRole("heading", { name: "暂无下载任务", exact: true })
      .waitFor();
    await page.evaluate(() => {
      for (let progress = 0; progress < 1200; progress++)
        for (const id of ["success", "failure", "paused"])
          window.__navigationQa.emit({
            type: "task",
            task: {
              id,
              title: `Synthetic ${id}`,
              status: "downloading",
              progress: progress % 100,
            },
          });
      window.__navigationQa.emit({
        type: "task",
        task: {
          id: "success",
          title: "Synthetic success",
          status: "completed",
          progress: 100,
        },
      });
      window.__navigationQa.emit({
        type: "task",
        task: {
          id: "failure",
          title: "Synthetic failure",
          status: "error",
          progress: 57,
          detail: "synthetic-terminal-error",
        },
      });
      window.__navigationQa.emit({
        type: "task",
        task: {
          id: "paused",
          title: "Synthetic paused",
          status: "paused",
          progress: 73,
        },
      });
    });
    await page.locator(".download-task-card").first().waitFor();
    assert.equal(await page.locator(".download-task-card").count(), 3);
    const success = page.locator(".download-task-card", {
      hasText: "Synthetic success",
    });
    assert.equal(
      await success.locator(".download-status").innerText(),
      "已完成",
    );
    assert.equal(
      await success.getByRole("progressbar").getAttribute("aria-valuenow"),
      "100",
    );
    const failure = page.locator(".download-task-card", {
      hasText: "Synthetic failure",
    });
    assert.equal(await failure.locator(".download-status").innerText(), "失败");
    assert.match(await failure.innerText(), /synthetic-terminal-error/);
    assert.equal(
      await page
        .locator(".download-task-card", { hasText: "Synthetic paused" })
        .getByRole("progressbar")
        .getAttribute("aria-valuenow"),
      "73",
    );
    await page.waitForTimeout(220);
    assert.equal(
      await page.locator(".download-task-card.completed").count(),
      1,
    );
    await page.getByRole("button", { name: "清除已完成", exact: true }).click();
    assert.equal(await page.locator(".download-task-card").count(), 1);
    report.checks.push(
      "3600 progress events merge into three correct terminal/latest task cards without lost completion/error/pause; clear finished preserves paused task",
    );

    await page.getByRole("button", { name: "资源下载", exact: true }).click();
    await page
      .getByLabel("实例名称", { exact: true })
      .fill("Retained synthetic installation");
    await page.getByLabel("模组加载器", { exact: true }).selectOption("fabric");
    await page.getByLabel("搜索游戏版本", { exact: true }).fill("1.20.1");
    await page
      .getByRole("button", { name: "1.20.1 正式版", exact: true })
      .click();
    await page.getByRole("tab", { name: "资源包", exact: true }).click();
    const resourcePanel = page.getByRole("tabpanel", {
      name: "资源包",
      exact: true,
    });
    await resourcePanel
      .getByLabel("搜索内容", { exact: true })
      .fill("retained resource query");
    await resourcePanel
      .getByRole("button", { name: "搜索", exact: true })
      .click();
    await resourcePanel
      .getByRole("heading", {
        name: "Synthetic resourcepack result: retained resource query",
        exact: true,
      })
      .waitFor();
    assert.match(
      await resourcePanel.innerText(),
      /安装到 Synthetic selected target/,
    );
    const beforeLeave = await page.evaluate(
      () =>
        window.__navigationQa.calls.filter((c) => c.method === "versions")
          .length,
    );
    await page.getByRole("button", { name: "关于与致谢", exact: true }).click();
    await page
      .getByRole("heading", { name: "关于与致谢", exact: true })
      .waitFor();
    assert.equal(await page.locator(".resource-downloads").count(), 1);
    await page.getByRole("button", { name: "资源下载", exact: true }).click();
    assert.equal(
      await page
        .getByRole("tab", { name: "资源包", exact: true })
        .getAttribute("aria-selected"),
      "true",
    );
    assert.equal(
      await resourcePanel.getByLabel("搜索内容", { exact: true }).inputValue(),
      "retained resource query",
    );
    await resourcePanel
      .getByRole("heading", {
        name: "Synthetic resourcepack result: retained resource query",
        exact: true,
      })
      .waitFor();
    const lastSearch = await page.evaluate(() =>
      window.__navigationQa.calls
        .filter((c) => c.method === "content:search")
        .at(-1),
    );
    assert.equal(lastSearch.payload.version, "1.21.1");
    assert.equal(lastSearch.payload.query, "retained resource query");
    assert.match(
      await resourcePanel.innerText(),
      /安装到 Synthetic selected target/,
    );
    await page.getByRole("tab", { name: "Minecraft", exact: true }).click();
    assert.equal(
      await page.getByLabel("实例名称", { exact: true }).inputValue(),
      "Retained synthetic installation",
    );
    assert.equal(
      await page.getByLabel("模组加载器", { exact: true }).inputValue(),
      "fabric",
    );
    assert.equal(
      await page.getByLabel("搜索游戏版本", { exact: true }).inputValue(),
      "1.20.1",
    );
    assert.equal(
      await page
        .getByRole("button", { name: "1.20.1 正式版", exact: true })
        .getAttribute("aria-pressed"),
      "true",
    );
    report.resourceVersionCalls = {
      beforeLeave,
      afterReturn: await page.evaluate(
        () =>
          window.__navigationQa.calls.filter((c) => c.method === "versions")
            .length,
      ),
    };
    assert.equal(
      report.resourceVersionCalls.afterReturn,
      report.resourceVersionCalls.beforeLeave,
      "first lazy About navigation must not reconnect the persistent resource version effect",
    );
    report.checks.push(
      "visited resource route retains type/search/submitted query/selected second-instance target and Minecraft version/loader/name across first lazy About navigation; version effect reconnect counts recorded separately",
    );

    await page.getByRole("button", { name: "启动器设置", exact: true }).click();
    await page.getByLabel("界面性能", { exact: true }).selectOption("quality");
    assert.equal(
      await page.locator("html").getAttribute("data-performance"),
      "efficient",
    );
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    await page.waitForFunction(
      () => document.documentElement.dataset.performance === "quality",
    );
    await page
      .getByLabel("界面性能", { exact: true })
      .selectOption("efficient");
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    await page.waitForFunction(
      () => document.documentElement.dataset.performance === "efficient",
    );
    await page.waitForFunction(
      () => !document.querySelector("feDisplacementMap"),
    );
    assert.equal(
      await page.evaluate(
        () => window.__navigationQa.state.settings.interfacePerformance,
      ),
      "efficient",
    );
    report.checks.push(
      "settings mode is staged until save; saving quality/efficient applies global attribute, returns to zero displacement filters",
    );

    report.calls = await page.evaluate(() => window.__navigationQa.calls);
    report.unexpectedCalls = await page.evaluate(
      () => window.__navigationQa.unexpectedCalls,
    );
    assert.deepEqual(report.unexpectedCalls, []);
    assert.deepEqual(report.pageErrors, []);
    await page.screenshot({
      path: path.join(output, "settings-efficient.png"),
    });
    report.passed = true;
  } catch (error) {
    report.error = { message: error.message, stack: error.stack };
    await page
      ?.screenshot({ path: path.join(output, "failure.png") })
      .catch(() => {});
    throw error;
  } finally {
    await browser?.close().catch(() => {});
    await server.close();
    await fs.writeFile(
      path.join(output, "report.json"),
      JSON.stringify(report, null, 2),
    );
  }
  console.log(JSON.stringify(report, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
