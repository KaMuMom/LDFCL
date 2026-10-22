import fs from "node:fs/promises";
import { constants, createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { StoredFile } from "../../shared/instance-storage";

export async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch (error: any) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
export function storageRelative(value: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 2048 ||
    /[\\\x00-\x1f<>:"|?*]/.test(value) ||
    path.isAbsolute(value)
  )
    throw Error("存储路径不安全");
  for (const part of value.split("/")) {
    if (
      !part ||
      part === "." ||
      part === ".." ||
      /[. ]$/.test(part) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    )
      throw Error("存储路径不安全");
  }
  return value;
}
export function storagePath(root: string, relative: string): string {
  storageRelative(relative);
  const target = path.resolve(root, ...relative.split("/"));
  if (!target.startsWith(path.resolve(root) + path.sep))
    throw Error("存储路径越界");
  return target;
}
/** Inspect each ancestor too: a link above the selected instance must not redirect writes. */
export async function safeDirectory(
  directory: string,
  create = false,
): Promise<void> {
  if (!path.isAbsolute(directory)) throw Error("存储目录必须为绝对路径");
  const absolute = path.resolve(directory);
  const base = path.parse(absolute).root;
  let current = base;
  for (const part of path
    .relative(base, absolute)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, part);
    if (create)
      await fs.mkdir(current).catch((error: any) => {
        if (error.code !== "EEXIST") throw error;
      });
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw Error("存储目录包含链接或不是普通文件夹");
  }
}
export async function safeFile(file: string): Promise<void> {
  await safeDirectory(path.dirname(file));
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw Error("存储文件包含链接或特殊文件");
}
export async function sha256File(file: string): Promise<string> {
  await safeFile(file);
  const handle = await fs.open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
  );
  try {
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false }))
      hash.update(chunk);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}
export async function atomicStorageJson(
  file: string,
  value: unknown,
): Promise<void> {
  await safeDirectory(path.dirname(file), true);
  if (await pathExists(file)) await safeFile(file);
  const stage = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(stage, JSON.stringify(value, null, 2), { flag: "wx" });
    await fs.rename(stage, file);
  } finally {
    await fs.rm(stage, { force: true });
  }
}
export async function readStorageJson(
  file: string,
  maxBytes = 32 * 1024 * 1024,
): Promise<any> {
  await safeFile(file);
  if ((await fs.stat(file)).size > maxBytes)
    throw Error("存储元数据超过大小限制");
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    throw Error("存储元数据格式无效");
  }
}

// A file lock also excludes another Node/Electron process. Only ESRCH proves a
// crashed owner is gone. A reused/live PID or malformed lock stays blocked.
export async function withInstanceStorageLock<T>(
  instanceDir: string,
  work: () => Promise<T>,
): Promise<T> {
  await safeDirectory(instanceDir);
  const control = path.join(instanceDir, ".ldfcl");
  await safeDirectory(control, true);
  const lock = path.join(control, "storage-operation.lock");
  let handle;
  try {
    handle = await fs.open(lock, "wx");
  } catch (error: any) {
    if (error.code !== "EEXIST") throw error;
    const busy = () =>
      Error("实例存储操作正在执行；无法确认旧进程已退出时请稍后重试");
    const recoveryPath = `${lock}.recovery`;
    let recovery;
    try {
      recovery = await fs.open(recoveryPath, "wx");
    } catch {
      throw busy();
    }
    try {
      const existing = await readStorageJson(lock, 4096);
      if (!Number.isSafeInteger(existing.pid) || existing.pid <= 0)
        throw busy();
      let definitelyExited = false;
      try {
        process.kill(existing.pid, 0);
      } catch (probe: any) {
        if (probe.code === "ESRCH") definitelyExited = true;
      }
      if (!definitelyExited) throw busy();
      await fs.unlink(lock);
      try {
        handle = await fs.open(lock, "wx");
      } catch {
        throw busy();
      }
    } finally {
      await recovery.close();
      await fs.unlink(recoveryPath).catch(() => {});
    }
  }
  try {
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
    );
    await recoverStorageTransaction(instanceDir);
    return await work();
  } finally {
    await handle.close();
    await fs.unlink(lock).catch(() => {});
  }
}

