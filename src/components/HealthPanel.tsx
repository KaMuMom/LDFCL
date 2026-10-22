import { useEffect, useState } from "react";
import { Activity, RefreshCw, Wrench } from "lucide-react";
import type { LauncherAPI } from "../../shared/types";
import type { HealthReport } from "../../shared/health";
import "./improvements.css";

export default function HealthPanel({
  instanceId,
  call,
  notify,
  compact = false,
}: {
  instanceId: string;
  call: LauncherAPI["call"];
  notify: (message: string) => void;
  compact?: boolean;
}) {
  const [report, setReport] = useState<HealthReport>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    setReport(undefined);
    void call<HealthReport | null>("health:latest", { id: instanceId })
      .then((value) => {
        if (active && value) setReport(value);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [instanceId, call]);
  useEffect(
    () =>
      window.launcher?.onEvent((event) => {
        if (event.type === "health" && event.report?.instanceId === instanceId)
          setReport(event.report);
      }),
    [instanceId],
  );
  const scan = async (fix = false) => {
    setBusy(true);
    try {
      const result = await call(fix ? "health:fix" : "health:scan", {
        id: instanceId,
        auto: fix,
      });
      setReport(fix ? result.report : result);
      if (fix)
        notify(
          `自动修复完成 · ${result.changes.filter((entry: any) => entry.status === "fixed").length} 项，变更日志已保存`,
        );
    } catch (error: any) {
      notify(String(error.message || error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className={`health-panel ${compact ? "compact" : ""}`}
      aria-label="实例健康检查"
    >
      <div className="improvement-heading">
        <strong>
          <Activity size={16} />{" "}
          {report
            ? `健康 ${report.score}/100 · ${{ healthy: "正常", warning: "有提示", error: "需要处理" }[report.status]}`
            : "启动前健康检查"}
        </strong>
        <div className="button-group">
          <button
            className="btn subtle"
            disabled={busy}
            onClick={() => void scan()}
          >
            <RefreshCw size={14} />
            {busy ? "检查中…" : "扫描"}
          </button>
          {!compact && (
            <button
              className="btn subtle"
              disabled={busy || !report?.issues.some((issue) => issue.autoFix)}
              onClick={() => void scan(true)}
            >
              <Wrench size={14} />
              自动修复
            </button>
          )}
        </div>
      </div>
      {!compact &&
        (report ? (
          <>
            <p className="muted">
              Java {report.requiredJava} · 内存 {report.memoryMb} MB ·{" "}
              {new Date(report.scannedAt).toLocaleString("zh-CN")}
            </p>
            <div className="health-issues">
              {report.issues.map((issue) => (
                <article
                  className={`health-issue ${issue.severity}`}
                  key={issue.id}
                >
                  <strong>{issue.title}</strong>
                  <p>{issue.detail}</p>
                  <p className="muted">
                    {issue.suggestion}
                    {issue.autoFix ? " · 可自动修复" : ""}
                  </p>
                </article>
              ))}
              {!report.issues.length && <p>未发现上述检查范围内的问题。</p>}
            </div>
            <p className="muted">{report.limits.join(" ")}</p>
          </>
        ) : (
          <p className="muted">
            检查 Java、前置 Mod、内存和历史日志。启动时会自动扫描。
          </p>
        ))}
    </section>
  );
}
