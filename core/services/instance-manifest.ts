import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Instance } from "../../shared/types";
import type {
  InstanceManifest,
  StoredFile,
  StorageDiff,
  StorageStats,
} from "../../shared/instance-storage";
import {
  ContentStore,
  pathExists,
  safeDirectory,
  safeFile,
  storageRelative,
  storagePath,
  sha256File,
  atomicStorageJson,
  readStorageJson,
  withInstanceStorageLock,
  replaceStorageFile,
} from "./content-store";

export const MANIFEST_FILE = ".ldfcl/manifest.json";
const EXCLUDED = [
  "logs",
  "crash-reports",
  ".trash",
  "cache",
  "accounts.json",
  "launcher_accounts.json",
  "launcher_accounts_microsoft_store.json",
  "launcher_profiles.json",
  "credentials.json",
  "tokens.json",
  ".ldfcl/snapshots",
  ".ldfcl/migration-backups",
  ".ldfcl/transactions",
  ".ldfcl/natives",
  ".ldfcl/health",
];
export interface InstanceStorageOptions {
  dataDir: string;
  minecraftRoot?: string;
}
export interface ManifestBuildOptions {
  instance?: Instance;
  migrate?: boolean;
}
function excluded(relative: string): boolean {
  // Only the launch pointer is runtime input under our private control directory.
  if (relative === ".ldfcl") return false;
  if (relative.startsWith(".ldfcl/")) return relative !== ".ldfcl/launch.json";
  return EXCLUDED.some(
    (p) =>
      relative.toLowerCase() === p.toLowerCase() ||
      relative.toLowerCase().startsWith(p.toLowerCase() + "/"),
  );
}
export function classifyStoredFile(
  relative: string,
): Pick<StoredFile, "mutable" | "role"> {
  const top = relative.split("/")[0].toLowerCase();
  const archive = /\.(jar|zip|jar\.disabled)$/i.test(relative);
  if (archive && top === "mods") return { mutable: false, role: "mod" };
  if (archive && top === "resourcepacks")
    return { mutable: false, role: "resourcepack" };
  if (archive && top === "shaderpacks")
    return { mutable: false, role: "shaderpack" };
  if (archive && top === "libraries")
    return { mutable: false, role: "library" };
  if (
    /^[^/]+\.jar$/i.test(relative) ||
    /^versions\/[^/]+\/[^/]+\.jar$/i.test(relative)
  )
    return { mutable: false, role: "client" };
  return { mutable: true, role: "data" };
}
/** Capture files by streaming their hash; no credentials, links or transient
 * launcher-private state are traversed. Empty user directories are preserved. */
