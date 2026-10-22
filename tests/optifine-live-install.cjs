// Explicit integration check: downloads real software, provisions Java if needed,
// and installs a real isolated OptiFine 1.12.2 G5 profile. It never launches a game.
// Keep third-party binaries in the temporary validation directory, not release/.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const AdmZip = require("adm-zip");
const compiled =
  process.env.LDFCL_TEST_COMPILED_ROOT ||
  path.join(__dirname, "..", "core", "dist");
const { GameService } = require(path.join(compiled, "core/services/game.js"));
const { scanGameDirectory } = require(
  path.join(compiled, "core/game-directories.js"),
);
const hash = (bytes, algorithm = "sha256") =>
  createHash(algorithm).update(bytes).digest("hex");
(async () => {
  const output = path.join(__dirname, "..", "release");
  await fs.mkdir(output, { recursive: true });
  const dataDir =
    process.env.LDFCL_OPTIFINE_LIVE_DATA ||
    (await fs.mkdtemp(path.join(os.tmpdir(), "LDFCL-optifine-live-")));
  const gameRoot = path.join(dataDir, ".minecraft");
  await fs.mkdir(gameRoot, { recursive: true });
  const nativeProfile = path.join(gameRoot, "launcher_profiles.json");
  const nativeSentinel =
    '{"profiles":{"native":{"name":"Preserve native launcher profile"}}}';
  await fs.writeFile(nativeProfile, nativeSentinel);
  const lines = [];
  const seen = new Set();
  const javaRuntimes = [];
  const service = new GameService(
    dataDir,
    (event) => {
      if (event.type === "log") lines.push(event.line);
      if (event.type !== "task") return;
      const key = `${event.task.id}:${event.task.status}`;
      if (seen.has(key)) return;
      seen.add(key);
      const line = `${event.task.title}: ${event.task.status}${event.task.detail ? " — " + event.task.detail : ""}`;
      lines.push(line);
      console.log(line);
    },
    { minecraftRoot: gameRoot },
  );
  service.setConcurrency(16);
  const originalEnsure = service.java.ensure.bind(service.java);
  service.java.ensure = async (...args) => {
    const executable = await originalEnsure(...args);
    const inspected = await service.java.inspect(executable);
    javaRuntimes.push(inspected);
    return executable;
  };
  try {
    const instance = await service.install({
      version: "1.12.2",
      loader: "optifine",
      loaderVersion: "HD_U_G5",
      name: "OptiFine 真实安装验证",
    });
    const target = path.join(gameRoot, "versions", instance.versionDirectory);
    const profile = JSON.parse(
      await fs.readFile(
        path.join(target, `${instance.versionDirectory}.json`),
        "utf8",
      ),
    );
    const client = await fs.readFile(
      path.join(target, `${instance.versionDirectory}.jar`),
    );
    const libraryPath = path.join(
      gameRoot,
      "libraries/optifine/OptiFine/1.12.2_HD_U_G5/OptiFine-1.12.2_HD_U_G5.jar",
    );
    const patched = await fs.readFile(libraryPath);
    const installer = await fs.readFile(
      path.join(dataDir, "cache/optifine/OptiFine_1.12.2_HD_U_G5.jar"),
    );
    const patchedJar = new AdmZip(patched);
    const launchwrapper = path.join(
      gameRoot,
      "libraries/optifine/launchwrapper-of/2.2/launchwrapper-of-2.2.jar",
    );
    assert.equal(instance.loader, "optifine");
    assert.equal(instance.loaderVersion, "HD_U_G5");
    assert.equal(profile.mainClass, "net.minecraft.launchwrapper.Launch");
    assert.equal(profile.inheritsFrom, undefined);
    assert(profile.minecraftArguments.includes("optifine.OptiFineTweaker"));
    assert.equal(hash(client, "sha1"), profile.downloads.client.sha1);
    assert.notEqual(
      hash(patched),
      hash(installer),
      "installer must be patched, not simply renamed",
    );
    assert(patchedJar.getEntry("optifine/OptiFineTweaker.class"));
    assert(
      patchedJar
        .getEntries()
        .some((entry) => /^[^/]+\.class$/.test(entry.entryName)),
      "generated library includes patched Minecraft classes",
    );
    assert.equal(
      patchedJar
        .getEntries()
        .filter((entry) => /\.xdelta$/.test(entry.entryName)).length,
      0,
    );
    assert(
      new AdmZip(launchwrapper).getEntry(
        "net/minecraft/launchwrapper/Launch.class",
      ),
    );
    assert.equal(await fs.readFile(nativeProfile, "utf8"), nativeSentinel);
    assert(javaRuntimes.some((runtime) => runtime?.major === 8));
    const scan = await scanGameDirectory({
      id: "validation",
      name: "验证",
      path: gameRoot,
      layout: "standard",
    });
    assert(
      scan.instances.some(
        (entry) =>
          entry.loader === "optifine" && entry.loaderVersion === "HD_U_G5",
      ),
    );
    const result = {
      passed: true,
      checkedAt: new Date().toISOString(),
      dataDir,
      instance,
      java: javaRuntimes,
      client: {
        size: client.length,
        sha1: hash(client, "sha1"),
        verifiedAgainstMojang: true,
      },
      installer: {
        size: installer.length,
        sha256: hash(installer),
        source: "https://bmclapi2.bangbang93.com/optifine/1.12.2/HD_U/G5",
      },
      generatedLibrary: {
        size: patched.length,
        sha256: hash(patched),
        entries: patchedJar.getEntries().length,
        patchedClasses: patchedJar
          .getEntries()
          .filter((entry) => /^[^/]+\.class$/.test(entry.entryName)).length,
      },
      launchProfile: {
        mainClass: profile.mainClass,
        arguments: profile.minecraftArguments,
        libraries: profile.libraries.length,
        assetIndex: profile.assetIndex?.id,
      },
      nativeProfilesPreserved: true,
      gameLaunched: false,
    };
    await fs.writeFile(
      path.join(output, "optifine-live-install.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
  } finally {
    await fs.writeFile(
      path.join(output, "optifine-live-install.log"),
      lines.join("\n"),
    );
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
