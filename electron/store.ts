import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import type { GameDirectory, Instance, Settings } from "../shared/types";
import { LAUNCHER_VERSION } from "../shared/launcher";
import { validateGameOptions } from "../shared/game-settings";
export const defaults: Settings = {
  downloadConcurrency: 8,
  memoryMode: "auto",
  memoryMb: 4096,
  javaPath: "",
  microsoftClientId: "",
  closeOnLaunch: false,
  gameDefaults: {},
};
export interface GameDirectoryStateSnapshot {
  gameDirectories: GameDirectory[];
  selectedGameDirectoryId?: string;
  instances: Instance[];
  selectedInstanceId?: string;
  selectedInstancesByDirectory: Record<string, string>;
  gameRoot?: string;
}
export class Store {
  instances: Instance[] = [];
  gameDirectories: GameDirectory[] = [];
  selectedGameDirectoryId?: string;
  settings: Settings = { ...defaults };
  selectedInstanceId?: string;
  selectedAccountId?: string;
  private pending = Promise.resolve();
  private selectedInstancesByDirectory = new Map<string, string>();
  private readonly defaultGameRoot: string;
  private readonly legacyDataDir: string;

  constructor(
    public dir: string,
    options: { defaultGameRoot?: string; legacyDataDir?: string } = {},
  ) {
    this.dir = path.resolve(dir);
    this.defaultGameRoot = path.resolve(
      options.defaultGameRoot ?? path.join(this.dir, ".minecraft"),
    );
    this.legacyDataDir = path.resolve(options.legacyDataDir ?? this.dir);
  }

  private directoryKey(value: string): string {
    const normalized = path.resolve(value);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  }

  private directoryId(value: string, layout: GameDirectory["layout"]): string {
    return `${layout}-${createHash("sha256")
      .update(this.directoryKey(value))
      .digest("hex")
      .slice(0, 20)}`;
  }

  get currentGameDirectory(): GameDirectory {
    const current = this.gameDirectories.find(
      (directory) => directory.id === this.selectedGameDirectoryId,
    );
    if (!current) throw Error("没有选中的游戏目录，请重新选择游戏目录。");
    return current;
  }

  get currentInstances(): Instance[] {
    if (!this.selectedGameDirectoryId) return [];
    return this.instances.filter(
      (instance) => instance.gameDirectoryId === this.selectedGameDirectoryId,
    );
  }

  registerGameDirectory(directory: GameDirectory): GameDirectory {
    if (
      !directory ||
      typeof directory.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(directory.id) ||
      typeof directory.name !== "string" ||
      !directory.name.trim() ||
      typeof directory.path !== "string" ||
      !path.isAbsolute(directory.path) ||
      directory.path.includes("\0") ||
      !["standard", "legacy"].includes(directory.layout)
    )
      throw Error("游戏目录登记信息无效。");
    const canonicalPath = path.resolve(directory.path);
    const existing = this.gameDirectories.find(
      (candidate) =>
        this.directoryKey(candidate.path) ===
          this.directoryKey(canonicalPath) &&
        candidate.layout === directory.layout,
    );
    if (existing) return existing;
    if (this.gameDirectories.some((candidate) => candidate.id === directory.id))
      throw Error("这个游戏目录标识已被其他路径使用。");
    const registered: GameDirectory = {
      id: directory.id,
      name: directory.name.trim(),
      path: canonicalPath,
      layout: directory.layout,
      ...(directory.layout === "standard" &&
      this.directoryKey(canonicalPath) ===
        this.directoryKey(this.defaultGameRoot)
        ? { isDefault: true }
        : {}),
    };
    this.gameDirectories.push(registered);
    return registered;
  }

  private rememberCurrentSelection(): void {
    const id = this.selectedGameDirectoryId;
    if (!id) return;
    if (
      this.selectedInstanceId &&
      this.currentInstances.some(
        (instance) => instance.id === this.selectedInstanceId,
      )
    )
      this.selectedInstancesByDirectory.set(id, this.selectedInstanceId);
    else {
      this.selectedInstanceId = undefined;
      this.selectedInstancesByDirectory.delete(id);
    }
  }

  private restoreCurrentSelection(): void {
    const directory = this.currentGameDirectory;
    const remembered = this.selectedInstancesByDirectory.get(directory.id);
    this.selectedInstanceId = this.currentInstances.some(
      (instance) => instance.id === remembered,
    )
      ? remembered
      : this.currentInstances[0]?.id;
    this.settings.gameRoot = directory.path;
    this.rememberCurrentSelection();
  }

