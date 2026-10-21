import {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  dialog,
  nativeImage,
  screen,
} from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { Store, validateSettings, saveGameOptions } from "./store";
import {
  effectiveGameOptions,
  validateGameOptions,
} from "../shared/game-settings";
import { ModFavorites } from "./services/mod-favorites";
import { SkinLibrary } from "./services/skin-library";
import { GameService } from "./services/game";
import { AccountService, validateSkinPng } from "./services/accounts";
import { createHash, randomUUID } from "node:crypto";
import { ContentService } from "./services/content";
import { resolveLauncherDataDirectory } from "./application-paths";
import { prepareLauncherDataDirectory } from "./launcher-data";
import {
  canonicalGameDirectoryPath,
  gameDirectoryPathKey,
  gameDirectoryRoots,
  resolveDefaultGameDirectoryPath,
  scanGameDirectory,
} from "./game-directories";
import type { GameDirectory, Instance } from "../shared/types";
import {
  assertInstanceGameDirectory,
  instanceGameDirectory,
  instanceVersionDirectoryId,
  prepareInstanceDirectories,
} from "./instance-paths";
let win: BrowserWindow | null = null;
let store: Store;
let game: GameService;
let accounts: AccountService;
let content: ContentService;
let modFavorites: ModFavorites;
let skinLibrary: SkinLibrary;
let microsoftDispatchRun = 0;
let directoryChanging = false;
let versionDeleting = false;
let gameDirectoryError: string | undefined;
const running = new Set<string>();
const locks = new Set<string>();
function emitGame(event: any) {
  if (event.type === "task" && event.task) {
    event = {
      ...event,
      task: {
        ...event.task,
        progress: event.task.progress * 100,
        status: event.task.status === "failed" ? "error" : event.task.status,
      },
    };
  }
  emit(event);
}
app.setName("LDFCL");
function emit(event: any) {
  if (
    event.type === "auth-status" &&
    event.status === "success" &&
    event.account?.id
  ) {
    store.selectedAccountId = event.account.id;
    if (win?.isMinimized()) win.restore();
    win?.show();
    win?.focus();
    void store
      .save()
      .then(() => emit({ type: "state" }))
      .catch(() => {});
  }
  if (event.type === "game" && ["exited", "error"].includes(event.status))
    running.delete(event.instanceId);
  if (win && !win.isDestroyed()) win.webContents.send("launcher:event", event);
}
async function state() {
  return {
    instances: store.currentInstances,
    gameDirectories: store.gameDirectories,
    selectedGameDirectoryId: store.selectedGameDirectoryId,
    accounts: await accounts.list(),
    settings: store.settings,
    selectedInstanceId: store.selectedInstanceId,
    selectedAccountId: store.selectedAccountId,
    system: { ...store.system(), gameDirectoryError },
  };
}
function bindGameServices() {
  const roots = gameDirectoryRoots(store.currentGameDirectory);
  game = new GameService(roots.dataDir, emitGame, {
    minecraftRoot: roots.minecraftRoot,
  });
  content = new ContentService(
    roots.dataDir,
    emit,
    () => store.settings.downloadConcurrency,
    store.dir,
    { minecraftRoot: roots.minecraftRoot },
  );
}
function instanceDirectory(instance: Instance): string {
  return instanceGameDirectory(
    gameDirectoryRoots(store.currentGameDirectory).minecraftRoot,
    instance,
  );
}
async function prepareDirectoryInstances(directory: GameDirectory) {
  return prepareInstanceDirectories(
    directory,
    store.instances.filter(
      (instance) => instance.gameDirectoryId === directory.id,
    ),
  );
}
async function assertVersionCanDelete(instance: Instance) {
  const root = gameDirectoryRoots(store.currentGameDirectory).minecraftRoot;
  const id = instanceVersionDirectoryId(instance);
  const key = (value: string) =>
    process.platform === "win32" ? value.toLowerCase() : value;
  const rootKey = key(await fs.realpath(root));
  for (const directory of store.gameDirectories) {
    const otherRoot = gameDirectoryRoots(directory).minecraftRoot;
    const canonical = await fs
      .realpath(otherRoot)
      .catch(() => path.resolve(otherRoot));
    if (key(canonical) !== rootKey) continue;
    if (
      store.instances.some(
        (other) =>
          other !== instance &&
          other.gameDirectoryId === directory.id &&
          key(instanceVersionDirectoryId(other)) === key(id),
      )
    )
      throw Error("其他实例仍在使用这个版本目录，无法删除。");
  }
  const versions = path.join(root, "versions");
  const entries = await fs.readdir(versions, { withFileTypes: true });
  if (entries.length > 4096)
    throw Error("版本目录过多，无法安全确认依赖，请先整理版本目录。");
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      key(entry.name) === key(id)
    )
      continue;
    const file = path.join(versions, entry.name, `${entry.name}.json`);
    let metadata: any;
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile()) continue;
      if (stat.size > 8 * 1024 * 1024) throw Error("版本配置过大");
      metadata = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (error: any) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) continue;
      throw Error("无法读取其他版本的依赖信息，暂时不能安全删除此版本。");
    }
    if (
      [metadata.inheritsFrom, metadata.jar].some(
        (reference) =>
          typeof reference === "string" && key(reference) === key(id),
      )
    )
      throw Error(
        `版本「${entry.name}」仍依赖此版本的配置或 JAR，请先移除依赖版本。`,
      );
  }
}
async function changeDirectory<T>(operation: () => Promise<T>): Promise<T> {
  if (directoryChanging || locks.size || running.size)
    throw Error("请先停止游戏并等待安装、更新或文件操作完成，再切换游戏目录。");
  const snapshot = store.captureGameDirectoryState();
  directoryChanging = true;
  try {
    return await operation();
  } catch (error) {
    store.restoreGameDirectoryState(snapshot);
    bindGameServices();
    emit({ type: "state" });
    throw error;
  } finally {
    directoryChanging = false;
  }
}
async function addDiscoveredInstances(
  directory: GameDirectory,
  discovered: Instance[],
): Promise<number> {
  const current = store.instances.filter(
    (i) => i.gameDirectoryId === directory.id,
  );
  const knownVersions = new Set<string>();
  for (const instance of current) {
    if (instance.versionDirectory) knownVersions.add(instance.versionDirectory);
    if (instance.importedVersionId)
      knownVersions.add(instance.importedVersionId);
    {
      try {
        const metadata = JSON.parse(
          await fs.readFile(
            path.join(
              instanceGameDirectory(
                gameDirectoryRoots(directory).minecraftRoot,
                instance,
              ),
              ".ldfcl",
              "launch.json",
            ),
            "utf8",
          ),
        );
        if (typeof metadata.version === "string")
          knownVersions.add(metadata.version);
      } catch {
        if (instance.loader === "vanilla") knownVersions.add(instance.version);
      }
    }
  }
  let added = 0;
  for (const instance of discovered) {
    if (
      knownVersions.has(instance.importedVersionId || instance.version) ||
      current.some((existing) => existing.id === instance.id)
    )
      continue;
    store.instances.push({ ...instance, gameDirectoryId: directory.id });
    knownVersions.add(instance.importedVersionId || instance.version);
    added++;
  }
  if (!store.currentInstances.some((i) => i.id === store.selectedInstanceId))
    store.selectedInstanceId = store.currentInstances[0]?.id;
  return added;
}
async function exclusive<T>(
  id: string,
  fn: () => Promise<T>,
  allowRunning = false,
) {
  if (directoryChanging) throw Error("游戏目录正在切换，请稍后重试。");
  if (versionDeleting) throw Error("正在删除版本，请等待完成后再操作。");
  if (locks.has(id) || (!allowRunning && running.has(id)))
    throw Error("此实例正在运行或处理任务，请稍后再试");
  locks.add(id);
  try {
    return await fn();
  } finally {
    locks.delete(id);
  }
}
async function call(method: string, p: any = {}) {
  if (
    directoryChanging &&
    (/^(?:instance:|content:|mods:|pack:)/.test(method) ||
      ["versions", "runtime", "install", "launch", "stop", "folder"].includes(
        method,
      ) ||
      (method === "select" && p.instanceId))
  )
    throw Error("游戏目录正在切换，请稍后重试。");
  const fileInstanceId =
    /^(?:instance:|mods:)/.test(method) || method === "folder"
      ? p.id
      : ["launch", "content:install", "content:versions"].includes(method)
        ? p.instanceId
        : undefined;
  if (fileInstanceId) {
    if (versionDeleting) throw Error("正在删除版本，请等待完成后再操作。");
    const directoryId = store.selectedGameDirectoryId;
    const instance = store.instance(fileInstanceId);
    if (!instance.versionDirectory)
      throw Error(
        "此实例的版本目录尚未准备好，请重新扫描游戏目录并查看目录提示。",
      );
    await assertInstanceGameDirectory(
      gameDirectoryRoots(store.currentGameDirectory).minecraftRoot,
      instance,
    );
    if (
      directoryChanging ||
      versionDeleting ||
      directoryId !== store.selectedGameDirectoryId
    )
      throw Error("游戏目录已切换，请重新操作当前版本。");
  }
  switch (method) {
    case "state":
      return state();
    case "versions":
      return game.versions();
    case "optifine:versions":
      return game.optifineVersions(p.version);
    case "runtime":
      return game.runtimeInfo();
    case "game-directory:add":
      return changeDirectory(async () => {
        let requested = p.path;
        if (!requested) {
          const chosen = await dialog.showOpenDialog(win!, {
            title: "添加 Minecraft 游戏目录",
            defaultPath: store.currentGameDirectory.path,
            properties: ["openDirectory", "createDirectory"],
          });
          if (chosen.canceled || !chosen.filePaths[0]) return null;
          requested = chosen.filePaths[0];
        }
        const rootPath = await canonicalGameDirectoryPath(requested);
        const key = gameDirectoryPathKey(rootPath);
        const existingPaths = await Promise.all(
          store.gameDirectories.map(async (directory) => ({
            directory,
            key: gameDirectoryPathKey(
              await fs.realpath(directory.path).catch(() => directory.path),
            ),
          })),
        );
        const directory = existingPaths.find((d) => d.key === key)
          ?.directory || {
          id: `directory-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`,
          name:
            path.basename(rootPath) === ".minecraft"
              ? `${path.basename(path.dirname(rootPath))} · .minecraft`
              : path.basename(rootPath),
          path: rootPath,
          layout: "standard" as const,
        };
        const registered = store.registerGameDirectory(directory);
        try {
          const prepared = await prepareDirectoryInstances(registered);
          const scan = await scanGameDirectory(registered);
          const discovered = await addDiscoveredInstances(
            registered,
            scan.instances,
          );
          store.selectGameDirectory(registered.id);
          await store.save();
          gameDirectoryError = prepared.warnings.join("\n") || undefined;
          return {
            ...(await state()),
            discovered,
            warnings: [...prepared.warnings, ...scan.warnings],
          };
        } finally {
          bindGameServices();
          emit({ type: "state" });
        }
      });
    case "game-directory:select":
      return changeDirectory(async () => {
        const directory = store.gameDirectories.find((d) => d.id === p.id);
        if (!directory) throw Error("游戏目录不存在，请重新添加。");
        await canonicalGameDirectoryPath(directory.path);
        try {
          const prepared = await prepareDirectoryInstances(directory);
          const scan = await scanGameDirectory(directory);
          const discovered = await addDiscoveredInstances(
            directory,
            scan.instances,
          );
          store.selectGameDirectory(directory.id);
          await store.save();
          gameDirectoryError = prepared.warnings.join("\n") || undefined;
          return {
            ...(await state()),
            discovered,
            warnings: [...prepared.warnings, ...scan.warnings],
          };
        } finally {
          bindGameServices();
          emit({ type: "state" });
        }
      });
    case "game-directory:scan":
      return changeDirectory(async () => {
        await canonicalGameDirectoryPath(store.currentGameDirectory.path);
        const prepared = await prepareDirectoryInstances(
          store.currentGameDirectory,
        );
        const scan = await scanGameDirectory(store.currentGameDirectory);
        const discovered = await addDiscoveredInstances(
          store.currentGameDirectory,
          scan.instances,
        );
        await store.save();
        gameDirectoryError = prepared.warnings.join("\n") || undefined;
        emit({ type: "state" });
        return {
          ...(await state()),
          discovered,
          warnings: [...prepared.warnings, ...scan.warnings],
        };
      });
    case "game-directory:remove":
      return changeDirectory(async () => {
        store.removeGameDirectory(p.id);
        try {
          await canonicalGameDirectoryPath(store.currentGameDirectory.path);
          const prepared = await prepareDirectoryInstances(
            store.currentGameDirectory,
          );
          await store.save();
          gameDirectoryError = prepared.warnings.join("\n") || undefined;
          return state();
        } finally {
          bindGameServices();
          emit({ type: "state" });
        }
      });
    case "game-directory:open": {
      const directory = p.id
        ? store.gameDirectories.find((d) => d.id === p.id)
        : store.currentGameDirectory;
      if (!directory) throw Error("游戏目录不存在。");
      const error = await shell.openPath(directory.path);
      if (error) throw Error(error);
      return true;
    }
    case "select": {
      if (p.instanceId) store.instance(p.instanceId);
      if (
        p.accountId &&
        !(await accounts.list()).some((x) => x.id === p.accountId)
      )
        throw Error("账号不存在");
      Object.assign(store, {
        ...(p.instanceId ? { selectedInstanceId: p.instanceId } : {}),
        ...(p.accountId ? { selectedAccountId: p.accountId } : {}),
      });
      await store.save();
      return state();
    }
    case "settings":
      store.settings = { ...store.settings, ...validateSettings(p) };
      await store.save();
      return state();
    case "install": {
      if (
        !/^[\w. +()-]{1,80}$/.test(p.version) ||
        !["vanilla", "fabric", "quilt", "forge", "optifine"].includes(
          p.loader || "vanilla",
        )
      )
        throw Error("版本信息无效");
      return exclusive(
        `install:${p.version}:${p.loader || "vanilla"}`,
        async () => {
          game.setConcurrency(store.settings.downloadConcurrency);
          const instance = await game.install(p);
          instance.gameDirectoryId = store.selectedGameDirectoryId;
          store.instances.push(instance);
          store.selectedInstanceId = instance.id;
          await store.save();
          emit({ type: "state" });
          return instance;
        },
      );
    }
    case "instance:save":
      return exclusive(p.id, async () => {
        const i = store.instance(p.id);
        if (p.name) i.name = String(p.name).slice(0, 80);
        if (p.gameSettings)
          i.gameSettings =
            p.replaceGameSettings === true
              ? validateGameOptions(p.gameSettings)
              : { ...i.gameSettings, ...validateGameOptions(p.gameSettings) };
        if (p.memoryMb !== undefined)
          i.memoryMb = Number(p.memoryMb) || undefined;
        if (p.javaPath !== undefined) i.javaPath = String(p.javaPath);
        await saveGameOptions(
          instanceDirectory(i),
          effectiveGameOptions(store.settings, i),
        );
        await store.save();
        return i;
      });
    case "instance:delete":
      return exclusive(p.id, async () => {
        if (locks.size !== 1 || running.size)
          throw Error("请先停止游戏并等待所有安装和文件操作完成，再删除版本。");
        versionDeleting = true;
        try {
          const i = store.instance(p.id);
          await assertVersionCanDelete(i);
          const dir = instanceDirectory(i);
          try {
            await fs.access(dir);
            await shell.trashItem(dir);
          } catch (e: any) {
            if (e.code !== "ENOENT") throw e;
          }
          store.instances = store.instances.filter((x) => x !== i);
          if (store.selectedInstanceId === i.id)
            store.selectedInstanceId = store.currentInstances[0]?.id;
          await store.save();
          return state();
        } finally {
          versionDeleting = false;
        }
      });
    case "launch":
      return exclusive(p.instanceId, async () => {
        const i = store.instance(p.instanceId);
        if (!p.accountId) throw Error("请先添加并选择一个账号");
        const account = await accounts.getForLaunch(p.accountId);
        await saveGameOptions(
          instanceDirectory(i),
          effectiveGameOptions(store.settings, i),
        );
        const result = await game.launch(i, account, store.settings);
        running.add(i.id);
        i.lastPlayed = new Date().toISOString();
        await store.save();
        if (store.settings.closeOnLaunch) win?.minimize();
        return result;
      });
    case "stop":
      await game.stop(p.id);
      running.delete(p.id);
      return true;
    case "account:offline": {
      const a = await accounts.addOffline(p.name);
      store.selectedAccountId = a.id;
      await store.save();
      return a;
    }
    case "account:microsoft": {
      const dispatchRun = ++microsoftDispatchRun;
      const flow = await accounts.beginMicrosoftDevice(
        p.clientId || store.settings.microsoftClientId,
      );
      if (dispatchRun !== microsoftDispatchRun)
        throw Error("此 Microsoft 登录请求已取消。");
      try {
        await shell.openExternal(flow.verificationUri);
      } catch {
        if (dispatchRun === microsoftDispatchRun) accounts.cancelMicrosoft();
        throw Error("无法打开系统浏览器，请检查默认浏览器后重试");
      }
      return flow;
    }
    case "account:cancel":
      microsoftDispatchRun++;
      return accounts.cancelMicrosoft();
    case "account:yggdrasil": {
      const a = await accounts.addYggdrasil(p);
      store.selectedAccountId = a.id;
      await store.save();
      return a;
    }
    case "account:remove":
      await accounts.remove(p.id);
      return state();
    case "skin-library:list":
      return skinLibrary.list();
    case "skin-library:save":
      return skinLibrary.save({
        name: p.name,
        variant: p.variant,
        dataUrl: p.dataUrl,
      });
    case "skin-library:rename":
      return skinLibrary.rename(p.id, p.name);
    case "skin-library:remove":
      return skinLibrary.remove(p.id);
    case "skin-library:import": {
      const selected = await dialog.showOpenDialog(win!, {
        title: "导入到皮肤库",
        filters: [{ name: "Minecraft PNG 皮肤", extensions: ["png"] }],
        properties: ["openFile"],
      });
      if (selected.canceled) return null;
      const file = selected.filePaths[0];
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024)
        throw Error("皮肤必须是小于 2 MB 的 PNG 文件");
      const data = await fs.readFile(file);
      validateSkinPng(data);
      return skinLibrary.save({
        name: path.basename(file, path.extname(file)),
        variant: p.variant === "slim" ? "slim" : "classic",
        dataUrl: `data:image/png;base64,${data.toString("base64")}`,
      });
    }
    case "skin-library:export": {
      const entry = (await skinLibrary.list()).find((item) => item.id === p.id);
      if (!entry) throw Error("皮肤库中找不到此皮肤");
      const file = await skinLibrary.file(p.id);
      const selected = await dialog.showSaveDialog(win!, {
        title: "导出皮肤",
        defaultPath: `${entry.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")}.png`,
        filters: [{ name: "PNG 皮肤", extensions: ["png"] }],
      });
      if (selected.canceled || !selected.filePath) return null;
      const destination = await fs
        .realpath(selected.filePath)
        .catch(async (error) => {
          if (error.code !== "ENOENT") throw error;
          return path.join(
            await fs.realpath(path.dirname(selected.filePath!)),
            path.basename(selected.filePath!),
          );
        });
      const library = await fs.realpath(path.dirname(file));
      const relative = path.relative(library, destination);
      if (
        !relative ||
        (!relative.startsWith(`..${path.sep}`) &&
          relative !== ".." &&
          !path.isAbsolute(relative))
      )
        throw Error("请选择皮肤库文件夹以外的位置导出，避免覆盖已保存的皮肤。");
      await fs.copyFile(file, selected.filePath);
      return selected.filePath;
    }
    case "skin-library:apply": {
      const entry = (await skinLibrary.list()).find((item) => item.id === p.id);
      if (!entry) throw Error("皮肤库中找不到此皮肤");
      return accounts.uploadSkin(
        p.accountId,
        await skinLibrary.file(p.id),
        entry.variant,
      );
    }
    case "skin:profile":
      return accounts.profile(p.id);
    case "skin:upload": {
      const d = await dialog.showOpenDialog(win!, {
        title: "选择 Minecraft 皮肤",
        filters: [{ name: "PNG 皮肤", extensions: ["png"] }],
        properties: ["openFile"],
      });
      if (d.canceled) return null;
      return accounts.uploadSkin(p.id, d.filePaths[0], p.variant || "classic");
    }
    case "skin:preview": {
      const d = await dialog.showOpenDialog(win!, {
        title: "预览皮肤 / 披风",
        filters: [{ name: "PNG 纹理", extensions: ["png"] }],
        properties: ["openFile"],
      });
      if (d.canceled) return null;
      const stat = await fs.stat(d.filePaths[0]);
      if (stat.size > 2 * 1024 * 1024) throw Error("纹理图片应小于 2 MB");
      const img = nativeImage.createFromPath(d.filePaths[0]);
      if (img.isEmpty()) throw Error("无法读取 PNG 图片");
      return { url: img.toDataURL(), name: path.basename(d.filePaths[0]) };
    }
    case "skin:reset":
      return accounts.resetSkin(p.id);
    case "skin:cape":
      return accounts.activateCape(p.id, p.capeId || null);
    case "skin:saveEdited": {
      const data = decodeSkin(p.dataUrl);
      const folder = path.join(store.dir, "cache", "edited-skins");
      await fs.mkdir(folder, { recursive: true });
      const temp = path.join(folder, `${randomUUID()}.png`);
      await fs.writeFile(temp, data);
      try {
        return await accounts.uploadSkin(
          p.id,
          temp,
          p.variant === "slim" ? "slim" : "classic",
        );
      } finally {
        await fs.unlink(temp).catch(() => {});
      }
    }
    case "skin:exportEdited": {
      const data = decodeSkin(p.dataUrl);
      const d = await dialog.showSaveDialog(win!, {
        title: "导出编辑后的皮肤",
        defaultPath: "LDFCL-skin.png",
        filters: [{ name: "PNG 皮肤", extensions: ["png"] }],
      });
      if (d.canceled || !d.filePath) return null;
      await fs.writeFile(d.filePath, data);
      return d.filePath;
    }
    case "content:search":
      return content.search(p);
    case "mod-favorites:list":
      return modFavorites.list();
    case "mod-favorites:set":
      return modFavorites.set(p.project, p.saved === true);
    case "content:versions":
      return content.projectVersions({
        projectId: p.projectId,
        instance: store.instance(p.instanceId),
      });
    case "content:install":
      return exclusive(p.instanceId, () =>
        content.install({ ...p, instance: store.instance(p.instanceId) }),
      );
    case "mods:list":
      return exclusive(
        p.id,
        () => content.listMods(store.instance(p.id)),
        true,
      );
    case "mods:duplicates":
      return exclusive(
        p.id,
        () => content.scanDuplicates(store.instance(p.id)),
        true,
      );
    case "mods:toggle":
      return exclusive(p.id, () =>
        content.enableMod(store.instance(p.id), p.file, Boolean(p.enabled)),
      );
    case "mods:remove":
      return exclusive(p.id, () =>
        content.removeMod(store.instance(p.id), p.file),
      );
    case "mods:updates":
      return exclusive(
        p.id,
        () => content.checkUpdates(store.instance(p.id)),
        true,
      );
    case "mods:apply":
      return exclusive(p.id, () =>
        content.applyUpdates(store.instance(p.id), p.updates),
      );
    case "mods:import":
      return exclusive(p.id, async () => {
        const d = await dialog.showOpenDialog(win!, {
          filters: [{ name: "Mod", extensions: ["jar"] }],
          properties: ["openFile", "multiSelections"],
        });
        if (d.canceled) return null;
        return content.importMods(d.filePaths, store.instance(p.id));
      });
    case "pack:import": {
      return exclusive("pack:import", async () => {
        const d = await dialog.showOpenDialog(win!, {
          title: "导入 Modrinth 整合包",
          filters: [{ name: "Modrinth 整合包", extensions: ["mrpack"] }],
          properties: ["openFile"],
        });
        if (d.canceled) return null;
        return installPack(d.filePaths[0]);
      });
    }
    case "pack:versions":
      return content.packVersions(p.projectId);
    case "pack:install": {
      return exclusive(`pack:${String(p.projectId)}`, async () => {
        const pack = await content.downloadPack(p.projectId, p.versionId);
        return installPack(pack.path);
      });
    }
    case "folder": {
      const openFolder = async () => {
        let target = store.dir;
        if (p.id) {
          const i = store.instance(p.id);
          const sub = [
            "mods",
            "config",
            "resourcepacks",
            "shaderpacks",
            "screenshots",
            "saves",
            "logs",
          ].includes(p.sub)
            ? p.sub
            : "";
          target = path.join(instanceDirectory(i), sub);
        }
        await fs.mkdir(target, { recursive: true });
        const error = await shell.openPath(target);
        if (error) throw Error(error);
        return true;
      };
      return p.id ? exclusive(p.id, openFolder, true) : openFolder();
    }
    case "external": {
      const url = new URL(p.url);
      if (url.protocol !== "https:") throw Error("只能打开 HTTPS 链接");
      await shell.openExternal(url.href);
      return true;
    }
    case "java:choose": {
      const d = await dialog.showOpenDialog(win!, {
        title: "选择 javaw.exe 或 java.exe",
        filters: [{ name: "Java", extensions: ["exe"] }],
        properties: ["openFile"],
      });
      return d.canceled ? null : d.filePaths[0];
    }
    default:
      throw Error("不支持的操作");
  }
}
async function createWindow() {
  const area = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: Math.min(1120, area.width),
    height: Math.min(760, area.height),
    minWidth: Math.min(960, area.width),
    minHeight: Math.min(640, area.height),
    frame: false,
    backgroundColor: "#e8eef8",
    show: false,
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
  win.once("ready-to-show", () => win?.show());
  if (process.env.LDFCL_DEV_URL) await win.loadURL(process.env.LDFCL_DEV_URL);
  else await win.loadFile(path.join(__dirname, "../../dist/index.html"));
}
app
  .whenReady()
  .then(async () => {
    const directoryOptions = {
      isPackaged: app.isPackaged,
      execPath: process.execPath,
      appPath: app.getAppPath(),
      portableExecutableDir: process.env.PORTABLE_EXECUTABLE_DIR,
      dataDirOverride: process.env.LDFCL_DATA_DIR,
      gameRootOverride: process.env.LDFCL_GAME_ROOT,
    };
    const dataDir = resolveLauncherDataDirectory(directoryOptions);
    // Preserve Electron's protected key profile while relocating launcher files.
    const migration = await prepareLauncherDataDirectory(
      dataDir,
      process.env.LDFCL_DATA_DIR ? undefined : app.getPath("userData"),
    );
    const defaultGameRoot = resolveDefaultGameDirectoryPath(directoryOptions);
    await fs.mkdir(defaultGameRoot, { recursive: true }).catch(() => {});
    store = new Store(dataDir, {
      defaultGameRoot,
      legacyDataDir: migration.legacyDataDir,
    });
    await store.load();
    try {
      await canonicalGameDirectoryPath(store.currentGameDirectory.path);
      const prepared = await prepareDirectoryInstances(
        store.currentGameDirectory,
      );
      gameDirectoryError = prepared.warnings.join("\n") || undefined;
    } catch (error: any) {
      gameDirectoryError = `当前游戏目录不可用：${error.message} 请在启动器设置中添加或选择可读写的游戏目录。`;
    }
    const scan = await scanGameDirectory(store.currentGameDirectory);
    await addDiscoveredInstances(store.currentGameDirectory, scan.instances);
    await store.save();
    bindGameServices();
    accounts = new AccountService(store.dir, emit);
    modFavorites = new ModFavorites(store.dir);
    skinLibrary = new SkinLibrary(store.dir);
    ipcMain.handle("launcher:call", async (event, method, payload) => {
      if (event.sender !== win?.webContents) throw Error("无效的调用来源");
      try {
        return await call(method, payload);
      } catch (e: any) {
        const message = String(e.message || e).replace(
          /(Bearer\s+)[\w.\-]+/g,
          "$1[hidden]",
        );
        throw Error(message);
      }
    });
    ipcMain.on("launcher:window", (e, action) => {
      if (e.sender !== win?.webContents) return;
      if (action === "minimize") win?.minimize();
      if (action === "maximize")
        win?.isMaximized() ? win.unmaximize() : win?.maximize();
      if (action === "close") win?.close();
    });
    await createWindow();
  })
  .catch((error) => {
    dialog.showErrorBox("LDFCL 启动失败", error.message);
    app.quit();
  });
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => accounts?.cancelMicrosoft());
function decodeSkin(dataUrl: string): Buffer {
  if (
    typeof dataUrl !== "string" ||
    dataUrl.length > 2800000 ||
    !dataUrl.startsWith("data:image/png;base64,")
  )
    throw Error("皮肤必须是小于 2 MB 的 PNG");
  const data = Buffer.from(dataUrl.slice(22), "base64");
  validateSkinPng(data);
  return data;
}
async function installPack(file: string) {
  const meta = await content.inspectPack(file);
  if (!["vanilla", "fabric", "quilt", "forge"].includes(meta.loader)) {
    throw new Error(`暂不支持 ${meta.loader} 整合包，请选择其他加载器版本`);
  }
  game.setConcurrency(store.settings.downloadConcurrency);
  const instance = await game.install({
    version: meta.minecraftVersion,
    name: meta.name,
    loader: meta.loader as any,
    loaderVersion: meta.loaderVersion,
  });
  instance.gameDirectoryId = store.selectedGameDirectoryId;
  store.instances.push(instance);
  store.selectedInstanceId = instance.id;
  await store.save();
  try {
    await content.importPack(file, instance);
    return instance;
  } finally {
    emit({ type: "state" });
  }
}