export interface StorageTransactionJournal {
  schemaVersion: 1;
  id: string;
  state: "prepared" | "committed";
  paths: { path: string; existed: boolean }[];
}
function validateJournal(
  value: any,
): asserts value is StorageTransactionJournal {
  if (
    value?.schemaVersion !== 1 ||
    !/^[a-f0-9-]{36}$/.test(value.id) ||
    !["prepared", "committed"].includes(value.state) ||
    !Array.isArray(value.paths) ||
    value.paths.length > 1000
  )
    throw Error("恢复事务记录无效");
  for (const entry of value.paths) {
    storageRelative(entry.path);
    if (
      entry.path.split("/").some((v: string) => v === ".ldfcl") ||
      typeof entry.existed !== "boolean"
    )
      throw Error("恢复事务路径无效");
  }
}
async function removePlain(file: string): Promise<void> {
  if (!(await pathExists(file))) return;
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink()) throw Error("事务目标包含链接");
  if (stat.isDirectory()) {
    for (const name of await fs.readdir(file))
      await removePlain(path.join(file, name));
    await fs.rmdir(file);
  } else if (stat.isFile()) {
    await fs.unlink(file);
  } else throw Error("事务目标包含特殊文件");
}
export async function recoverStorageTransaction(
  instanceDir: string,
): Promise<void> {
  const transactions = path.join(instanceDir, ".ldfcl", "transactions");
  if (!(await pathExists(transactions))) return;
  await safeDirectory(transactions);
  for (const id of await fs.readdir(transactions)) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("未知实例事务目录");
    const root = path.join(transactions, id);
    await safeDirectory(root);
    const journalPath = path.join(root, "journal.json");
    if (!(await pathExists(journalPath))) {
      await removePlain(root);
      continue;
    }
    const journal = await readStorageJson(journalPath);
    validateJournal(journal);
    if (journal.id !== id) throw Error("事务记录标识不符");
    if (journal.state === "prepared") {
      for (const entry of [...journal.paths].reverse()) {
        const target = storagePath(instanceDir, entry.path);
        const backup = storagePath(path.join(root, "before"), entry.path);
        const staged = storagePath(path.join(root, "after"), entry.path);
        if (entry.existed && (await pathExists(backup))) {
          await removePlain(target);
          await safeDirectory(path.dirname(target), true);
          await fs.rename(backup, target);
        } else if (!entry.existed && !(await pathExists(staged)))
          await removePlain(target);
      }
    }
    await removePlain(root);
  }
}
/** Stage everything before touching live paths. The durable journal rolls back a
 * partial publish on the next operation, including interruption between renames. */
export async function publishStoragePaths(
  instanceDir: string,
  scopes: string[],
  populate: (stage: string) => Promise<void>,
  onStep?: (step: number) => Promise<void>,
): Promise<void> {
  const unique = [...new Set(scopes)];
  for (const relative of unique) {
    storageRelative(relative);
    if (relative.includes("/") || relative === ".ldfcl")
      throw Error("事务仅支持实例顶层数据路径");
  }
  const id = randomUUID();
  const root = path.join(instanceDir, ".ldfcl", "transactions", id);
  const after = path.join(root, "after"),
    before = path.join(root, "before");
  await safeDirectory(after, true);
  await safeDirectory(before, true);
  let prepared = false;
  try {
    await populate(after);
    const journal: StorageTransactionJournal = {
      schemaVersion: 1,
      id,
      state: "prepared",
      paths: [],
    };
    for (const relative of unique) {
      const target = storagePath(instanceDir, relative);
      const existed = await pathExists(target);
      if (existed) await assertStorageTree(target);
      journal.paths.push({ path: relative, existed });
    }
    await atomicStorageJson(path.join(root, "journal.json"), journal);
    prepared = true;
    let step = 0;
    for (const entry of journal.paths) {
      const target = storagePath(instanceDir, entry.path);
      const staged = storagePath(after, entry.path);
      if (entry.existed)
        await fs.rename(target, storagePath(before, entry.path));
      if (await pathExists(staged)) await fs.rename(staged, target);
      if (onStep) await onStep(++step);
    }
    journal.state = "committed";
    await atomicStorageJson(path.join(root, "journal.json"), journal);
    await removePlain(root);
  } catch (error) {
    if (prepared) await recoverStorageTransaction(instanceDir);
    else await removePlain(root);
    throw error;
  }
}
export async function assertStorageTree(file: string): Promise<void> {
  await safeDirectory(path.dirname(file));
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink()) throw Error("实例数据包含链接");
  if (stat.isDirectory()) {
    for (const name of await fs.readdir(file)) {
      storageRelative(name);
      await assertStorageTree(path.join(file, name));
    }
  } else if (!stat.isFile()) throw Error("实例数据包含特殊文件");
}
/** Windows will not replace a read-only destination. Retain a temporary link to
 * the old inode so its CAS permissions can be restored after the atomic rename.
 * No old file bytes are ever opened for writing. */