  selectGameDirectory(id: string): void {
    if (!this.gameDirectories.some((directory) => directory.id === id))
      throw Error("找不到这个游戏目录。");
    this.rememberCurrentSelection();
    this.selectedGameDirectoryId = id;
    this.restoreCurrentSelection();
  }

  removeGameDirectory(id: string): void {
    const directory = this.gameDirectories.find(
      (candidate) => candidate.id === id,
    );
    if (!directory) throw Error("找不到这个游戏目录。");
    if (directory.isDefault) throw Error("启动器默认游戏目录不能移除。");
    if (this.selectedGameDirectoryId === id) {
      const fallback = this.gameDirectories.find(
        (candidate) => candidate.isDefault,
      );
      if (!fallback) throw Error("默认游戏目录尚未登记，无法移除当前目录。");
      this.selectGameDirectory(fallback.id);
    }
    // Unregistering a root preserves its files and instance metadata for re-adding it.
    this.gameDirectories = this.gameDirectories.filter(
      (candidate) => candidate.id !== id,
    );
  }

  captureGameDirectoryState(): GameDirectoryStateSnapshot {
    return {
      gameDirectories: structuredClone(this.gameDirectories),
      selectedGameDirectoryId: this.selectedGameDirectoryId,
      instances: structuredClone(this.instances),
      selectedInstanceId: this.selectedInstanceId,
      selectedInstancesByDirectory: Object.fromEntries(
        this.selectedInstancesByDirectory,
      ),
      gameRoot: this.settings.gameRoot,
    };
  }

  restoreGameDirectoryState(snapshot: GameDirectoryStateSnapshot): void {
    this.gameDirectories = structuredClone(snapshot.gameDirectories);
    this.selectedGameDirectoryId = snapshot.selectedGameDirectoryId;
    this.instances = structuredClone(snapshot.instances);
    this.selectedInstanceId = snapshot.selectedInstanceId;
    this.selectedInstancesByDirectory = new Map(
      Object.entries(snapshot.selectedInstancesByDirectory),
    );
    if (snapshot.gameRoot === undefined) delete this.settings.gameRoot;
    else this.settings.gameRoot = snapshot.gameRoot;
  }

