import fs from "node:fs/promises";
import path from "node:path";
import { Store, saveGameOptions } from "./store";
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
import { prepareLauncherDataDirectory } from "./launcher-data";
import {
  canonicalGameDirectoryPath,
  gameDirectoryPathKey,
  gameDirectoryRoots,
  scanGameDirectory,
  safeGameVersionId,
} from "./game-directories";
import type { GameDirectory, Instance } from "../shared/types";
import {
  assertInstanceGameDirectory,
  instanceGameDirectory,
  instanceVersionDirectoryId,
  prepareInstanceDirectories,
} from "./instance-paths";
import type { SecretStorage } from "./ports";
import type { LauncherHost } from "./host";
import { LauncherFeatures } from "./features";
import { validateExtraJvmArguments } from "../shared/jvm-arguments";
import {
  setDownloadSource,
  controlDownload,
  setTaskDownloadSource,
} from "./services/downloads";
import { AI_DISABLED_MESSAGE } from "../shared/ai";
import { ContentPacksService } from "./services/content-packs";

export interface LauncherCoreOptions {
  dataDir: string;
  defaultGameRoot: string;
  legacyUserDataDir?: string;
  secretStorage?: SecretStorage;
  host: LauncherHost;
  emit?: (event: any) => void;
}

export interface LauncherCore {
  call(method: string, payload?: any): Promise<any>;
  state(): Promise<any>;
  dispose(): void;
}

