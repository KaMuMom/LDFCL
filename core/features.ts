import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "./store";
import { validateGameOptions } from "../shared/game-settings";
import { validateExtraJvmArguments } from "../shared/jvm-arguments";
import type { Instance } from "../shared/types";
import type { HealthReport, HealthFixLog } from "../shared/health";
import type { LauncherHost } from "./host";
import { gameDirectoryRoots } from "./game-directories";
import {
  assertInstanceGameDirectory,
  instanceGameDirectory,
} from "./instance-paths";
import { HealthScanner } from "./services/health";
import { InstanceStorageService } from "./services/instance-manifest";
import { SnapshotService } from "./services/snapshots";
import { CrashDiagnostics } from "./services/crash-diagnostics";

async function jsonWrite(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2));
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
async function readJson(file: string) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024)
    throw Error("JSON 文件过大或不是普通文件");
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    throw Error("JSON 文件格式无效");
  }
}

/** Shared feature orchestration; the launcher owns instance and directory locks. */
export class LauncherFeatures {
  readonly diagnostics: CrashDiagnostics;
  private reports = new Map<string, HealthReport>();
  constructor(
    private options: {
      store: Store;
      host: LauncherHost;
      emit: (event: any) => void;
    },
  ) {
    this.diagnostics = new CrashDiagnostics(options.store.dir, {
      onDiagnosis: (diagnosis) =>
        options.emit({ type: "diagnosis", diagnosis }),
    });
  }
  private get store() {
    return this.options.store;
  }
  private get roots() {
    return gameDirectoryRoots(this.store.currentGameDirectory);
  }
  get storage() {
    return new InstanceStorageService({
      dataDir: this.store.dir,
      minecraftRoot: this.roots.minecraftRoot,
    });
  }
  get snapshots() {
    return new SnapshotService({
      dataDir: this.store.dir,
      minecraftRoot: this.roots.minecraftRoot,
    });
  }
  directory(instance: Instance) {
    return instanceGameDirectory(this.roots.minecraftRoot, instance);
  }
  async record(instance: Instance) {
    await jsonWrite(
      path.join(this.directory(instance), "instance.json"),
      instance,
    );
  }
  async migrate(instance: Instance) {
    await assertInstanceGameDirectory(this.roots.minecraftRoot, instance);
    await this.storage.migrate(this.directory(instance), { instance });
    await this.record(instance);
    return this.storage.rebuildManifest(this.directory(instance), { instance });
  }
  async afterChange(instance: Instance) {
    await this.record(instance);
    this.reports.delete(instance.id);
    await fs.rm(
      path.join(this.directory(instance), ".ldfcl", "health", "latest.json"),
      { force: true },
    );
    await this.storage.rebuildManifest(this.directory(instance), { instance });
  }
  async beforeChange(instance: Instance, name: string) {
    return this.createSnapshot(instance, `自动 · ${name}`);
  }
  async createSnapshot(instance: Instance, name?: string) {
    // Capture independent originals only when this instance is first used for
    // storage or mutation. Opening the launcher never hashes entire worlds.
    await this.storage.migrate(this.directory(instance), { instance });
    await this.record(instance);
    return this.snapshots.create(this.directory(instance), {
      name,
    });
  }
  async scan(instance: Instance) {
    const report = await new HealthScanner({
      minecraftRoot: this.roots.minecraftRoot,
      runtimeDataDir: this.roots.dataDir,
    }).scan(instance, this.store.settings);
    this.reports.set(instance.id, report);
    await jsonWrite(
      path.join(this.directory(instance), ".ldfcl", "health", "latest.json"),
      report,
    );
    this.options.emit({ type: "health", report });
    return report;
  }
  async latest(instance: Instance): Promise<HealthReport | null> {
    if (this.reports.has(instance.id)) return this.reports.get(instance.id)!;
    try {
      const report = await readJson(
        path.join(this.directory(instance), ".ldfcl", "health", "latest.json"),
      );
      return report.schemaVersion === 1 && report.instanceId === instance.id
        ? report
        : null;
    } catch {
      return null;
    }
  }
  async fix(instance: Instance) {
    const before = await this.scan(instance);
    await this.beforeChange(instance, "健康修复");
    const changes: HealthFixLog[] = [];
    for (const issue of before.issues) {
      if (!issue.autoFix) {
        changes.push({
          issueId: issue.id,
          status: "skipped",
          description: "需要手动处理；未改动文件",
        });
        continue;
      }
      try {
        if (issue.autoFix === "memory") {
          instance.memoryMb = undefined;
          this.store.settings.memoryMode = "auto";
        } else if (issue.autoFix === "java-auto") {
          instance.javaPath = "";
          this.store.settings.javaPath = "";
        } else if (issue.autoFix === "enable-dependency") {
          if (
            !issue.file ||
            path.basename(issue.file) !== issue.file ||
            !/\.jar\.disabled$/i.test(issue.file)
          )
            throw Error("前置文件无效");
          const source = path.join(
            this.directory(instance),
            "mods",
            issue.file,
          );
          const target = source.slice(0, -".disabled".length);
          // COPYFILE_EXCL avoids overwriting another mod installed since scan.
          await fs.copyFile(source, target, 1);
          try {
            await fs.unlink(source);
          } catch (error) {
            await fs.rm(target, { force: true }).catch(() => {});
            throw error;
          }
        }
        changes.push({
          issueId: issue.id,
          status: "fixed",
          description:
            issue.autoFix === "memory"
              ? "恢复自动内存模式，清除实例内存覆盖"
              : issue.autoFix === "java-auto"
                ? "清除自定义 Java，启动时自动选择或补齐"
                : `启用 ${issue.file}`,
        });
      } catch {
        changes.push({
          issueId: issue.id,
          status: "failed",
          description: "无法完成此修复；已有文件保留，请重新扫描",
        });
      }
    }
    await this.store.save();
    await this.afterChange(instance);
    const report = await this.scan(instance);
    const result = {
      instanceId: instance.id,
      fixedAt: new Date().toISOString(),
      before,
      changes,
      report,
    };
    await jsonWrite(
      path.join(
        this.directory(instance),
        ".ldfcl",
        "health",
        `fix-${randomUUID()}.json`,
      ),
      result,
    );
    this.options.emit({ type: "state" });
    return result;
  }
  async restore(
    instance: Instance,
    snapshotId: string,
    expectedPreviewId?: string,
  ) {
    const result = await this.snapshots.restore(
      this.directory(instance),
      snapshotId,
      { expectedPreviewId },
    );
    // Keep the registry in sync; otherwise launch would overwrite restored options.
    const restored = await readJson(
      path.join(this.directory(instance), "instance.json"),
    ).catch(() => null);
    if (restored) {
      instance.gameSettings = validateGameOptions(restored.gameSettings || {});
      instance.javaPath =
        typeof restored.javaPath === "string" ? restored.javaPath : undefined;
      instance.memoryMb =
        typeof restored.memoryMb === "number" &&
        Number.isFinite(restored.memoryMb) &&
        restored.memoryMb >= 512
          ? restored.memoryMb
          : undefined;
      instance.jvmArgs = validateExtraJvmArguments(restored.jvmArgs || []);
    }
    await this.store.save();
    await this.afterChange(instance);
    this.options.emit({ type: "state" });
    return result;
  }
  async manifest(instance: Instance, input: any) {
    const directory = this.directory(instance);
    await this.storage.migrate(directory, { instance });
    await this.record(instance);
    const manifest = await this.storage.rebuildManifest(directory, {
      instance,
    });
    let bundle = input.bundle;
    if (input.exportBundle === true && !bundle) {
      const picked = await this.options.host.chooseFiles({
        title: "选择清单包的保存位置（将在此处新建文件夹）",
        properties: ["openDirectory", "createDirectory"],
      });
      if (picked.canceled || !picked.filePaths[0]) return null;
      bundle = path.join(
        picked.filePaths[0],
        `${instance.versionDirectory || instance.id}-bundle-${Date.now()}`,
      );
    }
    if (bundle) {
      await this.storage.exportBundle(directory, path.resolve(bundle));
      return { path: path.resolve(bundle), manifest };
    }
    let output = input.output;
    if (input.save === true && !output) {
      const picked = await this.options.host.chooseSaveFile({
        title: "导出实例清单",
        defaultPath: `${instance.name}.manifest.json`,
        filters: [{ name: "实例清单", extensions: ["json"] }],
      });
      if (picked.canceled || !picked.filePath) return null;
      output = picked.filePath;
    }
    if (output) {
      await jsonWrite(path.resolve(output), manifest);
      return { path: path.resolve(output), manifest };
    }
    return manifest;
  }
}
