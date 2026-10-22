import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

type PreparedData = { legacyDataDir?: string };
const CONFIG_LIMIT = 16 * 1024 * 1024;
const TRANSLATION_FILE_LIMIT = 4 * 1024 * 1024;
const TRANSLATION_TOTAL_LIMIT = 32 * 1024 * 1024;
const TRANSLATION_COUNT_LIMIT = 256;
const MARKER = "storage-migration.json";
const pending = new Map<string, Promise<PreparedData>>();

function absoluteDirectory(value: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\0") ||
    !path.isAbsolute(value)
  )
    throw new Error("启动器数据目录必须是有效的绝对路径。");
  const resolved = path.resolve(value);
  for (const part of resolved
    .slice(path.parse(resolved).root.length)
    .split(path.sep)) {
    if (
      /[<>:"|?*\x00-\x1f]/.test(part) ||
      /[. ]$/.test(part) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    )
      throw new Error("启动器数据目录包含无效的路径名称。");
  }
  return resolved;
}

async function statIfPresent(file: string) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function requireDirectory(
  stat: Awaited<ReturnType<typeof fs.lstat>>,
  file: string,
): void {
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error(
      `启动器数据路径不是普通目录，或使用了目录联接/符号链接：${file}`,
    );
}

/** Check each existing parent before creating children, including Windows junctions. */
async function ensureParent(directory: string): Promise<void> {
  const parent = path.dirname(directory);
  if (parent !== directory) await ensureParent(parent);
  const stat = await statIfPresent(directory);
  if (stat) {
    requireDirectory(stat, directory);
    return;
  }
  try {
    await fs.mkdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  requireDirectory(await fs.lstat(directory), directory);
}

async function boundedFile(
  file: string,
  maximum: number,
): Promise<Buffer | undefined> {
  const before = await statIfPresent(file);
  if (!before) return undefined;
  if (before.isSymbolicLink() || !before.isFile())
    throw new Error(`迁移配置必须是普通文件，不能使用链接：${file}`);
  if (before.size > maximum) throw new Error(`迁移配置超过允许的大小：${file}`);
  const handle = await fs.open(file, "r");
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size > maximum
    )
      throw new Error(`迁移配置在读取前发生变化：${file}`);
    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= maximum) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximum + 1 - size));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > maximum) throw new Error(`迁移配置超过允许的大小：${file}`);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (
      size !== opened.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs
    )
      throw new Error(`迁移配置在读取时发生变化，请重试：${file}`);
    return Buffer.concat(chunks, size);
  } finally {
    await handle.close();
  }
}

async function verifyWritable(directory: string): Promise<void> {
  const probe = path.join(directory, `.ldfcl-write-${randomUUID()}.tmp`);
  const handle = await fs.open(probe, "wx", 0o600);
  try {
    await handle.writeFile("LDFCL");
  } finally {
    try {
      await handle.close();
    } finally {
      await fs.rm(probe);
    }
  }
}

async function existingDirectory(
  destination: string,
): Promise<PreparedData | undefined> {
  const stat = await statIfPresent(destination);
  if (!stat) return undefined;
  requireDirectory(stat, destination);
  await verifyWritable(destination);
  const bytes = await boundedFile(path.join(destination, MARKER), 64 * 1024);
  if (!bytes) return {};
  let marker: unknown;
  try {
    marker = JSON.parse(bytes.toString("utf8"));
  } catch {
    return {};
  }
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return {};
  const source = (marker as { sourceDataDir?: unknown }).sourceDataDir;
  if (typeof source !== "string") return {};
  try {
    const legacyDataDir = absoluteDirectory(source);
    const key = (value: string) =>
      process.platform === "win32" ? value.toLowerCase() : value;
    return key(legacyDataDir) === key(destination) ? {} : { legacyDataDir };
  } catch {
    return {};
  }
}

