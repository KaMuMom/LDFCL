import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { LAUNCHER_USER_AGENT } from "../../shared/launcher";
import type {
  DownloadContext,
  DownloadFileProgress,
  DownloadPlanStage,
  DownloadTaskProgress,
  Task,
} from "../../shared/types";
import {
  downloadUrls,
  getDownloadSource,
  type DownloadSource,
} from "./download-source";
import { replaceStorageFile, safeDirectory } from "./content-store";
export {
  downloadUrls,
  getDownloadSource,
  setDownloadSource,
} from "./download-source";
import {
  destinationKey,
  transferQueue,
  withDestination,
  registerDownloadFiles,
  finishDownloadFiles,
} from "./download-queue";
export { getDownloadTaskFiles } from "./download-queue";
export type { DownloadContext } from "../../shared/types";

export interface DownloadItem {
  url: string;
  path: string;
  sha1?: string;
  sha256?: string;
  sha512?: string;
  size?: number;
  maxBytes?: number;
  requireHttps?: boolean;
  source?: DownloadSource;
  /** Human-readable filename when the destination is an internal cache hash. */
  name?: string;
}
export type Emit = (event: any) => void;
type Meter = (
  received: number,
  total: number,
  phase?: "downloading" | "verifying",
) => void;
const plans = new Map<string, DownloadPlan>();
function emitTask(emit: Emit, task: Task) {
  const plan = task.download?.planId
    ? plans.get(task.download.planId)
    : undefined;
  if (
    task.download?.planFileId === undefined ||
    (plan && !plan.groupsFile(task.download))
  )
    emit({ type: "task", task });
  plan?.observe(task);
}
export interface DownloadPlanOptions {
  title: string;
  context?: DownloadContext;
  stages: Array<{ id: string; title: string }>;
}
/** Stages are declared before metadata is resolved; never imply that an unknown
 * asset/Java/loader list is already downloaded or invent an overall percentage. */