  async load() {
    await fs.mkdir(this.dir, { recursive: true });
    let data: any = {};
    try {
      data = JSON.parse(
        await fs.readFile(path.join(this.dir, "launcher.json"), "utf8"),
      );
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw Error("无效的启动器配置");
    } catch (e: any) {
      data = {};
      if (e.code !== "ENOENT") {
        await fs.copyFile(
          path.join(this.dir, "launcher.json"),
          path.join(this.dir, `launcher.corrupt-${Date.now()}.json`),
        );
      }
    }
    this.instances = Array.isArray(data.instances)
      ? data.instances.filter(
          (instance: any) => instance && typeof instance.id === "string",
        )
      : [];
    this.settings = { ...defaults, ...data.settings };
    try {
      this.settings.gameDefaults = validateGameOptions(
        this.settings.gameDefaults || {},
      );
    } catch {
      this.settings.gameDefaults = {};
    }
    this.selectedAccountId =
      typeof data.selectedAccountId === "string"
        ? data.selectedAccountId
        : undefined;
    this.gameDirectories = [];
    this.selectedInstancesByDirectory.clear();
    if (Array.isArray(data.gameDirectories)) {
      for (const directory of data.gameDirectories) {
        try {
          this.registerGameDirectory(directory);
        } catch {
          // Keep other usable roots when an obsolete registration is malformed.
        }
      }
    }
    const defaultDirectory = this.registerGameDirectory({
      id: this.directoryId(this.defaultGameRoot, "standard"),
      name: "默认游戏目录",
      path: this.defaultGameRoot,
      layout: "standard",
    });
    const oldInstances = this.instances.filter(
      (instance) => !instance.gameDirectoryId,
    );
    let legacy: GameDirectory | undefined;
    if (oldInstances.length) {
      legacy = this.registerGameDirectory({
        id: this.directoryId(this.legacyDataDir, "legacy"),
        name: "原有游戏目录",
        path: this.legacyDataDir,
        layout: "legacy",
      });
      for (const instance of oldInstances) instance.gameDirectoryId = legacy.id;
    }
    if (
      data.selectedInstancesByDirectory &&
      typeof data.selectedInstancesByDirectory === "object"
    ) {
      for (const [id, instanceId] of Object.entries(
        data.selectedInstancesByDirectory,
      ))
        if (typeof instanceId === "string")
          this.selectedInstancesByDirectory.set(id, instanceId);
    }
    const savedDirectory = this.gameDirectories.find(
      (directory) => directory.id === data.selectedGameDirectoryId,
    );
    this.selectedGameDirectoryId =
      savedDirectory?.id ?? legacy?.id ?? defaultDirectory.id;
    if (
      typeof data.selectedInstanceId === "string" &&
      this.currentInstances.some(
        (instance) => instance.id === data.selectedInstanceId,
      )
    )
      this.selectedInstancesByDirectory.set(
        this.selectedGameDirectoryId,
        data.selectedInstanceId,
      );
    this.restoreCurrentSelection();
    await this.save();
  }
  save() {
    this.rememberCurrentSelection();
    if (this.selectedGameDirectoryId)
      this.settings.gameRoot = this.currentGameDirectory.path;
    this.pending = this.pending
      .catch(() => {})
      .then(async () => {
        const file = path.join(this.dir, "launcher.json");
        await fs.writeFile(
          file + ".tmp",
          JSON.stringify(
            {
              instances: this.instances,
              gameDirectories: this.gameDirectories,
              selectedGameDirectoryId: this.selectedGameDirectoryId,
              selectedInstancesByDirectory: Object.fromEntries(
                this.selectedInstancesByDirectory,
              ),
              settings: this.settings,
              selectedInstanceId: this.selectedInstanceId,
              selectedAccountId: this.selectedAccountId,
            },
            null,
            2,
          ),
        );
        await fs.rename(file + ".tmp", file);
      });
    return this.pending;
  }
  instance(id: string) {
    const i = this.currentInstances.find((x) => x.id === id);
    if (!i) throw Error("找不到这个游戏实例");
    if (!/^[a-zA-Z0-9_-]+$/.test(i.id)) throw Error("实例路径无效");
    return i;
  }
  system() {
    return {
      totalMemoryMb: Math.floor(os.totalmem() / 1048576),
      freeMemoryMb: Math.floor(os.freemem() / 1048576),
      platform: `Windows ${os.release()} · ${os.arch()}`,
      version: LAUNCHER_VERSION,
      dataDir: this.dir,
      gameRoot:
        this.currentGameDirectory.layout === "legacy"
          ? path.join(this.currentGameDirectory.path, "minecraft")
          : this.currentGameDirectory.path,
      defaultGameRoot: this.defaultGameRoot,
    };
  }
}
export function validateSettings(p: Partial<Settings>): Partial<Settings> {
  const v = { ...p };
  if (v.gameDefaults !== undefined)
    v.gameDefaults = validateGameOptions(v.gameDefaults);
  if (v.downloadConcurrency !== undefined)
    v.downloadConcurrency = Math.max(
      1,
      Math.min(32, Math.round(Number(v.downloadConcurrency) || 8)),
    );
  if (v.memoryMb !== undefined)
    v.memoryMb = Math.max(
      1024,
      Math.min(
        Math.floor(os.totalmem() / 1048576),
        Math.round(Number(v.memoryMb) || 4096),
      ),
    );
  if (v.memoryMode !== undefined && !["auto", "manual"].includes(v.memoryMode))
    throw Error("无效的内存模式");
  return Object.fromEntries(
    Object.entries(v).filter(
      ([k]) => k !== "gameRoot" && Object.keys(defaults).includes(k),
    ),
  );
}
export async function saveGameOptions(
  dir: string,
  settings: Instance["gameSettings"],
) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "options.txt");
  let text = "";
  try {
    text = await fs.readFile(file, "utf8");
  } catch {}
  const values = new Map(
    text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf(":");
        return [l.slice(0, i), l.slice(i + 1)] as [string, string];
      }),
  );
  const allowed = [
    "fullscreen",
    "renderDistance",
    "simulationDistance",
    "maxFps",
    "fov",
    "gamma",
    "guiScale",
    "graphicsMode",
    "ao",
    "enableVsync",
    "soundCategory_master",
    "lang",
    "autoJump",
    "bobView",
  ];
  for (const [k, v] of Object.entries(settings)) {
    if (allowed.includes(k) && !/[\r\n]/.test(String(v)))
      values.set(k, String(v));
  }
  await fs.writeFile(
    file,
    [...values].map(([k, v]) => `${k}:${v}`).join("\n") + "\n",
  );
}
