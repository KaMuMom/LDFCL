import { useEffect, useRef, useState } from "react";
import { Download, Layers3, RefreshCw, X } from "lucide-react";
import type { ModpackVersion } from "../../shared/types";
import { GlassBackdrop } from "../ui/Glass";
import "./resources.css";

type Props = {
  project: { project_id: string; title: string; displayName?: string };
  call: (method: string, payload?: any) => Promise<any>;
  onClose: () => void;
  onInstall: (versionId: string) => Promise<boolean>;
};
const loaderNames: Record<string, string> = {
  fabric: "Fabric",
  quilt: "Quilt",
  forge: "Forge",
  neoforge: "NeoForge",
  minecraft: "原版",
  vanilla: "原版",
};
const loaderName = (loader: string) => loaderNames[loader] || loader;
const releaseName = { release: "正式版", beta: "测试版", alpha: "预览版" };
const supported = (version: ModpackVersion) =>
  !version.loaders.length ||
  version.loaders.some((loader) =>
    ["fabric", "quilt", "forge", "neoforge", "minecraft", "vanilla"].includes(
      loader,
    ),
  );
const fileSize = (bytes: number) =>
  bytes >= 1048576
    ? `${(bytes / 1048576).toFixed(1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
const date = (value: string) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "日期未知"
    : parsed.toLocaleDateString("zh-CN");
};

export default function ModpackVersionPicker({
  project,
  call,
  onClose,
  onInstall,
}: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [versions, setVersions] = useState<ModpackVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [minecraft, setMinecraft] = useState("");
  const [loader, setLoader] = useState("");
  const [selection, setSelection] = useState("");
  const [busy, setBusy] = useState(false);
  const [installError, setInstallError] = useState("");
  const installing = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const element = dialog.current!;
    const trigger = document.activeElement;
    element.showModal();
    return () => {
      mounted.current = false;
      element.close();
      queueMicrotask(() => {
        if (
          trigger instanceof HTMLElement &&
          trigger.isConnected &&
          trigger.getClientRects().length &&
          !trigger.closest("[hidden]")
        )
          trigger.focus({ preventScroll: true });
      });
    };
  }, []);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError("");
    setSelection("");
    call("pack:versions", { projectId: project.project_id })
      .then((result: ModpackVersion[]) => {
        if (current) setVersions(result);
      })
      .catch((e: any) => {
        if (current) {
          setVersions([]);
          setError(
            String(e.message || "无法获取整合包版本").replace(
              /^Error invoking remote method '[^']+': Error: /,
              "",
            ),
          );
        }
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [project.project_id, retry]);
  const filtered = versions.filter(
    (v) =>
      (!minecraft || v.gameVersions.includes(minecraft)) &&
      (!loader || v.loaders.includes(loader)),
  );
  const selected = filtered.find((v) => v.id === selection);
  const gameVersions = [
    ...new Set(versions.flatMap((v) => v.gameVersions)),
  ].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const loaders = [...new Set(versions.flatMap((v) => v.loaders))].sort();
  const install = async () => {
    if (!selected || !supported(selected) || installing.current) return;
    installing.current = true;
    setBusy(true);
    setInstallError("");
    try {
      if (await onInstall(selected.id)) {
        if (mounted.current) onClose();
      }
    } catch (e: any) {
      if (mounted.current)
        setInstallError(
          String(e.message || "安装失败").replace(
            /^Error invoking remote method '[^']+': Error: /,
            "",
          ),
        );
    } finally {
      installing.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="glass-surface pack-version-dialog"
      aria-label="选择整合包版本"
      aria-describedby="pack-version-description"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <GlassBackdrop radius={28} />
      <header className="pack-version-heading">
        <span className="resource-dialog-icon">
          <Layers3 size={24} />
        </span>
        <div>
          <h2>选择整合包版本</h2>
          <p id="pack-version-description">
            {project.displayName || project.title} · 安装为独立实例
          </p>
        </div>
        <button
          className="icon-btn"
          aria-label="关闭版本选择"
          onClick={onClose}
        >
          <X size={19} />
        </button>
      </header>
      <div className="pack-version-filters">
        <label>
          Minecraft 版本
          <select
            value={minecraft}
            disabled={loading || busy}
            onChange={(e) => {
              setMinecraft(e.target.value);
              setSelection("");
            }}
          >
            <option value="">全部版本</option>
            {gameVersions.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          模组加载器
          <select
            value={loader}
            disabled={loading || busy}
            onChange={(e) => {
              setLoader(e.target.value);
              setSelection("");
            }}
          >
            <option value="">全部加载器</option>
            {loaders.map((v) => (
              <option key={v} value={v}>
                {loaderName(v)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="pack-version-count" aria-live="polite">
        {loading
          ? "正在获取发行版本…"
          : `${filtered.length} 个可选发行版本 · 从新到旧`}
      </div>
      <div
        className="pack-version-list"
        role="radiogroup"
        aria-label="整合包发行版本"
        aria-busy={loading}
      >
        {loading ? (
          <div className="pack-version-empty">
            <span className="spinner" /> 正在加载版本列表…
          </div>
        ) : error ? (
          <div className="pack-version-empty" role="alert">
            <p>{error}</p>
            <button className="btn" onClick={() => setRetry((n) => n + 1)}>
              <RefreshCw size={15} /> 重试
            </button>
          </div>
        ) : !filtered.length ? (
          <div className="pack-version-empty">
            <Layers3 size={28} />
            <p>
              {versions.length
                ? "没有匹配的版本，请调整筛选条件"
                : "此整合包暂无可下载的发行版本"}
            </p>
            {versions.length ? (
              <button
                className="btn subtle"
                onClick={() => {
                  setMinecraft("");
                  setLoader("");
                  setSelection("");
                }}
              >
                清除筛选
              </button>
            ) : (
              <button
                className="btn subtle"
                onClick={() => setRetry((n) => n + 1)}
              >
                <RefreshCw size={15} /> 刷新版本
              </button>
            )}
          </div>
        ) : (
          filtered.map((version) => (
            <label
              key={version.id}
              className={`pack-version-row ${selection === version.id ? "selected" : ""} ${supported(version) ? "" : "unsupported"}`}
            >
              <input
                type="radio"
                name="pack-version"
                value={version.id}
                checked={selection === version.id}
                disabled={busy || !supported(version)}
                onChange={() => setSelection(version.id)}
              />
              <div className="pack-version-info">
                <strong>{version.name || version.versionNumber}</strong>
                <span className="pack-version-number">
                  {version.versionNumber}{" "}
                  <span className={`badge pack-release-${version.versionType}`}>
                    {releaseName[version.versionType]}
                  </span>
                </span>
                <span className="pack-version-platform">
                  Minecraft {version.gameVersions.join(" / ") || "未指定"} ·{" "}
                  {version.loaders.map(loaderName).join(" / ") || "原版"}
                </span>
                {!supported(version) && (
                  <span className="pack-version-unsupported">
                    暂不支持此加载器，请选择其他版本
                  </span>
                )}
              </div>
              <span className="pack-version-date">
                {date(version.publishedAt)}
                <small>{fileSize(version.downloadSize)} · 整合包文件</small>
              </span>
            </label>
          ))
        )}
      </div>
      {installError && (
        <div className="pack-version-install-error" role="alert">
          {installError}
        </div>
      )}
      <footer className="pack-version-footer">
        <div>
          <strong>
            {selected ? `已选 ${selected.versionNumber}` : "请选择一个发行版本"}
          </strong>
          <small>
            {busy
              ? "关闭此窗口后继续安装，可在下载任务中查看进度。"
              : "游戏文件和依赖将按此版本自动下载。"}
          </small>
        </div>
        <button
          className="btn primary"
          disabled={!selected || loading || busy || !supported(selected)}
          onClick={() => void install()}
        >
          {busy ? <span className="spinner small" /> : <Download size={16} />}
          {busy ? "正在安装…" : "安装所选版本"}
        </button>
      </footer>
    </dialog>
  );
}
