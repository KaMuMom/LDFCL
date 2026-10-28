import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  Box,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  Import,
  Layers,
  LoaderCircle,
  Package,
  Play,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Wifi,
} from "lucide-react";
import type { Instance, LauncherAPI } from "../../shared/types";
import GameOptionsFields from "./GameOptionsFields";
import HealthPanel from "./HealthPanel";
import InstanceStorage from "./InstanceStorage";
import InstanceContentPacks from "./InstanceContentPacks";
import { GAME_PRESETS } from "../../shared/game-presets";
import { GlassSurface } from "../ui/Glass";
import "./instances.css";

type Props = {
  initialTab: string;
  instances: Instance[];
  instance?: Instance;
  gameRoot: string;
  gameDefaults?: Instance["gameSettings"];
  call: LauncherAPI["call"];
  notify: (message: string) => void;
  refresh: () => Promise<void>;
  select: (payload: any) => Promise<void>;
  install: () => void;
  launch: () => any;
  busy: string;
};
const loaderName = (loader: string) =>
  ({
    vanilla: "原版",
    fabric: "Fabric",
    quilt: "Quilt",
    forge: "Forge",
    neoforge: "NeoForge",
    optifine: "OptiFine",
  })[loader] || loader;
const errorMessage = (error: any) =>
  String(error?.message || error).replace(
    /^Error invoking remote method '[^']+': Error: /,
    "",
  );
const validTab = (tab: string) =>
  ["mods", "overview", "game", "advanced", "health", "packs"].includes(tab)
    ? tab
    : "mods";
const PAGE_SIZE = 50;

function Pagination({
  label,
  total,
  page,
  setPage,
  disabled = false,
}: {
  label: string;
  total: number;
  page: number;
  setPage: (page: number) => void;
  disabled?: boolean;
}) {
  const pages = Math.ceil(total / PAGE_SIZE);
  if (pages <= 1) return null;
  return (
    <nav className="instance-pagination" aria-label={`${label}分页`}>
      <span className="muted">
        共 {total} 个{label}
      </span>
      <div className="instance-pagination-controls">
        <button
          className="icon-button"
          aria-label={`${label}上一页`}
          disabled={disabled || page === 0}
          onClick={() => setPage(page - 1)}
        >
          <ChevronLeft size={16} />
        </button>
        <select
          aria-label={`${label}页码`}
          value={page}
          disabled={disabled}
          onChange={(event) => setPage(Number(event.target.value))}
        >
          {Array.from({ length: pages }, (_, index) => (
            <option key={index} value={index}>
              第 {index + 1} / {pages} 页
            </option>
          ))}
        </select>
        <button
          className="icon-button"
          aria-label={`${label}下一页`}
          disabled={disabled || page === pages - 1}
          onClick={() => setPage(page + 1)}
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </nav>
  );
}

