// Explicit live integration check; never touches registered/personal game roots.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { GameService } = require("@ldfcl/core/services/game");
const { defaults } = require("@ldfcl/core/store");
const { setDownloadSource } = require("@ldfcl/core/services/downloads");
(async () => {
  const workspace = process.env.LDFCL_LIVE_WORKSPACE
    ? await fs.realpath(process.env.LDFCL_LIVE_WORKSPACE)
    : await fs.mkdtemp(path.join(os.tmpdir(), "LDFCL-NeoForge-live-"));
  if (
    path.dirname(workspace).toLowerCase() !==
      (await fs.realpath(os.tmpdir())).toLowerCase() ||
    !path.basename(workspace).startsWith("LDFCL-NeoForge-live-")
  )
    throw Error("Live verification must use its own TEMP workspace");
  const log = [],
    tasks = new Map();
  let instance,
    lastStatus = 0,
    ready;
  const initialized = new Promise((resolve) => {
    ready = resolve;
  });
  const game = new GameService(
    workspace,
    (event) => {
      if (event.type === "task") {
        tasks.set(event.task.id, event.task);
        if (
          Date.now() - lastStatus > 10000 ||
          ["failed", "error"].includes(event.task.status)
        ) {
          lastStatus = Date.now();
          console.log(
            JSON.stringify({
              task: event.task.title,
              status: event.task.status,
              progress: event.task.progress,
              detail: event.task.detail,
            }),
          );
        }
      }
      if (event.type === "log") {
        log.push(event.line);
        if (
          /Sound engine started|Created:.*textures\/atlas|OpenAL initialized/i.test(
            event.line,
          )
        )
          ready({ initialized: true });
      }
      if (event.type === "game" && event.status === "exited")
        ready({ initialized: false, exitCode: event.exitCode });
    },
    { minecraftRoot: path.join(workspace, ".minecraft") },
  );
  const report = {
    workspace,
    version: "1.21",
    loader: "neoforge",
    installed: false,
    launched: false,
    initialized: false,
  };
  game.downloads.concurrency = 16;
  try {
    setDownloadSource(
      process.env.LDFCL_LIVE_SOURCE === "bmclapi" ? "bmclapi" : "official",
    );
    console.log(JSON.stringify({ workspace, phase: "install" }));
    instance = await game.install({
      version: "1.21",
      loader: "neoforge",
      name: "NeoForge 1.21 live verification",
    });
    report.installed = true;
    report.instance = instance;
    console.log(
      JSON.stringify({
        phase: "launch",
        loaderVersion: instance.loaderVersion,
      }),
    );
    const result = await game.launch(
      instance,
      {
        id: "verification",
        type: "offline",
        name: "LDFCLVerify",
        uuid: "8328c130c74b3ce493d5822a404a858c",
      },
      { ...defaults, downloadConcurrency: 16 },
    );
    report.launched = !!result.pid;
    report.pid = result.pid;
    let timer;
    const state = await Promise.race([
      initialized,
      new Promise((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              initialized: false,
              reason: "Client initialization timeout",
            }),
          120000,
        );
      }),
    ]);
    clearTimeout(timer);
    Object.assign(report, state);
    await game.stop(instance.id);
    if (!report.initialized)
      throw Error("NeoForge did not reach client render/audio initialization");
    report.passed = true;
  } catch (error) {
    report.error = String(error.message || error);
    report.passed = false;
    if (instance) await game.stop(instance.id).catch(() => {});
    process.exitCode = 1;
  } finally {
    await fs.writeFile(path.join(workspace, "game-output.log"), log.join("\n"));
    await fs.writeFile(
      path.join(workspace, "verification.json"),
      JSON.stringify(report, null, 2),
    );
    await fs.mkdir(path.join(__dirname, "..", "test-results"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(__dirname, "..", "test-results", "p0-p6-neoforge-live.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
  }
})();
