const { _electron: electron } = require("playwright-core");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");

// Real Electron/IPC/React; synthetic TEMP roots only. The game process is
// deliberately simulated to exercise a successful spawn followed by failed
// record persistence without accessing any account or installed game.
(async () => {
  const project = path.resolve(__dirname, "..");
  const workspace = await fs.mkdtemp(
    path.join(os.tmpdir(), "LDFCL-issue-recovery-"),
  );
  const dataDir = path.join(workspace, "data");
  const custom = path.join(workspace, "旧目录 哈哈😄", ".minecraft");
  const dir = path.join(custom, "versions", "1.21.1");
  const output = path.join(project, "test-results", "issue-recovery");
  const checks = [],
    errors = [];
  let active;
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(
      path.join(dir, "1.21.1.json"),
      JSON.stringify({
        id: "1.21.1",
        mainClass: "net.minecraft.client.main.Main",
        libraries: [],
        javaVersion: { majorVersion: 21 },
      }),
    );
    await fs.writeFile(path.join(dir, "user-marker.txt"), "preserve");
    const env = { ...process.env, LDFCL_DATA_DIR: dataDir };
    delete env.ELECTRON_RUN_AS_NODE;
    const executable = process.env.LDFCL_TEST_EXE;
    active = await electron.launch({
      executablePath: executable || require("electron"),
      args: executable ? [] : [project],
      env,
      timeout: 45000,
    });
    const page = await active.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await page
      .getByRole("heading", { name: "开始游戏", exact: true })
      .waitFor();
    const call = (method, payload) =>
      page.evaluate(
        ({ method, payload }) => window.launcher.call(method, payload),
        { method, payload },
      );
    const initial = await call("state");
    const added = await call("game-directory:add", { path: custom });
    const id = added.selectedGameDirectoryId;
    await call("game-directory:select", {
      id: initial.selectedGameDirectoryId,
    });
    const moved = path.join(workspace, "新位置 中文😄");
    await fs.rename(path.dirname(custom), moved);
    const newPath = path.join(moved, ".minecraft");
    await page.reload();
    await page.getByRole("button", { name: "启动器设置", exact: true }).click();
    const row = page.locator('[data-game-directory-id="' + id + '"]');
    await row.getByText("目录不可用", { exact: true }).waitFor();
    assert.equal(
      await row
        .getByRole("button", { name: "使用目录", exact: true })
        .isDisabled(),
      true,
    );
    assert.equal(
      await row
        .getByRole("button", { name: "打开目录", exact: true })
        .isDisabled(),
      true,
    );
    await assert.rejects(fs.access(path.dirname(custom)), { code: "ENOENT" });
    checks.push("失效目录标记与禁用操作，不重建已移动路径");
    await page.screenshot({ path: path.join(output, "missing-directory.png") });
    await active.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selected],
      });
    }, newPath);
    await row.getByRole("button", { name: "重新定位", exact: true }).click();
    await row.getByText(newPath, { exact: true }).waitFor();
    await row.getByRole("button", { name: "使用目录", exact: true }).click();
    await row.getByText("当前使用", { exact: true }).waitFor();
    assert.equal(
      (await call("state")).selectedInstanceId,
      added.selectedInstanceId,
    );
    assert.equal(
      await fs.readFile(
        path.join(newPath, "versions/1.21.1/user-marker.txt"),
        "utf8",
      ),
      "preserve",
    );
    checks.push("原条目重新定位保留实例ID、选择和用户文件");
    for (const size of [
      { width: 1120, height: 760 },
      { width: 960, height: 640 },
    ]) {
      await active.evaluate(
        ({ BrowserWindow }, size) =>
          BrowserWindow.getAllWindows()[0].setSize(size.width, size.height),
        size,
      );
      await page.waitForTimeout(100);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth + 1,
        ),
        false,
      );
      await page.screenshot({
        path: path.join(output, "directory-" + size.width + ".png"),
      });
    }
    checks.push("默认和紧凑窗口目录管理布局");
    await call("account:offline", { name: "Regression" });
    await active.evaluate(({ app }) => {
      const load = process
        .getBuiltinModule("module")
        .createRequire(app.getAppPath() + "/package.json");
      const { GameService } = load("@ldfcl/core/services/game");
      const { Store } = load("@ldfcl/core/store");
      const originalSave = Store.prototype.save;
      let recordFailure = false;
      GameService.prototype.launch = async function (instance) {
        recordFailure = true;
        this.emit({
          type: "game",
          status: "started",
          instanceId: instance.id,
          pid: 12345,
        });
        return { pid: 12345 };
      };
      Store.prototype.save = function (...args) {
        if (recordFailure) {
          recordFailure = false;
          return Promise.reject(Error("controlled record failure"));
        }
        return originalSave.apply(this, args);
      };
    });
    await page.getByRole("button", { name: "开始游戏", exact: true }).click();
    await page.getByRole("button", { name: /启动游戏/ }).click();
    await page
      .getByRole("status")
      .filter({ hasText: "启动记录未能保存" })
      .waitFor();
    await page.getByRole("button", { name: /停止游戏/ }).waitFor();
    await page.screenshot({
      path: path.join(output, "launch-record-warning.png"),
    });
    checks.push(
      "进程已启动但记录保存失败时显示成功及独立提示，停止按钮状态正确",
    );
    await page.getByRole("button", { name: /停止游戏/ }).click();
    await page.getByRole("button", { name: /启动游戏/ }).waitFor();
    checks.push("停止后恢复启动操作");
    assert.deepEqual(errors, []);
    const report = {
      passed: true,
      checks,
      pageErrors: errors,
      executable: executable || "development Electron",
    };
    await fs.writeFile(
      path.join(output, "verification.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (active) await active.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
