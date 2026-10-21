const { _electron: electron } = require("playwright-core");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");

// Real Minecraft download UI, preload, IPC, metadata service and Store. Fixture
// responses replace the network; only the already-live-tested GameService.install
// boundary is stubbed to avoid downloading all Minecraft assets again.
(async () => {
  const root = path.resolve(__dirname, "..");
  const output = path.join(root, "release");
  await fs.mkdir(output, { recursive: true });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "LDFCL-optifine-ui-qa-"));
  const executable =
    process.env.LDFCL_TEST_EXECUTABLE || process.env.LDFCL_TEST_EXE;
  const env = { ...process.env, LDFCL_DATA_DIR: dir };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    executablePath: executable || require("electron"),
    args: executable ? [] : [root],
    env,
    timeout: 45000,
  });
  const checks = [],
    errors = [],
    screenshots = [];
  let page;
  let passed = false;
  async function until(read, predicate, label, timeout = 15000) {
    const deadline = Date.now() + timeout;
    let last;
    do {
      last = await read();
      if (predicate(last)) return last;
      await new Promise((resolve) => setTimeout(resolve, 30));
    } while (Date.now() < deadline);
    assert.fail(`${label}: ${JSON.stringify(last)}`);
  }
  const state = () => page.evaluate(() => window.launcher.call("state"));
  const qa = () =>
    app.evaluate(() => {
      const q = globalThis.__ldfclOptifineQA;
      return {
        requests: q.requests,
        completed: q.completed,
        held: q.held.length,
        installs: q.installs,
        unexpected: q.unexpected,
      };
    });
  const setMode = (version, mode) =>
    app.evaluate(
      (_electron, { version, mode }) => {
        globalThis.__ldfclOptifineQA.mode[version] = mode;
      },
      { version, mode },
    );
  const panel = () =>
    page.getByRole("tabpanel", { name: "Minecraft 下载", exact: true });
  const loader = () => panel().getByLabel("模组加载器", { exact: true });
  const editions = () =>
    panel().getByLabel("OptiFine 发行版本", { exact: true });
  const install = () => panel().getByRole("button", { name: /^下载并安装 / });
  async function selectMinecraft(version) {
    await panel()
      .locator(".version-list button")
      .filter({ has: page.getByText(version, { exact: true }) })
      .click();
  }
  async function expectEditions(ids) {
    await until(
      () =>
        editions()
          .locator("option")
          .evaluateAll((elements) => elements.map((element) => element.value)),
      (values) => JSON.stringify(values) === JSON.stringify(ids),
      "OptiFine editions",
    );
    if (ids.some(Boolean))
      await until(
        () => editions().isEnabled(),
        Boolean,
        "edition control enabled",
      );
  }
  async function shot(name) {
    const file = path.join(output, `optifine-download-${name}.png`);
    await page.screenshot({ path: file });
    screenshots.push(file);
  }
  async function onscreen(locator, label) {
    const box = await locator.evaluate((element) => {
      const r = element.getBoundingClientRect();
      const hit = document.elementFromPoint(
        r.x + r.width / 2,
        r.y + r.height / 2,
      );
      return {
        x: r.x,
        y: r.y,
        right: r.right,
        bottom: r.bottom,
        w: r.width,
        h: r.height,
        vw: innerWidth,
        vh: innerHeight,
        hit: !!hit && (hit === element || element.contains(hit)),
      };
    });
    assert(
      box.w > 0 &&
        box.h > 0 &&
        box.x >= -1 &&
        box.y >= -1 &&
        box.right <= box.vw + 1 &&
        box.bottom <= box.vh + 1 &&
        box.hit,
      `${label} clipped or covered: ${JSON.stringify(box)}`,
    );
  }
  try {
    page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await page
      .getByRole("heading", { name: "开始游戏", exact: true })
      .waitFor();
    await app.evaluate(({ app }) => {
      const paths = process.getBuiltinModule("path");
      const files = process.getBuiltinModule("fs/promises");
      const requireApp = process
        .getBuiltinModule("module")
        .createRequire(paths.join(app.getAppPath(), "package.json"));
      const { GameService } = requireApp(
        "./dist-electron/electron/services/game.js",
      );
      const { allocateVersionDirectory } = requireApp(
        "./dist-electron/electron/instance-paths.js",
      );
      const q = (globalThis.__ldfclOptifineQA = {
        originalFetch: globalThis.fetch,
        originalInstall: GameService.prototype.install,
        mode: {},
        requests: [],
        completed: 0,
        held: [],
        installs: [],
        unexpected: [],
      });
      const raw = (version, patch) => ({
        mcversion: version,
        type: "HD_U",
        patch,
        filename: `OptiFine_${version}_HD_U_${patch}.jar`,
      });
      const json = (body, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      globalThis.fetch = async (input) => {
        const url =
          typeof input === "string" ? input : input.url || String(input);
        if (
          url ===
          "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"
        )
          return json({
            latest: { release: "1.21.1", snapshot: "1.21.1" },
            versions: ["1.21.1", "1.12.2", "26.1"].map((id) => ({
              id,
              type: "release",
              url: `https://qa.invalid/${id}.json`,
            })),
          });
        const match = url.match(
          /^https:\/\/bmclapi2\.bangbang93\.com\/optifine\/([^/?]+)$/,
        );
        if (match) {
          const version = decodeURIComponent(match[1]);
          const mode = q.mode[version] || "normal";
          q.requests.push({ version, mode, url });
          if (mode === "hold")
            await new Promise((resolve) => q.held.push(resolve));
          q.completed++;
          if (mode === "error")
            return json({ error: "controlled OptiFine listing failure" }, 400);
          return json(
            version === "1.12.2"
              ? [raw(version, "F5"), raw(version, "G5")]
              : version === "1.21.1"
                ? [raw(version, "J3")]
                : [],
          );
        }
        q.unexpected.push(url);
        throw new Error(`Unexpected OptiFine QA network request: ${url}`);
      };
      GameService.prototype.install = async function (input) {
        q.installs.push({ ...input });
        const allocated = await allocateVersionDirectory(
          this.root,
          input.name || input.version,
        );
        const instance = {
          id: process.getBuiltinModule("crypto").randomUUID(),
          name: input.name || input.version,
          version: input.version,
          loader: input.loader || "vanilla",
          loaderVersion: input.loaderVersion,
          versionDirectory: allocated.id,
          createdAt: new Date().toISOString(),
          gameSettings: {},
        };
        await files.mkdir(paths.join(allocated.path, ".ldfcl"), {
          recursive: true,
        });
        await files.writeFile(
          paths.join(allocated.path, `${allocated.id}.json`),
          JSON.stringify({
            id: allocated.id,
            minecraftVersion: input.version,
            mainClass: "net.minecraft.client.main.Main",
            libraries: [],
          }),
        );
        await files.writeFile(
          paths.join(allocated.path, `${allocated.id}.jar`),
          "QA fixture, game is never launched",
        );
        await files.writeFile(
          paths.join(allocated.path, ".ldfcl", "launch.json"),
          JSON.stringify({ version: allocated.id }),
        );
        return instance;
      };
    });
    await page
      .locator("aside.sidebar")
      .getByRole("button", { name: "资源下载", exact: true })
      .click();
    await page.getByRole("tab", { name: "Minecraft", exact: true }).click();
    await until(
      () => panel().locator(".version-list button").count(),
      (count) => count === 3,
      "Minecraft fixture versions",
    );
    assert.deepEqual(
      (await qa()).requests,
      [],
      "vanilla view must not request OptiFine metadata",
    );
    await selectMinecraft("1.12.2");
    await loader().selectOption("optifine");
    await expectEditions(["HD_U_G5", "HD_U_F5"]);
    assert.equal((await qa()).requests.at(-1).version, "1.12.2");
    await editions().selectOption("HD_U_F5");
    await panel()
      .getByLabel("实例名称", { exact: true })
      .fill("OptiFine UI 精确发行版");
    await panel()
      .getByText(
        "独立安装 OptiFine，不与 Fabric、Quilt 或 Forge 组合。切换游戏版本后会重新查询。",
        { exact: true },
      )
      .waitFor();
    assert.equal(await install().isEnabled(), true);
    assert.deepEqual((await qa()).installs, []);
    checks.push(
      "Minecraft page queries the selected Minecraft version, sorts releases, permits an exact OptiFine edition and explains standalone installation",
    );

    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(960, 640),
    );
    await page.waitForFunction(
      () => Math.abs(innerWidth - 960) <= 2 && Math.abs(innerHeight - 640) <= 2,
    );
    await install().scrollIntoViewIfNeeded();
    await onscreen(loader(), "OptiFine loader control");
    await onscreen(editions(), "OptiFine edition control");
    await onscreen(install(), "install control");
    await shot("960x640");
    checks.push(
      "OptiFine loader, edition selector and installation button are visible and reachable at 960x640",
    );

    await install().click();
    const installed = await until(
      state,
      (value) => value.instances.length === 1,
      "OptiFine instance persisted through real IPC",
    );
    assert.equal(installed.instances[0].loader, "optifine");
    assert.equal(installed.instances[0].loaderVersion, "HD_U_F5");
    assert.equal(installed.instances[0].version, "1.12.2");
    assert.equal(
      installed.instances[0].gameDirectoryId,
      installed.selectedGameDirectoryId,
    );
    assert.deepEqual((await qa()).installs[0], {
      version: "1.12.2",
      loader: "optifine",
      loaderVersion: "HD_U_F5",
      name: "OptiFine UI 精确发行版",
    });
    checks.push(
      "real install IPC accepts loader=optifine and the exact chosen loaderVersion, then saves the independent instance",
    );

    await selectMinecraft("1.21.1");
    await expectEditions(["HD_U_J3"]);
    await setMode("1.12.2", "error");
    await selectMinecraft("1.12.2");
    await panel()
      .getByRole("alert")
      .filter({ hasText: "无法获取 Minecraft 1.12.2 的 OptiFine 版本" })
      .waitFor();
    assert.equal(await install().isDisabled(), true);
    await shot("error");
    await setMode("1.12.2", "normal");
    await panel()
      .getByRole("button", { name: "重试 OptiFine 版本", exact: true })
      .click();
    await expectEditions(["HD_U_G5", "HD_U_F5"]);
    assert.equal(await install().isEnabled(), true);
    checks.push(
      "OptiFine listing failures disable installation and recover with the visible retry control",
    );

    await selectMinecraft("26.1");
    await panel()
      .getByRole("status")
      .filter({ hasText: "此 Minecraft 版本暂无 OptiFine" })
      .waitFor();
    assert.equal(await editions().isDisabled(), true);
    assert.equal(await install().isDisabled(), true);
    await shot("unsupported");
    await panel()
      .getByRole("button", { name: "使用原版", exact: true })
      .click();
    assert.equal(await loader().inputValue(), "vanilla");
    assert.equal(await editions().count(), 0);
    assert.equal(await install().isEnabled(), true);
    await install().click();
    await until(
      state,
      (value) => value.instances.length === 2,
      "unsupported OptiFine Minecraft version installs as vanilla",
    );
    const vanilla = (await qa()).installs.at(-1);
    assert.equal(vanilla.version, "26.1");
    assert.equal(vanilla.loader, "vanilla");
    assert.equal(vanilla.loaderVersion, undefined);
    checks.push(
      "an unsupported new Minecraft version explains the empty list and can immediately install as vanilla",
    );

    await selectMinecraft("1.12.2");
    await setMode("1.12.2", "hold");
    await loader().selectOption("optifine");
    await until(
      qa,
      (value) => value.held === 1,
      "held old Minecraft OptiFine response",
    );
    assert.equal(await install().isDisabled(), true);
    await selectMinecraft("1.21.1");
    await expectEditions(["HD_U_J3"]);
    const completedBefore = (await qa()).completed;
    await app.evaluate(() =>
      globalThis.__ldfclOptifineQA.held
        .splice(0)
        .forEach((resolve) => resolve()),
    );
    await until(
      qa,
      (value) => value.completed > completedBefore,
      "old Minecraft metadata completed",
    );
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await expectEditions(["HD_U_J3"]);
    assert.equal(await editions().inputValue(), "HD_U_J3");
    assert.equal((await qa()).installs.length, 2);
    checks.push(
      "rapid Minecraft changes ignore late OptiFine responses and never install a stale edition",
    );

    await selectMinecraft("1.12.2");
    await until(
      qa,
      (value) => value.held === 1,
      "held listing before switching back to vanilla",
    );
    await loader().selectOption("vanilla");
    const completedOnLeave = (await qa()).completed;
    await app.evaluate(() =>
      globalThis.__ldfclOptifineQA.held
        .splice(0)
        .forEach((resolve) => resolve()),
    );
    await until(
      qa,
      (value) => value.completed > completedOnLeave,
      "inactive OptiFine request completed",
    );
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    assert.equal(await loader().inputValue(), "vanilla");
    assert.equal(await editions().count(), 0);
    assert.equal(await install().isEnabled(), true);
    assert.equal((await state()).instances.length, 2);
    assert.deepEqual((await qa()).unexpected, []);
    assert.deepEqual(errors, []);
    checks.push(
      "returning to vanilla during a pending OptiFine request keeps vanilla installation available and causes no extra installation",
    );
    await shot("complete");
    passed = true;
    const result = {
      passed,
      executable: executable || "development Electron",
      checks,
      screenshots,
      pageErrors: errors,
    };
    await fs.writeFile(
      path.join(output, "optifine-download-smoke.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
  } finally {
    if (!passed && page)
      await page
        .screenshot({
          path: path.join(output, "optifine-download-failure.png"),
        })
        .catch(() => {});
    await app
      .evaluate(({ app }) => {
        const q = globalThis.__ldfclOptifineQA;
        if (!q) return;
        const paths = process.getBuiltinModule("path");
        const requireApp = process
          .getBuiltinModule("module")
          .createRequire(paths.join(app.getAppPath(), "package.json"));
        requireApp(
          "./dist-electron/electron/services/game.js",
        ).GameService.prototype.install = q.originalInstall;
        globalThis.fetch = q.originalFetch;
        q.held.splice(0).forEach((resolve) => resolve());
      })
      .catch(() => {});
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