export class DownloadPlan {
  readonly id = randomUUID();
  private stages: DownloadPlanStage[];
  private batches = new Map<string, Task>();
  private status = "running";
  private detail?: string;
  private stageFiles = new Map<string, FileTracker>();
  private lastReport = 0;
  private reportTimer?: ReturnType<typeof setTimeout>;
  readonly control = new TaskControl(() => this.report());
  constructor(
    private emit: Emit,
    private options: DownloadPlanOptions,
  ) {
    if (
      !options.stages.length ||
      new Set(options.stages.map((stage) => stage.id)).size !==
        options.stages.length
    )
      throw new Error("下载阶段不能为空或重复");
    this.stages = options.stages.map((stage) => ({
      ...stage,
      status: "pending",
    }));
    plans.set(this.id, this);
    activeTasks.set(this.id, this.control);
    this.report();
  }
  context(stageId: string, planFileId?: string): DownloadContext {
    this.stage(stageId);
    return { ...this.options.context, planId: this.id, stageId, planFileId };
  }
  groupsFile(context?: DownloadContext): boolean {
    return (
      !!context?.stageId &&
      context.planFileId !== undefined &&
      this.stageFiles.has(context.stageId)
    );
  }
  setContext(context: DownloadContext) {
    this.options.context = { ...this.options.context, ...context };
    this.report();
  }
  async ready(): Promise<void> {
    await this.control.ready();
  }
  private stage(id: string) {
    const stage = this.stages.find((item) => item.id === id);
    if (!stage) throw new Error("下载阶段不存在");
    return stage;
  }
  startStage(id: string) {
    if (this.control.cancelled) throw new DownloadCancelledError();
    this.stage(id).status = "resolving";
    this.report();
  }
  completeStage(id: string) {
    if (this.control.cancelled) throw new DownloadCancelledError();
    this.stage(id).status = "completed";
    const tracker = this.stageFiles.get(id);
    if (tracker) {
      for (let index = 0; index < tracker.files.length; index++)
        tracker.update(index, {
          status: "completed",
          receivedBytes:
            tracker.files[index].totalBytes ??
            tracker.files[index].receivedBytes,
        });
      this.stage(id).completedFiles = tracker.files.length;
    }
    this.report();
  }
  setStageFiles(id: string, files: Array<{ name: string; size?: number }>) {
    const stage = this.stage(id);
    const tracker = new FileTracker(
      files.map((file) => ({
        path: file.name,
        name: file.name,
        size: file.size,
        url: "https://unused.invalid/",
      })),
    );
    this.stageFiles.set(id, tracker);
    stage.fileListId = `${this.id}:${id}`;
    stage.totalFiles = files.length;
    stage.completedFiles = 0;
    registerDownloadFiles(stage.fileListId, tracker.files);
    this.report();
  }
  completeFile(stageId: string, fileId: string) {
    const tracker = this.stageFiles.get(stageId);
    const index = Number(fileId);
    if (!tracker || !Number.isSafeInteger(index) || !tracker.files[index])
      return;
    tracker.update(index, {
      status: "completed",
      receivedBytes:
        tracker.files[index].totalBytes ?? tracker.files[index].receivedBytes,
    });
    this.stage(stageId).completedFiles = tracker.summary().completedFiles;
    this.report(false);
  }
  observe(task: Task) {
    if (this.status !== "running") return;
    const stage = this.stages.find(
      (item) => item.id === task.download?.stageId,
    );
    if (!stage) return;
    const tracker = this.stageFiles.get(stage.id);
    if (tracker) {
      const index = Number(task.download?.planFileId);
      if (
        task.download?.planFileId !== undefined &&
        Number.isSafeInteger(index) &&
        tracker.files[index]
      ) {
        const status =
          task.status === "completed"
            ? "completed"
            : task.status === "failed" || task.status === "error"
              ? "failed"
              : task.status === "cancelled"
                ? "cancelled"
                : "downloading";
        tracker.update(index, {
          status,
          receivedBytes: task.download?.receivedBytes || 0,
          ...(task.download?.totalBytes !== undefined
            ? { totalBytes: task.download.totalBytes }
            : {}),
        });
      }
      stage.completedFiles = tracker.summary().completedFiles;
    } else {
      this.batches.set(task.id, task);
      const children = [...this.batches.values()].filter(
        (item) => item.download?.stageId === stage.id,
      );
      stage.totalFiles = children.reduce(
        (sum, item) => sum + (item.download?.totalFiles || 0),
        0,
      );
      stage.completedFiles = children.reduce(
        (sum, item) => sum + (item.download?.completedFiles || 0),
        0,
      );
    }
    if (stage.status !== "completed")
      stage.status =
        task.status === "failed" || task.status === "error"
          ? "error"
          : task.status === "cancelled"
            ? "cancelled"
            : "running";
    this.report(false);
  }
  complete() {
    if (this.control.cancelled) throw new DownloadCancelledError();
    this.status = "completed";
    for (const stage of this.stages) {
      stage.status = "completed";
      if (stage.fileListId) finishDownloadFiles(stage.fileListId);
    }
    this.report();
    activeTasks.delete(this.id);
    plans.delete(this.id);
  }
  fail(error: unknown) {
    this.status =
      error instanceof DownloadCancelledError ? "cancelled" : "error";
    this.detail = String(error);
    for (const stage of this.stages)
      if (["running", "resolving"].includes(stage.status))
        stage.status = this.status === "cancelled" ? "cancelled" : "error";
    if (!this.control.cancelled) this.control.action("cancel");
    this.report();
    for (const stage of this.stages)
      if (stage.fileListId) finishDownloadFiles(stage.fileListId);
    activeTasks.delete(this.id);
    plans.delete(this.id);
  }
  private report(force = true) {
    if (!force && Date.now() - this.lastReport < 200) {
      this.reportTimer ??= setTimeout(
        () => {
          this.reportTimer = undefined;
          this.report();
        },
        200 - (Date.now() - this.lastReport),
      );
      return;
    }
    clearTimeout(this.reportTimer);
    this.reportTimer = undefined;
    this.lastReport = Date.now();
    const status =
      this.status === "running"
        ? this.control.cancelled
          ? "cancelled"
          : this.control.paused
            ? "paused"
            : "running"
        : this.status;
    const summaries = [...this.stageFiles.values()]
      .map((tracker) => tracker.summary())
      .concat([...this.batches.values()].map((task) => task.download!));
    this.emit({
      type: "task",
      task: {
        id: this.id,
        title: this.options.title,
        status,
        progress: this.status === "completed" ? 1 : 0,
        detail: this.detail,
        source: this.control.source,
        controllable: this.status === "running" && !this.control.cancelled,
        download: {
          ...this.options.context,
          kind: "plan",
          progressMode: "indeterminate",
          stages: this.stages.map((stage) => ({ ...stage })),
          activeFiles: summaries
            .flatMap((summary) => summary.activeFiles || [])
            .slice(0, 32),
          receivedBytes: summaries.reduce(
            (sum, summary) => sum + (summary.receivedBytes || 0),
            0,
          ),
          totalFiles: this.stages.reduce(
            (sum, stage) => sum + (stage.totalFiles || 0),
            0,
          ),
          completedFiles: this.stages.reduce(
            (sum, stage) => sum + (stage.completedFiles || 0),
            0,
          ),
        },
      },
    });
  }
}
function fileRecord(item: DownloadItem, index: number): DownloadFileProgress {
  return {
    id: String(index),
    name: path
      .basename(item.name || item.path)
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .slice(0, 512),
    status: "queued",
    receivedBytes: 0,
    totalBytes: item.size,
  };
}
class FileTracker {
  readonly files: DownloadFileProgress[];
  private active = new Map<string, DownloadFileProgress>();
  private completed = 0;
  private received = 0;
  private total = 0;
  private unknown = 0;
  phase: DownloadTaskProgress["phase"] = "queued";
  constructor(
    items: DownloadItem[],
    private context: DownloadContext = {},
  ) {
    this.files = items.map(fileRecord);
    for (const file of this.files) {
      if (file.totalBytes === undefined) this.unknown++;
      else this.total += file.totalBytes;
    }
  }
  update(index: number, patch: Partial<DownloadFileProgress>) {
    const file = this.files[index];
    this.received -= file.receivedBytes;
    this.total -= file.totalBytes ?? 0;
    if (file.totalBytes === undefined) this.unknown--;
    if (file.status === "completed") this.completed--;
    Object.assign(file, patch);
    this.received += file.receivedBytes;
    this.total += file.totalBytes ?? 0;
    if (file.totalBytes === undefined) this.unknown++;
    if (file.status === "completed") this.completed++;
    if (file.status === "downloading") this.active.set(file.id, file);
    else this.active.delete(file.id);
  }
  summary(): DownloadTaskProgress {
    return {
      ...this.context,
      kind: "files",
      phase: this.phase,
      progressMode: this.unknown ? "files" : "bytes",
      totalFiles: this.files.length,
      completedFiles: this.completed,
      receivedBytes: this.received,
      ...(!this.unknown ? { totalBytes: this.total } : {}),
      activeFiles: [...this.active.values()]
        .slice(0, 32)
        .map((file) => ({ ...file })),
    };
  }
}
const algorithms = ["sha1", "sha256", "sha512"] as const;
export class DownloadCancelledError extends Error {
  constructor() {
    super("下载已取消");
    this.name = "DownloadCancelledError";
  }
}
class DownloadPausedError extends Error {}
class TaskControl {
  paused = false;
  cancelled = false;
  source = getDownloadSource();
  private controllers = new Set<AbortController>();
  private wake = new Set<() => void>();
  constructor(readonly report: () => void) {}
  action(action: "pause" | "resume" | "cancel") {
    if (action === "pause") this.paused = true;
    else if (action === "resume") this.paused = false;
    else {
      this.cancelled = true;
      this.paused = false;
    }
    if (action !== "resume")
      for (const controller of this.controllers)
        controller.abort(
          this.cancelled
            ? new DownloadCancelledError()
            : new DownloadPausedError(),
        );
    if (!this.paused) for (const resolve of this.wake) resolve();
    this.report();
  }
  async ready() {
    if (this.cancelled) throw new DownloadCancelledError();
    if (this.paused)
      await new Promise<void>((resolve) => this.wake.add(resolve));
    this.wake.clear();
    if (this.cancelled) throw new DownloadCancelledError();
  }
  attach(controller: AbortController) {
    this.controllers.add(controller);
    if (this.paused || this.cancelled)
      controller.abort(
        this.cancelled
          ? new DownloadCancelledError()
          : new DownloadPausedError(),
      );
  }
  detach(controller: AbortController) {
    this.controllers.delete(controller);
  }
}
const activeTasks = new Map<string, TaskControl>();
export function controlDownload(
  id: string,
  action: "pause" | "resume" | "cancel",
): void {
  if (!["pause", "resume", "cancel"].includes(action))
    throw new Error("无效下载操作");
  const task = activeTasks.get(id);
  if (!task) throw new Error("任务已结束或不存在");
  task.action(action);
}
export function setTaskDownloadSource(
  id: string,
  source: DownloadSource,
): void {
  if (!["official", "bmclapi"].includes(source)) throw new Error("无效下载源");
  const task = activeTasks.get(id);
  if (!task) throw new Error("任务已结束或不存在");
  task.source = source;
  task.report();
}
class TransferError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}
function httpError(status: number, url: string): TransferError {
  return new TransferError(
    `请求失败 (${status}): ${new URL(url).hostname}`,
    [408, 425, 429].includes(status) || status >= 500,
  );
}
function canRetry(error: unknown): boolean {
  if (
    error instanceof DownloadCancelledError ||
    error instanceof DownloadPausedError
  )
    return false;
  if (error instanceof TransferError) return error.retryable;
  return ![
    "EACCES",
    "EPERM",
    "ENOSPC",
    "EROFS",
    "EISDIR",
    "ENOTDIR",
    "EINVAL",
  ].includes((error as NodeJS.ErrnoException)?.code ?? "");
}
const backoff = (attempt: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
export async function fileHash(
  file: string,
  algorithm = "sha1",
): Promise<string> {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
function validate(item: DownloadItem): void {
  const url = new URL(item.url);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    (item.requireHttps && url.protocol !== "https:")
  )
    throw new TransferError("下载地址必须使用有效的 HTTP/HTTPS 协议");
  for (const [value, name] of [
    [item.size, "文件大小"],
    [item.maxBytes, "下载上限"],
  ] as const)
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
      throw new TransferError(`${name}无效`);
  if (
    item.size !== undefined &&
    item.maxBytes !== undefined &&
    item.size > item.maxBytes
  )
    throw new TransferError("文件大小超过下载上限");
  for (const algorithm of algorithms) {
    const digest = item[algorithm];
    const length = { sha1: 40, sha256: 64, sha512: 128 }[algorithm];
    if (
      digest !== undefined &&
      !new RegExp(`^[a-f0-9]{${length}}$`, "i").test(digest)
    )
      throw new TransferError(`${algorithm} 校验值无效`);
  }
}
function mergeDestinations(items: DownloadItem[]): DownloadItem[] {
  const destinations = new Map<string, DownloadItem>();
  for (const item of items) {
    validate(item);
    const key = destinationKey(item.path);
    const previous = destinations.get(key);
    if (!previous) {
      destinations.set(key, { ...item });
      continue;
    }
    for (const field of [...algorithms, "size"] as const) {
      const a = previous[field],
        b = item[field];
      if (
        a !== undefined &&
        b !== undefined &&
        String(a).toLowerCase() !== String(b).toLowerCase()
      )
        throw new TransferError(
          `同一下载目标存在冲突的 ${field}：${path.basename(item.path)}`,
        );
    }
    const merged = { ...previous, ...item };
    for (const algorithm of algorithms)
      merged[algorithm] = item[algorithm] ?? previous[algorithm];
    merged.size = item.size ?? previous.size;
    merged.maxBytes = Math.min(
      item.maxBytes ?? Infinity,
      previous.maxBytes ?? Infinity,
    );
    if (!Number.isFinite(merged.maxBytes)) delete merged.maxBytes;
    merged.requireHttps = previous.requireHttps || item.requireHttps;
    validate(merged);
    destinations.set(key, merged);
  }
  return [...destinations.values()];
}
async function valid(item: DownloadItem): Promise<boolean> {
  try {
    const stat = await fs.lstat(item.path);
    if (
      !stat.isFile() ||
      (item.size !== undefined && item.size !== stat.size) ||
      (item.maxBytes !== undefined && stat.size > item.maxBytes)
    )
      return false;
    const expected = algorithms.filter(
      (algorithm) => item[algorithm] !== undefined,
    );
    if (!expected.length) return stat.size > 0 || item.size === 0;
    const hashes = expected.map((algorithm) => createHash(algorithm));
    for await (const chunk of createReadStream(item.path))
      for (const hash of hashes) hash.update(chunk);
    return hashes.every(
      (hash, index) =>
        hash.digest("hex") === item[expected[index]]!.toLowerCase(),
    );
  } catch {
    return false;
  }
}
export async function requestJson<T = any>(url: string): Promise<T> {
  let last: unknown;
  for (const target of downloadUrls(url))
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(target, {
          headers: { "User-Agent": LAUNCHER_USER_AGENT },
          signal: AbortSignal.timeout(45000),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw httpError(response.status, target);
        }
        return (await response.json()) as T;
      } catch (error) {
        last = error;
        if (!canRetry(error) || attempt === 2) break;
        await backoff(attempt);
      }
    }
  throw last;
}
export class DownloadManager {
  constructor(
    public dataDir: string,
    private emit: Emit = () => {},
    concurrency = 8,
    private defaultContext: DownloadContext = {},
  ) {
    this.concurrency = concurrency;
  }
  get concurrency(): number {
    return transferQueue.concurrency;
  }
  set concurrency(value: number) {
    transferQueue.concurrency = value;
  }

