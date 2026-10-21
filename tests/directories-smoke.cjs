const { _electron: electron } = require("playwright-core");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const AdmZip = require("adm-zip");

// Uses temporary, synthetic game profiles. It never launches Minecraft or opens
// real file pickers, and verifies that existing game files remain untouched.
(async () => {
  const project = path.resolve(__dirname, "..");
  const workspace = await fs.mkdtemp(
    path.join(os.tmpdir(), "LDFCL-directories-qa-"),
  );
  const configDir = path.join(workspace, "启动器配置");
  const gameA = path.join(workspace, "中文 空格 游戏 A", ".minecraft");
  const gameB = path.join(workspace, "另一处 游戏 B");
  const existingVersionDirectory = "1.16.5-optifine";
  const output = path.join(project, "test-results");
  const checks = [];
  const pageErrors = [];
  const originals = new Map();
  let active;

  async function writeFixture(file, bytes) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
    originals.set(file, Buffer.from(bytes));
  }
  async function version(root, id, extra = {}, preserve = true) {
    const profile = {
      id,
      type: "release",
      mainClass: "net.minecraft.client.main.Main",
      arguments: { game: [], jvm: [] },
      libraries: [],
      javaVersion: { majorVersion: 17 },
      ...extra,
    };
    const file = path.join(root, "versions", id, `${id}.json`);
    if (preserve) await writeFixture(file, JSON.stringify(profile));
    else {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(profile));
    }
    const jar = new AdmZip();
    jar.addFile(
      "QA-NOT-A-REAL-GAME.txt",
      Buffer.from("Synthetic scan fixture"),
    );
    if (preserve)
      await writeFixture(
        path.join(root, "versions", id, `${id}.jar`),
        jar.toBuffer(),
      );
    return file;
  }
  async function seedGame(root, marker) {
    await version(root, "1.20.1");
    await version(root, "fabric-loader-0.16.10-1.20.1", {
      inheritsFrom: "1.20.1",
      mainClass: "net.fabricmc.loader.impl.launch.knot.KnotClient",
      libraries: [{ name: "net.fabricmc:fabric-loader:0.16.10" }],
    });
    await writeFixture(
      path.join(root, "mods", "existing-user-mod.txt"),
      marker,
    );
    await writeFixture(
      path.join(root, "saves", "用户原存档", "keep.txt"),
      marker,
    );
    await writeFixture(
      path.join(root, "options.txt"),
      `fullscreen:false\n# ${marker}\n`,
    );
  }
  async function modFile(name, id) {
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
    const file = path.join(workspace, `${id}.jar`);
    await fs.writeFile(file, zip.toBuffer());
    return file;
  }
  await fs.mkdir(configDir, { recursive: true });
  await fs.mkdir(output, { recursive: true });
  await seedGame(gameA, "Original game A");
  await seedGame(gameB, "Original game B");
  await version(gameA, "1.16.5");
  await version(gameA, existingVersionDirectory, {
    inheritsFrom: "1.16.5",
    mainClass: "net.minecraft.launchwrapper.Launch",
    libraries: [{ name: "optifine:OptiFine:1.16.5_HD_U_G8" }],
  });
  const modA = await modFile("Directory A Mod", "directory_a_mod");
  const modB = await modFile("Directory B Mod", "directory_b_mod");
  const originalVersionMod = await modFile(
    "Existing OptiFine Mod",
    "existing_optifine_mod",
  );
  const existingRuntime = path.join(
    gameA,
    "versions",
    existingVersionDirectory,
  );
  const existingModPath = path.join(
    existingRuntime,
    "mods",
    path.basename(originalVersionMod),
  );
  await writeFixture(existingModPath, await fs.readFile(originalVersionMod));
  const existingSavePath = path.join(
    existingRuntime,
    "saves",
    "已有 OptiFine 世界",
    "keep.txt",
  );
  await writeFixture(
    existingSavePath,
    "Keep the existing version save in place",
  );

  async function launch() {
    const env = { ...process.env, LDFCL_DATA_DIR: configDir };
    delete env.ELECTRON_RUN_AS_NODE;
    const executable =
      process.env.LDFCL_TEST_EXE || process.env.LDFCL_TEST_EXECUTABLE;
    active = await electron.launch({
      executablePath: executable || require("electron"),
      args: executable ? [] : [project],
      env,
      timeout: 45000,
    });
    const page = await active.firstWindow();
    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.on("dialog", (dialog) => void dialog.accept());
    await page
      .getByRole("heading", { name: "开始游戏", exact: true })
      .waitFor();
    await active.evaluate(({ dialog, shell }) => {
      const qa = (globalThis.__ldfclDirectoriesQA = {
        nextFolder: null,
        nextFiles: [],
        opened: [],
        trashed: [],
        holdModImport: false,
        held: false,
        release: null,
        holdDirectoryPick: false,
        directoryHeld: false,
        releaseDirectory: null,
      });
      dialog.showOpenDialog = async (...args) => {
        const options = args[args.length - 1];
        if (options.properties?.includes("openDirectory")) {
          if (qa.holdDirectoryPick) {
            qa.directoryHeld = true;
            return new Promise((resolve) => {
              qa.releaseDirectory = resolve;
            });
          }
          const selected = qa.nextFolder;
          qa.nextFolder = null;
          return { canceled: !selected, filePaths: selected ? [selected] : [] };
        }
        if (qa.holdModImport) {
          qa.held = true;
          return new Promise((resolve) => {
            qa.release = resolve;
          });
        }
        return { canceled: false, filePaths: qa.nextFiles };
      };
      shell.openPath = async (target) => {
        qa.opened.push(target);
        return "";
      };
      shell.trashItem = async (target) => {
        qa.trashed.push(target);
        throw new Error("Directory QA must not trash an existing version");
      };
    });
    return page;
  }
  const state = (page) => page.evaluate(() => window.launcher.call("state"));
  const call = (page, method, payload) =>
    page.evaluate(
      ({ method, payload }) => window.launcher.call(method, payload),
      { method, payload },
    );
  async function waitForState(page, predicate, label, timeout = 10000) {
    const deadline = Date.now() + timeout;
    let last;
    do {
      last = await state(page);
      if (predicate(last)) return last;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    assert.fail(`${label}: ${JSON.stringify(last)}`);
  }
  async function selected(page, root) {
    return waitForState(
      page,
      (value) => value.system.gameRoot === root,
      `Selected game directory did not become ${root}`,
    );
  }
  async function settings(page) {
    await page
      .locator("aside.sidebar")
      .getByRole("button", { name: "启动器设置", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "游戏目录", exact: true })
      .waitFor();
  }
  function directory(s, root) {
    const found = s.gameDirectories.find((entry) => entry.path === root);
    assert(found, `Registered game directory missing: ${root}`);
    return found;
  }
  function fabric(s) {
    const found = s.instances.find((instance) => instance.loader === "fabric");
    assert(found, "Existing Fabric profile must be detected");
    assert.equal(found.version, "1.20.1");
    assert.equal(found.versionDirectory, "fabric-loader-0.16.10-1.20.1");
    return found;
  }
  const instanceDirectory = (root, instance) =>
    path.join(
      root,
      "versions",
      instance.versionDirectory || instance.importedVersionId || instance.id,
    );
  async function originalsUnchanged() {
    for (const [file, bytes] of originals)
      assert.deepEqual(await fs.readFile(file), bytes, file);
  }
  function directoryState(s) {
    return {
      selectedGameDirectoryId: s.selectedGameDirectoryId,
      selectedInstanceId: s.selectedInstanceId,
      gameRoot: s.system.gameRoot,
      settingsGameRoot: s.settings.gameRoot,
      gameDirectories: s.gameDirectories,
      instances: s.instances,
    };
  }
  async function waitForMain(flag, message) {
    const deadline = Date.now() + 10000;
    while (
      !(await active.evaluate(
        (_electron, key) => globalThis.__ldfclDirectoriesQA[key],
        flag,
      ))
    ) {
      assert(Date.now() < deadline, message);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  try {
    let page = await launch();
    let s = await state(page);
    const defaultRoot = path.join(configDir, ".minecraft");
    assert.equal(s.system.defaultGameRoot, defaultRoot);
    assert.equal(s.system.gameRoot, defaultRoot);
    assert.equal(s.instances.length, 0);
    const defaultDirectory = directory(s, defaultRoot);
    await call(page, "account:offline", { name: "Directory_QA" });
    const accountId = (await state(page)).accounts[0].id;
    await settings(page);
    assert.equal(
      await page
        .locator(`[data-game-directory-id="${defaultDirectory.id}"]`)
        .getByRole("button", { name: "移除目录", exact: true })
        .count(),
      0,
    );
    await assert.rejects(
      call(page, "game-directory:remove", { id: defaultDirectory.id }),
    );
    checks.push(
      "isolated default .minecraft root and protected default registration",
    );

    await active.evaluate((_electron, target) => {
      globalThis.__ldfclDirectoriesQA.nextFolder = target;
    }, gameA);
    await page
      .getByRole("button", { name: "添加游戏目录", exact: true })
      .click();
    s = await selected(page, gameA);
    const registeredA = directory(s, gameA);
    const instanceA = fabric(s);
    assert.equal(s.selectedGameDirectoryId, registeredA.id);
    assert.equal(s.accounts[0].id, accountId);
    const rowA = page.locator(`[data-game-directory-id="${registeredA.id}"]`);
    await rowA.getByText(gameA, { exact: true }).waitFor();
    assert.equal(
      await rowA.getByRole("button", { name: "使用目录", exact: true }).count(),
      0,
    );
    await rowA.getByText("当前使用", { exact: true }).waitFor();
    await rowA.getByRole("button", { name: "打开目录", exact: true }).click();
    assert.equal(
      (await active.evaluate(() => globalThis.__ldfclDirectoriesQA.opened)).at(
        -1,
      ),
      gameA,
    );
    checks.push(
      "folder picker registers Chinese/space path, selects it, and detects existing vanilla/Fabric profiles",
    );

    const existingInstance = s.instances.find(
      (instance) =>
        instance.importedVersionId === existingVersionDirectory ||
        instance.versionDirectory === existingVersionDirectory,
    );
    assert(existingInstance, "Existing OptiFine version must be detected");
    assert.equal(existingInstance.versionDirectory, existingVersionDirectory);
    assert.equal(instanceDirectory(gameA, existingInstance), existingRuntime);
    await page
      .locator("aside.sidebar")
      .getByRole("button", { name: "游戏实例", exact: true })
      .click();
    const existingLoaderLabel =
      {
        vanilla: "原版",
        fabric: "Fabric",
        quilt: "Quilt",
        forge: "Forge",
        optifine: "OptiFine",
      }[existingInstance.loader] || existingInstance.loader;
    const existingChoice = page
      .locator("aside.instances-sidebar")
      .getByRole("button", {
        name: `${existingInstance.name} ${existingInstance.version} ${existingLoaderLabel}`,
        exact: true,
      });
    await existingChoice.click();
    const existingPane = page.locator(
      `.instance-manager[data-instance-id="${existingInstance.id}"]`,
    );
    await existingPane.waitFor();
    assert.equal(await existingChoice.getAttribute("aria-pressed"), "true");
    assert.equal((await state(page)).selectedInstanceId, existingInstance.id);
    assert.equal(
      await existingPane.locator(".instance-path").getAttribute("title"),
      existingRuntime,
    );
    await existingPane
      .locator(".mod-row")
      .filter({ hasText: "Existing OptiFine Mod" })
      .waitFor();
    const [existingMod] = await call(page, "mods:list", {
      id: existingInstance.id,
    });
    assert.equal(existingMod.id, "existing_optifine_mod");
    await call(page, "folder", { id: existingInstance.id });
    assert.equal(
      (await active.evaluate(() => globalThis.__ldfclDirectoriesQA.opened)).at(
        -1,
      ),
      existingRuntime,
    );
    await call(page, "folder", { id: existingInstance.id, sub: "saves" });
    assert.equal(
      (await active.evaluate(() => globalThis.__ldfclDirectoriesQA.opened)).at(
        -1,
      ),
      path.join(existingRuntime, "saves"),
    );
    await call(page, "mods:toggle", {
      id: existingInstance.id,
      file: existingMod.file,
      enabled: false,
    });
    await fs.access(`${existingModPath}.disabled`);
    await assert.rejects(fs.access(existingModPath));
    await call(page, "mods:toggle", {
      id: existingInstance.id,
      file: `${existingMod.file}.disabled`,
      enabled: true,
    });
    await fs.access(existingModPath);
    await assert.rejects(fs.access(`${existingModPath}.disabled`));
    await call(page, "instance:save", {
      id: existingInstance.id,
      gameSettings: { renderDistance: 10 },
    });
    assert.match(
      await fs.readFile(path.join(existingRuntime, "options.txt"), "utf8"),
      /renderDistance:10/,
    );
    await originalsUnchanged();
    await assert.rejects(fs.access(path.join(gameA, "instances")));
    checks.push(
      "existing versions/1.16.5-optifine displays its real directory and manages its original Mod, options and save in place without moving user files",
    );

    const dependentVersionDirectory = "1.16.5-optifine-alias";
    await version(gameA, dependentVersionDirectory, {
      inheritsFrom: existingVersionDirectory,
      jar: existingVersionDirectory,
    });
    const withDependent = await call(page, "game-directory:scan");
    assert(
      withDependent.instances.some(
        (instance) => instance.versionDirectory === dependentVersionDirectory,
      ),
      "Rescan must register the profile that depends on OptiFine",
    );
    const instanceIdsBeforeDelete = withDependent.instances
      .map((instance) => instance.id)
      .sort();
    await assert.rejects(
      call(page, "instance:delete", { id: existingInstance.id }),
      /仍依赖此版本的配置或 JAR/,
    );
    assert.deepEqual(
      await active.evaluate(() => globalThis.__ldfclDirectoriesQA.trashed),
      [],
      "A version with dependants must be rejected before trashItem is called",
    );
    assert.deepEqual(
      (await state(page)).instances.map((instance) => instance.id).sort(),
      instanceIdsBeforeDelete,
    );
    for (const directory of [
      existingVersionDirectory,
      dependentVersionDirectory,
    ])
      for (const extension of ["json", "jar"])
        await fs.access(
          path.join(gameA, "versions", directory, `${directory}.${extension}`),
        );
    await originalsUnchanged();
    checks.push(
      "rescan preserves a dependent profile and rejects deleting its parent before trashing any version directory or changing the instance registry",
    );
    await call(page, "select", { instanceId: instanceA.id });
    await settings(page);

    await active.evaluate((_electron, file) => {
      globalThis.__ldfclDirectoriesQA.nextFiles = [file];
    }, modA);
    await call(page, "mods:import", { id: instanceA.id });
    await call(page, "instance:save", {
      id: instanceA.id,
      gameSettings: { fullscreen: true, renderDistance: 12 },
    });
    const runtimeA = instanceDirectory(s.system.gameRoot, instanceA);
    assert.equal(
      runtimeA,
      path.join(gameA, "versions", "fabric-loader-0.16.10-1.20.1"),
    );
    await fs.access(path.join(runtimeA, "mods", path.basename(modA)));
    const optionsA = await fs.readFile(
      path.join(runtimeA, "options.txt"),
      "utf8",
    );
    assert.match(optionsA, /fullscreen:true/);
    await fs.mkdir(path.join(runtimeA, "saves", "实例存档"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(runtimeA, "saves", "实例存档", "keep.txt"),
      "Isolated A save",
    );
    await call(page, "folder", { id: instanceA.id, sub: "saves" });
    assert.equal(
      (await active.evaluate(() => globalThis.__ldfclDirectoriesQA.opened)).at(
        -1,
      ),
      path.join(runtimeA, "saves"),
    );
    assert.equal(
      (await call(page, "mods:list", { id: instanceA.id }))[0].id,
      "directory_a_mod",
    );

    const beforeHeldRead = directoryState(await state(page));
    await active.evaluate(
      (_electron, target) => {
        const files = process.getBuiltinModule("node:fs/promises");
        const originalReadFile = files.readFile;
        const qa = globalThis.__ldfclDirectoriesQA;
        qa.originalReadFile = originalReadFile;
        qa.holdModRead = true;
        qa.modReadHeld = false;
        qa.releaseModRead = null;
        files.readFile = async (...args) => {
          if (qa.holdModRead && String(args[0]) === target) {
            qa.holdModRead = false;
            qa.modReadHeld = true;
            await new Promise((resolve) => {
              qa.releaseModRead = resolve;
            });
          }
          return originalReadFile(...args);
        };
      },
      path.join(runtimeA, ".ldfcl-content.json"),
    );
    const heldModRead = call(page, "mods:list", { id: instanceA.id });
    heldModRead.catch(() => {});
    let readMods;
    try {
      await waitForMain(
        "modReadHeld",
        "The real Mod service did not enter its metadata read",
      );
      await assert.rejects(
        call(page, "instance:delete", { id: instanceA.id }),
        /正在运行或处理任务|等待所有安装和文件操作完成/,
      );
      assert.deepEqual(
        await active.evaluate(() => globalThis.__ldfclDirectoriesQA.trashed),
        [],
        "An in-flight Mod read must block deletion before trashItem",
      );
      assert.deepEqual(directoryState(await state(page)), beforeHeldRead);
      await fs.access(
        path.join(runtimeA, `${instanceA.versionDirectory}.json`),
      );
      await fs.access(path.join(runtimeA, "mods", path.basename(modA)));
    } finally {
      await active.evaluate(() => {
        const files = process.getBuiltinModule("node:fs/promises");
        const qa = globalThis.__ldfclDirectoriesQA;
        qa.holdModRead = false;
        qa.releaseModRead?.();
        if (qa.originalReadFile) {
          files.readFile = qa.originalReadFile;
          delete qa.originalReadFile;
        }
      });
      readMods = await heldModRead;
    }
    assert.equal(readMods[0].id, "directory_a_mod");
    assert.equal(
      (await call(page, "mods:list", { id: instanceA.id }))[0].id,
      "directory_a_mod",
    );
    checks.push(
      "a genuine in-flight mods:list filesystem read blocks version deletion before trashing, then finishes normally after release",
    );
    await originalsUnchanged();
    checks.push(
      "mods/options/saves use the active root's versions/profile directory without changing original version metadata or shared saves",
    );

    await call(page, "game-directory:add", { path: gameB });
    s = await selected(page, gameB);
    const registeredB = directory(s, gameB);
    const instanceB = fabric(s);
    assert.deepEqual(await call(page, "mods:list", { id: instanceB.id }), []);
    await active.evaluate((_electron, file) => {
      globalThis.__ldfclDirectoriesQA.nextFiles = [file];
    }, modB);
    await call(page, "mods:import", { id: instanceB.id });
    await call(page, "instance:save", {
      id: instanceB.id,
      gameSettings: { fullscreen: false, maxFps: 60 },
    });
    const runtimeB = instanceDirectory(s.system.gameRoot, instanceB);
    assert.equal(
      runtimeB,
      path.join(gameB, "versions", "fabric-loader-0.16.10-1.20.1"),
    );
    assert.notEqual(runtimeB, runtimeA);
    await fs.access(path.join(runtimeB, "mods", path.basename(modB)));
    assert.match(
      await fs.readFile(path.join(runtimeB, "options.txt"), "utf8"),
      /fullscreen:false/,
    );
    assert.equal(
      await fs.readFile(path.join(runtimeA, "options.txt"), "utf8"),
      optionsA,
    );
    assert.equal(
      await fs.readFile(
        path.join(runtimeA, "saves", "实例存档", "keep.txt"),
        "utf8",
      ),
      "Isolated A save",
    );
    await assert.rejects(
      fs.access(path.join(runtimeB, "mods", path.basename(modA))),
    );
    await assert.rejects(fs.access(path.join(configDir, "instances")));
    assert.equal(s.accounts[0].id, accountId);
    checks.push(
      "arbitrary second root isolates mods/settings/saves while sharing account configuration",
    );

    await version(gameB, "1.19.4", {}, false);
    const beforeScan = await state(page);
    await page
      .getByRole("button", { name: "重新扫描版本", exact: true })
      .click();
    const scanned = await waitForState(
      page,
      (value) => value.instances.some((i) => i.version === "1.19.4"),
      "Rescan did not discover 1.19.4",
    );
    const rescanned = await call(page, "game-directory:scan");
    const scanDetails = (value) => ({
      gameRoot: value.system.gameRoot,
      selectedGameDirectoryId: value.selectedGameDirectoryId,
      instances: value.instances.map(
        ({
          id,
          version,
          versionDirectory,
          importedVersionId,
          gameDirectoryId,
        }) => ({
          id,
          version,
          versionDirectory,
          importedVersionId,
          gameDirectoryId,
        }),
      ),
    });
    assert.deepEqual(
      rescanned.instances.map((i) => i.id).sort(),
      scanned.instances.map((i) => i.id).sort(),
      JSON.stringify({
        beforeScan: scanDetails(beforeScan),
        scanned: scanDetails(scanned),
        rescanned: scanDetails(rescanned),
      }),
    );
    checks.push(
      "rescan detects newly added local versions and remains idempotent",
    );

    await page
      .locator(`[data-game-directory-id="${registeredA.id}"]`)
      .getByRole("button", { name: "使用目录", exact: true })
      .click();
    s = await selected(page, gameA);
    await call(page, "select", { instanceId: instanceA.id });
    assert.equal(
      (await call(page, "mods:list", { id: instanceA.id }))[0].id,
      "directory_a_mod",
    );
    await active.evaluate(() => {
      globalThis.__ldfclDirectoriesQA.holdModImport = true;
    });
    const pendingImport = call(page, "mods:import", { id: instanceA.id });
    // Observe both branches immediately so a test failure cannot leave an
    // unhandled rejection while the intentionally held picker is released.
    pendingImport.catch(() => {});
    try {
      const heldDeadline = Date.now() + 10000;
      while (
        !(await active.evaluate(() => globalThis.__ldfclDirectoriesQA.held))
      ) {
        assert(
          Date.now() < heldDeadline,
          "Mod import did not acquire its task lock",
        );
        await page.waitForTimeout(25);
      }
      await assert.rejects(
        call(page, "game-directory:select", { id: registeredB.id }),
      );
      assert.equal((await state(page)).system.gameRoot, gameA);
    } finally {
      await active.evaluate(() => {
        const qa = globalThis.__ldfclDirectoriesQA;
        qa.holdModImport = false;
        qa.release?.({ canceled: true, filePaths: [] });
      });
      await pendingImport;
    }
    checks.push("active content task blocks game-directory switching");

    const beforePicker = directoryState(await state(page));
    await active.evaluate(() => {
      globalThis.__ldfclDirectoriesQA.holdDirectoryPick = true;
    });
    const pendingDirectory = call(page, "game-directory:add");
    pendingDirectory.catch(() => {});
    try {
      await waitForMain(
        "directoryHeld",
        "Directory picker did not acquire the directory change gate",
      );
      await assert.rejects(
        call(page, "mods:list", { id: instanceA.id }),
        /游戏目录正在切换/,
      );
      await assert.rejects(call(page, "versions"), /游戏目录正在切换/);
      await assert.rejects(call(page, "runtime"), /游戏目录正在切换/);
      assert.deepEqual(directoryState(await state(page)), beforePicker);
    } finally {
      await active.evaluate(() => {
        const qa = globalThis.__ldfclDirectoriesQA;
        qa.holdDirectoryPick = false;
        qa.releaseDirectory?.({ canceled: true, filePaths: [] });
      });
      assert.equal(await pendingDirectory, null);
    }
    assert.deepEqual(directoryState(await state(page)), beforePicker);
    assert.equal(
      (await call(page, "mods:list", { id: instanceA.id }))[0].id,
      "directory_a_mod",
    );
    checks.push(
      "held add-directory picker rejects mods/version/runtime reads and preserves the original root",
    );

    const beforeFailure = directoryState(await state(page));
    const persistedBeforeFailure = await fs.readFile(
      path.join(configDir, "launcher.json"),
    );
    const optionsBeforeFailureB = await fs.readFile(
      path.join(runtimeB, "options.txt"),
      "utf8",
    );
    await active.evaluate((_electron, directory) => {
      // getBuiltinModule returns the same cached fs/promises object as
      // require("node:fs/promises") in the Electron main process.
      const files = process.getBuiltinModule("node:fs/promises");
      const path = process.getBuiltinModule("node:path");
      const qa = globalThis.__ldfclDirectoriesQA;
      const from = path.join(directory, "launcher.json.tmp");
      const to = path.join(directory, "launcher.json");
      qa.originalRename = files.rename;
      qa.renameFailures = 0;
      files.rename = async (...args) => {
        if (String(args[0]) === from && String(args[1]) === to) {
          qa.renameFailures++;
          const error = new Error(
            "Directory QA injected launcher configuration rename EACCES",
          );
          error.code = "EACCES";
          throw error;
        }
        return qa.originalRename(...args);
      };
    }, configDir);
    try {
      await assert.rejects(
        call(page, "game-directory:select", { id: registeredB.id }),
        /EACCES/,
      );
      assert.equal(
        await active.evaluate(
          () => globalThis.__ldfclDirectoriesQA.renameFailures,
        ),
        1,
      );
      assert.deepEqual(directoryState(await state(page)), beforeFailure);
      assert.deepEqual(
        await fs.readFile(path.join(configDir, "launcher.json")),
        persistedBeforeFailure,
      );
      assert.equal(
        (await call(page, "mods:list", { id: instanceA.id }))[0].id,
        "directory_a_mod",
      );
      await call(page, "folder", { id: instanceA.id, sub: "saves" });
      assert.equal(
        (
          await active.evaluate(() => globalThis.__ldfclDirectoriesQA.opened)
        ).at(-1),
        path.join(runtimeA, "saves"),
      );
    } finally {
      await active.evaluate(() => {
        const qa = globalThis.__ldfclDirectoriesQA;
        if (qa.originalRename) {
          process.getBuiltinModule("node:fs/promises").rename =
            qa.originalRename;
          delete qa.originalRename;
        }
      });
    }
    // A successful write after rollback proves the active instance path still
    // belongs to A and that the recovered save queue remains usable.
    await call(page, "instance:save", {
      id: instanceA.id,
      gameSettings: { renderDistance: 14 },
    });
    assert.match(
      await fs.readFile(path.join(runtimeA, "options.txt"), "utf8"),
      /renderDistance:14/,
    );
    assert.equal(
      await fs.readFile(path.join(runtimeB, "options.txt"), "utf8"),
      optionsBeforeFailureB,
    );
    await originalsUnchanged();
    checks.push(
      "launcher rename EACCES rolls back directory state, persistent selection and active content/file paths",
    );

    await active.close();
    active = undefined;
    page = await launch();
    s = await state(page);
    assert.equal(s.selectedGameDirectoryId, registeredA.id);
    assert.equal(s.system.gameRoot, gameA);
    assert.equal(s.selectedInstanceId, instanceA.id);
    assert.equal(s.accounts[0].id, accountId);
    assert.equal(
      (await call(page, "mods:list", { id: instanceA.id }))[0].id,
      "directory_a_mod",
    );
    checks.push(
      "selected game root, instance and global account persist across restart",
    );
    await call(page, "game-directory:select", { id: registeredB.id });
    s = await selected(page, gameB);
    assert.equal(s.selectedGameDirectoryId, registeredB.id);
    assert.equal(
      (await call(page, "mods:list", { id: instanceB.id }))[0].id,
      "directory_b_mod",
    );
    await call(page, "game-directory:select", { id: registeredA.id });
    await selected(page, gameA);
    checks.push(
      "failed root selection remains rolled back after restart and succeeds once the fault is removed",
    );

    await settings(page);
    const removable = page.locator(
      `[data-game-directory-id="${registeredB.id}"]`,
    );
    await removable
      .getByRole("button", { name: "移除目录", exact: true })
      .click();
    await removable.waitFor({ state: "hidden" });
    s = await state(page);
    assert.equal(
      s.gameDirectories.some((entry) => entry.id === registeredB.id),
      false,
    );
    assert.equal(s.system.gameRoot, gameA);
    await fs.access(path.join(runtimeB, "mods", path.basename(modB)));
    await fs.access(path.join(runtimeB, "options.txt"));
    await originalsUnchanged();
    await page.screenshot({ path: path.join(output, "game-directories.png") });
    assert.deepEqual(pageErrors, []);
    checks.push(
      "unregister removes only the registry entry and preserves all game data",
    );
    console.log(
      JSON.stringify({
        passed: true,
        checks,
        pageErrors,
        screenshot: "test-results/game-directories.png",
        isolatedConfigDir: configDir,
        gameRoots: [defaultRoot, gameA, gameB],
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
