const { _electron: electron } = require("playwright-core");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");

// Real renderer / IPC / account service; Microsoft, Xbox and Minecraft responses
// are controlled in Electron's main process. No real account or browser is used.
(async () => {
  const root = path.resolve(__dirname, "..");
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "LDFCL-device-login-qa-"),
  );
  const output = path.join(root, "test-results");
  await fs.mkdir(output, { recursive: true });
  const clientId = "11111111-2222-3333-4444-555555555555";
  const executable =
    process.env.LDFCL_TEST_EXECUTABLE || process.env.LDFCL_TEST_EXE;
  const env = { ...process.env, LDFCL_DATA_DIR: dir };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    executablePath: executable || require("electron"),
    args: executable ? [] : [root],
    env,
    timeout: 45000,
  });
  const errors = [];
  const checks = [];
  let page;
  try {
    page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await page
      .getByRole("heading", { name: "开始游戏", exact: true })
      .waitFor();
    await app.evaluate(({ shell, clipboard, BrowserWindow, ipcMain }) => {
      const qa = (globalThis.__ldfclDeviceQA = {
        mode: "pending",
        challenges: 0,
        polls: 0,
        aborted: 0,
        opened: [],
        copies: [],
        timeline: [],
        failClipboard: false,
        dispatchPayloads: [],
        settingsPayloads: [],
        grants: [],
        focus: 0,
        show: 0,
        restore: 0,
        holdSettings: false,
        settingsHeld: false,
        settingsReleased: false,
        holdExternal: false,
        clipboardText: clipboard.readText(),
        originalFetch: globalThis.fetch,
        originalExternal: shell.openExternal,
        originalClipboardWrite: clipboard.writeText,
      });
      clipboard.writeText = (text, ...args) => {
        qa.copies.push(text);
        qa.timeline.push({ kind: "copy", text });
        if (qa.failClipboard) throw Error("controlled clipboard failure");
        return qa.originalClipboardWrite.call(clipboard, text, ...args);
      };
      const originalIPC = ipcMain._invokeHandlers.get("launcher:call");
      if (typeof originalIPC !== "function")
        throw Error("Launcher IPC handler missing");
      ipcMain.removeHandler("launcher:call");
      ipcMain.handle("launcher:call", async (event, method, payload) => {
        if (method === "account:microsoft")
          qa.dispatchPayloads.push(payload ?? null);
        if (method === "settings") qa.settingsPayloads.push(payload);
        return originalIPC(event, method, payload);
      });
      const files = process.getBuiltinModule("fs/promises");
      qa.originalWriteFile = files.writeFile;
      files.writeFile = async (...args) => {
        if (qa.holdSettings && String(args[0]).endsWith("launcher.json.tmp")) {
          qa.holdSettings = false;
          qa.settingsHeld = true;
          await new Promise((resolve) => {
            qa.releaseSettings = resolve;
          });
          const result = await qa.originalWriteFile(...args);
          qa.settingsReleased = true;
          return result;
        }
        return qa.originalWriteFile(...args);
      };
      const window = BrowserWindow.getAllWindows()[0];
      for (const action of ["focus", "show", "restore"]) {
        const original = window[action].bind(window);
        window[action] = (...args) => {
          qa[action]++;
          return original(...args);
        };
      }
      const json = (body, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      const heldRequest = (signal) =>
        new Promise((_resolve, reject) => {
          const cancel = () => {
            clearTimeout(timer);
            qa.aborted++;
            reject(new DOMException("Controlled cancellation", "AbortError"));
          };
          const timer = setTimeout(() => {
            signal?.removeEventListener("abort", cancel);
            reject(new Error("controlled held request timed out"));
          }, 15000);
          if (signal?.aborted) cancel();
          else signal?.addEventListener("abort", cancel, { once: true });
        });
      globalThis.fetch = async (input, init = {}) => {
        const url = String(input);
        if (url.endsWith("/devicecode")) {
          qa.challenges++;
          if (qa.mode === "challenge-network")
            throw new Error("controlled device challenge network failure");
          const form = new URLSearchParams(String(init.body));
          qa.grants.push({
            kind: "devicecode",
            clientId: form.get("client_id"),
            hasSecret: form.has("client_secret"),
          });
          if (qa.mode === "challenge-hold") return heldRequest(init.signal);
          const challenge = {
            device_code: `fixture-private-device-code-${qa.challenges}`,
            user_code: "ABCD-EFGH",
            verification_uri: "https://microsoft.com/devicelogin",
            expires_in: 600,
            interval: 1,
          };
          if (qa.mode === "challenge-late")
            return new Promise((resolve) => {
              qa.releaseChallenge = () => resolve(json(challenge));
            });
          return json(challenge);
        }
        if (url.endsWith("/token")) {
          qa.polls++;
          const form = new URLSearchParams(String(init.body));
          qa.grants.push({
            kind: "token",
            grantType: form.get("grant_type"),
            hasPrivateCode: /^fixture-private-device-code-\d+$/.test(
              form.get("device_code") || "",
            ),
            hasSecret: form.has("client_secret"),
          });
          if (qa.mode === "hold") return heldRequest(init.signal);
          if (qa.mode === "token-network")
            throw new Error("controlled token network failure");
          if (qa.mode === "token-certificate") {
            const cause = new Error("controlled certificate failure");
            cause.code = "UNABLE_TO_GET_ISSUER_CERT_LOCALLY";
            throw new TypeError("fetch failed", { cause });
          }
          if (qa.mode === "denied")
            return json({ error: "authorization_declined" }, 400);
          if (qa.mode === "success")
            return json({
              access_token: "fixture-microsoft-access-token",
              refresh_token: "fixture-microsoft-refresh-token",
              expires_in: 3600,
            });
          return json({ error: "authorization_pending" }, 400);
        }
        if (url === "https://user.auth.xboxlive.com/user/authenticate")
          return json({
            Token: "fixture-xbl-token",
            DisplayClaims: { xui: [{ uhs: "fixture-user-hash" }] },
          });
        if (url === "https://xsts.auth.xboxlive.com/xsts/authorize")
          return json({
            Token: "fixture-xsts-token",
            DisplayClaims: { xui: [{ uhs: "fixture-user-hash" }] },
          });
        if (url.endsWith("/authentication/login_with_xbox"))
          return json({
            access_token: "fixture-minecraft-access-token",
            expires_in: 86400,
          });
        if (url.endsWith("/entitlements/mcstore"))
          return json({ items: [{ name: "game_minecraft" }] });
        if (url.endsWith("/minecraft/profile"))
          return json({
            id: "0123456789abcdef0123456789abcdef",
            name: "Device_QA",
            skins: [],
            capes: [],
          });
        throw new Error(`Unexpected fixture network request: ${url}`);
      };
      shell.openExternal = async (url) => {
        qa.opened.push(url);
        qa.timeline.push({ kind: "browser", url });
        if (qa.holdExternal) {
          qa.holdExternal = false;
          return new Promise((_resolve, reject) => {
            qa.rejectExternal = reject;
          });
        }
      };
    });
    await page.evaluate(() => {
      window.__deviceAuthEvents = [];
      window.launcher.onEvent((event) => {
        if (event.type === "auth-status") window.__deviceAuthEvents.push(event);
      });
    });

    const button = (name) => page.getByRole("button", { name, exact: true });
    const mainState = () =>
      app.evaluate(() => {
        const qa = globalThis.__ldfclDeviceQA;
        return {
          mode: qa.mode,
          polls: qa.polls,
          aborted: qa.aborted,
          challenges: qa.challenges,
          opened: qa.opened,
          copies: qa.copies,
          timeline: qa.timeline,
          dispatchPayloads: qa.dispatchPayloads,
          settingsPayloads: qa.settingsPayloads,
          grants: qa.grants,
          focus: qa.focus,
          show: qa.show,
          restore: qa.restore,
          settingsHeld: qa.settingsHeld,
          settingsReleased: qa.settingsReleased,
        };
      });
    const setMode = (mode) =>
      app.evaluate((_electron, value) => {
        globalThis.__ldfclDeviceQA.mode = value;
      }, mode);
    const waitForMain = async (predicate, label, timeout = 8000) => {
      const deadline = Date.now() + timeout;
      do {
        const state = await mainState();
        if (predicate(state)) return state;
        await page.waitForTimeout(100);
      } while (Date.now() < deadline);
      assert.fail(`${label}: ${JSON.stringify(await mainState())}`);
    };
    const waitForState = async (predicate, label, timeout = 10000) => {
      const deadline = Date.now() + timeout;
      let last;
      do {
        last = await page.evaluate(() => window.launcher.call("state"));
        if (predicate(last)) return last;
        await new Promise((resolve) => setTimeout(resolve, 25));
      } while (Date.now() < deadline);
      assert.fail(`${label}: ${JSON.stringify(last)}`);
    };
    const openAccount = async () => {
      await button("管理账号").click();
      await page.getByRole("dialog", { name: "你的冒险身份" }).waitFor();
      await button("正版登录").click();
      const field = page.getByLabel("Microsoft 应用 Client ID", {
        exact: true,
      });
      if (!(await field.isVisible()))
        await page.locator(".auth-config summary").click();
      assert.equal(await field.getAttribute("type"), "password");
      assert.equal(await field.inputValue(), "");
      const state = await page.evaluate(() => window.launcher.call("state"));
      assert.equal(state.settings.microsoftClientId, "");
      if (!state.settings.microsoftClientIdConfigured)
        await field.fill(clientId);
      else {
        assert.equal(state.settings.microsoftClientIdStorageStatus, "ready");
        await page
          .getByText("Client ID 已加密保存。留空继续使用，输入新值可替换。", {
            exact: true,
          })
          .waitFor();
      }
    };
    const start = async (mode = "hold", automaticallyCopied = true) => {
      await setMode(mode);
      const before = await mainState();
      await button("开始微软登录").click();
      if (
        !["challenge-network", "challenge-hold", "challenge-late"].includes(
          mode,
        )
      ) {
        await page.getByText("等待微软授权", { exact: true }).waitFor();
        await page.locator(".device-code-value").waitFor();
        await page
          .getByText(
            automaticallyCopied
              ? "授权码已自动复制，可在微软页面直接粘贴。"
              : "未能自动复制授权码，请使用“复制授权码”按钮或手动输入。",
            { exact: true },
          )
          .waitFor();
      }
      return before;
    };
    const assertStopped = async (before, label) => {
      await waitForMain(
        (state) => state.aborted > before.aborted,
        `${label} abort`,
      );
      const snapshot = await mainState();
      await page.waitForTimeout(1250);
      assert.equal(
        (await mainState()).polls,
        snapshot.polls,
        `${label} polling`,
      );
      const state = await page.evaluate(() => window.launcher.call("state"));
      assert.equal(
        state.accounts.length,
        0,
        `${label} must not add an account`,
      );
    };
    const assertOnscreen = async (locator, name) => {
      await locator.waitFor();
      const geometry = await locator.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const center = document.elementFromPoint(
          rect.x + rect.width / 2,
          rect.y + rect.height / 2,
        );
        return {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: innerWidth,
          height: innerHeight,
          clickable:
            !!center && (center === element || element.contains(center)),
        };
      });
      assert(
        geometry.left >= 0 &&
          geometry.top >= 0 &&
          geometry.right <= geometry.width + 1 &&
          geometry.bottom <= geometry.height + 1 &&
          geometry.clickable,
        `${name}: ${JSON.stringify(geometry)}`,
      );
    };

    await openAccount();
    await app.evaluate(() => {
      globalThis.__ldfclDeviceQA.holdSettings = true;
    });
    await button("开始微软登录").click();
    await waitForMain(
      (state) => state.settingsHeld,
      "held settings persistence",
    );
    assert.equal((await mainState()).challenges, 0);
    await button("关闭弹窗").click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await app.evaluate(() => {
      globalThis.__ldfclDeviceQA.releaseSettings();
    });
    await waitForMain(
      (state) => state.settingsReleased,
      "released settings persistence",
    );
    await page.waitForTimeout(600);
    assert.equal((await mainState()).challenges, 0);
    assert.deepEqual((await mainState()).opened, []);
    assert.deepEqual((await mainState()).copies, []);
    checks.push(
      "closing before settings IPC completes prevents late authorization dispatch",
    );

    await openAccount();
    const challenge = await page.evaluate(() =>
      window.launcher.call("account:microsoft"),
    );
    assert.deepEqual(Object.keys(challenge).sort(), [
      "codeCopied",
      "expiresIn",
      "flow",
      "interval",
      "userCode",
      "verificationUri",
    ]);
    assert.equal(challenge.flow, "device");
    assert.equal(challenge.userCode, "ABCD-EFGH");
    assert.equal(
      challenge.verificationUri,
      "https://microsoft.com/devicelogin",
    );
    assert.equal(challenge.interval, 1);
    assert.equal(challenge.expiresIn, 600);
    assert.equal(challenge.codeCopied, true);
    await page.getByText("等待微软授权", { exact: true }).waitFor();
    assert.equal(
      await page.locator(".device-code-value").innerText(),
      "ABCD-EFGH",
    );
    assert.deepEqual((await mainState()).opened, [challenge.verificationUri]);
    assert.deepEqual((await mainState()).copies, ["ABCD-EFGH"]);
    assert.deepEqual((await mainState()).timeline.slice(0, 2), [
      { kind: "copy", text: "ABCD-EFGH" },
      { kind: "browser", url: challenge.verificationUri },
    ]);
    await page
      .getByText("授权码已自动复制，可在微软页面直接粘贴。", { exact: true })
      .waitFor();
    await button("复制授权码").click();
    await button("复制授权码").getByText("已复制", { exact: true }).waitFor();
    assert.equal(
      await app.evaluate(({ clipboard }) => clipboard.readText()),
      "ABCD-EFGH",
    );
    await button("打开微软授权页面").click();
    assert.deepEqual((await mainState()).opened, [
      challenge.verificationUri,
      challenge.verificationUri,
    ]);
    await waitForMain((state) => state.polls > 0, "authorization_pending poll");
    assert.equal((await mainState()).copies.length, 1);
    assert(await page.getByText("等待微软授权", { exact: true }).isVisible());
    await page.screenshot({ path: path.join(output, "device-login.png") });
    await button("取消本次登录").click();
    await button("开始微软登录").waitFor();
    checks.push(
      "public device challenge and pending status",
      "device code automatically copied once before browser opens; manual copy and reopen remain available",
    );

    await app.evaluate(() => {
      globalThis.__ldfclDeviceQA.holdExternal = true;
    });
    await page.evaluate(() => {
      window.__oldDeviceDispatch = window.launcher
        .call("account:microsoft")
        .catch((error) => {
          window.__oldDeviceDispatchError = error.message;
        });
    });
    const oldBrowser = await waitForMain(
      (state) => state.opened.length === 3,
      "held old browser dispatch",
    );
    await page.evaluate(() => window.launcher.call("account:cancel"));
    await page.evaluate(() => window.launcher.call("account:microsoft"));
    await page.getByText("等待微软授权", { exact: true }).waitFor();
    await app.evaluate(() => {
      globalThis.__ldfclDeviceQA.rejectExternal(
        new Error("controlled old browser rejection"),
      );
    });
    await page.waitForFunction(() => !!window.__oldDeviceDispatchError);
    await waitForMain(
      (state) => state.polls > oldBrowser.polls,
      "new flow survives old browser rejection",
    );
    assert(await page.getByText("等待微软授权", { exact: true }).isVisible());
    await button("取消本次登录").click();
    checks.push(
      "old browser-dispatch failure cannot cancel a newer device session",
    );

    const cancel = await start();
    await waitForMain(
      (state) => state.polls > cancel.polls,
      "cancel held poll",
    );
    await button("取消本次登录").click();
    await button("开始微软登录").waitFor();
    await assertStopped(cancel, "cancel");
    const switched = await start();
    await waitForMain(
      (state) => state.polls > switched.polls,
      "switch held poll",
    );
    await button("离线账号").click();
    await page.getByPlaceholder("Steve").waitFor();
    await assertStopped(switched, "switch login type");
    await button("正版登录").click();
    const closed = await start();
    await waitForMain((state) => state.polls > closed.polls, "close held poll");
    await button("关闭弹窗").click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await assertStopped(closed, "close dialog");
    checks.push(
      "cancel, type switch and close abort polling without account mutation",
    );

    await openAccount();
    const fetching = await start("challenge-hold");
    await waitForMain(
      (state) => state.challenges > fetching.challenges,
      "held initial challenge",
    );
    await button("关闭弹窗").click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await assertStopped(fetching, "close while obtaining device code");
    assert.equal((await mainState()).opened.length, fetching.opened.length);
    assert.equal((await mainState()).copies.length, fetching.copies.length);
    checks.push(
      "closing during initial device-code request aborts and prevents both clipboard changes and browser dispatch",
    );

    await openAccount();
    const late = await start("challenge-late");
    await waitForMain(
      (state) => state.challenges > late.challenges,
      "late initial challenge request",
    );
    await button("关闭弹窗").click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await app.evaluate(() => globalThis.__ldfclDeviceQA.releaseChallenge());
    await page.waitForTimeout(250);
    const stale = await mainState();
    assert.equal(stale.opened.length, late.opened.length);
    assert.equal(stale.copies.length, late.copies.length);
    assert.equal(stale.polls, late.polls);
    checks.push(
      "cancelled initial request that resolves late cannot copy a stale code, open a browser or start polling",
    );

    await openAccount();
    await app.evaluate(({ clipboard }) => {
      const qa = globalThis.__ldfclDeviceQA;
      qa.originalClipboardWrite.call(clipboard, "clipboard-preserved-on-error");
      qa.failClipboard = true;
    });
    const copyFailure = await start("pending", false);
    const failedCopy = await waitForMain(
      (state) => state.opened.length > copyFailure.opened.length,
      "browser still opens after clipboard failure",
    );
    assert.equal(failedCopy.copies.length, copyFailure.copies.length + 1);
    assert.equal(
      await app.evaluate(({ clipboard }) => clipboard.readText()),
      "clipboard-preserved-on-error",
    );
    assert.equal(await button("复制授权码").innerText(), "复制授权码");
    await waitForMain(
      (state) => state.polls > copyFailure.polls,
      "clipboard failure does not block polling",
    );
    assert.equal((await mainState()).copies.length, failedCopy.copies.length);
    await app.evaluate(() => {
      globalThis.__ldfclDeviceQA.failClipboard = false;
    });
    await button("复制授权码").click();
    await button("复制授权码").getByText("已复制", { exact: true }).waitFor();
    await page
      .getByText("授权码已复制，可在微软页面直接粘贴。", { exact: true })
      .waitFor();
    assert.equal(
      await app.evaluate(({ clipboard }) => clipboard.readText()),
      "ABCD-EFGH",
    );
    await button("取消本次登录").click();
    await button("开始微软登录").waitFor();
    checks.push(
      "automatic clipboard failure keeps browser authorization and polling active, reports failure honestly, and manual copy recovers",
    );

    for (const mode of ["challenge-network", "token-certificate", "denied"]) {
      const before = await start(mode);
      if (mode !== "challenge-network")
        await waitForMain(
          (state) => state.polls > before.polls,
          `${mode} poll`,
        );
      await page.getByRole("dialog").locator(".error-box").first().waitFor();
      const error = await page
        .getByRole("dialog")
        .locator(".error-box")
        .first()
        .innerText();
      assert(error.trim(), `${mode}: an actionable error is visible`);
      if (mode === "token-certificate")
        assert.match(error, /HTTPS 证书验证失败/);
      await button("开始微软登录").waitFor();
      assert.equal(await button("开始微软登录").isEnabled(), true);
    }
    checks.push(
      "challenge network, certificate and refusal errors allow retry",
    );
    const transient = await start("token-network");
    await waitForMain(
      (state) => state.polls > transient.polls,
      "transient network poll",
    );
    await page.getByText(/Microsoft 暂时无法连接/).waitFor();
    assert.equal(
      await page.locator(".device-code-value").innerText(),
      "ABCD-EFGH",
    );
    const recovered = await mainState();
    await setMode("pending");
    await waitForMain(
      (state) => state.polls > recovered.polls,
      "automatic network recovery retry",
    );
    assert.equal((await mainState()).copies.length, recovered.copies.length);
    assert.equal(
      await page.locator(".device-code-value").innerText(),
      "ABCD-EFGH",
    );
    await button("打开微软授权页面").click();
    assert.equal((await mainState()).opened.at(-1), challenge.verificationUri);
    await button("取消本次登录").click();
    await button("开始微软登录").waitFor();
    checks.push(
      "temporary polling network failure keeps code and retries automatically",
    );

    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(960, 640),
    );
    const compact = await start();
    await waitForMain(
      (state) => state.polls > compact.polls,
      "compact held poll",
    );
    await assertOnscreen(page.getByRole("dialog"), "960x640 dialog");
    await assertOnscreen(page.locator(".device-code-value"), "device code");
    for (const name of ["复制授权码", "打开微软授权页面", "取消本次登录"])
      await assertOnscreen(button(name), name);
    assert.equal(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1,
      ),
      true,
    );
    await page.screenshot({
      path: path.join(output, "device-login-compact.png"),
    });
    await button("取消本次登录").click();
    await assertStopped(compact, "compact cancel");
    checks.push("960x640 code and controls stay visible and clickable");

    const successful = await start("pending");
    await waitForMain(
      (state) => state.polls > successful.polls,
      "pre-success pending poll",
    );
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].minimize(),
    );
    const focusBefore = await mainState();
    await setMode("success");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    const state = await waitForState(
      (value) =>
        value.accounts.length === 1 &&
        value.accounts[0].name === "Device_QA" &&
        value.selectedAccountId === value.accounts[0].id,
      "Device login did not persist and select the successful account",
    );
    assert.equal(state.accounts[0].type, "microsoft");
    for (const secret of [
      "accessToken",
      "refreshToken",
      "clientToken",
      "device_code",
    ])
      assert.equal(secret in state.accounts[0], false);
    const completed = await mainState();
    assert(completed.show > focusBefore.show, "login success shows launcher");
    assert(
      completed.focus > focusBefore.focus,
      "login success focuses launcher",
    );
    const windowState = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return { minimized: window.isMinimized(), visible: window.isVisible() };
    });
    assert.equal(
      windowState.minimized,
      false,
      "login success restores minimized launcher",
    );
    assert.equal(windowState.visible, true);
    const publicEvents = await page.evaluate(() => window.__deviceAuthEvents);
    const serialized = JSON.stringify({ state, challenge, publicEvents });
    for (const secret of [
      "fixture-private-device-code-",
      "fixture-microsoft-access-token",
      "fixture-microsoft-refresh-token",
      "fixture-minecraft-access-token",
      clientId,
    ])
      assert.equal(
        serialized.includes(secret),
        false,
        `${secret} stays in main process`,
      );
    assert(
      completed.grants.some(
        (grant) => grant.kind === "token" && grant.hasPrivateCode,
      ),
    );
    assert(completed.grants.every((grant) => !grant.hasSecret));
    assert(completed.dispatchPayloads.every((payload) => payload === null));
    assert.equal(completed.settingsPayloads.length, 1);
    assert.deepEqual(completed.settingsPayloads[0], {
      microsoftClientId: clientId,
    });
    assert.equal(state.settings.microsoftClientId, "");
    assert.equal(state.settings.microsoftClientIdConfigured, true);
    assert.equal(state.settings.microsoftClientIdStorageStatus, "ready");
    const persisted = await fs.readFile(
      path.join(dir, "launcher.json"),
      "utf8",
    );
    assert.equal(persisted.includes(clientId), false);
    assert(
      completed.grants
        .filter((grant) => grant.kind === "token")
        .every(
          (grant) =>
            grant.grantType === "urn:ietf:params:oauth:grant-type:device_code",
        ),
    );
    checks.push(
      "controlled Microsoft/Xbox/Minecraft success selects account and focuses window",
    );
    checks.push(
      "private device code, tokens and saved Client ID stay out of renderer state/events; account dispatch has no Client ID and launcher.json contains no plaintext ID",
    );
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        passed: true,
        dataDir: dir,
        screenshots: output,
        checks,
        pageErrors: errors,
      }),
    );
  } finally {
    await app
      .evaluate(({ shell, clipboard }) => {
        const qa = globalThis.__ldfclDeviceQA;
        if (!qa) return;
        globalThis.fetch = qa.originalFetch;
        shell.openExternal = qa.originalExternal;
        clipboard.writeText = qa.originalClipboardWrite;
        process.getBuiltinModule("fs/promises").writeFile =
          qa.originalWriteFile;
        qa.releaseSettings?.();
        qa.releaseChallenge?.();
        qa.rejectExternal?.(new Error("test cleanup"));
        clipboard.writeText(qa.clipboardText);
      })
      .catch(() => {});
    await app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
