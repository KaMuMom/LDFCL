const { chromium } = require("playwright-core");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

// Unlike portable-smoke.cjs, this check does not override LDFCL's game or
// configuration directories through environment variables. The real portable
// wrapper must derive both LDFCL-data and .minecraft from the copied EXE's
// location. --user-data-dir isolates Chromium/AppData only, not launcher files.
(async () => {
  const project = path.resolve(__dirname, "..");
  const source =
    process.env.LDFCL_TEST_PORTABLE_EXE ||
    path.join(
      project,
      "release",
      `LDFCL-${require("../package.json").version}-Windows-x64.exe`,
    );
  await fs.access(source);
  const workspace = await fs.mkdtemp(
    path.join(os.tmpdir(), "LDFCL-real-portable-qa-"),
  );
  const portableDir = path.join(workspace, "中文 空格 便携启动器");
  const chromiumDir = path.join(workspace, "独立 Chromium 用户数据");
  const movedPortableDir = path.join(
    workspace,
    "移动后的 中文 空格 便携启动器",
  );
  const movedChromiumDir = path.join(
    workspace,
    "移动后 全新 Chromium 用户数据",
  );
  const dataDir = path.join(portableDir, "LDFCL-data");
  const movedDataDir = path.join(movedPortableDir, "LDFCL-data");
  const movedDefaultRoot = path.join(movedPortableDir, ".minecraft");
  const customRoot = path.join(workspace, "自定义 游戏目录");
  const defaultRoot = path.join(portableDir, ".minecraft");
  const executable = path.join(portableDir, path.basename(source));
  const output = path.join(project, "test-results");
  const checks = [];
  const pageErrors = [];
  let session;
  await fs.mkdir(portableDir, { recursive: true });
  await fs.mkdir(chromiumDir, { recursive: true });
  await fs.mkdir(movedChromiumDir, { recursive: true });
  await fs.mkdir(customRoot, { recursive: true });
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(
    path.join(customRoot, "保留用户文件.txt"),
    "Portable directory fixture",
  );
  await fs.copyFile(source, executable);

  async function port() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const result = server.address().port;
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    return result;
  }
  async function launch(directory = portableDir, browserDataDir = chromiumDir) {
    const cdpPort = await port();
    const env = { ...process.env };
    for (const key of [
      "LDFCL_DATA_DIR",
      "LDFCL_GAME_ROOT",
      "LDFCL_DEV_URL",
      "PORTABLE_EXECUTABLE_DIR",
      "PORTABLE_EXECUTABLE_FILE",
      "PORTABLE_EXECUTABLE_FILENAME",
      "PORTABLE_EXECUTABLE_APP_FILENAME",
      "ELECTRON_RUN_AS_NODE",
    ])
      delete env[key];
    const run = {
      child: null,
      browser: null,
      page: null,
      exited: false,
      exitCode: undefined,
      spawnError: null,
    };
    session = run;
    run.child = spawn(
      path.join(directory, path.basename(source)),
      [
        `--user-data-dir=${browserDataDir}`,
        `--remote-debugging-port=${cdpPort}`,
      ],
      { env, windowsHide: true, stdio: "ignore" },
    );
    run.child.once("error", (error) => {
      run.spawnError = error;
      run.exited = true;
    });
    run.child.once("exit", (code) => {
      run.exitCode = code;
      run.exited = true;
    });
    const deadline = Date.now() + 60000;
    let endpoint;
    while (Date.now() < deadline) {
      if (run.spawnError) throw run.spawnError;
      if (run.exited)
        throw Error(
          `Copied portable EXE exited before startup: ${run.exitCode}`,
        );
      try {
        const response = await fetch(
          `http://127.0.0.1:${cdpPort}/json/version`,
        );
        if (response.ok) {
          endpoint = await response.json();
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert(
      endpoint?.webSocketDebuggerUrl,
      "Copied portable EXE did not expose its CDP endpoint",
    );
    run.browser = await chromium.connectOverCDP(endpoint.webSocketDebuggerUrl);
    run.page = run.browser.contexts()[0].pages()[0];
    assert(run.page, "Portable application window is missing");
    run.page.on("pageerror", (error) => pageErrors.push(error.message));
    await run.page
      .getByRole("heading", { name: "开始游戏", exact: true })
      .waitFor();
    return run;
  }
  const state = (run) => run.page.evaluate(() => window.launcher.call("state"));
  const call = (run, method, payload) =>
    run.page.evaluate(
      ({ method, payload }) => window.launcher.call(method, payload),
      { method, payload },
    );
  async function kill(run) {
    if (!run || run.exited || !run.child?.pid) return;
    await new Promise((resolve) => {
      const killer = spawn(
        "taskkill",
        ["/PID", String(run.child.pid), "/T", "/F"],
        {
          windowsHide: true,
          stdio: "ignore",
        },
      );
      killer.once("exit", resolve);
      killer.once("error", resolve);
    });
  }
  async function stop(run) {
    await run.page.evaluate(() => window.launcher.window("close"));
    const deadline = Date.now() + 15000;
    while (!run.exited && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 200));
    assert(
      run.exited,
      "Copied portable wrapper did not exit after closing its window",
    );
    assert.equal(run.exitCode, 0, "Copied portable EXE did not exit cleanly");
    await run.browser.close().catch(() => {});
    session = undefined;
  }

  const persistedSettings = {
    downloadConcurrency: 13,
    memoryMode: "manual",
    memoryMb: 2048,
    closeOnLaunch: false,
  };
  const favorite = {
    projectId: "portable-mod-qa",
    slug: "portable-synthetic-mod",
    title: "便携版合成模组收藏",
    description: "仅用于本地持久化验证，无需联网或下载。",
    author: "LDFCL QA",
  };
  const renamedSkin = "便携版已重命名皮肤";
  // Valid RGBA 64x64 PNG, including chunk CRCs and actual compressed scanlines.
  // Uses the same offline fixture construction as skin-library-smoke.cjs.
  function fixturePng() {
    const crc = (bytes) => {
      let value = 0xffffffff;
      for (const byte of bytes) {
        value ^= byte;
        for (let bit = 0; bit < 8; bit++)
          value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
      }
      return (value ^ 0xffffffff) >>> 0;
    };
    const chunk = (name, bytes) => {
      const result = Buffer.alloc(bytes.length + 12);
      result.writeUInt32BE(bytes.length);
      result.write(name, 4);
      bytes.copy(result, 8);
      result.writeUInt32BE(crc(result.subarray(4, -4)), result.length - 4);
      return result;
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(64);
    header.writeUInt32BE(64, 4);
    header[8] = 8;
    header[9] = 6;
    const pixels = Buffer.alloc(64 * 257);
    for (let y = 0; y < 64; y++)
      for (let x = 0; x < 64; x++) {
        const offset = y * 257 + 1 + x * 4;
        pixels[offset] = (x * 3 + 80) % 256;
        pixels[offset + 1] = (y * 3 + 100) % 256;
        pixels[offset + 2] = 180;
        pixels[offset + 3] = x >= 32 && y < 16 ? 0 : 255;
      }
    return Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", zlib.deflateSync(pixels)),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  }
  const skinBytes = fixturePng();
  async function assertPortableCollections(run, directory, skinId) {
    assert.deepEqual(await call(run, "mod-favorites:list"), [favorite]);
    const skins = await call(run, "skin-library:list");
    assert.equal(skins.length, 1);
    assert.equal(skins[0].id, skinId);
    assert.equal(skins[0].name, renamedSkin);
    assert.equal(skins[0].variant, "slim");
    assert.equal(
      skins[0].dataUrl,
      `data:image/png;base64,${skinBytes.toString("base64")}`,
    );
    const savedFavorites = JSON.parse(
      await fs.readFile(path.join(directory, "mod-favorites.json"), "utf8"),
    );
    assert.equal(savedFavorites.formatVersion, 1);
    assert.deepEqual(savedFavorites.mods, [favorite]);
    const index = JSON.parse(
      await fs.readFile(path.join(directory, "skins", "index.json"), "utf8"),
    );
    assert.equal(index.version, 1);
    assert.deepEqual(
      index.entries,
      skins.map(({ dataUrl, ...entry }) => entry),
    );
    assert.deepEqual(
      await fs.readFile(path.join(directory, "skins", `${skinId}.png`)),
      skinBytes,
    );
  }
  async function assertPortableFiles(directory, accountId) {
    const accountFile = path.join(directory, "accounts.json");
    const launcherFile = path.join(directory, "launcher.json");
    const accounts = JSON.parse(await fs.readFile(accountFile, "utf8"));
    const launcher = JSON.parse(await fs.readFile(launcherFile, "utf8"));
    assert(
      accounts.some(
        (account) =>
          account.id === accountId && account.name === "RealPortable_QA",
      ),
      "The actual EXE-side accounts.json must contain the saved offline account",
    );
    assert.equal(launcher.selectedAccountId, accountId);
    for (const [key, value] of Object.entries(persistedSettings))
      assert.equal(
        launcher.settings[key],
        value,
        `EXE-side launcher.json setting ${key}`,
      );
  }
  async function assertNoLauncherFiles(directory) {
    for (const filename of [
      "accounts.json",
      "launcher.json",
      "mod-favorites.json",
      path.join("skins", "index.json"),
    ])
      await assert.rejects(
        fs.access(path.join(directory, filename)),
        { code: "ENOENT" },
        `--user-data-dir must not receive ${filename}`,
      );
  }

  try {
    let run = await launch();
    let s = await state(run);
    // Fail before any mutation if the wrapper falls back to AppData/Chromium or
    // its transient self-extraction folder instead of the external EXE folder.
    assert.equal(
      s.system.dataDir,
      dataDir,
      "Launcher accounts/configuration must live in LDFCL-data beside the copied EXE",
    );
    assert.equal(s.system.gameRoot, defaultRoot);
    assert.equal(s.system.defaultGameRoot, defaultRoot);
    assert.equal((await fs.stat(defaultRoot)).isDirectory(), true);
    assert.equal(s.instances.length, 0);
    assert.equal(s.accounts.length, 0);
    const registeredDefault = s.gameDirectories.find(
      (entry) => entry.path === defaultRoot,
    );
    assert(
      registeredDefault,
      "Portable EXE-side default root must be registered",
    );
    assert.equal(s.selectedGameDirectoryId, registeredDefault.id);
    checks.push(
      "copied EXE starts from a Chinese/space path without game-root environment overrides",
    );
    checks.push(
      "--user-data-dir isolates Chromium only; launcher configuration is EXE-side LDFCL-data and the default game root is EXE-side .minecraft",
    );

    await call(run, "account:offline", { name: "RealPortable_QA" });
    s = await state(run);
    const accountId = s.accounts[0].id;
    assert.equal(s.selectedAccountId, accountId);
    await call(run, "settings", persistedSettings);
    assert.deepEqual(await call(run, "mod-favorites:list"), []);
    assert.deepEqual(await call(run, "skin-library:list"), []);
    await call(run, "mod-favorites:set", { project: favorite, saved: true });
    const savedSkin = await call(run, "skin-library:save", {
      name: "便携版原始皮肤",
      variant: "slim",
      dataUrl: `data:image/png;base64,${skinBytes.toString("base64")}`,
    });
    const skinId = savedSkin.id;
    await call(run, "skin-library:rename", { id: skinId, name: renamedSkin });
    await assertPortableCollections(run, dataDir, skinId);
    checks.push(
      "real IPC saves a synthetic Mod favorite and a valid 64x64 local slim skin, then renames the skin in EXE-side LDFCL-data",
    );
    await assertPortableFiles(dataDir, accountId);
    await assertNoLauncherFiles(chromiumDir);
    await call(run, "game-directory:add", { path: customRoot });
    s = await state(run);
    const selectedCustomId = s.selectedGameDirectoryId;
    assert.equal(s.system.gameRoot, customRoot);
    assert.equal(s.system.defaultGameRoot, defaultRoot);
    await assertPortableFiles(dataDir, accountId);
    await stop(run);

    run = await launch();
    s = await state(run);
    assert.equal(s.system.dataDir, dataDir);
    assert.equal(s.system.defaultGameRoot, defaultRoot);
    assert.equal(s.system.gameRoot, customRoot);
    assert.equal(s.selectedGameDirectoryId, selectedCustomId);
    assert.equal(s.accounts[0].id, accountId);
    assert.equal(s.accounts[0].name, "RealPortable_QA");
    assert.equal(s.selectedAccountId, accountId);
    for (const [key, value] of Object.entries(persistedSettings))
      assert.equal(s.settings[key], value);
    await assertPortableFiles(dataDir, accountId);
    await assertPortableCollections(run, dataDir, skinId);
    await assertNoLauncherFiles(chromiumDir);
    assert.equal(
      await fs.readFile(path.join(customRoot, "保留用户文件.txt"), "utf8"),
      "Portable directory fixture",
    );
    checks.push(
      "EXE-side account files, selected offline identity, launcher settings and custom directory survive a second portable extraction/start",
    );
    checks.push(
      "the second portable start restores the Mod favorite and renamed skin with identical PNG bytes and slim model from EXE-side LDFCL-data",
    );

    await call(run, "game-directory:select", { id: registeredDefault.id });
    s = await state(run);
    assert.equal(s.system.gameRoot, defaultRoot);
    await run.page
      .locator("aside.sidebar")
      .getByRole("button", { name: "启动器设置", exact: true })
      .click();
    await run.page
      .getByRole("heading", { name: "游戏目录", exact: true })
      .waitFor();
    await run.page
      .locator(`[data-game-directory-id="${registeredDefault.id}"]`)
      .getByText(defaultRoot, { exact: true })
      .waitFor();
    await run.page.screenshot({
      path: path.join(output, "portable-game-directories.png"),
    });
    await stop(run);

    // Move the complete portable directory after its wrapper has exited. A new
    // Chromium profile proves account/settings recovery comes from moved files.
    const relativeSource = path.relative(workspace, portableDir);
    const relativeTarget = path.relative(workspace, movedPortableDir);
    for (const relative of [relativeSource, relativeTarget])
      assert(
        relative &&
          !relative.startsWith(".." + path.sep) &&
          !path.isAbsolute(relative),
        "Portable relocation must remain inside this test's temporary workspace",
      );
    await fs.rename(portableDir, movedPortableDir);
    await assert.rejects(fs.access(portableDir), { code: "ENOENT" });
    await assertPortableFiles(movedDataDir, accountId);

    run = await launch(movedPortableDir, movedChromiumDir);
    s = await state(run);
    assert.equal(s.system.dataDir, movedDataDir);
    assert.equal(s.system.defaultGameRoot, movedDefaultRoot);
    assert.equal((await fs.stat(movedDefaultRoot)).isDirectory(), true);
    assert.equal(s.accounts[0].id, accountId);
    assert.equal(s.accounts[0].name, "RealPortable_QA");
    assert.equal(s.selectedAccountId, accountId);
    for (const [key, value] of Object.entries(persistedSettings))
      assert.equal(s.settings[key], value);
    await assertPortableFiles(movedDataDir, accountId);
    await assertPortableCollections(run, movedDataDir, skinId);
    await assertNoLauncherFiles(chromiumDir);
    await assertNoLauncherFiles(movedChromiumDir);
    const oldDefault = s.gameDirectories.find(
      (entry) => entry.id === registeredDefault.id,
    );
    assert(
      oldDefault,
      "Moving the portable folder must preserve the previous absolute root registration",
    );
    assert.equal(oldDefault.path, defaultRoot);
    assert.equal(!!oldDefault.isDefault, false);
    const relocatedDefault = s.gameDirectories.find(
      (entry) => entry.path === movedDefaultRoot,
    );
    assert(
      relocatedDefault?.isDefault,
      "The moved EXE-side .minecraft must be registered as the new default root",
    );
    // Store retains an existing absolute registration/selection. Selecting the
    // newly registered default verifies its prepared root without rewriting old
    // paths, worlds or unrelated user-selected directories.
    await call(run, "game-directory:select", { id: relocatedDefault.id });
    s = await state(run);
    assert.equal(s.system.gameRoot, movedDefaultRoot);
    assert.equal(s.selectedGameDirectoryId, relocatedDefault.id);
    assert.equal(s.system.gameDirectoryError, undefined);
    assert(
      s.gameDirectories.some(
        (entry) => entry.id === selectedCustomId && entry.path === customRoot,
      ),
    );
    await assertPortableFiles(movedDataDir, accountId);
    assert.equal(
      await fs.readFile(path.join(customRoot, "保留用户文件.txt"), "utf8"),
      "Portable directory fixture",
    );
    checks.push(
      "moving the complete Chinese/space portable directory preserves accounts and settings in moved LDFCL-data, even with a fresh Chromium user-data directory",
    );
    checks.push(
      "after moving the whole portable folder, a fresh Chromium profile restores the same Mod favorite and renamed slim skin with unchanged PNG bytes in moved EXE-side LDFCL-data",
    );
    checks.push(
      "moved EXE registers its new default .minecraft while preserving old absolute and custom root registrations",
    );
    await stop(run);
    assert.deepEqual(pageErrors, []);
    console.log(
      JSON.stringify({
        passed: true,
        portable: true,
        copiedExecutable: executable,
        movedExecutable: path.join(movedPortableDir, path.basename(source)),
        portableDataDir: dataDir,
        movedPortableDataDir: movedDataDir,
        isolatedChromiumDirs: [chromiumDir, movedChromiumDir],
        defaultGameRoot: defaultRoot,
        movedDefaultGameRoot: movedDefaultRoot,
        checks,
        pageErrors,
        screenshot: "test-results/portable-game-directories.png",
        gameLaunched: false,
      }),
    );
  } finally {
    if (session) {
      await kill(session);
      if (session.browser) await session.browser.close().catch(() => {});
    }
    await fs.rm(workspace, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
