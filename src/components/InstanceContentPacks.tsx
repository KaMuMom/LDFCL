import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  FolderOpen,
  LoaderCircle,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import type { Instance, LauncherAPI } from "../../shared/types";
import "./instance-content-packs.css";

type Kind = "resourcepack" | "shader";
type Pack = { name: string; size: number; enabled: boolean; order: number };
type Listing = { packs: Pack[]; renderer?: string; shaderAvailable: boolean };
type Props = {
  instance: Instance;
  kind: Kind;
  call: LauncherAPI["call"];
  notify: (message: string) => void;
};

export default function InstanceContentPacks({
  instance,
  kind,
  call,
  notify,
}: Props) {
  const [listing, setListing] = useState<Listing>({
    packs: [],
    shaderAvailable: false,
  });
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const request = useRef(0),
    identity = useRef("");
  identity.current = `${instance.id}:${kind}`;
  useEffect(() => {
    const id = ++request.current;
    setLoading(true);
    setError("");
    setListing({ packs: [], shaderAvailable: false });
    call<Listing>("content-packs:list", { instanceId: instance.id, kind })
      .then((value) => {
        if (id === request.current) setListing(value);
      })
      .catch((reason) => {
        if (id === request.current) setError(reason.message || "读取内容失败");
      })
      .finally(() => {
        if (id === request.current) setLoading(false);
      });
    return () => {
      request.current++;
    };
  }, [instance.id, kind, refresh]);
  const title = kind === "resourcepack" ? "资源包" : "光影包";
  async function action(method: string, payload: Record<string, unknown> = {}) {
    const target = identity.current;
    setBusy(true);
    setError("");
    try {
      await call(method, { instanceId: instance.id, kind, ...payload });
      if (target === identity.current) setRefresh((value) => value + 1);
    } catch (reason: any) {
      if (target === identity.current) {
        setError(reason.message || "操作失败");
        notify(reason.message || "操作失败");
      }
    } finally {
      if (target === identity.current) setBusy(false);
    }
  }
  function move(pack: Pack, direction: number) {
    const selected = listing.packs
      .filter((item) => item.enabled)
      .map((item) => item.name);
    const index = selected.indexOf(pack.name),
      target = index + direction;
    if (target < 0 || target >= selected.length) return;
    [selected[index], selected[target]] = [selected[target], selected[index]];
    void action("content-packs:reorder", { names: selected });
  }
  return (
    <div className="instance-content-packs">
      <div className="pack-manager-toolbar">
        <div>
          <strong>{title}管理</strong>
          <small>
            {instance.name} · 独立目录
            {listing.renderer ? ` · ${listing.renderer}` : ""}
          </small>
        </div>
        <button
          className="btn small"
          disabled={loading || busy}
          onClick={() => setRefresh((value) => value + 1)}
          aria-label={`刷新${title}`}
        >
          <RefreshCw size={15} />
        </button>
        <button
          className="btn small"
          disabled={busy}
          onClick={() => void action("content-packs:import")}
        >
          <Upload size={15} />
          导入
        </button>
        <button
          className="btn small"
          onClick={() => {
            void call("folder", {
              id: instance.id,
              sub: kind === "shader" ? "shaderpacks" : "resourcepacks",
            }).catch((reason) => notify(reason.message));
          }}
        >
          <FolderOpen size={15} />
          文件夹
        </button>
      </div>
      <p className="muted">
        {kind === "resourcepack"
          ? "在启动前启用、禁用及调整资源包顺序；列表后方的包具有更高覆盖优先级。"
          : "启用一个光影包会替换当前选择，设置将在下次启动时生效。"}
      </p>
      {kind === "shader" && !loading && !listing.shaderAvailable && (
        <div className="notice">
          此实例尚未检测到 Iris、Oculus 或
          OptiFine。安装对应渲染模组后即可启用光影。
        </div>
      )}
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {loading ? (
        <div className="pack-manager-empty">
          <LoaderCircle className="spin" size={20} />
          正在读取{title}…
        </div>
      ) : !listing.packs.length ? (
        <div className="pack-manager-empty">
          还没有{title}，可导入 ZIP 或从资源下载页面安装。
        </div>
      ) : (
        <div className="pack-manager-list">
          {listing.packs.map((pack) => {
            const enabled = listing.packs.filter((item) => item.enabled);
            const index = enabled.findIndex((item) => item.name === pack.name);
            return (
              <div className="pack-manager-row" key={pack.name}>
                <label className="pack-manager-choice">
                  <input
                    type="checkbox"
                    checked={pack.enabled}
                    disabled={
                      busy || (kind === "shader" && !listing.shaderAvailable)
                    }
                    onChange={(event) =>
                      void action("content-packs:toggle", {
                        name: pack.name,
                        enabled: event.target.checked,
                      })
                    }
                  />
                  <span>
                    <strong>{pack.name}</strong>
                    <small>
                      {(pack.size / 1048576).toFixed(1)} MB ·{" "}
                      {pack.enabled ? "已启用" : "未启用"}
                    </small>
                  </span>
                </label>
                {kind === "resourcepack" && pack.enabled && (
                  <>
                    <button
                      className="icon-btn"
                      aria-label={`上移 ${pack.name}`}
                      disabled={busy || index === 0}
                      onClick={() => move(pack, -1)}
                    >
                      <ArrowUp size={15} />
                    </button>
                    <button
                      className="icon-btn"
                      aria-label={`下移 ${pack.name}`}
                      disabled={busy || index === enabled.length - 1}
                      onClick={() => move(pack, 1)}
                    >
                      <ArrowDown size={15} />
                    </button>
                  </>
                )}
                <button
                  className="icon-btn danger"
                  disabled={busy}
                  aria-label={`删除 ${pack.name}`}
                  onClick={() => {
                    if (
                      window.confirm(
                        `删除 ${pack.name}？该文件将从此实例移除。`,
                      )
                    )
                      void action("content-packs:remove", { name: pack.name });
                  }}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
