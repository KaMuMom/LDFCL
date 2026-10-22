import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Copy,
  FileInput,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Terminal,
} from "lucide-react";
import type { Instance, LauncherAPI } from "../../shared/types";
import type { CrashDiagnosis } from "../../shared/diagnostics";
import { AI_DISABLED_MESSAGE } from "../../shared/ai";
import { GlassSurface } from "../ui/Glass";
import "./diagnostics.css";

interface Props {
  call: LauncherAPI["call"];
  instanceId?: string;
  instances?: Instance[];
  logs?: string[];
  refresh?: () => Promise<void>;
}
const categoryNames = {
  memory: "内存",
  java: "Java",
  dependency: "模组前置",
  "duplicate-mod": "重复模组",
  mixin: "Mixin 冲突",
  graphics: "图形与运行库",
  launch: "启动失败",
  unknown: "证据不足",
};
function message(error: unknown) {
  return String((error as Error)?.message || error).replace(
    /^Error invoking remote method '[^']+': Error: /,
    "",
  );
}

function localReport(report: CrashDiagnosis): CrashDiagnosis {
  const { ai: _historicalAI, ...local } = report;
  return local;
}

export default function Diagnostics({
  call,
  instanceId,
  instances = [],
  logs = [],
}: Props) {
  const [tab, setTab] = useState<"logs" | "diagnosis">("logs");
  const [selectedInstance, setSelectedInstance] = useState(instanceId || "");
  const [reports, setReports] = useState<CrashDiagnosis[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const current =
    reports.find((report) => report.id === selectedId) || reports[0];
  const recentLogs = logs.slice(-500);

  useEffect(() => {
    setSelectedInstance(instanceId || "");
  }, [instanceId]);
  const load = useCallback(async () => {
    const result = await call<CrashDiagnosis[]>(
      "diagnosis:list",
      selectedInstance ? { instanceId: selectedInstance } : {},
    );
    setReports(result.map(localReport));
    setSelectedId((previous) =>
      result.some((report) => report.id === previous)
        ? previous
        : result[0]?.id || "",
    );
  }, [call, selectedInstance]);
  useEffect(() => {
    let active = true;
    setError("");
    void call<CrashDiagnosis[]>(
      "diagnosis:list",
      selectedInstance ? { instanceId: selectedInstance } : {},
    )
      .then((result) => {
        if (!active) return;
        setReports(result.map(localReport));
        setSelectedId(result[0]?.id || "");
      })
      .catch((error) => {
        if (active) setError(message(error));
      });
    const unsubscribe = window.launcher?.onEvent((event) => {
      if (event.type === "diagnosis") void load().catch(() => {});
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [call, selectedInstance, load]);

  const action = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await work();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  };
  const copy = (text: string) =>
    action(async () => {
      await navigator.clipboard.writeText(text);
      setStatus("已复制到剪贴板");
    });

  return (
    <section className="diagnostics-page" aria-label="运行日志与诊断">
      <header className="page-heading">
        <div>
          <span className="eyebrow">RUN LOGS & DIAGNOSIS</span>
          <h1>运行日志与诊断</h1>
          <p>查看最近 500 行输出、本地崩溃规则与处理建议。</p>
        </div>
        <div className="button-group">
          <button
            className="btn subtle"
            disabled={busy}
            onClick={() => void action(load)}
          >
            <RefreshCw size={15} />
            刷新
          </button>
          <button
            className="btn subtle"
            disabled={busy || !selectedInstance}
            onClick={() =>
              void action(async () => {
                const report = await call<CrashDiagnosis | null>(
                  "diagnosis:import",
                  { instanceId: selectedInstance },
                );
                if (report) {
                  await load();
                  setSelectedId(report.id);
                  setTab("diagnosis");
                }
              })
            }
          >
            <FileInput size={15} />
            导入崩溃报告
          </button>
        </div>
      </header>
      <div className="diagnostic-toolbar">
        <div className="diagnostic-tabs" role="tablist" aria-label="日志视图">
          <button
            id="diagnostic-log-tab"
            role="tab"
            aria-controls="diagnostic-log-panel"
            aria-selected={tab === "logs"}
            onClick={() => setTab("logs")}
          >
            <Terminal size={16} />
            实时日志
          </button>
          <button
            id="diagnostic-report-tab"
            role="tab"
            aria-controls="diagnostic-report-panel"
            aria-selected={tab === "diagnosis"}
            onClick={() => setTab("diagnosis")}
          >
            <ShieldCheck size={16} />
            崩溃诊断{reports.length ? ` · ${reports.length}` : ""}
          </button>
        </div>
        <label>
          实例{" "}
          <select
            aria-label="诊断所属实例"
            value={selectedInstance}
            onChange={(event) => {
              setSelectedInstance(event.target.value);
            }}
          >
            <option value="">全部实例</option>
            {instances.map((instance) => (
              <option key={instance.id} value={instance.id}>
                {instance.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && (
        <p className="diagnostic-error" role="alert">
          <AlertTriangle size={16} />
          {error}
        </p>
      )}
      {status && (
        <p className="muted" role="status">
          {status}
        </p>
      )}
      {tab === "logs" && (
        <GlassSurface
          id="diagnostic-log-panel"
          role="tabpanel"
          aria-labelledby="diagnostic-log-tab"
          className="diagnostic-live-panel"
        >
          <div className="diagnostic-card-heading">
            <strong>最近游戏输出 · {recentLogs.length}/500 行</strong>
            <button
              className="btn subtle"
              onClick={() => void copy(recentLogs.join("\n"))}
              disabled={!recentLogs.length || busy}
            >
              <Copy size={14} />
              复制日志
            </button>
          </div>
          <p className="muted">
            此处显示本次打开启动器后的实时输出。崩溃报告按实例与运行单独保存；手动停止和正常退出不会生成崩溃诊断。
          </p>
          <pre
            className="diagnostic-console"
            tabIndex={0}
            aria-label="最近500行游戏日志"
          >
            {recentLogs.length
              ? recentLogs.join("\n")
              : "尚无游戏输出，启动游戏后在这里查看。"}
          </pre>
        </GlassSurface>
      )}
      {tab === "diagnosis" && (
        <div
          id="diagnostic-report-panel"
          role="tabpanel"
          aria-labelledby="diagnostic-report-tab"
          className="diagnostic-report-layout"
        >
          <GlassSurface className="diagnostic-history">
            <h3>本地报告</h3>
            {reports.length ? (
              reports.map((report) => (
                <button
                  key={report.id}
                  className={`diagnostic-history-item ${current?.id === report.id ? "selected" : ""}`}
                  aria-pressed={current?.id === report.id}
                  onClick={() => {
                    setSelectedId(report.id);
                  }}
                >
                  <strong>
                    {categoryNames[report.category] || report.category}
                  </strong>
                  <span>
                    {instances.find(
                      (instance) => instance.id === report.instanceId,
                    )?.name || report.instanceId}
                  </span>
                  <small>
                    {new Date(report.createdAt).toLocaleString("zh-CN")}
                  </small>
                </button>
              ))
            ) : (
              <p className="muted">
                没有崩溃报告。也可导入已有的 .txt 或 .log 文件进行本地诊断。
              </p>
            )}
          </GlassSurface>
          {current ? (
            <GlassSurface className="diagnostic-report">
              <div className="diagnostic-card-heading">
                <div>
                  <span className="eyebrow">
                    LOCAL RULES · {current.ruleVersion}
                  </span>
                  <h2>{current.summary}</h2>
                </div>
                <span className="diagnostic-confidence">
                  置信度 {Math.round(current.confidence * 100)}%
                </span>
              </div>
              <p className="muted">
                {categoryNames[current.category]} · 退出码{" "}
                {current.exitCode ?? "未知"} ·{" "}
                {current.terminationReason === "imported"
                  ? "导入报告"
                  : "本次运行"}
              </p>
              <div className="button-group">
                <button
                  className="btn subtle"
                  disabled
                  title={AI_DISABLED_MESSAGE}
                >
                  <Sparkles size={15} />
                  AI 增强建议
                </button>
                <button
                  className="btn subtle"
                  disabled={busy}
                  onClick={() => void copy(JSON.stringify(current, null, 2))}
                >
                  <Copy size={14} />
                  复制诊断
                </button>
              </div>
              <p className="muted">{AI_DISABLED_MESSAGE}</p>
              <h3>建议处理步骤</h3>
              <ol>
                {current.recommendations.map((recommendation, index) => (
                  <li key={index}>{recommendation}</li>
                ))}
              </ol>
              <h3>可疑模组</h3>
              {current.suspectedMods.length ? (
                current.suspectedMods.map((mod) => (
                  <article className="diagnostic-mod" key={mod.id}>
                    <strong>
                      {mod.name} · {Math.round(mod.confidence * 100)}%
                    </strong>
                    <p>{mod.reason}</p>
                  </article>
                ))
              ) : (
                <p className="muted">现有证据不足以归因到具体模组。</p>
              )}
              <h3>规则证据</h3>
              {current.evidence.length ? (
                current.evidence.map((evidence, index) => (
                  <details key={index}>
                    <summary>
                      {evidence.ruleId} · {evidence.source}:{evidence.line}
                    </summary>
                    <pre>{evidence.snippet}</pre>
                  </details>
                ))
              ) : (
                <p className="muted">
                  未命中已有规则，可结合原始错误类型进一步排查。
                </p>
              )}
              {current.warnings.map((warning, index) => (
                <p className="muted" key={index}>
                  {warning}
                </p>
              ))}
              <details>
                <summary>本次采集日志 · {current.logTail.length} 行</summary>
                <pre className="diagnostic-console" tabIndex={0}>
                  {current.logTail.join("\n")}
                </pre>
              </details>
            </GlassSurface>
          ) : (
            <GlassSurface className="diagnostic-report">
              <h2>本地诊断随时可用</h2>
              <p className="muted">
                游戏异常退出时会采集本次新增或更新的崩溃报告，排查内存、Java、模组前置、重复模组、Mixin
                和图形错误。
              </p>
            </GlassSurface>
          )}
        </div>
      )}
    </section>
  );
}
