const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright-core");

// The real React UI receives controlled updater events. Download, restart and
// release-page actions are recorded locally and never access the network.
(async () => {
  const root = path.resolve(__dirname, "..");
  const output = path.join(root, "test-results", "launcher-update-popup");
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
  const checks = [],
    screenshots = [],
    pageErrors = [];
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
    for (const [width, height] of [
      [1120, 760],
      [960, 640],
    ]) {
      for (const theme of ["light", "dark"]) {
        const page = await browser.newPage({ viewport: { width, height } });
        page.on("pageerror", (error) => pageErrors.push(error.message));
        await page.route("**/*", (route) =>
          new URL(route.request().url()).hostname === "127.0.0.1"
            ? route.continue()
            : route.abort(),
        );
        await page.addInitScript(
          ({ theme }) => {
            const listeners = new Set();
            const state = {
              gameDirectories: [],
              instances: [],
              accounts: [],
              settings: {
                theme,
                interfacePerformance: "efficient",
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
                version: "popup-qa",
                dataDir: "fixture-only",
                gameRoot: "fixture-only",
                defaultGameRoot: "fixture-only",
              },
            };
            const qa = (window.__updatePopupQa = {
              state,
              calls: [],
              unexpected: [],
              pendingSnapshots: [],
              holdInitialSnapshot: true,
              update: {
                status: "current",
                currentVersion: "0.6.3",
                latestVersion: "9.0.0",
                hasUpdate: true,
                releaseUrl: "https://example.invalid/release",
                supported: true,
              },
              emit(status, extra = {}) {
                qa.update = { ...qa.update, status, ...extra };
                for (const listener of listeners)
                  listener({
                    type: "launcher-update",
                    state: structuredClone(qa.update),
                  });
              },
            });
            window.launcher = {
              async call(method) {
                if (method === "state") return structuredClone(state);
                if (method === "store:stats")
                  return { objects: 0, bytes: 0, root: "fixture-only" };
                if (method === "update:state") {
                  const snapshot = structuredClone(qa.update);
                  if (qa.holdInitialSnapshot)
                    return new Promise((resolve) =>
                      qa.pendingSnapshots.push(() => resolve(snapshot)),
                    );
                  return snapshot;
                }
                qa.calls.push(method);
                if (method === "update:open") return true;
                if (method === "update:download") {
                  qa.emit("downloading", {
                    receivedBytes: 50,
                    totalBytes: 100,
                  });
                  return structuredClone(qa.update);
                }
                if (method === "update:install") {
                  qa.emit("installing");
                  return structuredClone(qa.update);
                }
                if (method === "update:check") {
                  qa.emit("available", { hasUpdate: true });
                  return structuredClone(qa.update);
                }
                qa.unexpected.push(method);
                throw new Error(`Unexpected popup fixture call: ${method}`);
              },
              onEvent(listener) {
                listeners.add(listener);
                return () => listeners.delete(listener);
              },
            };
          },
          { theme },
        );
        await page.goto(
          `http://127.0.0.1:${server.httpServer.address().port}/`,
        );
        const dock = page.locator("aside.sidebar");
        const home = dock.getByRole("button", {
          name: "开始游戏",
          exact: true,
        });
        await home.waitFor();
        assert.equal(await page.locator(".launcher-update-popup").count(), 0);
        await home.focus();
        await page.waitForFunction(
          () => window.__updatePopupQa.pendingSnapshots.length > 0,
        );
        const raceStatus = theme === "light" ? "ready" : "error";
        await page.evaluate(
          (status) =>
            window.__updatePopupQa.emit(status, {
              message: "较新的更新事件已经抵达。",
              lastAttempt:
                status === "error"
                  ? {
                      id: "startup-race-failure",
                      status: "failed",
                      version: "9.0.0",
                      completedAt: "2026-10-28T12:29:00.000Z",
                      message: "恢复的上次更新失败记录。",
                    }
                  : undefined,
            }),
          raceStatus,
        );
        const popup = page.locator(".launcher-update-popup");
        await popup.waitFor();
        await page.evaluate(() => {
          const qa = window.__updatePopupQa;
          qa.holdInitialSnapshot = false;
          qa.pendingSnapshots.splice(0).forEach((resolve) => resolve());
        });
        await dock
          .getByRole("button", { name: "启动器设置", exact: true })
          .click();
        if (raceStatus === "ready") {
          await page
            .locator(".launcher-update-panel")
            .getByRole("button", { name: "重启更新", exact: true })
            .waitFor();
        } else {
          await page
            .locator(
              ".launcher-update-panel .launcher-update-attempt[data-outcome='failed']",
            )
            .waitFor();
        }
        await home.click();
        await popup.waitFor();
        checks.push(
          `${width}x${height} ${theme}: delayed initial current snapshot cannot overwrite a newer ${raceStatus} event`,
        );
        const longMessage =
          Array.from(
            { length: 80 },
            (_, index) =>
              `更新说明 ${index + 1}：修复界面与资源下载，保留账号及独立版本目录。`,
          ).join("\n") +
          "\nhttps://example.invalid/" +
          "long-path".repeat(100);
        await page.evaluate(
          (message) =>
            window.__updatePopupQa.emit("available", {
              message,
              lastAttempt: undefined,
            }),
          longMessage,
        );
        await popup.waitFor();
        assert.equal(
          await home.evaluate((element) => document.activeElement === element),
          true,
          "opening update popup must not move keyboard focus",
        );
        assert.equal(await popup.getAttribute("aria-modal"), null);
        assert.equal(
          await popup.evaluate(
            (element) => element.parentElement.parentElement === document.body,
          ),
          true,
          "popup is portaled outside app clipping/stacking context",
        );

        async function inspect(label, longBody = true) {
          const layout = await popup.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const body = element.querySelector(".launcher-update-popup-body");
            const footer = element
              .querySelector(".launcher-update-popup-footer")
              .getBoundingClientRect();
            const buttons = [...element.querySelectorAll("button")].map(
              (button) => {
                const box = button.getBoundingClientRect();
                return {
                  label:
                    button.getAttribute("aria-label") || button.textContent,
                  visible:
                    box.width > 0 &&
                    box.height > 0 &&
                    box.left >= rect.left &&
                    box.right <= rect.right + 1 &&
                    box.top >= rect.top &&
                    box.bottom <= rect.bottom + 1 &&
                    box.bottom <= innerHeight,
                };
              },
            );
            return {
              top: rect.top,
              bottom: rect.bottom,
              left: rect.left,
              right: rect.right,
              height: rect.height,
              viewportWidth: innerWidth,
              viewportHeight: innerHeight,
              bodyScrollable: body.scrollHeight > body.clientHeight + 1,
              bodyOverflowX: body.scrollWidth > body.clientWidth + 1,
              footerVisible:
                footer.top >= rect.top && footer.bottom <= rect.bottom + 1,
              buttons,
            };
          });
          assert(
            layout.top >= 60 && layout.top < 100,
            `${label}: popup stays near top below titlebar`,
          );
          assert(
            layout.bottom <= height &&
              layout.left >= 0 &&
              layout.right <= width,
          );
          assert(
            layout.height <= 381 && layout.footerVisible,
            JSON.stringify(layout),
          );
          assert(
            layout.buttons.length > 0 &&
              layout.buttons.every((button) => button.visible),
            JSON.stringify(layout),
          );
          assert.equal(
            layout.bodyOverflowX,
            false,
            `${label}: long URLs must wrap`,
          );
          if (longBody)
            assert(
              layout.bodyScrollable,
              `${label}: long notes scroll independently`,
            );
          const top = layout.top;
          await popup
            .locator(".launcher-update-popup-body")
            .evaluate((element) => (element.scrollTop = element.scrollHeight));
          assert.equal(
            (await popup.boundingBox()).y,
            top,
            `${label}: body scrolling does not move popup`,
          );
          const screenshot = path.join(
            output,
            `${width}-${theme}-${label}.png`,
          );
          await page.screenshot({ path: screenshot, animations: "disabled" });
          screenshots.push(screenshot);
        }
        await inspect("available");
        await popup
          .getByRole("button", { name: "下载更新", exact: true })
          .click();
        await popup
          .getByRole("progressbar", { name: "启动器更新下载进度", exact: true })
          .waitFor();
        await inspect("downloading");
        await popup
          .getByRole("button", { name: "关闭更新提示", exact: true })
          .click();
        await page.evaluate(() =>
          window.__updatePopupQa.emit("downloading", { receivedBytes: 70 }),
        );
        assert.equal(
          await popup.count(),
          0,
          "progress packets do not reopen dismissed popup",
        );
        await page.evaluate(() => window.__updatePopupQa.emit("ready"));
        await popup
          .getByRole("button", { name: "重启更新", exact: true })
          .waitFor();
        await inspect("ready");
        await popup
          .getByRole("button", { name: "重启更新", exact: true })
          .click();
        await popup.getByText("正在应用更新…", { exact: true }).waitFor();
        await inspect("installing");
        await page.evaluate(() => window.__updatePopupQa.emit("error"));
        await popup
          .getByRole("button", { name: "重试下载", exact: true })
          .waitFor();
        await inspect("error");
        await popup
          .getByRole("button", { name: "重试下载", exact: true })
          .click();
        await page.waitForFunction(
          () =>
            window.__updatePopupQa.calls.filter(
              (method) => method === "update:download",
            ).length === 2,
        );
        await page.evaluate(() =>
          window.__updatePopupQa.emit("error", {
            latestVersion: "9.0.1",
            hasUpdate: false,
            lastAttempt: {
              id: "failed-attempt-1",
              status: "failed",
              version: "9.0.1",
              completedAt: "2026-10-28T12:30:00.000Z",
              message: "应用更新失败：目标程序仍被占用。",
              logPath: "C:/fixture-only/update-failed.log",
            },
          }),
        );
        await popup
          .locator(".launcher-update-attempt[data-outcome='failed']")
          .waitFor();
        await inspect("restored-failure");
        await popup
          .getByRole("button", { name: "重新检查", exact: true })
          .click();
        await popup
          .getByRole("button", { name: "下载更新", exact: true })
          .waitFor();
        await page.evaluate(() =>
          window.__updatePopupQa.emit("available", {
            latestVersion: "9.0.2",
            supported: false,
          }),
        );
        await popup
          .getByRole("button", { name: "前往下载", exact: true })
          .click();
        await inspect("unsupported");
        await page.evaluate(() =>
          window.__updatePopupQa.emit("error", {
            supported: true,
            hasUpdate: false,
            lastAttempt: {
              id: "rollback-attempt-2",
              status: "rolled-back",
              version: "9.0.2",
              completedAt: "2026-10-28T12:31:00.000Z",
              message: "新版启动确认超时，已恢复原程序。",
              logPath: "C:/fixture-only/update-rollback.log",
            },
          }),
        );
        await popup
          .locator(".launcher-update-attempt[data-outcome='rolled-back']")
          .waitFor();
        await popup
          .getByRole("button", { name: "重新检查", exact: true })
          .waitFor();
        await inspect("rolled-back");

        await dock
          .getByRole("button", { name: "启动器设置", exact: true })
          .click();
        await page.locator(".launcher-update-panel").waitFor();
        assert.equal(
          await popup.count(),
          0,
          "settings use their retained update card",
        );
        await page.evaluate(() =>
          window.__updatePopupQa.emit("ready", {
            latestVersion: "9.0.3",
            supported: true,
            lastAttempt: undefined,
          }),
        );
        await page
          .locator(".launcher-update-panel")
          .getByRole("button", { name: "重启更新", exact: true })
          .waitFor();
        await home.click();
        await popup
          .getByRole("button", { name: "重启更新", exact: true })
          .waitFor();
        await popup
          .getByRole("button", { name: "关闭更新提示", exact: true })
          .focus();
        await page.keyboard.press("Escape");
        await popup.waitFor({ state: "detached" });
        await dock
          .getByRole("button", { name: "启动器设置", exact: true })
          .click();
        await page.locator(".launcher-update-panel").waitFor();
        await home.click();
        assert.equal(
          await popup.count(),
          0,
          "dismissal survives page navigation",
        );
        await page.evaluate(() =>
          window.__updatePopupQa.emit("error", {
            hasUpdate: false,
            lastAttempt: undefined,
            message: "网络检查暂时不可用",
          }),
        );
        await dock
          .getByRole("button", { name: "启动器设置", exact: true })
          .click();
        const settingsCard = page.locator(".launcher-update-panel");
        await settingsCard
          .getByText("网络检查暂时不可用", { exact: true })
          .waitFor();
        await settingsCard
          .getByRole("button", { name: "检查更新", exact: true })
          .waitFor();
        await home.click();
        assert.equal(
          await popup.count(),
          0,
          "a transient background check failure does not interrupt the main page",
        );
        for (const id of ["fresh-failure-3", "fresh-failure-4"]) {
          await page.evaluate(
            (id) =>
              window.__updatePopupQa.emit("error", {
                lastAttempt: {
                  id,
                  status: "failed",
                  version: "9.0.3",
                  completedAt: "2026-10-28T12:32:00.000Z",
                  message: "上次安装失败，保留当前可用版本。",
                },
              }),
            id,
          );
          await popup
            .locator(".launcher-update-attempt[data-outcome='failed']")
            .waitFor();
          await popup
            .getByRole("button", { name: "关闭更新提示", exact: true })
            .click();
        }
        await page.evaluate(() => window.__updatePopupQa.emit("current"));
        await dock
          .getByRole("button", { name: "启动器设置", exact: true })
          .click();
        await settingsCard
          .locator(".launcher-update-attempt[data-outcome='failed']")
          .waitFor();
        await page.evaluate(() =>
          window.__updatePopupQa.emit("current", {
            lastAttempt: {
              id: "installed-attempt-5",
              status: "installed",
              version: "9.0.3",
              completedAt: "2026-10-28T12:33:00.000Z",
              message: "更新安装完成并已确认启动。",
            },
          }),
        );
        await settingsCard
          .locator(".launcher-update-attempt[data-outcome='installed']")
          .waitFor();
        await home.click();
        assert.equal(
          await popup.count(),
          0,
          "successful update history stays available in settings without an interrupting popup",
        );
        const calls = await page.evaluate(() => window.__updatePopupQa.calls);
        for (const method of [
          "update:download",
          "update:install",
          "update:check",
          "update:open",
        ])
          assert(calls.includes(method), `${method} remains connected`);
        assert.deepEqual(
          await page.evaluate(() => window.__updatePopupQa.unexpected),
          [],
        );
        checks.push(
          `${width}x${height} ${theme}: top portal, independent long-note scrolling, visible close/progress/actions, all updater actions, no focus stealing, dismiss/reopen lifecycle, persistent failure/rollback/success history, quiet transient network failure, retained settings card`,
        );
        await page.close();
      }
    }
    assert.deepEqual(pageErrors, []);
    const report = {
      passed: true,
      checks,
      screenshots,
      pageErrors,
      limitation:
        "Controlled frontend updater events; real GitHub downloads, executable replacement and restart were not performed.",
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
