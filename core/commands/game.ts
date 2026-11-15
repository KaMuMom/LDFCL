import {
  effectiveGameOptions,
  validateGameOptions,
} from "@ldfcl/contracts/game-settings";
import { validateExtraJvmArguments } from "@ldfcl/contracts/jvm-arguments";
import fs from "node:fs/promises";
import { canonicalGameDirectoryPath } from "../game-directories";
import type { LauncherRuntime } from "../runtime";
import { saveGameOptions } from "../store";
import type { CommandHandlers } from "./registry";
export function gameCommands(ctx: LauncherRuntime): CommandHandlers {
  return {
    install: async (p: any = {}) => {
      {
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
        return ctx.exclusive(
          `install:${p.version}:${p.loader || "vanilla"}`,
          async () => {
            await canonicalGameDirectoryPath(
              ctx.store.currentGameDirectory.path,
            );
            ctx.game.setConcurrency(ctx.store.settings.downloadConcurrency);
            const instance = await ctx.game.install(p);
            instance.gameDirectoryId = ctx.store.selectedGameDirectoryId;
            ctx.store.instances.push(instance);
            ctx.store.selectedInstanceId = instance.id;
            await ctx.store.save();
            await ctx.features.migrate(instance);
            ctx.emit({ type: "state" });
            return instance;
          },
        );
      }
    },
    "instance:save": async (p: any = {}) => {
      return ctx.mutate(p.id, "实例设置", async () => {
        const i = ctx.store.instance(p.id);
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
          ctx.instanceDirectory(i),
          effectiveGameOptions(ctx.store.settings, i),
        );
        await ctx.store.save();
        return i;
      });
    },
    "instance:delete": async (p: any = {}) => {
      return ctx.exclusive(p.id, async () => {
        if (ctx.locks.size !== 1 || ctx.running.size)
          throw Error("请先停止游戏并等待所有安装和文件操作完成，再删除版本。");
        ctx.versionDeleting = true;
        try {
          const i = ctx.store.instance(p.id);
          await ctx.assertVersionCanDelete(i);
          const dir = ctx.instanceDirectory(i);
          try {
            await fs.access(dir);
            await ctx.host.trashItem(dir);
          } catch (e: any) {
            if (e.code !== "ENOENT") throw e;
          }
          ctx.store.instances = ctx.store.instances.filter((x) => x !== i);
          if (ctx.store.selectedInstanceId === i.id)
            ctx.store.selectedInstanceId = ctx.store.currentInstances[0]?.id;
          await ctx.store.save();
          return ctx.state();
        } finally {
          ctx.versionDeleting = false;
        }
      });
    },
    launch: async (p: any = {}) => {
      return ctx.exclusive(p.instanceId, async () => {
        const i = ctx.store.instance(p.instanceId);
        if (!p.accountId) throw Error("请先添加并选择一个账号");
        const account = await ctx.accounts.getForLaunch(p.accountId);
        const warnings: string[] = [];
        // An optional diagnostic or its report file must not turn a runnable
        // instance into a failed launch. Required options/snapshots stay strict.
        try {
          await ctx.features.scan(i);
        } catch {
          warnings.push("启动前健康报告未能保存，可稍后重新扫描。");
        }
        await ctx.features.beforeChange(i, "启动前设置");
        await saveGameOptions(
          ctx.instanceDirectory(i),
          effectiveGameOptions(ctx.store.settings, i),
        );
        const result = await ctx.game.launch(i, account, ctx.store.settings);
        i.lastPlayed = new Date().toISOString();
        try {
          await ctx.store.save();
        } catch {
          warnings.push(
            "游戏进程已启动，但启动记录未能保存，请检查启动器配置目录的写入权限。",
          );
        }
        if (ctx.store.settings.closeOnLaunch && ctx.running.has(i.id)) {
          try {
            ctx.host.minimizeWindow();
          } catch {
            warnings.push("游戏进程已启动，但启动器窗口未能最小化。");
          }
        }
        return { ...result, running: ctx.running.has(i.id), warnings };
      });
    },
    stop: async (p: any = {}) => {
      await ctx.game.stop(p.id);
      ctx.running.delete(p.id);
      return true;
    },
  };
}