export async function captureStorageTree(
  root: string,
  store: ContentStore | undefined,
  include: (relative: string, directory: boolean) => boolean,
): Promise<{ files: StoredFile[]; directories: string[] }> {
  await safeDirectory(root);
  const files: StoredFile[] = [],
    directories: string[] = [];
  const aliases = new Set<string>();
  async function visit(directory: string, prefix = "") {
    for (const name of (await fs.readdir(directory)).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      storageRelative(relative);
      const file = storagePath(root, relative),
        stat = await fs.lstat(file);
      if (!include(relative, stat.isDirectory())) continue;
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
        throw Error(`实例包含链接或特殊文件：${relative}`);
      const key = relative.toLowerCase();
      if (aliases.has(key)) throw Error("实例文件存在大小写冲突");
      aliases.add(key);
      if (stat.isDirectory()) {
        directories.push(relative);
        await visit(file, relative);
      } else {
        const digest = store
          ? await store.putFile(file)
          : { sha256: await sha256File(file), size: stat.size };
        files.push({
          path: relative,
          ...digest,
          ...classifyStoredFile(relative),
        });
      }
    }
  }
  await visit(root);
  return { files, directories };
}
export function validateStoredFiles(
  files: any,
  directories: any,
): asserts files is StoredFile[] {
  if (
    !Array.isArray(files) ||
    !Array.isArray(directories) ||
    files.length + directories.length > 250000
  )
    throw Error("清单文件数量无效或过多");
  const all = new Map<string, "file" | "directory">();
  for (const dir of directories) {
    storageRelative(dir);
    const key = dir.toLowerCase();
    if (all.has(key)) throw Error("清单路径重复");
    all.set(key, "directory");
  }
  for (const file of files) {
    storageRelative(file?.path);
    if (
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      typeof file.mutable !== "boolean"
    )
      throw Error("清单文件记录无效");
    const policy = classifyStoredFile(file.path);
    // Imported manifests cannot label config/options/saves as immutable links.
    if (file.mutable !== policy.mutable || file.role !== policy.role)
      throw Error("清单文件可写策略无效");
    const key = file.path.toLowerCase();
    if (all.has(key)) throw Error("清单路径重复");
    all.set(key, "file");
  }
  for (const key of all.keys()) {
    const pieces = key.split("/");
    pieces.pop();
    while (pieces.length) {
      if (all.get(pieces.join("/")) === "file")
        throw Error("清单文件和目录冲突");
      pieces.pop();
    }
  }
}
export function validateInstanceManifest(
  value: any,
): asserts value is InstanceManifest {
  if (
    value?.schemaVersion !== 1 ||
    value.kind !== "ldfcl-instance-manifest" ||
    typeof value.id !== "string" ||
    typeof value.createdAt !== "string"
  )
    throw Error("实例清单格式不支持");
  storageRelative(value.directoryName);
  if (value.directoryName.includes("/")) throw Error("清单版本目录无效");
  validateStoredFiles(value.files, value.directories);
  for (const entry of [
    ...value.files,
    ...value.directories.map((p: string) => ({ path: p })),
  ])
    if (excluded(entry.path)) throw Error("清单包含启动器私有或瞬态文件");
  validateStoredFiles(value.sharedFiles, []);
  for (const file of value.sharedFiles)
    if (!/^(libraries|versions)\//.test(file.path))
      throw Error("共享清单路径无效");
  if (
    !value.versionRecipe ||
    !Array.isArray(value.versionRecipe.profiles) ||
    value.versionRecipe.profiles.length > 16
  )
    throw Error("版本恢复配方无效");
  if (
    value.instance !== undefined &&
    (typeof value.instance.id !== "string" ||
      typeof value.instance.version !== "string" ||
      typeof value.instance.name !== "string" ||
      !["vanilla", "fabric", "quilt", "forge", "neoforge", "optifine"].includes(
        value.instance.loader,
      ))
  )
    throw Error("实例元数据无效");
}
export function diffStoredFiles(
  before: StoredFile[],
  after: StoredFile[],
): StorageDiff {
  const old = new Map(before.map((f) => [f.path, f])),
    current = new Map(after.map((f) => [f.path, f]));
  const added: StoredFile[] = [],
    removed: StoredFile[] = [],
    changed: StorageDiff["changed"] = [];
  let unchanged = 0;
  for (const [name, file] of old) {
    const next = current.get(name);
    if (!next) removed.push(file);
    else if (file.sha256 !== next.sha256 || file.size !== next.size)
      changed.push({ before: file, after: next });
    else unchanged++;
  }
  for (const [name, file] of current) if (!old.has(name)) added.push(file);
  return { added, removed, changed, unchanged };
}
function libraryCoordinate(name: string): string | undefined {
  const [identifier, extension = "jar"] = name.split("@");
  const [group, artifact, version, classifier] = identifier.split(":");
  if (!group || !artifact || !version) return undefined;
  const relative = `${group.replace(/\./g, "/")}/${artifact}/${version}/${artifact}-${version}${classifier ? `-${classifier}` : ""}.${extension}`;
  storageRelative(relative);
  return relative;
}

function launchArgumentValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(launchArgumentValues);
  if (value && typeof value === "object" && "value" in value)
    return launchArgumentValues(value.value);
  return [];
}

