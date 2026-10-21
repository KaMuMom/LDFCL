import { useEffect, useRef, useState } from "react";
import { Download, Package, RefreshCw, X } from "lucide-react";
import type { Instance } from "../../shared/types";
import { GlassBackdrop } from "../ui/Glass";
import "./resources.css";
import "./ModInstallPicker.css";

type Props = {
  project: { project_id: string; title: string; displayName?: string };
  instances: Instance[];
  initialInstanceId?: string;
  call: (method: string, payload?: any) => Promise<any>;
  onClose: () => void;
  onInstall: (target: Instance, versionId?: string) => Promise<boolean>;
};
const message = (error: any) =>
  String(error?.message || "无法获取兼容版本").replace(
    /^Error invoking remote method '[^']+': Error: /,
    "",
  );
export default function ModInstallPicker({
  project,
  instances,
  initialInstanceId,
  call,
  onClose,
  onInstall,
}: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(false);
  const installing = useRef(false);
  const request = useRef(0);
  const [targetId, setTargetId] = useState(
    () => initialInstanceId || instances[0]?.id || "",
  );
  const [versions, setVersions] = useState<any[]>([]);
  const [versionId, setVersionId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const target = instances.find((item) => item.id === targetId);
  const supported =
    !!target && ["fabric", "quilt", "forge"].includes(target.loader);
  useEffect(() => {
    alive.current = true;
    const element = dialog.current!;
    const trigger = document.activeElement;
    element.showModal();
    return () => {
      alive.current = false;
      request.current++;
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
    const id = ++request.current;
    setVersionId("");
    setVersions([]);
    setError("");
    if (!supported || !target) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const snapshot = {
      id: target.id,
      version: target.version,
      loader: target.loader,
    };
    call("content:versions", {
      projectId: project.project_id,
      instanceId: snapshot.id,
    })
      .then((value) => {
        if (request.current !== id || !alive.current) return;
        const compatible = (Array.isArray(value) ? value : []).filter(
          (version) =>
            version?.project_id === project.project_id &&
            typeof version.id === "string" &&
            version.game_versions?.includes(snapshot.version) &&
            version.loaders?.includes(snapshot.loader) &&
            version.files?.some(
              (file: any) =>
                typeof file.filename === "string" &&
                /\.jar$/i.test(file.filename),
            ),
        );
        compatible.sort(
          (a, b) =>
            (Date.parse(b.date_published) || 0) -
            (Date.parse(a.date_published) || 0),
        );
        setVersions(compatible);
      })
      .catch((error) => {
        if (request.current === id && alive.current) setError(message(error));
      })
      .finally(() => {
        if (request.current === id && alive.current) setLoading(false);
      });
    return () => {
      request.current++;
    };
  }, [project.project_id, target?.id, target?.version, target?.loader, retry]);
  const install = async () => {
    if (
      !target ||
      !supported ||
      loading ||
      !versions.length ||
      error ||
      installing.current
    )
      return;
    const snapshot = { ...target };
    const selection = versionId || versions[0].id;
    if (!versions.some((version) => version.id === selection)) return;
    installing.current = true;
    setBusy(true);
    setError("");
    try {
      if (await onInstall(snapshot, selection)) {
        if (alive.current) onClose();
      }
    } catch (error) {
      if (alive.current) setError(message(error));
    } finally {
      installing.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="glass-surface mod-install-dialog"
      aria-label="选择模组安装位置"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <GlassBackdrop radius={28} />
      <header className="mod-install-heading">
        <span className="resource-dialog-icon">
          <Package size={24} />
        </span>
        <div>
          <h2>选择模组安装位置</h2>
          <p>{project.displayName || project.title}</p>
        </div>
        <button
          className="icon-btn"
          aria-label="关闭模组安装选择"
          onClick={onClose}
        >
          <X size={19} />
        </button>
      </header>
      <div className="mod-install-body">
        <label>
          目标游戏版本
          <select
            aria-label="目标游戏版本"
            disabled={busy || !instances.length}
            value={targetId}
            onChange={(event) => {
              request.current++;
              setTargetId(event.target.value);
              setVersions([]);
              setVersionId("");
              setError("");
              setLoading(true);
            }}
          >
            {!instances.length && <option value="">暂无游戏实例</option>}
            {instances.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · Minecraft {item.version} · {item.loader}
                {item.loaderVersion ? ` ${item.loaderVersion}` : ""}
              </option>
            ))}
          </select>
        </label>
        <p className="muted">模组只写入所选游戏版本的 mods 文件夹。</p>
        <label>
          模组发行版本
          <select
            aria-label="模组发行版本"
            disabled={busy || loading || !versions.length}
            value={versionId}
            onChange={(event) => setVersionId(event.target.value)}
          >
            <option value="">
              {loading
                ? "正在获取兼容版本…"
                : versions.length
                  ? "推荐：最新兼容发行版"
                  : "暂无兼容版本"}
            </option>
            {versions.map((version) => (
              <option key={version.id} value={version.id}>
                {version.version_number || version.name || version.id} ·{" "}
                {version.version_type === "beta"
                  ? "测试版"
                  : version.version_type === "alpha"
                    ? "预览版"
                    : "正式版"}
                {version.date_published
                  ? ` · ${version.date_published.slice(0, 10)}`
                  : ""}
              </option>
            ))}
          </select>
        </label>
        {!target ? (
          <div className="notice">
            请先创建一个 Fabric、Quilt 或 Forge 游戏实例。
          </div>
        ) : !supported ? (
          <div className="notice">
            此目标未安装支持模组的加载器。请选择已安装 Fabric、Quilt 或 Forge
            的游戏版本。
          </div>
        ) : !loading && !versions.length && !error ? (
          <div className="notice">
            <Package size={18} /> 此模组暂无匹配 Minecraft {target.version} /{" "}
            {target.loader} 的发行版本，请选择其他目标。
          </div>
        ) : null}
        <div className="notice mod-dependency-notice">
          <Package size={18} />
          <span>
            自动递归补齐必需前置模组，并校验游戏版本与加载器；可选前置不会安装。
          </span>
        </div>
        {error && (
          <div className="notice danger" role="alert">
            {error}
            <button
              className="btn subtle"
              disabled={busy}
              onClick={() => setRetry((value) => value + 1)}
            >
              <RefreshCw size={14} />
              重试
            </button>
          </div>
        )}
      </div>
      <footer className="mod-install-footer">
        <span className="muted" aria-live="polite">
          {loading
            ? "正在检查目标兼容性…"
            : busy
              ? "正在安装模组与必需前置…"
              : `${versions.length} 个兼容发行版本`}
        </span>
        <button
          className="btn primary"
          disabled={
            busy || loading || !supported || !versions.length || !!error
          }
          onClick={() => void install()}
        >
          {busy ? <span className="spinner small" /> : <Download size={16} />}
          {busy ? "安装中" : "确认安装到此版本"}
        </button>
      </footer>
    </dialog>
  );
}