function Empty({
  icon: Icon,
  title,
  text,
}: {
  icon: any;
  title: string;
  text: string;
}) {
  return (
    <div className="empty instance-empty">
      <div className="empty-icon">
        <Icon size={29} />
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}

export default function Instances({
  initialTab,
  instances,
  instance,
  gameRoot,
  gameDefaults,
  call,
  notify,
  refresh,
  select,
  install,
  launch,
  busy,
}: Props) {
  const [tab, setTab] = useState(() => validTab(initialTab));
  const [query, setQuery] = useState("");
  const [versionPage, setVersionPage] = useState(0);
  const versionList = useRef<HTMLDivElement>(null);
  const [selecting, setSelecting] = useState("");
  const [importing, setImporting] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setTab(validTab(initialTab));
  }, [initialTab]);
  const choose = async (version: Instance) => {
    if (selecting || version.id === instance?.id) return;
    setSelecting(version.id);
    setTab("mods");
    try {
      await select({ instanceId: version.id });
    } catch (error) {
      if (mounted.current) notify(errorMessage(error));
    } finally {
      if (mounted.current) setSelecting("");
    }
  };
  const importPack = async () => {
    setImporting(true);
    try {
      await call("pack:import");
      if (mounted.current) await refresh();
    } catch (error) {
      if (mounted.current) notify(errorMessage(error));
    } finally {
      if (mounted.current) setImporting(false);
    }
  };
  const search = query.trim().toLocaleLowerCase();
  const versionSearchIndex = useMemo(
    () =>
      instances.map((version) => ({
        version,
        search: [
          version.name,
          version.version,
          version.loader,
          loaderName(version.loader),
          version.loaderVersion || "",
        ]
          .join(" ")
          .toLocaleLowerCase(),
      })),
    [instances],
  );
  const filtered = useMemo(
    () =>
      versionSearchIndex
        .filter((entry) => entry.search.includes(search))
        .map((entry) => entry.version),
    [versionSearchIndex, search],
  );
  const selectedIndex = filtered.findIndex(
    (version) => version.id === instance?.id,
  );
  const currentVersionPage = Math.min(
    versionPage,
    Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1),
  );
  const visibleVersions = filtered.slice(
    currentVersionPage * PAGE_SIZE,
    (currentVersionPage + 1) * PAGE_SIZE,
  );
  useEffect(() => {
    setVersionPage(
      selectedIndex >= 0 ? Math.floor(selectedIndex / PAGE_SIZE) : 0,
    );
  }, [instance?.id, selectedIndex, gameRoot, search]);
  useEffect(() => {
    const list = versionList.current;
    if (!list) return;
    list.scrollTop = 0;
    const selected = list.querySelector<HTMLElement>("[aria-pressed='true']");
    if (selected) {
      const itemBox = selected.getBoundingClientRect();
      const listBox = list.getBoundingClientRect();
      if (itemBox.bottom > listBox.bottom)
        list.scrollTop = itemBox.bottom - listBox.bottom;
    }
  }, [currentVersionPage, instance?.id, search]);
  return (
    <div className="instances-page">
      <div className="page-heading instances-page-heading">
        <div>
          <div className="eyebrow">INSTANCE LIBRARY</div>
          <h1>游戏实例</h1>
          <p>存档、模组与游戏预设，随每个版本独立保存。</p>
        </div>
        <div className="button-group">
          <button
            className="btn subtle"
            disabled={importing}
            onClick={() => {
              setImporting(true);
              void call("instance:rebuild")
                .then(refresh)
                .catch((error) => notify(errorMessage(error)))
                .finally(() => setImporting(false));
            }}
          >
            <Import size={16} />
            从清单重建
          </button>
          <button
            className="btn subtle"
            disabled={importing}
            onClick={() => void importPack()}
          >
            {importing ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Import size={16} />
            )}
            导入整合包
          </button>
          <button className="btn primary" onClick={install}>
            <Plus size={17} />
            新建实例
          </button>
        </div>
      </div>
      <div className="instances-workspace">
        <GlassSurface
          as="aside"
          className="instances-sidebar"
          aria-label="游戏版本选择"
        >
          <div className="instance-list-heading">
            <h3>游戏版本</h3>
            <span className="badge">{instances.length}</span>
          </div>
          <label className="instance-search">
            <Search size={15} />
            <input
              type="search"
              aria-label="搜索游戏版本"
              placeholder="搜索游戏版本"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setVersionPage(0);
              }}
            />
          </label>
          <Pagination
            label="版本"
            total={filtered.length}
            page={currentVersionPage}
            setPage={setVersionPage}
            disabled={!!selecting}
          />
          <div className="instance-list" ref={versionList}>
            {visibleVersions.map((version) => (
              <button
                className={`version-choice ${instance?.id === version.id ? "selected" : ""}`}
                key={version.id}
                aria-label={`${version.name} ${version.version} ${loaderName(version.loader)}`}
                aria-pressed={instance?.id === version.id}
                disabled={!!selecting}
                onClick={() => void choose(version)}
              >
                <span
                  className={`instance-icon ${version.loader === "vanilla" ? "" : "modded"}`}
                >
                  <Box size={23} />
                </span>
                <span className="version-choice-text">
                  <strong>{version.name}</strong>
                  <span className="version-choice-meta">
                    {version.version} · {loaderName(version.loader)}
                  </span>
                </span>
                {selecting === version.id ? (
                  <LoaderCircle className="spin" size={15} />
                ) : instance?.id === version.id ? (
                  <CheckCircle2 size={15} />
                ) : null}
              </button>
            ))}
            {!filtered.length && (
              <p className="muted">
                {instances.length ? "没有匹配的游戏版本" : "还没有安装游戏版本"}
              </p>
            )}
          </div>
          <div className="instance-isolation-note">
            <ShieldCheck size={15} />
            <span>
              版本隔离始终开启。每个版本独立保存 Mod、存档与 options.txt。
            </span>
          </div>
        </GlassSurface>
        {instance ? (
          <InstanceManager
            key={instance.id}
            instance={instance}
            gameRoot={gameRoot}
            gameDefaults={gameDefaults}
            tab={tab}
            setTab={setTab}
            call={call}
            notify={notify}
            refresh={refresh}
            launch={launch}
            busy={busy}
          />
        ) : (
          <GlassSurface
            className="instance-details instance-manager"
            aria-label="实例管理"
          >
            <div className="detail-body">
              <Empty
                icon={Layers}
                title="第一个世界，等你创造"
                text="点击新建实例安装 Minecraft，或导入 .mrpack 整合包。"
              />
            </div>
          </GlassSurface>
        )}
      </div>
    </div>
  );
}

