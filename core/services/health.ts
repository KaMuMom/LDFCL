import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import AdmZip from "adm-zip";
import type { Instance, Settings } from "../../shared/types";
import type { HealthIssue, HealthReport } from "../../shared/health";
import {
  instanceGameDirectory,
  instanceVersionDirectoryId,
  assertPlainTree,
} from "../instance-paths";
import { JavaManager, automaticMemoryMb } from "./java";
import { compatibleJavaArchitecture } from "./java-runtime";
import { readModMetadata } from "./mod-metadata";

export function healthJavaMajor(version: string): number {
  if (/^(?:2\d\.|26w|27w)/.test(version)) return 25;
  if (!/^1\./.test(version)) return 21;
  const parts = version.split(".").map(Number);
  if (parts[0] >= 26) return 25;
  if (parts[0] === 1 && (parts[1] > 20 || (parts[1] === 20 && parts[2] >= 5)))
    return 21;
  if (parts[0] === 1 && parts[1] >= 18) return 17;
  if (parts[0] === 1 && parts[1] === 17) return 16;
  return 8;
}

function readEntry(zip: AdmZip, name: string): string | null {
  const entry = zip.getEntry(name);
  if (!entry || entry.header.size > 2 * 1024 * 1024) return null;
  return zip.readAsText(entry);
}

