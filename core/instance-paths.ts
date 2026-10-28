import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { GameDirectory, Instance } from "../shared/types";
import { gameDirectoryRoots, safeGameVersionId } from "./game-directories";

export function instanceVersionDirectoryId(instance: Instance): string {
  return safeGameVersionId(
    instance.versionDirectory || instance.importedVersionId || instance.id,
  );
}

export function instanceGameDirectory(
  minecraftRoot: string,
  instance: Instance,
): string {
  if (!path.isAbsolute(minecraftRoot))
    throw new Error("游戏目录必须使用绝对路径");
  return path.join(
    minecraftRoot,
    "versions",
    instanceVersionDirectoryId(instance),
  );
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch (error: any) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function plainDirectory(file: string): Promise<void> {
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error(`目录包含链接或不是普通文件夹：${file}`);
}

/** No links are followed, including junctions within saves/mods/config. */
export async function assertPlainTree(file: string): Promise<void> {
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink())
    throw new Error(`不支持符号链接或目录联接：${file}`);
  if (stat.isDirectory()) {
    for (const name of await fs.readdir(file))
      await assertPlainTree(path.join(file, name));
  } else if (!stat.isFile()) throw new Error(`不支持特殊文件：${file}`);
}

async function versionsRoot(minecraftRoot: string): Promise<string> {
  if (!path.isAbsolute(minecraftRoot))
    throw new Error("游戏目录必须使用绝对路径");
  // Existing registrations must never resurrect a moved/deleted game root.
  // Creating the default root belongs to explicit launcher initialization.
  if (!(await exists(minecraftRoot)))
    throw new Error("游戏目录已不存在，可能已被移动或删除，请重新定位。");
  await plainDirectory(minecraftRoot);
  const versions = path.join(minecraftRoot, "versions");
  await fs.mkdir(versions).catch((error: any) => {
    if (error.code !== "EEXIST") throw error;
  });
  await plainDirectory(versions);
  const relative = path.relative(
    await fs.realpath(minecraftRoot),
    await fs.realpath(versions),
  );
  if (relative !== "versions") throw new Error("版本目录路径越界");
  return versions;
}

export async function assertInstanceGameDirectory(
  minecraftRoot: string,
  instance: Instance,
): Promise<string> {
  const versions = await versionsRoot(minecraftRoot);
  const target = path.join(versions, instanceVersionDirectoryId(instance));
  await plainDirectory(target);
  const relative = path.relative(
    await fs.realpath(versions),
    await fs.realpath(target),
  );
  if (relative !== instanceVersionDirectoryId(instance))
    throw new Error("版本目录路径越界");
  // Check each immediate entry, not every block/region file in large worlds.
  // Content operations validate their own nested paths; migration does a full walk.
  for (const name of await fs.readdir(target)) {
    const stat = await fs.lstat(path.join(target, name));
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
      throw new Error(`版本目录包含链接或特殊文件：${name}`);
  }
  return target;
}

function readableName(
  instance: Pick<Instance, "name" | "version" | "loader">,
): string {
  try {
    return safeGameVersionId(instance.name.trim());
  } catch {}
  return safeGameVersionId(
    `${instance.version}${instance.loader === "vanilla" ? "" : "-" + instance.loader}`,
  );
}

