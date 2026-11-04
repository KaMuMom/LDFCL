import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDownToLine,
  CheckCircle2,
  ExternalLink,
  RefreshCw,
  RotateCw,
  X,
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
    let eventRevision = 0;
    const unsubscribe = api.onEvent((event) => {
      if (event.type === "launcher-update" && active) {
        eventRevision++;
        setState(event.state);
      }
    });
    void api
      .call<LauncherUpdateState>("update:state")
      .then((value) => {
        // A newer event may arrive while the initial IPC snapshot is in flight.
        if (active && eventRevision === 0) setState(value);
      })
      .catch(() => {});
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
  suppressPopup = false,
}: {
  state?: LauncherUpdateState;
  call: LauncherAPI["call"];
  notify: (message: string) => void;
  compact?: boolean;
  suppressPopup?: boolean;
}) {
  const titleId = useId();
  const [dismissedKey, setDismissedKey] = useState("");
  const attempt = state?.lastAttempt;
  const failedAttempt = attempt && attempt.status !== "installed";
  const popupKey = state
    ? `${state.latestVersion || state.currentVersion}:${state.status}:${attempt?.id || ""}`
    : "";
  if (
    !state ||
    (compact &&
      (suppressPopup ||
        dismissedKey === popupKey ||
        !(
          ["available", "downloading", "ready", "installing"].includes(
            state.status,
          ) ||
          (state.status === "error" && (state.hasUpdate || failedAttempt))
        )))
  )
    return null;
  const busy = ["checking", "downloading", "installing"].includes(state.status);
  const action = async (method: string) => {
    if (compact) setDismissedKey("");
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
                  ? attempt?.status === "rolled-back"
                    ? "更新未完成，已恢复原版本"
                    : failedAttempt
                      ? "上次更新未完成"
                      : "暂时无法完成更新"
                  : "启动器更新";
  const attemptDetails = attempt && (
    <div className="launcher-update-attempt" data-outcome={attempt.status}>
      <strong>
        {attempt.status === "installed"
          ? "上次更新已完成"
          : attempt.status === "rolled-back"
            ? "上次更新已回退"
            : "上次更新未完成"}
      </strong>
      <p>
        版本 {attempt.version}
        {Number.isFinite(Date.parse(attempt.completedAt))
          ? ` · ${new Date(attempt.completedAt).toLocaleString("zh-CN")}`
          : ""}
      </p>
      <p>{attempt.message}</p>
      {attempt.logPath && (
        <p>
          诊断日志：<code>{attempt.logPath}</code>
        </p>
      )}
    </div>
  );
  const detailMessage =
    state.message !== attempt?.message ? state.message : undefined;
  if (compact) {
    const dismiss = () => setDismissedKey(popupKey);
    return createPortal(
      <div className="launcher-update-popup-region">
        <GlassSurface
          className="launcher-update-popup"
          role="region"
          aria-labelledby={titleId}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              dismiss();
            }
          }}
        >
          <header className="launcher-update-popup-heading">
            <div>
              <span className="launcher-update-eyebrow">启动器更新</span>
              <strong
                id={titleId}
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                {label}
              </strong>
            </div>
            <button
              className="icon-button"
              aria-label="关闭更新提示"
              title="稍后可在启动器设置中继续查看"
              onClick={dismiss}
            >
              <X size={17} />
            </button>
          </header>
          <div className="launcher-update-popup-body">
            <p className="launcher-update-version">
              当前版本 {state.currentVersion}
            </p>
            {detailMessage && (
              <p className="launcher-update-message">{detailMessage}</p>
            )}
            {attemptDetails}
            {!state.supported && (
              <p>当前运行环境请从发行页下载新版便携程序。</p>
            )}
          </div>
          <footer className="launcher-update-popup-footer">
            {state.status === "downloading" && (
              <div className="launcher-update-progress">
                <progress
                  aria-label="启动器更新下载进度"
                  {...(state.totalBytes
                    ? {
                        value: state.receivedBytes || 0,
                        max: state.totalBytes,
                      }
                    : {})}
                />
                <span>
                  {bytes(state.receivedBytes)} /{" "}
                  {state.totalBytes ? bytes(state.totalBytes) : "等待总大小"}
                </span>
              </div>
            )}
            <div className="launcher-update-popup-bottom">
              <p>稍后可在启动器设置中继续查看。</p>
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
                {!state.supported ? (
                  <button
                    className="btn primary"
                    onClick={() => void action("update:open")}
                  >
                    <ExternalLink size={16} />
                    前往下载
                  </button>
                ) : (
                  <>
                    <button
                      className="btn subtle"
                      onClick={() => void action("update:open")}
                    >
                      <ExternalLink size={16} />
                      发行页面
                    </button>
                    {["available", "error"].includes(state.status) &&
                      state.hasUpdate && (
                        <button
                          className="btn primary"
                          onClick={() => void action("update:download")}
                        >
                          <ArrowDownToLine size={16} />
                          {state.status === "error" ? "重试下载" : "下载更新"}
                        </button>
                      )}
                    {state.status === "error" && !state.hasUpdate && (
                      <button
                        className="btn primary"
                        onClick={() => void action("update:check")}
                      >
                        <RefreshCw size={16} />
                        重新检查
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          </footer>
        </GlassSurface>
      </div>,
      document.body,
    );
  }
  const content = (
    <>
      <div className="launcher-update-copy" aria-live="polite">
        <strong>{label}</strong>
        <p>当前版本 {state.currentVersion} · 启动时自动检查 GitHub Latest</p>
        {detailMessage && <p>{detailMessage}</p>}
        {attemptDetails}
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
        {!state.supported && <p>当前运行环境请从发行页下载新版便携程序。</p>}
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
        <button
          className="btn subtle"
          onClick={() => void action("update:open")}
        >
          <ExternalLink size={16} />
          发行页面
        </button>
        {state.status === "current" && (
          <CheckCircle2 size={18} aria-hidden="true" />
        )}
      </div>
    </>
  );
  return (
    <GlassSurface className="settings-panel full-span launcher-update-panel">
      {content}
    </GlassSurface>
  );
}
