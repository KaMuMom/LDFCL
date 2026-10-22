import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type {
  InstanceSnapshot,
  SnapshotPreview,
  StoredFile,
  StorageDiff,
} from "../../shared/instance-storage";
import {
  ContentStore,
  atomicStorageJson,
  pathExists,
  readStorageJson,
  safeDirectory,
  storagePath,
  withInstanceStorageLock,
  publishStoragePaths,
} from "./content-store";
import {
  captureStorageTree,
  diffStoredFiles,
  validateStoredFiles,
  type InstanceStorageOptions,
} from "./instance-manifest";

/** These are the entire rollback boundary. Worlds, logs, screenshots, runtime,
 * accounts, caches, native libraries and migration originals are never restored. */
export const SNAPSHOT_PATHS = [
  "mods",
  "config",
  "resourcepacks",
  "shaderpacks",
  "options.txt",
  "optionsof.txt",
  "optionsshaders.txt",
  "servers.dat",
  "instance.json",
  ".ldfcl-content.json",
] as const;
const PRESERVED = [
  "saves",
  "logs",
  "screenshots",
  "crash-reports",
  ".ldfcl/migration-backups",
  ".ldfcl/natives",
];
function included(relative: string): boolean {
  return SNAPSHOT_PATHS.some(
    (scope) => relative === scope || relative.startsWith(scope + "/"),
  );
}
export function validateInstanceSnapshot(
  value: any,
): asserts value is InstanceSnapshot {
  if (
    value?.schemaVersion !== 1 ||
    value.kind !== "ldfcl-instance-snapshot" ||
    !/^[a-f0-9-]{36}$/.test(value.id) ||
    typeof value.name !== "string" ||
    typeof value.createdAt !== "string" ||
    !Array.isArray(value.scopes) ||
    JSON.stringify(value.scopes) !== JSON.stringify(SNAPSHOT_PATHS)
  )
    throw Error("快照格式或回滚范围无效");
  validateStoredFiles(value.files, value.directories);
  for (const entry of [
    ...value.files,
    ...value.directories.map((p: string) => ({ path: p })),
  ])
    if (!included(entry.path)) throw Error("快照包含回滚范围之外的路径");
}
export interface SnapshotServiceOptions extends InstanceStorageOptions {
  /** A host may fault-inject durable publish steps for filesystem recovery tests. */
  onTransactionStep?: (step: number) => Promise<void>;
}
export class SnapshotService {
  readonly contentStore: ContentStore;
  constructor(readonly options: SnapshotServiceOptions) {
    this.contentStore = new ContentStore(options);
  }
  private async assertInstance(instanceDir: string): Promise<void> {
    await safeDirectory(instanceDir);
    if (this.options.minecraftRoot) {
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
        throw Error("快照实例不在当前游戏根目录");
    }
  }
  private file(instanceDir: string, snapshotId: string) {
    if (typeof snapshotId !== "string" || !/^[a-f0-9-]{36}$/.test(snapshotId))
      throw Error("快照标识无效");
    return path.join(instanceDir, ".ldfcl", "snapshots", `${snapshotId}.json`);
  }
  private async read(
    instanceDir: string,
    snapshotId: string,
  ): Promise<InstanceSnapshot> {
    const value = await readStorageJson(this.file(instanceDir, snapshotId));
    validateInstanceSnapshot(value);
    if (value.id !== snapshotId) throw Error("快照标识不符");
    return value;
  }
  private async capture(
    instanceDir: string,
    name: string,
  ): Promise<InstanceSnapshot> {
    const tree = await captureStorageTree(
      instanceDir,
      this.contentStore,
      (relative) => included(relative),
    );
    const snapshot: InstanceSnapshot = {
      schemaVersion: 1,
      kind: "ldfcl-instance-snapshot",
      id: randomUUID(),
      name: name.trim().slice(0, 200) || "实例快照",
      createdAt: new Date().toISOString(),
      ...tree,
      scopes: [...SNAPSHOT_PATHS],
      logicalBytes: tree.files.reduce((sum, file) => sum + file.size, 0),
    };
    await atomicStorageJson(this.file(instanceDir, snapshot.id), snapshot);
    return snapshot;
  }
  async create(
    instanceDir: string,
    options: { name?: string } = {},
  ): Promise<InstanceSnapshot> {
    await this.assertInstance(instanceDir);
    return withInstanceStorageLock(instanceDir, () =>
      this.capture(instanceDir, options.name || "手动快照"),
    );
  }
  async list(instanceDir: string): Promise<InstanceSnapshot[]> {
    await this.assertInstance(instanceDir);
    const root = path.join(instanceDir, ".ldfcl", "snapshots");
    if (!(await pathExists(root))) return [];
    await safeDirectory(root);
    const snapshots: InstanceSnapshot[] = [];
    for (const name of await fs.readdir(root)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      snapshots.push(await this.read(instanceDir, name.slice(0, -5)));
    }
    return snapshots.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  private async current(instanceDir: string) {
    return captureStorageTree(instanceDir, undefined, (relative) =>
      included(relative),
    );
  }
  private makePreview(
    snapshot: InstanceSnapshot,
    current: { files: StoredFile[]; directories: string[] },
  ): SnapshotPreview {
    const canonical = (files: StoredFile[]) =>
      files
        .map((f) => [f.path, f.sha256, f.size])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    const previewId = createHash("sha256")
      .update(
        JSON.stringify({
          snapshot: snapshot.id,
          before: canonical(current.files),
          beforeDirs: [...current.directories].sort(),
          after: canonical(snapshot.files),
          afterDirs: [...snapshot.directories].sort(),
        }),
      )
      .digest("hex");
    return {
      snapshotId: snapshot.id,
      previewId,
      diff: diffStoredFiles(current.files, snapshot.files),
      preservedPaths: [...PRESERVED],
    };
  }
  async previewRestore(
    instanceDir: string,
    snapshotId: string,
  ): Promise<SnapshotPreview> {
    await this.assertInstance(instanceDir);
    return withInstanceStorageLock(instanceDir, async () => {
      const snapshot = await this.read(instanceDir, snapshotId);
      for (const file of snapshot.files)
        await this.contentStore.verify(file.sha256, file.size);
      return this.makePreview(snapshot, await this.current(instanceDir));
    });
  }
  async diff(instanceDir: string, snapshotId: string): Promise<StorageDiff> {
    return (await this.previewRestore(instanceDir, snapshotId)).diff;
  }
  async restore(
    instanceDir: string,
    snapshotId: string,
    options: { expectedPreviewId?: string } = {},
  ): Promise<{
    snapshotId: string;
    preRestoreSnapshotId: string;
    diff: StorageDiff;
    restoredFiles: number;
    preservedPaths: string[];
  }> {
    await this.assertInstance(instanceDir);
    return withInstanceStorageLock(instanceDir, async () => {
      const snapshot = await this.read(instanceDir, snapshotId);
      for (const file of snapshot.files)
        await this.contentStore.verify(file.sha256, file.size);
      const preview = this.makePreview(
        snapshot,
        await this.current(instanceDir),
      );
      if (
        options.expectedPreviewId &&
        options.expectedPreviewId !== preview.previewId
      )
        throw Error("实例在预览后已发生变化，请重新预览回滚");
      // Protection is committed before any live path is moved. It survives both
      // successful restore and publish failure so users can explicitly undo it.
      const protection = await this.capture(
        instanceDir,
        `回滚前保护 · ${snapshot.name}`,
      );
      await publishStoragePaths(
        instanceDir,
        [...SNAPSHOT_PATHS],
        async (stage) => {
          for (const dir of snapshot.directories)
            await safeDirectory(storagePath(stage, dir), true);
          for (const file of snapshot.files) {
            // Snapshots always copy writable state. Immutable archive links remain
            // read-only and can be replaced atomically by content installation.
            await this.contentStore.materialize(
              file,
              storagePath(stage, file.path),
            );
          }
        },
        this.options.onTransactionStep,
      );
      return {
        snapshotId,
        preRestoreSnapshotId: protection.id,
        diff: preview.diff,
        restoredFiles: snapshot.files.length,
        preservedPaths: [...PRESERVED],
      };
    });
  }
}
