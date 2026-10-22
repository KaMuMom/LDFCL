import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import type {
  GameDirectory,
  Instance,
  MicrosoftClientIdStorageStatus,
  Settings,
} from "../shared/types";
import type { SecretStorage } from "./ports";
import { LAUNCHER_VERSION } from "../shared/launcher";
import { validateGameOptions } from "../shared/game-settings";
import { validateExtraJvmArguments } from "../shared/jvm-arguments";
import { GAME_PRESETS } from "../shared/game-presets";
export const defaults: Settings = {
  downloadConcurrency: 8,
  memoryMode: "auto",
  memoryMb: 4096,
  javaPath: "",
  microsoftClientId: "",
  microsoftClientIdConfigured: false,
  microsoftClientIdStorageStatus: "empty",
  closeOnLaunch: false,
  gameDefaults: {},
  downloadSource: "official",
  theme: "system",
  gamePreset: "custom",
  jvmArgs: [],
};
export interface GameDirectoryStateSnapshot {
  gameDirectories: GameDirectory[];
  selectedGameDirectoryId?: string;
  instances: Instance[];
  selectedInstanceId?: string;
  selectedInstancesByDirectory: Record<string, string>;
  gameRoot?: string;
}
interface MicrosoftClientCredential {
  value: string;
  record?: unknown;
  status: MicrosoftClientIdStorageStatus;
}
function normalizeMicrosoftClientId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw Error("微软应用配置格式无效，请重新输入。");
  const normalized = value.trim();
  if (
    normalized &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      normalized,
    )
  )
    throw Error("微软应用 ID 必须是有效的 UUID，请检查后重新输入。");
  return normalized;
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
  private readonly secretStorage?: SecretStorage;
  // True private fields keep IDs out of accidental JSON serialization of Store.
  #microsoftClientValue = "";
  #microsoftClientRecord: unknown;
  #legacyMicrosoftClientId?: string;
  #microsoftClientStatus: MicrosoftClientIdStorageStatus = "empty";

  constructor(
    public dir: string,
    options: {
      defaultGameRoot?: string;
      legacyDataDir?: string;
      secretStorage?: SecretStorage;
    } = {},
  ) {
    this.dir = path.resolve(dir);
    this.defaultGameRoot = path.resolve(
      options.defaultGameRoot ?? path.join(this.dir, ".minecraft"),
    );
    this.legacyDataDir = path.resolve(options.legacyDataDir ?? this.dir);
    this.secretStorage = options.secretStorage;
  }

  private secureStorageAvailable(): boolean {
    try {
      return this.secretStorage?.isEncryptionAvailable() === true;
    } catch {
      return false;
    }
  }

  private publishMicrosoftClientStatus(): void {
    this.settings.microsoftClientId = "";
    this.settings.microsoftClientIdConfigured = Boolean(
      this.#microsoftClientValue,
    );
    this.settings.microsoftClientIdStorageStatus = this.#microsoftClientStatus;
  }

  private decodeMicrosoftClientRecord(
    record: unknown,
  ): MicrosoftClientCredential {
    if (!this.secureStorageAvailable())
      return { value: "", record, status: "unavailable" };
    try {
      const candidate = record as any;
      if (
        candidate?.schemaVersion !== 1 ||
        typeof candidate.encryptedClientId !== "string" ||
        candidate.encryptedClientId.length > 65536 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(candidate.encryptedClientId)
      )
        throw Error("Invalid encrypted configuration");
      const bytes = Buffer.from(candidate.encryptedClientId, "base64");
      if (bytes.toString("base64") !== candidate.encryptedClientId)
        throw Error("Invalid encrypted configuration");
      const value = normalizeMicrosoftClientId(
        this.secretStorage!.decryptString(bytes),
      );
      if (!value) throw Error("Empty encrypted configuration");
      return { value, record, status: "ready" };
    } catch {
      // Cross-account DPAPI data and corrupt ciphertext remain recoverable on disk.
      return { value: "", record, status: "unreadable" };
    }
  }

  private loadMicrosoftClientConfiguration(data: any): void {
    this.#microsoftClientRecord = data.microsoftClientConfiguration;
    this.#legacyMicrosoftClientId = undefined;
    this.#microsoftClientValue = "";
    this.#microsoftClientStatus = this.secureStorageAvailable()
      ? "empty"
      : "unavailable";
    if (this.#microsoftClientRecord !== undefined) {
      const loaded = this.decodeMicrosoftClientRecord(
        this.#microsoftClientRecord,
      );
      this.#microsoftClientValue = loaded.value;
      this.#microsoftClientStatus = loaded.status;
    }
    const legacy = data.settings?.microsoftClientId;
    if (
      !this.#microsoftClientValue &&
      typeof legacy === "string" &&
      legacy.trim()
    ) {
      this.#legacyMicrosoftClientId = legacy;
      this.#microsoftClientStatus = "migration-pending";
    }
    this.publishMicrosoftClientStatus();
  }

  /** Main-process only. Public settings always contain an empty placeholder. */
  getMicrosoftClientId(): string {
    if (this.#microsoftClientValue) return this.#microsoftClientValue;
    if (this.#legacyMicrosoftClientId)
      throw Error(
        "微软应用配置尚未完成安全迁移，请恢复系统加密服务或重新配置。",
      );
    if (this.#microsoftClientRecord !== undefined) {
      const loaded = this.decodeMicrosoftClientRecord(
        this.#microsoftClientRecord,
      );
      this.#microsoftClientValue = loaded.value;
      this.#microsoftClientStatus = loaded.status;
      this.publishMicrosoftClientStatus();
      if (loaded.value) return loaded.value;
      throw Error(
        loaded.status === "unavailable"
          ? "系统安全存储不可用，请恢复后重试或重新配置微软应用。"
          : "保存的微软应用配置无法在当前系统账户解密，请重新配置。",
      );
    }
    return "";
  }

  private stageMicrosoftClientCredential(
    value?: string,
    clear = false,
  ): MicrosoftClientCredential {
    if (clear)
      return {
        value: "",
        status: this.secureStorageAvailable() ? "empty" : "unavailable",
      };
    const requested = value || this.#legacyMicrosoftClientId;
    if (requested) {
      if (!this.secureStorageAvailable())
        throw Error(
          "系统安全存储不可用，无法安全保存微软应用配置；原配置已保留。",
        );
      try {
        const normalized = normalizeMicrosoftClientId(requested);
        if (!normalized) throw Error("Empty configuration");
        const encrypted = this.secretStorage!.encryptString(normalized);
        if (!Buffer.isBuffer(encrypted) || !encrypted.length)
          throw Error("Invalid encrypted configuration");
        return {
          value: normalized,
          record: {
            schemaVersion: 1,
            encryptedClientId: encrypted.toString("base64"),
          },
          status: "ready",
        };
      } catch {
        throw Error("系统安全存储未能加密微软应用配置；原配置已保留，请重试。");
      }
    }
    return {
      value: this.#microsoftClientValue,
      record: this.#microsoftClientRecord,
      status:
        this.#microsoftClientRecord === undefined
          ? this.secureStorageAvailable()
            ? "empty"
            : "unavailable"
          : this.#microsoftClientStatus,
    };
  }

  private async writeConfiguration(
    settings: Settings,
    record: unknown,
  ): Promise<void> {
    const file = path.join(this.dir, "launcher.json"),
      temporary = file + ".tmp";
    const persistedSettings = { ...settings, microsoftClientId: "" };
    delete persistedSettings.microsoftClientIdConfigured;
    delete persistedSettings.microsoftClientIdStorageStatus;
    try {
      await fs.writeFile(
        temporary,
        JSON.stringify(
          {
            instances: this.instances,
            gameDirectories: this.gameDirectories,
            selectedGameDirectoryId: this.selectedGameDirectoryId,
            selectedInstancesByDirectory: Object.fromEntries(
              this.selectedInstancesByDirectory,
            ),
            settings: persistedSettings,
            selectedInstanceId: this.selectedInstanceId,
            selectedAccountId: this.selectedAccountId,
            ...(record === undefined
              ? {}
              : { microsoftClientConfiguration: record }),
          },
          null,
          2,
        ),
        { encoding: "utf8", mode: 0o600 },
      );
      await fs.rename(temporary, file);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  private enqueueConfigurationSave(
    options: {
      initialization?: boolean;
      patch?: Partial<Settings>;
      clientId?: string;
      clearClientId?: boolean;
    } = {},
  ): Promise<void> {
    const operation = this.pending
      .catch(() => {})
      .then(async () => {
        try {
          const credential = this.stageMicrosoftClientCredential(
            options.clientId,
            options.clearClientId,
          );
          const settings = {
            ...this.settings,
            ...options.patch,
            microsoftClientId: "",
          };
          await this.writeConfiguration(settings, credential.record);
          // Commit credentials and effective settings only after atomic publication.
          this.#microsoftClientValue = credential.value;
          this.#microsoftClientRecord = credential.record;
          this.#legacyMicrosoftClientId = undefined;
          this.#microsoftClientStatus = credential.status;
          this.settings = { ...this.settings, ...options.patch };
          this.publishMicrosoftClientStatus();
        } catch (error) {
          this.publishMicrosoftClientStatus();
          // Legacy plaintext cannot be safely rewritten without encryption. Startup
          // remains usable; explicit mutations still report the preservation error.
          if (options.initialization && this.#legacyMicrosoftClientId) return;
          throw error;
        }
      });
    this.pending = operation;
    return operation;
  }

  async updateSettings(
    patch: Partial<Settings> & { clearMicrosoftClientId?: boolean },
    options: { clearMicrosoftClientId?: boolean } = {},
  ): Promise<void> {
    const validated = validateSettings(patch);
    const clientId = validated.microsoftClientId;
    delete validated.microsoftClientId;
    if (
      (patch.clearMicrosoftClientId !== undefined &&
        typeof patch.clearMicrosoftClientId !== "boolean") ||
      (options.clearMicrosoftClientId !== undefined &&
        typeof options.clearMicrosoftClientId !== "boolean")
    )
      throw Error("微软应用配置清除选项无效。");
    const clear =
      options.clearMicrosoftClientId === true ||
      patch.clearMicrosoftClientId === true;
    if (clear && clientId) throw Error("不能同时清除并设置微软应用配置。");
    await this.enqueueConfigurationSave({
      patch: validated,
      clientId: clientId || undefined,
      clearClientId: clear,
    });
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

  async load(options: { readOnly?: boolean } = {}) {
    if (!options.readOnly) await fs.mkdir(this.dir, { recursive: true });
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
        if (options.readOnly) {
          // JSON.parse errors can quote configuration contents on recent Node
          // versions. Do not echo those contents into command-line diagnostics.
          const code =
            typeof e.code === "string" && /^[A-Z0-9_]+$/.test(e.code)
              ? ` (${e.code})`
              : "";
          throw new Error(
            e instanceof SyntaxError
              ? "启动器配置 JSON 无效，未执行任何写入。"
              : `无法只读加载启动器配置${code}，未执行任何写入。`,
          );
        }
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
    this.loadMicrosoftClientConfiguration(data);
    if (!["official", "bmclapi"].includes(this.settings.downloadSource || ""))
      this.settings.downloadSource = "official";
    if (!["system", "light", "dark"].includes(this.settings.theme || ""))
      this.settings.theme = "system";
    if (
      this.settings.gamePreset !== "custom" &&
      !Object.hasOwn(GAME_PRESETS, this.settings.gamePreset || "")
    )
      this.settings.gamePreset = "custom";
    try {
      this.settings.jvmArgs = validateExtraJvmArguments(
        this.settings.jvmArgs || [],
      );
    } catch {
      this.settings.jvmArgs = [];
    }
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
    if (!options.readOnly) await this.save({ initialization: true });
  }
  save(options: { initialization?: boolean } = {}) {
    this.rememberCurrentSelection();
    if (this.selectedGameDirectoryId)
      this.settings.gameRoot = this.currentGameDirectory.path;
    return this.enqueueConfigurationSave(options);
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
  delete v.microsoftClientIdConfigured;
  delete v.microsoftClientIdStorageStatus;
  if (v.microsoftClientId !== undefined)
    v.microsoftClientId = normalizeMicrosoftClientId(v.microsoftClientId);
  if (
    v.downloadSource !== undefined &&
    !["official", "bmclapi"].includes(v.downloadSource)
  )
    throw Error("无效的下载源");
  if (v.theme !== undefined && !["system", "light", "dark"].includes(v.theme))
    throw Error("无效的主题");
  if (
    v.gamePreset !== undefined &&
    v.gamePreset !== "custom" &&
    !Object.hasOwn(GAME_PRESETS, v.gamePreset)
  )
    throw Error("无效的启动预设");
  if (v.jvmArgs !== undefined) v.jvmArgs = validateExtraJvmArguments(v.jvmArgs);
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