/** Business orchestration shared by hosts; native capabilities are injected. */
export async function createLauncherCore(
  options: LauncherCoreOptions,
): Promise<LauncherCore> {
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
    if (event.type === "game" && ["exited", "error"].includes(event.status))
      running.delete(event.instanceId);
    options.emit?.(event);
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
  async function call(method: string, p: any = {}) {
    // No AI module, settings, credential reads or network requests are reachable.
    if (method.startsWith("ai:")) throw Error(AI_DISABLED_MESSAGE);
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
    switch (method) {
      case "state":
        return state();
      case "versions":
        return game.versions();
      case "optifine:versions":
        return game.optifineVersions(p.version);
      case "neoforge:versions":
        return game.neoforgeVersions(p.version);
      case "runtime":
        return game.runtimeInfo();
      case "store:stats":
        return features.storage.stats();
      case "instance:manifest":
        return exclusive(p.id, () =>
          features.manifest(store.instance(p.id), p),
        );
      case "instance:rebuild":
        return exclusive("manifest:rebuild", async () => {
          let file = p.file;
          if (!file && !p.bundle) {
            const chosen = await host.chooseFiles({
              title: "选择实例 manifest（清单包中同样选择此文件）",
              filters: [{ name: "实例清单", extensions: ["json"] }],
              properties: ["openFile"],
            });
            if (chosen.canceled || !chosen.filePaths[0]) return null;
            file = chosen.filePaths[0];
          }
          let bundle = p.bundle;
          if (bundle) {
            for (const candidate of [
              "instance.manifest.json",
              "manifest.json",
            ]) {
              const target = path.join(path.resolve(bundle), candidate);
              if (
                await fs.lstat(target).then(
                  (stat) => stat.isFile() && !stat.isSymbolicLink(),
                  () => false,
                )
              ) {
                file = target;
                break;
              }
            }
          }
          if (typeof file !== "string" || !path.isAbsolute(file))
            throw Error("请选择有效的清单文件");
          const stat = await fs.lstat(file);
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.size > 32 * 1024 * 1024
          )
            throw Error("清单文件过大或不是普通文件");
          let manifest: any;
          try {
            manifest = JSON.parse(await fs.readFile(file, "utf8"));
          } catch {
            throw Error("实例清单 JSON 无效");
          }
          const source = manifest.instance;
          if (
            !source ||
            typeof source.version !== "string" ||
            ![
              "vanilla",
              "fabric",
              "quilt",
              "forge",
              "neoforge",
              "optifine",
            ].includes(source.loader)
          )
            throw Error("实例清单缺少有效的游戏版本与加载器信息");
          const versionDirectory = safeGameVersionId(
            source.versionDirectory || source.importedVersionId || source.id,
          );
          const root = gameDirectoryRoots(
            store.currentGameDirectory,
          ).minecraftRoot;
          await canonicalGameDirectoryPath(root);
          await fs.mkdir(path.join(root, "versions"), { recursive: true });
          const destination = path.join(root, "versions", versionDirectory);
          if (
            await fs.lstat(destination).then(
              () => true,
              () => false,
            )
          )
            throw Error(
              "此游戏目录已有同名版本；请在启动器设置添加并切换到干净游戏目录后重建，现有文件将保留",
            );
          if (
            !bundle &&
            (await fs.stat(path.join(path.dirname(file), "blobs")).then(
              (stat) => stat.isDirectory(),
              () => false,
            ))
          )
            bundle = path.dirname(file);
          if (bundle)
            await features.storage.rebuildFromBundle(
              path.resolve(bundle),
              destination,
            );
          else await features.storage.reconstruct(manifest, destination);
          const instance: Instance = {
            id: randomUUID(),
            name: String(p.name || source.name || source.version).slice(0, 100),
            version: source.version,
            loader: source.loader,
            loaderVersion:
              typeof source.loaderVersion === "string"
                ? source.loaderVersion
                : undefined,
            versionDirectory,
            gameDirectoryId: store.selectedGameDirectoryId,
            createdAt: new Date().toISOString(),
            gameSettings: validateGameOptions(source.gameSettings || {}),
            memoryMb:
              typeof source.memoryMb === "number" &&
              Number.isFinite(source.memoryMb) &&
              source.memoryMb >= 512
                ? source.memoryMb
                : undefined,
            // A portable manifest never activates a foreign executable path.
            javaPath: "",
            jvmArgs: validateExtraJvmArguments(source.jvmArgs || []),
          };
          store.instances.push(instance);
          store.selectedInstanceId = instance.id;
          await store.save();
          await features.migrate(instance);
          emit({ type: "state" });
          return instance;
        });
      case "snapshot:create":
        return exclusive(p.id, () =>
          features.createSnapshot(store.instance(p.id), p.name),
        );
      case "snapshot:list":
        return exclusive(
          p.id,
          () =>
            features.snapshots.list(instanceDirectory(store.instance(p.id))),
          true,
        );
      case "snapshot:diff":
      case "snapshot:preview":
        return exclusive(p.id, () =>
          features.snapshots.previewRestore(
            instanceDirectory(store.instance(p.id)),
            p.snapshotId,
          ),
        );
      case "snapshot:restore":
        if (p.apply !== true) throw Error("请先查看回滚变更，再确认执行");
        return exclusive(p.id, () =>
          features.restore(
            store.instance(p.id),
            p.snapshotId,
            p.expectedPreviewId,
          ),
        );
      case "health:scan":
        return exclusive(p.id, () => features.scan(store.instance(p.id)), true);
      case "health:latest":
        return features.latest(store.instance(p.id));
      case "health:fix":
        if (p.auto !== true) throw Error("请先扫描，再选择自动修复");
        return exclusive(p.id, () => features.fix(store.instance(p.id)));
      case "diagnosis:list":
        return features.diagnostics.list(p.id || p.instanceId);
      case "diagnosis:get":
        return features.diagnostics.get(p.diagnosisId || p.id);
      case "diagnosis:share":
        return features.diagnostics.getSharePayload(p.diagnosisId || p.id);
      case "diagnosis:import":
        return exclusive(
          p.id || p.instanceId,
          async () => {
            const instance = store.instance(p.id || p.instanceId);
            let file = p.file;
            if (!file) {
              const chosen = await host.chooseFiles({
                title: "导入崩溃报告",
                filters: [{ name: "崩溃报告", extensions: ["txt", "log"] }],
                properties: ["openFile"],
              });
              if (chosen.canceled || !chosen.filePaths[0]) return null;
              file = chosen.filePaths[0];
            }
            return features.diagnostics.importReport({
              instanceId: instance.id,
              file,
              gameDirectory: instanceDirectory(instance),
            });
          },
          true,
        );
      case "download:control":
        controlDownload(p.id, p.action);
        return true;
      case "download:source":
        setTaskDownloadSource(p.id, p.source);
        return true;
      case "game-directory:add":
        return changeDirectory(async () => {
          let requested = p.path;
          if (!requested) {
            const chosen = await host.chooseFiles({
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
        const error = await host.openPath(directory.path);
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
        await store.updateSettings(p);
        setDownloadSource(store.settings.downloadSource || "official");
        return state();
      case "install": {
        if (
          !/^[\w. +()-]{1,80}$/.test(p.version) ||
          ![
            "vanilla",
            "fabric",
            "quilt",
            "forge",
            "neoforge",
            "optifine",
          ].includes(p.loader || "vanilla")
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
            await features.migrate(instance);
            emit({ type: "state" });
            return instance;
          },
        );
      }
      case "instance:save":
        return mutate(p.id, "实例设置", async () => {
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
          if (p.jvmArgs !== undefined)
            i.jvmArgs = validateExtraJvmArguments(p.jvmArgs);
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
            throw Error(
              "请先停止游戏并等待所有安装和文件操作完成，再删除版本。",
            );
          versionDeleting = true;
          try {
            const i = store.instance(p.id);
            await assertVersionCanDelete(i);
            const dir = instanceDirectory(i);
            try {
              await fs.access(dir);
              await host.trashItem(dir);
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
          await features.scan(i);
          await features.beforeChange(i, "启动前设置");
          await saveGameOptions(
            instanceDirectory(i),
            effectiveGameOptions(store.settings, i),
          );
          const result = await game.launch(i, account, store.settings);
          running.add(i.id);
          i.lastPlayed = new Date().toISOString();
          await store.save();
          if (store.settings.closeOnLaunch) host.minimizeWindow();
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
        microsoftClipboardStatus = undefined;
        accounts.cancelMicrosoft();
        const flow = await accounts.beginMicrosoftDevice(
          store.getMicrosoftClientId(),
        );
        const isCurrent = () =>
          dispatchRun === microsoftDispatchRun &&
          accounts.isMicrosoftDeviceChallengeActive(flow);
        if (!isCurrent()) throw Error("此 Microsoft 登录请求已取消。");
        let codeCopied = false;
        try {
          if (host.writeClipboardText) {
            host.writeClipboardText(flow.userCode);
            codeCopied = true;
          }
        } catch {
          // Clipboard availability must not prevent Microsoft authorization.
        }
        const copyMessage = codeCopied
          ? undefined
          : "未能自动复制授权码，请使用“复制授权码”按钮或手动输入。";
        if (!isCurrent()) throw Error("此 Microsoft 登录请求已取消。");
        microsoftClipboardStatus = {
          run: dispatchRun,
          userCode: flow.userCode,
          codeCopied,
          copyMessage,
        };
        emit({
          type: "auth-status",
          status: "waiting",
          ...flow,
          codeCopied,
          copyMessage,
          message: codeCopied
            ? "授权码已自动复制，请在 Microsoft 授权页面粘贴并完成登录。"
            : "请在 Microsoft 授权页面输入设备代码，完成授权后将自动继续。",
        });
        if (!isCurrent()) throw Error("此 Microsoft 登录请求已取消。");
        try {
          await host.openExternal(flow.verificationUri);
        } catch {
          if (dispatchRun === microsoftDispatchRun) accounts.cancelMicrosoft();
          throw Error("无法打开系统浏览器，请检查默认浏览器后重试");
        }
        return { ...flow, codeCopied, ...(copyMessage ? { copyMessage } : {}) };
      }
      case "account:cancel":
        microsoftDispatchRun++;
        microsoftClipboardStatus = undefined;
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
        const selected = await host.chooseFiles({
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
        const entry = (await skinLibrary.list()).find(
          (item) => item.id === p.id,
        );
        if (!entry) throw Error("皮肤库中找不到此皮肤");
        const file = await skinLibrary.file(p.id);
        const selected = await host.chooseSaveFile({
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
          throw Error(
            "请选择皮肤库文件夹以外的位置导出，避免覆盖已保存的皮肤。",
          );
        await fs.copyFile(file, selected.filePath);
        return selected.filePath;
      }
      case "skin-library:apply": {
        const entry = (await skinLibrary.list()).find(
          (item) => item.id === p.id,
        );
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
        const d = await host.chooseFiles({
          title: "选择 Minecraft 皮肤",
          filters: [{ name: "PNG 皮肤", extensions: ["png"] }],
          properties: ["openFile"],
        });
        if (d.canceled) return null;
        return accounts.uploadSkin(
          p.id,
          d.filePaths[0],
          p.variant || "classic",
        );
      }
      case "skin:preview": {
        const d = await host.chooseFiles({
          title: "预览皮肤 / 披风",
          filters: [{ name: "PNG 纹理", extensions: ["png"] }],
          properties: ["openFile"],
        });
        if (d.canceled) return null;
        const stat = await fs.stat(d.filePaths[0]);
        if (stat.size > 2 * 1024 * 1024) throw Error("纹理图片应小于 2 MB");
        return {
          url: host.imageDataUrl(d.filePaths[0]),
          name: path.basename(d.filePaths[0]),
        };
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
        const d = await host.chooseSaveFile({
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
      case "content-packs:list":
        return queuedRead(p.instanceId, () =>
          new ContentPacksService(
            gameDirectoryRoots(store.currentGameDirectory).minecraftRoot,
          ).list(store.instance(p.instanceId), p.kind),
        );
      case "content-packs:toggle":
        return mutate(p.instanceId, "启停资源包或光影", () =>
          new ContentPacksService(
            gameDirectoryRoots(store.currentGameDirectory).minecraftRoot,
          ).setEnabled(store.instance(p.instanceId), p.kind, p.name, p.enabled),
        );
      case "content-packs:remove":
        return mutate(p.instanceId, "移除资源包或光影", () =>
          new ContentPacksService(
            gameDirectoryRoots(store.currentGameDirectory).minecraftRoot,
          ).remove(store.instance(p.instanceId), p.kind, p.name),
        );
      case "content-packs:reorder":
        return mutate(p.instanceId, "资源包排序", () =>
          new ContentPacksService(
            gameDirectoryRoots(store.currentGameDirectory).minecraftRoot,
          ).reorder(store.instance(p.instanceId), p.names),
        );
      case "content-packs:import":
        return mutate(p.instanceId, "导入资源包或光影", async () => {
          if (!["resourcepack", "shader"].includes(p.kind))
            throw Error("无效的内容类型");
          const chosen = await host.chooseFiles({
            title: "导入 ZIP 资源包或光影",
            filters: [{ name: "资源包或光影", extensions: ["zip"] }],
            properties: ["openFile", "multiSelections"],
          });
          if (chosen.canceled) return null;
          return content.importFiles(
            chosen.filePaths,
            store.instance(p.instanceId),
            p.kind,
          );
        });
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
        return mutate(p.instanceId, "安装内容", () =>
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
        return mutate(p.id, "启停 Mod", () =>
          content.enableMod(store.instance(p.id), p.file, Boolean(p.enabled)),
        );
      case "mods:remove":
        return mutate(p.id, "移除 Mod", () =>
          content.removeMod(store.instance(p.id), p.file),
        );
      case "mods:updates":
        return exclusive(
          p.id,
          () => content.checkUpdates(store.instance(p.id)),
          true,
        );
      case "mods:apply":
        return mutate(p.id, "更新 Mod", () =>
          content.applyUpdates(store.instance(p.id), p.updates),
        );
      case "mods:import":
        return mutate(p.id, "导入 Mod", async () => {
          const d = await host.chooseFiles({
            filters: [{ name: "Mod", extensions: ["jar"] }],
            properties: ["openFile", "multiSelections"],
          });
          if (d.canceled) return null;
          return content.importMods(d.filePaths, store.instance(p.id));
        });
      case "pack:import": {
        return exclusive("pack:import", async () => {
          const d = await host.chooseFiles({
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
          const error = await host.openPath(target);
          if (error) throw Error(error);
          return true;
        };
        return p.id ? exclusive(p.id, openFolder, true) : openFolder();
      }
      case "external": {
        const url = new URL(p.url);
        if (url.protocol !== "https:") throw Error("只能打开 HTTPS 链接");
        await host.openExternal(url.href);
        return true;
      }
      case "java:choose": {
        const d = await host.chooseFiles({
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
  await fs.mkdir(options.defaultGameRoot, { recursive: true }).catch(() => {});
  store = new Store(options.dataDir, {
    defaultGameRoot: options.defaultGameRoot,
    legacyDataDir: migration.legacyDataDir,
    secretStorage: options.secretStorage,
  });
  await store.load();
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
    gameDirectoryError = prepared.warnings.join("\n") || undefined;
  } catch (error: any) {
    gameDirectoryError = `当前游戏目录不可用：${error.message} 请在启动器设置中添加或选择可读写的游戏目录。`;
  }
  const scan = await scanGameDirectory(store.currentGameDirectory);
  await addDiscoveredInstances(store.currentGameDirectory, scan.instances);
  await store.save({ initialization: true });
  bindGameServices();
  accounts = new AccountService(store.dir, emit, {
    secretStorage: options.secretStorage,
  });
  modFavorites = new ModFavorites(store.dir);
  skinLibrary = new SkinLibrary(store.dir);
  return {
    call,
    state,
    dispose: () => {
      microsoftDispatchRun++;
      microsoftClipboardStatus = undefined;
      accounts.cancelMicrosoft();
    },
  };
}
