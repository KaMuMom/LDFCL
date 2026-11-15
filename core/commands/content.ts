import { gameDirectoryRoots } from "../game-directories";
import type { LauncherRuntime } from "../runtime";
import { ContentPacksService } from "../services/content-packs";
import type { CommandHandlers } from "./registry";
export function contentCommands(ctx: LauncherRuntime): CommandHandlers {
  return {
    "content:search": async (p: any = {}) => {
      return ctx.content.search(p);
    },
    "content-packs:list": async (p: any = {}) => {
      return ctx.queuedRead(p.instanceId, () =>
        new ContentPacksService(
          gameDirectoryRoots(ctx.store.currentGameDirectory).minecraftRoot,
        ).list(ctx.store.instance(p.instanceId), p.kind),
      );
    },
    "content-packs:toggle": async (p: any = {}) => {
      return ctx.mutate(p.instanceId, "启停资源包或光影", () =>
        new ContentPacksService(
          gameDirectoryRoots(ctx.store.currentGameDirectory).minecraftRoot,
        ).setEnabled(
          ctx.store.instance(p.instanceId),
          p.kind,
          p.name,
          p.enabled,
        ),
      );
    },
    "content-packs:remove": async (p: any = {}) => {
      return ctx.mutate(p.instanceId, "移除资源包或光影", () =>
        new ContentPacksService(
          gameDirectoryRoots(ctx.store.currentGameDirectory).minecraftRoot,
        ).remove(ctx.store.instance(p.instanceId), p.kind, p.name),
      );
    },
    "content-packs:reorder": async (p: any = {}) => {
      return ctx.mutate(p.instanceId, "资源包排序", () =>
        new ContentPacksService(
          gameDirectoryRoots(ctx.store.currentGameDirectory).minecraftRoot,
        ).reorder(ctx.store.instance(p.instanceId), p.names),
      );
    },
    "content-packs:import": async (p: any = {}) => {
      return ctx.mutate(p.instanceId, "导入资源包或光影", async () => {
        if (!["resourcepack", "shader"].includes(p.kind))
          throw Error("无效的内容类型");
        const chosen = await ctx.host.chooseFiles({
          title: "导入 ZIP 资源包或光影",
          filters: [{ name: "资源包或光影", extensions: ["zip"] }],
          properties: ["openFile", "multiSelections"],
        });
        if (chosen.canceled) return null;
        return ctx.content.importFiles(
          chosen.filePaths,
          ctx.store.instance(p.instanceId),
          p.kind,
        );
      });
    },
    "mod-favorites:list": async (p: any = {}) => {
      return ctx.modFavorites.list();
    },
    "mod-favorites:set": async (p: any = {}) => {
      return ctx.modFavorites.set(p.project, p.saved === true);
    },
    "content:versions": async (p: any = {}) => {
      return ctx.content.projectVersions({
        projectId: p.projectId,
        instance: ctx.store.instance(p.instanceId),
      });
    },
    "content:install": async (p: any = {}) => {
      return ctx.mutate(p.instanceId, "安装内容", () =>
        ctx.content.install({
          ...p,
          instance: ctx.store.instance(p.instanceId),
        }),
      );
    },
    "mods:list": async (p: any = {}) => {
      return ctx.exclusive(
        p.id,
        () => ctx.content.listMods(ctx.store.instance(p.id)),
        true,
      );
    },
    "mods:duplicates": async (p: any = {}) => {
      return ctx.exclusive(
        p.id,
        () => ctx.content.scanDuplicates(ctx.store.instance(p.id)),
        true,
      );
    },
    "mods:toggle": async (p: any = {}) => {
      return ctx.mutate(p.id, "启停 Mod", () =>
        ctx.content.enableMod(
          ctx.store.instance(p.id),
          p.file,
          Boolean(p.enabled),
        ),
      );
    },
    "mods:remove": async (p: any = {}) => {
      return ctx.mutate(p.id, "移除 Mod", () =>
        ctx.content.removeMod(ctx.store.instance(p.id), p.file),
      );
    },
    "mods:updates": async (p: any = {}) => {
      return ctx.exclusive(
        p.id,
        () => ctx.content.checkUpdates(ctx.store.instance(p.id)),
        true,
      );
    },
    "mods:apply": async (p: any = {}) => {
      return ctx.mutate(p.id, "更新 Mod", () =>
        ctx.content.applyUpdates(ctx.store.instance(p.id), p.updates),
      );
    },
    "mods:import": async (p: any = {}) => {
      return ctx.mutate(p.id, "导入 Mod", async () => {
        const d = await ctx.host.chooseFiles({
          filters: [{ name: "Mod", extensions: ["jar"] }],
          properties: ["openFile", "multiSelections"],
        });
        if (d.canceled) return null;
        return ctx.content.importMods(d.filePaths, ctx.store.instance(p.id));
      });
    },
    "pack:import": async (p: any = {}) => {
      {
        return ctx.exclusive("pack:import", async () => {
          const d = await ctx.host.chooseFiles({
            title: "导入 Modrinth 整合包",
            filters: [{ name: "Modrinth 整合包", extensions: ["mrpack"] }],
            properties: ["openFile"],
          });
          if (d.canceled) return null;
          return ctx.installPack(d.filePaths[0]);
        });
      }
    },
    "pack:versions": async (p: any = {}) => {
      return ctx.content.packVersions(p.projectId);
    },
    "pack:install": async (p: any = {}) => {
      {
        return ctx.exclusive(`pack:${String(p.projectId)}`, async () => {
          const pack = await ctx.content.downloadPack(p.projectId, p.versionId);
          return ctx.installPack(pack.path);
        });
      }
    },
  };
}
