const { _electron: electron } = require("playwright-core");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const AdmZip = require("adm-zip");

// Real renderer, preload, IPC and local filesystem. Synthetic instances never
// launch Minecraft; native import/folder actions and late IPC replies are
// controlled in the main process. No real accounts or game data are used.
(async () => {
  const project = path.resolve(__dirname, "..");
  const workspace = await fs.mkdtemp(
    path.join(os.tmpdir(), "LDFCL-instances-qa-"),
  );
  const configDir = path.join(workspace, "中文 配置");
  const gameRoot = path.join(configDir, ".minecraft");
  const gameDirectoryId = "instances-qa-standard";
  const output = path.join(project, "test-results");
  const checks = [];
  const pageErrors = [];
  const instances = [
    {
      id: "isolation-a",
      name: "生存世界 A",
      version: "1.21.1",
      loader: "fabric",
      gameDirectoryId,
      versionDirectory: "1.21.1-fabric-isolation-a",
      createdAt: "2026-10-20T00:00:00.000Z",
      gameSettings: { fullscreen: false, lang: "zh_cn", renderDistance: 8 },
    },
    {
      id: "isolation-b",
      name: "冒险世界 B",
      version: "1.20.1",
      loader: "forge",
      gameDirectoryId,
      versionDirectory: "1.20.1-forge-isolation-b",
      createdAt: "2026-10-20T00:00:00.000Z",
      gameSettings: { fullscreen: true, lang: "en_us", renderDistance: 20 },
    },
  ];
  const instanceDir = (instance) =>
    path.join(gameRoot, "versions", instance.versionDirectory);
  let active;

  async function write(file, bytes) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
  }
  function jar(id, name) {
    const zip = new AdmZip();
    zip.addFile(
      "fabric.mod.json",
      Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          id,
          name,
          version: "1.0.0",
        }),
      ),
    );
    return zip.toBuffer();
  }
  async function tree(directory) {
    const result = {};
    async function read(current) {
      for (const entry of await fs.readdir(current, { withFileTypes: true })) {
        const file = path.join(current, entry.name);
        if (entry.isDirectory()) await read(file);
        else if (entry.isFile())
          result[path.relative(directory, file)] = createHash("sha256")
            .update(await fs.readFile(file))
            .digest("hex");
      }
    }
    await read(directory);
    return result;
  }
  async function poll(read, predicate, label, timeout = 10000) {
    const deadline = Date.now() + timeout;
    let last;
    do {
      last = await read();
      if (predicate(last)) return last;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    assert.fail(`${label}: ${JSON.stringify(last)}`);
  }
  const state = (page) => page.evaluate(() => window.launcher.call("state"));
  const qa = () =>
    active.evaluate(() => {
      const value = globalThis.__ldfclInstancesQA;
      return {
        opened: value.opened,
        imports: value.imports,
        held: value.held,
        delayedReturned: value.delayedReturned,
        heldState: value.heldState,
        delayedStateReturned: value.delayedStateReturned,
        heldStateInstanceId: value.heldStateInstanceId,
        lists: value.lists,
      };
    });
  const details = (page) =>
    page.locator("section.instance-details.instance-manager");
  const choice = (page, instance) =>
    page
      .locator(".instance-list .version-choice")
      .filter({ hasText: instance.name });
  const mod = (page, name) =>
    details(page).locator(".mod-row").filter({ hasText: name });
  async function assertMod(page, name, absent) {
    await mod(page, name).waitFor();
    assert.equal(
      await mod(page, absent).count(),
      0,
      `${absent} leaked into the selected instance`,
    );
  }
  async function select(page, instance, expectedMod, absentMod) {
    await choice(page, instance).click();
    await poll(
      () => state(page),
      (value) => value.selectedInstanceId === instance.id,
      `Selection did not persist for ${instance.id}`,
    );
    await poll(
      () => details(page).getAttribute("data-instance-id"),
      (id) => id === instance.id,
      "Right pane did not switch instances",
    );
    assert.equal(
      await choice(page, instance).getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(
      await details(page).locator(".instance-path").getAttribute("title"),
      instanceDir(instance),
      "Displayed game directory must use the selected version directory",
    );
    assert.match(
      await details(page)
        .getByRole("button", { name: "Mod 管理", exact: true })
        .getAttribute("class"),
      /selected/,
    );
    if (expectedMod) await assertMod(page, expectedMod, absentMod);
  }
  async function launch() {
    const env = { ...process.env, LDFCL_DATA_DIR: configDir };
    delete env.ELECTRON_RUN_AS_NODE;
    const executable =
      process.env.LDFCL_TEST_EXECUTABLE || process.env.LDFCL_TEST_EXE;
    active = await electron.launch({
      executablePath: executable || require("electron"),
      args: executable ? [] : [project],
      env,
      timeout: 45000,
    });
    const page = await active.firstWindow();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page
      .getByRole("heading", { name: "开始游戏", exact: true })
      .waitFor();
    await active.evaluate(
      ({ dialog, shell, ipcMain }, fixture) => {
        const original = ipcMain._invokeHandlers.get("launcher:call");
        if (typeof original !== "function")
          throw Error("Launcher IPC handler missing");
        const value = (globalThis.__ldfclInstancesQA = {
          opened: [],
          imports: [],
          lists: [],
          holdId: null,
          held: false,
          delayedReturned: false,
          holdStateId: null,
          awaitingSavedState: false,
          heldState: false,
          delayedStateReturned: false,
          heldStateInstanceId: null,
          importFile: fixture.importFile,
        });
        shell.openPath = async (target) => {
          value.opened.push(target);
          return "";
        };
        dialog.showOpenDialog = async (_window, options) => {
          value.imports.push(options);
          return { canceled: false, filePaths: [value.importFile] };
        };
        ipcMain.removeHandler("launcher:call");
        ipcMain.handle("launcher:call", async (event, method, payload) => {
          const result = await original(event, method, payload);
          if (method === "instance:save" && value.holdStateId === payload.id)
            value.awaitingSavedState = true;
          if (
            method === "state" &&
            value.awaitingSavedState &&
            result.selectedInstanceId === value.holdStateId
          ) {
            // The test issues no state calls between arming and heldState.
            // This genuine snapshot comes from App.refresh after the UI save.
            value.awaitingSavedState = false;
            value.holdStateId = null;
            value.heldState = true;
            value.heldStateInstanceId = result.selectedInstanceId;
            await new Promise((resolve) => {
              value.releaseState = resolve;
            });
            value.delayedStateReturned = true;
          }
          if (method === "mods:list") {
            value.lists.push(payload.id);
            if (value.holdId === payload.id) {
              value.holdId = null;
              value.held = true;
              await new Promise((resolve) => {
                value.release = resolve;
              });
              value.delayedReturned = true;
            }
          }
          return result;
        });
      },
      { importFile: path.join(workspace, "imported-only-a.jar") },
    );
    return page;
  }
  async function openInstances(page) {
    await page
      .locator("aside.sidebar")
      .getByRole("button", { name: "游戏实例", exact: true })
      .click();
    await page.locator(".instances-workspace").waitFor();
    await page
      .getByRole("heading", { name: "游戏版本", exact: true })
      .waitFor();
  }
  async function layout(page, width, height, image) {
    await active.evaluate(
      ({ BrowserWindow }, size) => {
        BrowserWindow.getAllWindows()[0].setContentSize(
          size.width,
          size.height,
        );
      },
      { width, height },
    );
    await page.waitForFunction(
      ({ width, height }) => innerWidth === width && innerHeight === height,
      { width, height },
    );
    const geometry = await page.evaluate(() => {
      const measure = (selector) => {
        const element = document.querySelector(selector);
        const rect = element.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
          client: element.clientWidth,
          scroll: element.scrollWidth,
        };
      };
      return {
        width: innerWidth,
        document: document.documentElement.scrollWidth,
        main: measure(".main-content"),
        workspace: measure(".instances-workspace"),
        left: measure(".instances-sidebar"),
        right: measure(".instance-manager"),
      };
    });
    assert(
      geometry.left.width > 150 &&
        geometry.right.width > 300 &&
        geometry.left.right <= geometry.right.x + 1 &&
        Math.min(geometry.left.bottom, geometry.right.bottom) >
          Math.max(geometry.left.y, geometry.right.y) + 100,
      `${width}x${height} must retain a left/right split: ${JSON.stringify(geometry)}`,
    );
    assert(
      geometry.document <= geometry.width + 1 &&
        [
          geometry.main,
          geometry.workspace,
          geometry.left,
          geometry.right,
        ].every((value) => value.scroll <= value.client + 1),
      `${width}x${height} horizontal overflow: ${JSON.stringify(geometry)}`,
    );
    const search = page
      .locator("aside.instances-sidebar")
      .getByLabel("搜索游戏版本", { exact: true });
    await search.fill("冒险世界");
    await choice(page, instances[1]).waitFor();
    assert.equal(await choice(page, instances[0]).count(), 0);
    await search.fill("");
    await choice(page, instances[0]).waitFor();
    await search.blur();
    await page.mouse.move(width - 8, height - 8);
    await page.screenshot({ path: path.join(output, image) });
  }
  async function folders(page, instance) {
    const pane = details(page);
    assert.equal(
      await pane.locator(".instance-path").textContent(),
      instanceDir(instance),
    );
    const before = (await qa()).opened.length;
    await pane.getByRole("button", { name: "打开目录", exact: true }).click();
    await poll(
      qa,
      (value) => value.opened.length === before + 1,
      "Open instance directory",
    );
    assert.equal((await qa()).opened.at(-1), instanceDir(instance));
    await pane.getByRole("button", { name: "实例概览", exact: true }).click();
    for (const [name, sub] of [
      ["Mod 文件夹", "mods"],
      ["资源包", "resourcepacks"],
      ["光影包", "shaderpacks"],
      ["游戏存档", "saves"],
    ]) {
      const count = (await qa()).opened.length;
      await pane.getByRole("button", { name, exact: true }).click();
      const snapshot = await poll(
        qa,
        (value) => value.opened.length === count + 1,
        `Open ${instance.id}/${sub}`,
      );
      assert.equal(
        snapshot.opened.at(-1),
        path.join(instanceDir(instance), sub),
      );
    }
    await pane.getByRole("button", { name: "Mod 管理", exact: true }).click();
  }

  await fs.mkdir(configDir, { recursive: true });
  await fs.mkdir(output, { recursive: true });
  await write(
    path.join(configDir, "launcher.json"),
    JSON.stringify({
      instances,
      gameDirectories: [
        {
          id: gameDirectoryId,
          name: "界面验证游戏目录",
          path: gameRoot,
          layout: "standard",
        },
      ],
      selectedGameDirectoryId: gameDirectoryId,
      selectedInstanceId: instances[0].id,
    }),
  );
  for (const [index, instance] of instances.entries()) {
    const root = instanceDir(instance);
    const marker = index ? "B" : "A";
    await write(
      path.join(root, `${instance.versionDirectory}.json`),
      JSON.stringify({
        id: instance.versionDirectory,
        type: "release",
        clientVersion: instance.version,
        mainClass: "net.minecraft.client.main.Main",
        libraries: [],
      }),
    );
    await write(
      path.join(root, "mods", "shared.jar"),
      jar(`isolated_${marker.toLowerCase()}`, `Only ${marker} Mod`),
    );
    await write(
      path.join(root, "options.txt"),
      `fullscreen:${instance.gameSettings.fullscreen}\nlang:${instance.gameSettings.lang}\n# retain ${marker}\n`,
    );
    for (const sub of ["config", "saves", "resourcepacks", "shaderpacks"])
      await write(
        path.join(root, sub, "保留用户数据.txt"),
        `Instance ${marker}: ${sub}`,
      );
  }
  await write(
    path.join(workspace, "imported-only-a.jar"),
    jar("imported_only_a", "Imported A Mod"),
  );
  const beforeA = await tree(instanceDir(instances[0]));
  const beforeB = await tree(instanceDir(instances[1]));
  try {
    let page = await launch();
    const initialState = await state(page);
    assert.equal(initialState.system.gameRoot, gameRoot);
    assert.equal(initialState.system.gameDirectoryError, undefined);
    assert.equal(initialState.instances.length, instances.length);
    // Opening the launcher must not start CAS migration or create metadata for
    // either instance. First-use storage work belongs to an explicit mutation.
    assert.deepEqual(await tree(instanceDir(instances[0])), beforeA);
    assert.deepEqual(await tree(instanceDir(instances[1])), beforeB);
    checks.push(
      "startup preserves both instance trees exactly without eager CAS manifests or backups",
    );
    await openInstances(page);
    await assertMod(page, "Only A Mod", "Only B Mod");
    assert.equal(
      await details(page).locator(".instance-path").getAttribute("title"),
      instanceDir(instances[0]),
    );
    assert.match(
      await details(page)
        .getByRole("button", { name: "Mod 管理", exact: true })
        .getAttribute("class"),
      /selected/,
    );
    await layout(page, 1120, 760, "instances-layout.png");
    await layout(page, 960, 640, "instances-compact.png");
    checks.push(
      "1120x760 and 960x640 retain separate version/mod columns without horizontal overflow; version search works",
    );

    await select(page, instances[1], "Only B Mod", "Only A Mod");
    await folders(page, instances[1]);
    await details(page)
      .getByRole("button", { name: "游戏预设", exact: true })
      .click();
    assert.equal(
      await details(page)
        .locator('.options-grid input[type="range"]')
        .first()
        .inputValue(),
      "20",
    );
    assert.match(
      await details(page)
        .getByRole("button", { name: "全屏显示", exact: true })
        .getAttribute("class"),
      /\bon\b/,
    );
    await select(page, instances[0], "Only A Mod", "Only B Mod");
    await folders(page, instances[0]);
    checks.push(
      "left version selection automatically switches the default Mod pane; all folder actions resolve inside the selected instance",
    );

    await details(page)
      .getByRole("button", { name: "导入 Mod", exact: true })
      .click();
    await mod(page, "Imported A Mod").waitFor();
    assert.equal((await qa()).imports.length, 1);
    await fs.access(
      path.join(instanceDir(instances[0]), "mods", "imported-only-a.jar"),
    );
    await details(page).getByLabel("禁用 Only A Mod", { exact: true }).click();
    await details(page)
      .getByLabel("启用 Only A Mod", { exact: true })
      .waitFor();
    await fs.access(
      path.join(instanceDir(instances[0]), "mods", "shared.jar.disabled"),
    );
    await details(page)
      .getByLabel("移除 Imported A Mod", { exact: true })
      .click();
    await mod(page, "Imported A Mod").waitFor({ state: "hidden" });
    await assert.rejects(
      fs.access(
        path.join(instanceDir(instances[0]), "mods", "imported-only-a.jar"),
      ),
    );
    assert.deepEqual(
      await tree(instanceDir(instances[1])),
      beforeB,
      "A Mod actions changed B files",
    );
    checks.push(
      "native Mod import, disable and remove affect only A; B's same-named jar and every user file remain unchanged",
    );

    await details(page)
      .getByRole("button", { name: "游戏预设", exact: true })
      .click();
    assert.equal(
      await details(page)
        .locator('.options-grid input[type="range"]')
        .first()
        .inputValue(),
      "8",
    );
    assert.doesNotMatch(
      await details(page)
        .getByRole("button", { name: "全屏显示", exact: true })
        .getAttribute("class"),
      /\bon\b/,
    );
    await details(page)
      .getByRole("button", { name: "全屏显示", exact: true })
      .click();
    await details(page)
      .getByRole("button", { name: "保存游戏预设", exact: true })
      .click();
    await poll(
      () =>
        fs.readFile(
          path.join(instanceDir(instances[0]), "options.txt"),
          "utf8",
        ),
      (value) => /fullscreen:true/.test(value),
      "A fullscreen option did not save",
    );
    assert.deepEqual(
      await tree(instanceDir(instances[1])),
      beforeB,
      "A options save changed B files",
    );
    const afterA = await tree(instanceDir(instances[0]));
    for (const [file, digest] of Object.entries(beforeA))
      if (!file.startsWith(`mods${path.sep}`) && file !== "options.txt")
        assert.equal(afterA[file], digest, `A user file changed: ${file}`);
    checks.push(
      "game options save only to A; config, saves, resourcepacks and shaderpacks remain byte-for-byte isolated",
    );

    await select(page, instances[1], "Only B Mod", "Only A Mod");
    await active.evaluate((_electron, id) => {
      globalThis.__ldfclInstancesQA.holdId = id;
    }, instances[0].id);
    await select(page, instances[0]);
    await poll(qa, (value) => value.held, "A's old Mod response was not held");
    await select(page, instances[1], "Only B Mod", "Only A Mod");
    await active.evaluate(() => globalThis.__ldfclInstancesQA.release());
    await poll(
      qa,
      (value) => value.delayedReturned,
      "A's old Mod response was not released",
    );
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await assertMod(page, "Only B Mod", "Only A Mod");
    assert.equal(
      await details(page).getAttribute("data-instance-id"),
      instances[1].id,
    );
    assert.equal(
      await details(page)
        .getByLabel("禁用 Only B Mod", { exact: true })
        .isEnabled(),
      true,
    );
    checks.push(
      "a held genuine A mods:list reply arriving after selection of B cannot overwrite B's Mod pane",
    );

    await select(page, instances[0], "Only A Mod", "Only B Mod");
    await details(page)
      .getByRole("button", { name: "游戏预设", exact: true })
      .click();
    await active.evaluate((_electron, id) => {
      globalThis.__ldfclInstancesQA.holdStateId = id;
    }, instances[0].id);
    await details(page)
      .getByRole("button", { name: "保存游戏预设", exact: true })
      .click();
    // Only main-process QA reads are allowed here: using state(page) would risk
    // consuming the target reply before the actual renderer refresh requests it.
    const heldState = await poll(
      qa,
      (value) => value.heldState,
      "App.refresh did not request the held A state after the UI preset save",
    );
    assert.equal(heldState.heldStateInstanceId, instances[0].id);
    await select(page, instances[1], "Only B Mod", "Only A Mod");
    await active.evaluate(() => globalThis.__ldfclInstancesQA.releaseState());
    await poll(
      qa,
      (value) => value.delayedStateReturned,
      "A's old App.refresh state snapshot was not released",
    );
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const actualBackend = await state(page);
    const actualPaneId = await details(page).getAttribute("data-instance-id");
    assert.equal(
      actualPaneId,
      instances[1].id,
      `Old App.refresh state replaced a newer UI selection: ${JSON.stringify({
        actualPaneId,
        backendInstanceId: actualBackend.selectedInstanceId,
        aPressed: await choice(page, instances[0]).getAttribute("aria-pressed"),
        bPressed: await choice(page, instances[1]).getAttribute("aria-pressed"),
        qa: await qa(),
      })}`,
    );
    assert.equal(
      actualBackend.selectedInstanceId,
      instances[1].id,
      "The backend selection must remain B after releasing the old A snapshot",
    );
    assert.equal(
      await choice(page, instances[1]).getAttribute("aria-pressed"),
      "true",
    );
    await assertMod(page, "Only B Mod", "Only A Mod");
    assert.match(
      await details(page)
        .getByRole("button", { name: "Mod 管理", exact: true })
        .getAttribute("class"),
      /selected/,
    );
    checks.push(
      "a genuine old App.refresh state snapshot from A's preset save cannot undo a newer B selection or replace its Mod pane",
    );

    await active.close();
    active = undefined;
    page = await launch();
    const restored = await state(page);
    assert.equal(restored.selectedInstanceId, instances[1].id);
    await openInstances(page);
    assert.equal(
      await choice(page, instances[1]).getAttribute("aria-pressed"),
      "true",
    );
    await assertMod(page, "Only B Mod", "Only A Mod");
    assert.match(
      await details(page)
        .getByRole("button", { name: "Mod 管理", exact: true })
        .getAttribute("class"),
      /selected/,
    );
    assert.deepEqual(
      await tree(instanceDir(instances[1])),
      beforeB,
      "restart must not migrate or add metadata to the unmodified B instance",
    );
    checks.push(
      "selected version persists after restart and reopens its own default Mod management pane",
    );
    assert.deepEqual(pageErrors, []);
    console.log(
      JSON.stringify({
        passed: true,
        checks,
        pageErrors,
        screenshots: [
          "test-results/instances-layout.png",
          "test-results/instances-compact.png",
        ],
        isolatedConfigDir: configDir,
        gameLaunched: false,
      }),
    );
  } finally {
    if (active) await active.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
