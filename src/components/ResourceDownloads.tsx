import { useEffect, useState } from "react";
import {
  Box,
  Check,
  Cpu,
  Download,
  Layers3,
  LoaderCircle,
  Package,
  RefreshCw,
  Search,
  Sparkles,
  WandSparkles,
} from "lucide-react";
import type {
  Instance,
  LauncherAPI,
  OptifineVersion,
} from "../../shared/types";
import ContentBrowser, { type ContentKind } from "./ContentBrowser";
import { GlassSurface } from "../ui/Glass";
import "./resources.css";

export type ResourceKind = "minecraft" | ContentKind;
const tabs = [
  { id: "minecraft", name: "Minecraft", icon: Box },
  { id: "mod", name: "Mod 模组", icon: Package },
  { id: "modpack", name: "整合包", icon: Layers3 },
  { id: "resourcepack", name: "资源包", icon: Sparkles },
  { id: "shader", name: "光影包", icon: WandSparkles },
] as const;
type Props = {
  active?: boolean;
  kind: ResourceKind;
  setKind: (kind: ResourceKind) => void;
  instance?: Instance;
  instances?: Instance[];
  call: LauncherAPI["call"];
  notify: (message: string) => void;
  onInstalled: () => void;
  showTasks: () => void;
};
const message = (e: any) =>
  String(e.message || e).replace(
    /^Error invoking remote method '[^']+': Error: /,
    "",
  );
const loaderName = (value: string) =>
  value === "vanilla"
    ? "原版"
    : value === "optifine"
      ? "OptiFine"
      : value[0].toUpperCase() + value.slice(1);

export default function ResourceDownloads({
  active = true,
  kind,
  setKind,
  instance,
  instances = [],
  call,
  notify,
  onInstalled,
  showTasks,
}: Props) {
  const [opened, setOpened] = useState<ResourceKind[]>([kind]);
  useEffect(() => {
    setOpened((previous) =>
      previous.includes(kind) ? previous : [...previous, kind],
    );
  }, [kind]);
  return (
    <div className="resource-downloads">
      <div className="page-heading">
        <div className="resource-page-title">
          <span className="resource-heading-icon">
            <Download size={25} />
          </span>
          <div>
            <div className="eyebrow">EXPLORE YOUR NEXT WORLD</div>
            <h1>资源下载</h1>
            <p>Minecraft 与社区资源，一处获取。</p>
          </div>
        </div>
        <button className="btn subtle" onClick={showTasks}>
          <Download size={16} />
          下载任务
        </button>
      </div>
      <GlassSurface
        as="div"
        className="content-tabs resource-tabs"
        role="tablist"
        aria-label="资源类型"
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={kind === tab.id}
            className={`content-tab ${kind === tab.id ? "active" : ""}`}
            onClick={() => setKind(tab.id)}
          >
            <tab.icon size={17} />
            {tab.name}
          </button>
        ))}
      </GlassSurface>
      <div
        hidden={kind !== "minecraft"}
        role="tabpanel"
        aria-label="Minecraft 下载"
      >
        <GameDownload
          call={call}
          notify={notify}
          onInstalled={onInstalled}
          showTasks={showTasks}
        />
      </div>
      {tabs
        .filter(
          (tab) =>
            tab.id !== "minecraft" &&
            (opened.includes(tab.id) || tab.id === kind),
        )
        .map((tab) => (
          <div
            key={tab.id}
            hidden={kind !== tab.id}
            role="tabpanel"
            aria-label={tab.name}
          >
            <ContentBrowser
              initialKind={tab.id as ContentKind}
              active={active && kind === tab.id}
              embedded
              instance={instance}
              instances={instances}
              call={call}
              notify={notify}
              onInstalled={onInstalled}
            />
          </div>
        ))}
    </div>
  );
}

