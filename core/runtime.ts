import type { GameDirectory, Instance } from "@ldfcl/contracts/types";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { LauncherFeatures } from "./features";
import {
  canonicalGameDirectoryPath,
  gameDirectoryRoots,
  scanGameDirectory,
} from "./game-directories";
import type { LauncherHost } from "./host";
import {
  assertInstanceGameDirectory,
  instanceGameDirectory,
  instanceVersionDirectoryId,
  prepareInstanceDirectories,
} from "./instance-paths";
import { prepareLauncherDataDirectory } from "./launcher-data";
import type { SecretStorage } from "./ports";
import { AccountService, validateSkinPng } from "./services/accounts";
import { ContentService } from "./services/content";
import { setDownloadSource } from "./services/downloads";
import { GameService } from "./services/game";
import { ModFavorites } from "./services/mod-favorites";
import { SkinLibrary } from "./services/skin-library";
import { Store } from "./store";

export interface LauncherCoreOptions {
  dataDir: string;
  defaultGameRoot: string;
  programDir?: string;
  legacyUserDataDir?: string;
  secretStorage?: SecretStorage;
  host: LauncherHost;
  emit?: (event: any) => void;
}

/** Business orchestration shared by hosts; native capabilities are injected. */
export async function createLauncherRuntime(options: LauncherCoreOptions) {
  const host = options.host;
  let store: Store;
  let game: GameService;
  let accounts: AccountService;
  let content: ContentService;
  let modFavorites: ModFavorites;
  let skinLibrary: SkinLibrary;
  let features: LauncherFeatures;
  let microsoftDispatchRun = 0;
  let microsoftClipboardStatus:
    | {
        run: number;
        userCode: string;
        codeCopied: boolean;
        copyMessage?: string;
      }
    | undefined;
  let directoryChanging = false;
  let versionDeleting = false;
  let gameDirectoryError: string | undefined;
  let gameDirectoryWarnings: string[] = [];
  const running = new Set<string>();
  const locks = new Set<string>();
  const readQueues = new Map<string, Promise<unknown>>();
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
  function emit(event: any) {
    if (
      event.type === "auth-status" &&
      event.flow === "device" &&
      event.status === "waiting" &&
      microsoftClipboardStatus?.run === microsoftDispatchRun &&
      microsoftClipboardStatus.userCode === event.userCode
    ) {
      const { codeCopied, copyMessage } = microsoftClipboardStatus;
      event = { ...event, codeCopied, copyMessage };
    }
    if (
      event.type === "auth-status" &&
      event.status === "success" &&
      event.account?.id
    ) {
      store.selectedAccountId = event.account.id;
      host.focusWindow();
      void store
        .save()
        .then(() => emit({ type: "state" }))
        .catch(() => {});
    }
    if (event.type === "game") {
      if (["started", "running"].includes(event.status))
        running.add(event.instanceId);
      if (["exited", "stopped", "error"].includes(event.status))
        running.delete(event.instanceId);
    }
    options.emit?.(event);
  }
  async function state() {
    return {
      instances: store.currentInstances,
      gameDirectories: await Promise.all(
        store.gameDirectories.map(async (directory) => {
          try {
            const root = gameDirectoryRoots(directory).minecraftRoot;
            if (!(await fs.stat(root)).isDirectory())
              throw Object.assign(Error(), { code: "ENOTDIR" });
            await fs.access(root, constants.R_OK | constants.W_OK);
            return { ...directory, available: true };
          } catch (error: any) {
            return {
              ...directory,
              available: false,
              unavailableReason: ["ENOENT", "ENOTDIR"].includes(error.code)
                ? "目录已移动或删除，请重新定位或移除登记。"
                : "目录无法访问，请检查权限或重新定位。",
            };
          }
        }),
      ),
      selectedGameDirectoryId: store.selectedGameDirectoryId,
      accounts: await accounts.list(),
      settings: store.settings,
      selectedInstanceId: store.selectedInstanceId,
      selectedAccountId: store.selectedAccountId,
      runningInstanceIds: [...running],
      system: { ...store.system(), gameDirectoryError, gameDirectoryWarnings },
    };
  }
  function bindGameServices() {
    const roots = gameDirectoryRoots(store.currentGameDirectory);
    game = new GameService(roots.dataDir, emitGame, {
      minecraftRoot: roots.minecraftRoot,
      diagnostics: features.diagnostics,
    });
    setDownloadSource(store.settings.downloadSource || "official");
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
  function setDirectoryWarnings(warnings: string[]) {
    gameDirectoryError = undefined;
    gameDirectoryWarnings = warnings;
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
      throw Error(
        "请先停止游戏并等待安装、更新或文件操作完成，再切换游戏目录。",
      );
    const snapshot = store.captureGameDirectoryState();
    const previousDirectoryError = gameDirectoryError;
    const previousDirectoryWarnings = gameDirectoryWarnings;
    directoryChanging = true;
    try {
      return await operation();
    } catch (error) {
      store.restoreGameDirectoryState(snapshot);
      gameDirectoryError = previousDirectoryError;
      gameDirectoryWarnings = previousDirectoryWarnings;
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
      if (instance.versionDirectory)
        knownVersions.add(instance.versionDirectory);
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
          if (instance.loader === "vanilla")
            knownVersions.add(instance.version);
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
  async function mutate<T>(id: string, name: string, fn: () => Promise<T>) {
    return exclusive(id, async () => {
      const instance = store.instance(id);
      await features.beforeChange(instance, name);
      try {
        return await fn();
      } finally {
        await features.afterChange(instance);
      }
    });
  }
  async function queuedRead<T>(id: string, fn: () => Promise<T>) {
    const previous = readQueues.get(id) || Promise.resolve();
    const result = previous.catch(() => {}).then(() => exclusive(id, fn, true));
    readQueues.set(id, result);
    try {
      return await result;
    } finally {
      if (readQueues.get(id) === result) readQueues.delete(id);
    }
  }
  async function guardCommand(method: string, p: any = {}) {
    if (
      directoryChanging &&
      (/^(?:instance:|content:|content-packs:|mods:|pack:|snapshot:|health:|packs:)/.test(
        method,
      ) ||
        ["versions", "runtime", "install", "launch", "stop", "folder"].includes(
          method,
        ) ||
        (method === "select" && p.instanceId))
    )
      throw Error("游戏目录正在切换，请稍后重试。");
    const fileInstanceId =
      /^(?:instance:(?!rebuild)|mods:|snapshot:|health:|packs:)/.test(method) ||
      method === "folder"
        ? p.id
        : ["launch", "content:install", "content:versions"].includes(method) ||
            method.startsWith("content-packs:")
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
  }
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
    if (
      !["vanilla", "fabric", "quilt", "forge", "neoforge"].includes(meta.loader)
    ) {
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
      await features.migrate(instance);
      return instance;
    } finally {
      emit({ type: "state" });
    }
  }

  const migration = await prepareLauncherDataDirectory(
    options.dataDir,
    options.legacyUserDataDir,
  );
  store = new Store(options.dataDir, {
    defaultGameRoot: options.defaultGameRoot,
    programDir: options.programDir,
    legacyDataDir: migration.legacyDataDir,
    secretStorage: options.secretStorage,
  });
  await store.load();
  if (!store.hadDefaultGameDirectory)
    await fs
      .mkdir(options.defaultGameRoot, { recursive: true })
      .catch(() => {});
  features = new LauncherFeatures({
    store,
    host,
    emit,
  });
  try {
    await canonicalGameDirectoryPath(store.currentGameDirectory.path);
    const prepared = await prepareDirectoryInstances(
      store.currentGameDirectory,
    );
    setDirectoryWarnings(prepared.warnings);
  } catch (error: any) {
    gameDirectoryError = `当前游戏目录不可用：${error.message} 请在启动器设置中添加或选择可读写的游戏目录。`;
  }
  const scan = await scanGameDirectory(store.currentGameDirectory);
  if (!gameDirectoryError)
    setDirectoryWarnings([...gameDirectoryWarnings, ...scan.warnings]);
  await addDiscoveredInstances(store.currentGameDirectory, scan.instances);
  await store.save({ initialization: true });
  bindGameServices();
  accounts = new AccountService(store.dir, emit, {
    secretStorage: options.secretStorage,
  });
  modFavorites = new ModFavorites(store.dir);
  skinLibrary = new SkinLibrary(store.dir);
  return {
    guardCommand,
    state,
    get game() {
      return game;
    },
    set game(value: typeof game) {
      game = value;
    },
    get features() {
      return features;
    },
    set features(value: typeof features) {
      features = value;
    },
    get exclusive() {
      return exclusive;
    },
    get store() {
      return store;
    },
    set store(value: typeof store) {
      store = value;
    },
    get host() {
      return host;
    },
    get emit() {
      return emit;
    },
    get instanceDirectory() {
      return instanceDirectory;
    },
    get changeDirectory() {
      return changeDirectory;
    },
    get prepareDirectoryInstances() {
      return prepareDirectoryInstances;
    },
    get addDiscoveredInstances() {
      return addDiscoveredInstances;
    },
    get setDirectoryWarnings() {
      return setDirectoryWarnings;
    },
    get bindGameServices() {
      return bindGameServices;
    },
    get accounts() {
      return accounts;
    },
    set accounts(value: typeof accounts) {
      accounts = value;
    },
    get mutate() {
      return mutate;
    },
    get locks() {
      return locks;
    },
    get running() {
      return running;
    },
    get versionDeleting() {
      return versionDeleting;
    },
    set versionDeleting(value: typeof versionDeleting) {
      versionDeleting = value;
    },
    get assertVersionCanDelete() {
      return assertVersionCanDelete;
    },
    get microsoftDispatchRun() {
      return microsoftDispatchRun;
    },
    set microsoftDispatchRun(value: typeof microsoftDispatchRun) {
      microsoftDispatchRun = value;
    },
    get microsoftClipboardStatus() {
      return microsoftClipboardStatus;
    },
    set microsoftClipboardStatus(value: typeof microsoftClipboardStatus) {
      microsoftClipboardStatus = value;
    },
    get skinLibrary() {
      return skinLibrary;
    },
    set skinLibrary(value: typeof skinLibrary) {
      skinLibrary = value;
    },
    get decodeSkin() {
      return decodeSkin;
    },
    get content() {
      return content;
    },
    set content(value: typeof content) {
      content = value;
    },
    get queuedRead() {
      return queuedRead;
    },
    get modFavorites() {
      return modFavorites;
    },
    set modFavorites(value: typeof modFavorites) {
      modFavorites = value;
    },
    get installPack() {
      return installPack;
    },
    dispose: () => {
      microsoftDispatchRun++;
      microsoftClipboardStatus = undefined;
      accounts.cancelMicrosoft();
    },
  };
}

export type LauncherRuntime = Awaited<ReturnType<typeof createLauncherRuntime>>;