  createPlan(options: DownloadPlanOptions): DownloadPlan {
    return new DownloadPlan(this.emit, options);
  }
  scoped(context: DownloadContext): DownloadManager {
    return new DownloadManager(this.dataDir, this.emit, this.concurrency, {
      ...this.defaultContext,
      ...context,
    });
  }

  async download(
    url: string,
    dest: string,
    sha1?: string,
    size?: number,
    label?: string,
    context?: DownloadContext,
  ): Promise<void> {
    return this.downloadVerified(
      { url, path: dest, sha1, size },
      label,
      context,
    );
  }
  async downloadVerified(
    item: DownloadItem,
    label?: string,
    context?: DownloadContext,
  ): Promise<void> {
    context = { ...this.defaultContext, ...context };
    const id = randomUUID();
    const tracker = new FileTracker([item], context);
    if (!context?.planId || !plans.get(context.planId)?.groupsFile(context))
      registerDownloadFiles(id, tracker.files);
    let progress = 0;
    let currentDetail: string | undefined;
    let control!: TaskControl;
    const report = (status: string, detail?: string) => {
      if (control?.cancelled) status = "cancelled";
      else if (control?.paused && status === "running") status = "paused";
      currentDetail = detail ?? currentDetail;
      emitTask(this.emit, {
        id,
        title: label || path.basename(item.path),
        progress: status === "completed" ? 1 : progress,
        status,
        detail: currentDetail,
        controllable: ["running", "paused"].includes(status),
        source: control?.source ?? getDownloadSource(),
        download: tracker.summary(),
      });
    };
    control =
      (context?.planId ? plans.get(context.planId)?.control : undefined) ||
      new TaskControl(() =>
        report(
          control.cancelled
            ? "cancelled"
            : control.paused
              ? "paused"
              : "running",
        ),
      );
    activeTasks.set(id, control);
    report("running");
    try {
      await this.transfer(
        item,
        (received, total, phase = "downloading") => {
          tracker.phase = phase;
          tracker.update(0, {
            status: "downloading",
            receivedBytes: received,
            ...(total > 0 || item.size === 0 ? { totalBytes: total } : {}),
          });
          progress = total ? Math.min(0.99, received / total) : 0;
          report(
            "running",
            `${(received / 1048576).toFixed(1)} / ${total ? (total / 1048576).toFixed(1) : "?"} MB`,
          );
        },
        control,
      );
      tracker.update(0, {
        status: "completed",
        totalBytes:
          tracker.files[0].totalBytes ?? tracker.files[0].receivedBytes,
      });
      report("completed");
    } catch (error) {
      tracker.update(0, {
        status:
          error instanceof DownloadCancelledError ? "cancelled" : "failed",
      });
      report(
        error instanceof DownloadCancelledError ? "cancelled" : "failed",
        String(error),
      );
      throw error;
    } finally {
      activeTasks.delete(id);
      finishDownloadFiles(id);
    }
  }
  private async transfer(
    item: DownloadItem,
    meter: Meter,
    control: TaskControl,
  ): Promise<void> {
    validate(item);
    await withDestination(item.path, async () => {
      await control.ready();
      meter(0, item.size ?? 0, "verifying");
      if (await valid(item)) {
        await control.ready();
        const size = item.size ?? (await fs.stat(item.path)).size;
        meter(size, size, "verifying");
        return;
      }
      await safeDirectory(path.dirname(item.path), true);
      let last: unknown;
      let attempt = 0;
      while (attempt < 3) {
        try {
          await control.ready();
        } catch (error) {
          await this.clearPartial(item.path);
          throw error;
        }
        const controller = new AbortController();
        control.attach(controller);
        try {
          await transferQueue.run(async () => {
            meter(0, item.size ?? 0, "downloading");
            const urls = downloadUrls(item.url, item.source ?? control.source);
            let sourceError: unknown;
            for (const url of urls) {
              try {
                await this.attempt({ ...item, url }, meter, controller);
                return;
              } catch (error) {
                if (
                  control.paused ||
                  control.cancelled ||
                  controller.signal.aborted
                )
                  throw error;
                sourceError = error;
              }
            }
            throw sourceError;
          }, controller.signal);
          return;
        } catch (error) {
          if (control.cancelled) {
            await this.clearPartial(item.path);
            throw new DownloadCancelledError();
          }
          if (control.paused || error instanceof DownloadPausedError) continue;
          last = error;
          if (!canRetry(error) || attempt === 2) break;
          await backoff(attempt);
          attempt++;
        } finally {
          control.detach(controller);
        }
      }
      throw last;
    });
  }
  private async clearPartial(destination: string) {
    await fs.rm(`${destination}.part`, { force: true });
    await fs.rm(`${destination}.part.meta`, { force: true });
  }
  private async attempt(
    item: DownloadItem,
    meter: Meter,
    parentController: AbortController,
  ): Promise<void> {
    const controller = new AbortController();
    const interrupt = () => controller.abort(parentController.signal.reason);
    parentController.signal.addEventListener("abort", interrupt, {
      once: true,
    });
    if (parentController.signal.aborted) interrupt();
    const temporary = `${item.path}.part`;
    const metadataFile = `${temporary}.meta`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let response: Response | undefined;
    let bodyConsumed = false;
    let retain = true;
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => controller.abort(new TransferError("下载超时", true)),
        60000,
      );
    };
    try {
      // A partial is reusable only for identical expected content and source.
      const identity = JSON.stringify([
        item.url,
        item.size,
        item.sha1,
        item.sha256,
        item.sha512,
      ]);
      let partial:
        | { identity: string; etag?: string; modified?: string; total?: number }
        | undefined;
      let offset = 0;
      try {
        const metaStat = await fs.lstat(metadataFile),
          partStat = await fs.lstat(temporary);
        if (
          !metaStat.isFile() ||
          metaStat.isSymbolicLink() ||
          metaStat.size > 65536 ||
          !partStat.isFile() ||
          partStat.isSymbolicLink()
        )
          throw new TransferError("下载临时文件包含不受支持的链接");
        partial = JSON.parse(await fs.readFile(metadataFile, "utf8"));
        if (
          partial?.identity === identity &&
          (partial.etag ||
            partial.modified ||
            algorithms.some((algorithm) => item[algorithm]))
        )
          offset = partStat.size;
      } catch (error: any) {
        if (error instanceof TransferError) throw error;
      }
      if (!offset) {
        await this.clearPartial(item.path);
        partial = undefined;
      } else if (await valid({ ...item, path: temporary })) {
        // Do not publish an unbounded partial lacking an authoritative length/hash.
        if (
          item.size !== undefined ||
          algorithms.some((algorithm) => item[algorithm])
        ) {
          controller.signal.throwIfAborted();
          await replaceStorageFile(temporary, item.path);
          await fs.rm(metadataFile, { force: true });
          return;
        }
      }
      touch();
      const headers: Record<string, string> = {
        "User-Agent": LAUNCHER_USER_AGENT,
        "Accept-Encoding": "identity",
      };
      if (offset) {
        headers.Range = `bytes=${offset}-`;
        const validator = partial?.etag || partial?.modified;
        if (validator) headers["If-Range"] = validator;
      }
      response = await fetch(item.url, {
        headers,
        signal: controller.signal,
      });
      if (item.requireHttps && new URL(response.url).protocol !== "https:")
        throw new TransferError("下载重定向至非 HTTPS 地址");
      if (response.status === 416 && offset) {
        const total = /^bytes \*\/(\d+)$/.exec(
          response.headers.get("content-range") || "",
        );
        const identityVerified =
          algorithms.some((algorithm) => item[algorithm]) ||
          (partial?.etag && response.headers.get("etag") === partial.etag) ||
          (partial?.modified &&
            response.headers.get("last-modified") === partial.modified);
        if (
          identityVerified &&
          total &&
          Number(total[1]) === offset &&
          (await valid({ ...item, size: item.size ?? offset, path: temporary }))
        ) {
          controller.signal.throwIfAborted();
          await replaceStorageFile(temporary, item.path);
          await fs.rm(metadataFile, { force: true });
          meter(offset, offset);
          return;
        }
        await this.clearPartial(item.path);
        throw new TransferError("服务器拒绝续传范围，将重新下载", true);
      }
      if (!response.ok) throw httpError(response.status, item.url);
      if (!response.body) throw new TransferError("下载响应为空", true);
      if (response.status === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
          response.headers.get("content-range") || "",
        );
        if (
          !range ||
          Number(range[1]) !== offset ||
          Number(range[2]) < offset ||
          Number(range[3]) <= Number(range[2]) ||
          (partial?.etag &&
            response.headers.get("etag") &&
            response.headers.get("etag") !== partial.etag)
        ) {
          retain = false;
          throw new TransferError("续传范围或资源标识不匹配", true);
        }
      } else offset = 0;
      const rawLength = response.headers.get("content-length");
      const parsedLength =
        rawLength !== null && !response.headers.get("content-encoding")
          ? Number(rawLength)
          : undefined;
      const headerLength =
        parsedLength !== undefined &&
        Number.isSafeInteger(parsedLength) &&
        parsedLength >= 0
          ? parsedLength
          : undefined;
      const rangeTotal =
        response.status === 206
          ? Number(response.headers.get("content-range")?.split("/")[1])
          : undefined;
      const expectedLength =
        rangeTotal ??
        (headerLength !== undefined ? offset + headerLength : undefined);
      if (expectedLength !== undefined) {
        if (item.maxBytes !== undefined && expectedLength > item.maxBytes)
          throw new TransferError("文件大小超过下载上限");
        if (item.size !== undefined && item.size !== expectedLength)
          throw new TransferError("下载文件大小与预期不符", true);
      }
      const total = item.size ?? expectedLength ?? 0;
      const responseEtag = response.headers.get("etag");
      const meta = {
        identity,
        etag:
          responseEtag && !responseEtag.startsWith("W/")
            ? responseEtag
            : undefined,
        modified: response.headers.get("last-modified") || undefined,
        total,
      };
      // Never follow symlinks supplied as a metadata/partial target.
      for (const file of [temporary, metadataFile]) {
        try {
          if ((await fs.lstat(file)).isSymbolicLink())
            throw new TransferError("下载临时文件包含链接");
        } catch (error: any) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      await fs.writeFile(metadataFile, JSON.stringify(meta), { flag: "w" });
      let received = offset,
        lastUpdate = 0;
      const meterStream = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          received += chunk.length;
          touch();
          if (
            (item.maxBytes !== undefined && received > item.maxBytes) ||
            (item.size !== undefined && received > item.size)
          ) {
            callback(new TransferError("下载文件超出预期大小"));
            return;
          }
          if (Date.now() - lastUpdate >= 200) {
            meter(received, total);
            lastUpdate = Date.now();
          }
          callback(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(response.body as any),
        meterStream,
        createWriteStream(temporary, { flags: offset ? "a" : "w" }),
        { signal: controller.signal },
      );
      bodyConsumed = true;
      clearTimeout(timer);
      meter(received, total, "verifying");
      if (
        (total && received !== total) ||
        !(await valid({ ...item, path: temporary }))
      ) {
        retain = false;
        throw new TransferError("下载文件校验失败，将自动重试", true);
      }
      // Rename publishes a verified file; an existing destination stays intact if publication fails.
      controller.signal.throwIfAborted();
      await replaceStorageFile(temporary, item.path);
      await fs.rm(metadataFile, { force: true });
    } catch (error) {
      if (
        !canRetry(error) &&
        !(controller.signal.reason instanceof DownloadPausedError)
      )
        retain = false;
      throw controller.signal.aborted
        ? controller.signal.reason || error
        : error;
    } finally {
      clearTimeout(timer);
      parentController.signal.removeEventListener("abort", interrupt);
      // A completed body has already released its connection. Aborting it and
      // cancelling it again races HTTP parser shutdown on some Node versions.
      // pipeline owns cancellation once Readable.fromWeb has locked the body.
      if (
        response?.body &&
        !bodyConsumed &&
        !response.body.locked &&
        !controller.signal.aborted
      ) {
        try {
          await response.body.cancel();
        } catch {
          controller.abort();
        }
      }
      if (!retain) await this.clearPartial(item.path);
    }
  }
  async downloadMany(
    items: DownloadItem[],
    label = "下载游戏文件",
    context?: DownloadContext,
  ): Promise<void> {
    context = { ...this.defaultContext, ...context };
    const id = randomUUID();
    let control!: TaskControl;
    let unique: DownloadItem[];
    try {
      unique = mergeDestinations(items);
    } catch (error) {
      emitTask(this.emit, {
        id,
        title: label,
        progress: 0,
        status: "failed",
        detail: String(error),
        download: { ...context, kind: "files", progressMode: "indeterminate" },
      });
      throw error;
    }
    const tracker = new FileTracker(unique, context);
    registerDownloadFiles(id, tracker.files);
    let next = 0,
      done = 0,
      failed = false,
      failure: unknown;
    let lastReport = 0;
    let reportTimer: ReturnType<typeof setTimeout> | undefined;
    const report = (requestedStatus: string, force = false) => {
      const status = control?.cancelled
        ? "cancelled"
        : control?.paused
          ? "paused"
          : requestedStatus;
      if (!force && Date.now() - lastReport < 200) {
        reportTimer ??= setTimeout(
          () => {
            reportTimer = undefined;
            report(requestedStatus, true);
          },
          200 - (Date.now() - lastReport),
        );
        return;
      }
      clearTimeout(reportTimer);
      reportTimer = undefined;
      lastReport = Date.now();
      const download = tracker.summary();
      const fraction = download.totalBytes
        ? (download.receivedBytes || 0) / download.totalBytes
        : done / Math.max(1, unique.length);
      emitTask(this.emit, {
        id,
        title: label,
        progress: status === "completed" ? 1 : Math.min(0.99, fraction),
        status,
        detail: failed ? String(failure) : `${done} / ${unique.length}`,
        controllable: ["running", "paused"].includes(status),
        source: control?.source ?? getDownloadSource(),
        download,
      });
    };
    control =
      (context?.planId ? plans.get(context.planId)?.control : undefined) ||
      new TaskControl(() => report("running", true));
    activeTasks.set(id, control);
    report("running", true);
    const worker = async () => {
      while (next < unique.length && !failed) {
        const index = next++;
        const item = unique[index];
        try {
          await this.transfer(
            item,
            (bytes, total, phase = "downloading") => {
              tracker.phase = phase;
              tracker.update(index, {
                status: "downloading",
                receivedBytes: Math.min(bytes, item.size ?? bytes),
                ...(total > 0 || item.size === 0 ? { totalBytes: total } : {}),
              });
              report("running");
            },
            control,
          );
          const file = tracker.files[index];
          tracker.update(index, {
            status: "completed",
            totalBytes: file.totalBytes ?? file.receivedBytes,
          });
          done++;
          report("running");
        } catch (error) {
          tracker.update(index, {
            status:
              error instanceof DownloadCancelledError ? "cancelled" : "failed",
          });
          if (!failed) {
            failed = true;
            failure = error;
          }
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(this.concurrency, Math.max(1, unique.length)) },
        worker,
      ),
    );
    if (control.cancelled)
      for (let index = 0; index < tracker.files.length; index++)
        if (tracker.files[index].status === "queued")
          tracker.update(index, { status: "cancelled" });
    report(failed ? "failed" : "completed", true);
    activeTasks.delete(id);
    finishDownloadFiles(id);
    if (failed) throw failure;
  }
}