function GameDownload({
  call,
  notify,
  onInstalled,
  showTasks,
}: Pick<Props, "call" | "notify" | "onInstalled" | "showTasks">) {
  const [versions, setVersions] = useState<any[]>([]);
  const [version, setVersion] = useState("");
  const [name, setName] = useState("");
  const [loader, setLoader] = useState("vanilla");
  const [snapshots, setSnapshots] = useState(false);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [optifine, setOptifine] = useState<OptifineVersion[]>([]);
  const [optifineVersion, setOptifineVersion] = useState("");
  const [optifineFor, setOptifineFor] = useState("");
  const [optifineLoading, setOptifineLoading] = useState(false);
  const [optifineError, setOptifineError] = useState("");
  const [optifineRetry, setOptifineRetry] = useState(0);
  const load = async () => {
    setError("");
    setLoading(true);
    try {
      const data = await call<any[]>("versions");
      setVersions(data);
      setVersion(
        (old) =>
          old ||
          data.find((v) => v.type === "release")?.id ||
          data[0]?.id ||
          "",
      );
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    let current = true;
    if (loader !== "optifine" || !version) return;
    setOptifineLoading(true);
    setOptifineError("");
    setOptifine([]);
    setOptifineVersion("");
    setOptifineFor("");
    call<OptifineVersion[]>("optifine:versions", { version })
      .then((data) => {
        if (!current) return;
        setOptifine(data);
        setOptifineVersion(data[0]?.id || "");
        setOptifineFor(version);
      })
      .catch((error) => {
        if (current) setOptifineError(message(error));
      })
      .finally(() => {
        if (current) setOptifineLoading(false);
      });
    return () => {
      current = false;
    };
  }, [loader, version, optifineRetry]);
  const optifineReady =
    loader !== "optifine" ||
    (!optifineLoading &&
      optifineFor === version &&
      optifine.some((release) => release.id === optifineVersion));
  const filtered = versions.filter(
    (v) =>
      (snapshots || v.type === "release") &&
      v.id.toLowerCase().includes(search.toLowerCase()),
  );
  const install = async () => {
    if (!version || busy || !optifineReady) return;
    setBusy(true);
    setError("");
    try {
      await call("install", {
        version,
        loader,
        loaderVersion: loader === "optifine" ? optifineVersion : undefined,
        name:
          name.trim() ||
          `${version}${loader === "vanilla" ? "" : ` · ${loaderName(loader)}`}`,
      });
      onInstalled();
      notify("游戏实例已安装，可前往开始游戏启动");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="game-download-layout">
      <GlassSurface className="game-version-panel">
        <div className="section-title">
          <h3>
            <span className="resource-step">01</span>
            选择游戏版本 <span>{filtered.length}</span>
          </h3>
          <button
            className="icon-button"
            aria-label="刷新版本列表"
            disabled={loading}
            onClick={() => void load()}
          >
            <RefreshCw size={16} className={loading ? "spin" : ""} />
          </button>
        </div>
        <div className="version-filter">
          <div className="search-field">
            <Search size={16} />
            <input
              aria-label="搜索游戏版本"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索版本，如 1.21.1"
            />
          </div>
          <label className="check-label">
            <input
              type="checkbox"
              checked={snapshots}
              onChange={(e) => setSnapshots(e.target.checked)}
            />
            快照与旧版
          </label>
        </div>
        <div className="version-list" aria-label="游戏版本列表">
          {filtered.slice(0, 300).map((v) => (
            <button
              key={v.id}
              disabled={busy}
              className={version === v.id ? "selected" : ""}
              aria-pressed={version === v.id}
              onClick={() => setVersion(v.id)}
            >
              <Box size={17} />
              <b>{v.id}</b>
              <span>
                {v.type === "release"
                  ? "正式版"
                  : v.type === "snapshot"
                    ? "快照"
                    : "历史版本"}
              </span>
              {version === v.id && <Check size={16} />}
            </button>
          ))}
          {!versions.length && loading && (
            <div className="loading">
              <LoaderCircle className="spin" size={19} />
              正在获取官方版本列表…
            </div>
          )}
          {!loading && !filtered.length && (
            <div className="loading">
              {error ? "版本列表获取失败，请重试" : "没有匹配的版本"}
            </div>
          )}
        </div>
        <p className="download-source">
          版本元数据与游戏文件来自 Mojang / Microsoft。
        </p>
      </GlassSurface>
      <GlassSurface className="game-config-panel">
        <h3>
          <span className="resource-step">02</span>安装到独立实例
        </h3>
        <p className="muted">存档、Mod 与设置分别保存。</p>
        <div className="field">
          <label htmlFor="instance-name">实例名称</label>
          <input
            id="instance-name"
            disabled={busy}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={`${version || "我的 Minecraft"}${loader === "vanilla" ? "" : ` · ${loaderName(loader)}`}`}
          />
        </div>
        <div className="field">
          <label htmlFor="instance-loader">模组加载器</label>
          <select
            id="instance-loader"
            value={loader}
            disabled={busy}
            onChange={(e) => setLoader(e.target.value)}
          >
            {["vanilla", "fabric", "quilt", "forge", "optifine"].map((l) => (
              <option key={l} value={l}>
                {loaderName(l)}
              </option>
            ))}
          </select>
        </div>
        {loader === "optifine" && (
          <div className="field optifine-install-options">
            <label htmlFor="instance-optifine">OptiFine 发行版本</label>
            <select
              id="instance-optifine"
              value={optifineVersion}
              disabled={
                busy ||
                optifineLoading ||
                optifineFor !== version ||
                !optifine.length
              }
              onChange={(event) => setOptifineVersion(event.target.value)}
            >
              {!optifine.length && (
                <option value="">
                  {optifineLoading ? "正在查询可用发行版…" : "暂无可用发行版"}
                </option>
              )}
              {optifine.map((release) => (
                <option value={release.id} key={release.id}>
                  {release.id}
                  {release.preview ? " · 预览版" : " · 正式版"}
                </option>
              ))}
            </select>
            {optifineError ? (
              <div role="alert" className="error-box">
                {optifineError}
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => setOptifineRetry((value) => value + 1)}
                >
                  重试 OptiFine 版本
                </button>
              </div>
            ) : !optifineLoading &&
              optifineFor === version &&
              !optifine.length ? (
              <p className="muted" role="status">
                此 Minecraft 版本暂无 OptiFine，可选择其他游戏版本或
                <button
                  className="text-button"
                  onClick={() => setLoader("vanilla")}
                >
                  使用原版
                </button>
                。
              </p>
            ) : null}
            <p className="muted optifine-description">
              独立安装 OptiFine，不与 Fabric、Quilt 或 Forge
              组合。切换游戏版本后会重新查询。
            </p>
            <p className="download-source">
              OptiFine 由 sp614x 开发，版本与安装器来自 BMCLAPI 镜像。
            </p>
          </div>
        )}
        <div className="install-selection">
          <Box size={23} />
          <div>
            <strong>{version || "选择一个版本"}</strong>
            <small>{loaderName(loader)} · 版本隔离</small>
          </div>
        </div>
        <div className="notice">
          <Cpu size={18} />
          <span>自动匹配 Java，补齐游戏运行库和资源。</span>
        </div>
        <button
          className="btn primary full"
          disabled={!version || busy || !optifineReady}
          onClick={() => void install()}
        >
          {busy ? (
            <LoaderCircle className="spin" size={17} />
          ) : (
            <Download size={17} />
          )}
          {busy ? "正在安装…" : `下载并安装 ${version}`}
        </button>
        {busy && (
          <button className="text-button full" onClick={showTasks}>
            查看下载进度
          </button>
        )}
      </GlassSurface>
      {error && (
        <div role="alert" className="error-box game-download-error">
          {error}
        </div>
      )}
    </div>
  );
}