/** Modern Forge loaders locate installer-generated Minecraft/loader artifacts
 * through launch flags, rather than declaring them in the classpath libraries.
 * Capture only those exact coordinates, never an entire shared Maven cache. */
function generatedLoaderLibraries(
  profiles: InstanceManifest["versionRecipe"]["profiles"],
): string[] {
  const flags = new Map<string, string>();
  // Inherited arguments precede child arguments during actual launch.
  for (const { metadata } of [...profiles].reverse()) {
    const args = launchArgumentValues(metadata.arguments?.game);
    if (typeof metadata.minecraftArguments === "string")
      args.unshift(...metadata.minecraftArguments.split(/\s+/));
    for (let i = 0; i + 1 < args.length; i++)
      if (/^--fml\./i.test(args[i]))
        flags.set(args[i].toLowerCase(), args[i + 1]);
  }
  const part = (flag: string) => {
    const value = flags.get(flag);
    return value && /^[a-z0-9][a-z0-9._+-]*$/i.test(value) ? value : undefined;
  };
  const minecraft = part("--fml.mcversion"),
    neoForge = part("--fml.neoforgeversion"),
    forge = part("--fml.forgeversion"),
    mappings = part("--fml.neoformversion") || part("--fml.mcpversion");
  const coordinates: string[] = [];
  if (minecraft && mappings && (neoForge || forge))
    for (const classifier of ["extra", "slim", "srg"])
      coordinates.push(
        `net.minecraft:client:${minecraft}-${mappings}:${classifier}`,
      );
  if (neoForge)
    for (const classifier of ["client", "universal"])
      coordinates.push(`net.neoforged:neoforge:${neoForge}:${classifier}`);
  if (minecraft && forge)
    for (const classifier of ["client", "universal"])
      coordinates.push(
        `net.minecraftforge:forge:${minecraft}-${forge}:${classifier}`,
      );
  return coordinates.map((coordinate) => libraryCoordinate(coordinate)!);
}

