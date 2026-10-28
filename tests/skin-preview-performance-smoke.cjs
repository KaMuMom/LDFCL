const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright-core");

// Real React/skinview3d with software WebGL; fixtures never access account
// services, personal game directories or the Electron profile.
(async () => {
  const root = path.resolve(__dirname, "..");
  const output = path.join(root, "test-results", "skin-performance");
  await fs.mkdir(output, { recursive: true });
  const { createServer } = await import("vite");
  const server = await createServer({
    root,
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
      watch: { ignored: ["**/*"] },
    },
  });
  const checks = [];
  const measurements = {};
  const errors = [];
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({
      executablePath:
        process.env.LDFCL_TEST_BROWSER ||
        "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      headless: true,
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    });
    const page = await browser.newPage({
      viewport: { width: 1120, height: 760 },
      deviceScaleFactor: 2,
    });
    page.on("pageerror", (error) => errors.push(error.message));
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
          version: "skin-performance-qa",
          dataDir: "fixture-only",
          gameRoot: "fixture-only",
          defaultGameRoot: "fixture-only",
        },
      };
      window.__skinPerf = {
        state,
        viewers: [],
        emit() {
          for (const listener of listeners) listener({ type: "state" });
        },
      };
      window.launcher = {
        async call(method) {
          if (method === "state") return structuredClone(state);
          if (method === "update:state")
            return {
              status: "idle",
              currentVersion: "0.6.3",
              supported: false,
            };
          if (method === "skin-library:list" || method === "mod-favorites:list")
            return [];
          if (method === "skin:profile")
            return {
              skins: state.accounts[0]?.skins || [],
              capes: state.accounts[0]?.capes || [],
              editable: false,
            };
          throw Error("Unexpected skin performance fixture call: " + method);
        },
        onEvent(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
    await page
      .getByRole("heading", { name: "开始游戏", exact: true })
      .waitFor();

    async function inspectViewer(selector) {
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
            const viewer = hook.memoizedState?.current;
            if (viewer?.renderer?.isWebGLRenderer && viewer.skinTexture)
              return true;
            hook = hook.next;
          }
          fiber = fiber.return;
        }
        return false;
      }, selector);
      await page.evaluate((selector) => {
        const canvas = document.querySelector(selector);
        let fiber =
          canvas[
            Object.keys(canvas).find((key) => key.startsWith("__reactFiber$"))
          ];
        while (fiber) {
          let hook = fiber.memoizedState;
          while (hook) {
            const viewer = hook.memoizedState?.current;
            if (viewer?.renderer?.isWebGLRenderer && viewer.skinTexture) {
              const qa = window.__skinPerf;
              qa.viewer = viewer;
              qa.viewers.push(viewer);
              qa.draws = 0;
              const render = viewer.renderer.render.bind(viewer.renderer);
              viewer.renderer.render = (scene, camera) => {
                const result = render(scene, camera);
                if (scene === viewer.scene) {
                  qa.draws++;
                  if (qa.capture) {
                    qa.capture = false;
                    const context = viewer.renderer.getContext();
                    const pixels = new Uint8Array(
                      context.drawingBufferWidth *
                        context.drawingBufferHeight *
                        4,
                    );
                    context.readPixels(
                      0,
                      0,
                      context.drawingBufferWidth,
                      context.drawingBufferHeight,
                      context.RGBA,
                      context.UNSIGNED_BYTE,
                      pixels,
                    );
                    qa.coloredPixels = 0;
                    for (let index = 0; index < pixels.length; index += 4)
                      if (
                        pixels[index + 3] > 0 &&
                        pixels[index] + pixels[index + 1] + pixels[index + 2] >
                          30
                      )
                        qa.coloredPixels++;
                  }
                }
                return result;
              };
              return;
            }
            hook = hook.next;
          }
          fiber = fiber.return;
        }
        throw Error("SkinViewer React ref missing");
      }, selector);
    }
    let lastSample;
    async function countFrames(milliseconds = 650) {
      const before = await page.evaluate(() => ({
        draws: window.__skinPerf.draws,
        time: performance.now(),
      }));
      await page.waitForTimeout(milliseconds);
      const after = await page.evaluate(() => ({
        draws: window.__skinPerf.draws,
        time: performance.now(),
      }));
      lastSample = {
        frames: after.draws - before.draws,
        durationMs: after.time - before.time,
      };
      return lastSample.frames;
    }
    // Allow async ResizeObserver / texture upload callbacks to complete before
    // sampling idle work, including under software WebGL and concurrent CI load.
    const settle = () => page.waitForTimeout(750);
    const dock = page.locator("aside.sidebar");
    await inspectViewer(".home-skin-viewport canvas");
    await settle();
    measurements.homeIdleFrames = await countFrames();
    assert.equal(
      measurements.homeIdleFrames,
      0,
      "efficient home has no idle WebGL rendering",
    );
    assert.deepEqual(
      await page.evaluate(() => ({
        ratio: window.__skinPerf.viewer.pixelRatio,
        target: window.__skinPerf.viewer.composer.renderTarget1.width,
        paused: window.__skinPerf.viewer.renderPaused,
        model: window.__skinPerf.viewer.playerObject.skin.modelType,
      })),
      { ratio: 1, target: 1, paused: true, model: "default" },
    );
    await page.evaluate(() => {
      window.__skinPerf.capture = true;
      window.__skinPerf.viewer.controls.dispatchEvent({ type: "change" });
    });
    await page.waitForFunction(() => window.__skinPerf.coloredPixels > 1000);
    await page
      .locator(".home-skin-panel")
      .screenshot({ path: path.join(output, "efficient-home.png") });
    checks.push(
      "efficient home: idle zero WebGL draws; DPR 1 on a DPR 2 display; single-pass scene visibly contains classic Steve; unused targets reduced to 1px",
    );

    const homeCanvas = page.locator(".home-skin-viewport canvas");
    const homeBefore = await page.evaluate(() =>
      window.__skinPerf.viewer.camera.position.toArray(),
    );
    const homeBox = await homeCanvas.boundingBox();
    await page.mouse.move(
      homeBox.x + homeBox.width / 2,
      homeBox.y + homeBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      homeBox.x + homeBox.width / 2 + 65,
      homeBox.y + homeBox.height / 2 + 30,
      { steps: 8 },
    );
    await page.mouse.up();
    assert.notDeepEqual(
      await page.evaluate(() =>
        window.__skinPerf.viewer.camera.position.toArray(),
      ),
      homeBefore,
    );
    await page
      .getByRole("button", { name: "开启自动旋转", exact: true })
      .click();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    measurements.homeRotationFrames = await countFrames();
    measurements.homeRotationSample = lastSample;
    assert(
      measurements.homeRotationFrames > 1 &&
        measurements.homeRotationFrames <= lastSample.durationMs * 0.06 + 2,
      JSON.stringify(measurements),
    );
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await settle();
    assert.equal(await countFrames(), 0, "unfocused preview stops rotation");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    assert((await countFrames()) > 3, "focused preview resumes rotation");
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();
    assert.equal(await countFrames(), 0, "hidden document stops rotation");
    await page.evaluate(() => {
      delete document.hidden;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    assert((await countFrames()) > 3, "visible document resumes rotation");
    await page
      .locator(".home-skin-viewport")
      .evaluate((element) => (element.style.transform = "translateX(-5000px)"));
    await settle();
    assert.equal(await countFrames(), 0, "offscreen preview stops rotation");
    await page
      .locator(".home-skin-viewport")
      .evaluate((element) => (element.style.transform = ""));
    assert((await countFrames()) > 3, "onscreen preview resumes rotation");
    await page
      .getByRole("button", { name: "暂停自动旋转", exact: true })
      .click();
    await settle();
    assert.equal(await countFrames(), 0);
    checks.push(
      "home drag, explicit rotation, pause, window focus, document visibility and intersection visibility work without a persistent hidden loop",
    );

    await page.evaluate(() => {
      window.__skinPerf.state.settings.interfacePerformance = "quality";
      window.__skinPerf.emit();
    });
    await page.waitForFunction(
      () => window.__skinPerf.viewer.pixelRatio === 1.5,
    );
    assert(
      await page.evaluate(
        () =>
          window.__skinPerf.viewer.composer.renderTarget1.width >
          window.__skinPerf.viewer.width,
      ),
    );
    measurements.qualityIdleFrames = await countFrames();
    assert(measurements.qualityIdleFrames > 3);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForFunction(
      () => window.__skinPerf.viewer.animation === null,
    );
    await settle();
    assert.equal(
      await countFrames(),
      0,
      "reduced motion suppresses decorative quality animation",
    );
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.evaluate(() => {
      window.__skinPerf.state.settings.interfacePerformance = "efficient";
      window.__skinPerf.emit();
    });
    await page.waitForFunction(() => window.__skinPerf.viewer.pixelRatio === 1);
    await settle();
    assert.equal(await countFrames(), 0);
    checks.push(
      "quality restores FXAA target sizes and bounded DPR 1.5; reduced motion and returning to efficient eliminate idle rendering",
    );

    await dock.getByRole("button", { name: "皮肤与披风", exact: true }).click();
    await inspectViewer(".wardrobe-stage canvas");
    await settle();
    assert(await page.evaluate(() => window.__skinPerf.viewers[0].disposed));
    assert.equal(await countFrames(), 0);
    assert.equal(
      await page
        .getByRole("button", { name: "开启自动旋转", exact: true })
        .getAttribute("aria-pressed"),
      "false",
    );
    const zoom = await page.evaluate(() => window.__skinPerf.viewer.zoom);
    const zoomDraws = await page.evaluate(() => window.__skinPerf.draws);
    await page.getByRole("button", { name: "放大角色", exact: true }).click();
    await settle();
    assert(
      await page.evaluate(
        (draws) => window.__skinPerf.draws > draws,
        zoomDraws,
      ),
      "zoom invalidates the static preview",
    );
    assert(
      await page.evaluate((zoom) => window.__skinPerf.viewer.zoom > zoom, zoom),
    );
    await page.getByRole("button", { name: "缩小角色", exact: true }).click();
    await page
      .getByRole("button", { name: "重置观察角度", exact: true })
      .click();
    await settle();
    assert.equal(
      await page.evaluate(() => window.__skinPerf.viewer.zoom),
      0.74,
    );
    await page
      .getByRole("button", { name: "纤细 · 3 像素", exact: true })
      .click();
    await page.waitForFunction(
      () => window.__skinPerf.viewer.playerObject.skin.modelType === "slim",
    );
    await page
      .getByRole("button", { name: "经典 · 4 像素", exact: true })
      .click();
    await page.waitForFunction(
      () => window.__skinPerf.viewer.playerObject.skin.modelType === "default",
    );
    await page
      .getByRole("button", { name: "保存当前皮肤到库", exact: true })
      .click();
    await page.getByRole("dialog").waitFor();
    assert.equal(
      await page.getByRole("dialog").locator("input").first().inputValue(),
      "Steve",
    );
    await page
      .getByRole("button", { name: "关闭皮肤库窗口", exact: true })
      .click();
    await page
      .locator(".wardrobe-stage")
      .screenshot({ path: path.join(output, "efficient-wardrobe.png") });
    checks.push(
      "wardrobe defaults to zero idle draws; classic/slim, zoom/reset and saving Steve into the skin library remain available; previous viewer disposed on navigation",
    );

    await page.evaluate(async () => {
      const image = new Image();
      image.src = "/skins/steve.png";
      await image.decode();
      const skin = document.createElement("canvas");
      skin.width = skin.height = 64;
      const context = skin.getContext("2d");
      context.drawImage(image, 0, 0);
      context.fillStyle = "#ff0000";
      context.fillRect(8, 8, 1, 1);
      const cape = document.createElement("canvas");
      cape.width = 64;
      cape.height = 32;
      const capeContext = cape.getContext("2d");
      capeContext.fillStyle = "#3344ff";
      capeContext.fillRect(0, 0, 64, 32);
      const qa = window.__skinPerf;
      qa.state.accounts = [
        {
          id: "skin-perf",
          type: "microsoft",
          name: "CustomSkin",
          skins: [{ state: "ACTIVE", variant: "SLIM", url: skin.toDataURL() }],
          capes: [
            {
              id: "qa-cape",
              state: "ACTIVE",
              url: cape.toDataURL(),
              alias: "QA Cape",
            },
          ],
        },
      ];
      qa.state.selectedAccountId = "skin-perf";
      qa.emit();
    });
    await page.waitForFunction(
      () =>
        window.__skinPerf.viewer.playerObject.skin.modelType === "slim" &&
        window.__skinPerf.viewer.playerObject.cape.visible,
    );
    await settle();
    assert.equal(await countFrames(), 0);
    await page.evaluate(() => {
      window.__skinPerf.capture = true;
      window.__skinPerf.viewer.controls.dispatchEvent({ type: "change" });
    });
    await page.waitForFunction(() => !window.__skinPerf.capture);
    assert(await page.evaluate(() => window.__skinPerf.coloredPixels > 1000));
    await page.getByRole("button", { name: "图形编辑", exact: true }).click();
    const editor = page.getByLabel("可涂色编辑的皮肤像素画布", { exact: true });
    await editor.waitFor();
    await page.waitForFunction(
      () =>
        document
          .querySelector("canvas[aria-label='可涂色编辑的皮肤像素画布']")
          .getContext("2d")
          .getImageData(8, 8, 1, 1).data[0] === 255,
    );
    const brush = await page
      .getByLabel("画笔颜色", { exact: true })
      .inputValue();
    const editorBox = await editor.boundingBox();
    await editor.click({
      position: {
        x: (editorBox.width * 8.5) / 64,
        y: (editorBox.height * 8.5) / 64,
      },
    });
    const editDraws = await page.evaluate(() => window.__skinPerf.draws);
    await page.getByRole("button", { name: "应用到预览", exact: true }).click();
    await page.waitForFunction((brush) => {
      const pixel = window.__skinPerf.viewer.skinCanvas
        .getContext("2d")
        .getImageData(8, 8, 1, 1).data;
      return (
        Array.from(pixel.slice(0, 3))
          .map((value) => value.toString(16).padStart(2, "0"))
          .join("") === brush.slice(1).toLowerCase()
      );
    }, brush);
    await page.waitForFunction(
      (draws) => window.__skinPerf.draws > draws,
      editDraws,
    );
    checks.push(
      "pixel editor applies a changed UV pixel and invalidates the static 3D texture preview",
    );
    await page
      .getByRole("button", { name: "开启自动旋转", exact: true })
      .click();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    measurements.wardrobeRotationFrames = await countFrames();
    measurements.wardrobeRotationSample = lastSample;
    assert(
      measurements.wardrobeRotationFrames > 3 &&
        measurements.wardrobeRotationFrames <= lastSample.durationMs * 0.06 + 2,
      JSON.stringify({
        measurements,
        lifecycle: await page.evaluate(() => ({
          focused: document.hasFocus(),
          hidden: document.hidden,
          rotating: window.__skinPerf.viewer.autoRotate,
          disposed: window.__skinPerf.viewer.disposed,
          mode: document.documentElement.dataset.performance,
        })),
      }),
    );
    await dock.getByRole("button", { name: "开始游戏", exact: true }).click();
    await settle();
    assert(await page.evaluate(() => window.__skinPerf.viewers[1].disposed));
    const oldDraws = await page.evaluate(() => window.__skinPerf.draws);
    await page.waitForTimeout(650);
    assert.equal(
      await page.evaluate(() => window.__skinPerf.draws),
      oldDraws,
      "disposed wardrobe stops rendering",
    );
    checks.push(
      "custom account slim texture and cape render in efficient mode; explicit wardrobe rotation works and is disposed when navigating away",
    );
    assert.deepEqual(errors, []);
    const report = {
      passed: true,
      checks,
      measurements,
      pageErrors: errors,
      limitation:
        "Frontend fixtures and Edge software WebGL, DPR 2; lifecycle events are controlled simulations. No real account services, gameplay, physical low-end hardware or universal FPS guarantee.",
    };
    await fs.writeFile(
      path.join(output, "report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