export async function replaceStorageFile(
  stage: string,
  target: string,
): Promise<void> {
  await safeFile(stage);
  if (!(await pathExists(target))) {
    await fs.rename(stage, target);
    return;
  }
  await safeFile(target);
  const stat = await fs.stat(target);
  if (process.platform !== "win32" || stat.mode & 0o200) {
    await fs.rename(stage, target);
    return;
  }
  const original = `${target}.${randomUUID()}.permissions`;
  if (stat.nlink > 1) await fs.link(target, original);
  let published = false;
  try {
    await fs.chmod(target, 0o600);
    await fs.rename(stage, target);
    published = true;
  } finally {
    if (stat.nlink > 1) {
      try {
        await fs.chmod(original, stat.mode & 0o777);
      } finally {
        await fs.unlink(original).catch(() => {});
      }
    } else if (!published && (await pathExists(target)))
      await fs.chmod(target, stat.mode & 0o777);
  }
}
/** Break a managed immutable link before any caller intentionally edits in place. */
export async function ensurePrivateFile(file: string): Promise<void> {
  await safeFile(file);
  const stat = await fs.stat(file);
  if (stat.nlink <= 1 && stat.mode & 0o200) return;
  const stage = `${file}.${randomUUID()}.private`;
  try {
    await fs.copyFile(file, stage, constants.COPYFILE_EXCL);
    await fs.chmod(stage, 0o600);
    await replaceStorageFile(stage, file);
  } finally {
    await fs.rm(stage, { force: true });
  }
}

