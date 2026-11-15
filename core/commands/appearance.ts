import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { LauncherRuntime } from "../runtime";
import { validateSkinPng } from "../services/accounts";
import type { CommandHandlers } from "./registry";
export function appearanceCommands(ctx: LauncherRuntime): CommandHandlers {
  return {
    "skin-library:list": async (p: any = {}) => {
      return ctx.skinLibrary.list();
    },
    "skin-library:save": async (p: any = {}) => {
      return ctx.skinLibrary.save({
        name: p.name,
        variant: p.variant,
        dataUrl: p.dataUrl,
      });
    },
    "skin-library:rename": async (p: any = {}) => {
      return ctx.skinLibrary.rename(p.id, p.name);
    },
    "skin-library:remove": async (p: any = {}) => {
      return ctx.skinLibrary.remove(p.id);
    },
    "skin-library:import": async (p: any = {}) => {
      {
        const selected = await ctx.host.chooseFiles({
          title: "导入到皮肤库",
          filters: [{ name: "Minecraft PNG 皮肤", extensions: ["png"] }],
          properties: ["openFile"],
        });
        if (selected.canceled) return null;
        const file = selected.filePaths[0];
        const stat = await fs.stat(file);
        if (!stat.isFile() || stat.size > 2 * 1024 * 1024)
          throw Error("皮肤必须是小于 2 MB 的 PNG 文件");
        const data = await fs.readFile(file);
        validateSkinPng(data);
        return ctx.skinLibrary.save({
          name: path.basename(file, path.extname(file)),
          variant: p.variant === "slim" ? "slim" : "classic",
          dataUrl: `data:image/png;base64,${data.toString("base64")}`,
        });
      }
    },
    "skin-library:export": async (p: any = {}) => {
      {
        const entry = (await ctx.skinLibrary.list()).find(
          (item) => item.id === p.id,
        );
        if (!entry) throw Error("皮肤库中找不到此皮肤");
        const file = await ctx.skinLibrary.file(p.id);
        const selected = await ctx.host.chooseSaveFile({
          title: "导出皮肤",
          defaultPath: `${entry.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")}.png`,
          filters: [{ name: "PNG 皮肤", extensions: ["png"] }],
        });
        if (selected.canceled || !selected.filePath) return null;
        const destination = await fs
          .realpath(selected.filePath)
          .catch(async (error) => {
            if (error.code !== "ENOENT") throw error;
            return path.join(
              await fs.realpath(path.dirname(selected.filePath!)),
              path.basename(selected.filePath!),
            );
          });
        const library = await fs.realpath(path.dirname(file));
        const relative = path.relative(library, destination);
        if (
          !relative ||
          (!relative.startsWith(`..${path.sep}`) &&
            relative !== ".." &&
            !path.isAbsolute(relative))
        )
          throw Error(
            "请选择皮肤库文件夹以外的位置导出，避免覆盖已保存的皮肤。",
          );
        await fs.copyFile(file, selected.filePath);
        return selected.filePath;
      }
    },
    "skin-library:apply": async (p: any = {}) => {
      {
        const entry = (await ctx.skinLibrary.list()).find(
          (item) => item.id === p.id,
        );
        if (!entry) throw Error("皮肤库中找不到此皮肤");
        return ctx.accounts.uploadSkin(
          p.accountId,
          await ctx.skinLibrary.file(p.id),
          entry.variant,
        );
      }
    },
    "skin:profile": async (p: any = {}) => {
      return ctx.accounts.profile(p.id);
    },
    "skin:upload": async (p: any = {}) => {
      {
        const d = await ctx.host.chooseFiles({
          title: "选择 Minecraft 皮肤",
          filters: [{ name: "PNG 皮肤", extensions: ["png"] }],
          properties: ["openFile"],
        });
        if (d.canceled) return null;
        return ctx.accounts.uploadSkin(
          p.id,
          d.filePaths[0],
          p.variant || "classic",
        );
      }
    },
    "skin:preview": async (p: any = {}) => {
      {
        const d = await ctx.host.chooseFiles({
          title: "预览皮肤 / 披风",
          filters: [{ name: "PNG 纹理", extensions: ["png"] }],
          properties: ["openFile"],
        });
        if (d.canceled) return null;
        const stat = await fs.stat(d.filePaths[0]);
        if (stat.size > 2 * 1024 * 1024) throw Error("纹理图片应小于 2 MB");
        return {
          url: ctx.host.imageDataUrl(d.filePaths[0]),
          name: path.basename(d.filePaths[0]),
        };
      }
    },
    "skin:reset": async (p: any = {}) => {
      return ctx.accounts.resetSkin(p.id);
    },
    "skin:cape": async (p: any = {}) => {
      return ctx.accounts.activateCape(p.id, p.capeId || null);
    },
    "skin:saveEdited": async (p: any = {}) => {
      {
        const data = ctx.decodeSkin(p.dataUrl);
        const folder = path.join(ctx.store.dir, "cache", "edited-skins");
        await fs.mkdir(folder, { recursive: true });
        const temp = path.join(folder, `${randomUUID()}.png`);
        await fs.writeFile(temp, data);
        try {
          return await ctx.accounts.uploadSkin(
            p.id,
            temp,
            p.variant === "slim" ? "slim" : "classic",
          );
        } finally {
          await fs.unlink(temp).catch(() => {});
        }
      }
    },
    "skin:exportEdited": async (p: any = {}) => {
      {
        const data = ctx.decodeSkin(p.dataUrl);
        const d = await ctx.host.chooseSaveFile({
          title: "导出编辑后的皮肤",
          defaultPath: "LDFCL-skin.png",
          filters: [{ name: "PNG 皮肤", extensions: ["png"] }],
        });
        if (d.canceled || !d.filePath) return null;
        await fs.writeFile(d.filePath, data);
        return d.filePath;
      }
    },
  };
}
