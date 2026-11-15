import fs from "node:fs/promises";
import path from "node:path";
import type { LauncherRuntime } from "../runtime";
import { setDownloadSource } from "../services/downloads";
import type { CommandHandlers } from "./registry";
export function systemCommands(ctx: LauncherRuntime): CommandHandlers {
  return {
    state: async (p: any = {}) => {
      return ctx.state();
    },
    versions: async (p: any = {}) => {
      return ctx.game.versions();
    },
    "optifine:versions": async (p: any = {}) => {
      return ctx.game.optifineVersions(p.version);
    },
    "neoforge:versions": async (p: any = {}) => {
      return ctx.game.neoforgeVersions(p.version);
    },
    runtime: async (p: any = {}) => {
      return ctx.game.runtimeInfo();
    },
    select: async (p: any = {}) => {
      {
        if (p.instanceId) ctx.store.instance(p.instanceId);
        if (
          p.accountId &&
          !(await ctx.accounts.list()).some((x) => x.id === p.accountId)
        )
          throw Error("账号不存在");
        Object.assign(ctx.store, {
          ...(p.instanceId ? { selectedInstanceId: p.instanceId } : {}),
          ...(p.accountId ? { selectedAccountId: p.accountId } : {}),
        });
        await ctx.store.save();
        return ctx.state();
      }
    },
    settings: async (p: any = {}) => {
      await ctx.store.updateSettings(p);
      setDownloadSource(ctx.store.settings.downloadSource || "official");
      return ctx.state();
    },
    folder: async (p: any = {}) => {
      {
        const openFolder = async () => {
          let target = ctx.store.dir;
          if (p.id) {
            const i = ctx.store.instance(p.id);
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
            target = path.join(ctx.instanceDirectory(i), sub);
          }
          await fs.mkdir(target, { recursive: true });
          const error = await ctx.host.openPath(target);
          if (error) throw Error(error);
          return true;
        };
        return p.id ? ctx.exclusive(p.id, openFolder, true) : openFolder();
      }
    },
    external: async (p: any = {}) => {
      {
        const url = new URL(p.url);
        if (url.protocol !== "https:") throw Error("只能打开 HTTPS 链接");
        await ctx.host.openExternal(url.href);
        return true;
      }
    },
    "java:choose": async (p: any = {}) => {
      {
        const d = await ctx.host.chooseFiles({
          title: "选择 javaw.exe 或 java.exe",
          filters: [{ name: "Java", extensions: ["exe"] }],
          properties: ["openFile"],
        });
        return d.canceled ? null : d.filePaths[0];
      }
    },
  };
}
