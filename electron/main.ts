import {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  dialog,
  nativeImage,
  screen,
  safeStorage,
  clipboard,
} from "electron";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { LauncherCore, LauncherCoreOptions } from "@ldfcl/core/launcher";
import { resolveLauncherDataDirectory } from "@ldfcl/core/application-paths";
import { resolveDefaultGameDirectoryPath } from "@ldfcl/core/game-directories";
import { LauncherUpdater, RELEASE_PAGE } from "./updater";

let win: BrowserWindow | null = null;
let launcher: LauncherCore | undefined;
let launcherReady: Promise<LauncherCore> | undefined;
let startupBusy = false;
let quitting = false;
let startupDataDirectory = "尚未确定";
let updater: LauncherUpdater;
let updaterScheduled = false;
let updateInstalling = false;
let activeCoreCalls = 0;
const activeDownloadTasks = new Set<string>();
app.setName("LDFCL");

function publicError(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/(Bearer\s+)[\w.\-]+/gi, "$1[hidden]")
    .replace(
      /((?:access|refresh|id)[_-]?token[\s"':=]+)[^\s,"'}]+/gi,
      "$1[hidden]",
    );
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );
}

async function showStartupPage(error?: unknown) {
  const target = win;
  if (!target || target.isDestroyed() || quitting) return;
  const nonce = randomBytes(18).toString("base64");
  const message = error
    ? publicError(error).slice(0, 2400)
    : "正在准备本地配置，请稍候。";
  const diagnostic = error
    ? [
        `LDFCL ${app.getVersion()}`,
        `配置目录：${startupDataDirectory}`,
        publicError(
          error instanceof Error ? error.stack || error.message : error,
        ).slice(0, 10000),
      ].join("\n")
    : "";
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
    <meta name="viewport" content="width=device-width, initial-scale=1"><title>LDFCL</title>
    <style>html{color-scheme:light}*{box-sizing:border-box}body{margin:0;font:14px/1.6 'Segoe UI','Microsoft YaHei',sans-serif;color:#233047;background:#e8eef8}header{height:54px;padding:14px 22px;-webkit-app-region:drag}header button{float:right;-webkit-app-region:no-drag;background:transparent;color:#233047;font-size:18px;padding:0 12px}main{max-width:680px;margin:12vh auto;padding:36px;border:1px solid #fff9;border-radius:24px;background:#f8faffeb;box-shadow:0 18px 50px #394f7812}h1{margin:8px 0;font-size:27px;font-weight:600}p{white-space:pre-wrap;overflow-wrap:anywhere;color:#55627a}button{border:0;border-radius:9px;padding:10px 18px;cursor:pointer;background:#315ed8;color:white;font:inherit}details{margin-top:24px}summary{cursor:pointer}pre{max-height:220px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 Consolas,monospace}.indicator{width:32px;height:32px;border:3px solid #d7e1f7;border-top-color:#315ed8;border-radius:50%;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.indicator{animation:none}}</style>
    </head><body><header>LDFCL<button id="close" aria-label="关闭启动器">×</button></header><main>
    ${error ? "" : '<div class="indicator" aria-hidden="true"></div>'}
    <h1>${error ? "启动失败" : "正在启动 LDFCL"}</h1>
    <p role="${error ? "alert" : "status"}">${escapeHtml(message)}</p>
    ${error ? `<button id="retry">重试</button><details><summary>诊断信息</summary><pre>${escapeHtml(diagnostic)}</pre></details>` : ""}
    </main><script nonce="${nonce}">document.getElementById('close').addEventListener('click',()=>window.launcher.window('close'));document.getElementById('retry')?.addEventListener('click',async(event)=>{event.currentTarget.disabled=true;try{await window.launcher.call('startup:retry')}catch(error){document.querySelector('[role=alert]').textContent=String(error.message||error);event.currentTarget.disabled=false}});</script></body></html>`;
  target.show();
  await target.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
  );
}

async function showStartupFailure(error: unknown) {
  console.error("LDFCL startup failed:", publicError(error));
  try {
    await showStartupPage(error);
  } catch (displayError) {
    // The native error remains visible even if the fallback document cannot load.
    if (win && !win.isDestroyed()) win.show();
    dialog.showErrorBox(
      "LDFCL 启动失败",
      `${publicError(error)}\n${publicError(displayError)}`,
    );
  }
}

function createWindow() {
  const area = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: Math.min(1120, area.width),
    height: Math.min(760, area.height),
    minWidth: Math.min(960, area.width),
    minHeight: Math.min(640, area.height),
    frame: false,
    backgroundColor: "#e8eef8",
    // Visibility must never depend on core initialization or ready-to-show.
    show: true,
    title: "LDFCL",
    icon: path.join(__dirname, "../../dist/icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file:") && !url.startsWith("http://127.0.0.1:5173"))
      event.preventDefault();
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    if (!quitting)
      void showStartupFailure(
        Error(`界面进程已退出（${details.reason}），请重试。`),
      );
  });
  win.on("closed", () => {
    win = null;
  });
}

function coreOptions(): LauncherCoreOptions {
  const directoryOptions = {
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    appPath: app.getAppPath(),
    portableExecutableDir: process.env.PORTABLE_EXECUTABLE_DIR,
    dataDirOverride: process.env.LDFCL_DATA_DIR,
    gameRootOverride: process.env.LDFCL_GAME_ROOT,
  };
  startupDataDirectory = resolveLauncherDataDirectory(directoryOptions);
  return {
    dataDir: startupDataDirectory,
    defaultGameRoot: resolveDefaultGameDirectoryPath(directoryOptions),
    // Keep the protected Electron profile so existing encrypted accounts work.
    legacyUserDataDir: process.env.LDFCL_DATA_DIR
      ? undefined
      : app.getPath("userData"),
    secretStorage: safeStorage,
    emit(event) {
      if (event.type === "task") {
        const task = event.task || event;
        if (
          ["running", "downloading", "paused", "queued"].includes(task.status)
        )
          activeDownloadTasks.add(task.id);
        else activeDownloadTasks.delete(task.id);
      }
      if (win && !win.isDestroyed())
        win.webContents.send("launcher:event", event);
    },
    host: {
      chooseFiles: (options) => dialog.showOpenDialog(win!, options),
      chooseSaveFile: (options) => dialog.showSaveDialog(win!, options),
      openPath: (target) => shell.openPath(target),
      openExternal: (url) => shell.openExternal(url),
      writeClipboardText: (text) => clipboard.writeText(text),
      trashItem: (target) => shell.trashItem(target),
      imageDataUrl(target) {
        const image = nativeImage.createFromPath(target);
        if (image.isEmpty()) throw Error("无法读取 PNG 图片");
        return image.toDataURL();
      },
      focusWindow() {
        if (win?.isMinimized()) win.restore();
        win?.show();
        win?.focus();
      },
      minimizeWindow: () => win?.minimize(),
    },
  };
}

async function startLauncher() {
  if (startupBusy || quitting || !win || win.isDestroyed()) return;
  startupBusy = true;
  try {
    // Render a local loading document before loading the core or touching data.
    await showStartupPage();
    if (!launcher) {
      launcherReady = Promise.resolve().then(() => {
        const { createLauncherCore } =
          require("@ldfcl/core/launcher") as typeof import("@ldfcl/core/launcher");
        return createLauncherCore(coreOptions());
      });
      const initialized = await launcherReady;
      if (quitting || !win || win.isDestroyed()) {
        initialized.dispose();
        return;
      }
      launcher = initialized;
    }
    if (process.env.LDFCL_DEV_URL)
      await win!.loadURL(process.env.LDFCL_DEV_URL);
    else await win!.loadFile(path.join(__dirname, "../../dist/index.html"));
    if (!updaterScheduled) {
      updaterScheduled = true;
      const timer = setTimeout(() => {
        if (!quitting) void updater.check();
      }, 3500);
      timer.unref();
    }
  } catch (error) {
    await showStartupFailure(error);
  } finally {
    startupBusy = false;
  }
}

app
  .whenReady()
  .then(() => {
    const portableFile = process.env.PORTABLE_EXECUTABLE_FILE;
    updater = new LauncherUpdater({
      currentVersion: app.getVersion(),
      executable:
        app.isPackaged &&
        process.platform === "win32" &&
        process.arch === "x64" &&
        portableFile &&
        path.isAbsolute(portableFile) &&
        path.extname(portableFile).toLowerCase() === ".exe"
          ? portableFile
          : undefined,
      emit(state) {
        if (win && !win.isDestroyed())
          win.webContents.send("launcher:event", {
            type: "launcher-update",
            state,
          });
      },
      async canInstall() {
        if (updateInstalling) throw Error("更新正在安装。");
        if (activeCoreCalls || activeDownloadTasks.size)
          throw Error("请等待当前操作和下载完成，再重启更新。");
        const state = await launcher?.state();
        if (state?.runningInstanceIds?.length)
          throw Error("请先关闭正在运行的 Minecraft，再重启更新。");
        if (activeCoreCalls || activeDownloadTasks.size)
          throw Error("请等待当前操作完成，再重启更新。");
        updateInstalling = true;
      },
      quit() {
        app.quit();
      },
    });
    ipcMain.handle("launcher:call", async (event, method, payload) => {
      if (event.sender !== win?.webContents) throw Error("无效的调用来源");
      try {
        if (method === "update:state") return updater.state();
        if (method === "update:check") return updater.check();
        if (method === "update:download") return updater.download();
        if (method === "update:open") {
          await shell.openExternal(RELEASE_PAGE);
          return true;
        }
        if (method === "update:install") {
          if (updateInstalling || updater.state().status === "installing")
            throw Error("更新正在安装。");
          try {
            return await updater.install();
          } catch (error) {
            if (updater.state().status !== "installing")
              updateInstalling = false;
            throw error;
          }
        }
        if (updateInstalling) throw Error("正在应用启动器更新，请稍候。");
        if (method === "startup:retry") {
          void startLauncher();
          return true;
        }
        if (!launcherReady) throw Error("启动器正在准备，请稍后重试。");
        const ready = await launcherReady;
        activeCoreCalls++;
        try {
          return await ready.call(method, payload);
        } finally {
          activeCoreCalls--;
        }
      } catch (error: any) {
        throw Error(publicError(error));
      }
    });
    ipcMain.on("launcher:window", (event, action) => {
      if (event.sender !== win?.webContents) return;
      if (action === "minimize") win?.minimize();
      if (action === "maximize")
        win?.isMaximized() ? win.unmaximize() : win?.maximize();
      if (action === "close") win?.close();
    });
    createWindow();
    void startLauncher();
  })
  .catch((error) => {
    dialog.showErrorBox("LDFCL 启动失败", error.message);
    app.quit();
  });
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  quitting = true;
  launcher?.dispose();
});
