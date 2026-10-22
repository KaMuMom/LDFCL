import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type {
  CrashCategory,
  CrashDiagnosis,
  DiagnosisEvidence,
  DiagnosisMod,
  DiagnosisSharePayload,
  SuspectedMod,
} from "../../shared/diagnostics";

const MAX_REPORT_BYTES = 2 * 1024 * 1024;
const MAX_LOG_BYTES = 256 * 1024;
const MAX_LINE_LENGTH = 32768;
const MAX_STORED_REPORTS = 50;
const RULE_VERSION = "1.0.0";
const ID = /^[a-zA-Z0-9_-]{1,128}$/;

/** Used for disk, UI and remote payloads; input logs are never sent verbatim. */
export function redactDiagnosticText(
  value: string,
  secrets: string[] = [],
): string {
  let text = value;
  for (const secret of [...new Set(secrets.filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  ))
    text = text.split(secret).join("[REDACTED]");
  return (
    text
      .replace(/(Bearer\s+)[^\s\"'<>]+/gi, "$1[REDACTED]")
      .replace(
        /((?:access[_-]?token|refresh[_-]?token|client[_-]?token|api[_-]?key|authorization|password|session)[\"'\s:=]+)[^\s,;\"'<>]+/gi,
        "$1[REDACTED]",
      )
      .replace(
        /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
        "[TOKEN]",
      )
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[KEY]")
      .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, "[EMAIL]")
      .replace(
        /\b[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\b/gi,
        "[UUID]",
      )
      .replace(
        /\b[A-Z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/\s\"'<>]+/gi,
        "[USER_HOME]",
      )
      .replace(/\/(?:home|Users)\/[^/\s\"'<>]+/g, "[USER_HOME]")
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g, "[IP]")
      .replace(
        /((?:--username|Setting user:|Username:|Player name:)\s+)[^\s,;]+/gi,
        "$1[PLAYER]",
      )
      .replace(
        /((?:Connecting to|Server IP|server address)\s*[:=]?\s*)[^\s,;]+/gi,
        "$1[SERVER]",
      )
      // Minecraft marks chat explicitly. XML tags (including log4j:Message and
      // log4j:Throwable) and Java generic types are ordinary diagnostic output.
      // Stop before a CDATA terminator so a real chat event keeps its XML frame.
      .replace(/\[CHAT\](?:(?!\]\]>)[^\r\n])*/gi, "[CHAT REDACTED]")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
  );
}

export function diagnosisSharePayload(
  report: CrashDiagnosis,
): DiagnosisSharePayload {
  const sanitize = (value: string) =>
    redactDiagnosticText(value).replace(
      /\b[A-Z]:[\\/][^\r\n\s\"'<>]+/gi,
      "[LOCAL_PATH]",
    );
  return {
    category: report.category,
    summary: sanitize(report.summary),
    confidence: report.confidence,
    suspectedMods: report.suspectedMods.map((mod) => ({
      ...mod,
      name: sanitize(mod.name),
      reason: sanitize(mod.reason),
    })),
    evidence: report.evidence.slice(0, 12).map((evidence) => ({
      ...evidence,
      source: sanitize(evidence.source),
      snippet: sanitize(evidence.snippet),
    })),
    recommendations: report.recommendations.map(sanitize),
    logTail: report.logTail
      .slice(-150)
      .map((line) => sanitize(line).slice(0, 1600)),
  };
}

interface Rule {
  id: string;
  category: CrashCategory;
  pattern: RegExp;
  summary: string;
  confidence: number;
  recommendations: string[];
}
const RULES: Rule[] = [
  {
    id: "memory.heap",
    category: "memory",
    pattern:
      /OutOfMemoryError|Java heap space|GC overhead limit exceeded|Could not reserve enough space|Native memory allocation .*failed/i,
    summary: "游戏或 Java 可用内存不足",
    confidence: 0.96,
    recommendations: [
      "关闭占用较高的应用，然后使用自动内存或按物理内存调整分配。",
      "若已分配大量内存，降低资源包分辨率、渲染距离或排查持续增长的内存占用。",
    ],
  },
  {
    id: "java.class-version",
    category: "java",
    pattern:
      /UnsupportedClassVersionError|class file version \d+|only recognizes class file versions|Unsupported major.minor version|requires (?:Java|java) \d+/i,
    summary: "Java 版本与游戏或模组不匹配",
    confidence: 0.97,
    recommendations: [
      "清除自定义 Java 路径，让启动器按版本自动选择或补齐 Java。",
      "检查模组要求的 Java 和 Minecraft 版本是否与实例一致。",
    ],
  },
  {
    id: "mods.duplicate",
    category: "duplicate-mod",
    pattern:
      /DuplicateModsFoundException|Duplicate (?:mods?|mod ID)|Found duplicate mods|duplicate mod ID/i,
    summary: "加载器检测到重复模组",
    confidence: 0.98,
    recommendations: [
      "在模组管理中运行重复检测，保留与实例版本匹配的一份。",
      "调整前创建快照；先禁用重复文件，再重新启动验证。",
    ],
  },
  {
    id: "mods.dependency",
    category: "dependency",
    pattern:
      /MissingModsException|Missing mandatory dependencies|requires (?:any |version |a )?.*?(?:not installed|missing)|depends on .*?(?:missing|not installed)|ModResolutionException|Incompatible mod set|Could not find required mod|requires.*?which is missing/i,
    summary: "存在缺失前置或不兼容的模组版本",
    confidence: 0.94,
    recommendations: [
      "根据日志中的依赖名称安装对应前置，核对 Minecraft 和加载器版本。",
      "运行实例健康检查，恢复被禁用的必需前置或更换不兼容模组。",
    ],
  },
  {
    id: "mods.mixin",
    category: "mixin",
    pattern:
      /MixinApplyError|MixinTransformerError|InvalidMixinException|Mixin apply .*failed|mixin.*(?:injection failure|failed injecting|critical injection failure)/i,
    summary: "模组 Mixin 注入失败，可能存在版本冲突",
    confidence: 0.86,
    recommendations: [
      "核对证据中的 Mixin 所属模组及其前置版本。",
      "创建快照后逐步禁用最近添加或更新的模组，验证冲突组合。",
    ],
  },
  {
    id: "graphics.native",
    category: "graphics",
    pattern:
      /GLFW error|Failed to create (?:the )?(?:OpenGL|window)|Pixel format not accelerated|No OpenGL context|EXCEPTION_ACCESS_VIOLATION.*(?:lwjgl|atio|nvoglv)|UnsatisfiedLinkError|Couldn't load.*lwjgl/i,
    summary: "显卡环境或本机运行库加载失败",
    confidence: 0.87,
    recommendations: [
      "更新显卡驱动并确认该游戏版本的 OpenGL 支持。",
      "关闭光影或图形增强模组后验证，运行健康检查修复缺失运行库。",
    ],
  },
];

export interface DiagnoseTextOptions {
  instanceId: string;
  runId?: string;
  id?: string;
  exitCode?: number | null;
  terminationReason?: CrashDiagnosis["terminationReason"];
  source?: string;
  secrets?: string[];
  mods?: DiagnosisMod[];
  warnings?: string[];
  collectedFiles?: string[];
}

/** Pure, deterministic rules. A generic exit code alone never blames a mod. */
export function diagnoseText(
  input: string,
  options: DiagnoseTextOptions,
): CrashDiagnosis {
  const text = redactDiagnosticText(
    input.slice(-MAX_REPORT_BYTES),
    options.secrets,
  );
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.slice(0, MAX_LINE_LENGTH));
  const matches = RULES.flatMap((rule) => {
    const hits = lines.flatMap((line, index) =>
      rule.pattern.test(line)
        ? [
            {
              source: options.source || "game-output",
              line: index + 1,
              snippet: line.slice(0, 1200),
              ruleId: rule.id,
            },
          ]
        : [],
    );
    return hits.length ? [{ rule, hits }] : [];
  });
  const primary = matches[0]?.rule;
  const evidence: DiagnosisEvidence[] = matches
    .flatMap((match) => match.hits.slice(0, 3))
    .slice(0, 12);
  const suspectedMods: SuspectedMod[] = [];
  // Only explicit mod-id labels or Mixin config ownership count as attribution.
  for (const mod of (options.mods || []).slice(0, 1000)) {
    const ids = [mod.id, ...(mod.ids || [])].filter((id) =>
      /^[a-z0-9_.-]{2,128}$/i.test(id),
    );
    const related = evidence.find((item) =>
      ids.some((id) => {
        const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(
          `(?:mod(?:\\s+id)?\\s*[:=]?\\s*[\\"']?|\\b)${escaped}(?:[\\"']?\\s+(?:requires|depends|failed)|[.:/_-]mixins?|\\.mixins?\\.json)`,
          "i",
        ).test(item.snippet);
      }),
    );
    if (related && suspectedMods.length < 10)
      suspectedMods.push({
        id: mod.id,
        name: redactDiagnosticText(mod.name || mod.id, options.secrets),
        reason: `证据 ${related.ruleId} 明确提及此模组；需要进一步验证`,
        confidence: Math.min(primary?.confidence || 0.5, 0.8),
      });
  }
  const runId = options.runId || randomUUID();
  return {
    schemaVersion: 1,
    id: options.id || runId,
    runId,
    instanceId: options.instanceId,
    createdAt: new Date().toISOString(),
    exitCode: options.exitCode ?? null,
    terminationReason: options.terminationReason || "imported",
    category:
      primary?.category ||
      (options.terminationReason === "launch-error" ? "launch" : "unknown"),
    summary:
      primary?.summary ||
      (options.terminationReason === "launch-error"
        ? "游戏进程未能正常启动"
        : "尚未找到足够证据判断退出原因"),
    confidence: primary?.confidence || 0.2,
    suspectedMods,
    evidence,
    recommendations: primary?.recommendations || [
      "查看本次运行的首个异常和 crash-reports，核对 Java、加载器和最近改动。",
      "使用实例健康检查；调整前创建快照。退出码本身不足以确定故障模组。",
    ],
    ruleVersion: RULE_VERSION,
    source: "rules",
    logTail: lines
      .filter(Boolean)
      .slice(-500)
      .map((line) => line.slice(0, 2000)),
    collectedFiles: options.collectedFiles || [],
    warnings: options.warnings || [],
  };
}

type Baseline = Map<string, { mtimeMs: number; size: number }>;
async function containedFile(root: string, file: string): Promise<boolean> {
  const relative = path.relative(root, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  let cursor = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const stat = await fs.lstat(cursor).catch(() => null);
    if (!stat || stat.isSymbolicLink()) return false;
  }
  const [realRoot, realFile] = await Promise.all([
    fs.realpath(root),
    fs.realpath(file),
  ]);
  const realRelative = path.relative(realRoot, realFile);
  return !realRelative.startsWith("..") && !path.isAbsolute(realRelative);
}
async function crashFiles(root: string): Promise<Baseline> {
  const result: Baseline = new Map();
  const directory = path.join(root, "crash-reports");
  if (!(await containedFile(root, directory).catch(() => false))) return result;
  const names = (await fs.readdir(directory).catch(() => []))
    .filter((name) => /\.(?:txt|log)$/i.test(name))
    .slice(-100);
  for (const name of names) {
    const file = path.join(directory, name);
    const stat = await fs.lstat(file).catch(() => null);
    if (stat?.isFile() && !stat.isSymbolicLink())
      result.set(file, { mtimeMs: stat.mtimeMs, size: stat.size });
  }
  return result;
}
async function boundedText(
  file: string,
  maxBytes = MAX_REPORT_BYTES,
  tail = false,
): Promise<string> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw Error("诊断输入必须是普通文件，不能为链接");
  if (!tail && stat.size > maxBytes) throw Error("崩溃报告超过 2 MiB 限制");
  const handle = await fs.open(file, "r");
  try {
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(
      buffer,
      0,
      length,
      tail ? Math.max(0, stat.size - length) : 0,
    );
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

export interface CrashSessionOptions {
  instanceId: string;
  gameDirectory: string;
  secrets?: string[];
  mods?: DiagnosisMod[];
  onLine?: (line: string, stream: "stdout" | "stderr", runId: string) => void;
}
export interface CrashExit {
  exitCode: number | null;
  signal?: string | null;
  spawnError?: string;
}

export class CrashSession {
  readonly id = randomUUID();
  readonly runId = this.id;
  private stopped = false;
  private completed?: Promise<CrashDiagnosis | undefined>;
  private lines: string[] = [];
  private bytes = 0;
  private streams = {
    stdout: {
      decoder: new StringDecoder("utf8"),
      pending: "",
      dropping: false,
    },
    stderr: {
      decoder: new StringDecoder("utf8"),
      pending: "",
      dropping: false,
    },
  };
  constructor(
    private owner: CrashDiagnostics,
    private options: CrashSessionOptions,
    private baseline: Baseline,
    private latestBaseline: { size: number; mtimeMs: number } | null,
  ) {}
  markStopped(): void {
    this.stopped = true;
  }
  private addLine(line: string, stream: "stdout" | "stderr") {
    const safe = redactDiagnosticText(line, this.options.secrets).slice(
      0,
      MAX_LINE_LENGTH,
    );
    this.lines.push(safe);
    this.bytes += Buffer.byteLength(safe);
    while (this.lines.length > 500 || this.bytes > MAX_LOG_BYTES)
      this.bytes -= Buffer.byteLength(this.lines.shift() || "");
    this.options.onLine?.(safe, stream, this.id);
  }
  capture(stream: "stdout" | "stderr", chunk: Uint8Array | string): void {
    if (this.completed) return;
    const target = this.streams[stream];
    const value =
      typeof chunk === "string"
        ? chunk
        : target.decoder.write(Buffer.from(chunk));
    const parts = value.split("\n");
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      if (!target.dropping) {
        target.pending += part;
        if (target.pending.length > MAX_LINE_LENGTH) {
          target.pending = "";
          target.dropping = true;
        }
      }
      if (index < parts.length - 1) {
        this.addLine(
          target.dropping
            ? "[过长日志行已省略]"
            : target.pending.replace(/\r$/, ""),
          stream,
        );
        target.pending = "";
        target.dropping = false;
      }
    }
  }
  finish(exit: CrashExit): Promise<CrashDiagnosis | undefined> {
    if (this.completed) return this.completed;
    this.completed = this.finalize(exit);
    return this.completed;
  }
  private async finalize(exit: CrashExit): Promise<CrashDiagnosis | undefined> {
    for (const stream of ["stdout", "stderr"] as const) {
      const value = this.streams[stream];
      value.pending += value.decoder.end();
      if (value.pending || value.dropping)
        this.addLine(
          value.dropping ? "[过长日志行已省略]" : value.pending,
          stream,
        );
    }
    if (this.stopped || (exit.exitCode === 0 && !exit.spawnError))
      return undefined;
    const root = this.options.gameDirectory;
    const warnings: string[] = [];
    const collectedFiles: string[] = [];
    let text = this.lines.join("\n");
    if (exit.spawnError)
      text += `\n${redactDiagnosticText(exit.spawnError, this.options.secrets)}`;
    const files = await crashFiles(root);
    let remaining = MAX_REPORT_BYTES;
    for (const [file, stat] of [...files]
      .sort((a, b) => b[1].mtimeMs - a[1].mtimeMs)
      .slice(0, 5)) {
      const prior = this.baseline.get(file);
      if (prior && prior.size === stat.size && prior.mtimeMs === stat.mtimeMs)
        continue;
      if (stat.size > remaining) {
        warnings.push("部分崩溃文件超出本次采集上限，已省略。");
        continue;
      }
      try {
        if (!(await containedFile(root, file))) continue;
        const content = await boundedText(file, remaining);
        remaining -= Buffer.byteLength(content);
        const relative = path.relative(root, file).split(path.sep).join("/");
        collectedFiles.push(
          redactDiagnosticText(relative, this.options.secrets),
        );
        text += `\n--- ${redactDiagnosticText(relative, this.options.secrets)} ---\n${content}`;
      } catch {
        warnings.push("部分崩溃文件无法读取，诊断使用现有日志。");
      }
    }
    const latest = path.join(root, "logs", "latest.log");
    try {
      const stat = await fs.lstat(latest);
      if (
        (!this.latestBaseline ||
          stat.size !== this.latestBaseline.size ||
          stat.mtimeMs !== this.latestBaseline.mtimeMs) &&
        (await containedFile(root, latest))
      ) {
        text += `\n--- logs/latest.log ---\n${await boundedText(latest, MAX_LOG_BYTES, true)}`;
        collectedFiles.push("logs/latest.log");
      }
    } catch {
      /* Optional game output remains useful when latest.log is absent. */
    }
    const report = diagnoseText(text, {
      ...this.options,
      runId: this.id,
      exitCode: exit.exitCode,
      terminationReason: exit.spawnError ? "launch-error" : "crash",
      collectedFiles,
      warnings,
    });
    await this.owner.save(report);
    return report;
  }
}

export class CrashDiagnostics {
  private directory: string;
  private queue = Promise.resolve();
  constructor(
    dataDir: string,
    private options: { onDiagnosis?: (diagnosis: CrashDiagnosis) => void } = {},
  ) {
    this.directory = path.join(dataDir, "diagnostics");
  }
  async begin(options: CrashSessionOptions): Promise<CrashSession> {
    if (!ID.test(options.instanceId)) throw Error("实例标识无效");
    const gameDirectory = await fs.realpath(options.gameDirectory);
    const baseline = await crashFiles(gameDirectory);
    const stat = await fs
      .lstat(path.join(gameDirectory, "logs", "latest.log"))
      .catch(() => null);
    return new CrashSession(
      this,
      { ...options, gameDirectory },
      baseline,
      stat?.isFile() ? { size: stat.size, mtimeMs: stat.mtimeMs } : null,
    );
  }
  async save(report: CrashDiagnosis): Promise<void> {
    if (!ID.test(report.id)) throw Error("诊断标识无效");
    const work = this.queue
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(this.directory, { recursive: true });
        const destination = path.join(this.directory, `${report.id}.json`);
        const temporary = `${destination}.${randomUUID()}.tmp`;
        try {
          await fs.writeFile(temporary, JSON.stringify(report, null, 2), {
            mode: 0o600,
          });
          await fs.rename(temporary, destination);
        } finally {
          await fs.rm(temporary, { force: true });
        }
        const names = (await fs.readdir(this.directory)).filter((name) =>
          /^[a-zA-Z0-9_-]+\.json$/.test(name),
        );
        const dated = await Promise.all(
          names.map(async (name) => ({
            name,
            stat: await fs
              .lstat(path.join(this.directory, name))
              .catch(() => null),
          })),
        );
        for (const entry of dated
          .filter((entry) => entry.stat?.isFile())
          .sort((a, b) => b.stat!.mtimeMs - a.stat!.mtimeMs)
          .slice(MAX_STORED_REPORTS))
          await fs.rm(path.join(this.directory, entry.name), { force: true });
        this.options.onDiagnosis?.(report);
      });
    this.queue = work;
    return work;
  }
  async get(id: string): Promise<CrashDiagnosis> {
    if (!ID.test(id)) throw Error("诊断标识无效");
    const report = JSON.parse(
      await boundedText(path.join(this.directory, `${id}.json`)),
    );
    if (
      report.schemaVersion !== 1 ||
      report.id !== id ||
      !Array.isArray(report.evidence) ||
      !Array.isArray(report.logTail) ||
      !ID.test(report.instanceId)
    )
      throw Error("诊断数据格式无效");
    return report;
  }
  async list(instanceId?: string): Promise<CrashDiagnosis[]> {
    const names = (await fs.readdir(this.directory).catch(() => []))
      .filter((name) => /^[a-zA-Z0-9_-]+\.json$/.test(name))
      .slice(0, MAX_STORED_REPORTS + 10);
    const results = await Promise.all(
      names.map((name) => this.get(name.slice(0, -5)).catch(() => null)),
    );
    return results
      .filter(
        (value): value is CrashDiagnosis =>
          !!value && (!instanceId || value.instanceId === instanceId),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async getSharePayload(id: string): Promise<DiagnosisSharePayload> {
    return diagnosisSharePayload(await this.get(id));
  }
  async importReport(options: {
    instanceId: string;
    file: string;
    gameDirectory?: string;
    secrets?: string[];
    mods?: DiagnosisMod[];
  }): Promise<CrashDiagnosis> {
    if (!ID.test(options.instanceId)) throw Error("实例标识无效");
    const text = await boundedText(path.resolve(options.file));
    const report = diagnoseText(text, {
      instanceId: options.instanceId,
      secrets: options.secrets,
      mods: options.mods,
      source: "imported-report",
      terminationReason: "imported",
      collectedFiles: ["imported-report"],
    });
    await this.save(report);
    return report;
  }
}
