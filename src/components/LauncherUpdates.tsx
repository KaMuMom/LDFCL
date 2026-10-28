import { useEffect, useState } from "react";
import {
  ArrowDownToLine,
  CheckCircle2,
  ExternalLink,
  RefreshCw,
  RotateCw,
} from "lucide-react";
import type { LauncherAPI } from "../../shared/types";
import type { LauncherUpdateState } from "../../shared/updates";
import { GlassSurface } from "../ui/Glass";
import "./launcher-updates.css";

function bytes(value = 0) {
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
export function useLauncherUpdates(api?: LauncherAPI) {
  const [state, setState] = useState<LauncherUpdateState>();
  useEffect(() => {
    if (!api) return;
    let active = true;
    void api
      .call<LauncherUpdateState>("update:state")
      .then((value) => {
        if (active) setState(value);
      })
      .catch(() => {});
    const unsubscribe = api.onEvent((event) => {
      if (event.type === "launcher-update" && active) setState(event.state);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api]);
  return state;
}

export default function LauncherUpdates({
  state,
  call,
  notify,
  compact = false,
}: {
  state?: LauncherUpdateState;
  call: LauncherAPI["call"];
  notify: (message: string) => void;
  compact?: boolean;
}) {
  if (
    !state ||
    (compact &&
      !["available", "downloading", "ready", "installing"].includes(
        state.status,
      ))
  )
    return null;
  const busy = ["checking", "downloading", "installing"].includes(state.status);
  const action = async (method: string) => {
    try {
      const result = await call<LauncherUpdateState | boolean>(method);
      if (typeof result !== "boolean" && result.status === "error")
        notify(result.message || "暂时无法完成更新，请稍后重试。");
    } catch (error) {
      notify(
        String(error instanceof Error ? error.message : error).replace(
          /^Error invoking remote method '[^']+': Error: /,
          "",
        ),
      );
    }
  };
  const label =
    state.status === "current"
      ? "已是最新正式版"
      : state.status === "checking"
        ? "正在检查更新…"
        : state.status === "available"
          ? `发现新版本 ${state.latestVersion}`
          : state.status === "downloading"
            ? `正在下载 ${state.latestVersion}`
            : state.status === "ready"
              ? `${state.latestVersion} 已准备就绪`
              : state.status === "installing"
                ? "正在应用更新…"
                : state.status === "error"
                  ? "暂时无法完成更新"
                  : "启动器更新";
  const content = (
    <>
      <div className="launcher-update-copy" aria-live="polite">
        <strong>{label}</strong>
        {!compact && (
          <p>当前版本 {state.currentVersion} · 启动时自动检查 GitHub Latest</p>
        )}
        {state.message && <p>{state.message}</p>}
        {state.status === "downloading" && (
          <>
            <progress
              aria-label="启动器更新下载进度"
              value={state.receivedBytes || 0}
              max={state.totalBytes || 1}
            />
            <p>
              {bytes(state.receivedBytes)} / {bytes(state.totalBytes)}
            </p>
          </>
        )}
        {!state.supported && !compact && (
          <p>当前运行环境请从发行页下载新版便携程序。</p>
        )}
      </div>
      <div className="launcher-update-actions">
        {state.status === "ready" && (
          <button
            className="btn primary"
            onClick={() => void action("update:install")}
          >
            <RotateCw size={16} />
            重启更新
          </button>
        )}
        {compact && !state.supported && (
          <button
            className="btn primary"
            onClick={() => void action("update:open")}
          >
            <ExternalLink size={16} />
            前往下载
          </button>
        )}
        {["available", "error"].includes(state.status) &&
          state.hasUpdate &&
          state.supported && (
            <button
              className="btn primary"
              onClick={() => void action("update:download")}
            >
              <ArrowDownToLine size={16} />
              下载更新
            </button>
          )}
        {!compact && (
          <button
            className="btn subtle"
            disabled={busy || state.status === "ready"}
            onClick={() => void action("update:check")}
          >
            <RefreshCw
              size={16}
              className={state.status === "checking" ? "spin" : ""}
            />
            检查更新
          </button>
        )}
        {!compact && (
          <button
            className="btn subtle"
            onClick={() => void action("update:open")}
          >
            <ExternalLink size={16} />
            发行页面
          </button>
        )}
        {state.status === "current" && (
          <CheckCircle2 size={18} aria-hidden="true" />
        )}
      </div>
    </>
  );
  return compact ? (
    <GlassSurface className="launcher-update-banner" role="status">
      {content}
    </GlassSurface>
  ) : (
    <GlassSurface className="settings-panel full-span launcher-update-panel">
      {content}
    </GlassSurface>
  );
}