/** Reserve by mkdir: an existing file, folder, or Windows case alias is never reused. */
export async function allocateVersionDirectory(
  minecraftRoot: string,
  preferred: string,
): Promise<{ id: string; path: string }> {
  const versions = await versionsRoot(minecraftRoot);
  const base = safeGameVersionId(preferred).slice(0, 165);
  for (let suffix = 1; suffix < 100000; suffix++) {
    const id = suffix === 1 ? base : `${base}-${suffix}`;
    if (
      (await fs.readdir(versions)).some(
        (entry) => entry.toLowerCase() === id.toLowerCase(),
      )
    )
      continue;
    const target = path.join(versions, id);
    try {
      await fs.mkdir(target);
      return { id, path: target };
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  throw new Error("无法分配唯一版本文件夹");
}

async function readProfile(root: string, id: string): Promise<any> {
  safeGameVersionId(id);
  const versions = await versionsRoot(root);
  const folder = path.join(versions, id);
  await plainDirectory(folder);
  const file = path.join(folder, `${id}.json`);
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024)
    throw new Error("版本配置不是有效的普通文件");
  const metadata = JSON.parse(await fs.readFile(file, "utf8"));
  if (metadata?.id !== id) throw new Error("版本配置标识不符");
  return metadata;
}

async function clientSource(
  root: string,
  id: string,
  vanillaVersion: string,
  seen = new Set<string>(),
): Promise<string | undefined> {
  if (seen.size > 8 || seen.has(id)) throw new Error("版本继承循环或层数异常");
  seen.add(id);
  let own: any;
  try {
    own = await readProfile(root, id);
  } catch (error: any) {
    // A known official parent can be completed on launch. Missing loader
    // profiles are never guessed or substituted with another installation.
    if (error.code === "ENOENT" && id === vanillaVersion) return undefined;
    throw error;
  }
  const clientId = safeGameVersionId(own.jar || id);
  const client = path.join(root, "versions", clientId, `${clientId}.jar`);
  if (await exists(client)) {
    await plainDirectory(path.dirname(client));
    const stat = await fs.lstat(client);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("客户端 JAR 包含链接");
    return client;
  }
  if (own.inheritsFrom)
    return clientSource(
      root,
      safeGameVersionId(own.inheritsFrom),
      vanillaVersion,
      seen,
    );
  return undefined;
}

const MIGRATION_MARKER = "directory-migration.json";

/** Copy old instance data, preserving the source and every occupied native folder.
 * A completed owner/source marker makes a retry safe if Store.save previously failed. */
export async function prepareInstanceDirectories(
  directory: GameDirectory,
  instances: Instance[],
): Promise<{ prepared: number; migrated: number; warnings: string[] }> {
  const { dataDir, minecraftRoot } = gameDirectoryRoots(directory);
  const result = { prepared: 0, migrated: 0, warnings: [] as string[] };
  if (directory.layout === "legacy" && !(await exists(minecraftRoot))) {
    // Legacy data legitimately predates its minecraft child. Only create that
    // one child for an actual pending old-layout migration. A prepared legacy
    // registration whose minecraft child was moved is an unavailable root.
    await plainDirectory(dataDir);
    const sources = await Promise.all(
      instances
        .filter((instance) => !instance.versionDirectory)
        .map((instance) =>
          fs
            .lstat(
              path.join(dataDir, "instances", safeGameVersionId(instance.id)),
            )
            .catch(() => null),
        ),
    );
    if (!sources.some((stat) => stat?.isDirectory() && !stat.isSymbolicLink()))
      throw new Error("游戏目录已不存在，可能已被移动或删除，请重新定位。");
    await fs.mkdir(minecraftRoot).catch((error: any) => {
      if (error.code !== "EEXIST") throw error;
    });
  }
  const versions = await versionsRoot(minecraftRoot);
  for (const instance of instances) {
    try {
      if (instance.versionDirectory) {
        await assertInstanceGameDirectory(minecraftRoot, instance);
        await readProfile(minecraftRoot, instance.versionDirectory);
        result.prepared++;
        continue;
      }
      const source = path.join(
        dataDir,
        "instances",
        safeGameVersionId(instance.id),
      );
      const hasSource = await exists(source);
      if (hasSource) {
        await plainDirectory(path.join(dataDir, "instances"));
        await assertPlainTree(source);
      }
      const canonicalSource = hasSource
        ? await fs.realpath(source)
        : path.resolve(source);
      const sourceKey =
        process.platform === "win32"
          ? canonicalSource.toLowerCase()
          : canonicalSource;
      let recovered: string | undefined;
      for (const id of await fs.readdir(versions)) {
        try {
          safeGameVersionId(id);
          await plainDirectory(path.join(versions, id));
          await plainDirectory(path.join(versions, id, ".ldfcl"));
          const markerFile = path.join(
            versions,
            id,
            ".ldfcl",
            MIGRATION_MARKER,
          );
          const markerStat = await fs.lstat(markerFile);
          if (
            !markerStat.isFile() ||
            markerStat.isSymbolicLink() ||
            markerStat.size > 16384
          )
            continue;
          const marker = JSON.parse(await fs.readFile(markerFile, "utf8"));
          if (
            marker.completed === true &&
            marker.instanceId === instance.id &&
            marker.source === sourceKey
          ) {
            await assertInstanceGameDirectory(minecraftRoot, {
              ...instance,
              versionDirectory: id,
            });
            await readProfile(minecraftRoot, id);
            recovered = id;
            break;
          }
        } catch {}
      }
      if (recovered) {
        instance.versionDirectory = recovered;
        result.prepared++;
        continue;
      }
      if (!hasSource && instance.importedVersionId) {
        const id = safeGameVersionId(instance.importedVersionId);
        await assertInstanceGameDirectory(minecraftRoot, {
          ...instance,
          versionDirectory: id,
        });
        await readProfile(minecraftRoot, id);
        instance.versionDirectory = id;
        result.prepared++;
        continue;
      }
      let sourceId: string | undefined;
      if (hasSource) {
        try {
          const pointer = JSON.parse(
            await fs.readFile(
              path.join(source, ".ldfcl", "launch.json"),
              "utf8",
            ),
          );
          sourceId = safeGameVersionId(pointer.version);
        } catch {
          // Older imported instances may never have written this pointer.
          // Use their explicit import record below, then validate that exact
          // profile; never guess a loader installation from the MC version.
        }
      }
      sourceId ||=
        instance.importedVersionId ||
        (instance.loader === "vanilla" ? instance.version : undefined);
      if (!sourceId)
        throw new Error(
          "版本关联信息待确认，旧实例文件已保留；完成关联后即可使用此实例。",
        );
      safeGameVersionId(sourceId);
      let metadata: any;
      let jar: string | undefined;
      try {
        metadata = await readProfile(minecraftRoot, sourceId);
        jar = await clientSource(minecraftRoot, sourceId, instance.version);
      } catch (error: any) {
        if (instance.loader !== "vanilla" || error.code !== "ENOENT")
          throw error;
        metadata = { _ldfclVanillaSource: instance.version };
      }
      const stage = path.join(versions, `.ldfcl-migration-${randomUUID()}`);
      await fs.mkdir(stage);
      try {
        if (hasSource) {
          for (const name of await fs.readdir(source))
            await fs.cp(path.join(source, name), path.join(stage, name), {
              recursive: true,
              force: false,
              errorOnExist: true,
              dereference: false,
            });
        }
        await assertPlainTree(stage);
        let allocation = await allocateVersionDirectory(
          minecraftRoot,
          readableName(instance),
        );
        while (
          (await exists(path.join(stage, `${allocation.id}.json`))) ||
          (await exists(path.join(stage, `${allocation.id}.jar`)))
        ) {
          await fs.rmdir(allocation.path);
          allocation = await allocateVersionDirectory(
            minecraftRoot,
            `${allocation.id}-isolated`,
          );
        }
        try {
          const output = {
            ...metadata,
            id: allocation.id,
            jar: allocation.id,
            minecraftVersion: instance.version,
          };
          await fs.writeFile(
            path.join(stage, `${allocation.id}.json`),
            JSON.stringify(output, null, 2),
            { flag: "wx" },
          );
          if (jar)
            await fs.copyFile(
              jar,
              path.join(stage, `${allocation.id}.jar`),
              constants.COPYFILE_EXCL,
            );
          await fs.mkdir(path.join(stage, ".ldfcl"), { recursive: true });
          await fs.writeFile(
            path.join(stage, ".ldfcl", "launch.json"),
            JSON.stringify({ version: allocation.id }),
          );
          await fs.writeFile(
            path.join(stage, ".ldfcl", MIGRATION_MARKER),
            JSON.stringify({
              completed: true,
              instanceId: instance.id,
              source: sourceKey,
              sourceVersion: sourceId,
            }),
          );
          // The reservation belongs to this operation and is still empty.
          await fs.rmdir(allocation.path);
          await fs.rename(stage, allocation.path);
          instance.versionDirectory = allocation.id;
          result.prepared++;
          result.migrated++;
        } catch (error) {
          await fs.rmdir(allocation.path).catch(() => {});
          throw error;
        }
      } finally {
        await fs.rm(stage, { recursive: true, force: true });
      }
    } catch (error) {
      result.warnings.push(
        `${instance.name}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return result;
}
