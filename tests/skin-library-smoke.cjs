const { _electron: electron } = require("playwright-core");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const zlib = require("node:zlib");

// Real renderer/preload/IPC/SkinLibrary, disk persistence and PNG files.
// Native file dialogs and the Microsoft AccountService.uploadSkin boundary are
// fixtures. No personal profile, credentials, remote upload or game is used.
(async () => {
  const root = path.resolve(__dirname, "..");
  const output = path.join(root, "release");
  await fs.mkdir(output, { recursive: true });
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "LDFCL-skin-library-qa-"),
  );
  const dataDir = path.join(dir, "data");
  const importFile = path.join(dir, "本地探险家.png");
  const exportFile = path.join(dir, "导出 皮肤.png");
  const executable =
    process.env.LDFCL_TEST_EXECUTABLE || process.env.LDFCL_TEST_EXE;
  const env = {
    ...process.env,
    LDFCL_DATA_DIR: dataDir,
    LDFCL_GAME_ROOT: path.join(dir, "minecraft"),
  };
  for (const key of [
    "ELECTRON_RUN_AS_NODE",
    "LDFCL_DEV_URL",
    "PORTABLE_EXECUTABLE_DIR",
    "PORTABLE_EXECUTABLE_FILE",
  ])
    delete env[key];
  const checks = [],
    screenshots = [],
    pageErrors = [];
  let app,
    page,
    passed = false;
  const hash = (data) => createHash("sha256").update(data).digest("hex");
  function fixturePng() {
    const crc = (buffer) => {
      let value = 0xffffffff;
      for (const byte of buffer) {
        value ^= byte;
        for (let bit = 0; bit < 8; bit++)
          value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
      }
      return (value ^ 0xffffffff) >>> 0;
    };
    const chunk = (name, data) => {
      const result = Buffer.alloc(data.length + 12);
      result.writeUInt32BE(data.length);
      result.write(name, 4);
      data.copy(result, 8);
      result.writeUInt32BE(crc(result.subarray(4, -4)), result.length - 4);
      return result;
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(64);
    header.writeUInt32BE(64, 4);
    header[8] = 8;
    header[9] = 6;
    const pixels = Buffer.alloc(64 * (64 * 4 + 1));
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
  const originalPng = fixturePng();
  await fs.writeFile(importFile, originalPng);
  const call = (method, payload) =>
    page.evaluate(
      ({ method, payload }) => window.launcher.call(method, payload),
      { method, payload },
    );
  const entries = () => call("skin-library:list");
  const qa = () =>
    app.evaluate(() => {
      const q = globalThis.__ldfclSkinLibraryQA;
      return {
        uploads: q.uploads,
        importCalls: q.importCalls,
        exportCalls: q.exportCalls,
        unexpectedNetwork: q.unexpectedNetwork,
      };
    });
  async function until(read, predicate, label, timeout = 15000) {
    const deadline = Date.now() + timeout;
    let value;
    do {
      value = await read();
      if (predicate(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 40));
    } while (Date.now() < deadline);
    assert.fail(`${label}: ${JSON.stringify(value)}`);
  }
  const library = () => page.locator(".skin-library");
  const card = (name) =>
    library()
      .locator("article.skin-library-card")
      .filter({
        has: page.getByRole("heading", { name, exact: true, level: 4 }),
      });
  const dialog = (name) => page.getByRole("dialog", { name, exact: true });
  async function openWardrobe() {
    await page
      .locator("aside.sidebar")
      .getByRole("button", { name: "皮肤与披风", exact: true })
      .click();
    await library().waitFor();
    await until(
      () =>
        library()
          .getByRole("button", { name: "收藏当前预览", exact: true })
          .isEnabled(),
      Boolean,
      "local library controls enabled",
    );
  }
  async function shot(name, target = page) {
    const file = path.join(output, `skin-library-${name}.png`);
    await target.screenshot({ path: file });
    screenshots.push(file);
  }
  async function launch() {
    app = await electron.launch({
      executablePath: executable || require("electron"),
      args: [
        ...(executable ? [] : [root]),
        `--user-data-dir=${path.join(dir, "isolated-electron-profile")}`,
      ],
      env,
      timeout: 45000,
    });
    page = await app.firstWindow();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page
      .getByRole("heading", { name: "开始游戏", exact: true })
      .waitFor();
    await app.evaluate(
      ({ app, dialog }, fixture) => {
        const paths = process.getBuiltinModule("path");
        const files = process.getBuiltinModule("fs/promises");
        const crypto = process.getBuiltinModule("crypto");
        const requireApp = process
          .getBuiltinModule("module")
          .createRequire(paths.join(app.getAppPath(), "package.json"));
        const { SkinLibrary } = requireApp(
          "./dist-electron/electron/services/skin-library.js",
        );
        const { AccountService } = requireApp(
          "./dist-electron/electron/services/accounts.js",
        );
        const q = (globalThis.__ldfclSkinLibraryQA = {
          signedIn: false,
          failListOnce: false,
          failSaveOnce: false,
          failUploadOnce: false,
          uploads: [],
          importCalls: [],
          exportCalls: [],
          exportPath: fixture.exportFile,
          unexpectedNetwork: [],
          originalList: SkinLibrary.prototype.list,
          originalSave: SkinLibrary.prototype.save,
          originalAccountList: AccountService.prototype.list,
          originalProfile: AccountService.prototype.profile,
          originalUpload: AccountService.prototype.uploadSkin,
          originalOpen: dialog.showOpenDialog,
          originalSaveDialog: dialog.showSaveDialog,
          originalFetch: globalThis.fetch,
          profile: {
            id: "00000000000000000000000000000004",
            name: "Library_QA",
            editable: true,
            skins: [],
            capes: [],
          },
        });
        globalThis.fetch = async (input) => {
          const url =
            typeof input === "string" ? input : input.url || String(input);
          if (
            url ===
            "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"
          )
            return new Response(
              JSON.stringify({
                latest: { release: "1.21.1", snapshot: "1.21.1" },
                versions: [],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          q.unexpectedNetwork.push(url);
          throw new Error(`Unexpected skin-library QA network request: ${url}`);
        };
        SkinLibrary.prototype.list = async function () {
          if (q.failListOnce) {
            q.failListOnce = false;
            throw new Error("受控读取失败，请重试皮肤库");
          }
          return q.originalList.call(this);
        };
        SkinLibrary.prototype.save = async function (input) {
          if (q.failSaveOnce) {
            q.failSaveOnce = false;
            throw new Error("受控本地保存失败，请重试");
          }
          return q.originalSave.call(this, input);
        };
        dialog.showOpenDialog = async (...args) => {
          q.importCalls.push(args.at(-1)?.title);
          return { canceled: false, filePaths: [fixture.importFile] };
        };
        dialog.showSaveDialog = async (...args) => {
          q.exportCalls.push(args.at(-1)?.title);
          return { canceled: false, filePath: q.exportPath };
        };
        AccountService.prototype.list = async function () {
          return q.signedIn
            ? [
                {
                  id: "skin-library-microsoft-qa",
                  type: "microsoft",
                  name: "Library_QA",
                  uuid: q.profile.id,
                },
              ]
            : q.originalAccountList.call(this);
        };
        AccountService.prototype.profile = async function (id) {
          if (id === "skin-library-microsoft-qa") return q.profile;
          return q.originalProfile.call(this, id);
        };
        AccountService.prototype.uploadSkin = async function (
          id,
          file,
          variant,
        ) {
          if (id !== "skin-library-microsoft-qa")
            throw new Error("Unexpected upload account");
          const data = await files.readFile(file);
          q.uploads.push({
            id,
            variant,
            file,
            sha256: crypto.createHash("sha256").update(data).digest("hex"),
          });
          if (q.failUploadOnce) {
            q.failUploadOnce = false;
            throw new Error("受控正版应用失败，请重试");
          }
          q.profile = {
            ...q.profile,
            skins: [
              {
                id: "qa-active",
                state: "ACTIVE",
                variant: variant.toUpperCase(),
                url: `data:image/png;base64,${data.toString("base64")}`,
              },
            ],
          };
          return q.profile;
        };
      },
      { importFile, exportFile },
    );
  }
  async function closeApp() {
    if (!app) return;
    await app.close();
    app = undefined;
    page = undefined;
  }
  try {
    await launch();
    assert.deepEqual((await call("state")).accounts, []);
    await app.evaluate(() => {
      globalThis.__ldfclSkinLibraryQA.failListOnce = true;
    });
    await page
      .locator("aside.sidebar")
      .getByRole("button", { name: "皮肤与披风", exact: true })
      .click();
    await library()
      .getByRole("alert")
      .filter({ hasText: "受控读取失败" })
      .waitFor();
    await library()
      .getByRole("button", { name: "重新加载", exact: true })
      .click();
    await library()
      .getByText("你的皮肤收藏，从这里开始", { exact: true })
      .waitFor();
    checks.push(
      "Without accounts, a library read error is visible and retry loads the real empty local library",
    );

    await library()
      .getByRole("button", { name: "收藏当前预览", exact: true })
      .click();
    await dialog("保存到皮肤库").waitFor();
    await dialog("保存到皮肤库")
      .getByLabel("皮肤名称", { exact: true })
      .fill("示例收藏 QA");
    await app.evaluate(() => {
      globalThis.__ldfclSkinLibraryQA.failSaveOnce = true;
    });
    await dialog("保存到皮肤库")
      .getByRole("button", { name: "保存", exact: true })
      .click();
    await dialog("保存到皮肤库")
      .getByRole("alert")
      .filter({ hasText: "受控本地保存失败" })
      .waitFor();
    assert.equal((await entries()).length, 0);
    await dialog("保存到皮肤库")
      .getByRole("button", { name: "保存", exact: true })
      .click();
    await dialog("保存到皮肤库").waitFor({ state: "detached" });
    await card("示例收藏 QA").waitFor();
    let saved = await entries();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].variant, "classic");
    checks.push(
      "Current example preview saves through real IPC/disk without an account; a failed save stays in the name dialog and can be retried",
    );

    await page
      .getByRole("button", { name: "纤细 · 3 像素", exact: true })
      .click();
    await library()
      .getByRole("button", { name: "添加本地皮肤", exact: true })
      .click();
    await card("本地探险家").waitFor();
    saved = await entries();
    const imported = saved.find((entry) => entry.name === "本地探险家");
    assert(imported);
    assert.equal(imported.variant, "slim");
    assert.equal(
      hash(Buffer.from(imported.dataUrl.split(",")[1], "base64")),
      hash(originalPng),
    );
    assert.equal(
      await card("本地探险家")
        .getByRole("button", { name: "预览皮肤 本地探险家", exact: true })
        .getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(
      await page.locator(".wardrobe-texture img").getAttribute("src"),
      imported.dataUrl,
    );
    assert.match(
      await page
        .getByRole("button", { name: "纤细 · 3 像素", exact: true })
        .getAttribute("class"),
      /active/,
    );
    assert(
      await card("本地探险家")
        .getByRole("button", { name: "应用至正版账号", exact: true })
        .isDisabled(),
    );
    assert.equal((await qa()).uploads.length, 0);
    await page
      .locator(".wardrobe-stage")
      .screenshot({ path: path.join(output, "skin-library-3d-preview.png") });
    screenshots.push(path.join(output, "skin-library-3d-preview.png"));
    checks.push(
      "Local PNG imports byte-for-byte with the selected slim model, selects the main 3D preview, and never uploads while unsigned",
    );

    await page.getByRole("button", { name: "图形编辑", exact: true }).click();
    const editor = dialog("皮肤像素编辑器");
    await editor.waitFor();
    const pixels = editor.locator("canvas");
    await until(
      () =>
        pixels.evaluate((canvas) =>
          Array.from(canvas.getContext("2d").getImageData(10, 10, 1, 1).data),
        ),
      (value) => value[3] > 0,
      "editor texture loaded",
    );
    const before = await pixels.evaluate((canvas) =>
      canvas.toDataURL("image/png"),
    );
    const bounds = await pixels.boundingBox();
    await page.mouse.click(
      bounds.x + (10.5 / 64) * bounds.width,
      bounds.y + (10.5 / 64) * bounds.height,
    );
    const edited = await pixels.evaluate((canvas) =>
      canvas.toDataURL("image/png"),
    );
    assert.notEqual(edited, before);
    await editor
      .getByRole("button", { name: "保存到皮肤库", exact: true })
      .click();
    await dialog("保存到皮肤库")
      .getByLabel("皮肤名称", { exact: true })
      .fill("像素编辑收藏 QA");
    await dialog("保存到皮肤库")
      .getByRole("button", { name: "保存", exact: true })
      .click();
    await dialog("保存到皮肤库").waitFor({ state: "detached" });
    await editor
      .getByRole("button", { name: "关闭编辑器", exact: true })
      .click();
    await card("像素编辑收藏 QA").waitFor();
    const editedEntry = (await entries()).find(
      (entry) => entry.name === "像素编辑收藏 QA",
    );
    assert(editedEntry);
    assert.equal(editedEntry.dataUrl, edited);
    assert.equal(editedEntry.variant, "slim");
    assert.equal((await qa()).uploads.length, 0);
    checks.push(
      "A real pointer stroke changes the pixel canvas; saving the edit stores those exact PNG bytes/model without uploading",
    );

    await card("像素编辑收藏 QA")
      .getByRole("button", { name: "预览皮肤 像素编辑收藏 QA", exact: true })
      .click();
    await card("像素编辑收藏 QA")
      .getByRole("button", { name: "重命名皮肤 像素编辑收藏 QA", exact: true })
      .click();
    await dialog("重命名皮肤")
      .getByLabel("皮肤名称", { exact: true })
      .fill("我的像素旅人 QA");
    await dialog("重命名皮肤")
      .getByRole("button", { name: "保存", exact: true })
      .click();
    await dialog("重命名皮肤").waitFor({ state: "detached" });
    assert.equal(
      await page.locator(".wardrobe-texture strong").textContent(),
      "我的像素旅人 QA",
      "renaming the selected skin updates the main preview title",
    );
    await card("我的像素旅人 QA")
      .getByRole("button", { name: "导出皮肤 我的像素旅人 QA", exact: true })
      .click();
    await until(
      () => fs.readFile(exportFile).catch(() => null),
      Boolean,
      "exported PNG exists",
    );
    assert.equal(
      hash(await fs.readFile(exportFile)),
      hash(Buffer.from(edited.split(",")[1], "base64")),
    );
    const indexFile = path.join(dataDir, "skins", "index.json");
    const indexBeforeUnsafeExport = await fs.readFile(indexFile);
    const entriesBeforeUnsafeExport = await entries();
    await app.evaluate((_electron, file) => {
      globalThis.__ldfclSkinLibraryQA.exportPath = file;
    }, indexFile);
    await card("我的像素旅人 QA")
      .getByRole("button", { name: "导出皮肤 我的像素旅人 QA", exact: true })
      .click();
    await library()
      .getByRole("alert")
      .filter({ hasText: /皮肤库/ })
      .waitFor();
    assert.deepEqual(await fs.readFile(indexFile), indexBeforeUnsafeExport);
    assert.deepEqual(await entries(), entriesBeforeUnsafeExport);
    await app.evaluate((_electron, file) => {
      globalThis.__ldfclSkinLibraryQA.exportPath = file;
    }, exportFile);
    checks.push(
      "Exporting onto the existing library index is rejected and leaves every metadata/PNG entry intact",
    );
    await card("示例收藏 QA")
      .getByRole("button", { name: "删除皮肤 示例收藏 QA", exact: true })
      .click();
    await dialog("删除收藏皮肤")
      .getByRole("button", { name: "取消", exact: true })
      .click();
    assert.equal((await entries()).length, 3);
    await card("示例收藏 QA")
      .getByRole("button", { name: "删除皮肤 示例收藏 QA", exact: true })
      .click();
    await dialog("删除收藏皮肤")
      .getByRole("button", { name: "删除", exact: true })
      .click();
    await dialog("删除收藏皮肤").waitFor({ state: "detached" });
    await until(
      entries,
      (list) => list.length === 2,
      "deleted local entry removed",
    );
    assert.equal(
      hash(await fs.readFile(exportFile)),
      hash(Buffer.from(edited.split(",")[1], "base64")),
    );
    assert.equal((await qa()).uploads.length, 0);
    checks.push(
      "Rename persists, export matches edited PNG bytes, delete can be cancelled, and confirmed deletion preserves exported files; none invokes upload",
    );

    const window = await app.browserWindow(page);
    await window.evaluate((win) => win.setSize(960, 720));
    await until(
      () => page.evaluate(() => innerWidth),
      (width) => width === 960,
      "small window width",
    );
    await library().scrollIntoViewIfNeeded();
    const overflow = await library().evaluate((element) => ({
      content: element.scrollWidth,
      client: element.clientWidth,
    }));
    assert(overflow.content <= overflow.client + 1, JSON.stringify(overflow));
    await card("我的像素旅人 QA")
      .getByRole("button", { name: "导出皮肤 我的像素旅人 QA", exact: true })
      .scrollIntoViewIfNeeded();
    await shot("960-local-library");
    checks.push(
      "At 960 px window width the library grid does not overflow and card actions remain reachable",
    );

    await app.evaluate(() => {
      globalThis.__ldfclSkinLibraryQA.signedIn = true;
    });
    await page.reload();
    await page
      .getByRole("heading", { name: "开始游戏", exact: true })
      .waitFor();
    await openWardrobe();
    assert.equal((await call("state")).accounts[0].type, "microsoft");
    await card("我的像素旅人 QA")
      .getByRole("button", { name: "预览皮肤 我的像素旅人 QA", exact: true })
      .click();
    assert.equal(
      (await qa()).uploads.length,
      0,
      "preview with Microsoft account must still not upload",
    );
    await app.evaluate(() => {
      globalThis.__ldfclSkinLibraryQA.failUploadOnce = true;
    });
    const apply = () =>
      card("我的像素旅人 QA").getByRole("button", {
        name: "应用至正版账号",
        exact: true,
      });
    await apply().click();
    await library()
      .getByRole("alert")
      .filter({ hasText: "受控正版应用失败" })
      .waitFor();
    assert.equal((await qa()).uploads.length, 1);
    await until(() => apply().isEnabled(), Boolean, "apply retry unlocked");
    await apply().click();
    await until(
      qa,
      (q) => q.uploads.length === 2,
      "explicit apply retries reached the upload service boundary",
    );
    await until(() => apply().isEnabled(), Boolean, "apply completed");
    const afterApply = await qa();
    assert(
      afterApply.uploads.every(
        (upload) =>
          upload.id === "skin-library-microsoft-qa" &&
          upload.variant === "slim" &&
          upload.sha256 === hash(Buffer.from(edited.split(",")[1], "base64")),
      ),
    );
    assert.equal(afterApply.importCalls.length, 1);
    assert.equal(afterApply.exportCalls.length, 2);
    assert.deepEqual(afterApply.unexpectedNetwork, []);
    await shot("explicit-account-apply");
    checks.push(
      "With a synthetic signed-in Microsoft profile, only clicking Apply reaches AccountService.uploadSkin; failure stays visible, retry sends exact stored bytes/model to the selected account",
    );

    const beforeRestart = (await entries())
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        variant: entry.variant,
        dataUrl: entry.dataUrl,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    await closeApp();
    await launch();
    await openWardrobe();
    const afterRestart = (await entries())
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        variant: entry.variant,
        dataUrl: entry.dataUrl,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(afterRestart, beforeRestart);
    assert.deepEqual((await call("state")).accounts, []);
    await card("我的像素旅人 QA")
      .getByRole("button", { name: "预览皮肤 我的像素旅人 QA", exact: true })
      .click();
    assert.equal(
      await page.locator(".wardrobe-texture img").getAttribute("src"),
      edited,
    );
    assert.match(
      await page
        .getByRole("button", { name: "纤细 · 3 像素", exact: true })
        .getAttribute("class"),
      /active/,
    );
    assert.deepEqual((await qa()).uploads, []);
    await library().scrollIntoViewIfNeeded();
    await shot("persisted-after-restart");
    checks.push(
      "An actual process restart retains names, IDs, models, PNG bytes and deletion; the library still previews skins with no account",
    );
    assert.deepEqual(pageErrors, []);
    passed = true;
    const result = {
      passed,
      checks,
      screenshots,
      pageErrors,
      boundaries:
        "Microsoft profile/upload and native dialogs were fixtures; local renderer, IPC, validation, library persistence and exported bytes were real.",
    };
    await fs.writeFile(
      path.join(output, "skin-library-smoke.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
  } finally {
    if (!passed && page)
      await page
        .screenshot({ path: path.join(output, "skin-library-failure.png") })
        .catch(() => {});
    await closeApp().catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
