const { chromium } = require("playwright-core");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const AdmZip = require("adm-zip");

// Measure a real, unmodified portable program. CPU throttling controls only
// renderer execution; it does not emulate an old iGPU, low RAM, or storage.
// All account/configuration/mod files are synthetic and live in TEMP.
(async () => {
  const project = path.resolve(__dirname, "..");
  const source = path.resolve(
    process.env.LDFCL_TEST_PORTABLE_EXE ||
      path.join(project, "release/0.6.3/LDFCL-0.6.3-Windows-x64.exe"),
  );
  const label = process.env.LDFCL_PERF_LABEL || "baseline";
  assert(/^[a-z0-9.-]+$/i.test(label), "Invalid report label");
  const rates = (process.env.LDFCL_PERF_RATES || "1,4,6")
    .split(",")
    .map(Number);
  assert(
    rates.every((value) => Number.isFinite(value) && value >= 1 && value <= 20),
  );
  const duration = Math.max(
    2000,
    Math.min(10000, Number(process.env.LDFCL_PERF_DURATION) || 4500),
  );
  const modCount = Math.max(
    0,
    Math.min(3000, Number(process.env.LDFCL_PERF_MOD_COUNT) || 1000),
  );
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "LDFCL-perf-"));
  const portable = path.join(workspace, "便携性能测试");
  const data = path.join(portable, "LDFCL-data");
  const game = path.join(portable, ".minecraft");
  const profile = "1.21.1-fabric-perf";
  const instanceDir = path.join(game, "versions", profile);
  const executable = path.join(portable, path.basename(source));
  const output = path.join(project, "test-results", "ui-performance");
  await fs.mkdir(output, { recursive: true });
  const reportPath = path.join(output, `${label}.json`);
  const report = {
    passed: false,
    methodVersion: 2,
    label,
    timestamp: new Date().toISOString(),
    executable: source,
    executableSha256: createHash("sha256")
      .update(await fs.readFile(source))
      .digest("hex"),
    sampleDurationMs: duration,
    rates,
    modCount,
    scenarios: [],
    pageErrors: [],
    limitations: [
      "Renderer CPU slowdown is controlled stress, not a low-end CPU/iGPU/RAM emulator.",
      "rAF frame intervals describe compositor opportunities and main-thread stalls, not proof of physical display presentation.",
      "Samples exclude installation, network transfer and real Minecraft gameplay; cache and first-route setup are reported separately.",
      "Pointer stress dispatches synthetic window mousemove events at an 8ms requested interval; it is not native mouse input or full hit-testing latency measurement.",
      "Scroll stress changes the actual scrollable mod-list or nearest scrollable ancestor and records cumulative movement; wardrobe rotation is explicitly enabled before measurement.",
    ],
  };
  let child,
    browser,
    exited = false,
    exitCode;
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const execFileAsync = promisify(execFile);
  async function processMemory() {
    try {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,PrivatePageCount | ConvertTo-Json -Compress",
        ],
        { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 },
      );
      const all = JSON.parse(stdout);
      const pids = new Set([child.pid]);
      let previous;
      do {
        previous = pids.size;
        for (const item of all)
          if (pids.has(item.ParentProcessId)) pids.add(item.ProcessId);
      } while (pids.size !== previous);
      const processes = all
        .filter((item) => pids.has(item.ProcessId))
        .map((item) => ({
          pid: item.ProcessId,
          parentPid: item.ParentProcessId,
          name: item.Name,
          workingSetBytes: Number(item.WorkingSetSize),
          privateBytes: Number(item.PrivatePageCount),
        }));
      return {
        processes,
        workingSetBytes: processes.reduce(
          (sum, item) => sum + item.workingSetBytes,
          0,
        ),
        privateBytes: processes.reduce(
          (sum, item) => sum + item.privateBytes,
          0,
        ),
        note: "CIM process-tree snapshot; summed working sets can double-count shared pages and are not total system memory pressure.",
      };
    } catch (error) {
      return { unavailable: error.message };
    }
  }
  async function write(relative, value) {
    const file = path.join(portable, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, value);
  }
  async function port() {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const value = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    return value;
  }
  try {
    try {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$perfCpu=Get-CimInstance Win32_Processor; $perfSystem=Get-CimInstance Win32_ComputerSystem; $perfDisplay=Get-CimInstance Win32_VideoController; [pscustomobject]@{processor=($perfCpu.Name -join '; ');logicalProcessors=($perfCpu.NumberOfLogicalProcessors | Measure-Object -Sum).Sum;physicalMemoryBytes=[double]$perfSystem.TotalPhysicalMemory;displays=@($perfDisplay | Select-Object Name,CurrentHorizontalResolution,CurrentVerticalResolution,CurrentRefreshRate)} | ConvertTo-Json -Depth 4 -Compress",
        ],
        { windowsHide: true, timeout: 15000 },
      );
      report.host = JSON.parse(stdout);
    } catch (error) {
      report.hostObservationError = error.message;
    }
    await fs.mkdir(portable, { recursive: true });
    await fs.copyFile(source, executable);
    await write(
      "LDFCL-data/launcher.json",
      JSON.stringify({
        gameDirectories: [
          {
            id: "perf-root",
            name: "Synthetic performance root",
            path: game,
            layout: "standard",
            isDefault: true,
          },
        ],
        selectedGameDirectoryId: "perf-root",
        selectedInstanceId: "perf-instance",
        accounts: [],
        instances: [
          {
            id: "perf-instance",
            name: "1000 Mod 性能测试",
            version: "1.21.1",
            loader: "fabric",
            loaderVersion: "0.16.14",
            gameDirectoryId: "perf-root",
            versionDirectory: profile,
            createdAt: "2026-10-28T00:00:00.000Z",
            gameSettings: {},
          },
        ],
        settings: {
          theme: "light",
          downloadConcurrency: 8,
          memoryMode: "auto",
          memoryMb: 4096,
          javaPath: "",
          microsoftClientId: "",
          closeOnLaunch: false,
        },
      }),
    );
    await write(
      `.minecraft/versions/${profile}/${profile}.json`,
      JSON.stringify({
        id: profile,
        minecraftVersion: "1.21.1",
        mainClass: "net.fabricmc.loader.impl.launch.knot.KnotClient",
        libraries: [],
      }),
    );
    await fs.mkdir(path.join(instanceDir, "mods"), { recursive: true });
    for (let index = 0; index < modCount; index++) {
      const zip = new AdmZip();
      zip.addFile(
        "fabric.mod.json",
        Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            id: `performance_fixture_${index}`,
            version: "1.0.0",
            name: `性能测试 Mod ${String(index).padStart(4, "0")}`,
          }),
        ),
      );
      await fs.writeFile(
        path.join(
          instanceDir,
          "mods",
          `fixture-${String(index).padStart(4, "0")}.jar`,
        ),
        zip.toBuffer(),
      );
    }
    const cdpPort = await port();
    const environment = {
      ...process.env,
      LDFCL_DATA_DIR: data,
      LDFCL_GAME_ROOT: game,
    };
    for (const key of [
      "ELECTRON_RUN_AS_NODE",
      "LDFCL_DEV_URL",
      "PORTABLE_EXECUTABLE_FILE",
      "PORTABLE_EXECUTABLE_DIR",
      "PORTABLE_EXECUTABLE_APP_FILENAME",
    ])
      delete environment[key];
    child = spawn(
      executable,
      [
        `--user-data-dir=${path.join(workspace, "chromium")}`,
        `--remote-debugging-port=${cdpPort}`,
      ],
      { env: environment, windowsHide: true, stdio: "ignore" },
    );
    child.on("exit", (code) => {
      exited = true;
      exitCode = code;
    });
    child.on("error", (error) => {
      report.spawnError = error.message;
      exited = true;
    });
    let endpoint;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (exited) throw Error(`Portable exited before startup: ${exitCode}`);
      try {
        const response = await fetch(
          `http://127.0.0.1:${cdpPort}/json/version`,
          { signal: AbortSignal.timeout(1000) },
        );
        if (response.ok) {
          endpoint = await response.json();
          break;
        }
      } catch {}
      await pause(200);
    }
    assert(endpoint?.webSocketDebuggerUrl);
    browser = await chromium.connectOverCDP(endpoint.webSocketDebuggerUrl);
    const context = browser.contexts()[0];
    const page = context.pages()[0] || (await context.waitForEvent("page"));
    page.on("pageerror", (error) => report.pageErrors.push(error.message));
    await page
      .getByRole("heading", { name: "开始游戏", exact: true })
      .waitFor({ timeout: 60000 });
    await page.bringToFront();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    try {
      const browserCdp = await browser.newBrowserCDPSession();
      const system = await browserCdp.send("SystemInfo.getInfo");
      report.gpu = {
        devices: system.gpu.devices,
        featureStatus: system.gpu.featureStatus,
        renderer: system.gpu.auxAttributes?.glRenderer,
        softwareRendering: system.gpu.auxAttributes?.softwareRendering,
      };
      await browserCdp.detach();
    } catch (error) {
      report.gpuObservationError = error.message;
    }
    report.initial = await page.evaluate(() => ({
      viewport: {
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
      },
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory,
      visible: document.visibilityState,
    }));
    await page.evaluate(() => {
      window.__uiPerfDraws = 0;
      for (const kind of [
        window.WebGLRenderingContext,
        window.WebGL2RenderingContext,
      ]) {
        if (!kind) continue;
        for (const method of [
          "drawElements",
          "drawArrays",
          "drawElementsInstanced",
          "drawArraysInstanced",
        ]) {
          const original = kind.prototype[method];
          if (typeof original !== "function") continue;
          kind.prototype[method] = function (...args) {
            window.__uiPerfDraws++;
            return original.apply(this, args);
          };
        }
      }
      window.__uiPerfLongTasks = [];
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          window.__uiPerfLongTasks.push({
            start: entry.startTime,
            duration: entry.duration,
          });
      });
      observer.observe({ type: "longtask", buffered: false });
    });
    async function metrics() {
      return Object.fromEntries(
        (await cdp.send("Performance.getMetrics")).metrics.map((item) => [
          item.name,
          item.value,
        ]),
      );
    }
    async function inventory() {
      return page.evaluate(() => ({
        domNodes: document.querySelectorAll("*").length,
        svgFilters: document.querySelectorAll("filter").length,
        displacementFilters:
          document.querySelectorAll("feDisplacementMap").length,
        canvases: document.querySelectorAll("canvas").length,
        glassSurfaces: document.querySelectorAll(".glass-surface").length,
        liveLiquidRenderers:
          document.querySelectorAll(".liquid-renderer").length,
        backdropFilteredElements: [...document.querySelectorAll("*")].filter(
          (element) => {
            const style = getComputedStyle(element);
            return (
              style.backdropFilter !== "none" ||
              (style.webkitBackdropFilter &&
                style.webkitBackdropFilter !== "none")
            );
          },
        ).length,
        visible: document.visibilityState,
      }));
    }
    async function sample(name, rate, action = "none") {
      await page.mouse.move(1100, 40);
      await pause(300);
      const before = await metrics();
      const inv = await inventory();
      const result = await page.evaluate(
        ({ duration, action }) =>
          new Promise((resolve) => {
            const started = performance.now(),
              longStart = window.__uiPerfLongTasks.length,
              drawsStart = window.__uiPerfDraws;
            const times = [];
            let last,
              frame,
              actionCount = 0;
            const scrolling = action === "scroll" || action === "scroll-mods";
            const preferred = document.querySelector(
              action === "scroll-mods" ? ".mod-list" : ".main-content",
            );
            let scrollTarget = preferred;
            while (scrollTarget) {
              const style = getComputedStyle(scrollTarget);
              if (
                /auto|scroll|overlay/.test(style.overflowY) &&
                scrollTarget.scrollHeight > scrollTarget.clientHeight + 2
              )
                break;
              scrollTarget = scrollTarget.parentElement;
            }
            if (!scrollTarget && scrolling) {
              const main = document.querySelector(".main-content");
              if (main && main.scrollHeight > main.clientHeight + 2)
                scrollTarget = main;
            }
            if (scrolling && scrollTarget) scrollTarget.scrollTop = 0;
            const scrollStart = scrollTarget?.scrollTop || 0;
            let scrollTravel = 0,
              scrollMax = scrollStart;
            const timer =
              action === "none"
                ? undefined
                : setInterval(() => {
                    actionCount++;
                    if (action === "synthetic-window-mousemove")
                      window.dispatchEvent(
                        new MouseEvent("mousemove", {
                          clientX: 90 + ((actionCount * 13) % 960),
                          clientY: 50 + ((actionCount * 7) % 650),
                          bubbles: true,
                        }),
                      );
                    if (scrolling && scrollTarget) {
                      const beforeScroll = scrollTarget.scrollTop;
                      scrollTarget.scrollTop +=
                        actionCount % 100 < 50 ? 18 : -18;
                      scrollTravel += Math.abs(
                        scrollTarget.scrollTop - beforeScroll,
                      );
                      scrollMax = Math.max(scrollMax, scrollTarget.scrollTop);
                    }
                  }, 8);
            const finish = () => {
              cancelAnimationFrame(frame);
              clearInterval(timer);
              const elapsed = performance.now() - started;
              const sorted = [...times].sort((a, b) => a - b);
              const percentile = (p) =>
                sorted[
                  Math.min(
                    sorted.length - 1,
                    Math.floor((sorted.length - 1) * p),
                  )
                ] || 0;
              const total = times.reduce((sum, value) => sum + value, 0);
              const longTasks = window.__uiPerfLongTasks
                .slice(longStart)
                .filter((entry) => entry.start >= started);
              resolve({
                elapsedMs: elapsed,
                frames: times.length,
                averageFps: total ? (times.length * 1000) / total : 0,
                frameMs: {
                  p50: percentile(0.5),
                  p95: percentile(0.95),
                  p99: percentile(0.99),
                  max: sorted.at(-1) || 0,
                },
                framesOver25ms: times.filter((value) => value > 25).length,
                framesOver50ms: times.filter((value) => value > 50).length,
                approximateMissed60HzSlots: times.reduce(
                  (sum, value) =>
                    sum + Math.max(0, Math.round(value / (1000 / 60)) - 1),
                  0,
                ),
                longTasks: {
                  count: longTasks.length,
                  totalMs: longTasks.reduce(
                    (sum, entry) => sum + entry.duration,
                    0,
                  ),
                  maximumMs: Math.max(
                    0,
                    ...longTasks.map((entry) => entry.duration),
                  ),
                },
                webglDrawCalls: window.__uiPerfDraws - drawsStart,
                actionCount,
                scroll: scrolling
                  ? {
                      target: scrollTarget
                        ? `${scrollTarget.tagName.toLowerCase()}.${String(scrollTarget.className).trim().replace(/\s+/g, ".")}`
                        : null,
                      scrollHeight: scrollTarget?.scrollHeight || 0,
                      clientHeight: scrollTarget?.clientHeight || 0,
                      start: scrollStart,
                      end: scrollTarget?.scrollTop || 0,
                      maximum: scrollMax,
                      cumulativePixels: scrollTravel,
                    }
                  : undefined,
              });
            };
            const tick = (stamp) => {
              if (last !== undefined) times.push(stamp - last);
              last = stamp;
              if (stamp - started >= duration) finish();
              else frame = requestAnimationFrame(tick);
            };
            frame = requestAnimationFrame(tick);
          }),
        { duration, action },
      );
      if (action === "scroll" || action === "scroll-mods")
        assert(
          result.scroll?.cumulativePixels > 100,
          `${name}: no actual scrolling: ${JSON.stringify(result.scroll)}`,
        );
      const after = await metrics();
      const metricDelta = {};
      for (const key of [
        "TaskDuration",
        "ScriptDuration",
        "LayoutDuration",
        "RecalcStyleDuration",
        "LayoutCount",
        "RecalcStyleCount",
      ])
        metricDelta[key] = after[key] - before[key];
      const entry = {
        name,
        cpuSlowdown: rate,
        action,
        ...result,
        inventory: inv,
        mainThreadMetricsDelta: metricDelta,
        jsHeapBytes: after.JSHeapUsedSize,
        processMemory: await processMemory(),
      };
      report.scenarios.push(entry);
      await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
      console.log(
        JSON.stringify({
          scenario: name,
          rate,
          fps: result.averageFps.toFixed(1),
          p95: result.frameMs.p95.toFixed(1),
          longTasks: result.longTasks.count,
          drawCalls: result.webglDrawCalls,
          dom: inv.domNodes,
          liquid: inv.liveLiquidRenderers,
        }),
      );
    }
    for (const rate of rates) {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate });
      await page.getByRole("button", { name: "开始游戏", exact: true }).click();
      await page.getByLabel("首页角色皮肤预览", { exact: true }).waitFor();
      await pause(1500);
      await sample("home-idle", rate);
      await sample("home-pointer", rate, "synthetic-window-mousemove");
      const wardrobeStart = performance.now();
      await page
        .getByRole("button", { name: "皮肤与披风", exact: true })
        .click();
      await page.locator(".wardrobe-stage canvas").waitFor();
      const rotation = page.getByRole("button", {
        name: /^(开启|暂停)自动旋转$/,
      });
      assert.equal(await rotation.count(), 1);
      if ((await rotation.getAttribute("aria-pressed")) !== "true")
        await rotation.click();
      assert.equal(await rotation.getAttribute("aria-pressed"), "true");
      await pause(1000);
      report.scenarios.push({
        name: "wardrobe-navigation",
        cpuSlowdown: rate,
        elapsedIncludingTextureWarmupMs: performance.now() - wardrobeStart,
        rotationEnabled: true,
      });
      await sample("wardrobe-rotating", rate);
      await page
        .getByRole("button", { name: "启动器设置", exact: true })
        .click();
      await page.locator(".settings-grid").waitFor();
      await pause(500);
      await sample("settings-scroll", rate, "scroll");
      const modsStart = performance.now();
      await page.getByRole("button", { name: "游戏实例", exact: true }).click();
      await page.locator(".mod-row").first().waitFor({ timeout: 60000 });
      report.scenarios.push({
        name: "mods-first-navigation",
        cpuSlowdown: rate,
        elapsedMs: performance.now() - modsStart,
        renderedRows: await page.locator(".mod-row").count(),
        expectedDataRows: modCount,
      });
      await pause(700);
      await sample("mods-scroll-1000", rate, "scroll-mods");
      await page.screenshot({
        path: path.join(output, `${label}-mods-${rate}x.png`),
      });
    }
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    report.finalState = await page
      .evaluate(() => window.launcher.call("state"))
      .then((state) => ({
        version: state.system.version,
        accounts: state.accounts.length,
        instanceCount: state.instances.length,
      }));
    assert.equal(report.finalState.accounts, 0);
    assert.equal(report.finalState.instanceCount, 1);
    assert.deepEqual(report.pageErrors, []);
    await page.evaluate(() => window.launcher.window("close"));
    const closeDeadline = Date.now() + 15000;
    while (!exited && Date.now() < closeDeadline) await pause(150);
    assert(exited);
    assert.equal(exitCode, 0);
    report.exitCode = exitCode;
    report.passed = true;
  } catch (error) {
    report.error = { message: error.message, stack: error.stack };
    throw error;
  } finally {
    await browser?.close().catch(() => {});
    if (child && !exited)
      await new Promise((resolve) => {
        const killer = spawn(
          "taskkill",
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" },
        );
        killer.once("exit", resolve);
        killer.once("error", resolve);
      });
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    assert(
      path.resolve(workspace).startsWith(path.resolve(os.tmpdir()) + path.sep),
    );
    await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
  console.log(
    JSON.stringify({
      passed: report.passed,
      reportPath,
      scenarios: report.scenarios.length,
    }),
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
