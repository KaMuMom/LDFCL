import { memo, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Download,
  LoaderCircle,
  Pause,
  Play,
  X,
} from "lucide-react";
import type {
  DownloadFilePage,
  DownloadPlanStage,
  LauncherAPI,
  Task,
} from "../../shared/types";
import { taskProgressPercent } from "../../shared/task-progress";
import { GlassSurface } from "../ui/Glass";
import "./DownloadTasks.css";

type Props = {
  tasks: Task[];
  call: LauncherAPI["call"];
  notify: (message: string) => void;
  source?: "official" | "bmclapi";
};
const statusName: Record<string, string> = {
  completed: "已完成",
  error: "失败",
  failed: "失败",
  running: "进行中",
  downloading: "下载中",
  paused: "已暂停",
  cancelled: "已取消",
  queued: "等待下载",
};
const message = (error: unknown) =>
  String((error as Error)?.message || error).replace(
    /^Error invoking remote method '[^']+': Error: /,
    "",
  );
const active = (task: Task) =>
  ["running", "downloading", "paused"].includes(task.status);
export function downloadBytes(bytes?: number): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return "大小未知";
  const amount = Math.max(0, bytes);
  if (amount < 1024) return `${Math.round(amount)} B`;
  if (amount < 1048576) return `${(amount / 1024).toFixed(1)} KiB`;
  if (amount < 1073741824) return `${(amount / 1048576).toFixed(1)} MiB`;
  return `${(amount / 1073741824).toFixed(2)} GiB`;
}
export function downloadProgressLabel(task: Task): string {
  const d = task.download;
  if (!d) return `任务进度 ${taskProgressPercent(task)}%`;
  if (d.kind === "plan") {
    const stages = d.stages || [];
    return `阶段 ${stages.filter((stage) => stage.status === "completed").length}/${stages.length}${d.totalFiles !== undefined ? ` · 已知文件 ${d.completedFiles || 0}/${d.totalFiles}` : ""}`;
  }
  const files = `文件 ${d.completedFiles || 0}/${d.totalFiles ?? "待解析"}`;
  if (d.totalBytes !== undefined)
    return `${files} · ${downloadBytes(d.receivedBytes || 0)} / ${downloadBytes(d.totalBytes)}${d.totalBytes > 0 ? ` · 字节进度 ${task.status === "completed" ? 100 : Math.min(99, Math.floor(((d.receivedBytes || 0) / d.totalBytes) * 100))}%` : ""}`;
  return `${files} · 已接收 ${downloadBytes(d.receivedBytes || 0)} · 总大小未知`;
}
function progressValue(task: Task): number | undefined {
  const d = task.download;
  if (!d) return taskProgressPercent(task);
  if (d.kind === "plan") return undefined;
  if (task.status === "completed") return 100;
  if (d.totalBytes)
    return Math.min(
      99,
      Math.max(0, Math.floor(((d.receivedBytes || 0) / d.totalBytes) * 100)),
    );
  if ((d.totalFiles || 0) > 1)
    return Math.min(
      99,
      Math.floor(((d.completedFiles || 0) / d.totalFiles!) * 100),
    );
  return undefined;
}
export function DownloadTaskSummary({ task }: { task: Task }) {
  const d = task.download;
  return (
    <span className="download-task-summary">
      {d?.resourceName || task.title}
      {d?.targetInstanceName ? ` → ${d.targetInstanceName}` : ""} ·{" "}
      {downloadProgressLabel(task)}
    </span>
  );
}
function FileList({
  taskId,
  call,
  running,
  total: expectedTotal,
}: {
  taskId: string;
  call: LauncherAPI["call"];
  running: boolean;
  total?: number;
}) {
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<DownloadFilePage>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    let pending = false;
    const read = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await call<DownloadFilePage>("download:files", {
          id: taskId,
          offset,
          limit: 50,
        });
        if (live) {
          setPage(result);
          setError("");
        }
      } catch (error) {
        if (live) setError(message(error));
      } finally {
        pending = false;
      }
    };
    setPage(undefined);
    void read();
    const interval = running
      ? window.setInterval(() => void read(), 1000)
      : undefined;
    return () => {
      live = false;
      window.clearInterval(interval);
    };
  }, [taskId, offset, call, running, retry]);
  const total = page?.total ?? expectedTotal ?? 0;
  return (
    <div className="download-file-list">
      {error ? (
        <p role="alert" className="download-file-error">
          {error}{" "}
          <button
            className="btn subtle"
            onClick={() => setRetry((old) => old + 1)}
          >
            重试
          </button>
        </p>
      ) : !page ? (
        <p className="muted">读取文件清单…</p>
      ) : (
        <>
          <ul aria-label="预期下载文件">
            {page.files.map((file) => (
              <li key={file.id}>
                <span title={file.name}>{file.name}</span>
                <span>{statusName[file.status] || file.status}</span>
                <small>
                  {downloadBytes(file.receivedBytes)} /{" "}
                  {downloadBytes(file.totalBytes)}
                </small>
              </li>
            ))}
          </ul>
          {!page.files.length && <p className="muted">此阶段无需下载文件。</p>}
        </>
      )}
      {total > 50 && (
        <div className="download-file-pages">
          <span>
            第 {Math.floor(offset / 50) + 1} / {Math.ceil(total / 50)} 页 · 共{" "}
            {total} 个文件
          </span>
          <button
            className="btn subtle"
            disabled={!offset}
            onClick={() => setOffset((old) => Math.max(0, old - 50))}
          >
            上一页
          </button>
          <button
            className="btn subtle"
            disabled={offset + 50 >= total}
            onClick={() => setOffset((old) => old + 50)}
          >
            下一页
          </button>
        </div>
      )}
    </div>
  );
}
function TaskControls({
  task,
  call,
  notify,
  source,
}: Omit<Props, "tasks"> & { task: Task }) {
  const [working, setWorking] = useState(false);
  if (!task.controllable) return null;
  const run = async (method: string, payload: unknown) => {
    setWorking(true);
    try {
      await call(method, payload);
    } catch (error) {
      notify(message(error));
    } finally {
      setWorking(false);
    }
  };
  return (
    <div className="download-task-controls">
      <select
        aria-label={`${task.title} 下载源`}
        value={task.source || source || "official"}
        disabled={working}
        onChange={(event) =>
          void run("download:source", {
            id: task.id,
            source: event.target.value,
          })
        }
      >
        <option value="official">官方源</option>
        <option value="bmclapi">BMCLAPI</option>
      </select>
      <button
        className="btn subtle"
        disabled={working}
        onClick={() =>
          void run("download:control", {
            id: task.id,
            action: task.status === "paused" ? "resume" : "pause",
          })
        }
      >
        {task.status === "paused" ? <Play size={14} /> : <Pause size={14} />}
        {task.status === "paused" ? "继续" : "暂停"}
      </button>
      <button
        className="btn subtle"
        disabled={working}
        onClick={() =>
          void run("download:control", { id: task.id, action: "cancel" })
        }
      >
        <X size={14} />
        取消
      </button>
    </div>
  );
}
function TaskMeter({ task }: { task: Task }) {
  const percent = progressValue(task);
  return (
    <div className="download-task-meter">
      <div
        className={`progress ${percent === undefined && active(task) ? "download-indeterminate" : ""}`}
        role="progressbar"
        aria-label={downloadProgressLabel(task)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <i style={{ width: `${percent ?? (active(task) ? 30 : 0)}%` }} />
      </div>
      <small>
        {downloadProgressLabel(task)}
        {task.download?.phase === "verifying" && active(task)
          ? " · 校验文件中"
          : ""}
      </small>
    </div>
  );
}
function ActiveFiles({ task }: { task: Task }) {
  const files = task.download?.activeFiles || [];
  if (!files.length || !active(task)) return null;
  return (
    <div className="download-active-files">
      <span>{task.status === "paused" ? "已暂停文件" : "当前文件"}</span>
      {files.slice(0, 3).map((file, index) => (
        <small key={`${file.id}-${index}`} title={file.name}>
          {file.name} · {downloadBytes(file.receivedBytes)}
          {file.totalBytes !== undefined
            ? ` / ${downloadBytes(file.totalBytes)}`
            : " · 大小未知"}
        </small>
      ))}
      {files.length > 3 && <small>另有 {files.length - 3} 个并发文件</small>}
    </div>
  );
}
function FilesTask({
  task,
  call,
  notify,
  source,
  nested = false,
}: Omit<Props, "tasks"> & { task: Task; nested?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={`download-file-task ${nested ? "nested" : ""}`}>
      <div className="download-file-task-heading">
        <strong>{task.download?.resourceName || task.title}</strong>
        <span className={`download-status ${task.status}`}>
          {statusName[task.status] || task.status}
        </span>
      </div>
      {task.download?.targetInstanceName && (
        <p className="download-target">
          目标实例：{task.download.targetInstanceName}
        </p>
      )}
      {task.detail &&
        ["failed", "error", "cancelled"].includes(task.status) && (
          <p className="download-file-error">{task.detail}</p>
        )}
      <TaskMeter task={task} />
      <ActiveFiles task={task} />
      <div className="download-file-task-footer">
        {task.download?.kind === "files" &&
          task.download.totalFiles !== undefined && (
            <button
              className="btn subtle download-expand"
              aria-expanded={expanded}
              onClick={() => setExpanded((old) => !old)}
            >
              <ChevronDown size={14} />
              {expanded
                ? "收起文件清单"
                : `查看全部 ${task.download.totalFiles} 个文件`}
            </button>
          )}
        {!nested && (
          <TaskControls
            task={task}
            call={call}
            notify={notify}
            source={source}
          />
        )}
      </div>
      {expanded && (
        <FileList
          taskId={task.id}
          call={call}
          running={active(task)}
          total={task.download?.totalFiles}
        />
      )}
    </div>
  );
}
function Stage({
  stage,
  children,
  call,
  running,
}: {
  stage: DownloadPlanStage;
  children: React.ReactNode;
  call: LauncherAPI["call"];
  running: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const status = {
    pending: stage.totalFiles === undefined ? "待解析" : "等待下载",
    resolving: stage.totalFiles === undefined ? "解析中" : "准备下载",
    running: "进行中",
    completed: "已完成",
    error: "失败",
    cancelled: "已取消",
  }[stage.status];
  const hasFiles = !!stage.fileListId || !!children;
  return (
    <div className={`download-stage ${stage.status}`}>
      <button
        className="download-stage-heading"
        disabled={!hasFiles}
        aria-expanded={hasFiles ? expanded : undefined}
        onClick={() => setExpanded((old) => !old)}
      >
        <span className="download-stage-dot">
          {stage.status === "completed" ? (
            <Check size={12} />
          ) : ["running", "resolving"].includes(stage.status) ? (
            <LoaderCircle size={12} className={running ? "spin" : ""} />
          ) : null}
        </span>
        <strong>{stage.title}</strong>
        <span>
          {status}
          {stage.totalFiles !== undefined
            ? ` · ${stage.completedFiles || 0}/${stage.totalFiles} 个文件`
            : ""}
        </span>
        {hasFiles && <ChevronDown size={14} />}
      </button>
      {expanded && (
        <div className="download-stage-content">
          {stage.fileListId ? (
            <FileList
              taskId={stage.fileListId}
              call={call}
              running={running && stage.status !== "completed"}
              total={stage.totalFiles}
            />
          ) : (
            children
          )}
        </div>
      )}
    </div>
  );
}
function DownloadTasks({ tasks, call, notify, source }: Props) {
  const { roots, stageChildren } = useMemo(() => {
    const planIds = new Set(
      tasks
        .filter((task) => task.download?.kind === "plan")
        .map((task) => task.id),
    );
    const roots = tasks.filter(
      (task) => !task.download?.planId || !planIds.has(task.download.planId),
    );
    const stageChildren = new Map<string, Task[]>();
    for (const task of tasks) {
      if (!task.download?.planId) continue;
      const key = `${task.download.planId}\0${task.download.stageId}`;
      const group = stageChildren.get(key) || [];
      group.push(task);
      stageChildren.set(key, group);
    }
    return { roots, stageChildren };
  }, [tasks]);
  if (!roots.length)
    return (
      <GlassSurface className="download-tasks-empty">
        <Download size={28} />
        <h3>暂无下载任务</h3>
        <p>安装游戏或下载内容后，可在这里查看完整阶段和文件清单。</p>
      </GlassSurface>
    );
  return (
    <div className="download-tasks">
      {[...roots].reverse().map((task) => (
        <GlassSurface
          key={task.id}
          className={`download-task-card ${task.status}`}
        >
          {task.download?.kind === "plan" ? (
            <>
              <div className="download-plan-heading">
                <span className="quick-icon mint">
                  {task.status === "completed" ? (
                    <Check size={20} />
                  ) : ["error", "failed"].includes(task.status) ? (
                    <AlertTriangle size={20} />
                  ) : (
                    <Download size={20} />
                  )}
                </span>
                <div>
                  <h3>{task.title}</h3>
                  <p>
                    {task.download.resourceName || "正在解析资源"}
                    {task.download.targetInstanceName
                      ? ` · 目标实例：${task.download.targetInstanceName}`
                      : ""}
                  </p>
                </div>
                <span className={`download-status ${task.status}`}>
                  {statusName[task.status] || task.status}
                </span>
              </div>
              <TaskMeter task={task} />
              <ActiveFiles task={task} />
              {task.detail && (
                <p className="download-file-error">{task.detail}</p>
              )}
              <div className="download-plan-stages">
                {task.download.stages?.map((stage) => {
                  const children =
                    stageChildren.get(`${task.id}\0${stage.id}`) || [];
                  return (
                    <Stage
                      key={stage.id}
                      stage={stage}
                      call={call}
                      running={active(task)}
                    >
                      {children.length
                        ? children.map((child) => (
                            <FilesTask
                              key={child.id}
                              task={child}
                              call={call}
                              notify={notify}
                              source={source}
                              nested
                            />
                          ))
                        : null}
                    </Stage>
                  );
                })}
              </div>
              {active(task) &&
                task.download.stages?.some(
                  (stage) =>
                    stage.id === "loader" &&
                    ["resolving", "running"].includes(stage.status),
                ) && (
                  <p className="muted">
                    官方安装器运行期间，取消将在安全检查点生效。
                  </p>
                )}
              <TaskControls
                task={task}
                call={call}
                notify={notify}
                source={source}
              />
            </>
          ) : (
            <FilesTask
              task={task}
              call={call}
              notify={notify}
              source={source}
            />
          )}
        </GlassSurface>
      ))}
    </div>
  );
}

export default memo(DownloadTasks);
