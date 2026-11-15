import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  canonicalGameDirectoryPath,
  gameDirectoryPathKey,
  scanGameDirectory,
} from "../game-directories";
import type { LauncherRuntime } from "../runtime";
import type { CommandHandlers } from "./registry";
export function directoriesCommands(ctx: LauncherRuntime): CommandHandlers {
  return {
    "game-directory:add": async (p: any = {}) => {
      return ctx.changeDirectory(async () => {
        let requested = p.path;
        if (!requested) {
          const chosen = await ctx.host.chooseFiles({
            title: "添加 Minecraft 游戏目录",
            defaultPath: ctx.store.currentGameDirectory.path,
            properties: ["openDirectory", "createDirectory"],
          });
          if (chosen.canceled || !chosen.filePaths[0]) return null;
          requested = chosen.filePaths[0];
        }
        const rootPath = await canonicalGameDirectoryPath(requested);
        const key = gameDirectoryPathKey(rootPath);
        const existingPaths = await Promise.all(
          ctx.store.gameDirectories.map(async (directory) => ({
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
        const registered = ctx.store.registerGameDirectory(directory);
        try {
          const prepared = await ctx.prepareDirectoryInstances(registered);
          const scan = await scanGameDirectory(registered);
          const discovered = await ctx.addDiscoveredInstances(
            registered,
            scan.instances,
          );
          ctx.store.selectGameDirectory(registered.id);
          await ctx.store.save();
          ctx.setDirectoryWarnings([...prepared.warnings, ...scan.warnings]);
          return {
            ...(await ctx.state()),
            discovered,
            warnings: [...prepared.warnings, ...scan.warnings],
          };
        } finally {
          ctx.bindGameServices();
          ctx.emit({ type: "state" });
        }
      });
    },
    "game-directory:select": async (p: any = {}) => {
      return ctx.changeDirectory(async () => {
        const directory = ctx.store.gameDirectories.find((d) => d.id === p.id);
        if (!directory) throw Error("游戏目录不存在，请重新添加。");
        await canonicalGameDirectoryPath(directory.path);
        try {
          const prepared = await ctx.prepareDirectoryInstances(directory);
          const scan = await scanGameDirectory(directory);
          const discovered = await ctx.addDiscoveredInstances(
            directory,
            scan.instances,
          );
          ctx.store.selectGameDirectory(directory.id);
          await ctx.store.save();
          ctx.setDirectoryWarnings([...prepared.warnings, ...scan.warnings]);
          return {
            ...(await ctx.state()),
            discovered,
            warnings: [...prepared.warnings, ...scan.warnings],
          };
        } finally {
          ctx.bindGameServices();
          ctx.emit({ type: "state" });
        }
      });
    },
    "game-directory:relocate": async (p: any = {}) => {
      return ctx.changeDirectory(async () => {
        const directory = ctx.store.gameDirectories.find((d) => d.id === p.id);
        if (!directory) throw Error("游戏目录不存在，请重新添加。");
        if (directory.isDefault)
          throw Error("默认目录固定在程序旁；可添加其他游戏目录。");
        let requested = p.path;
        if (!requested) {
          const chosen = await ctx.host.chooseFiles({
            title: "重新定位已移动的 Minecraft 游戏目录",
            properties: ["openDirectory"],
          });
          if (chosen.canceled || !chosen.filePaths[0]) return null;
          requested = chosen.filePaths[0];
        }
        const rootPath = await canonicalGameDirectoryPath(requested);
        const key = gameDirectoryPathKey(rootPath);
        for (const other of ctx.store.gameDirectories) {
          if (other.id === directory.id) continue;
          const canonical = await fs
            .realpath(other.path)
            .catch(() => other.path);
          if (gameDirectoryPathKey(canonical) === key)
            throw Error("该位置已登记为其他游戏目录，请直接使用对应条目。");
        }
        // Keep the registry identity and its instance selections; never copy
        // game data or recreate the old path when a folder was moved.
        directory.path = rootPath;
        const prepared = await ctx.prepareDirectoryInstances(directory);
        const scan = await scanGameDirectory(directory);
        const discovered = await ctx.addDiscoveredInstances(
          directory,
          scan.instances,
        );
        if (directory.id === ctx.store.selectedGameDirectoryId) {
          ctx.store.selectGameDirectory(directory.id);
          ctx.setDirectoryWarnings([...prepared.warnings, ...scan.warnings]);
        }
        await ctx.store.save();
        ctx.bindGameServices();
        ctx.emit({ type: "state" });
        return {
          ...(await ctx.state()),
          discovered,
          warnings: [...prepared.warnings, ...scan.warnings],
        };
      });
    },
    "game-directory:create-default": async (p: any = {}) => {
      return ctx.changeDirectory(async () => {
        const directory = ctx.store.gameDirectories.find((d) => d.isDefault);
        if (!directory) throw Error("默认游戏目录尚未登记。");
        await fs.mkdir(directory.path, { recursive: true });
        await canonicalGameDirectoryPath(directory.path);
        if (directory.id === ctx.store.selectedGameDirectoryId)
          ctx.setDirectoryWarnings([]);
        ctx.emit({ type: "state" });
        return ctx.state();
      });
    },
    "game-directory:scan": async (p: any = {}) => {
      return ctx.changeDirectory(async () => {
        await canonicalGameDirectoryPath(ctx.store.currentGameDirectory.path);
        const prepared = await ctx.prepareDirectoryInstances(
          ctx.store.currentGameDirectory,
        );
        const scan = await scanGameDirectory(ctx.store.currentGameDirectory);
        const discovered = await ctx.addDiscoveredInstances(
          ctx.store.currentGameDirectory,
          scan.instances,
        );
        await ctx.store.save();
        ctx.setDirectoryWarnings([...prepared.warnings, ...scan.warnings]);
        ctx.emit({ type: "state" });
        return {
          ...(await ctx.state()),
          discovered,
          warnings: [...prepared.warnings, ...scan.warnings],
        };
      });
    },
    "game-directory:remove": async (p: any = {}) => {
      return ctx.changeDirectory(async () => {
        ctx.store.removeGameDirectory(p.id);
        try {
          await canonicalGameDirectoryPath(ctx.store.currentGameDirectory.path);
          const prepared = await ctx.prepareDirectoryInstances(
            ctx.store.currentGameDirectory,
          );
          await ctx.store.save();
          ctx.setDirectoryWarnings(prepared.warnings);
          return ctx.state();
        } finally {
          ctx.bindGameServices();
          ctx.emit({ type: "state" });
        }
      });
    },
    "game-directory:open": async (p: any = {}) => {
      {
        const directory = p.id
          ? ctx.store.gameDirectories.find((d) => d.id === p.id)
          : ctx.store.currentGameDirectory;
        if (!directory) throw Error("游戏目录不存在。");
        await canonicalGameDirectoryPath(directory.path);
        const error = await ctx.host.openPath(directory.path);
        if (error) throw Error(error);
        return true;
      }
    },
  };
}
