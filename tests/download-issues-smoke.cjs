const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright-core");

// Actual React UI, with isolated IPC fixtures only. No Electron profile, account,
// game directory or external service is touched.
(async () => {
  const root = path.resolve(__dirname, "..");
  const output = path.join(root, "test-results", "download-issues");
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
  const checks = [];
  const errors = [];
  let browser;
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
      const state = {
        gameDirectories: [],
        instances: [],
        accounts: [],
        settings: {
          theme: "light",
          downloadConcurrency: 8,
          memoryMode: "auto",
          memoryMb: 4096,
          javaPath: "",
          microsoftClientId: "",
          closeOnLaunch: false,
        },
        system: {
          totalMemoryMb: 8192,
          freeMemoryMb: 4096,
          platform: "Windows · x64",
          version: "download-qa",
          dataDir: "fixture-only",
          gameRoot: "fixture-only",
          defaultGameRoot: "fixture-only",
        },
      };
      const qa = (window.__downloadQa = {
        calls: [],
        tasks: {},
        emit(task) {
          this.tasks[task.id] = task;
          for (const listener of listeners)
            listener({ type: "task", task: structuredClone(task) });
        },
      });
      window.launcher = {
        async call(method, payload = {}) {
          qa.calls.push({ method, payload });
          if (method === "state") return structuredClone(state);
          if (
            ["skin-library:list", "mod-favorites:list", "versions"].includes(
              method,
            )
          )
            return [];
          if (method === "download:files" && payload.id === "metadata-qa")
            return {
              taskId: payload.id,
              offset: payload.offset,
              total: 1,
              files: [
                {
                  id: "0",
                  name: "version.json",
                  status: "completed",
                  receivedBytes: 1024,
                  totalBytes: 1024,
                },
              ],
            };
          if (method === "download:files")
            return {
              taskId: payload.id,
              offset: payload.offset,
              total: 55,
              files: Array.from(
                { length: Math.min(payload.limit, 55 - payload.offset) },
                (_, index) => ({
                  id: String(index + payload.offset),
                  name: `library-${String(index + payload.offset).padStart(2, "0")}.jar`,
                  status:
                    index + payload.offset < 10
                      ? "completed"
                      : index + payload.offset === 10
                        ? "downloading"
                        : "queued",
                  receivedBytes: index + payload.offset < 10 ? 1048576 : 0,
                  totalBytes: 1048576,
                }),
              ),
            };
          if (method === "download:control") {
            const task = qa.tasks[payload.id];
            qa.emit({
              ...task,
              status:
                payload.action === "pause"
                  ? "paused"
                  : payload.action === "resume"
                    ? "running"
                    : "cancelled",
              controllable: payload.action !== "cancel",
            });
            return true;
          }
          if (method === "download:source") {
            const task = qa.tasks[payload.id];
            qa.emit({ ...task, source: payload.source });
            return true;
          }
          throw new Error(`Unexpected download QA call: ${method}`);
        },
        onEvent(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        window() {},
      };
    });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
    await page
      .getByRole("heading", { name: "开始游戏", exact: true })
      .waitFor();
    await page.evaluate(() => {
      const qa = window.__downloadQa;
      qa.emit({
        id: "plan-qa",
        title: "安装 Minecraft 1.21.1 / Fabric",
        status: "running",
        progress: 0,
        controllable: true,
        source: "official",
        download: {
          kind: "plan",
          progressMode: "indeterminate",
          resourceName: "Minecraft 1.21.1",
          targetInstanceName: "QA 隔离实例",
          totalFiles: 56,
          completedFiles: 11,
          stages: [
            {
              id: "metadata",
              title: "解析版本与加载器",
              status: "completed",
              totalFiles: 1,
              completedFiles: 1,
            },
            {
              id: "libraries",
              title: "游戏本体与运行库",
              status: "running",
              totalFiles: 55,
              completedFiles: 10,
            },
            { id: "assets", title: "游戏资源", status: "pending" },
            { id: "java", title: "Java 运行环境", status: "pending" },
          ],
          activeFiles: [
            {
              id: "10",
              name: "fabric-loader-0.16.10.jar",
              status: "downloading",
              receivedBytes: 524288,
              totalBytes: 1048576,
            },
          ],
        },
      });
      qa.emit({
        id: "metadata-qa",
        title: "版本元数据",
        status: "completed",
        progress: 100,
        controllable: false,
        source: "official",
        download: {
          kind: "files",
          progressMode: "bytes",
          planId: "plan-qa",
          stageId: "metadata",
          resourceName: "版本元数据",
          targetInstanceName: "QA 隔离实例",
          totalFiles: 1,
          completedFiles: 1,
          receivedBytes: 1024,
          totalBytes: 1024,
          activeFiles: [],
        },
      });
      qa.emit({
        id: "libraries-qa",
        title: "游戏本体与运行库",
        status: "running",
        progress: 25,
        controllable: true,
        source: "official",
        download: {
          kind: "files",
          progressMode: "bytes",
          planId: "plan-qa",
          stageId: "libraries",
          resourceName: "Fabric Loader 与游戏本体",
          targetInstanceName: "QA 隔离实例",
          totalFiles: 55,
          completedFiles: 10,
          receivedBytes: 8388608,
          totalBytes: 33554432,
          activeFiles: [
            {
              id: "10",
              name: "fabric-loader-0.16.10.jar",
              status: "downloading",
              receivedBytes: 524288,
              totalBytes: 1048576,
            },
          ],
        },
      });
    });
    await page.getByRole("button", { name: "下载任务", exact: true }).click();
    await page
      .getByRole("heading", { name: "下载任务", exact: true })
      .waitFor();
    assert.equal(
      await page.locator(".download-task-card").count(),
      1,
      "a plan and its batches share one top-level card",
    );
    for (const title of [
      "解析版本与加载器",
      "游戏本体与运行库",
      "游戏资源",
      "Java 运行环境",
    ])
      await page.getByRole("button", { name: new RegExp(title) }).waitFor();
    assert.equal(await page.getByText("待解析", { exact: true }).count(), 2);
    assert.ok(
      (await page.locator(".download-task-card").innerText()).includes(
        "目标实例：QA 隔离实例",
      ),
    );
    assert.ok(
      (await page.locator(".download-task-card").innerText()).includes(
        "fabric-loader-0.16.10.jar",
      ),
    );
    checks.push(
      "all expected stages, unresolved stages, target instance and active filenames are visible immediately; batches are grouped",
    );
    await page.mouse.move(1100, 50);
    await page.screenshot({ path: path.join(output, "01-plan.png") });

    await page.getByRole("button", { name: "清除已完成", exact: true }).click();
    const completedStage = page
      .locator(".download-stage")
      .filter({ hasText: "解析版本与加载器" });
    await completedStage.locator(".download-stage-heading").click();
    await completedStage
      .getByRole("button", { name: "查看全部 1 个文件", exact: true })
      .click();
    await completedStage.getByText("version.json", { exact: true }).waitFor();
    assert.equal(
      await completedStage.locator(".download-file-list li").count(),
      1,
    );
    assert.ok(
      await page.evaluate(() =>
        window.__downloadQa.calls.some(
          (entry) =>
            entry.method === "download:files" &&
            entry.payload.id === "metadata-qa",
        ),
      ),
    );
    assert.equal(await page.locator(".download-task-card").count(), 1);
    checks.push(
      "clearing completed tasks preserves the completed child batches of an active plan and their expandable file lists",
    );
    await page.screenshot({
      path: path.join(output, "04-completed-stage-kept.png"),
    });
    await completedStage.locator(".download-stage-heading").click();

    await page.getByRole("button", { name: /游戏本体与运行库/ }).click();
    await page
      .getByRole("button", { name: "查看全部 55 个文件", exact: true })
      .click();
    await page.getByText("library-00.jar", { exact: true }).waitFor();
    assert.equal(await page.locator(".download-file-list li").count(), 50);
    assert.ok(
      (await page.locator(".download-file-task.nested").innerText()).includes(
        "字节进度 25%",
      ),
    );
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await page.getByText("library-50.jar", { exact: true }).waitFor();
    assert.equal(await page.locator(".download-file-list li").count(), 5);
    assert.equal(
      await page
        .getByRole("button", { name: "下一页", exact: true })
        .isDisabled(),
      true,
    );
    const requests = await page.evaluate(() =>
      window.__downloadQa.calls.filter(
        (entry) => entry.method === "download:files",
      ),
    );
    assert.ok(
      requests.some(
        (entry) =>
          entry.payload.id === "libraries-qa" &&
          entry.payload.offset === 50 &&
          entry.payload.limit === 50,
      ),
    );
    checks.push(
      "known files expand through bounded 50-file IPC pages; bytes and file counts are labelled separately",
    );
    await page.screenshot({ path: path.join(output, "02-files.png") });

    const parentControls = page.locator(
      ".download-task-card > .download-task-controls",
    );
    await parentControls.getByRole("combobox").selectOption("bmclapi");
    await parentControls
      .getByRole("button", { name: "暂停", exact: true })
      .click();
    await parentControls
      .getByRole("button", { name: "继续", exact: true })
      .waitFor();
    await parentControls
      .getByRole("button", { name: "继续", exact: true })
      .click();
    await parentControls
      .getByRole("button", { name: "暂停", exact: true })
      .waitFor();
    const controls = await page.evaluate(() =>
      window.__downloadQa.calls.filter((entry) =>
        ["download:source", "download:control"].includes(entry.method),
      ),
    );
    assert.ok(
      controls.some(
        (entry) =>
          entry.method === "download:source" &&
          entry.payload.id === "plan-qa" &&
          entry.payload.source === "bmclapi",
      ),
    );
    assert.deepEqual(
      controls
        .filter((entry) => entry.method === "download:control")
        .map((entry) => entry.payload),
      [
        { id: "plan-qa", action: "pause" },
        { id: "plan-qa", action: "resume" },
      ],
    );
    checks.push(
      "plan mirror selection and pause/resume buttons preserve their task IDs and control payloads",
    );

    await page.evaluate(() =>
      window.__downloadQa.emit({
        id: "unknown-qa",
        title: "下载未知长度的 Java",
        status: "running",
        progress: 0,
        controllable: true,
        source: "official",
        download: {
          kind: "files",
          progressMode: "files",
          resourceName: "Java 21 运行环境",
          targetInstanceName: "QA 隔离实例",
          totalFiles: 1,
          completedFiles: 0,
          receivedBytes: 1024,
          activeFiles: [
            {
              id: "0",
              name: "java-runtime.zip",
              status: "downloading",
              receivedBytes: 1024,
            },
          ],
        },
      }),
    );
    const unknown = page
      .locator(".download-task-card")
      .filter({ hasText: "Java 21 运行环境" });
    await unknown.getByText(/总大小未知/).waitFor();
    assert.ok(
      !(await unknown.innerText()).includes("%"),
      "unknown response lengths must not display a byte percentage",
    );
    assert.equal(
      await unknown.getByRole("progressbar").getAttribute("aria-valuenow"),
      null,
    );
    await page.setViewportSize({ width: 960, height: 640 });
    await page.evaluate(
      () => (document.documentElement.dataset.theme = "dark"),
    );
    await unknown.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, "03-compact-dark.png") });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    assert.equal(overflow, false);
    checks.push(
      "unknown total size uses an indeterminate bar with no fabricated percent; compact 960x640 dark layout has no horizontal overflow",
    );
    await unknown.getByRole("button", { name: "取消", exact: true }).click();
    assert.ok(
      await page.evaluate(() =>
        window.__downloadQa.calls.some(
          (entry) =>
            entry.method === "download:control" &&
            entry.payload.id === "unknown-qa" &&
            entry.payload.action === "cancel",
        ),
      ),
    );
    checks.push("cancel keeps the standalone download task identity");
    assert.deepEqual(errors, []);
    const report = {
      passed: checks.length,
      checks,
      pageErrors: errors,
      scope:
        "Controlled frontend fixture; no real accounts, game data or external download services",
      screenshots: [
        "01-plan.png",
        "02-files.png",
        "03-compact-dark.png",
        "04-completed-stage-kept.png",
      ],
    };
    await fs.writeFile(
      path.join(output, "report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
