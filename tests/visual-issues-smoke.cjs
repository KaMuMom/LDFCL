const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright-core");

// Frontend-only fixtures: no account tokens, real services, game directories or
// Electron profile are used. The actual React, upstream glass and WebGL render.
(async () => {
  const root = path.resolve(__dirname, "..");
  const output = path.join(root, "test-results", "visual-issues");
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
  const errors = [];
  const screenshots = [];
  let browser;
  try {
    await server.listen();
    const address = server.httpServer.address();
    browser = await chromium.launch({
      executablePath:
        process.env.LDFCL_TEST_BROWSER ||
        "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      headless: true,
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    });
    const page = await browser.newPage({
      viewport: { width: 1120, height: 760 },
    });
    async function comparePixels(before, after, label) {
      const difference = await page.evaluate(
        async ({ before, after }) => {
          const read = async (source) => {
            const image = new Image();
            image.src = `data:image/png;base64,${source}`;
            await image.decode();
            const canvas = document.createElement("canvas");
            canvas.width = image.width;
            canvas.height = image.height;
            const context = canvas.getContext("2d");
            context.drawImage(image, 0, 0);
            return context.getImageData(0, 0, image.width, image.height).data;
          };
          const [a, b] = await Promise.all([read(before), read(after)]);
          let max = 0,
            sum = 0,
            changed = 0,
            strongChanged = 0;
          for (let index = 0; index < a.length; index += 4) {
            let pixel = 0;
            for (let channel = 0; channel < 3; channel++) {
              const delta = Math.abs(a[index + channel] - b[index + channel]);
              max = Math.max(max, delta);
              sum += delta;
              pixel = Math.max(pixel, delta);
            }
            if (pixel) changed++;
            if (pixel > 2) strongChanged++;
          }
          return {
            max,
            mean: sum / ((a.length / 4) * 3),
            changed,
            strongChanged,
          };
        },
        { before: before.toString("base64"), after: after.toString("base64") },
      );
      // Compositor rounding is either <=2/255 across a translucent surface or
      // a handful of antialiased corner pixels. Reject stronger regional changes.
      assert(
        difference.max <= 8 &&
          difference.strongChanged <= 32 &&
          difference.mean < 0.15,
        `${label}: ${JSON.stringify(difference)}`,
      );
    }
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) =>
      new URL(route.request().url()).hostname === "127.0.0.1"
        ? route.continue()
        : route.abort(),
    );
    await page.addInitScript(() => {
      const listeners = new Set();
      const state = {
        gameDirectories: [],
        instances: [],
        accounts: [
          { id: "visual-fixture", name: "Visual_QA", type: "microsoft" },
        ],
        selectedAccountId: "visual-fixture",
        settings: {
          theme: "light",
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
          platform: "Windows · x64",
          version: "visual-qa",
          dataDir: "fixture-only",
          gameRoot: "fixture-only",
          defaultGameRoot: "fixture-only",
        },
      };
      const qa = (window.__visualQa = {
        profileCalls: 0,
        unexpectedCalls: [],
        failProfile: false,
        state,
        theme(value) {
          state.settings.theme = value;
          for (const listener of listeners) listener({ type: "state" });
        },
      });
      window.launcher = {
        async call(method) {
          if (method === "state") return structuredClone(state);
          if (method === "skin:profile") {
            qa.profileCalls++;
            if (qa.failProfile)
              throw new Error("QA profile temporarily unavailable");
            return { skins: [], capes: [], editable: false };
          }
          if (method === "versions") return [{ id: "1.21.1", type: "release" }];
          if (method === "skin-library:list" || method === "mod-favorites:list")
            return [];
          if (method === "content:search")
            return {
              total_hits: 2,
              hits: ["Aurora", "Forest"].map((title, index) => ({
                project_id: `visual-project-${index}`,
                slug: `visual-project-${index}`,
                title: `${title} QA resource pack`,
                description: "Local visual regression fixture",
                author: "LDFCL QA",
                categories: [],
                downloads: 1000,
              })),
            };
          qa.unexpectedCalls.push(method);
          throw new Error(`Unexpected QA call: ${method}`);
        },
        onEvent(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    });
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page
      .getByRole("heading", { name: "开始游戏", exact: true })
      .waitFor();
    await page.waitForFunction(() => window.__visualQa.profileCalls > 0);

    const texture = await page.evaluate(async () => {
      const { defaultSkinTexture } = await import("/shared/default-skin.ts");
      const image = new Image();
      image.src = defaultSkinTexture();
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 64;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, 64, 64).data;
      const region = (x, y, width, height) => {
        const values = [];
        for (let row = y; row < y + height; row++)
          for (let col = x; col < x + width; col++) {
            const index = (row * 64 + col) * 4;
            values.push(Array.from(pixels.slice(index, index + 4)));
          }
        return values;
      };
      return {
        dataUrl: canvas.toDataURL("image/png"),
        sourceUrl: image.src,
        top: region(8, 0, 8, 8),
        bottom: region(16, 0, 8, 8),
        right: region(0, 8, 8, 8),
        front: region(8, 8, 8, 8),
        left: region(16, 8, 8, 8),
        back: region(24, 8, 8, 8),
        outerHead: region(32, 0, 32, 16),
      };
    });
    for (const face of ["top", "bottom", "right", "front", "left", "back"])
      assert(
        texture[face].every((pixel) => pixel[3] === 255),
        `${face} has a hole`,
      );
    assert.match(
      texture.sourceUrl,
      /\/skins\/steve\.png$/,
      "default skin is the bundled Steve template",
    );
    assert(
      texture.outerHead.every((pixel) => pixel[3] === 0),
      "unused outer head layer stays transparent",
    );
    await fs.writeFile(
      path.join(output, "default-skin-64x64.png"),
      Buffer.from(texture.dataUrl.split(",")[1], "base64"),
    );
    checks.push(
      "bundled official Steve PNG: six opaque head faces and transparent outer layer",
    );

    const initialCalls = await page.evaluate(
      () => window.__visualQa.profileCalls,
    );
    const rotate = page.getByRole("button", {
      name: "开启自动旋转",
      exact: true,
    });
    assert(
      await rotate.locator("svg.lucide-play").count(),
      "rotation uses a play icon",
    );
    await rotate.click();
    const pause = page.getByRole("button", {
      name: "暂停自动旋转",
      exact: true,
    });
    assert.equal(await pause.getAttribute("aria-pressed"), "true");
    await pause.click();
    assert.equal(
      await page.evaluate(() => window.__visualQa.profileCalls),
      initialCalls,
    );
    await page
      .getByRole("button", { name: "刷新角色外观", exact: true })
      .click();
    await page.waitForFunction(
      (calls) => window.__visualQa.profileCalls === calls + 1,
      initialCalls,
    );
    await page
      .getByRole("button", { name: "刷新角色外观", exact: true })
      .waitFor();
    await page.evaluate(() => {
      window.__visualQa.failProfile = true;
    });
    await page
      .getByRole("button", { name: "刷新角色外观", exact: true })
      .click();
    await page
      .getByText("QA profile temporarily unavailable", { exact: true })
      .waitFor();
    await page.getByRole("button", { name: "关闭提示", exact: true }).click();
    await page.evaluate(() => {
      window.__visualQa.failProfile = false;
    });
    assert.equal(
      await page
        .getByRole("button", { name: "刷新角色外观", exact: true })
        .isEnabled(),
      true,
    );
    checks.push(
      "rotation play/pause does not refresh; dedicated refresh re-queries profile and recovers after failure",
    );

    const homeCanvas = page.getByLabel("首页角色皮肤预览", { exact: true });
    const canvasBox = await homeCanvas.boundingBox();
    for (const [index, dx, dy] of [
      [0, 0, 0],
      [1, 100, 0],
      [2, 100, 0],
      [3, 60, 70],
    ]) {
      if (dx || dy) {
        await page.mouse.move(
          canvasBox.x + canvasBox.width / 2,
          canvasBox.y + canvasBox.height / 2,
        );
        await page.mouse.down();
        await page.mouse.move(
          canvasBox.x + canvasBox.width / 2 + dx,
          canvasBox.y + canvasBox.height / 2 + dy,
          { steps: 15 },
        );
        await page.mouse.up();
      }
      await page.waitForTimeout(250);
      const file = path.join(output, `default-character-angle-${index}.png`);
      await page.locator(".home-skin-panel").screenshot({ path: file });
      screenshots.push(file);
    }
    checks.push(
      "actual WebGL default character renders after horizontal and vertical orbit drags",
    );

    const dock = page.locator("aside.sidebar");
    await dock.getByRole("button", { name: "皮肤与披风", exact: true }).click();
    await page
      .getByLabel("可拖拽旋转的 Minecraft 角色三维预览", { exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "暂停自动旋转", exact: true })
      .click();
    const wardrobeFile = path.join(output, "default-character-wardrobe.png");
    await page.locator(".wardrobe-stage").screenshot({ path: wardrobeFile });
    screenshots.push(wardrobeFile);
    await dock.getByRole("button", { name: "资源下载", exact: true }).click();
    await page.getByRole("tab", { name: "资源包", exact: true }).click();
    await page.getByText("Aurora QA resource pack", { exact: true }).waitFor();

    for (const [width, height] of [
      [1120, 760],
      [960, 640],
    ]) {
      await page.setViewportSize({ width, height });
      for (const theme of ["light", "dark"]) {
        await page.evaluate((value) => window.__visualQa.theme(value), theme);
        await page.waitForFunction(
          (value) => document.documentElement.dataset.theme === value,
          theme,
        );
        await page.mouse.move(width - 4, height - 4);
        await page.waitForTimeout(300);
        const layers = await page
          .locator(".glass-backdrop")
          .evaluateAll((elements) =>
            elements
              .filter((element) => element.getBoundingClientRect().width > 0)
              .map((element) => {
                const css = getComputedStyle(element);
                return {
                  paintContained: css.contain.includes("paint"),
                  isolated: css.isolation === "isolate",
                  clipped: css.clipPath !== "none",
                  inert: element.inert,
                  extraShadowsHidden: Array.from(element.children)
                    .filter(
                      (child) => !child.classList.contains("liquid-renderer"),
                    )
                    .every(
                      (child) => getComputedStyle(child).display === "none",
                    ),
                  actualGlass: !!element.querySelector(
                    ".liquid-renderer .glass__warp[style*='filter']",
                  ),
                };
              }),
          );
        assert(layers.length >= 4);
        assert(
          layers.every((layer) => Object.values(layer).every(Boolean)),
          JSON.stringify(layers),
        );
        const clip = {
          x: width / 2,
          y: 100,
          width: width / 2 - 18,
          height: Math.min(420, height - 120),
        };
        const baseline = await page.screenshot({
          clip,
          animations: "disabled",
        });
        for (const name of ["皮肤与披风", "下载任务", "开始游戏"]) {
          const button = dock.getByRole("button", { name, exact: true });
          const box = await button.boundingBox();
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(220);
          const hovered = await page.screenshot({
            clip,
            animations: "disabled",
          });
          await fs.writeFile(
            path.join(output, `compare-${width}-${theme}-baseline.png`),
            baseline,
          );
          await fs.writeFile(
            path.join(output, `compare-${width}-${theme}-hover.png`),
            hovered,
          );
          await comparePixels(
            baseline,
            hovered,
            `${name} hover changes resource content`,
          );
          await page.mouse.down();
          await page.waitForTimeout(220);
          const file = path.join(output, `glass-${width}-${theme}-${name}.png`);
          await page.screenshot({ path: file, animations: "disabled" });
          screenshots.push(file);
          const pressed = await page.screenshot({
            clip,
            animations: "disabled",
          });
          await comparePixels(
            baseline,
            pressed,
            `${name} press changes resource content`,
          );
          await page.mouse.move(width - 4, height - 4);
          await page.mouse.up();
        }
        checks.push(
          `${width}x${height} ${theme}: isolated real glass; three sidebar hover/hold/drag-away states preserve right resource pixels within compositor rounding tolerance`,
        );
      }
    }
    assert.deepEqual(
      await page.evaluate(() => window.__visualQa.unexpectedCalls),
      [],
    );
    assert.deepEqual(errors, []);
    const report = {
      passed: true,
      checks,
      screenshots,
      pageErrors: errors,
      limitation:
        "Frontend fixture with software WebGL; real account APIs and hardware GPU compositing were not exercised.",
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
