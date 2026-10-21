const { chromium } = require("playwright-core");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const AdmZip = require("adm-zip");

// Exercise main.ts migration through the real portable wrapper. All old source,
// EXE-side configuration and game fixtures stay inside one temporary workspace.
// --user-data-dir selects a synthetic legacy source, never the user's AppData.
(async () => {
  const project = path.resolve(__dirname, "..");
  const source = path.resolve(
    process.env.LDFCL_TEST_PORTABLE_EXE ||
      path.join(
        project,
        "release",
        `LDFCL-${require("../package.json").version}-Windows-x64.exe`,
      ),
  );
  await fs.access(source);
  const workspace = await fs.mkdtemp(
    path.join(os.tmpdir(), "LDFCL-config-migration-qa-"),
  );
  const portableDir = path.join(workspace, "中文 空格 便携启动器");
  const legacyDir = path.join(workspace, "隔离 旧配置 用户数据");
  const dataDir = path.join(portableDir, "LDFCL-data");
  const defaultRoot = path.join(portableDir, ".minecraft");
  const gameRoot = path.join(workspace, "原有 自定义游戏目录", ".minecraft");
  const executable = path.join(portableDir, path.basename(source));
  const translationRelative = path.join("translations", "mods", "custom.json");
  const profileId = "1.20.1-迁移验证";
  const profileDir = path.join(gameRoot, "versions", profileId);
  const directory = {
    id: "migration-fixture-root",
    name: "原有合成游戏目录",
    path: gameRoot,
    layout: "standard",
  };
  const instance = {
    id: "migration-fixture-instance",
    name: "配置迁移验证实例",
    version: "1.20.1",
    loader: "vanilla",
    gameDirectoryId: directory.id,
    importedVersionId: profileId,
    versionDirectory: profileId,
    createdAt: "2026-10-20T00:00:00.000Z",
    gameSettings: { lang: "zh_cn", renderDistance: 10 },
  };
  const name = "Migration_QA";
  const uuid = createHash("md5").update(`OfflinePlayer:${name}`).digest();
  uuid[6] = (uuid[6] & 0x0f) | 0x30;
  uuid[8] = (uuid[8] & 0x3f) | 0x80;
  const account = {
    id: randomUUID(),
    type: "offline",
    name,
    uuid: uuid.toString("hex"),
  };
  const initialSettings = {
    downloadConcurrency: 13,
    memoryMode: "manual",
    memoryMb: 2048,
    javaPath: "",
    microsoftClientId: "",
    closeOnLaunch: false,
  };
  const updatedSettings = {
    downloadConcurrency: 7,
    memoryMode: "auto",
    memoryMb: 1024,
    closeOnLaunch: true,
  };
  const translation = {
    schemaVersion: 1,
    entries: [
      {
        slug: "migration-fixture",
        modIds: ["migration_fixture"],
        originalName: "Migration Fixture Mod",
        nameZh: "迁移自定义模组",
        descriptionZh: "仅供隔离迁移测试使用的合成中文条目。",
        source: "迁移测试合成条目",
        license: "CC0-1.0",
      },
    ],
  };
  const sourceFiles = new Map([
    [
      "launcher.json",
      Buffer.from(
        JSON.stringify(
          {
            instances: [instance],
            gameDirectories: [directory],
            selectedGameDirectoryId: directory.id,
            selectedInstanceId: instance.id,
            selectedInstancesByDirectory: { [directory.id]: instance.id },
            selectedAccountId: account.id,
            settings: initialSettings,
          },
          null,
          2,
        ) + "\r\n",
      ),
    ],
    ["accounts.json", Buffer.from(JSON.stringify([account], null, 2) + "\r\n")],
    [
      translationRelative,
      Buffer.from(JSON.stringify(translation, null, 2) + "\r\n"),
    ],
  ]);
  const gameFiles = new Map();
  const checks = [];
  const pageErrors = [];
  let session;

  async function write(file, bytes) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
  }
  async function port() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const value = server.address().port;
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    return value;
  }
  const call = (run, method, payload) =>
    run.page.evaluate(
      ({ method, payload }) => window.launcher.call(method, payload),
      { method, payload },
    );
  const state = (run) => call(run, "state");
  async function launch() {
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
      executable,
      [`--user-data-dir=${legacyDir}`, `--remote-debugging-port=${cdpPort}`],
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
          `Migration portable EXE exited before startup: ${run.exitCode}`,
        );
      try {
        const response = await fetch(
          `http://127.0.0.1:${cdpPort}/json/version`,
          {
            signal: AbortSignal.timeout(1500),
          },
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
      "Migration portable EXE did not expose CDP",
    );
    run.browser = await chromium.connectOverCDP(endpoint.webSocketDebuggerUrl);
    run.page = run.browser.contexts()[0].pages()[0];
    assert(run.page, "Migration application window is missing");
    run.page.on("pageerror", (error) => pageErrors.push(error.message));
    await run.page
      .getByRole("heading", { name: "开始游戏", exact: true })
      .waitFor();
    return run;
  }
  async function stop(run) {
    await run.page.evaluate(() => window.launcher.window("close"));
    const deadline = Date.now() + 15000;
    while (!run.exited && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 200));
    assert(
      run.exited,
      "Migration portable wrapper did not exit after window close",
    );
    assert.equal(
      run.exitCode,
      0,
      "Migration portable EXE did not exit cleanly",
    );
    await run.browser.close().catch(() => {});
    session = undefined;
  }
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
  async function assertSourcesPreserved() {
    for (const [relative, bytes] of sourceFiles)
      assert.deepEqual(
        await fs.readFile(path.join(legacyDir, relative)),
        bytes,
        `Legacy source must remain byte-for-byte unchanged: ${relative}`,
      );
    for (const [relative, bytes] of gameFiles)
      assert.deepEqual(
        await fs.readFile(path.join(profileDir, relative)),
        bytes,
        `Original game fixture must remain unchanged: ${relative}`,
      );
  }
  async function assertTranslation(run) {
    assert.deepEqual(
      await fs.readFile(path.join(dataDir, translationRelative)),
      sourceFiles.get(translationRelative),
      "Custom translation JSON must be copied without changing its bytes",
    );
    const mods = await call(run, "mods:list", { id: instance.id });
    assert.equal(mods.length, 1);
    assert.equal(mods[0].id, "migration_fixture");
    assert.equal(mods[0].displayName, translation.entries[0].nameZh);
    assert.equal(mods[0].descriptionZh, translation.entries[0].descriptionZh);
    assert.equal(mods[0].translation.source, translation.entries[0].source);
  }
  function assertLocationAndRoot(current) {
    assert.equal(current.system.dataDir, dataDir);
    assert.equal(current.system.defaultGameRoot, defaultRoot);
    assert.equal(current.system.gameRoot, gameRoot);
    assert.equal(current.system.gameDirectoryError, undefined);
    assert.equal(current.selectedGameDirectoryId, directory.id);
    assert.equal(current.selectedInstanceId, instance.id);
    assert(
      current.gameDirectories.some(
        (entry) => entry.id === directory.id && entry.path === gameRoot,
      ),
    );
    assert(
      current.instances.some(
        (entry) =>
          entry.id === instance.id &&
          entry.gameDirectoryId === directory.id &&
          entry.versionDirectory === profileId,
      ),
    );
  }

  try {
    await fs.mkdir(portableDir, { recursive: true });
    await fs.copyFile(source, executable);
    for (const [relative, bytes] of sourceFiles)
      await write(path.join(legacyDir, relative), bytes);
    const client = new AdmZip();
    client.addFile(
      "SYNTHETIC-NOT-A-REAL-GAME.txt",
      Buffer.from("Migration fixture only"),
    );
    const mod = new AdmZip();
    mod.addFile(
      "fabric.mod.json",
      Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          id: "migration_fixture",
          name: "Migration Fixture Mod",
          description: "Synthetic migration fixture",
          version: "1.0.0",
        }),
      ),
    );
    gameFiles.set(
      `${profileId}.json`,
      Buffer.from(
        JSON.stringify({
          id: profileId,
          clientVersion: instance.version,
          type: "release",
          mainClass: "net.minecraft.client.main.Main",
          libraries: [],
        }),
      ),
    );
    gameFiles.set(`${profileId}.jar`, client.toBuffer());
    gameFiles.set(path.join("mods", "migration-fixture.jar"), mod.toBuffer());
    for (const [relative, bytes] of gameFiles)
      await write(path.join(profileDir, relative), bytes);

    let run = await launch();
    let current = await state(run);
    // Confirm main.ts selected EXE-side data before making any IPC mutation.
    assertLocationAndRoot(current);
    assert.deepEqual(current.accounts, [account]);
    assert.equal(current.selectedAccountId, account.id);
    for (const [key, value] of Object.entries(initialSettings))
      assert.equal(current.settings[key], value, `Migrated setting ${key}`);
    assert.deepEqual(
      JSON.parse(
        await fs.readFile(path.join(dataDir, "accounts.json"), "utf8"),
      ),
      [account],
    );
    const marker = JSON.parse(
      await fs.readFile(path.join(dataDir, "storage-migration.json"), "utf8"),
    );
    assert.equal(marker.sourceDataDir, legacyDir);
    for (const relative of sourceFiles.keys())
      assert(marker.files.includes(relative.replace(/\\/g, "/")));
    await assertSourcesPreserved();
    await assertTranslation(run);
    checks.push(
      "real main.ts migrates synthetic accounts, selected identity and launcher settings from isolated --user-data-dir to EXE-side LDFCL-data",
    );
    checks.push(
      "existing absolute game-root and instance registrations retain their identities and paths",
    );
    checks.push(
      "legacy launcher.json, accounts.json, custom translation and game fixtures stay byte-for-byte unchanged; copied custom translation works through mods:list",
    );

    await call(run, "account:remove", { id: account.id });
    await call(run, "settings", updatedSettings);
    current = await state(run);
    assert.deepEqual(current.accounts, []);
    for (const [key, value] of Object.entries(updatedSettings))
      assert.equal(current.settings[key], value);
    assert.deepEqual(
      JSON.parse(
        await fs.readFile(path.join(dataDir, "accounts.json"), "utf8"),
      ),
      [],
    );
    await assertSourcesPreserved();
    await stop(run);

    run = await launch();
    current = await state(run);
    assertLocationAndRoot(current);
    assert.deepEqual(
      current.accounts,
      [],
      "Deleted account must not reappear from the unchanged legacy source",
    );
    for (const [key, value] of Object.entries(updatedSettings))
      assert.equal(
        current.settings[key],
        value,
        `Persisted new setting ${key}`,
      );
    const savedLauncher = JSON.parse(
      await fs.readFile(path.join(dataDir, "launcher.json"), "utf8"),
    );
    for (const [key, value] of Object.entries(updatedSettings))
      assert.equal(savedLauncher.settings[key], value);
    assert.deepEqual(
      JSON.parse(
        await fs.readFile(path.join(dataDir, "accounts.json"), "utf8"),
      ),
      [],
    );
    await assertSourcesPreserved();
    await assertTranslation(run);
    checks.push(
      "account:remove and settings IPC save only to EXE-side files; second portable startup preserves changes without re-importing the deleted legacy account",
    );
    await stop(run);
    assert.deepEqual(pageErrors, []);
    console.log(
      JSON.stringify({
        passed: true,
        portable: true,
        migration: true,
        copiedExecutable: executable,
        isolatedLegacyDir: legacyDir,
        portableDataDir: dataDir,
        preservedGameRoot: gameRoot,
        checks,
        pageErrors,
        gameLaunched: false,
      }),
    );
  } finally {
    if (session) {
      await kill(session);
      if (session.browser) await session.browser.close().catch(() => {});
    }
    assert.equal(path.dirname(workspace), path.resolve(os.tmpdir()));
    assert(path.basename(workspace).startsWith("LDFCL-config-migration-qa-"));
    await fs.rm(workspace, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
