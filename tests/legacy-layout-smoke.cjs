const { _electron: electron } = require("playwright-core");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const AdmZip = require("adm-zip");

// Real Electron, preload, IPC and filesystem migration of synthetic 0.2.3 data.
// Every root is temporary. No real account, Minecraft process or picker is used.
(async () => {
  const project = path.resolve(__dirname, "..");
  const workspace = await fs.mkdtemp(
    path.join(os.tmpdir(), "LDFCL-legacy-layout-qa-"),
  );
  const configDir = path.join(workspace, "中文 启动器配置");
  const standardRoot = path.join(workspace, "标准 游戏目录", ".minecraft");
  const defaultRoot = path.join(configDir, ".minecraft");
  const pageErrors = [];
  const checks = [];
  let active;

  async function write(file, bytes) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
  }
  function modJar(id, name) {
    const zip = new AdmZip();
    zip.addFile(
      "fabric.mod.json",
      Buffer.from(
        JSON.stringify({ schemaVersion: 1, id, name, version: "1.0.0" }),
      ),
    );
    return zip.toBuffer();
  }
  async function tree(directory) {
    const result = {};
    async function visit(current) {
      for (const entry of await fs.readdir(current, { withFileTypes: true })) {
        const file = path.join(current, entry.name);
        if (entry.isDirectory()) await visit(file);
        else if (entry.isFile())
          result[path.relative(directory, file)] = createHash("sha256")
            .update(await fs.readFile(file))
            .digest("hex");
        else assert.fail(`Unexpected fixture link or special file: ${file}`);
      }
    }
    await visit(directory);
    return result;
  }
  async function versionDirectories(root) {
    return (await fs.readdir(path.join(root, "versions"))).sort();
  }
  async function seed(directory, marker) {
    const minecraftRoot =
      directory.layout === "legacy"
        ? path.join(directory.path, "minecraft")
        : directory.path;
    const profileId = `fabric-native-${marker}-1.20.1`;
    const instance = {
      id: `old-${marker}-instance`,
      name: `旧版隔离实例 ${marker}`,
      version: "1.20.1",
      loader: "fabric",
      loaderVersion: "0.16.10",
      gameDirectoryId: directory.id,
      createdAt: "2026-10-20T00:00:00.000Z",
      gameSettings: { fullscreen: false, lang: "zh_cn", renderDistance: 8 },
    };
    const source = path.join(directory.path, "instances", instance.id);
    const native = path.join(minecraftRoot, "versions", profileId);
    await write(
      path.join(source, ".ldfcl", "launch.json"),
      JSON.stringify({ version: profileId }),
    );
    await write(
      path.join(source, "mods", `old-${marker}.jar`),
      modJar(`old_${marker}_mod`, `Old ${marker} Mod`),
    );
    await write(
      path.join(source, "options.txt"),
      `fullscreen:false\nlang:zh_cn\nrenderDistance:8\n# old ${marker} options\n`,
    );
    await write(
      path.join(source, "saves", `旧存档 ${marker}`, "level.dat"),
      Buffer.from(`Synthetic old save ${marker}\0keep`),
    );
    await write(
      path.join(source, "config", "用户配置.json"),
      JSON.stringify({ marker, keep: true }),
    );
    await write(
      path.join(native, `${profileId}.json`),
      JSON.stringify({
        id: profileId,
        type: "release",
        clientVersion: instance.version,
        mainClass: "net.fabricmc.loader.impl.launch.knot.KnotClient",
        libraries: [{ name: "net.fabricmc:fabric-loader:0.16.10" }],
        arguments: { game: [], jvm: [] },
      }),
    );
    const client = new AdmZip();
    client.addFile(
      "QA-NOT-A-REAL-GAME.txt",
      Buffer.from(`Synthetic native client ${marker}`),
    );
    const clientBytes = client.toBuffer();
    await write(path.join(native, `${profileId}.jar`), clientBytes);
    await write(
      path.join(native, "mods", `native-${marker}.jar`),
      modJar(`native_${marker}_mod`, `Native ${marker} Mod`),
    );
    await write(
      path.join(native, "saves", `原生存档 ${marker}`, "level.dat"),
      `Do not mix native ${marker} saves into the old instance`,
    );
    await write(
      path.join(native, "options.txt"),
      `fullscreen:true\nlang:en_us\n# native ${marker}\n`,
    );
    for (const shared of ["assets", "libraries"])
      await write(
        path.join(minecraftRoot, shared, "preserve", `${marker}.bin`),
        Buffer.from(`Shared ${shared} ${marker}\0unchanged`),
      );
    return {
      marker,
      directory,
      minecraftRoot,
      profileId,
      instance,
      source,
      native,
      clientBytes,
      sourceBefore: await tree(source),
      nativeBefore: await tree(native),
      assetsBefore: await tree(path.join(minecraftRoot, "assets")),
      librariesBefore: await tree(path.join(minecraftRoot, "libraries")),
    };
  }
  const standard = await seed(
    {
      id: "old-standard-root",
      name: "0.2.3 标准游戏目录",
      path: standardRoot,
      layout: "standard",
    },
    "standard",
  );
  const legacy = await seed(
    {
      id: "old-legacy-root",
      name: "0.2.3 Legacy 游戏目录",
      path: configDir,
      layout: "legacy",
    },
    "legacy",
  );
  const fixtures = [standard, legacy];
  await write(
    path.join(configDir, "launcher.json"),
    JSON.stringify({
      instances: fixtures.map((fixture) => fixture.instance),
      gameDirectories: fixtures.map((fixture) => fixture.directory),
      selectedGameDirectoryId: standard.directory.id,
      selectedInstanceId: standard.instance.id,
      selectedInstancesByDirectory: Object.fromEntries(
        fixtures.map((fixture) => [fixture.directory.id, fixture.instance.id]),
      ),
    }),
  );

  const call = (page, method, payload) =>
    page.evaluate(
      ({ method, payload }) => window.launcher.call(method, payload),
      { method, payload },
    );
  const state = (page) => call(page, "state");
  async function persistedInstances() {
    const persisted = JSON.parse(
      await fs.readFile(path.join(configDir, "launcher.json"), "utf8"),
    );
    return Object.fromEntries(
      fixtures.map(({ instance }) => {
        const saved = persisted.instances.find(
          (item) => item.id === instance.id,
        );
        assert(saved, `Persisted old instance is missing: ${instance.id}`);
        return [instance.id, saved.versionDirectory];
      }),
    );
  }
  async function launch() {
    const env = {
      ...process.env,
      LDFCL_DATA_DIR: configDir,
      LDFCL_GAME_ROOT: defaultRoot,
    };
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
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page
      .getByRole("heading", { name: "开始游戏", exact: true })
      .waitFor();
    await active.evaluate(({ shell }) => {
      globalThis.__ldfclLegacyQA = { opened: [] };
      shell.openPath = async (target) => {
        globalThis.__ldfclLegacyQA.opened.push(target);
        return "";
      };
    });
    return page;
  }
  async function preserved() {
    for (const fixture of fixtures) {
      assert.deepEqual(await tree(fixture.source), fixture.sourceBefore);
      assert.deepEqual(await tree(fixture.native), fixture.nativeBefore);
      assert.deepEqual(
        await tree(path.join(fixture.minecraftRoot, "assets")),
        fixture.assetsBefore,
      );
      assert.deepEqual(
        await tree(path.join(fixture.minecraftRoot, "libraries")),
        fixture.librariesBefore,
      );
    }
  }
  async function verifyMigration(page, fixture, renderDistance) {
    const s = await state(page);
    assert.equal(s.selectedGameDirectoryId, fixture.directory.id);
    assert.equal(s.selectedInstanceId, fixture.instance.id);
    assert.equal(s.system.gameRoot, fixture.minecraftRoot);
    assert.equal(s.system.defaultGameRoot, defaultRoot);
    assert.equal(s.system.gameDirectoryError, undefined);
    assert.deepEqual(s.accounts, []);
    const instance = s.instances.find(
      (item) => item.id === fixture.instance.id,
    );
    assert(instance, "Migration must preserve the original instance identity");
    assert(
      instance.versionDirectory,
      "Migration must persist its target folder",
    );
    assert.notEqual(instance.versionDirectory, fixture.profileId);
    const target = path.join(
      fixture.minecraftRoot,
      "versions",
      instance.versionDirectory,
    );
    assert.notEqual(target, fixture.source);
    assert.notEqual(target, fixture.native);
    const metadata = JSON.parse(
      await fs.readFile(
        path.join(target, `${instance.versionDirectory}.json`),
        "utf8",
      ),
    );
    assert.equal(metadata.id, instance.versionDirectory);
    assert.equal(metadata.jar, instance.versionDirectory);
    assert.equal(metadata.minecraftVersion, instance.version);
    assert.deepEqual(
      await fs.readFile(path.join(target, `${instance.versionDirectory}.jar`)),
      fixture.clientBytes,
    );
    assert.equal(
      JSON.parse(
        await fs.readFile(path.join(target, ".ldfcl", "launch.json"), "utf8"),
      ).version,
      instance.versionDirectory,
    );
    const marker = JSON.parse(
      await fs.readFile(
        path.join(target, ".ldfcl", "directory-migration.json"),
        "utf8",
      ),
    );
    assert.equal(marker.completed, true);
    assert.equal(marker.instanceId, instance.id);
    assert.equal(marker.sourceVersion, fixture.profileId);
    const targetBefore = await tree(target);
    for (const [relative, hash] of Object.entries(fixture.sourceBefore))
      if (relative !== path.join(".ldfcl", "launch.json"))
        assert.equal(targetBefore[relative], hash, `Copy missing: ${relative}`);
    await assert.rejects(
      fs.access(path.join(target, "mods", `native-${fixture.marker}.jar`)),
    );
    for (const markerName of ["standard", "legacy"])
      await assert.rejects(
        fs.access(path.join(target, "saves", `原生存档 ${markerName}`)),
      );
    const mods = await call(page, "mods:list", { id: instance.id });
    assert.deepEqual(
      mods.map((mod) => mod.id),
      [`old_${fixture.marker}_mod`],
    );
    await call(page, "folder", { id: instance.id });
    assert.equal(
      (await active.evaluate(() => globalThis.__ldfclLegacyQA.opened)).at(-1),
      target,
    );
    await call(page, "instance:save", {
      id: instance.id,
      gameSettings: { fullscreen: true, renderDistance },
    });
    assert.match(
      await fs.readFile(path.join(target, "options.txt"), "utf8"),
      /fullscreen:true/,
    );
    assert.match(
      await fs.readFile(path.join(target, "options.txt"), "utf8"),
      new RegExp(`renderDistance:${renderDistance}(?:\\r?\\n|$)`),
    );
    const targetAfter = await tree(target);
    assert.deepEqual(
      Object.keys(targetAfter).sort(),
      Object.keys(targetBefore).sort(),
    );
    for (const [relative, hash] of Object.entries(targetBefore))
      if (relative !== "options.txt") assert.equal(targetAfter[relative], hash);
    await preserved();
    return { instance, target, snapshot: targetAfter };
  }

  try {
    let page = await launch();
    const migratedStandard = await verifyMigration(page, standard, 12);
    checks.push(
      "startup migrates standard-root instances into a separate versions directory with its own JSON/JAR, Mod, options, config and saves",
    );
    const selectedLegacy = await call(page, "game-directory:select", {
      id: legacy.directory.id,
    });
    assert.deepEqual(selectedLegacy.warnings, []);
    const migratedLegacy = await verifyMigration(page, legacy, 20);
    assert.deepEqual(
      await tree(migratedStandard.target),
      migratedStandard.snapshot,
    );
    checks.push(
      "legacy registration migrates config/instances into config/minecraft/versions and keeps both roots' original source, native profile, assets and libraries byte-for-byte unchanged",
    );
    const beforeRestart = await persistedInstances();
    assert.deepEqual(beforeRestart, {
      [standard.instance.id]: migratedStandard.instance.versionDirectory,
      [legacy.instance.id]: migratedLegacy.instance.versionDirectory,
    });
    const listings = await Promise.all(
      fixtures.map((fixture) => versionDirectories(fixture.minecraftRoot)),
    );
    for (const listing of listings)
      assert(!listing.some((name) => name.startsWith(".ldfcl-migration-")));
    await active.close();
    active = undefined;

    page = await launch();
    const restored = await state(page);
    assert.equal(restored.selectedGameDirectoryId, legacy.directory.id);
    assert.equal(restored.selectedInstanceId, legacy.instance.id);
    assert.equal(restored.system.gameRoot, legacy.minecraftRoot);
    assert.equal(restored.system.gameDirectoryError, undefined);
    assert.deepEqual(await persistedInstances(), beforeRestart);
    assert.deepEqual(
      await tree(migratedLegacy.target),
      migratedLegacy.snapshot,
    );
    assert.equal(
      (await call(page, "mods:list", { id: legacy.instance.id }))[0].id,
      "old_legacy_mod",
    );
    await call(page, "game-directory:select", { id: standard.directory.id });
    const restoredStandard = await state(page);
    assert.equal(restoredStandard.selectedInstanceId, standard.instance.id);
    assert.equal(restoredStandard.system.gameRoot, standard.minecraftRoot);
    assert.equal(restoredStandard.system.gameDirectoryError, undefined);
    assert.equal(
      (await call(page, "mods:list", { id: standard.instance.id }))[0].id,
      "old_standard_mod",
    );
    assert.deepEqual(await persistedInstances(), beforeRestart);
    assert.deepEqual(
      await Promise.all(
        fixtures.map((fixture) => versionDirectories(fixture.minecraftRoot)),
      ),
      listings,
      "Restart and root reselection must not allocate migration copies again",
    );
    assert.deepEqual(
      await tree(migratedStandard.target),
      migratedStandard.snapshot,
    );
    await preserved();
    assert.deepEqual(pageErrors, []);
    checks.push(
      "restart restores the legacy selection and both persisted version directories; root reselection creates no additional copy and changes no source or migrated files",
    );
    console.log(
      JSON.stringify({
        passed: true,
        checks,
        pageErrors,
        migratedVersionDirectories: beforeRestart,
        restoredGameDirectoryId: restored.selectedGameDirectoryId,
        isolatedConfigDir: configDir,
        gameLaunched: false,
        realAccountsUsed: false,
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
