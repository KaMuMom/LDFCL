import { validateGameOptions } from "@ldfcl/contracts/game-settings";
import { validateExtraJvmArguments } from "@ldfcl/contracts/jvm-arguments";
import type { Instance } from "@ldfcl/contracts/types";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  canonicalGameDirectoryPath,
  gameDirectoryRoots,
  safeGameVersionId,
} from "../game-directories";
import type { LauncherRuntime } from "../runtime";
import type { CommandHandlers } from "./registry";
export function storageCommands(ctx: LauncherRuntime): CommandHandlers {
  return {
    "store:stats": async (p: any = {}) => {
      return ctx.features.storage.stats();
    },
    "instance:manifest": async (p: any = {}) => {
      return ctx.exclusive(p.id, () =>
        ctx.features.manifest(ctx.store.instance(p.id), p),
      );
    },
    "instance:rebuild": async (p: any = {}) => {
      return ctx.exclusive("manifest:rebuild", async () => {
        let file = p.file;
        if (!file && !p.bundle) {
          const chosen = await ctx.host.chooseFiles({
            title: "选择实例 manifest（清单包中同样选择此文件）",
            filters: [{ name: "实例清单", extensions: ["json"] }],
            properties: ["openFile"],
          });
          if (chosen.canceled || !chosen.filePaths[0]) return null;
          file = chosen.filePaths[0];
        }
        let bundle = p.bundle;
        if (bundle) {
          for (const candidate of ["instance.manifest.json", "manifest.json"]) {
            const target = path.join(path.resolve(bundle), candidate);
            if (
              await fs.lstat(target).then(
                (stat) => stat.isFile() && !stat.isSymbolicLink(),
                () => false,
              )
            ) {
              file = target;
              break;
            }
          }
        }
        if (typeof file !== "string" || !path.isAbsolute(file))
          throw Error("请选择有效的清单文件");
        const stat = await fs.lstat(file);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.size > 32 * 1024 * 1024
        )
          throw Error("清单文件过大或不是普通文件");
        let manifest: any;
        try {
          manifest = JSON.parse(await fs.readFile(file, "utf8"));
        } catch {
          throw Error("实例清单 JSON 无效");
        }
        const source = manifest.instance;
        if (
          !source ||
          typeof source.version !== "string" ||
          ![
            "vanilla",
            "fabric",
            "quilt",
            "forge",
            "neoforge",
            "optifine",
          ].includes(source.loader)
        )
          throw Error("实例清单缺少有效的游戏版本与加载器信息");
        const versionDirectory = safeGameVersionId(
          source.versionDirectory || source.importedVersionId || source.id,
        );
        const root = gameDirectoryRoots(
          ctx.store.currentGameDirectory,
        ).minecraftRoot;
        await canonicalGameDirectoryPath(root);
        await fs.mkdir(path.join(root, "versions"), { recursive: true });
        const destination = path.join(root, "versions", versionDirectory);
        if (
          await fs.lstat(destination).then(
            () => true,
            () => false,
          )
        )
          throw Error(
            "此游戏目录已有同名版本；请在启动器设置添加并切换到干净游戏目录后重建，现有文件将保留",
          );
        if (
          !bundle &&
          (await fs.stat(path.join(path.dirname(file), "blobs")).then(
            (stat) => stat.isDirectory(),
            () => false,
          ))
        )
          bundle = path.dirname(file);
        if (bundle)
          await ctx.features.storage.rebuildFromBundle(
            path.resolve(bundle),
            destination,
          );
        else await ctx.features.storage.reconstruct(manifest, destination);
        const instance: Instance = {
          id: randomUUID(),
          name: String(p.name || source.name || source.version).slice(0, 100),
          version: source.version,
          loader: source.loader,
          loaderVersion:
            typeof source.loaderVersion === "string"
              ? source.loaderVersion
              : undefined,
          versionDirectory,
          gameDirectoryId: ctx.store.selectedGameDirectoryId,
          createdAt: new Date().toISOString(),
          gameSettings: validateGameOptions(source.gameSettings || {}),
          memoryMb:
            typeof source.memoryMb === "number" &&
            Number.isFinite(source.memoryMb) &&
            source.memoryMb >= 512
              ? source.memoryMb
              : undefined,
          // A portable manifest never activates a foreign executable path.
          javaPath: "",
          jvmArgs: validateExtraJvmArguments(source.jvmArgs || []),
        };
        ctx.store.instances.push(instance);
        ctx.store.selectedInstanceId = instance.id;
        await ctx.store.save();
        await ctx.features.migrate(instance);
        ctx.emit({ type: "state" });
        return instance;
      });
    },
    "snapshot:create": async (p: any = {}) => {
      return ctx.exclusive(p.id, () =>
        ctx.features.createSnapshot(ctx.store.instance(p.id), p.name),
      );
    },
    "snapshot:list": async (p: any = {}) => {
      return ctx.exclusive(
        p.id,
        () =>
          ctx.features.snapshots.list(
            ctx.instanceDirectory(ctx.store.instance(p.id)),
          ),
        true,
      );
    },
    "snapshot:diff": async (p: any = {}) => {
      return ctx.exclusive(p.id, () =>
        ctx.features.snapshots.previewRestore(
          ctx.instanceDirectory(ctx.store.instance(p.id)),
          p.snapshotId,
        ),
      );
    },
    "snapshot:preview": async (p: any = {}) => {
      return ctx.exclusive(p.id, () =>
        ctx.features.snapshots.previewRestore(
          ctx.instanceDirectory(ctx.store.instance(p.id)),
          p.snapshotId,
        ),
      );
    },
    "snapshot:restore": async (p: any = {}) => {
      if (p.apply !== true) throw Error("请先查看回滚变更，再确认执行");
      return ctx.exclusive(p.id, () =>
        ctx.features.restore(
          ctx.store.instance(p.id),
          p.snapshotId,
          p.expectedPreviewId,
        ),
      );
    },
    "health:scan": async (p: any = {}) => {
      return ctx.exclusive(
        p.id,
        () => ctx.features.scan(ctx.store.instance(p.id)),
        true,
      );
    },
    "health:latest": async (p: any = {}) => {
      return ctx.features.latest(ctx.store.instance(p.id));
    },
    "health:fix": async (p: any = {}) => {
      if (p.auto !== true) throw Error("请先扫描，再选择自动修复");
      return ctx.exclusive(p.id, () =>
        ctx.features.fix(ctx.store.instance(p.id)),
      );
    },
    "diagnosis:list": async (p: any = {}) => {
      return ctx.features.diagnostics.list(p.id || p.instanceId);
    },
    "diagnosis:get": async (p: any = {}) => {
      return ctx.features.diagnostics.get(p.diagnosisId || p.id);
    },
    "diagnosis:share": async (p: any = {}) => {
      return ctx.features.diagnostics.getSharePayload(p.diagnosisId || p.id);
    },
    "diagnosis:import": async (p: any = {}) => {
      return ctx.exclusive(
        p.id || p.instanceId,
        async () => {
          const instance = ctx.store.instance(p.id || p.instanceId);
          let file = p.file;
          if (!file) {
            const chosen = await ctx.host.chooseFiles({
              title: "导入崩溃报告",
              filters: [{ name: "崩溃报告", extensions: ["txt", "log"] }],
              properties: ["openFile"],
            });
            if (chosen.canceled || !chosen.filePaths[0]) return null;
            file = chosen.filePaths[0];
          }
          return ctx.features.diagnostics.importReport({
            instanceId: instance.id,
            file,
            gameDirectory: ctx.instanceDirectory(instance),
          });
        },
        true,
      );
    },
  };
}