/** Presence checks only: loader version-range solving still belongs to the loader. */
function requiredIds(zip: AdmZip): string[] {
  const fabric = readEntry(zip, "fabric.mod.json");
  if (fabric) {
    const parsed = JSON.parse(fabric);
    return Object.keys(parsed.depends || {});
  }
  const quilt = readEntry(zip, "quilt.mod.json");
  if (quilt) {
    const parsed = JSON.parse(quilt);
    const entries = parsed.quilt_loader?.depends || [];
    return entries
      .filter((dep: any) => dep && !dep.optional && typeof dep.id === "string")
      .map((dep: any) => dep.id);
  }
  const toml =
    readEntry(zip, "META-INF/neoforge.mods.toml") ||
    readEntry(zip, "META-INF/mods.toml");
  if (!toml) return [];
  const result: string[] = [];
  for (const block of toml
    .split(/^\s*\[\[dependencies\.[^\]]+\]\]\s*$/m)
    .slice(1)) {
    // Limit each table so another mod table cannot provide the mandatory flag.
    const table = block.split(/^\s*\[/m)[0];
    const id = /^\s*modId\s*=\s*["']([\w.:-]+)["']/m.exec(table)?.[1];
    if (
      id &&
      (/^\s*mandatory\s*=\s*true/m.test(table) ||
        /^\s*type\s*=\s*["']required["']/m.test(table))
    )
      result.push(id);
  }
  return result;
}

export interface HealthScannerOptions {
  minecraftRoot: string;
  runtimeDataDir?: string;
  java?: Pick<JavaManager, "inspect" | "discover">;
  totalMemoryMb?: () => number;
  freeMemoryMb?: () => number;
}

export class HealthScanner {
  private java: Pick<JavaManager, "inspect" | "discover">;
  constructor(private options: HealthScannerOptions) {
    this.java =
      options.java ||
      new JavaManager(options.runtimeDataDir || options.minecraftRoot);
  }

  async scan(instance: Instance, settings: Settings): Promise<HealthReport> {
    const dir = instanceGameDirectory(this.options.minecraftRoot, instance);
    const issues: HealthIssue[] = [];
    const add = (issue: HealthIssue) => issues.push(issue);
    let requiredJava = healthJavaMajor(instance.version);
    try {
      const metadataFile = path.join(
        dir,
        `${instanceVersionDirectoryId(instance)}.json`,
      );
      await assertPlainTree(metadataFile);
      const stat = await fs.stat(metadataFile);
      if (stat.size > 8 * 1024 * 1024) throw Error("large");
      const metadata = JSON.parse(await fs.readFile(metadataFile, "utf8"));
      if (
        Number.isInteger(metadata.javaVersion?.majorVersion) &&
        metadata.javaVersion.majorVersion > 0
      )
        requiredJava = metadata.javaVersion.majorVersion;
    } catch {
      add({
        id: "files:version",
        category: "files",
        severity: "error",
        title: "版本配置缺失或损坏",
        detail: "无法读取此实例的版本 JSON。",
        suggestion: "重新扫描目录或从 manifest 重建实例。",
      });
    }
    const customJava = instance.javaPath || settings.javaPath;
    if (customJava) {
      const java = await this.java.inspect(customJava);
      if (
        !java ||
        java.major !== requiredJava ||
        !compatibleJavaArchitecture(java)
      )
        add({
          id: "java:mismatch",
          category: "java",
          severity: "error",
          title: "指定 Java 与游戏要求不匹配",
          detail: `需要 Java ${requiredJava} (${process.arch})，指定环境为 ${java ? `Java ${java.major} (${java.architecture || "未知架构"})` : "无法运行"}。`,
          suggestion: "清空此实例和全局的自定义 Java 路径，恢复自动选择。",
          autoFix: "java-auto",
        });
    } else {
      const local = await this.java.discover();
      if (
        !local.some(
          (java) =>
            java.major === requiredJava && compatibleJavaArchitecture(java),
        )
      )
        add({
          id: "java:provision",
          category: "java",
          severity: "info",
          title: "启动时将补齐 Java",
          detail: `未找到匹配的 Java ${requiredJava} (${process.arch})。`,
          suggestion: "保持联网；原有启动流程会下载并校验所需 Java。",
        });
    }
    const total = this.options.totalMemoryMb?.() ?? os.totalmem() / 1048576;
    const free = this.options.freeMemoryMb?.() ?? os.freemem() / 1048576;
    const memoryMb =
      instance.memoryMb ||
      (settings.memoryMode === "manual"
        ? settings.memoryMb
        : automaticMemoryMb(total * 1048576, free * 1048576));
    const modsDir = path.join(dir, "mods");
    const records: {
      file: string;
      ids: string[];
      dependencies: string[];
      enabled: boolean;
    }[] = [];
    try {
      await assertPlainTree(modsDir);
      for (const file of (await fs.readdir(modsDir))
        .filter((file) => /\.jar(?:\.disabled)?$/i.test(file))
        .slice(0, 4096)) {
        try {
          const full = path.join(modsDir, file);
          const stat = await fs.lstat(full);
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.size > 512 * 1024 * 1024
          )
            throw Error("invalid");
          const zip = new AdmZip(full);
          const metadata = readModMetadata(
            (name) => readEntry(zip, name),
            file,
          );
          records.push({
            file,
            ids: metadata.ids,
            dependencies: requiredIds(zip),
            enabled: !file.endsWith(".disabled"),
          });
        } catch {
          add({
            id: `files:mod:${file}`,
            category: "files",
            severity: "warning",
            title: "无法检查 Mod 元数据",
            detail: file,
            suggestion: "检查 JAR 是否完整。",
          });
        }
      }
    } catch (error: any) {
      if (error.code !== "ENOENT")
        add({
          id: "files:mods",
          category: "files",
          severity: "error",
          title: "Mod 目录无法安全读取",
          detail: "目录包含链接、特殊文件或不可读项。",
          suggestion: "检查目录权限并移除目录联接。",
        });
    }
    const present = new Set([
      "minecraft",
      "java",
      "fabricloader",
      "quilt_loader",
      "forge",
      "neoforge",
      ...records
        .filter((record) => record.enabled)
        .flatMap((record) => record.ids),
    ]);
    // Loader built-ins are only present for their own loader.
    for (const [id, loader] of [
      ["fabricloader", "fabric"],
      ["quilt_loader", "quilt"],
      ["forge", "forge"],
      ["neoforge", "neoforge"],
    ])
      if (
        instance.loader !== loader &&
        !(instance.loader === "quilt" && id === "fabricloader")
      )
        present.delete(id);
    for (const record of records.filter((record) => record.enabled))
      for (const id of record.dependencies) {
        if (!/^[\w.:-]{1,256}$/.test(id) || present.has(id)) continue;
        const disabled = records.find(
          (candidate) => !candidate.enabled && candidate.ids.includes(id),
        );
        add({
          id: `dependency:${record.file}:${id}`,
          category: "dependency",
          severity: "error",
          title: `缺少前置 ${id}`,
          detail: `${record.file} 声明了必需依赖 ${id}。此检查只验证存在性。`,
          suggestion: disabled
            ? "启用已安装的前置 Mod。"
            : "在资源下载中选择此实例，补装兼容的前置 Mod。",
          ...(disabled
            ? { autoFix: "enable-dependency" as const, file: disabled.file }
            : {}),
        });
      }
    const recommended =
      records.filter((record) => record.enabled).length >= 50
        ? 4096
        : instance.loader === "vanilla"
          ? 1024
          : 2048;
    if (memoryMb < recommended || memoryMb > total - 512)
      add({
        id: "memory:allocation",
        category: "memory",
        severity: memoryMb < 512 || memoryMb >= total ? "error" : "warning",
        title: "内存分配不合理",
        detail: `当前 ${Math.round(memoryMb)} MB，建议至少 ${recommended} MB，并为系统保留内存。`,
        suggestion: "恢复自动内存分配；大型整合包请根据需求单独调整。",
        autoFix: "memory",
      });
    try {
      const file = path.join(dir, "logs", "latest.log");
      await assertPlainTree(file);
      const handle = await fs.open(file, "r");
      let text = "";
      try {
        const stat = await handle.stat();
        const size = Math.min(stat.size, 256 * 1024);
        const buffer = Buffer.alloc(size);
        await handle.read(buffer, 0, size, stat.size - size);
        text = buffer.toString("utf8");
      } finally {
        await handle.close();
      }
      const warnings = text
        .split(/\r?\n/)
        .filter((line) => /\b(?:WARN|ERROR|FATAL)\b/i.test(line));
      if (warnings.length)
        add({
          id: "logs:historical",
          category: "logs",
          severity: "warning",
          title: "历史日志包含警告",
          detail: `最近 256 KiB 日志中发现 ${warnings.length} 行警告或错误。`,
          suggestion:
            "打开日志与诊断查看规则分析；历史警告不一定阻止本次启动。",
        });
    } catch {
      /* Missing logs are normal before first launch. Never expose log contents here. */
    }
    const score = Math.max(
      0,
      100 -
        issues.reduce(
          (sum, issue) =>
            sum +
            (issue.severity === "error"
              ? 25
              : issue.severity === "warning"
                ? 8
                : 0),
          0,
        ),
    );
    return {
      schemaVersion: 1,
      instanceId: instance.id,
      scannedAt: new Date().toISOString(),
      score,
      status: issues.some((issue) => issue.severity === "error")
        ? "error"
        : issues.some((issue) => issue.severity === "warning")
          ? "warning"
          : "healthy",
      issues,
      requiredJava,
      memoryMb: Math.round(memoryMb),
      limits: [
        "只验证必需 Mod ID 的存在性，不代替加载器的版本范围与兼容性校验。",
        "扫描仅检查本地文件；不会联网、下载、登录账号或自动修改配置。",
      ],
    };
  }
}