export class InstanceStorageService {
  readonly contentStore: ContentStore;
  private readonly registry: string;
  constructor(readonly options: InstanceStorageOptions) {
    this.contentStore = new ContentStore(options);
    this.registry = path.join(options.dataDir, "store", "manifests");
  }
  private async assertInstance(instanceDir: string) {
    await safeDirectory(instanceDir);
    if (this.options.minecraftRoot) {
      await safeDirectory(this.options.minecraftRoot);
      const relative = path.relative(
        path.resolve(this.options.minecraftRoot, "versions"),
        path.resolve(instanceDir),
      );
      if (
        !relative ||
        relative.startsWith("..") ||
        path.isAbsolute(relative) ||
        relative.includes(path.sep)
      )
        throw Error("实例目录不在当前游戏根的 versions 中");
    }
  }
  private key(instanceDir: string) {
    return createHash("sha256")
      .update(
        process.platform === "win32"
          ? path.resolve(instanceDir).toLowerCase()
          : path.resolve(instanceDir),
      )
      .digest("hex");
  }
  private async register(instanceDir: string, manifest: InstanceManifest) {
    await atomicStorageJson(
      path.join(this.registry, `${this.key(instanceDir)}.json`),
      { instanceDir: path.resolve(instanceDir), manifest },
    );
  }
  async readManifest(instanceDir: string): Promise<InstanceManifest> {
    await this.assertInstance(instanceDir);
    const value = await readStorageJson(
      storagePath(instanceDir, MANIFEST_FILE),
    );
    validateInstanceManifest(value);
    return value;
  }
  private async recipe(
    instanceDir: string,
  ): Promise<Pick<InstanceManifest, "versionRecipe" | "sharedFiles">> {
    const versionId = path.basename(instanceDir),
      profiles: InstanceManifest["versionRecipe"]["profiles"] = [],
      sharedFiles: StoredFile[] = [];
    const root =
      this.options.minecraftRoot || path.dirname(path.dirname(instanceDir));
    const seen = new Set<string>(),
      sharedSeen = new Set<string>();
    const addShared = async (relative: string) => {
      storageRelative(relative);
      if (sharedSeen.has(relative.toLowerCase())) return;
      sharedSeen.add(relative.toLowerCase());
      const file = storagePath(root, relative);
      if (!(await pathExists(file))) return;
      const digest = await this.contentStore.putFile(file);
      sharedFiles.push({
        path: relative,
        ...digest,
        ...classifyStoredFile(relative),
      });
    };
    const visit = async (id: string): Promise<void> => {
      storageRelative(id);
      if (id.includes("/")) throw Error("版本继承标识无效");
      if (seen.has(id) || seen.size >= 16)
        throw Error("版本继承循环或层数异常");
      seen.add(id);
      const metadataFile =
        id === versionId
          ? path.join(instanceDir, `${id}.json`)
          : storagePath(root, `versions/${id}/${id}.json`);
      if (!(await pathExists(metadataFile))) return;
      const metadata = await readStorageJson(metadataFile, 8 * 1024 * 1024);
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
        throw Error("版本 JSON 无效");
      profiles.push({ id, metadata });
      if (id !== versionId) {
        await addShared(`versions/${id}/${id}.json`);
        await addShared(`versions/${id}/${id}.jar`);
      }
      if (
        typeof metadata.jar === "string" &&
        metadata.jar !== versionId &&
        metadata.jar !== id
      ) {
        storageRelative(metadata.jar);
        if (metadata.jar.includes("/")) throw Error("版本 JAR 引用无效");
        await addShared(`versions/${metadata.jar}/${metadata.jar}.jar`);
      }
      for (const library of Array.isArray(metadata.libraries)
        ? metadata.libraries
        : []) {
        const paths: string[] = [];
        if (typeof library?.downloads?.artifact?.path === "string")
          paths.push(library.downloads.artifact.path);
        for (const classifier of Object.values(
          library?.downloads?.classifiers || {},
        ) as any[])
          if (typeof classifier?.path === "string") paths.push(classifier.path);
        if (typeof library?.name === "string") {
          const relative = libraryCoordinate(library.name);
          if (relative) paths.push(relative);
        }
        for (const relative of paths)
          await addShared(`libraries/${storageRelative(relative)}`);
      }
      if (typeof metadata.inheritsFrom === "string")
        await visit(metadata.inheritsFrom);
    };
    await visit(versionId);
    for (const relative of generatedLoaderLibraries(profiles))
      await addShared(`libraries/${relative}`);
    return {
      versionRecipe: {
        versionId,
        profiles,
        sharedRoots: ["assets", "libraries", "runtime"],
        completeOnLaunch: true,
      },
      sharedFiles,
    };
  }
  private async capture(
    instanceDir: string,
    options: ManifestBuildOptions = {},
  ): Promise<InstanceManifest> {
    const tree = await captureStorageTree(
      instanceDir,
      this.contentStore,
      (relative) => !excluded(relative),
    );
    const previous = await this.readManifest(instanceDir).catch(
      () => undefined,
    );
    const policies = new Map(previous?.files.map((f) => [f.path, f]));
    for (const entry of tree.files) {
      const old = policies.get(entry.path);
      if (old?.sha256 === entry.sha256 && old.materialization) {
        entry.materialization = old.materialization;
        if (old.fallbackReason) entry.fallbackReason = old.fallbackReason;
      } else entry.materialization = "copy";
    }
    let instance = options.instance;
    if (
      !instance &&
      (await pathExists(path.join(instanceDir, "instance.json")))
    )
      instance = await readStorageJson(path.join(instanceDir, "instance.json"));
    const manifest: InstanceManifest = {
      schemaVersion: 1,
      kind: "ldfcl-instance-manifest",
      id: previous?.id || randomUUID(),
      createdAt: new Date().toISOString(),
      directoryName: path.basename(instanceDir),
      ...(instance ? { instance: structuredClone(instance) } : {}),
      ...tree,
      ...(await this.recipe(instanceDir)),
      excludedPaths: [...EXCLUDED],
    };
    validateInstanceManifest(manifest);
    return manifest;
  }
  async rebuildManifest(
    instanceDir: string,
    options: ManifestBuildOptions = {},
  ): Promise<InstanceManifest> {
    await this.assertInstance(instanceDir);
    if (options.migrate) {
      await this.migrate(instanceDir, options);
    }
    return withInstanceStorageLock(instanceDir, async () => {
      const manifest = await this.capture(instanceDir, options);
      await atomicStorageJson(
        storagePath(instanceDir, MANIFEST_FILE),
        manifest,
      );
      await this.register(instanceDir, manifest);
      return manifest;
    });
  }
  async exportManifest(instanceDir: string): Promise<string> {
    return JSON.stringify(await this.readManifest(instanceDir), null, 2);
  }
  diff(before: InstanceManifest, after: InstanceManifest): StorageDiff {
    validateInstanceManifest(before);
    validateInstanceManifest(after);
    return diffStoredFiles(
      [...before.files, ...before.sharedFiles],
      [...after.files, ...after.sharedFiles],
    );
  }
  private async restoreMigrationOriginals(
    instanceDir: string,
    backup: string,
    manifest: InstanceManifest,
  ): Promise<number> {
    validateInstanceManifest(manifest);
    for (const entry of manifest.files) {
      const source = storagePath(path.join(backup, "files"), entry.path);
      if ((await sha256File(source)) !== entry.sha256)
        throw Error("迁移原件备份已损坏");
    }
    // Repair history objects from independent originals as well. Leaving a bad
    // old blob would otherwise make a successful rollback impossible to index.
    for (const entry of manifest.files)
      await this.contentStore.repairFromVerifiedFile(
        storagePath(path.join(backup, "files"), entry.path),
        entry.sha256,
      );
    let restored = 0;
    for (const entry of manifest.files.filter((f) => !f.mutable)) {
      const target = storagePath(instanceDir, entry.path),
        stage = `${target}.${randomUUID()}.rollback`;
      await safeDirectory(path.dirname(target), true);
      if (await pathExists(target)) await safeFile(target);
      try {
        await fs.copyFile(
          storagePath(path.join(backup, "files"), entry.path),
          stage,
          constants.COPYFILE_EXCL,
        );
        await fs.chmod(stage, 0o600);
        await replaceStorageFile(stage, target);
        restored++;
      } finally {
        await fs.unlink(stage).catch(() => {});
      }
    }
    return restored;
  }
  private async recoverMigration(instanceDir: string): Promise<void> {
    const pendingFile = path.join(
      instanceDir,
      ".ldfcl",
      "migration-pending.json",
    );
    if (!(await pathExists(pendingFile))) return;
    const pending = await readStorageJson(pendingFile);
    if (
      pending.schemaVersion !== 1 ||
      !/^[a-f0-9-]{36}$/.test(pending.backupId)
    )
      throw Error("迁移恢复记录无效");
    const marker = await readStorageJson(
      path.join(instanceDir, ".ldfcl", "cas-migration.json"),
    ).catch(() => undefined);
    if (marker?.backupId !== pending.backupId) {
      const backup = path.join(
        instanceDir,
        ".ldfcl",
        "migration-backups",
        pending.backupId,
      );
      const original = await readStorageJson(
        path.join(backup, "original-manifest.json"),
      );
      await this.restoreMigrationOriginals(instanceDir, backup, original);
      const previousFile = path.join(backup, "previous-storage-manifest.json");
      if (await pathExists(previousFile)) {
        const previous = await readStorageJson(previousFile);
        validateInstanceManifest(previous);
        await atomicStorageJson(
          storagePath(instanceDir, MANIFEST_FILE),
          previous,
        );
        await this.register(instanceDir, previous);
      } else {
        await fs
          .unlink(storagePath(instanceDir, MANIFEST_FILE))
          .catch(() => {});
        await fs
          .unlink(path.join(this.registry, `${this.key(instanceDir)}.json`))
          .catch(() => {});
      }
    }
    await fs.unlink(pendingFile);
  }
  /** Immutable archives are published as read-only hardlinks. A real independent
   * byte backup of the first migration is kept, never part of later snapshots. */
  async migrate(
    instanceDir: string,
    options: ManifestBuildOptions = {},
  ): Promise<{
    migrated: boolean;
    backupId?: string;
    manifest: InstanceManifest;
  }> {
    await this.assertInstance(instanceDir);
    return withInstanceStorageLock(instanceDir, async () => {
      await this.recoverMigration(instanceDir);
      const markerFile = path.join(instanceDir, ".ldfcl", "cas-migration.json");
      if (await pathExists(markerFile)) {
        const marker = await readStorageJson(markerFile);
        return {
          migrated: false,
          backupId: marker.backupId,
          manifest: await this.readManifest(instanceDir),
        };
      }
      const previous = await this.readManifest(instanceDir).catch(
        () => undefined,
      );
      const manifest = await this.capture(instanceDir, options),
        backupId = randomUUID();
      const backup = path.join(
        instanceDir,
        ".ldfcl",
        "migration-backups",
        backupId,
      );
      await safeDirectory(backup, true);
      // Every original byte has an independent copy before the first instance
      // file is replaced. A failed backup leaves live data untouched.
      for (const entry of manifest.files) {
        const destination = storagePath(path.join(backup, "files"), entry.path);
        await safeDirectory(path.dirname(destination), true);
        await fs.copyFile(
          storagePath(instanceDir, entry.path),
          destination,
          constants.COPYFILE_EXCL,
        );
        await fs.chmod(destination, 0o600);
        if ((await sha256File(destination)) !== entry.sha256)
          throw Error("迁移原件备份校验失败");
      }
      await atomicStorageJson(
        path.join(backup, "original-manifest.json"),
        manifest,
      );
      if (previous)
        await atomicStorageJson(
          path.join(backup, "previous-storage-manifest.json"),
          previous,
        );
      const pendingFile = path.join(
        instanceDir,
        ".ldfcl",
        "migration-pending.json",
      );
      await atomicStorageJson(pendingFile, { schemaVersion: 1, backupId });
      const replaced: string[] = [];
      try {
        for (const entry of manifest.files) {
          if (entry.mutable) {
            entry.materialization = "copy";
            continue;
          }
          const target = storagePath(instanceDir, entry.path),
            stage = `${target}.${randomUUID()}.link`;
          try {
            Object.assign(
              entry,
              await this.contentStore.materialize(entry, stage),
            );
            await replaceStorageFile(stage, target);
            replaced.push(entry.path);
          } finally {
            await fs.unlink(stage).catch(() => {});
          }
        }
        await atomicStorageJson(
          storagePath(instanceDir, MANIFEST_FILE),
          manifest,
        );
        await this.register(instanceDir, manifest);
        await atomicStorageJson(markerFile, {
          schemaVersion: 1,
          backupId,
          migratedAt: new Date().toISOString(),
        });
        await fs.unlink(pendingFile);
        return { migrated: true, backupId, manifest };
      } catch (error) {
        for (const relative of replaced) {
          const target = storagePath(instanceDir, relative),
            stage = `${target}.${randomUUID()}.rollback`;
          await fs.copyFile(
            storagePath(path.join(backup, "files"), relative),
            stage,
            constants.COPYFILE_EXCL,
          );
          await fs.chmod(stage, 0o600);
          await replaceStorageFile(stage, target);
        }
        await this.recoverMigration(instanceDir);
        throw error;
      }
    });
  }
  async rollbackMigration(
    instanceDir: string,
  ): Promise<{ restored: number; backupId: string }> {
    await this.assertInstance(instanceDir);
    return withInstanceStorageLock(instanceDir, async () => {
      const markerFile = path.join(instanceDir, ".ldfcl", "cas-migration.json"),
        marker = await readStorageJson(markerFile);
      if (!/^[a-f0-9-]{36}$/.test(marker.backupId))
        throw Error("迁移备份标识无效");
      const backup = path.join(
          instanceDir,
          ".ldfcl",
          "migration-backups",
          marker.backupId,
        ),
        manifest = await readStorageJson(
          path.join(backup, "original-manifest.json"),
        );
      validateInstanceManifest(manifest);
      // Migration only changed immutable materialization. Restoring those bytes
      // leaves mutable worlds/options progressed since migration untouched.
      const restored = await this.restoreMigrationOriginals(
        instanceDir,
        backup,
        manifest,
      );
      await fs.unlink(markerFile);
      await fs.unlink(storagePath(instanceDir, MANIFEST_FILE)).catch(() => {});
      await fs
        .unlink(path.join(this.registry, `${this.key(instanceDir)}.json`))
        .catch(() => {});
      return { restored, backupId: marker.backupId };
    });
  }
  private async restoreShared(
    manifest: InstanceManifest,
    minecraftRoot: string,
  ): Promise<void> {
    await safeDirectory(minecraftRoot, true);
    for (const entry of manifest.sharedFiles) {
      const target = storagePath(minecraftRoot, entry.path);
      await this.contentStore.verify(entry.sha256, entry.size);
      if (await pathExists(target)) {
        if ((await sha256File(target)) !== entry.sha256)
          throw Error(`共享文件冲突，已保留原件：${entry.path}`);
        continue;
      }
      await this.contentStore.materialize(entry, target);
    }
  }
  async reconstruct(
    manifest: InstanceManifest,
    destination: string,
  ): Promise<InstanceManifest> {
    validateInstanceManifest(manifest);
    if (
      !path.isAbsolute(destination) ||
      path.basename(destination) !== manifest.directoryName
    )
      throw Error(
        "重建目录必须使用清单中的版本目录名称；请选择没有同名版本的游戏根目录",
      );
    await safeDirectory(path.dirname(destination), true);
    if (await pathExists(destination))
      throw Error("重建目标已存在；不会覆盖已有实例");
    for (const entry of [...manifest.files, ...manifest.sharedFiles])
      await this.contentStore.verify(entry.sha256, entry.size);
    const stage = path.join(
      path.dirname(destination),
      `.ldfcl-rebuild-${randomUUID()}`,
    );
    await safeDirectory(stage, true);
    const restored = structuredClone(manifest);
    try {
      for (const dir of manifest.directories)
        await safeDirectory(storagePath(stage, dir), true);
      for (const entry of restored.files)
        Object.assign(
          entry,
          await this.contentStore.materialize(
            entry,
            storagePath(stage, entry.path),
          ),
        );
      await this.restoreShared(
        manifest,
        this.options.minecraftRoot || path.dirname(path.dirname(destination)),
      );
      await atomicStorageJson(storagePath(stage, MANIFEST_FILE), restored);
      if (await pathExists(destination))
        throw Error("重建目标在操作期间被占用");
      // mkdir reservation plus removal protects ordinary concurrent rebuilds;
      // no existing nonempty version folder can be renamed over.
      await fs.mkdir(destination);
      await fs.rmdir(destination);
      await fs.rename(stage, destination);
      await this.register(destination, restored);
      return restored;
    } catch (error) {
      await fs.rm(stage, { recursive: true, force: true });
      throw error;
    }
  }
  async exportBundle(
    instanceDir: string,
    bundleDir: string,
  ): Promise<{ path: string; manifest: InstanceManifest; objects: number }> {
    await this.assertInstance(instanceDir);
    return withInstanceStorageLock(instanceDir, async () => {
      if (!path.isAbsolute(bundleDir)) throw Error("清单包目录必须为绝对路径");
      const relation = path.relative(instanceDir, bundleDir);
      if (
        !relation ||
        (!relation.startsWith("..") && !path.isAbsolute(relation))
      )
        throw Error("清单包不能导出到实例内部");
      await safeDirectory(path.dirname(bundleDir), true);
      if (await pathExists(bundleDir)) throw Error("清单包目标已存在");
      const manifest = await this.capture(instanceDir),
        stage = `${bundleDir}.${randomUUID()}.tmp`;
      await safeDirectory(stage, true);
      try {
        const unique = new Map(
          [...manifest.files, ...manifest.sharedFiles].map((f) => [
            f.sha256,
            f,
          ]),
        );
        for (const entry of unique.values()) {
          const source = await this.contentStore.verify(
              entry.sha256,
              entry.size,
            ),
            target = path.join(
              stage,
              "blobs",
              entry.sha256.slice(0, 2),
              entry.sha256,
            );
          await safeDirectory(path.dirname(target), true);
          await fs.copyFile(source, target, constants.COPYFILE_EXCL);
          await fs.chmod(target, 0o600);
          if ((await sha256File(target)) !== entry.sha256)
            throw Error("导出清单包校验失败");
        }
        await atomicStorageJson(path.join(stage, "manifest.json"), manifest);
        if (await pathExists(bundleDir)) throw Error("清单包目标被占用");
        await fs.rename(stage, bundleDir);
        return { path: bundleDir, manifest, objects: unique.size };
      } finally {
        await fs.rm(stage, { recursive: true, force: true });
      }
    });
  }
  async rebuildFromBundle(
    bundleDir: string,
    destination: string,
  ): Promise<InstanceManifest> {
    await safeDirectory(bundleDir);
    const manifest = await readStorageJson(
      path.join(bundleDir, "manifest.json"),
    );
    validateInstanceManifest(manifest);
    // Validate the complete bundle before adding any objects or touching a game root.
    for (const entry of [...manifest.files, ...manifest.sharedFiles]) {
      const source = path.join(
        bundleDir,
        "blobs",
        entry.sha256.slice(0, 2),
        entry.sha256,
      );
      if (
        (await fs.lstat(source)).size !== entry.size ||
        (await sha256File(source)) !== entry.sha256
      )
        throw Error("清单包内容损坏或缺失");
    }
    for (const entry of new Map<string, StoredFile>(
      [...manifest.files, ...manifest.sharedFiles].map((f: StoredFile) => [
        f.sha256,
        f,
      ]),
    ).values())
      await this.contentStore.putFile(
        path.join(bundleDir, "blobs", entry.sha256.slice(0, 2), entry.sha256),
        entry.sha256,
      );
    return this.reconstruct(manifest, destination);
  }
  async stats(manifests?: InstanceManifest[]): Promise<StorageStats> {
    const objects = await this.contentStore.objects();
    const recorded: InstanceManifest[] = manifests ? [...manifests] : [];
    if (!manifests && (await pathExists(this.registry))) {
      await safeDirectory(this.registry);
      for (const name of await fs.readdir(this.registry))
        if (/^[a-f0-9]{64}\.json$/.test(name)) {
          const record = await readStorageJson(path.join(this.registry, name));
          validateInstanceManifest(record.manifest);
          if (
            typeof record.instanceDir === "string" &&
            (await pathExists(
              path.join(record.instanceDir, ".ldfcl", "manifest.json"),
            ))
          )
            recorded.push(record.manifest);
        }
    }
    const files = recorded.flatMap((m) => [...m.files, ...m.sharedFiles]);
    const logicalBytes = files.reduce((sum, f) => sum + f.size, 0),
      storedBytes = objects.reduce((sum, f) => sum + f.size, 0);
    const uniqueReferencedBytes = [
      ...new Map(files.map((f) => [f.sha256, f])).values(),
    ].reduce((sum, f) => sum + f.size, 0);
    return {
      objects: objects.length,
      storedBytes,
      logicalBytes,
      referencedFiles: files.length,
      deduplicatedBytes: Math.max(0, logicalBytes - uniqueReferencedBytes),
      manifests: recorded.length,
      hardlinkedFiles: files.filter((f) => f.materialization === "hardlink")
        .length,
      copiedFiles: files.filter((f) => f.materialization !== "hardlink").length,
    };
  }
}
