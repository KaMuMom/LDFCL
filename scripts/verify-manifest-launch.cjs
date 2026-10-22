// Explicit P1 live check. Run only after verify-neoforge.cjs reports success.
// All game operations are confined to that script's isolated TEMP workspace.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const assert = require("node:assert/strict");
const {
  InstanceStorageService,
} = require("@ldfcl/core/services/instance-manifest");
const {
  sha256File,
  safeDirectory,
  storagePath,
} = require("@ldfcl/core/services/content-store");
const { instanceVersionDirectoryId } = require("@ldfcl/core/instance-paths");
const { GameService } = require("@ldfcl/core/services/game");
const { defaults } = require("@ldfcl/core/store");

const resultDirectory = path.join(__dirname, "..", "test-results");
const sourceReportFile = path.join(resultDirectory, "p0-p6-neoforge-live.json");
const reportFile = path.join(resultDirectory, "p0-p6-manifest-launch.json");

async function mustNotExist(filename) {
  try {
    await fs.lstat(filename);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(
    `Live verification requires a fresh destination: ${filename}`,
  );
}
function childPath(workspace, relative) {
  const target = path.resolve(workspace, relative);
  const relation = path.relative(workspace, target);
  assert(
    relation &&
      !path.isAbsolute(relation) &&
      relation !== ".." &&
      !relation.startsWith(`..${path.sep}`),
    "verification path must remain inside its isolated workspace",
  );
  return target;
}
async function verifyFiles(root, files) {
  for (const entry of files) {
    const filename = storagePath(root, entry.path);
    assert.equal(
      (await fs.lstat(filename)).size,
      entry.size,
      `restored size: ${entry.path}`,
    );
    assert.equal(
      await sha256File(filename),
      entry.sha256,
      `restored hash: ${entry.path}`,
    );
  }
  return files.length;
}
function waitFor(promise, milliseconds, fallback) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

(async () => {
  const report = {
    sourceReport: sourceReportFile,
    passed: false,
    cleanTarget: false,
    exported: false,
    rebuilt: false,
    launched: false,
    initialized: false,
    stopped: false,
  };
  const log = [],
    blockedNetwork = [];
  let workspace, attemptDirectory, game, instance, originalFetch, ready, exited;
  const initialized = new Promise((resolve) => {
    ready = resolve;
  });
  const stopped = new Promise((resolve) => {
    exited = resolve;
  });
  let renderInitialized = false,
    audioInitialized = false,
    exitedBeforeInitialization = false;
  try {
    const source = JSON.parse(await fs.readFile(sourceReportFile, "utf8"));
    assert(
      source.passed === true &&
        source.installed === true &&
        source.initialized === true &&
        source.instance,
      "NeoForge live verification must finish successfully before this script runs",
    );
    assert(
      typeof source.workspace === "string" && path.isAbsolute(source.workspace),
      "source verification workspace must be absolute",
    );
    const tempRoot = await fs.realpath(os.tmpdir());
    workspace = await fs.realpath(source.workspace);
    const relative = path.relative(tempRoot, workspace);
    assert(
      relative &&
        !path.isAbsolute(relative) &&
        !relative.startsWith("..") &&
        path.basename(workspace).startsWith("LDFCL-NeoForge-live-"),
      "source must be the isolated NeoForge verification TEMP workspace",
    );
    await safeDirectory(workspace);
    report.workspace = workspace;
    attemptDirectory = childPath(workspace, `manifest-check-${randomUUID()}`);
    await mustNotExist(attemptDirectory);
    await safeDirectory(attemptDirectory, true);
    report.attemptDirectory = attemptDirectory;
    const sourceRoot = childPath(workspace, ".minecraft");
    const sourceDirectory = path.join(
      sourceRoot,
      "versions",
      instanceVersionDirectoryId(source.instance),
    );
    const exportData = childPath(attemptDirectory, "export-data");
    const rebuiltData = childPath(attemptDirectory, "rebuilt-data");
    const rebuiltRoot = childPath(attemptDirectory, "rebuilt.minecraft");
    const bundleDirectory = childPath(attemptDirectory, "bundle");
    const basename = path.basename(sourceDirectory);
    const destination = path.join(rebuiltRoot, "versions", basename);
    for (const filename of [
      exportData,
      rebuiltData,
      rebuiltRoot,
      bundleDirectory,
    ])
      await mustNotExist(filename);
    report.cleanTarget = true;
    Object.assign(report, {
      sourceRoot,
      sourceDirectory,
      exportData,
      rebuiltData,
      rebuiltRoot,
      bundleDirectory,
      destination,
      version: source.instance.version,
      loader: source.instance.loader,
      loaderVersion: source.instance.loaderVersion,
    });

    console.log(
      JSON.stringify({
        phase: "export",
        workspace,
        attemptDirectory,
        sourceDirectory,
      }),
    );
    const exporter = new InstanceStorageService({
      dataDir: exportData,
      minecraftRoot: sourceRoot,
    });
    const exported = await exporter.exportBundle(
      sourceDirectory,
      bundleDirectory,
    );
    report.exported = true;
    report.bundleObjects = exported.objects;
    const libraryEntries = exported.manifest.sharedFiles.filter(
      (entry) =>
        entry.path.startsWith("libraries/") && entry.role === "library",
    );
    const clientEntries = exported.manifest.files.filter(
      (entry) => entry.role === "client",
    );
    assert(
      libraryEntries.length > 0,
      "the bundle must contain real shared game libraries",
    );
    assert(
      clientEntries.some(
        (entry) => entry.path === `${basename}.jar` && entry.size > 0,
      ),
      "the bundle must contain the real isolated client JAR",
    );

    // No source store/instance/library copy is available to the fresh importer.
    await mustNotExist(rebuiltData);
    await mustNotExist(rebuiltRoot);
    console.log(
      JSON.stringify({
        phase: "rebuild",
        objects: exported.objects,
        libraries: libraryEntries.length,
        destination,
      }),
    );
    const importer = new InstanceStorageService({
      dataDir: rebuiltData,
      minecraftRoot: rebuiltRoot,
    });
    const restored = await importer.rebuildFromBundle(
      bundleDirectory,
      destination,
    );
    assert.equal(restored.directoryName, basename);
    report.instanceFilesVerified = await verifyFiles(
      destination,
      restored.files,
    );
    report.sharedFilesVerified = await verifyFiles(
      rebuiltRoot,
      restored.sharedFiles,
    );
    report.libraryFilesVerified = libraryEntries.length;
    report.clientJarsVerified = clientEntries.length;
    report.storeObjects = (await importer.contentStore.objects()).length;
    assert.equal(
      report.storeObjects,
      exported.objects,
      "fresh target CAS is populated from the exported bundle only",
    );
    report.rebuilt = true;

    const assetSource = path.join(sourceRoot, "assets"),
      assetDestination = path.join(rebuiltRoot, "assets");
    await mustNotExist(assetDestination);
    await safeDirectory(assetSource);
    await fs.cp(assetSource, assetDestination, {
      recursive: true,
      force: false,
      errorOnExist: true,
      dereference: false,
    });
    report.assetCacheCopied = true;
    report.javaCache = path.join(workspace, "runtime");
    instance = {
      ...source.instance,
      ...(restored.instance || {}),
      versionDirectory: basename,
    };
    report.instance = instance;
    game = new GameService(
      workspace,
      (event) => {
        if (event.type === "log") {
          log.push(event.line);
          if (/Created:.*textures[\\/]atlas/i.test(event.line))
            renderInitialized = true;
          if (/Sound engine started|OpenAL initialized/i.test(event.line))
            audioInitialized = true;
          if (renderInitialized && audioInitialized)
            ready({ initialized: true });
        }
        if (event.type === "game" && event.status === "exited") {
          exitedBeforeInitialization = !(renderInitialized && audioInitialized);
          ready({
            initialized: false,
            reason: "Client exited before render/audio initialization",
            exitCode: event.exitCode,
          });
          exited({ stopped: true, exitCode: event.exitCode });
        }
      },
      { minecraftRoot: rebuiltRoot },
    );

    // Assets and the verified Java runtime are cached; runtime artifacts must
    // already exist from the bundle. Reject network completion during this proof.
    originalFetch = global.fetch;
    global.fetch = async (url) => {
      const target = new URL(String(url));
      blockedNetwork.push(`${target.origin}${target.pathname}`);
      throw new Error(
        `Rebuilt launch unexpectedly required a network artifact: ${target.hostname}`,
      );
    };
    console.log(
      JSON.stringify({
        phase: "launch",
        destination,
        networkCompletionAllowed: false,
      }),
    );
    const launched = await game.launch(
      instance,
      {
        id: "verification",
        type: "offline",
        name: "LDFCLVerify",
        uuid: "8328c130c74b3ce493d5822a404a858c",
      },
      { ...defaults, downloadConcurrency: 16 },
    );
    report.pid = launched.pid;
    report.launched = Number.isInteger(launched.pid) && launched.pid > 0;
    Object.assign(
      report,
      await waitFor(initialized, 120000, {
        initialized: false,
        reason: "Client render/audio initialization timed out",
      }),
    );
    report.renderInitialized = renderInitialized;
    report.audioInitialized = audioInitialized;
    report.exitedBeforeInitialization = exitedBeforeInitialization;
    await game.stop(instance.id);
    Object.assign(report, await waitFor(stopped, 10000, { stopped: false }));
    assert(
      report.initialized && renderInitialized && audioInitialized,
      "rebuilt client must reach actual render and audio initialization",
    );
    assert(
      report.stopped,
      "verification client must be stopped after initialization",
    );
    assert.deepEqual(
      blockedNetwork,
      [],
      "all instance/runtime library artifacts must be available without downloads",
    );
    await verifyFiles(
      destination,
      restored.files.filter((entry) => !entry.mutable),
    );
    await verifyFiles(rebuiltRoot, restored.sharedFiles);
    report.passed = true;
  } catch (error) {
    report.error = String(error.message || error);
    if (game && instance) await game.stop(instance.id).catch(() => {});
    process.exitCode = 1;
  } finally {
    if (originalFetch) global.fetch = originalFetch;
    report.blockedNetwork = blockedNetwork;
    report.renderInitialized = renderInitialized;
    report.audioInitialized = audioInitialized;
    await fs.mkdir(resultDirectory, { recursive: true });
    if (attemptDirectory && report.attemptDirectory === attemptDirectory) {
      const outputLog = childPath(
        attemptDirectory,
        "manifest-rebuilt-game-output.log",
      );
      await fs.writeFile(outputLog, log.join("\n"));
      report.gameOutput = outputLog;
      await fs.writeFile(
        childPath(attemptDirectory, "manifest-launch-verification.json"),
        JSON.stringify(report, null, 2),
      );
    }
    await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
})();
