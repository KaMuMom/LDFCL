const { _electron: electron } = require("playwright-core");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const AdmZip = require("adm-zip");

(async () => {
  const root = path.resolve(__dirname, "..");
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "LDFCL-improvements-qa-"),
  );
  const output = path.join(root, "test-results");
  await fs.mkdir(output, { recursive: true });
  const gameRoot = path.join(dataDir, ".minecraft");
  const instance = {
    id: "improvements-a",
    name: "改进功能验证实例",
    version: "1.21.1",
    loader: "vanilla",
    gameDirectoryId: "improvements-root",
    versionDirectory: "improvements-a",
    createdAt: new Date().toISOString(),
    gameSettings: {},
    memoryMb: 512,
    javaPath: path.join(dataDir, "missing-java.exe"),
  };
  const other = {
    ...instance,
    id: "improvements-b",
    name: "隔离对照实例",
    versionDirectory: "improvements-b",
    memoryMb: undefined,
    javaPath: undefined,
  };
  await fs.writeFile(
    path.join(dataDir, "launcher.json"),
    JSON.stringify({
      instances: [instance, other],
      gameDirectories: [
        {
          id: instance.gameDirectoryId,
          name: "改进功能测试目录",
          path: gameRoot,
          layout: "standard",
        },
      ],
      selectedGameDirectoryId: instance.gameDirectoryId,
      selectedInstanceId: instance.id,
      settings: { memoryMode: "manual", memoryMb: 4096 },
    }),
  );
  const instanceDir = path.join(
    gameRoot,
    "versions",
    instance.versionDirectory,
  );
  const otherDir = path.join(gameRoot, "versions", other.versionDirectory);
  for (const item of [instance, other]) {
    const directory = path.join(gameRoot, "versions", item.versionDirectory);
    for (const sub of [
      "mods",
      "config",
      "saves/world",
      "resourcepacks",
      "shaderpacks",
    ])
      await fs.mkdir(path.join(directory, sub), { recursive: true });
    await fs.writeFile(
      path.join(directory, `${item.versionDirectory}.json`),
      JSON.stringify({
        id: item.versionDirectory,
        type: "release",
        clientVersion: item.version,
        mainClass: "net.minecraft.client.main.Main",
        libraries: [],
        javaVersion: { majorVersion: 21 },
      }),
    );
    await fs.writeFile(
      path.join(directory, "options.txt"),
      'renderDistance:12\nresourcePacks:["vanilla"]\n',
    );
    await fs.writeFile(
      path.join(directory, "config", "smoke.txt"),
      "before-snapshot",
    );
    await fs.writeFile(
      path.join(directory, "saves", "world", "level.dat"),
      "untouched-world",
    );
  }
  for (const [file, id, depends] of [
    ["needs.jar", "needs", { helper: "*" }],
    ["helper.jar.disabled", "helper", {}],
  ]) {
    const mod = new AdmZip();
    mod.addFile(
      "fabric.mod.json",
      Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          id,
          name: id,
          version: "1.0",
          depends,
        }),
      ),
    );
    await fs.writeFile(path.join(instanceDir, "mods", file), mod.toBuffer());
  }
  const resource = new AdmZip();
  resource.addFile(
    "pack.mcmeta",
    Buffer.from(
      JSON.stringify({
        pack: { pack_format: 34, description: "UI smoke resource" },
      }),
    ),
  );
  await fs.writeFile(
    path.join(instanceDir, "resourcepacks", "qa-pack.zip"),
    resource.toBuffer(),
  );
  const crash = path.join(dataDir, "input-crash.txt");
  await fs.writeFile(
    crash,
    "java.lang.OutOfMemoryError: Java heap space\naccessToken=private-smoke-token\nC:\\Users\\PrivateSmoke\\Game\\latest.log\n",
  );
  const historicalAISettings = JSON.stringify({
    enabled: true,
    provider: "openai-compatible",
    baseUrl: "http://127.0.0.1:1/v1",
    model: "historical-ai-config-should-not-render",
    timeoutMs: 1000,
  });
  const historicalAISecrets = JSON.stringify({
    encryptedKey: "historical-placeholder-not-a-real-key",
  });
  await fs.writeFile(
    path.join(dataDir, "ai-settings.json"),
    historicalAISettings,
  );
  await fs.writeFile(
    path.join(dataDir, "ai-secrets.json"),
    historicalAISecrets,
  );
  const environment = { ...process.env, LDFCL_DATA_DIR: dataDir };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.LDFCL_AI_API_KEY;
  const executable =
    process.env.LDFCL_TEST_EXECUTABLE || process.env.LDFCL_TEST_EXE;
  const checks = [],
    errors = [];
  let app, page;
  const state = () => page.evaluate(() => window.launcher.call("state"));
  async function until(predicate, label = "state") {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const value = await state();
      if (predicate(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    throw Error(`${label} did not settle`);
  }
  async function untilCall(method, payload, predicate) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        const value = await page.evaluate(
          ({ method, payload }) => window.launcher.call(method, payload),
          { method, payload },
        );
        if (predicate(value)) return value;
      } catch {
        /* Mutations briefly hold the same instance lock. */
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw Error(`${method} did not settle`);
  }
  const nav = (name) =>
    page
      .locator("aside.sidebar")
      .getByRole("button", { name, exact: true })
      .click();
  try {
    app = await electron.launch({
      executablePath: executable || require("electron"),
      args: executable ? [] : [root],
      cwd: root,
      env: environment,
      timeout: 45000,
    });
    page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await page
      .getByRole("heading", { name: "开始游戏", exact: true })
      .waitFor();
    await app.evaluate(({ ipcMain }) => {
      const original = ipcMain._invokeHandlers.get("launcher:call");
      if (typeof original !== "function")
        throw Error("Launcher IPC handler missing");
      const audit = (globalThis.__ldfclDisabledAIQA = {
        aiCalls: [],
        shareCalls: [],
      });
      ipcMain.removeHandler("launcher:call");
      ipcMain.handle("launcher:call", async (event, method, payload) => {
        if (method.startsWith("ai:")) {
          audit.aiCalls.push(method);
          throw Error("Disabled AI UI attempted an AI request");
        }
        if (method === "diagnosis:share") {
          audit.shareCalls.push(method);
          throw Error("Disabled AI UI attempted a sharing preview");
        }
        const result = await original(event, method, payload);
        if (method === "diagnosis:list")
          return result.map((report) => ({
            ...report,
            ai: {
              status: "enhanced",
              provider: "mock",
              generatedAt: "2025-01-01T00:00:00.000Z",
              summary: "historical-ai-result-should-not-render",
              recommendations: ["historical-ai-advice-should-not-render"],
            },
          }));
        return result;
      });
    });
    assert.equal((await state()).system.gameRoot, gameRoot);
    await nav("游戏实例");
    await page.getByRole("button", { name: "健康与快照", exact: true }).click();
    const health = page.getByRole("region", {
      name: "实例健康检查",
      exact: true,
    });
    await health.getByRole("button", { name: "扫描", exact: true }).click();
    await health
      .getByText("指定 Java 与游戏要求不匹配", { exact: true })
      .waitFor();
    await health.getByText("缺少前置 helper", { exact: true }).waitFor();
    await health.getByRole("button", { name: "自动修复", exact: true }).click();
    await until(
      (value) =>
        value.settings.memoryMode === "auto" &&
        !value.instances.find((item) => item.id === instance.id).javaPath,
      "health fix",
    );
    await page
      .getByRole("status")
      .filter({ hasText: "自动修复完成" })
      .waitFor();
    await fs.access(path.join(instanceDir, "mods", "helper.jar"));
    assert.equal(
      (await state()).instances.find((item) => item.id === instance.id)
        .memoryMb,
      undefined,
    );
    checks.push(
      "health scan and auto-fix clicked in UI; invalid Java/low memory cleared and disabled required mod enabled",
    );

    const snapshotName = "UI 手动回滚验证";
    await page
      .getByRole("textbox", { name: "快照名称", exact: true })
      .fill(snapshotName);
    await page.getByRole("button", { name: "创建快照", exact: true }).click();
    const snapshotRow = page
      .locator(".snapshot-row")
      .filter({ hasText: snapshotName });
    await snapshotRow.waitFor();
    await fs.writeFile(
      path.join(instanceDir, "config", "smoke.txt"),
      "after-snapshot",
    );
    await snapshotRow
      .getByRole("button", { name: "查看回滚变更", exact: true })
      .click();
    const preview = page.getByRole("region", { name: "回滚预览", exact: true });
    await preview.waitFor();
    assert.match(await preview.textContent(), /smoke\.txt/);
    assert.equal(
      await fs.readFile(path.join(instanceDir, "config", "smoke.txt"), "utf8"),
      "after-snapshot",
    );
    await preview
      .getByRole("button", { name: "确认回滚", exact: true })
      .click();
    await preview.waitFor({ state: "hidden" });
    assert.equal(
      await fs.readFile(path.join(instanceDir, "config", "smoke.txt"), "utf8"),
      "before-snapshot",
    );
    assert.equal(
      await fs.readFile(
        path.join(instanceDir, "saves", "world", "level.dat"),
        "utf8",
      ),
      "untouched-world",
    );
    checks.push(
      "snapshot create, preview and explicit restore clicked in UI; preview makes no changes and restore preserves worlds",
    );

    await page.getByRole("button", { name: "资源与光影", exact: true }).click();
    const packRow = page
      .locator(".pack-manager-row")
      .filter({ hasText: "qa-pack.zip" });
    const packToggle = packRow.getByRole("checkbox");
    await packToggle.waitFor();
    assert.equal(await packToggle.isChecked(), false);
    await packToggle.click();
    await untilCall(
      "content-packs:list",
      { instanceId: instance.id, kind: "resourcepack" },
      (listing) =>
        listing.packs.some(
          (item) => item.name === "qa-pack.zip" && item.enabled,
        ),
    );
    assert.match(
      await fs.readFile(path.join(instanceDir, "options.txt"), "utf8"),
      /file\/qa-pack\.zip/,
    );
    await page.waitForFunction(
      () =>
        document.querySelector('.pack-manager-row input[type="checkbox"]')
          ?.checked === true,
    );
    await packToggle.click();
    await untilCall(
      "content-packs:list",
      { instanceId: instance.id, kind: "resourcepack" },
      (listing) =>
        listing.packs.some(
          (item) => item.name === "qa-pack.zip" && !item.enabled,
        ),
    );
    assert.equal(
      (await fs.readFile(path.join(otherDir, "options.txt"), "utf8")).includes(
        "qa-pack.zip",
      ),
      false,
    );
    checks.push(
      "resource pack enable/disable clicked in UI and writes only selected instance options",
    );

    await nav("启动器设置");
    for (const [theme, expected] of [
      ["dark", "dark"],
      ["light", "light"],
      ["system", "dark"],
    ]) {
      if (theme === "system") await page.emulateMedia({ colorScheme: "dark" });
      await page.getByLabel("主题", { exact: true }).selectOption(theme);
      await page.getByRole("button", { name: "保存设置", exact: true }).click();
      await until((value) => value.settings.theme === theme, `theme ${theme}`);
      await page.waitForFunction(
        (expected) => document.documentElement.dataset.theme === expected,
        expected,
      );
    }
    await page.emulateMedia({ colorScheme: "light" });
    await page.waitForFunction(
      () => document.documentElement.dataset.theme === "light",
    );
    checks.push(
      "light/dark/system selected and saved via UI; system follows live color-scheme changes",
    );

    const ai = page.getByRole("region", { name: "AI 服务设置", exact: true });
    const enabled = ai.getByRole("button", {
      name: "启用 AI 服务",
      exact: true,
    });
    assert.equal(await enabled.getAttribute("aria-pressed"), "false");
    assert.equal(await enabled.isDisabled(), true);
    await ai
      .getByRole("status")
      .filter({ hasText: "AI 功能暂未启用，当前仅保留界面预览。" })
      .waitFor();
    const baseline = (await state()).settings;
    const controls = ai.locator("input, select, textarea, button");
    assert.ok((await controls.count()) >= 10);
    for (const control of await controls.all())
      assert.equal(await control.isDisabled(), true);
    for (const input of await ai.locator("input, textarea").all())
      assert.equal(await input.inputValue(), "");
    assert.equal(
      (await ai.textContent()).includes(
        "historical-ai-config-should-not-render",
      ),
      false,
    );
    await ai.evaluate((section) => {
      for (const button of section.querySelectorAll("button")) button.click();
    });
    assert.deepEqual((await state()).settings, baseline);
    await ai.locator(".ai-suggestion").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(output, "improvements-ai-preview.png"),
    });
    checks.push(
      "AI settings is a static disabled preview, ignores historical enabled settings and leaves game configuration unchanged",
    );
    await page.screenshot({
      path: path.join(output, "improvements-ai-settings.png"),
      fullPage: false,
    });

    const imported = await page.evaluate(
      async ({ id, file }) =>
        window.launcher.call("diagnosis:import", { instanceId: id, file }),
      { id: instance.id, file: crash },
    );
    assert.equal(imported.category, "memory");
    assert.equal(
      JSON.stringify(imported).includes("private-smoke-token"),
      false,
    );
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      for (let i = 0; i < 510; i++)
        window.webContents.send("launcher:event", {
          type: "log",
          instanceId: "improvements-a",
          line: `UI smoke line ${i}`,
        });
    });
    await nav("运行日志");
    const console = page.getByLabel("最近500行游戏日志", { exact: true });
    await page.waitForFunction(() =>
      document
        .querySelector(".diagnostic-console")
        ?.textContent?.includes("UI smoke line 509"),
    );
    const lines = (await console.textContent()).split("\n");
    assert.equal(lines.length, 500);
    assert.equal(lines[0], "UI smoke line 10");
    assert.equal(lines.at(-1), "UI smoke line 509");
    await page.getByRole("button", { name: "复制日志", exact: true }).click();
    await page
      .getByRole("status")
      .filter({ hasText: "已复制到剪贴板" })
      .waitFor();
    const clipboardText = await app.evaluate(({ clipboard }) =>
      clipboard.readText(),
    );
    assert.equal(
      clipboardText.replace(/\r\n/g, "\n") === lines.join("\n"),
      true,
      `Clipboard must contain the 500 visible log lines (actual ${clipboardText.length}, expected ${lines.join("\n").length} characters)`,
    );
    await page.getByRole("tab", { name: /崩溃诊断/ }).click();
    await page
      .getByRole("heading", { name: "游戏或 Java 可用内存不足", exact: true })
      .waitFor();
    const enhancement = page.getByRole("button", {
      name: "AI 增强建议",
      exact: true,
    });
    assert.equal(await enhancement.isDisabled(), true);
    assert.equal(
      await enhancement.getAttribute("title"),
      "AI 功能暂未启用，当前仅保留界面预览。",
    );
    assert.equal(await page.locator(".diagnostic-ai-result").count(), 0);
    assert.equal(
      (await page.locator(".diagnostic-report").textContent()).includes(
        "historical-ai-result-should-not-render",
      ),
      false,
    );
    assert.equal(
      await page.getByRole("dialog", { name: "确认发送脱敏诊断" }).count(),
      0,
    );
    assert.equal(
      (await page.locator(".diagnostic-report").textContent()).includes(
        "private-smoke-token",
      ),
      false,
    );
    await app.evaluate(({ clipboard }) => clipboard.writeText(""));
    await page.getByRole("button", { name: "复制诊断", exact: true }).click();
    await page
      .getByRole("status")
      .filter({ hasText: "已复制到剪贴板" })
      .waitFor();
    const copiedDiagnosis = JSON.parse(
      await app.evaluate(({ clipboard }) => clipboard.readText()),
    );
    assert.equal(copiedDiagnosis.id, imported.id);
    assert.equal("ai" in copiedDiagnosis, false);
    assert.equal(
      JSON.stringify(copiedDiagnosis).includes("private-smoke-token"),
      false,
    );
    const aiAudit = await app.evaluate(() => globalThis.__ldfclDisabledAIQA);
    assert.deepEqual(aiAudit, { aiCalls: [], shareCalls: [] });
    assert.equal(
      await fs.readFile(path.join(dataDir, "ai-settings.json"), "utf8"),
      historicalAISettings,
    );
    assert.equal(
      await fs.readFile(path.join(dataDir, "ai-secrets.json"), "utf8"),
      historicalAISecrets,
    );
    checks.push(
      "logs retain and copy the latest 500 lines; local diagnosis and copy work, old AI results are hidden and excluded from copy, zero AI or sharing-preview calls",
    );
    await page.evaluate(() => {
      document.querySelector("main.main-content").scrollTop = 0;
    });
    await page.screenshot({
      path: path.join(output, "improvements-diagnosis.png"),
      fullPage: false,
    });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(960, 640),
    );
    await page.evaluate(() => {
      document.querySelector("main.main-content").scrollTop = 0;
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({
      path: path.join(output, "improvements-diagnosis-960x640.png"),
      fullPage: false,
    });
    assert.deepEqual(errors, []);
    const result = {
      passed: true,
      checks,
      pageErrors: errors,
      dataDir,
      gameLaunched: false,
      remoteAIInvoked: false,
      aiCalls: aiAudit.aiCalls,
      sharingPreviewCalls: aiAudit.shareCalls,
    };
    await fs.writeFile(
      path.join(output, "improvements-smoke.json"),
      JSON.stringify(result, null, 2),
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    if (page)
      await page
        .screenshot({ path: path.join(output, "improvements-failure.png") })
        .catch(() => {});
    throw error;
  } finally {
    if (app) await app.close().catch(() => {});
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
