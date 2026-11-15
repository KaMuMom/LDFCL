"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { chromium, _electron: electron } = require("playwright-core");
// Read actual output pixels from both production rendering paths. Controlled
// textures make double-gamma and a missing postprocessing conversion measurable.
(async () => {
  const root = path.resolve(__dirname, "..");
  const executable = process.env.LDFCL_TEST_LIGHTING_EXE;
  const baseline = process.env.LDFCL_LIGHTING_BASELINE === "1";
  const output = path.join(
    root,
    "test-results",
    "skin-lighting",
    executable ? "packaged" : baseline ? "before" : "after",
  );
  await fs.mkdir(output, { recursive: true });
  const { createServer } = await import("vite");
  const server = await createServer({
    root,
    server: { host: "127.0.0.1", port: 0, watch: { ignored: ["**/*"] } },
  });
  const report = {
    passed: false,
    baseline,
    runtime: executable ? "packaged-electron" : "browser-fixture",
    samples: [],
    checks: [],
    pageErrors: [],
  };
  let browser, app, temporaryRoot;
  try {
    let page;
    if (executable) {
      assert(
        path.isAbsolute(executable),
        "Pass an absolute unpacked application executable",
      );
      temporaryRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "LDFCL-lighting-qa-"),
      );
      const env = {
        ...process.env,
        LDFCL_DATA_DIR: path.join(temporaryRoot, "data"),
        LDFCL_GAME_ROOT: path.join(temporaryRoot, "game"),
      };
      for (const key of Object.keys(env))
        if (
          key.startsWith("PORTABLE_EXECUTABLE_") ||
          ["ELECTRON_RUN_AS_NODE", "LDFCL_DEV_URL", "NODE_OPTIONS"].includes(
            key,
          )
        )
          delete env[key];
      app = await electron.launch({
        executablePath: executable,
        args: [`--user-data-dir=${path.join(temporaryRoot, "browser")}`],
        env,
        timeout: 45000,
      });
      report.applicationVersion = await app.evaluate(({ app }) =>
        app.getVersion(),
      );
      report.asarSha256 = createHash("sha256")
        .update(
          await fs.readFile(
            path.join(path.dirname(executable), "resources", "app.asar"),
          ),
        )
        .digest("hex");
      page = await app.firstWindow();
      await page
        .getByRole("heading", { name: "开始游戏", exact: true })
        .waitFor({ timeout: 30000 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      page.on("pageerror", (error) => report.pageErrors.push(error.message));
      await page.evaluate(() => {
        window.__lighting = {
          state: { settings: { interfacePerformance: "efficient" } },
          emit() {
            document.documentElement.dataset.performance =
              this.state.settings.interfacePerformance;
          },
        };
        window.__lighting.emit();
      });
    } else {
      await server.listen();
      browser = await chromium.launch({
        executablePath: require("./helpers/browser.cjs").browserExecutable(),
        headless: true,
        args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
      });
      page = await browser.newPage({
        viewport: { width: 1120, height: 760 },
        reducedMotion: "reduce",
      });
      page.on("pageerror", (error) => report.pageErrors.push(error.message));
      await page.route("**/*", (route) =>
        new URL(route.request().url()).hostname === "127.0.0.1"
          ? route.continue()
          : route.abort(),
      );
      await page.addInitScript(() => {
        const listeners = new Set();
        const state = {
          instances: [],
          accounts: [],
          gameDirectories: [],
          settings: {
            theme: "light",
            interfacePerformance: "efficient",
            motion: "reduced",
            downloadConcurrency: 8,
            memoryMode: "auto",
            memoryMb: 4096,
            javaPath: "",
            microsoftClientId: "",
            closeOnLaunch: false,
          },
          system: {
            totalMemoryMb: 8192,
            freeMemoryMb: 4096,
            platform: "Windows x64",
            version: "lighting-fixture",
            dataDir: "fixture-only",
            gameRoot: "fixture-only",
            defaultGameRoot: "fixture-only",
          },
        };
        window.__lighting = {
          state,
          emit: () => {
            for (const fn of listeners) fn({ type: "state" });
          },
        };
        window.launcher = {
          call: async (method) => {
            if (method === "state") return structuredClone(state);
            if (method === "update:state")
              return {
                status: "idle",
                supported: false,
                currentVersion: "lighting-fixture",
              };
            if (["skin-library:list", "mod-favorites:list"].includes(method))
              return [];
            throw Error("Unexpected lighting fixture call: " + method);
          },
          onEvent: (fn) => {
            listeners.add(fn);
            return () => listeners.delete(fn);
          },
        };
      });
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
    }
    async function viewer(selector) {
      await page.locator(selector).waitFor();
      await page.waitForFunction((selector) => {
        const canvas = document.querySelector(selector);
        let fiber =
          canvas?.[
            Object.keys(canvas).find((key) => key.startsWith("__reactFiber$"))
          ];
        while (fiber) {
          let hook = fiber.memoizedState;
          while (hook) {
            const v = hook.memoizedState?.current;
            if (v?.renderer?.isWebGLRenderer && v.playerObject?.skin.map) {
              window.__lighting.viewer = v;
              return true;
            }
            hook = hook.next;
          }
          fiber = fiber.return;
        }
        return false;
      }, selector);
      await page.evaluate(() => {
        const qa = window.__lighting,
          v = qa.viewer;
        v.animation = null;
        v.autoRotate = false;
        const original = v.renderer.render.bind(v.renderer);
        v.renderer.render = (scene, camera) => {
          const result = original(scene, camera);
          if (qa.capture && v.renderer.getRenderTarget() === null) {
            const gl = v.renderer.getContext(),
              data = new Uint8Array(
                gl.drawingBufferWidth * gl.drawingBufferHeight * 4,
              );
            gl.readPixels(
              0,
              0,
              gl.drawingBufferWidth,
              gl.drawingBufferHeight,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              data,
            );
            const histogram = Array.from({ length: 3 }, () =>
              new Array(256).fill(0),
            );
            let count = 0;
            for (let i = 0; i < data.length; i += 4)
              if (data[i + 3] >= 250) {
                count++;
                for (let c = 0; c < 3; c++) histogram[c][data[i + c]]++;
              }
            const quantile = (h, q) => {
              let sum = 0;
              for (let i = 0; i < 256; i++) {
                sum += h[i];
                if (sum >= count * q) return i;
              }
              return 255;
            };
            qa.sample = {
              count,
              median: histogram.map((h) => quantile(h, 0.5)),
              p10: histogram.map((h) => quantile(h, 0.1)),
              p90: histogram.map((h) => quantile(h, 0.9)),
            };
            qa.capture = false;
          }
          return result;
        };
      });
      await page.waitForTimeout(450);
    }
    async function mode(mode) {
      await page.evaluate((mode) => {
        window.__lighting.state.settings.interfacePerformance = mode;
        window.__lighting.emit();
      }, mode);
      await page.waitForFunction(
        (mode) => document.documentElement.dataset.performance === mode,
        mode,
      );
      await page.waitForTimeout(120);
    }
    async function sample() {
      await page.evaluate(() => {
        window.__lighting.capture = true;
        window.__lighting.viewer.controls.dispatchEvent({ type: "change" });
      });
      await page.waitForFunction(() => !window.__lighting.capture);
      const value = await page.evaluate(() => window.__lighting.sample);
      assert(value.count > 500, "visible rendered pixels required");
      return value;
    }
    for (const [area, selector, panel] of [
      ["home", ".home-skin-viewport canvas", ".home-skin-panel"],
      ["wardrobe", ".wardrobe-stage canvas", ".wardrobe-stage"],
    ]) {
      if (area === "wardrobe")
        await page
          .locator("aside.sidebar")
          .getByRole("button", { name: "皮肤与披风", exact: true })
          .click();
      await viewer(selector);
      for (const displayMode of ["efficient", "quality"]) {
        await mode(displayMode);
        await sample();
        await page.locator(panel).screenshot({
          path: path.join(output, `${area}-${displayMode}.png`),
        });
      }
      for (const fixture of [
        { name: "mid", rgb: [128, 128, 128], min: 104, max: 139 },
        { name: "dark", rgb: [32, 32, 32], min: 20, max: 40 },
        { name: "white", rgb: [240, 240, 240], min: 210, max: 247 },
        { name: "color", rgb: [72, 120, 176] },
        { name: "slim", rgb: [128, 128, 128], min: 104, max: 139 },
        { name: "cape", rgb: [128, 128, 128], min: 104, max: 139 },
      ]) {
        await page.evaluate((fixture) => {
          const v = window.__lighting.viewer,
            texture = document.createElement("canvas");
          texture.width = 64;
          texture.height = fixture.name === "cape" ? 32 : 64;
          const ctx = texture.getContext("2d");
          ctx.fillStyle = `rgb(${fixture.rgb.join(",")})`;
          ctx.fillRect(0, 0, texture.width, texture.height);
          v.playerObject.resetJoints();
          v.playerWrapper.rotation.y = 0;
          v.playerObject.rotation.y =
            fixture.name === "cape"
              ? Math.PI
              : fixture.name === "mid"
                ? -Math.PI / 4
                : -0.25;
          v.playerObject.skin.visible = fixture.name !== "cape";
          v.playerObject.cape.visible = fixture.name === "cape";
          if (fixture.name === "cape") v.loadCape(texture);
          else
            v.loadSkin(texture, {
              model: fixture.name === "slim" ? "slim" : "default",
            });
        }, fixture);
        const modes = {};
        for (const displayMode of ["efficient", "quality"]) {
          await mode(displayMode);
          modes[displayMode] = await sample();
        }
        report.samples.push({
          area,
          fixture: fixture.name,
          input: fixture.rgb,
          ...modes,
        });
        if (!baseline) {
          for (const displayMode of ["efficient", "quality"]) {
            if (fixture.min !== undefined)
              assert(
                modes[displayMode].median.every(
                  (x) => x >= fixture.min && x <= fixture.max,
                ),
                `${area}/${fixture.name}/${displayMode}: unexpected lightness ${modes[displayMode].median}`,
              );
            if (fixture.name === "color")
              assert(
                modes[displayMode].median.every(
                  (x, i) => Math.abs(x - fixture.rgb[i]) <= 20,
                ),
                `${area}/${displayMode}: texture colors must stay close to original`,
              );
          }
          assert(
            modes.efficient.median.every(
              (x, i) => Math.abs(x - modes.quality.median[i]) <= 3,
            ),
            `${area}/${fixture.name}: mode switch changes gamma`,
          );
          if (fixture.name === "mid")
            assert(
              modes.efficient.p90[0] - modes.efficient.p10[0] >= 8,
              `${area}: directional light must give faces visible depth`,
            );
        }
      }
      report.checks.push(
        baseline
          ? `${area}: baseline output pixels recorded`
          : `${area}: midtones, dark tones, highlights, colored skin, classic/slim reload and cape retain natural colors across efficient/quality rendering`,
      );
    }
    assert.deepEqual(report.pageErrors, []);
    report.passed = !baseline;
  } catch (error) {
    report.error = error.stack;
    process.exitCode = 1;
  } finally {
    await browser?.close();
    await app?.close();
    await server.close();
    if (temporaryRoot) {
      assert.equal(path.dirname(temporaryRoot), path.resolve(os.tmpdir()));
      await fs.rm(temporaryRoot, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 250,
      });
    }
    await fs.writeFile(
      path.join(output, "report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
  }
})();
