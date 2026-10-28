const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright-core");

// Exercise real React lists and actions with 1001 local-only Mod fixtures.
// IPC replies are controlled; no real game files or accounts are changed.
(async () => {
  const root = path.resolve(__dirname, "..");
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
  let browser;
  const errors = [];
  const checks = [];
  try {
    await server.listen();
    browser = await chromium.launch({
      executablePath:
        process.env.LDFCL_TEST_BROWSER ||
        "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      headless: true,
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    });
    const page = await browser.newPage({
      viewport: { width: 1120, height: 760 },
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) =>
      new URL(route.request().url()).hostname === "127.0.0.1"
        ? route.continue()
        : route.abort(),
    );
    await page.addInitScript(() => {
      const listeners = new Set();
      const instances = Array.from({ length: 123 }, (_, index) => ({
        id: `fixture-${index}`,
        name: `测试版本 ${index}`,
        version: "1.21.1",
        loader: "fabric",
        createdAt: "2026-10-28T00:00:00.000Z",
        gameSettings: {},
      }));
      const mods = Array.from({ length: 1001 }, (_, index) => ({
        id: `mod-${index}`,
        name: `Mod ${index}`,
        displayName: index === 1000 ? "中文末页模组" : `Mod ${index}`,
        nameZh: index === 1000 ? "中文末页模组" : undefined,
        originalName: index === 1000 ? "Original Tail Library" : undefined,
        file: index === 1000 ? "late-file-1000.jar" : `mod-${index}.jar`,
        enabled: true,
        version: "1.0.0",
      }));
      const state = {
        gameDirectories: [],
        instances,
        selectedInstanceId: "fixture-112",
        accounts: [],
        settings: {
          interfacePerformance: "efficient",
          theme: "light",
          memoryMode: "auto",
          memoryMb: 2048,
          javaPath: "",
          microsoftClientId: "",
          downloadConcurrency: 4,
          closeOnLaunch: false,
        },
        system: {
          totalMemoryMb: 4096,
          freeMemoryMb: 2048,
          platform: "Windows · x64",
          version: "pagination-qa",
          dataDir: "fixture-only",
          gameRoot: "fixture-only",
          defaultGameRoot: "fixture-only",
        },
      };
      const qa = (window.__paginationQa = { mods, calls: [], unexpected: [] });
      window.launcher = {
        async call(method, payload) {
          if (method === "state") return structuredClone(state);
          if (method === "health:latest") return null;
          if (method === "update:state")
            return { status: "current", currentVersion: "fixture-only" };
          qa.calls.push({ method, payload });
          if (method === "select") {
            state.selectedInstanceId = payload.instanceId;
            return;
          }
          if (method === "mods:list")
            return payload.id === "fixture-112" ? structuredClone(qa.mods) : [];
          if (method === "mods:toggle") {
            qa.mods.find((mod) => mod.file === payload.file).enabled =
              payload.enabled;
            return;
          }
          if (method === "mods:remove") {
            qa.mods = qa.mods.filter((mod) => mod.file !== payload.file);
            return;
          }
          if (method === "mods:duplicates")
            return [{ id: "fixture-duplicate" }];
          if (method === "mods:updates")
            return [{ file: "mod-0.jar", version: "2.0.0" }];
          if (method === "mods:apply") {
            qa.mods[0].version = "2.0.0";
            return;
          }
          qa.unexpected.push(method);
          throw new Error(`Unexpected pagination call: ${method}`);
        },
        onEvent(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
    const dock = page.locator("aside.sidebar");
    await dock.getByRole("button", { name: "游戏实例", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelectorAll(".mod-row").length === 50,
    );
    assert.equal(await page.locator(".version-choice").count(), 23);
    assert.equal(
      await page.getByLabel("版本页码", { exact: true }).inputValue(),
      "2",
    );
    assert.equal(
      await page.getByLabel("Mod页码", { exact: true }).inputValue(),
      "0",
    );
    const selectedVisible = await page
      .locator(".version-choice.selected")
      .evaluate((item) => {
        const box = item.getBoundingClientRect(),
          parent = item.parentElement.getBoundingClientRect();
        return box.top >= parent.top - 1 && box.bottom <= parent.bottom + 1;
      });
    assert(
      selectedVisible,
      "preselected version must be visible within its list",
    );
    checks.push(
      "123 versions open on the selected third page; only 50 of 1001 Mods mount",
    );

    await page.getByLabel("Mod页码", { exact: true }).selectOption("20");
    await page.waitForFunction(
      () => document.querySelectorAll(".mod-row").length === 1,
    );
    await page
      .getByRole("button", { name: "禁用 Mod 1000", exact: true })
      .click();
    await page
      .getByRole("button", { name: "启用 Mod 1000", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "启用 Mod 1000", exact: true })
        .getAttribute("aria-pressed"),
      "false",
    );
    const search = page.getByLabel("搜索已安装 Mod", { exact: true });
    for (const query of ["中文末页", "original tail", "late-file-1000.jar"]) {
      await search.fill(query);
      await page.waitForFunction(
        () => document.querySelectorAll(".mod-row").length === 1,
      );
      assert.match(await page.locator(".mod-row").innerText(), /中文末页模组/);
      assert.equal(
        await page
          .getByRole("navigation", { name: "Mod分页", exact: true })
          .count(),
        0,
      );
    }
    await search.fill("不存在的模组");
    await page
      .getByRole("heading", { name: "没有匹配的 Mod", exact: true })
      .waitFor();
    await search.fill("");
    await page.waitForFunction(
      () => document.querySelectorAll(".mod-row").length === 50,
    );
    assert.equal(
      await page.getByLabel("Mod页码", { exact: true }).inputValue(),
      "0",
    );
    await page.getByLabel("Mod页码", { exact: true }).selectOption("20");
    await page
      .getByRole("button", { name: "移除 Mod 1000", exact: true })
      .click();
    await page.waitForFunction(
      () => document.querySelectorAll(".mod-row").length === 50,
    );
    assert.equal(
      await page.getByLabel("Mod页码", { exact: true }).inputValue(),
      "19",
    );
    checks.push(
      "last page is reachable; Chinese/original/file search works; toggling and deleting the final row retain valid pagination",
    );

    await page.getByRole("button", { name: "重复检测", exact: true }).click();
    await page.getByText("发现 1 组重复项", { exact: true }).waitFor();
    await page.getByRole("button", { name: "检查更新", exact: true }).click();
    await page.getByRole("button", { name: "全部更新", exact: true }).click();
    await page
      .getByText("Mod 更新完成，旧文件已备份", { exact: true })
      .waitFor();
    const calls = await page.evaluate(() => window.__paginationQa.calls);
    for (const method of [
      "mods:toggle",
      "mods:remove",
      "mods:duplicates",
      "mods:updates",
      "mods:apply",
    ]) {
      const matching = calls.filter((call) => call.method === method);
      assert.equal(matching.length, 1, method);
      assert.equal(
        matching[0].payload.id,
        "fixture-112",
        `${method} targets selected instance`,
      );
    }
    checks.push(
      "duplicate detection and updates still act on the complete selected instance",
    );

    const versionSearch = page.getByLabel("搜索游戏版本", { exact: true });
    await versionSearch.fill("测试版本 122");
    await page
      .getByRole("button", { name: "测试版本 122 1.21.1 Fabric", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "还没有添加 Mod", exact: true })
      .waitFor();
    await versionSearch.fill("");
    await page.waitForFunction(
      () => document.querySelector('[aria-label="版本页码"]')?.value === "2",
    );
    assert.equal(
      await page.getByLabel("版本页码", { exact: true }).inputValue(),
      "2",
    );
    await page
      .getByRole("button", { name: "测试版本 112 1.21.1 Fabric", exact: true })
      .click();
    await page.waitForFunction(
      () => document.querySelectorAll(".mod-row").length === 50,
    );
    checks.push(
      "version search, selecting another isolated instance, and returning to the original preserve access to every version",
    );
    assert.deepEqual(
      await page.evaluate(() => window.__paginationQa.unexpected),
      [],
    );
    assert.deepEqual(errors, []);
    const output = path.join(root, "test-results", "instances-pagination");
    await fs.mkdir(output, { recursive: true });
    const report = {
      passed: true,
      checks,
      pageErrors: errors,
      limitation:
        "Frontend fixture; actual game files, network Mod updates and Minecraft launch were not exercised.",
    };
    await fs.writeFile(
      path.join(output, "report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
