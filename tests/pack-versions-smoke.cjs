const { _electron: electron } = require("playwright-core");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const AdmZip = require("adm-zip");

// Real desktop, preload, IPC, Modrinth service, verified .mrpack downloads and
// import/persistence. Only network responses and GameService.install are fixtures;
// no Microsoft account, full Minecraft download, Java runtime or game is needed.
(async () => {
  const root = path.resolve(__dirname, "..");
  const output = path.join(root, "release");
  await fs.mkdir(output, { recursive: true });
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "LDFCL-pack-versions-qa-"),
  );
  const executable =
    process.env.LDFCL_TEST_EXECUTABLE || process.env.LDFCL_TEST_EXE;
  const env = { ...process.env, LDFCL_DATA_DIR: dir };
  delete env.ELECTRON_RUN_AS_NODE;
  const projects = [
    {
      id: "packqa01",
      project_id: "packqa01",
      project_type: "modpack",
      slug: "qa-multi-pack",
      title: "QA 多版本冒险整合包",
      description: "用于验证历史发行版的受控整合包。",
      author: "LDFCL QA",
      downloads: 4200,
      follows: 12,
      categories: ["adventure"],
      versions: ["1.21.1", "1.20.1"],
    },
    {
      id: "packqa02",
      project_id: "packqa02",
      project_type: "modpack",
      slug: "qa-other-pack",
      title: "QA 另一个整合包",
      description: "用于验证关闭弹窗后的过期响应。",
      author: "LDFCL QA",
      downloads: 320,
      follows: 1,
      categories: ["adventure"],
      versions: ["1.20.1"],
    },
  ];
  const specs = [
    [
      "newqa001",
      "新版 3.0 · Fabric",
      "3.0.0",
      "1.21.1",
      "fabric",
      "0.16.14",
      "2026-09-01",
    ],
    [
      "oldqa001",
      "旧版 1.0 · Fabric",
      "1.0.0",
      "1.20.1",
      "fabric",
      "0.16.14",
      "2025-01-01",
    ],
    [
      "forge001",
      "Forge 2.0",
      "2.0.0",
      "1.20.1",
      "forge",
      "47.4.0",
      "2026-02-01",
    ],
    [
      "neoq0001",
      "NeoForge 4.0",
      "4.0.0",
      "1.21.1",
      "neoforge",
      "21.1.1",
      "2026-09-20",
    ],
    [
      "other001",
      "另一个项目的发行版",
      "1.1.0",
      "1.20.1",
      "fabric",
      "0.16.14",
      "2026-08-01",
    ],
  ];
  const versions = [];
  const archives = {};
  for (const [
    id,
    name,
    number,
    mc,
    loader,
    loaderVersion,
    published,
  ] of specs) {
    const project = id === "other001" ? projects[1] : projects[0];
    const zip = new AdmZip();
    const dependency = loader === "fabric" ? "fabric-loader" : loader;
    zip.addFile(
      "modrinth.index.json",
      Buffer.from(
        JSON.stringify({
          formatVersion: 1,
          game: "minecraft",
          versionId: number,
          name: project.title,
          files: [],
          dependencies: { minecraft: mc, [dependency]: loaderVersion },
        }),
      ),
    );
    zip.addFile("overrides/config/pack-version-qa.txt", Buffer.from(id));
    const bytes = zip.toBuffer();
    const url = `https://cdn.modrinth.com/data/${project.id}/versions/${id}/${id}.mrpack`;
    archives[url] = bytes.toString("base64");
    versions.push({
      id,
      project_id: project.id,
      name,
      version_number: number,
      version_type: "release",
      date_published: `${published}T12:00:00Z`,
      game_versions: [mc],
      loaders: [loader],
      files: [
        {
          primary: true,
          filename: `${id}.mrpack`,
          url,
          size: bytes.length,
          hashes: {
            sha1: createHash("sha1").update(bytes).digest("hex"),
            sha512: createHash("sha512").update(bytes).digest("hex"),
          },
        },
      ],
    });
  }
  const app = await electron.launch({
    executablePath: executable || require("electron"),
    args: executable ? [] : [root],
    env,
    timeout: 45000,
  });
  const errors = [];
  const accessibilityIssues = [];
  const checks = [];
  const screenshots = [];
  let page;
  let passed = false;

  async function until(read, predicate, label, timeout = 15000) {
    const deadline = Date.now() + timeout;
    let last;
    do {
      last = await read();
      if (predicate(last)) return last;
      await new Promise((resolve) => setTimeout(resolve, 35));
    } while (Date.now() < deadline);
    assert.fail(`${label}: ${JSON.stringify(last)}`);
  }
  const state = () => page.evaluate(() => window.launcher.call("state"));
  const qa = () =>
    app.evaluate(() => {
      const q = globalThis.__ldfclPackQA;
      return {
        mode: q.mode,
        versionRequests: q.versionRequests,
        versionCompleted: q.versionCompleted,
        heldCount: q.heldVersions.length,
        installHeld: q.installHeld,
        installCalls: q.installCalls,
        downloadCalls: q.downloadCalls,
        binaryRequests: q.binaryRequests,
        unexpected: q.unexpected,
      };
    });
  const mode = (value) =>
    app.evaluate((_electron, value) => {
      globalThis.__ldfclPackQA.mode = value;
    }, value);
  const dialog = () =>
    page.getByRole("dialog", { name: "选择整合包版本", exact: true });
  const radio = (id) => dialog().locator(`input[type=radio][value="${id}"]`);
  const card = (project) =>
    page
      .getByRole("tabpanel", { name: "整合包", exact: true })
      .locator("article.content-card")
      .filter({
        has: page.getByRole("heading", { name: project.title, exact: true }),
      });
  async function open(project = projects[0]) {
    await card(project)
      .getByRole("button", { name: "选择版本", exact: true })
      .click();
    await dialog().waitFor();
  }
  async function loaded(count = 4) {
    await until(
      () => dialog().getByRole("radio").count(),
      (n) => n === count,
      "version rows",
    );
    await until(
      () => dialog().getByRole("radiogroup").getAttribute("aria-busy"),
      (v) => v === "false",
      "version request settled",
    );
  }
  async function close() {
    await dialog()
      .getByRole("button", { name: "关闭版本选择", exact: true })
      .click();
    await dialog().waitFor({ state: "detached" });
  }
  async function shot(name) {
    const file = path.join(output, `pack-versions-${name}.png`);
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
        width: r.width,
        height: r.height,
        vw: innerWidth,
        vh: innerHeight,
        hit: !!hit && (hit === element || element.contains(hit)),
      };
    });
    assert(
      box.width > 0 &&
        box.height > 0 &&
        box.x >= -1 &&
        box.y >= -1 &&
        box.right <= box.vw + 1 &&
        box.bottom <= box.vh + 1 &&
        box.hit,
      `${label} is clipped or covered: ${JSON.stringify(box)}`,
    );
  }

  try {
    page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await page
      .getByRole("heading", { name: "开始游戏", exact: true })
      .waitFor();
    assert.equal((await state()).instances.length, 0);
    await app.evaluate(
      ({ app }, fixtures) => {
        const paths = process.getBuiltinModule("path");
        const files = process.getBuiltinModule("fs/promises");
        const crypto = process.getBuiltinModule("crypto");
        const requireApp = process
          .getBuiltinModule("module")
          .createRequire(paths.join(app.getAppPath(), "package.json"));
        const { GameService } = requireApp(
          "./dist-electron/electron/services/game.js",
        );
        const { ContentService } = requireApp(
          "./dist-electron/electron/services/content.js",
        );
        const { allocateVersionDirectory } = requireApp(
          "./dist-electron/electron/instance-paths.js",
        );
        const q = (globalThis.__ldfclPackQA = {
          mode: "normal",
          versionRequests: [],
          versionCompleted: 0,
          heldVersions: [],
          installCalls: [],
          installHeld: false,
          installMode: "normal",
          downloadCalls: [],
          binaryRequests: [],
          unexpected: [],
          originalFetch: globalThis.fetch,
          originalInstall: GameService.prototype.install,
          originalDownload: ContentService.prototype.downloadPack,
        });
        const response = (url, body, status = 200, binary = false) => {
          const result = new Response(binary ? body : JSON.stringify(body), {
            status,
            headers: binary
              ? {
                  "content-length": String(body.length),
                  "content-type": "application/zip",
                }
              : { "content-type": "application/json" },
          });
          Object.defineProperty(result, "url", { value: url });
          return result;
        };
        globalThis.fetch = async (input) => {
          const url =
            typeof input === "string" ? input : input.url || String(input);
          const parsed = new URL(url);
          if (
            url ===
            "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"
          )
            return response(url, {
              latest: { release: "1.21.1", snapshot: "1.21.1" },
              versions: ["1.21.1", "1.20.1"].map((id) => ({
                id,
                type: "release",
                url: `https://qa.invalid/${id}.json`,
              })),
            });
          if (
            parsed.hostname === "api.modrinth.com" &&
            parsed.pathname === "/v2/search"
          )
            return response(url, {
              hits: fixtures.projects,
              total_hits: fixtures.projects.length,
              offset: 0,
              limit: 20,
            });
          const projectMatch = parsed.pathname.match(
            /^\/v2\/project\/([^/]+)$/,
          );
          if (parsed.hostname === "api.modrinth.com" && projectMatch) {
            const project = fixtures.projects.find(
              (p) => p.id === projectMatch[1],
            );
            return response(
              url,
              project || { error: "fixture project missing" },
              project ? 200 : 404,
            );
          }
          const listMatch = parsed.pathname.match(
            /^\/v2\/project\/([^/]+)\/version$/,
          );
          if (parsed.hostname === "api.modrinth.com" && listMatch) {
            const id = listMatch[1];
            const requestMode = id === "packqa01" ? q.mode : "normal";
            q.versionRequests.push({ projectId: id, url, mode: requestMode });
            let list = fixtures.versions.filter((v) => v.project_id === id);
            if (requestMode === "hold") {
              await new Promise((resolve) => q.heldVersions.push(resolve));
              list = list.map((v) => ({
                ...v,
                name: `过期响应不应出现 ${v.name}`,
              }));
            }
            q.versionCompleted++;
            if (requestMode === "error")
              return response(
                url,
                { error: "controlled version-list failure" },
                503,
              );
            return response(url, requestMode === "empty" ? [] : list);
          }
          const releaseMatch = parsed.pathname.match(
            /^\/v2\/version\/([^/]+)$/,
          );
          if (parsed.hostname === "api.modrinth.com" && releaseMatch) {
            const version = fixtures.versions.find(
              (v) => v.id === releaseMatch[1],
            );
            return response(url, version || {}, version ? 200 : 404);
          }
          if (fixtures.archives[url]) {
            q.binaryRequests.push(url);
            return response(
              url,
              Buffer.from(fixtures.archives[url], "base64"),
              200,
              true,
            );
          }
          q.unexpected.push(url);
          throw new Error(`Unexpected QA network request: ${url}`);
        };
        ContentService.prototype.downloadPack = async function (
          projectId,
          versionId,
        ) {
          q.downloadCalls.push({ projectId, versionId });
          return q.originalDownload.call(this, projectId, versionId);
        };
        GameService.prototype.install = async function (input) {
          q.installCalls.push({ ...input });
          if (q.installMode === "fail")
            throw new Error("受控安装失败，请重试所选发行版");
          const installMode = q.installMode;
          if (installMode === "hold" || installMode === "hold-fail") {
            q.installHeld = true;
            await new Promise((resolve) => {
              q.releaseInstall = resolve;
            });
            q.installHeld = false;
          }
          if (installMode === "hold-fail")
            throw new Error("受控后台安装失败，请重试所选发行版");
          const allocated = await allocateVersionDirectory(
            this.root,
            input.name || `QA-${input.version}`,
          );
          const instance = {
            id: crypto.randomUUID(),
            name: input.name || allocated.id,
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
              type: "release",
              clientVersion: input.version,
              mainClass: "net.minecraft.client.main.Main",
              libraries: [],
            }),
          );
          await files.writeFile(
            paths.join(allocated.path, `${allocated.id}.jar`),
            "QA client fixture",
          );
          await files.writeFile(
            paths.join(allocated.path, ".ldfcl", "launch.json"),
            JSON.stringify({ version: input.version, loader: input.loader }),
          );
          return instance;
        };
      },
      { projects, versions, archives },
    );
    await page
      .locator("aside.sidebar")
      .getByRole("button", { name: "资源下载", exact: true })
      .click();
    await page.getByRole("tab", { name: "整合包", exact: true }).click();
    await card(projects[0]).waitFor();
    await open();
    await loaded();
    assert.equal(await dialog().getByRole("radio").count(), 4);
    assert.equal(
      await dialog().locator("input:checked").count(),
      0,
      "release choice is explicit",
    );
    assert.equal(
      await dialog()
        .getByRole("button", { name: "安装所选版本", exact: true })
        .isDisabled(),
      true,
    );
    assert.equal(await radio("neoq0001").isDisabled(), true);
    await dialog()
      .getByText("暂不支持此加载器，请选择其他版本", { exact: true })
      .waitFor();
    assert.deepEqual((await qa()).downloadCalls, []);
    assert.deepEqual((await qa()).installCalls, []);
    assert.equal((await state()).instances.length, 0);
    checks.push(
      "opening the real picker downloads no pack and creates no instance; explicit selection and unsupported-loader guard",
    );

    await dialog()
      .getByRole("combobox", { name: /^Minecraft 版本/ })
      .selectOption("1.20.1");
    await loaded(2);
    assert.deepEqual(
      await dialog()
        .getByRole("radio")
        .evaluateAll((els) => els.map((el) => el.value).sort()),
      ["forge001", "oldqa001"],
    );
    await dialog()
      .getByRole("combobox", { name: /^模组加载器/ })
      .selectOption("fabric");
    await loaded(1);
    assert.equal(await radio("oldqa001").count(), 1);
    await radio("oldqa001").check();
    assert.equal(
      await dialog()
        .getByRole("button", { name: "安装所选版本", exact: true })
        .isEnabled(),
      true,
      "no current instance is required",
    );
    await dialog()
      .getByRole("combobox", { name: /^Minecraft 版本/ })
      .selectOption("1.21.1");
    assert.equal(
      await dialog().locator("input:checked").count(),
      0,
      "changing a filter clears the selection",
    );
    await dialog()
      .getByRole("combobox", { name: /^模组加载器/ })
      .selectOption("forge");
    await dialog()
      .getByText("没有匹配的版本，请调整筛选条件", { exact: true })
      .waitFor();
    await dialog()
      .getByRole("button", { name: "清除筛选", exact: true })
      .click();
    await loaded();
    checks.push(
      "Minecraft/loader filters combine, reset the selection, and recover from no matches",
    );

    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(960, 640),
    );
    await page.waitForFunction(
      () => Math.abs(innerWidth - 960) <= 2 && Math.abs(innerHeight - 640) <= 2,
    );
    for (const [locator, label] of [
      [dialog(), "dialog"],
      [
        dialog().getByRole("button", { name: "关闭版本选择", exact: true }),
        "close",
      ],
      [
        dialog().getByRole("combobox", { name: /^Minecraft 版本/ }),
        "Minecraft filter",
      ],
      [
        dialog().getByRole("combobox", { name: /^模组加载器/ }),
        "loader filter",
      ],
      [
        dialog().getByRole("button", { name: "安装所选版本", exact: true }),
        "install",
      ],
    ])
      await onscreen(locator, label);
    await radio("oldqa001").scrollIntoViewIfNeeded();
    await onscreen(radio("oldqa001"), "historical release radio");
    await radio("oldqa001").check();
    await shot("960x640");
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      assert.equal(
        await dialog().evaluate((element) =>
          element.contains(document.activeElement),
        ),
        true,
        "native modal traps Tab focus",
      );
    }
    await page.keyboard.press("Escape");
    await dialog().waitFor({ state: "detached" });
    if (
      !(await card(projects[0])
        .getByRole("button", { name: "选择版本", exact: true })
        .evaluate((element) => element === document.activeElement))
    )
      accessibilityIssues.push(
        "Escape must return focus to the visible picker trigger",
      );
    checks.push(
      "960x640 modal controls and historical release remain visible; native Tab/Escape behavior",
    );

    await mode("error");
    await open();
    await dialog().getByRole("alert").waitFor();
    await shot("error");
    await mode("normal");
    await dialog().getByRole("button", { name: "重试", exact: true }).click();
    await loaded();
    await close();
    await mode("empty");
    await open();
    await dialog()
      .getByText("此整合包暂无可下载的发行版本", { exact: true })
      .waitFor();
    assert.equal(await dialog().getByRole("radio").count(), 0);
    assert.equal(
      await dialog()
        .getByRole("button", { name: "安装所选版本", exact: true })
        .isDisabled(),
      true,
    );
    await shot("empty");
    await mode("normal");
    await dialog()
      .getByRole("button", { name: "刷新版本", exact: true })
      .click();
    await loaded();
    await close();
    checks.push(
      "version-list errors and empty releases can retry without installing anything",
    );

    await mode("hold");
    await open();
    await until(qa, (q) => q.heldCount === 1, "held closed picker response");
    await close();
    await open(projects[1]);
    await loaded(1);
    assert.equal(await radio("other001").count(), 1);
    const completedBefore = (await qa()).versionCompleted;
    await app.evaluate(() =>
      globalThis.__ldfclPackQA.heldVersions
        .splice(0)
        .forEach((resolve) => resolve()),
    );
    await until(
      qa,
      (q) => q.versionCompleted > completedBefore,
      "closed request completed",
    );
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    assert.equal(
      await dialog()
        .getByText(/过期响应不应出现/)
        .count(),
      0,
    );
    assert.equal(await radio("other001").count(), 1);
    await close();
    await mode("hold");
    await open();
    await until(qa, (q) => q.heldCount === 1, "held navigation response");
    // A native modal intentionally blocks pointer input behind it. Invoke the
    // real tab control through DOM activation to exercise component deactivation.
    await page
      .getByRole("tab", { name: "资源包", exact: true })
      .evaluate((element) => element.click());
    await dialog().waitFor({ state: "detached" });
    const completedOnLeave = (await qa()).versionCompleted;
    await app.evaluate(() =>
      globalThis.__ldfclPackQA.heldVersions
        .splice(0)
        .forEach((resolve) => resolve()),
    );
    await until(
      qa,
      (q) => q.versionCompleted > completedOnLeave,
      "deactivated picker request completed",
    );
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    assert.equal(await dialog().count(), 0);
    await page.getByRole("tab", { name: "整合包", exact: true }).click();
    assert.equal(await dialog().count(), 0);
    assert.deepEqual((await qa()).downloadCalls, []);
    checks.push(
      "closed or deactivated pickers ignore late responses and never overwrite another project's releases",
    );

    await mode("normal");
    await open();
    await loaded();
    await radio("oldqa001").check();
    await app.evaluate(() => {
      globalThis.__ldfclPackQA.installMode = "fail";
    });
    await dialog()
      .getByRole("button", { name: "安装所选版本", exact: true })
      .click();
    await dialog()
      .getByRole("alert")
      .filter({ hasText: "受控安装失败" })
      .waitFor();
    assert.equal(await radio("oldqa001").isChecked(), true);
    assert.equal(
      await dialog()
        .getByRole("button", { name: "安装所选版本", exact: true })
        .isEnabled(),
      true,
    );
    assert.equal((await state()).instances.length, 0);
    await shot("install-error");
    await app.evaluate(() => {
      globalThis.__ldfclPackQA.installMode = "normal";
    });
    await dialog()
      .getByRole("button", { name: "安装所选版本", exact: true })
      .click();
    await dialog().waitFor({ state: "detached", timeout: 20000 });
    const installed = await until(
      state,
      (s) => s.instances.length === 1,
      "historical pack persisted",
    );
    const historical = installed.instances[0];
    assert.equal(historical.version, "1.20.1");
    assert.equal(historical.loader, "fabric");
    assert.equal(historical.loaderVersion, "0.16.14");
    assert.equal(historical.gameDirectoryId, installed.selectedGameDirectoryId);
    assert.equal(
      await fs.readFile(
        path.join(
          installed.system.gameRoot,
          "versions",
          historical.versionDirectory,
          "config",
          "pack-version-qa.txt",
        ),
        "utf8",
      ),
      "oldqa001",
    );
    const selectedQA = await qa();
    assert.deepEqual(selectedQA.downloadCalls, [
      { projectId: "packqa01", versionId: "oldqa001" },
      { projectId: "packqa01", versionId: "oldqa001" },
    ]);
    assert(selectedQA.binaryRequests.length >= 1);
    assert(
      selectedQA.binaryRequests.every((url) => url.includes("/oldqa001/")),
      "retry must not download the newest release",
    );
    assert(
      selectedQA.installCalls.every(
        (input) =>
          input.version === "1.20.1" &&
          input.loader === "fabric" &&
          input.loaderVersion === "0.16.14",
      ),
    );
    checks.push(
      "failed installation retains the exact historical choice and retries; verified .mrpack import persists its isolated instance and override",
    );

    await until(
      () =>
        card(projects[0])
          .getByRole("button", { name: "选择版本", exact: true })
          .isEnabled(),
      Boolean,
      "same-project picker reopens",
    );
    await open();
    await loaded();
    assert.equal(
      await radio("newqa001").count(),
      1,
      "current instance must not hide other Minecraft releases",
    );
    assert.equal(await radio("oldqa001").count(), 1);
    await radio("newqa001").check();
    await app.evaluate(() => {
      globalThis.__ldfclPackQA.installMode = "hold";
    });
    await dialog()
      .getByRole("button", { name: "安装所选版本", exact: true })
      .click();
    await until(qa, (q) => q.installHeld, "background installation held");
    await dialog()
      .getByText("关闭此窗口后继续安装，可在下载任务中查看进度。", {
        exact: true,
      })
      .waitFor();
    await shot("background-install");
    await close();
    assert.equal(
      await card(projects[0])
        .getByRole("button", { name: "安装中", exact: true })
        .isDisabled(),
      true,
    );
    await app.evaluate(() => {
      const q = globalThis.__ldfclPackQA;
      q.installMode = "normal";
      q.releaseInstall();
    });
    const completed = await until(
      state,
      (s) => s.instances.length === 2,
      "background installation persisted",
    );
    await until(
      () =>
        card(projects[0])
          .getByRole("button", { name: "选择版本", exact: true })
          .isEnabled(),
      Boolean,
      "background import finished",
    );
    const newer = completed.instances.find(
      (instance) => instance.id !== historical.id,
    );
    assert.equal(newer.version, "1.21.1");
    assert.notEqual(newer.versionDirectory, historical.versionDirectory);
    assert.equal(
      await fs.readFile(
        path.join(
          completed.system.gameRoot,
          "versions",
          newer.versionDirectory,
          "config",
          "pack-version-qa.txt",
        ),
        "utf8",
      ),
      "newqa001",
    );
    assert.equal(
      await fs.readFile(
        path.join(
          completed.system.gameRoot,
          "versions",
          historical.versionDirectory,
          "config",
          "pack-version-qa.txt",
        ),
        "utf8",
      ),
      "oldqa001",
    );
    assert.equal(
      await dialog().count(),
      0,
      "background completion must not reopen the dialog",
    );
    assert.deepEqual((await qa()).downloadCalls.at(-1), {
      projectId: "packqa01",
      versionId: "newqa001",
    });
    checks.push(
      "installed projects reopen with all historical releases; closing a busy picker continues one installation and keeps both versions isolated",
    );

    await open();
    await loaded();
    await radio("oldqa001").check();
    await app.evaluate(() => {
      globalThis.__ldfclPackQA.installMode = "hold-fail";
    });
    await dialog()
      .getByRole("button", { name: "安装所选版本", exact: true })
      .click();
    await until(
      qa,
      (q) => q.installHeld,
      "failing background installation held",
    );
    await page.keyboard.press("Escape");
    await dialog().waitFor({ state: "detached" });
    await app.evaluate(() => {
      const q = globalThis.__ldfclPackQA;
      q.installMode = "normal";
      q.releaseInstall();
    });
    await page.getByText(/受控后台安装失败，请重试所选发行版/).waitFor();
    await until(
      () =>
        card(projects[0])
          .getByRole("button", { name: "选择版本", exact: true })
          .isEnabled(),
      Boolean,
      "failed background install released the project",
    );
    assert.equal((await state()).instances.length, 2);
    assert.equal(await dialog().count(), 0);
    await shot("background-error");
    checks.push(
      "Escape closes a busy picker; a later installation failure remains visible and releases the project for retry",
    );
    const finalQA = await qa();
    assert(
      finalQA.versionRequests.every((request) => {
        const url = new URL(request.url);
        return (
          !url.searchParams.has("game_versions") &&
          !url.searchParams.has("loaders")
        );
      }),
      "pack releases must not inherit current-instance compatibility filters",
    );
    assert.deepEqual(finalQA.unexpected, []);
    await shot("complete");
    assert.deepEqual(errors, []);
    assert.deepEqual(accessibilityIssues, []);
    passed = true;
    const result = { passed, checks, screenshots, pageErrors: errors };
    await fs.writeFile(
      path.join(output, "pack-versions-smoke.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
  } finally {
    if (!passed && page) {
      await page
        .screenshot({ path: path.join(output, "pack-versions-failure.png") })
        .catch(() => {});
    }
    await app
      .evaluate(({ app }) => {
        const q = globalThis.__ldfclPackQA;
        if (!q) return;
        const paths = process.getBuiltinModule("path");
        const requireApp = process
          .getBuiltinModule("module")
          .createRequire(paths.join(app.getAppPath(), "package.json"));
        requireApp(
          "./dist-electron/electron/services/game.js",
        ).GameService.prototype.install = q.originalInstall;
        requireApp(
          "./dist-electron/electron/services/content.js",
        ).ContentService.prototype.downloadPack = q.originalDownload;
        globalThis.fetch = q.originalFetch;
        q.heldVersions.splice(0).forEach((resolve) => resolve());
        q.releaseInstall?.();
      })
      .catch(() => {});
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