export class ContentStore {
  readonly root: string;
  constructor(options: { dataDir: string } | string) {
    const dataDir = typeof options === "string" ? options : options.dataDir;
    if (!path.isAbsolute(dataDir)) throw Error("内容存储目录必须为绝对路径");
    this.root = path.join(dataDir, "store", "sha256");
  }
  objectPath(hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw Error("SHA256 标识无效");
    return path.join(this.root, hash.slice(0, 2), hash);
  }
  async verify(hash: string, size?: number): Promise<string> {
    const file = this.objectPath(hash);
    await safeFile(file);
    if (
      (size !== undefined && (await fs.stat(file)).size !== size) ||
      (await sha256File(file)) !== hash
    )
      throw Error(`内容存储 SHA256 校验失败：${hash}`);
    return file;
  }
  async putFile(
    source: string,
    expectedHash?: string,
  ): Promise<{ sha256: string; size: number }> {
    await safeFile(source);
    const hash = await sha256File(source);
    if (expectedHash && expectedHash !== hash)
      throw Error("源文件 SHA256 校验失败");
    const target = this.objectPath(hash);
    await safeDirectory(path.dirname(target), true);
    if (await pathExists(target)) {
      await this.verify(hash);
      return { sha256: hash, size: (await fs.stat(target)).size };
    }
    const stage = `${target}.${randomUUID()}.part`;
    try {
      await fs.copyFile(source, stage, constants.COPYFILE_EXCL);
      if ((await sha256File(stage)) !== hash)
        throw Error("文件复制期间发生变化");
      // link is an atomic no-replace publish: concurrent writers cannot overwrite
      // an object already referenced by another instance.
      await fs.chmod(stage, 0o444);
      try {
        await fs.link(stage, target);
      } catch (error: any) {
        if (error.code === "EEXIST") {
          /* Another verified publisher won. */
        } else if (
          ["EXDEV", "EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP"].includes(
            error.code,
          )
        ) {
          // FAT/exFAT cannot publish an object with link(). An exclusive sibling
          // lock prevents another launcher from reading a partially copied object.
          const lockPath = `${target}.publish-lock`;
          let lock;
          try {
            lock = await fs.open(lockPath, "wx");
          } catch (lockError: any) {
            if (lockError.code === "EEXIST")
              throw Error("内容存储对象正在发布，请稍后重试");
            throw lockError;
          }
          try {
            if (!(await pathExists(target))) {
              // The unique stage is already verified and rename stays on the
              // same filesystem, including when the source file was elsewhere.
              await fs.rename(stage, target);
            }
          } finally {
            await lock.close();
            await fs.unlink(lockPath).catch(() => {});
          }
        } else throw error;
      }
      await this.verify(hash);
      return { sha256: hash, size: (await fs.stat(target)).size };
    } finally {
      await fs.unlink(stage).catch(() => {});
    }
  }
  async materialize(
    entry: Pick<StoredFile, "sha256" | "size" | "mutable">,
    destination: string,
    preferHardlink = !entry.mutable,
  ): Promise<{
    materialization: "hardlink" | "copy";
    fallbackReason?: string;
  }> {
    const source = await this.verify(entry.sha256, entry.size);
    await safeDirectory(path.dirname(destination), true);
    if (await pathExists(destination)) throw Error("实例物化目标已存在");
    let fallbackReason: string | undefined;
    if (preferHardlink && !entry.mutable) {
      try {
        await fs.link(source, destination);
        return { materialization: "hardlink" };
      } catch (error: any) {
        if (error.code === "EEXIST") throw error;
        fallbackReason = [
          "EXDEV",
          "EPERM",
          "EACCES",
          "ENOTSUP",
          "EOPNOTSUPP",
        ].includes(error.code)
          ? `hardlink-${error.code}`
          : undefined;
        if (!fallbackReason) throw error;
      }
    }
    await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
    await fs.chmod(destination, 0o600);
    if ((await sha256File(destination)) !== entry.sha256) {
      await fs.unlink(destination);
      throw Error("物化文件 SHA256 校验失败");
    }
    return {
      materialization: "copy",
      ...(fallbackReason ? { fallbackReason } : {}),
    };
  }
  /** Explicit recovery only: the independent source must reproduce the exact
   * expected digest before a corrupted CAS object can be atomically replaced.
   * Existing instance links to the corrupt old inode remain detectable; callers
   * restore their own instance separately instead of silently rewriting others. */
  async repairFromVerifiedFile(
    source: string,
    expectedHash: string,
  ): Promise<void> {
    const target = this.objectPath(expectedHash);
    if ((await sha256File(source)) !== expectedHash)
      throw Error("恢复原件 SHA256 校验失败");
    if (!(await pathExists(target))) {
      await this.putFile(source, expectedHash);
      return;
    }
    try {
      await this.verify(expectedHash);
      return;
    } catch {
      await safeFile(target);
    }
    const lockFile = `${target}.repair-lock`;
    let lock;
    try {
      lock = await fs.open(lockFile, "wx");
    } catch {
      throw Error("内容存储恢复正在执行，请稍后重试");
    }
    const stage = `${target}.${randomUUID()}.repair`;
    try {
      await fs.copyFile(source, stage, constants.COPYFILE_EXCL);
      if ((await sha256File(stage)) !== expectedHash)
        throw Error("恢复文件复制期间发生变化");
      await fs.chmod(stage, 0o444);
      await replaceStorageFile(stage, target);
      await this.verify(expectedHash);
    } finally {
      await fs.unlink(stage).catch(() => {});
      await lock.close();
      await fs.unlink(lockFile).catch(() => {});
    }
  }
  async objects(): Promise<{ sha256: string; size: number }[]> {
    if (!(await pathExists(this.root))) return [];
    await safeDirectory(this.root);
    const objects: { sha256: string; size: number }[] = [];
    for (const prefix of await fs.readdir(this.root)) {
      if (!/^[a-f0-9]{2}$/.test(prefix)) continue;
      const dir = path.join(this.root, prefix);
      await safeDirectory(dir);
      for (const hash of await fs.readdir(dir))
        if (/^[a-f0-9]{64}$/.test(hash) && hash.startsWith(prefix)) {
          const file = path.join(dir, hash);
          await safeFile(file);
          objects.push({ sha256: hash, size: (await fs.stat(file)).size });
        }
    }
    return objects;
  }
}
