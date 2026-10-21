const { _electron: electron } = require("playwright-core");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const Zip = require("adm-zip");

// Real renderer, preload, IPC, ContentService, verified JAR downloads and local
// favorites. Only external HTTP responses are controlled; no install method is
// stubbed. Both game versions are pre-existing small local fixtures.
(async () => {
  const root = path.resolve(__dirname, "..");
  const output = path.join(root, "release");
  await fs.mkdir(output, { recursive: true });
  const work = await fs.mkdtemp(
    path.join(os.tmpdir(), "LDFCL-mod-download-qa-"),
  );
  const dataDir = path.join(work, "中文 配置", "LDFCL-data");
  const gameRoot = path.join(work, "中文 游戏", ".minecraft");
  const userData = path.join(work, "Chromium QA");
  const executable =
    process.env.LDFCL_TEST_EXE || process.env.LDFCL_TEST_EXECUTABLE;
  const instances = [
    {
      id: "modqa-a",
      name: "目标 A · 1.21.1",
      version: "1.21.1",
      versionDirectory: "A-Fabric",
    },
    {
      id: "modqa-b",
      name: "目标 B · 1.20.1",
      version: "1.20.1",
      versionDirectory: "B-Fabric",
    },
  ].map((instance) => ({
    ...instance,
    loader: "fabric",
    loaderVersion: "0.16.14",
    gameDirectoryId: "modqa-directory",
    createdAt: "2026-01-01T00:00:00Z",
    gameSettings: {},
  }));
  const projects = [
    ["qaMain", "qa-main", "QA 必需前置主模组"],
    ["qaFailure", "qa-failure", "QA 重试验证模组"],
    ["qaDependency", "qa-dependency", "QA 必需前置"],
    ["qaLeaf", "qa-leaf", "QA 递归前置"],
    ["qaOptional", "qa-optional", "QA 可选前置"],
  ].map(([id, slug, title]) => ({
    id,
    project_id: id,
    slug,
    title,
    project_type: "mod",
    description: "受控测试模组，验证目标版本与前置安装。",
    author: "LDFCL QA",
    downloads: 3600,
    categories: ["utility"],
    versions: ["1.21.1", "1.20.1"],
  }));
  const archives = {};
  const versions = [];
  function jar(modId, version) {
    const zip = new Zip();
    zip.addFile(
      "fabric.mod.json",
      Buffer.from(
        JSON.stringify({ schemaVersion: 1, id: modId, name: modId, version }),
      ),
    );
    return zip.toBuffer();
  }
  function release(projectId, id, minecraft, filename, dependencies = []) {
    const bytes = jar(projectId.toLowerCase(), id);
    const url = `https://cdn.modrinth.com/qa/${id}/${filename}`;
    archives[url] = bytes.toString("base64");
    const version = {
      id,
      project_id: projectId,
      name: id,
      version_number: id,
      version_type: "release",
      date_published: "2026-10-01T12:00:00Z",
      game_versions: [minecraft],
      loaders: ["fabric"],
      dependencies,
      files: [
        {
          primary: true,
          filename,
          url,
          size: bytes.length,
          hashes: {
            sha1: createHash("sha1").update(bytes).digest("hex"),
            sha512: createHash("sha512").update(bytes).digest("hex"),
          },
        },
      ],
    };
    versions.push(version);
    return version;
  }
  release("qaMain", "mainA", "1.21.1", "main-a.jar");
  release("qaMain", "mainB", "1.20.1", "main-b.jar", [
    {
      project_id: "qaDependency",
      version_id: "dependencyB",
      dependency_type: "required",
    },
    { project_id: "qaOptional", dependency_type: "optional" },
  ]);
  const dependency = release(
    "qaDependency",
    "dependencyB",
    "1.20.1",
    "dependency.jar",
    [{ version_id: "leafB", dependency_type: "required" }],
  );
  release("qaLeaf", "leafB", "1.20.1", "leaf.jar");
  release("qaOptional", "optionalB", "1.20.1", "optional.jar");
  release("qaFailure", "failureA", "1.21.1", "retry-a.jar");
  release("qaFailure", "failureB", "1.20.1", "retry-b.jar");
  async function put(file, bytes) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
  }
  const instanceDir = (instance) =>
    path.join(gameRoot, "versions", instance.versionDirectory);
  for (const instance of instances) {
    const dir = instanceDir(instance);
    await fs.mkdir(path.join(dir, "mods"), { recursive: true });
    await put(
      path.join(dir, `${instance.versionDirectory}.json`),
      JSON.stringify({
        id: instance.versionDirectory,
        type: "release",
        clientVersion: instance.version,
        mainClass: "net.minecraft.client.main.Main",
        libraries: [],
      }),
    );
    await put(
      path.join(dir, `${instance.versionDirectory}.jar`),
      jar("client_fixture", "1.0"),
    );
    await put(
      path.join(dir, ".ldfcl/launch.json"),
      JSON.stringify({ version: instance.version, loader: instance.loader }),
    );
    await put(
      path.join(dir, "options.txt"),
      "fullscreen:false\nrenderDistance:12\n",
    );
  }
  await put(
    path.join(instanceDir(instances[0]), "mods/untouched-a.jar"),
    jar("untouched_a", "1.0"),
  );
  await put(
    path.join(instanceDir(instances[1]), "mods/dependency.jar.disabled"),
    Buffer.from(archives[dependency.files[0].url], "base64"),
  );
  await put(
    path.join(instanceDir(instances[1]), ".ldfcl-content.json"),
    JSON.stringify({
      "mods/dependency.jar": {
        projectId: "qaDependency",
        versionId: "dependencyB",
        versionName: "dependencyB",
      },
    }),
  );
  await put(
    path.join(dataDir, "launcher.json"),
    JSON.stringify({
      instances,
      gameDirectories: [
        {
          id: "modqa-directory",
          name: "模组验证目录",
          path: gameRoot,
          layout: "standard",
        },
      ],
      selectedGameDirectoryId: "modqa-directory",
      selectedInstanceId: instances[0].id,
    }),
  );
  async function snapshot(directory) {
    const files = {};
    async function visit(base, relative = "") {
      for (const entry of await fs.readdir(base, { withFileTypes: true })) {
        const name = path.join(relative, entry.name),
          file = path.join(base, entry.name);
        if (entry.isDirectory()) await visit(file, name);
        else
          files[name] = createHash("sha256")
            .update(await fs.readFile(file))
            .digest("hex");
      }
    }
    await visit(directory);
    return files;
  }
  const originalA = await snapshot(instanceDir(instances[0]));
  const originalBProfile = await fs.readFile(
    path.join(instanceDir(instances[1]), "B-Fabric.json"),
  );
  const pageErrors = [],
    checks = [],
    screenshots = [];
  let app,
    page,
    passed = false;
  async function until(read, predicate, label, timeout = 15000) {
    const end = Date.now() + timeout;
    let value;
    do {
      value = await read();
      if (predicate(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 35));
    } while (Date.now() < end);
    assert.fail(`${label}: ${JSON.stringify(value)}`);
  }
  async function launch() {
    const env = {
      ...process.env,
      LDFCL_DATA_DIR: dataDir,
      LDFCL_GAME_ROOT: gameRoot,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({
      executablePath: executable || require("electron"),
      args: executable
        ? [`--user-data-dir=${userData}`]
        : [root, `--user-data-dir=${userData}`],
      env,
      timeout: 45000,
    });
    page = await app.firstWindow();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page
      .getByRole("heading", { name: "开始游戏", exact: true })
      .waitFor();
    await app.evaluate(
      ({ app }, fixtures) => {
        const paths = process.getBuiltinModule("path");
        const requireApp = process
          .getBuiltinModule("module")
          .createRequire(paths.join(app.getAppPath(), "package.json"));
        const { ContentService } = requireApp(
          "./dist-electron/electron/services/content.js",
        );
        const q = (globalThis.__ldfclModQA = {
          holdA: false,
          held: [],
          listCompleted: 0,
          lists: [],
          exactVersions: [],
          binary: [],
          installCalls: [],
          reports: [],
          unexpected: [],
          installMode: "normal",
          installHeld: false,
          originalFetch: globalThis.fetch,
          originalInstall: ContentService.prototype.install,
        });
        const response = (url, body, status = 200, binary = false) => {
          const result = new Response(binary ? body : JSON.stringify(body), {
            status,
            headers: binary
              ? {
                  "content-length": String(body.length),
                  "content-type": "application/java-archive",
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
              hits: fixtures.projects.slice(0, 2),
              total_hits: 2,
              offset: 0,
              limit: 20,
            });
          const list = parsed.pathname.match(
            /^\/v2\/project\/([^/]+)\/version$/,
          );
          if (parsed.hostname === "api.modrinth.com" && list) {
            const games = JSON.parse(
              parsed.searchParams.get("game_versions") || "[]",
            );
            const loaders = JSON.parse(
              parsed.searchParams.get("loaders") || "[]",
            );
            q.lists.push({ projectId: list[1], games, loaders });
            let items = fixtures.versions.filter(
              (version) =>
                version.project_id === list[1] &&
                (!games.length ||
                  games.some((game) => version.game_versions.includes(game))) &&
                (!loaders.length ||
                  loaders.some((loader) => version.loaders.includes(loader))),
            );
            if (q.holdA && list[1] === "qaMain" && games.includes("1.21.1")) {
              await new Promise((resolve) => q.held.push(resolve));
              items = items.map((version) => ({
                ...version,
                version_number: "迟到响应不能出现",
              }));
            }
            q.listCompleted++;
            return response(url, items);
          }
          const project = parsed.pathname.match(/^\/v2\/project\/([^/]+)$/);
          if (parsed.hostname === "api.modrinth.com" && project) {
            const item = fixtures.projects.find(
              (item) => item.id === project[1],
            );
            return response(url, item || {}, item ? 200 : 404);
          }
          const exact = parsed.pathname.match(/^\/v2\/version\/([^/]+)$/);
          if (parsed.hostname === "api.modrinth.com" && exact) {
            q.exactVersions.push(exact[1]);
            if (exact[1] === "failureB" && q.installMode === "hold-fail") {
              q.installHeld = true;
              await new Promise((resolve) => {
                q.releaseInstall = resolve;
              });
              q.installHeld = false;
              return response(
                url,
                { error: "controlled background failure" },
                403,
              );
            }
            if (exact[1] === "failureB" && q.installMode === "fail")
              return response(
                url,
                { error: "controlled install failure" },
                403,
              );
            const item = fixtures.versions.find((item) => item.id === exact[1]);
            return response(url, item || {}, item ? 200 : 404);
          }
          if (fixtures.archives[url]) {
            q.binary.push(url);
            return response(
              url,
              Buffer.from(fixtures.archives[url], "base64"),
              200,
              true,
            );
          }
          q.unexpected.push(url);
          throw new Error(`Unexpected mod QA network request: ${url}`);
        };
        ContentService.prototype.install = async function (input, ...rest) {
          q.installCalls.push({
            projectId: input.projectId,
            instanceId: input.instance.id,
            versionId: input.versionId,
          });
          const report = await q.originalInstall.call(this, input, ...rest);
          q.reports.push(report);
          return report;
        };
      },
      { projects, versions, archives },
    );
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(960, 640),
    );
  }
  const qa = () =>
    app.evaluate(() => {
      const q = globalThis.__ldfclModQA;
      return {
        held: q.held.length,
        listCompleted: q.listCompleted,
        lists: q.lists,
        exactVersions: q.exactVersions,
        binary: q.binary,
        installCalls: q.installCalls,
        reports: q.reports,
        unexpected: q.unexpected,
        installHeld: q.installHeld,
      };
    });
  const state = () => page.evaluate(() => window.launcher.call("state"));
  const panel = () =>
    page.getByRole("tabpanel", { name: "Mod 模组", exact: true });
  const dialog = () =>
    page.getByRole("dialog", { name: "选择模组安装位置", exact: true });
  const target = () =>
    dialog().getByRole("combobox", { name: "目标游戏版本", exact: true });
  const releaseSelect = () =>
    dialog().getByRole("combobox", { name: "模组发行版本", exact: true });
  const install = () =>
    dialog().getByRole("button", { name: "确认安装到此版本", exact: true });
  const card = (title = projects[0].title) =>
    panel()
      .locator("article.content-card")
      .filter({ has: page.getByRole("heading", { name: title, exact: true }) });
  async function navigate() {
    await page
      .locator("aside.sidebar")
      .getByRole("button", { name: "资源下载", exact: true })
      .click();
    await page.getByRole("tab", { name: "Mod 模组", exact: true }).click();
    await card().waitFor();
  }
  async function open(title = projects[0].title) {
    await card(title)
      .getByRole("button", { name: "选择安装位置", exact: true })
      .click();
    await dialog().waitFor();
  }
  async function close() {
    await dialog()
      .getByRole("button", { name: "关闭模组安装选择", exact: true })
      .click();
    await dialog().waitFor({ state: "detached" });
  }
  async function loaded(versionId) {
    await until(
      () =>
        releaseSelect()
          .locator("option")
          .evaluateAll((items) => items.map((item) => item.value)),
      (values) => values.includes(versionId),
      `compatible release ${versionId}`,
    );
    await until(() => install().isEnabled(), Boolean, "confirm enabled");
  }
  async function shot(name) {
    const file = path.join(output, `mod-download-${name}.png`);
    await page.screenshot({ path: file });
    screenshots.push(file);
  }
  async function onscreen(locator, name) {
    const value = await locator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
      );
      return {
        x: rect.x,
        y: rect.y,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
        hit: !!hit && (hit === element || element.contains(hit)),
      };
    });
    assert(
      value.x >= -1 &&
        value.y >= -1 &&
        value.right <= value.viewportWidth + 1 &&
        value.bottom <= value.viewportHeight + 1 &&
        value.width > 0 &&
        value.height > 0 &&
        value.hit,
      `${name} clipped or covered: ${JSON.stringify(value)}`,
    );
  }
  async function finishApp() {
    if (app) {
      await app.close();
      app = undefined;
      page = undefined;
    }
  }
  try {
    await launch();
    assert.equal((await state()).selectedInstanceId, instances[0].id);
    await navigate();
    await app.evaluate(() => {
      globalThis.__ldfclModQA.holdA = true;
    });
    await open();
    assert.equal(
      await target().inputValue(),
      instances[0].id,
      "current A is only the default target, not an implicit install",
    );
    await until(qa, (value) => value.held === 1, "A version request held");
    assert.equal(await install().isDisabled(), true);
    assert.equal((await qa()).installCalls.length, 0);
    await target().selectOption(instances[1].id);
    await loaded("mainB");
    const before = (await qa()).listCompleted;
    await app.evaluate(() => {
      const q = globalThis.__ldfclModQA;
      q.holdA = false;
      q.held.splice(0).forEach((resolve) => resolve());
    });
    await until(
      qa,
      (value) => value.listCompleted > before,
      "late A request finished",
    );
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    assert.equal(await target().inputValue(), instances[1].id);
    assert.deepEqual(
      await releaseSelect()
        .locator("option")
        .evaluateAll((items) => items.map((item) => item.value)),
      ["", "mainB"],
    );
    assert.equal(await dialog().getByText("迟到响应不能出现").count(), 0);
    for (const currentId of [instances[1].id, instances[0].id]) {
      await page.evaluate(
        (instanceId) => window.launcher.call("select", { instanceId }),
        currentId,
      );
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.send("launcher:event", {
          type: "state",
        }),
      );
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      assert.equal(
        await target().inputValue(),
        instances[1].id,
        "changing the current instance must not reset the explicit dialog target",
      );
    }
    await onscreen(target(), "target selector at 960x640");
    await onscreen(releaseSelect(), "release selector at 960x640");
    await onscreen(install(), "confirm at 960x640");
    await shot("960x640");
    checks.push(
      "real target picker defaults to A, waits for compatible versions, and discards a late A response after selecting B; controls fit 960x640",
    );
    await install().click();
    await dialog().waitFor({ state: "detached" });
    const afterInstall = await qa();
    assert.deepEqual(afterInstall.installCalls[0], {
      projectId: "qaMain",
      instanceId: instances[1].id,
      versionId: "mainB",
    });
    assert.equal(
      (await state()).selectedInstanceId,
      instances[0].id,
      "installing to B does not change current A",
    );
    assert.deepEqual(await snapshot(instanceDir(instances[0])), originalA);
    assert.deepEqual(
      (await fs.readdir(path.join(instanceDir(instances[1]), "mods"))).sort(),
      ["dependency.jar", "leaf.jar", "main-b.jar"],
    );
    assert.deepEqual(
      await fs.readFile(path.join(instanceDir(instances[1]), "B-Fabric.json")),
      originalBProfile,
    );
    assert.deepEqual(
      afterInstall.reports[0].dependencies.map((item) => item.projectId),
      ["qaLeaf", "qaDependency"],
    );
    assert.deepEqual(afterInstall.binary.sort(), [
      "https://cdn.modrinth.com/qa/leafB/leaf.jar",
      "https://cdn.modrinth.com/qa/mainB/main-b.jar",
    ]);
    assert.deepEqual(
      await fs.readFile(path.join(instanceDir(instances[1]), "mods/dependency.jar")),
      Buffer.from(archives[dependency.files[0].url], "base64"),
      "the matching disabled dependency is enabled and reused without downloading",
    );
    assert(!afterInstall.exactVersions.includes("optionalB"));
    checks.push(
      "real IPC installs only to B, verifies JAR downloads, recursively installs required dependencies and enables the disabled copy while skipping optional mods; A and B profile remain intact",
    );
    await open();
    await loaded("mainA");
    await close();
    checks.push(
      "the same project remains selectable after installation so another instance can receive it",
    );
    await card()
      .getByRole("button", { name: `收藏 ${projects[0].title}`, exact: true })
      .click();
    await until(
      () =>
        card()
          .getByRole("button", {
            name: `取消收藏 ${projects[0].title}`,
            exact: true,
          })
          .count(),
      (value) => value === 1,
      "favorite saved",
    );
    const disk = JSON.parse(
      await fs.readFile(path.join(dataDir, "mod-favorites.json"), "utf8"),
    );
    assert.equal(disk.mods[0].projectId, "qaMain");
    await finishApp();
    await launch();
    await navigate();
    await card()
      .getByRole("button", {
        name: `取消收藏 ${projects[0].title}`,
        exact: true,
      })
      .waitFor();
    await panel()
      .getByRole("button", { name: "只看收藏", exact: true })
      .click();
    assert.equal(await panel().locator("article.content-card").count(), 1);
    await shot("favorites");
    await card()
      .getByRole("button", {
        name: `取消收藏 ${projects[0].title}`,
        exact: true,
      })
      .click();
    await panel().getByText("还没有找到相关内容", { exact: true }).waitFor();
    assert.deepEqual(
      JSON.parse(
        await fs.readFile(path.join(dataDir, "mod-favorites.json"), "utf8"),
      ).mods,
      [],
    );
    await panel()
      .getByRole("button", { name: "只看收藏", exact: true })
      .click();
    await card(projects[1].title).waitFor();
    checks.push(
      "favorite star persists across a real restart; only-favorites shows exactly the saved project and removing it persists an empty collection",
    );
    await open(projects[1].title);
    await target().selectOption(instances[1].id);
    await loaded("failureB");
    await app.evaluate(() => {
      globalThis.__ldfclModQA.installMode = "fail";
    });
    await install().click();
    await until(
      () => dialog().getByRole("alert").innerText(),
      (text) => text.includes("403"),
      "installation failure remains inline",
    );
    await shot("inline-error");
    assert.equal(await dialog().count(), 1);
    assert.equal(
      await dialog()
        .getByRole("button", { name: "重试", exact: true })
        .isEnabled(),
      true,
    );
    await app.evaluate(() => {
      globalThis.__ldfclModQA.installMode = "normal";
    });
    await dialog().getByRole("button", { name: "重试", exact: true }).click();
    await loaded("failureB");
    await install().click();
    await dialog().waitFor({ state: "detached" });
    await fs.access(path.join(instanceDir(instances[1]), "mods/retry-b.jar"));
    checks.push(
      "a real failed exact-version request stays inline in the picker and retry revalidates and completes installation into B",
    );
    await open(projects[1].title);
    await target().selectOption(instances[1].id);
    await loaded("failureB");
    await app.evaluate(() => {
      globalThis.__ldfclModQA.installMode = "hold-fail";
    });
    await install().click();
    await until(qa, (value) => value.installHeld, "background install held");
    await page.keyboard.press("Escape");
    await dialog().waitFor({ state: "detached" });
    assert.equal(
      await card(projects[1].title)
        .getByRole("button", { name: "安装中", exact: true })
        .isDisabled(),
      true,
    );
    // Native dialogs block outside pointer input. Activate the real tab through
    // DOM to exercise the component's active=false lifecycle during this request.
    await page
      .getByRole("tab", { name: "资源包", exact: true })
      .evaluate((element) => element.click());
    await app.evaluate(() => {
      globalThis.__ldfclModQA.releaseInstall();
    });
    await page.locator(".toast").getByText(/403/).waitFor();
    await page.getByRole("tab", { name: "Mod 模组", exact: true }).click();
    await until(
      () =>
        card(projects[1].title)
          .getByRole("button", { name: "选择安装位置", exact: true })
          .isEnabled(),
      Boolean,
      "background failure releases project",
    );
    checks.push(
      "closing the busy picker and switching tabs keeps the project locked until settlement, then shows the global failure and allows another attempt",
    );
    await open();
    await loaded("mainA");
    await app.evaluate(() => {
      globalThis.__ldfclModQA.holdA = true;
    });
    await close();
    await open();
    await until(
      qa,
      (value) => value.held === 1,
      "deactivating version request held",
    );
    await page
      .getByRole("tab", { name: "资源包", exact: true })
      .evaluate((element) => element.click());
    await dialog().waitFor({ state: "detached" });
    await app.evaluate(() => {
      const q = globalThis.__ldfclModQA;
      q.holdA = false;
      q.held.splice(0).forEach((resolve) => resolve());
    });
    await page.getByRole("tab", { name: "Mod 模组", exact: true }).click();
    assert.equal(await dialog().count(), 0);
    await open();
    await loaded("mainA");
    await close();
    assert.equal(await panel().getByText("迟到响应不能出现").count(), 0);
    checks.push(
      "deactivation closes the native picker; a late hidden response cannot reopen or contaminate the next picker",
    );
    assert.deepEqual(await snapshot(instanceDir(instances[0])), originalA);
    assert.deepEqual((await qa()).unexpected, []);
    assert.deepEqual(pageErrors, []);
    await shot("complete");
    passed = true;
  } finally {
    if (!passed && page)
      await page
        .screenshot({ path: path.join(output, "mod-download-failure.png") })
        .catch(() => {});
    const diagnostics = app ? await qa().catch(() => undefined) : undefined;
    await finishApp();
    const report = { passed, checks, screenshots, pageErrors, diagnostics };
    await fs.writeFile(
      path.join(output, "mod-download-smoke.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    await fs.rm(work, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