class InactiveInstanceError extends Error {}
function InstanceManager({
  instance,
  gameRoot,
  gameDefaults,
  tab,
  setTab,
  call: callApi,
  notify: notifyParent,
  refresh: refreshParent,
  launch,
  busy,
}: Pick<
  Props,
  | "gameRoot"
  | "gameDefaults"
  | "call"
  | "notify"
  | "refresh"
  | "launch"
  | "busy"
> & {
  instance: Instance;
  tab: string;
  setTab: (tab: string) => void;
}) {
  const [mods, setMods] = useState<any[]>([]);
  const [modQuery, setModQuery] = useState("");
  const [modPage, setModPage] = useState(0);
  const modList = useRef<HTMLDivElement>(null);
  const modSearchIndex = useMemo(
    () =>
      mods.map((mod) => ({
        mod,
        search: [
          mod.displayName,
          mod.nameZh,
          mod.originalName,
          mod.name,
          mod.id,
          mod.file,
          mod.filename,
        ]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase(),
      })),
    [mods],
  );
  const modSearch = modQuery.trim().toLocaleLowerCase();
  const filteredMods = useMemo(
    () =>
      modSearchIndex
        .filter((entry) => entry.search.includes(modSearch))
        .map((entry) => entry.mod),
    [modSearchIndex, modSearch],
  );
  const currentModPage = Math.min(
    modPage,
    Math.max(0, Math.ceil(filteredMods.length / PAGE_SIZE) - 1),
  );
  const visibleMods = filteredMods.slice(
    currentModPage * PAGE_SIZE,
    (currentModPage + 1) * PAGE_SIZE,
  );
  useEffect(() => {
    if (modList.current) modList.current.scrollTop = 0;
    setModPage(currentModPage);
  }, [currentModPage, modSearch]);
  const [duplicates, setDuplicates] = useState<any[]>([]);
  const [updates, setUpdates] = useState<any[]>([]);
  const [working, setWorking] = useState("");
  const [modsLoading, setModsLoading] = useState(tab === "mods");
  const [modsError, setModsError] = useState("");
  const [gameOptions, setGameOptions] = useState<Record<string, any>>(() => ({
    ...instance.gameSettings,
  }));
  const [editName, setEditName] = useState(instance.name);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const mounted = useRef(true);
  const lifecycle = useRef(0);
  const modsRequest = useRef(0);
  useEffect(() => {
    mounted.current = true;
    lifecycle.current++;
    return () => {
      mounted.current = false;
      lifecycle.current++;
      modsRequest.current++;
    };
  }, []);
  const call: LauncherAPI["call"] = async (method, payload) => {
    const generation = lifecycle.current;
    if (!mounted.current) throw new InactiveInstanceError();
    const result = await callApi(method, payload);
    if (!mounted.current || generation !== lifecycle.current)
      throw new InactiveInstanceError();
    return result;
  };
  const notify = (message: string) => {
    if (mounted.current) notifyParent(message);
  };
  const refresh = async () => {
    if (!mounted.current) throw new InactiveInstanceError();
    await refreshParent();
    if (!mounted.current) throw new InactiveInstanceError();
  };
  const run = async (label: string, fn: () => Promise<any>) => {
    const generation = lifecycle.current;
    if (!mounted.current) return;
    setWorking(label);
    try {
      await fn();
    } catch (error) {
      if (
        mounted.current &&
        generation === lifecycle.current &&
        !(error instanceof InactiveInstanceError)
      )
        notify(errorMessage(error));
    } finally {
      if (mounted.current && generation === lifecycle.current) setWorking("");
    }
  };
  const loadMods = async () => {
    const request = ++modsRequest.current;
    setModsLoading(true);
    setModsError("");
    try {
      const result = await call("mods:list", { id: instance.id });
      if (mounted.current && request === modsRequest.current)
        setMods(Array.isArray(result) ? result : []);
    } catch (error) {
      if (
        mounted.current &&
        request === modsRequest.current &&
        !(error instanceof InactiveInstanceError)
      )
        setModsError(errorMessage(error));
      throw error;
    } finally {
      if (mounted.current && request === modsRequest.current)
        setModsLoading(false);
    }
  };
  useEffect(() => {
    if (tab === "mods") void run("list", loadMods);
  }, [tab]);
  const option = (key: string, value: any) =>
    setGameOptions((old) => ({ ...old, [key]: value }));
  const separator = gameRoot.includes("\\") ? "\\" : "/";
  const versionDirectory =
    instance.versionDirectory || instance.importedVersionId || instance.id;
  const instancePath = gameRoot
    ? `${gameRoot.replace(/[\\/]+$/, "")}${separator}versions${separator}${versionDirectory}`
    : `versions/${versionDirectory}`;
  return (
    <GlassSurface
      className="instance-details instance-manager"
      aria-label="实例管理"
      data-instance-id={instance.id}
    >
      <header className="detail-heading">
        <div className="instance-detail-summary">
          <span className="instance-detail-emblem">
            <Box size={27} />
          </span>
          <div className="instance-detail-copy">
            <span className="instance-detail-caption">当前工作区</span>
            <h2>{instance.name}</h2>
            <p className="instance-detail-platform">
              <span className="badge">{loaderName(instance.loader)}</span>
              <span>Minecraft {instance.version}</span>
              <span className="instance-isolation-status">
                <ShieldCheck size={12} /> 版本隔离已开启
              </span>
            </p>
            <p className="instance-path" title={instancePath}>
              {instancePath}
            </p>
          </div>
        </div>
        <div className="button-group">
          <button
            className="btn subtle"
            onClick={() =>
              void run("folder", () => call("folder", { id: instance.id }))
            }
          >
            <FolderOpen size={16} />
            打开目录
          </button>
          <button
            className="btn primary"
            onClick={() => void launch()}
            disabled={busy === "launch"}
          >
            <Play size={16} />
            启动游戏
          </button>
        </div>
      </header>
      <div className="tabs instance-tabs">
        {[
          ["mods", "Mod 管理"],
          ["overview", "实例概览"],
          ["game", "游戏预设"],
          ["advanced", "实例设置"],
          ["health", "健康与快照"],
          ["packs", "资源与光影"],
        ].map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? "selected" : ""}
            aria-pressed={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "overview" && (
        <div className="detail-body instance-overview">
          <div className="info-grid">
            <div>
              <label>游戏版本</label>
              <strong>{instance.version}</strong>
            </div>
            <div>
              <label>模组加载器</label>
              <strong>
                {loaderName(instance.loader)} {instance.loaderVersion || ""}
              </strong>
            </div>
            <div>
              <label>创建时间</label>
              <strong>
                {new Date(instance.createdAt).toLocaleDateString("zh-CN")}
              </strong>
            </div>
            <div>
              <label>上次游玩</label>
              <strong>
                {instance.lastPlayed
                  ? new Date(instance.lastPlayed).toLocaleString("zh-CN")
                  : "还未启程"}
              </strong>
            </div>
          </div>
          <div className="folder-grid">
            {[
              ["mods", "Mod 文件夹", Package],
              ["resourcepacks", "资源包", Box],
              ["shaderpacks", "光影包", Wifi],
              ["saves", "游戏存档", Layers],
            ].map(([sub, label, Icon]: any) => (
              <button
                className="folder-card"
                key={sub}
                onClick={() =>
                  void run("folder", () =>
                    call("folder", { id: instance.id, sub }),
                  )
                }
              >
                <Icon size={23} />
                <span>{label}</span>
                <ArrowUpRight size={15} />
              </button>
            ))}
          </div>
          <div className="notice">
            <ShieldCheck size={18} />
            该实例的存档、Mod、资源包、光影及 options.txt 与其他版本完全隔离。
          </div>
        </div>
      )}
      {tab === "health" && (
        <div className="detail-body">
          <HealthPanel instanceId={instance.id} call={call} notify={notify} />
          <InstanceStorage
            instanceId={instance.id}
            call={call}
            refresh={refresh}
            notify={notify}
          />
        </div>
      )}
      {tab === "packs" && (
        <div className="detail-body">
          <InstanceContentPacks
            instance={instance}
            kind="resourcepack"
            call={call}
            notify={notify}
          />
          <hr />
          <InstanceContentPacks
            instance={instance}
            kind="shader"
            call={call}
            notify={notify}
          />
        </div>
      )}
      {tab === "mods" && (
        <div className="detail-body instance-mods">
          <div className="mod-toolbar">
            <span className="muted">{mods.length} 个 Mod</span>
            <div className="button-group">
              <button
                className="btn subtle"
                disabled={!!working}
                onClick={() =>
                  void run("import", async () => {
                    await call("mods:import", { id: instance.id });
                    await loadMods();
                  })
                }
              >
                <Plus size={15} />
                导入 Mod
              </button>
              <button
                className="btn subtle"
                disabled={!!working}
                onClick={() =>
                  void run("scan", async () => {
                    const r = await call<any>("mods:duplicates", {
                      id: instance.id,
                    });
                    const groups = Array.isArray(r)
                      ? r
                      : r.groups || r.duplicateGroups || [];
                    setDuplicates(groups);
                    notify(
                      groups.length
                        ? `发现 ${groups.length} 组重复 Mod`
                        : "未发现重复 Mod",
                    );
                  })
                }
              >
                <Search size={15} />
                重复检测
              </button>
              <button
                className="btn subtle"
                disabled={!!working}
                onClick={() =>
                  void run("update", async () => {
                    const r = await call<any>("mods:updates", {
                      id: instance.id,
                    });
                    const u = Array.isArray(r) ? r : r.updates || [];
                    setUpdates(u);
                    notify(
                      u.length
                        ? `发现 ${u.length} 个可用更新`
                        : "所有已识别 Mod 均为兼容版本中的最新版本",
                    );
                  })
                }
              >
                <RefreshCw
                  size={15}
                  className={working === "update" ? "spin" : ""}
                />
                检查更新
              </button>
            </div>
          </div>
          <label className="instance-search mod-search">
            <Search size={15} />
            <input
              type="search"
              aria-label="搜索已安装 Mod"
              placeholder="搜索 Mod 名称、中文名或文件名"
              value={modQuery}
              onChange={(event) => {
                setModQuery(event.target.value);
                setModPage(0);
              }}
            />
          </label>
          {modSearch && !modsLoading && !modsError && mods.length > 0 && (
            <p className="muted mod-search-summary" role="status">
              找到 {filteredMods.length} 个 Mod，共 {mods.length} 个
            </p>
          )}
          {!modsLoading && !modsError && (
            <Pagination
              label="Mod"
              total={filteredMods.length}
              page={currentModPage}
              setPage={setModPage}
              disabled={!!working}
            />
          )}
          {duplicates.length > 0 && (
            <div className="warning-box">
              <AlertTriangle size={17} />
              <div>
                <strong>发现 {duplicates.length} 组重复项</strong>
                <p>
                  {duplicates
                    .map((d: any) => d.id || d.modId || d.key || d.reason)
                    .join("、")}
                  。请核对下方 Mod，禁用或移除多余版本。
                </p>
              </div>
            </div>
          )}
          {updates.length > 0 && (
            <div className="notice">
              <RefreshCw size={17} />
              <span>{updates.length} 个 Mod 可以更新，将保留旧文件备份。</span>
              <button
                className="btn primary"
                disabled={!!working}
                onClick={() =>
                  void run("apply", async () => {
                    await call("mods:apply", {
                      id: instance.id,
                      updates,
                    });
                    setUpdates([]);
                    await loadMods();
                    notify("Mod 更新完成，旧文件已备份");
                  })
                }
              >
                全部更新
              </button>
            </div>
          )}
          {working && working !== "list" && (
            <p className="muted">
              <LoaderCircle className="spin inline-icon" size={15} />
              正在处理…
            </p>
          )}
          {modsLoading ? (
            <div className="empty" role="status">
              <LoaderCircle className="spin" size={24} />
              <p>正在读取此版本的 Mod…</p>
            </div>
          ) : modsError ? (
            <div className="error-box" role="alert">
              <p>{modsError}</p>
              <button
                className="btn subtle"
                onClick={() => void run("list", loadMods)}
              >
                <RefreshCw size={15} />
                重新读取
              </button>
            </div>
          ) : !mods.length ? (
            <Empty
              icon={Package}
              title="还没有添加 Mod"
              text="导入本地 .jar 文件，或前往资源下载查找兼容内容。"
            />
          ) : !filteredMods.length ? (
            <Empty
              icon={Search}
              title="没有匹配的 Mod"
              text="试试其他名称、中文名或 .jar 文件名。"
            />
          ) : (
            <div className="mod-list" ref={modList}>
              {visibleMods.map((m: any) => (
                <div
                  key={m.file || m.filename}
                  className={`mod-row ${m.enabled === false ? "disabled" : ""}`}
                >
                  <div className="mod-cube">
                    <Package size={20} />
                  </div>
                  <div className="mod-copy">
                    <strong>{m.displayName || m.name || m.id || m.file}</strong>
                    {m.nameZh && <p>{m.originalName || m.name}</p>}
                    {m.displayDescription && (
                      <p className="mod-translation">{m.displayDescription}</p>
                    )}
                    {m.translation?.status === "unavailable" && (
                      <span className="mod-translation">
                        暂无中文 · 显示原文
                      </span>
                    )}
                    <p>
                      {m.version || "未知版本"} · {m.file || m.filename}
                    </p>
                  </div>
                  {m.duplicate && <span className="badge warning">重复</span>}
                  <button
                    className={`toggle ${m.enabled !== false ? "on" : ""}`}
                    aria-label={`${m.enabled === false ? "启用" : "禁用"} ${m.name}`}
                    aria-pressed={m.enabled !== false}
                    disabled={!!working}
                    onClick={() =>
                      void run("toggle", async () => {
                        await call("mods:toggle", {
                          id: instance.id,
                          file: m.file || m.filename,
                          enabled: m.enabled === false,
                        });
                        await loadMods();
                      })
                    }
                  >
                    <span />
                  </button>
                  <button
                    className="icon-button danger"
                    aria-label={`移除 ${m.name}`}
                    disabled={!!working}
                    onClick={() =>
                      void run("remove", async () => {
                        await call("mods:remove", {
                          id: instance.id,
                          file: m.file || m.filename,
                        });
                        await loadMods();
                      })
                    }
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {tab === "game" && (
        <div className="detail-body instance-game-options">
          <div className="field">
            <label htmlFor="instance-launch-preset">快速启动预设</label>
            <select
              id="instance-launch-preset"
              defaultValue=""
              onChange={(event) => {
                const preset = GAME_PRESETS[event.target.value];
                if (preset) setGameOptions({ ...preset.options });
              }}
            >
              <option value="">选择预设并预览，保存后生效</option>
              {Object.entries(GAME_PRESETS).map(([id, preset]) => (
                <option value={id} key={id}>
                  {preset.name} · {preset.description}
                </option>
              ))}
            </select>
          </div>
          <div className="notice">
            <SlidersHorizontal size={18} />
            提前设置下一次游戏的画面、音量和界面。正在运行的游戏应先退出。
          </div>
          <p className="muted">
            通用设置作为默认值；这里修改的选项只覆盖当前实例。
          </p>
          <GameOptionsFields
            value={{ ...gameDefaults, ...gameOptions }}
            onChange={option}
            idPrefix="instance-game"
          />
          <div className="instance-options-actions">
            <button
              className="btn subtle"
              disabled={!!working}
              onClick={() =>
                void run("inherit", async () => {
                  await call("instance:save", {
                    id: instance.id,
                    gameSettings: {},
                    replaceGameSettings: true,
                  });
                  setGameOptions({});
                  await refresh();
                  notify("已清除实例单独预设，下次启动使用通用设置");
                })
              }
            >
              恢复通用设置
            </button>
            <button
              className="btn primary"
              onClick={() =>
                void run("save", async () => {
                  await call("instance:save", {
                    id: instance.id,
                    gameSettings: gameOptions,
                  });
                  await refresh();
                  notify("游戏预设已保存，下次启动生效");
                })
              }
            >
              <Check size={16} />
              保存游戏预设
            </button>
          </div>
        </div>
      )}
      {tab === "advanced" && (
        <div className="detail-body instance-advanced">
          <div className="instance-rename-card">
            <div className="field">
              <label htmlFor={`instance-rename-${instance.id}`}>实例名称</label>
              <input
                id={`instance-rename-${instance.id}`}
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
              />
            </div>
            <button
              className="btn primary"
              onClick={() =>
                void run("rename", async () => {
                  await call("instance:save", {
                    id: instance.id,
                    name: editName,
                  });
                  await refresh();
                  notify("实例名称已更新");
                })
              }
            >
              保存名称
            </button>
          </div>
          <div className="danger-zone">
            <div>
              <strong>移除游戏实例</strong>
              <p>实例目录移入系统回收站，共享游戏资源缓存继续保留。</p>
            </div>
            <button
              className="btn danger"
              onClick={() => {
                if (!deleteConfirm) {
                  setDeleteConfirm(true);
                  return;
                }
                void run("delete", async () => {
                  await call("instance:delete", { id: instance.id });
                  await refresh();
                  notify("实例已移至回收站");
                });
              }}
            >
              {deleteConfirm ? "确认移至回收站" : "移除实例"}
            </button>
          </div>
        </div>
      )}
    </GlassSurface>
  );
}