async function copyLegacy(
  stage: string,
  legacyDirectory?: string,
): Promise<PreparedData & { files: string[] }> {
  const files: string[] = [];
  if (!legacyDirectory) return { files };
  const source = absoluteDirectory(legacyDirectory);
  const stat = await statIfPresent(source);
  if (!stat) return { files };
  requireDirectory(stat, source);
  const copy = async (relative: string, maximum: number) => {
    const bytes = await boundedFile(path.join(source, relative), maximum);
    if (!bytes) return 0;
    const target = path.join(stage, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes, { flag: "wx", mode: 0o600 });
    files.push(relative.replace(/\\/g, "/"));
    return bytes.length;
  };
  for (const filename of ["launcher.json", "accounts.json"])
    await copy(filename, CONFIG_LIMIT);
  const translations = path.join(source, "translations");
  const translationsStat = await statIfPresent(translations);
  if (translationsStat) {
    requireDirectory(translationsStat, translations);
    const mods = path.join(translations, "mods");
    const modsStat = await statIfPresent(mods);
    if (modsStat) {
      requireDirectory(modsStat, mods);
      let count = 0,
        total = 0;
      const entries = await fs.opendir(mods);
      for await (const entry of entries) {
        if (!/\.json$/i.test(entry.name)) continue;
        if (++count > TRANSLATION_COUNT_LIMIT)
          throw new Error("迁移的模组翻译文件数量超过 256 个。");
        total += await copy(
          path.join("translations", "mods", entry.name),
          TRANSLATION_FILE_LIMIT,
        );
        if (total > TRANSLATION_TOTAL_LIMIT)
          throw new Error("迁移的模组翻译文件总大小超过 32 MiB。");
      }
    }
  }
  return { files, ...(files.length ? { legacyDataDir: source } : {}) };
}

async function prepare(
  destination: string,
  legacyDirectory?: string,
): Promise<PreparedData> {
  let stage: string | undefined;
  try {
    await ensureParent(path.dirname(destination));
    const existing = await existingDirectory(destination);
    if (existing) return existing;
    stage = await fs.mkdtemp(
      path.join(path.dirname(destination), `.ldfcl-migration-`),
    );
    const copied = await copyLegacy(stage, legacyDirectory);
    await fs.writeFile(
      path.join(stage, MARKER),
      JSON.stringify(
        {
          formatVersion: 1,
          createdAt: new Date().toISOString(),
          ...(copied.legacyDataDir
            ? { sourceDataDir: copied.legacyDataDir }
            : {}),
          files: copied.files,
        },
        null,
        2,
      ),
      { flag: "wx", mode: 0o600 },
    );
    await verifyWritable(stage);
    // Re-check after copying: another process may have initialized its own data directory.
    const appeared = await existingDirectory(destination);
    if (appeared) return appeared;
    try {
      await fs.rename(stage, destination);
    } catch (error) {
      if (
        ![
          "EEXIST",
          "ENOTEMPTY",
          "EPERM",
          "EACCES",
          "EISDIR",
          "ENOTDIR",
        ].includes((error as NodeJS.ErrnoException).code || "")
      )
        throw error;
      const winner = await existingDirectory(destination);
      if (!winner) throw error;
      return winner;
    }
    stage = undefined;
    return copied.legacyDataDir ? { legacyDataDir: copied.legacyDataDir } : {};
  } catch (error) {
    throw new Error(
      `无法准备启动器数据目录 ${destination}：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    if (stage) await fs.rm(stage, { recursive: true, force: true });
  }
}

/** Initialize once; an existing destination never re-imports deleted accounts or settings. */
export async function prepareLauncherDataDirectory(
  destination: string,
  legacyDirectory?: string,
): Promise<PreparedData> {
  const resolved = absoluteDirectory(destination);
  const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const active = pending.get(key);
  if (active) return active;
  const operation = prepare(resolved, legacyDirectory);
  pending.set(key, operation);
  try {
    return await operation;
  } finally {
    if (pending.get(key) === operation) pending.delete(key);
  }
}
