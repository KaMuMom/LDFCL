import { useCallback, useEffect, useRef, useState } from "react";
import {
  Home,
  Layers,
  Compass,
  Shirt,
  Download,
  Settings,
  Terminal,
  Plus,
  Play,
  ChevronRight,
  Box,
  Check,
  CheckCircle2,
  X,
  Minus,
  Square,
  UserRound,
  ShieldCheck,
  FolderOpen,
  SlidersHorizontal,
  Trash2,
  RefreshCw,
  Package,
  MemoryStick,
  Cpu,
  AlertTriangle,
  LogOut,
  ExternalLink,
  LoaderCircle,
  Pause,
  Copy,
  Globe,
  Info,
  Grid2X2,
} from "lucide-react";
import type { State, Task, LauncherAPI } from "../shared/types";
import Wardrobe from "./components/Wardrobe";
import HomeSkinPreview from "./components/HomeSkinPreview";
import ResourceDownloads, {
  type ResourceKind,
} from "./components/ResourceDownloads";
import About from "./components/About";
import Instances from "./components/Instances";
import GeneralGameSettings from "./components/GeneralGameSettings";
import HealthPanel from "./components/HealthPanel";
import Diagnostics from "./components/Diagnostics";
import AISettings from "./components/AISettings";
import { GAME_PRESETS, gamePreset } from "../shared/game-presets";
import { GlassSurface } from "./ui/Glass";
import { LAUNCHER_VERSION } from "../shared/launcher";
import { taskProgressPercent } from "../shared/task-progress";
declare global {
  interface Window {
    launcher?: LauncherAPI;
  }
}
const empty: State = {
  gameDirectories: [],
  instances: [],
  accounts: [],
  settings: {
    downloadConcurrency: 8,
    memoryMode: "auto",
    memoryMb: 4096,
    javaPath: "",
    microsoftClientId: "",
    closeOnLaunch: false,
  },
  system: {
    totalMemoryMb: 0,
    freeMemoryMb: 0,
    platform: "Windows · x64",
    version: LAUNCHER_VERSION,
    dataDir: "",
    gameRoot: "",
    defaultGameRoot: "",
  },
};
const nav = [
  { id: "home", name: "开始游戏", icon: Home },
  { id: "instances", name: "游戏实例", icon: Layers },
  { id: "discover", name: "资源下载", icon: Compass },
  { id: "wardrobe", name: "皮肤与披风", icon: Shirt },
  { id: "downloads", name: "下载任务", icon: Download },
];
const loaderName = (l: string) =>
  ({
    vanilla: "原版",
    fabric: "Fabric",
    quilt: "Quilt",
    forge: "Forge",
    neoforge: "NeoForge",
    optifine: "OptiFine",
  })[l] || l;
const errorMessage = (e: any) =>
  String(e.message || e).replace(
    /^Error invoking remote method '[^']+': Error: /,
    "",
  );
export default function App() {
  const [state, setState] = useState<State>(empty),
    [page, setPage] = useState("home"),
    [modal, setModal] = useState<null | "account" | "versions">(null),
    [instancePageTab, setInstancePageTab] = useState("mods"),
    [resourceKind, setResourceKind] = useState<ResourceKind>("minecraft"),
    [tasks, setTasks] = useState<Record<string, Task>>({}),
    [toast, setToast] = useState(""),
    [busy, setBusy] = useState(""),
    [logsByInstance, setLogs] = useState<Record<string, string[]>>({}),
    [running, setRunning] = useState<string[]>([]),
    [auth, setAuth] = useState<any>(null);
  const instance =
    state.instances.find((i) => i.id === state.selectedInstanceId) ||
    state.instances[0];
  const account =
    state.accounts.find((a) => a.id === state.selectedAccountId) ||
    state.accounts[0];
  const logs = logsByInstance[instance?.id || "launcher"] || [];
  const notify = useCallback((text: string) => setToast(text), []);
  const call = useCallback(
    async <T = any,>(method: string, payload?: any): Promise<T> => {
      if (window.launcher) return window.launcher.call<T>(method, payload);
      if (method === "state") return empty as T;
      throw Error("请在 LDFCL 桌面版中使用此功能");
    },
    [],
  );
  const refreshRequest = useRef(0);
  const refresh = async () => {
    const request = ++refreshRequest.current;
    try {
      const nextState = await call<State>("state");
      if (request === refreshRequest.current) setState(nextState);
    } catch (e) {
      if (request === refreshRequest.current) notify(errorMessage(e));
    }
  };
  const action = async (name: string, fn: () => Promise<any>) => {
    setBusy(name);
    try {
      await fn();
    } catch (e) {
      notify(errorMessage(e));
    } finally {
      setBusy("");
    }
  };
  useEffect(() => {
    void refresh();
    return window.launcher?.onEvent((e) => {
      if (e.type === "task") {
        const t = e.task || e;
        setTasks((old) => ({ ...old, [t.id]: t }));
      }
      if (
        e.type === "state" ||
        e.type === "account" ||
        e.type === "account-removed"
      )
        void refresh();
      if (e.type === "auth-status") {
        setAuth(e);
        if (e.status === "success") {
          void refresh();
          setModal(null);
          notify("正版账号登录成功");
        }
        if (["error", "expired"].includes(e.status)) notify(e.message);
      }
      if (e.type === "log")
        setLogs((old) => {
          const id = e.instanceId || "launcher";
          return {
            ...old,
            [id]: [
              ...(old[id] || []),
              ...String(e.line || e.message || "").split(/\r?\n/),
            ].slice(-500),
          };
        });
      if (e.type === "diagnosis") notify("已生成崩溃诊断，可在运行日志中查看");
      if (e.type === "game") {
        const id = e.instanceId;
        if (["started", "running"].includes(e.status))
          setRunning((old) => [...new Set([...old, id])]);
        if (["exited", "stopped", "error"].includes(e.status))
          setRunning((old) => old.filter((x) => x !== id));
        if (e.status === "error")
          notify(e.error || "游戏进程启动失败，请查看运行日志");
        if (e.status === "exited" && e.exitCode)
          notify(`游戏已退出（代码 ${e.exitCode}），可在运行日志中查看原因`);
      }
    });
  }, []);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        state.settings.theme === "dark" ||
        (state.settings.theme !== "light" && media.matches)
          ? "dark"
          : "light";
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [state.settings.theme]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 6500);
    return () => clearTimeout(t);
  }, [toast]);
  const openGameDownloads = () => {
    setResourceKind("minecraft");
    setPage("discover");
  };
  const launch = () =>
    action("launch", async () => {
      if (!instance) {
        openGameDownloads();
        return;
      }
      if (!account) {
        setModal("account");
        return;
      }
      const r = await call("launch", {
        instanceId: instance.id,
        accountId: account.id,
      });
      setRunning((old) => [...new Set([...old, instance.id])]);
      notify(`Minecraft 已启动 · PID ${r.pid}`);
      void refresh();
    });
  const select = async (p: any) => {
    await call("select", p);
    await refresh();
  };
  const list = Object.values(tasks);
  const activeTasks = list.filter(
    (t) => t.status === "running" || t.status === "downloading",
  );
  return (
    <div className="app-shell">
      <div className="app-backdrop" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <GlassSurface as="aside" className="sidebar" radius={28}>
        <div className="brand">
          <div className="brand-mark">
            <Box size={25} strokeWidth={1.8} />
          </div>
        </div>
        <nav>
          {nav.map((n) => (
            <button
              key={n.id}
              aria-label={n.name}
              title={n.name}
              data-tooltip={n.name}
              className={`nav-item ${page === n.id ? "active" : ""}`}
              onClick={() => {
                if (n.id === "instances") setInstancePageTab("mods");
                setPage(n.id);
              }}
            >
              <n.icon size={19} />
              {n.id === "downloads" && activeTasks.length > 0 ? (
                <b className="nav-count">{activeTasks.length}</b>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            aria-label="启动器设置"
            title="启动器设置"
            data-tooltip="启动器设置"
            className={`nav-item ${page === "settings" ? "active" : ""}`}
            onClick={() => setPage("settings")}
          >
            <Settings size={19} />
          </button>
          <button
            aria-label="运行日志"
            title="运行日志"
            data-tooltip="运行日志"
            className={`nav-item ${page === "logs" ? "active" : ""}`}
            onClick={() => setPage("logs")}
          >
            <Terminal size={19} />
          </button>
          <button
            aria-label="关于与致谢"
            title="关于与致谢"
            data-tooltip="关于与致谢"
            className={`nav-item ${page === "about" ? "active" : ""}`}
            onClick={() => setPage("about")}
          >
            <Info size={19} />
          </button>
          <div className="sidebar-divider" />
          <button
            className="account-mini"
            aria-label="账号管理"
            title="账号管理"
            data-tooltip="账号管理"
            onClick={() => setModal("account")}
          >
            <div className="avatar">
              <UserRound size={23} />
            </div>
          </button>
        </div>
      </GlassSurface>
      <div className="main-shell">
        <header className="titlebar">
          <div className="breadcrumb">
            <span className="titlebar-brand">
              LDFCL<span>.</span>
            </span>{" "}
            <ChevronRight size={13} />
            <b>
              {
                [
                  ...nav,
                  { id: "settings", name: "启动器设置" },
                  { id: "logs", name: "运行日志" },
                  { id: "about", name: "关于与致谢" },
                ].find((n) => n.id === page)?.name
              }
            </b>
          </div>
          <div className="title-actions">
            <span className="local-badge" title={state.system.gameRoot}>
              <span />
              {state.gameDirectories.find(
                (d) => d.id === state.selectedGameDirectoryId,
              )?.name || "本地工作空间"}
            </span>
            <button
              aria-label="最小化"
              onClick={() => window.launcher?.window("minimize")}
            >
              <Minus size={16} />
            </button>
            <button
              aria-label="最大化"
              onClick={() => window.launcher?.window("maximize")}
            >
              <Square size={12} />
            </button>
            <button
              aria-label="关闭"
              className="window-close"
              onClick={() => window.launcher?.window("close")}
            >
              <X size={17} />
            </button>
          </div>
        </header>
        <main className={`main-content ${page === "home" ? "home-main" : ""}`}>
          {page === "home" && (
            <div className="launcher-home">
              <div className="home-topline">
                <div>
                  <div className="eyebrow">MINECRAFT JAVA EDITION</div>
                  <h1>开始游戏</h1>
                </div>
                {instance && (
                  <HealthPanel
                    key={instance.id}
                    instanceId={instance.id}
                    call={call}
                    notify={notify}
                    compact
                  />
                )}
              </div>
              <div className="home-station">
                <HomeSkinPreview
                  accounts={state.accounts}
                  selectedAccountId={account?.id}
                  call={call}
                  notify={notify}
                  onSelect={async (id) => {
                    await select({ accountId: id });
                  }}
                  onManage={() => setModal("account")}
                />
                <div className="home-game-area">
                  <GlassSurface
                    className="home-version-card"
                    aria-label="当前游戏版本"
                  >
                    <div className="version-artwork">
                      <div className="version-artwork-shade" />
                      <span className="version-artwork-tag">
                        <Box size={14} />
                        JAVA EDITION
                      </span>
                      <div className="version-artwork-title">
                        <span>你的世界，随时出发</span>
                        <strong>MINECRAFT</strong>
                      </div>
                      <div className="version-artwork-info">
                        <span className="version-number">
                          {instance?.version || "尚未安装"}
                        </span>
                        <span>
                          {instance
                            ? loaderName(instance.loader)
                            : "从第一个版本开始"}
                        </span>
                      </div>
                    </div>
                    <div className="home-version-caption">
                      <div>
                        <h2>{instance?.name || "准备一个新世界"}</h2>
                        <p>
                          {instance
                            ? "存档与 Mod 独立隔离"
                            : "安装 Minecraft，开启你的冒险。"}
                        </p>
                      </div>
                      <span className="badge">
                        {instance ? "独立实例" : "MINECRAFT"}
                      </span>
                    </div>
                    <div className="home-version-actions">
                      <button
                        className="btn"
                        onClick={() => setModal("versions")}
                      >
                        <Layers size={16} />
                        切换版本
                      </button>
                      <button
                        className="btn"
                        disabled={!instance}
                        onClick={() => {
                          setInstancePageTab("game");
                          setPage("instances");
                        }}
                      >
                        <SlidersHorizontal size={16} />
                        版本设置
                      </button>
                      <button
                        className="btn"
                        disabled={!instance}
                        onClick={() => {
                          setInstancePageTab("mods");
                          setPage("instances");
                        }}
                      >
                        <Package size={16} />
                        Mod 管理
                      </button>
                    </div>
                  </GlassSurface>
                  <GlassSurface as="div" className="home-ready-bar">
                    <div className="home-ready-info">
                      <span className="ready-indicator" />
                      <div>
                        <strong>
                          {instance
                            ? account
                              ? "已就绪"
                              : "添加账号即可出发"
                            : "等待安装游戏"}
                        </strong>
                        <p>
                          {state.settings.memoryMode === "auto"
                            ? "自动分配内存"
                            : String(state.settings.memoryMb / 1024) +
                              " GB 内存"}{" "}
                          · 自动匹配 Java
                        </p>
                      </div>
                    </div>
                    <button
                      aria-label={
                        running.includes(instance?.id || "")
                          ? "停止游戏"
                          : instance
                            ? "启动游戏"
                            : "安装游戏"
                      }
                      className="home-launch-button"
                      disabled={busy === "launch" || busy === "stop"}
                      onClick={() =>
                        running.includes(instance?.id || "")
                          ? void action("stop", () =>
                              call("stop", { id: instance?.id }).then(() =>
                                setRunning((old) =>
                                  old.filter((x) => x !== instance?.id),
                                ),
                              ),
                            )
                          : void launch()
                      }
                    >
                      {busy === "launch" ? (
                        <LoaderCircle className="spin" size={24} />
                      ) : running.includes(instance?.id || "") ? (
                        <Pause size={24} />
                      ) : (
                        <Play size={24} fill="currentColor" />
                      )}
                      <span>
                        {busy === "launch"
                          ? "正在准备"
                          : running.includes(instance?.id || "")
                            ? "停止游戏"
                            : instance
                              ? "启动游戏"
                              : "安装游戏"}
                        <small>
                          {instance
                            ? "Minecraft " + instance.version
                            : "下载你的第一个版本"}
                        </small>
                      </span>
                      <ChevronRight size={20} />
                    </button>
                  </GlassSurface>
                </div>
              </div>
              <footer className="home-statusline">
                <span>
                  <ShieldCheck size={13} />
                  本地加密保存账号
                </span>
                <span>LDFCL {state.system.version}</span>
              </footer>
            </div>
          )}
          {page === "instances" && (
            <Instances
              key={state.selectedGameDirectoryId}
              initialTab={instancePageTab}
              gameRoot={state.system.gameRoot}
              gameDefaults={state.settings.gameDefaults}
              instances={state.instances}
              instance={instance}
              call={call}
              notify={notify}
              refresh={refresh}
              select={select}
              install={() => openGameDownloads()}
              launch={launch}
              busy={busy}
            />
          )}
          <div hidden={page !== "discover"}>
            <ResourceDownloads
              key={state.selectedGameDirectoryId}
              active={page === "discover"}
              instances={state.instances}
              kind={resourceKind}
              setKind={setResourceKind}
              instance={instance}
              call={call}
              notify={notify}
              onInstalled={() => void refresh()}
              showTasks={() => setPage("downloads")}
            />
          </div>
          {page === "about" && (
            <About version={state.system.version} call={call} notify={notify} />
          )}
          {page === "wardrobe" && (
            <>
              <PageTitle
                eyebrow="YOUR OWN IDENTITY"
                title="皮肤与披风"
                subtitle="预览和编辑皮肤，管理你拥有的正版披风。"
              />
              <Wardrobe
                accounts={state.accounts}
                selectedAccountId={account?.id}
                call={call}
                notify={notify}
              />
            </>
          )}
          {page === "downloads" && (
            <>
              <PageTitle
                eyebrow="DOWNLOAD CENTER"
                title="下载任务"
                subtitle={`${state.settings.downloadConcurrency} 线程并发 · 自动重试与文件完整性校验`}
              />
              <div className="section-title">
                <h3>
                  下载任务 <span>{list.length}</span>
                </h3>
                <button
                  className="btn subtle"
                  onClick={() =>
                    setTasks((old) =>
                      Object.fromEntries(
                        Object.entries(old).filter(([, t]) =>
                          ["running", "downloading", "paused"].includes(
                            t.status,
                          ),
                        ),
                      ),
                    )
                  }
                >
                  <Trash2 size={15} />
                  清除已完成
                </button>
              </div>
              <div className="task-list">
                {!list.length ? (
                  <Empty
                    icon={Download}
                    title="这里暂时很安静"
                    text="安装游戏或下载社区内容后，可以在这里查看进度。"
                  />
                ) : (
                  [...list].reverse().map((t) => (
                    <GlassSurface as="div" className="task-row" key={t.id}>
                      <span
                        className={`quick-icon ${t.status === "error" ? "peach" : "mint"}`}
                      >
                        {t.status === "completed" ? (
                          <Check size={21} />
                        ) : t.status === "error" ? (
                          <AlertTriangle size={21} />
                        ) : (
                          <Download size={21} />
                        )}
                      </span>
                      <div>
                        <strong>{t.title}</strong>
                        <p>
                          {t.detail ||
                            {
                              completed: "已完成",
                              error: "下载失败",
                              running: "正在下载",
                              downloading: "正在下载",
                              paused: "已暂停",
                              cancelled: "已取消",
                            }[t.status] ||
                            t.status}
                        </p>
                        <div className="progress">
                          <i
                            style={{
                              width: `${taskProgressPercent(t)}%`,
                            }}
                          />
                        </div>
                      </div>
                      <span>{taskProgressPercent(t)}%</span>
                      {t.controllable && (
                        <div className="button-group">
                          <select
                            aria-label={`${t.title} 下载源`}
                            value={
                              t.source ||
                              state.settings.downloadSource ||
                              "official"
                            }
                            onChange={(event) =>
                              void call("download:source", {
                                id: t.id,
                                source: event.target.value,
                              }).catch((error) => notify(errorMessage(error)))
                            }
                          >
                            <option value="official">官方源</option>
                            <option value="bmclapi">BMCLAPI</option>
                          </select>
                          <button
                            className="btn subtle"
                            onClick={() =>
                              void call("download:control", {
                                id: t.id,
                                action:
                                  t.status === "paused" ? "resume" : "pause",
                              }).catch((error) => notify(errorMessage(error)))
                            }
                          >
                            {t.status === "paused" ? "继续" : "暂停"}
                          </button>
                          <button
                            className="btn subtle"
                            onClick={() =>
                              void call("download:control", {
                                id: t.id,
                                action: "cancel",
                              }).catch((error) => notify(errorMessage(error)))
                            }
                          >
                            取消
                          </button>
                        </div>
                      )}
                    </GlassSurface>
                  ))
                )}
              </div>
            </>
          )}
          {page === "settings" && (
            <LauncherSettings
              state={state}
              call={call}
              refresh={refresh}
              notify={notify}
            />
          )}
          {page === "logs" && (
            <Diagnostics
              call={call}
              instanceId={instance?.id}
              instances={state.instances}
              logs={logs}
            />
          )}
        </main>
      </div>
      {toast && (
        <GlassSurface as="div" role="status" className="toast" radius={20}>
          <span>{toast}</span>
          <button aria-label="关闭提示" onClick={() => setToast("")}>
            <X size={16} />
          </button>
        </GlassSurface>
      )}
      {modal === "versions" && (
        <Modal
          title="切换游戏版本"
          subtitle="选择已安装的独立实例，或下载新的游戏版本。"
          close={() => setModal(null)}
        >
          <div className="home-instance-picker">
            {state.instances.map((i) => (
              <button
                key={i.id}
                className={i.id === instance?.id ? "selected" : ""}
                onClick={() =>
                  void action("select", async () => {
                    await select({ instanceId: i.id });
                    setModal(null);
                  })
                }
              >
                <span className="instance-icon">
                  <Box size={24} />
                </span>
                <span>
                  <strong>{i.name}</strong>
                  <small>
                    Minecraft {i.version} · {loaderName(i.loader)}
                  </small>
                </span>
                {i.id === instance?.id ? (
                  <CheckCircle2 size={18} />
                ) : (
                  <ChevronRight size={17} />
                )}
              </button>
            ))}
            {!state.instances.length && (
              <p className="muted">还没有安装游戏，先下载一个版本吧。</p>
            )}
          </div>
          <button
            className="btn primary full"
            onClick={() => {
              setModal(null);
              openGameDownloads();
            }}
          >
            <Plus size={16} />
            下载新版本
          </button>
        </Modal>
      )}
      {modal === "account" && (
        <AccountModal
          state={state}
          call={call}
          auth={auth}
          refresh={refresh}
          notify={notify}
          close={() => setModal(null)}
        />
      )}
    </div>
  );
}
function PageTitle({
  eyebrow,
  title,
  subtitle,
  children,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {children}
    </div>
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
    <GlassSurface as="div" className="empty">
      <div className="empty-icon">
        <Icon size={29} />
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
    </GlassSurface>
  );
}
function Modal({
  title,
  subtitle,
  close,
  children,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  close: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <GlassSurface
        as="div"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal ${wide ? "wide" : ""}`}
        radius={28}
      >
        <div className="modal-heading">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-button" onClick={close} aria-label="关闭弹窗">
            <X size={20} />
          </button>
        </div>
        {children}
      </GlassSurface>
    </div>
  );
}
function MicrosoftDeviceStatus({
  auth,
  call,
  onError,
}: {
  auth: any;
  call: LauncherAPI["call"];
  onError: (message: string) => void;
}) {
  const [seconds, setSeconds] = useState(auth.expiresIn ?? 0);
  const [copied, setCopied] = useState(auth.codeCopied === true);
  useEffect(() => {
    setCopied(auth.codeCopied === true);
  }, [auth.userCode, auth.codeCopied]);
  useEffect(() => {
    const expiresAt = Date.now() + (auth.expiresIn ?? 0) * 1000;
    const update = () =>
      setSeconds(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [auth.userCode, auth.expiresIn]);
  const waiting = auth.status === "waiting";
  return (
    <div className="device-auth-status" role="status" aria-live="polite">
      <div className="device-auth-heading">
        <LoaderCircle className="spin" size={20} />
        <strong>{waiting ? "等待微软授权" : "正在获取 Minecraft 档案"}</strong>
      </div>
      {waiting && (
        <>
          <p>{auth.message || "在已打开的微软页面输入以下授权码："}</p>
          <code className="device-code-value" aria-label="微软授权码">
            {auth.userCode}
          </code>
          <p className="device-code-copy-status">
            {copied
              ? auth.codeCopied
                ? "授权码已自动复制，可在微软页面直接粘贴。"
                : "授权码已复制，可在微软页面直接粘贴。"
              : auth.copyMessage ||
                (auth.codeCopied === false
                  ? "未能自动复制授权码，请使用“复制授权码”按钮或手动输入。"
                  : "正在准备复制授权码…")}
          </p>
          <div className="device-auth-actions">
            <button
              className="btn subtle"
              aria-label="复制授权码"
              onClick={() =>
                void navigator.clipboard
                  .writeText(auth.userCode)
                  .then(() => setCopied(true))
                  .catch(() => onError("无法复制，请手动输入上方授权码。"))
              }
            >
              {copied ? <Check size={15} /> : <Copy size={15} />}
              {copied ? "已复制" : "复制授权码"}
            </button>
            <button
              className="btn subtle"
              onClick={() =>
                void call("external", { url: auth.verificationUri }).catch(
                  (e) => onError(errorMessage(e)),
                )
              }
            >
              打开微软授权页面 <ExternalLink size={15} />
            </button>
          </div>
          <small className="device-auth-expiry" aria-live="off">
            剩余 {Math.floor(seconds / 60)}:
            {String(seconds % 60).padStart(2, "0")}
            ，完成后将自动登录
          </small>
        </>
      )}
      {!waiting && <p>{auth.message}</p>}
      <button
        className="text-button"
        onClick={() =>
          void call("account:cancel").catch((e) => onError(errorMessage(e)))
        }
      >
        取消本次登录
      </button>
    </div>
  );
}
function AccountModal({
  state,
  call,
  auth,
  refresh,
  notify,
  close,
}: {
  state: State;
  call: LauncherAPI["call"];
  auth: any;
  refresh: () => Promise<void>;
  notify: (s: string) => void;
  close: () => void;
}) {
  const [type, setType] = useState("microsoft"),
    [name, setName] = useState(""),
    [server, setServer] = useState(""),
    [password, setPassword] = useState(""),
    [clientId, setClientId] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const attempt = useRef(0);
  const devicePending =
    type === "microsoft" &&
    auth?.flow === "device" &&
    ["waiting", "authenticating"].includes(auth.status);
  useEffect(
    () => () => {
      attempt.current++;
    },
    [],
  );
  const displayError =
    error ||
    (type === "microsoft" &&
    !busy &&
    auth?.flow === "device" &&
    ["error", "expired"].includes(auth.status)
      ? auth.message
      : "");
  const cancelPending = async () => {
    if (type === "microsoft") await call("account:cancel");
  };
  const closeAccount = () => {
    if (busy && type !== "microsoft") return;
    attempt.current++;
    void cancelPending()
      .then(close)
      .catch((e) => setError(errorMessage(e)));
  };
  const add = async () => {
    const run = ++attempt.current;
    setBusy(true);
    setError("");
    try {
      if (type === "offline") {
        await call("account:offline", { name });
        await refresh();
        close();
        notify("离线账号已添加");
      } else if (type === "yggdrasil") {
        await call("account:yggdrasil", { server, username: name, password });
        setPassword("");
        await refresh();
        close();
        notify("皮肤站账号已添加");
      } else {
        if (clientId.trim()) {
          await call("settings", { microsoftClientId: clientId.trim() });
          if (run === attempt.current) setClientId("");
          await refresh();
        }
        if (run !== attempt.current) return;
        await call("account:microsoft");
      }
    } catch (e) {
      if (run === attempt.current) setError(errorMessage(e));
    } finally {
      if (run === attempt.current) setBusy(false);
    }
  };
  return (
    <Modal
      title="你的冒险身份"
      subtitle="支持 Microsoft 正版、离线和 Yggdrasil 皮肤站。"
      close={closeAccount}
    >
      {state.accounts.length > 0 && (
        <div className="account-list">
          {state.accounts.map((a) => (
            <div key={a.id}>
              <span className="avatar">
                <UserRound size={20} />
              </span>
              <div>
                <strong>{a.name}</strong>
                <small>
                  {a.type === "microsoft"
                    ? "正版"
                    : a.type === "offline"
                      ? "离线"
                      : a.server}
                </small>
              </div>
              <button
                className="btn subtle"
                disabled={busy}
                onClick={() =>
                  void cancelPending()
                    .then(() => call("select", { accountId: a.id }))
                    .then(refresh)
                    .then(close)
                }
              >
                {state.selectedAccountId === a.id ? "当前" : "使用"}
              </button>
              <button
                className="icon-button danger"
                aria-label={`移除 ${a.name}`}
                onClick={() =>
                  void call("account:remove", { id: a.id })
                    .then(refresh)
                    .catch((e) => notify(errorMessage(e)))
                }
              >
                <LogOut size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="segmented account-tabs">
        {[
          ["microsoft", "正版登录"],
          ["offline", "离线账号"],
          ["yggdrasil", "其他皮肤站"],
        ].map(([id, label]) => (
          <button
            key={id}
            className={type === id ? "selected" : ""}
            disabled={busy}
            onClick={() => {
              if (id === type || busy) return;
              setBusy(true);
              void cancelPending()
                .then(() => {
                  setType(id);
                  setError("");
                })
                .catch((e) => setError(errorMessage(e)))
                .finally(() => setBusy(false));
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {type === "microsoft" ? (
        <>
          {!devicePending && (
            <div className="microsoft-login-intro">
              <ShieldCheck size={30} />
              <div>
                <strong>使用 Microsoft 账号登录</strong>
                <p>
                  通过微软设备代码完成正版授权。在系统浏览器的 Microsoft
                  页面输入代码，LDFCL 不会接收您的微软密码。
                </p>
              </div>
            </div>
          )}
          {!devicePending && (
            <details
              className="auth-config"
              open={
                state.settings.microsoftClientIdStorageStatus !== "ready" &&
                !busy &&
                !["waiting", "authenticating"].includes(auth?.status)
              }
            >
              <summary>应用授权配置</summary>
              <div className="field">
                <label htmlFor="microsoft-client-id">
                  Microsoft 应用 Client ID
                </label>
                <input
                  id="microsoft-client-id"
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  value={clientId}
                  disabled={
                    busy || ["waiting", "authenticating"].includes(auth?.status)
                  }
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder={
                    state.settings.microsoftClientIdStorageStatus === "ready"
                      ? "已加密保存，留空继续使用"
                      : "具有 Minecraft API 权限的公用客户端 ID"
                  }
                />
              </div>
              <p>
                {state.settings.microsoftClientIdStorageStatus === "ready"
                  ? "Client ID 已加密保存。留空继续使用，输入新值可替换。"
                  : state.settings.microsoftClientIdStorageStatus ===
                      "unavailable"
                    ? "系统加密存储不可用，请恢复系统加密功能后重新配置。"
                    : state.settings.microsoftClientIdStorageStatus ===
                        "unreadable"
                      ? "保存的授权配置无法解密，请重新输入 Client ID。"
                      : state.settings.microsoftClientIdStorageStatus ===
                          "migration-pending"
                        ? "旧授权配置尚未完成加密迁移，请恢复系统加密功能后重新配置。"
                        : "尚未配置 Client ID，保存时将使用系统加密存储。"}
              </p>
              <p>
                使用自有且获准访问 Minecraft API 的应用，并启用公用客户端流程。
                设备代码登录无需配置本机回调地址。
              </p>
            </details>
          )}
          <p className="auth-tls-note">
            <ShieldCheck size={15} />
            正版登录使用 HTTPS 证书验证，证书异常时停止登录。
          </p>
          {auth?.flow === "device" &&
            ["waiting", "authenticating"].includes(auth.status) && (
              <MicrosoftDeviceStatus
                auth={auth}
                call={call}
                onError={setError}
              />
            )}
        </>
      ) : (
        <>
          {type === "yggdrasil" && (
            <div className="field">
              <label>认证服务器地址</label>
              <input
                value={server}
                onChange={(e) => setServer(e.target.value)}
                placeholder="https://皮肤站/api/yggdrasil"
              />
            </div>
          )}
          <div className="field">
            <label>
              {type === "offline"
                ? "玩家名称（3–16 个英文字母、数字或下划线）"
                : "用户名 / 邮箱"}
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={type === "offline" ? "Steve" : "你的皮肤站用户名"}
            />
          </div>
          {type === "yggdrasil" && (
            <div className="field">
              <label>密码</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="off"
                placeholder="仅用于本次登录，不保存密码"
              />
            </div>
          )}
          {type === "offline" && (
            <div className="notice">
              <Globe size={18} />
              <span>离线身份适用于本地游戏及允许离线登录的服务器。</span>
            </div>
          )}
        </>
      )}
      {displayError && (
        <div className="error-box" role="alert">
          {displayError}
        </div>
      )}
      {!devicePending && (
        <button
          className="btn primary full"
          disabled={
            busy ||
            (type === "microsoft" &&
              ["waiting", "authenticating"].includes(auth?.status))
          }
          onClick={() => void add()}
        >
          {busy ? (
            <LoaderCircle className="spin" size={17} />
          ) : type === "microsoft" ? (
            <Grid2X2 size={17} />
          ) : (
            <Plus size={17} />
          )}{" "}
          {type === "microsoft"
            ? busy
              ? "正在获取授权码…"
              : "开始微软登录"
            : "添加账号"}
        </button>
      )}
    </Modal>
  );
}
function LauncherSettings({
  state,
  call,
  refresh,
  notify,
}: {
  state: State;
  call: LauncherAPI["call"];
  refresh: () => Promise<void>;
  notify: (s: string) => void;
}) {
  const [s, setS] = useState(state.settings),
    [runtime, setRuntime] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [directoryBusy, setDirectoryBusy] = useState(false);
  useEffect(() => {
    setS((previous) => ({ ...previous, gameRoot: state.settings.gameRoot }));
  }, [state.settings.gameRoot]);
  const directoryAction = async (method: string, payload?: any) => {
    setDirectoryBusy(true);
    try {
      const result = await call(method, payload);
      if (!result) return;
      await refresh();
      if (method === "game-directory:remove") {
        notify("已移除目录登记，游戏文件保留在原处");
      } else {
        const warnings = result.warnings || [];
        notify(
          `游戏目录已就绪 · 新发现 ${result.discovered || 0} 个版本${warnings.length ? ` · ${warnings[0]}${warnings.length > 1 ? `（共 ${warnings.length} 条提示）` : ""}` : ""}`,
        );
      }
    } catch (e) {
      notify(errorMessage(e));
    } finally {
      setDirectoryBusy(false);
    }
  };
  const save = async () => {
    setBusy(true);
    try {
      const { gameRoot: _gameRoot, ...preferences } = s;
      await call("settings", preferences);
      await refresh();
      notify("启动器设置已保存");
    } catch (e) {
      notify(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageTitle
        eyebrow="MAKE IT YOURS"
        title="启动器设置"
        subtitle="让性能、下载和运行环境，适合你的电脑。"
      >
        <button
          className="btn primary"
          disabled={busy || directoryBusy}
          onClick={() => void save()}
        >
          <Check size={17} />
          保存设置
        </button>
      </PageTitle>
      <div className="settings-grid">
        <GlassSurface className="settings-panel full-span">
          <h3>
            <Settings size={19} />
            外观与启动预设
          </h3>
          <div className="field">
            <label htmlFor="launcher-theme">主题</label>
            <select
              id="launcher-theme"
              value={s.theme || "system"}
              onChange={(event) =>
                setS({
                  ...s,
                  theme: event.target.value as "system" | "light" | "dark",
                })
              }
            >
              <option value="system">跟随系统</option>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="launcher-preset">通用启动预设</label>
            <select
              id="launcher-preset"
              value={s.gamePreset || "custom"}
              onChange={(event) => {
                const id = event.target.value as typeof s.gamePreset;
                setS({
                  ...s,
                  gamePreset: id,
                  ...(id && id !== "custom"
                    ? { gameDefaults: gamePreset(id) }
                    : {}),
                });
              }}
            >
              <option value="custom">自定义</option>
              {Object.entries(GAME_PRESETS).map(([id, preset]) => (
                <option key={id} value={id}>
                  {preset.name} · {preset.description}
                </option>
              ))}
            </select>
          </div>
          <p className="muted">
            预设更新通用游戏设置，实例内单独设置继续优先；保存后生效。
          </p>
        </GlassSurface>
        <GeneralGameSettings
          value={s.gameDefaults}
          onChange={(gameDefaults) => setS({ ...s, gameDefaults })}
        />
        <GlassSurface className="settings-panel full-span game-directories-panel">
          <div className="directory-heading">
            <h3>
              <FolderOpen size={19} />
              游戏目录
            </h3>
            <div className="directory-actions">
              <button
                className="btn subtle"
                disabled={directoryBusy || busy}
                onClick={() => void directoryAction("game-directory:scan")}
              >
                <RefreshCw size={15} />
                重新扫描版本
              </button>
              <button
                className="btn primary"
                disabled={directoryBusy || busy}
                onClick={() => void directoryAction("game-directory:add")}
              >
                {directoryBusy ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <Plus size={16} />
                )}
                添加游戏目录
              </button>
            </div>
          </div>
          <p className="muted">
            可选择任意位置的 .minecraft 或其他游戏文件夹。切换后，版本、Mod
            和游戏设置随目录切换。
          </p>
          {state.system.gameDirectoryError && (
            <div className="notice directory-error" role="alert">
              <AlertTriangle size={17} />
              {state.system.gameDirectoryError}
            </div>
          )}
          <div className="directory-list">
            {state.gameDirectories.map((directory) => {
              const selected = directory.id === state.selectedGameDirectoryId;
              return (
                <div
                  className={`game-directory-row ${selected ? "selected" : ""}`}
                  key={directory.id}
                  data-game-directory-id={directory.id}
                >
                  <span className={`quick-icon ${selected ? "mint" : ""}`}>
                    <FolderOpen size={20} />
                  </span>
                  <div className="directory-details">
                    <div className="directory-label">
                      <strong>{directory.name}</strong>
                      {selected && <span className="badge">当前使用</span>}
                      {directory.isDefault && (
                        <span className="badge">程序旁默认</span>
                      )}
                      {directory.layout === "legacy" && (
                        <span className="badge">原有目录</span>
                      )}
                    </div>
                    <p className="break-word" title={directory.path}>
                      {directory.path}
                    </p>
                  </div>
                  <div className="directory-actions">
                    <button
                      className="btn subtle"
                      disabled={directoryBusy || busy}
                      onClick={() =>
                        void call("game-directory:open", {
                          id: directory.id,
                        }).catch((e) => notify(errorMessage(e)))
                      }
                    >
                      <FolderOpen size={15} />
                      打开目录
                    </button>
                    {!selected && (
                      <button
                        className="btn subtle"
                        disabled={directoryBusy || busy}
                        onClick={() =>
                          void directoryAction("game-directory:select", {
                            id: directory.id,
                          })
                        }
                      >
                        <Check size={15} />
                        使用目录
                      </button>
                    )}
                    {!directory.isDefault && (
                      <button
                        className="btn subtle"
                        disabled={directoryBusy || busy}
                        onClick={() =>
                          void directoryAction("game-directory:remove", {
                            id: directory.id,
                          })
                        }
                      >
                        <Trash2 size={15} />
                        移除目录
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="notice">
            <Info size={17} />
            <span>
              默认目录在启动器程序旁创建。添加已有目录会识别其中的版本，各版本继续使用独立的
              Mod、存档和设置；原有文件保留原处。移除目录仅取消登记。
            </span>
          </div>
          <p className="directory-default-path break-word">
            默认位置：{state.system.defaultGameRoot || "桌面版启动后显示"}
          </p>
        </GlassSurface>
        <GlassSurface className="settings-panel">
          <h3>
            <MemoryStick size={19} />
            内存分配
          </h3>
          <p className="muted">
            可用 {(state.system.freeMemoryMb / 1024).toFixed(1)} GB / 共{" "}
            {(state.system.totalMemoryMb / 1024).toFixed(1)} GB
          </p>
          <div className="segmented">
            <button
              className={s.memoryMode === "auto" ? "selected" : ""}
              onClick={() => setS({ ...s, memoryMode: "auto" })}
            >
              智能分配
            </button>
            <button
              className={s.memoryMode === "manual" ? "selected" : ""}
              onClick={() => setS({ ...s, memoryMode: "manual" })}
            >
              手动调整
            </button>
          </div>
          {s.memoryMode === "auto" ? (
            <div className="memory-visual">
              <span>系统与其他应用</span>
              <i />
              <b>按版本与可用内存动态分配</b>
            </div>
          ) : (
            <div className="field slider-field">
              <label>
                游戏内存<b>{(s.memoryMb / 1024).toFixed(1)} GB</b>
              </label>
              <input
                type="range"
                min={1024}
                max={Math.max(state.system.totalMemoryMb - 2048, 2048)}
                step={256}
                value={s.memoryMb}
                onChange={(e) =>
                  setS({ ...s, memoryMb: Number(e.target.value) })
                }
              />
            </div>
          )}
          <div className="notice">
            自动模式为系统预留内存，模组较多时可切换到手动分配。
          </div>
        </GlassSurface>
        <GlassSurface className="settings-panel">
          <h3>
            <Download size={19} />
            下载与网络
          </h3>
          <div className="field">
            <label htmlFor="global-download-source">全局游戏资源源</label>
            <select
              id="global-download-source"
              value={s.downloadSource || "official"}
              onChange={(event) =>
                setS({
                  ...s,
                  downloadSource: event.target.value as "official" | "bmclapi",
                })
              }
            >
              <option value="official">官方源</option>
              <option value="bmclapi">BMCLAPI 镜像</option>
            </select>
          </div>
          <div className="field slider-field">
            <label>
              并发下载线程<b>{s.downloadConcurrency} 线程</b>
            </label>
            <input
              type="range"
              min={1}
              max={32}
              value={s.downloadConcurrency}
              onChange={(e) =>
                setS({ ...s, downloadConcurrency: Number(e.target.value) })
              }
            />
          </div>
          <div className="notice">
            <ShieldCheck size={17} />
            游戏资源和内容下载均进行哈希校验，失败自动重试。
          </div>
          <p className="muted">
            镜像仅映射支持的游戏资源地址，账号认证仍连接官方；各下载任务可单独选择源。
          </p>
        </GlassSurface>
        <GlassSurface className="settings-panel full-span">
          <h3>
            <Cpu size={19} />
            Java 运行环境
          </h3>
          <div className="java-status">
            <span className="quick-icon mint">
              <CheckCircle2 size={23} />
            </span>
            <div>
              <strong>按游戏需求自动选择</strong>
              <p>
                优先使用匹配的本地 Java；缺失时下载 Eclipse
                Temurin，不修改系统环境变量。
              </p>
            </div>
            <button
              className="btn subtle"
              onClick={() =>
                void call("runtime")
                  .then(setRuntime)
                  .catch((e) => notify(errorMessage(e)))
              }
            >
              <RefreshCw size={15} />
              检测环境
            </button>
          </div>
          <div className="field">
            <label>自定义 Java 路径（留空使用自动模式）</label>
            <div className="input-with-button">
              <input
                value={s.javaPath}
                onChange={(e) => setS({ ...s, javaPath: e.target.value })}
                placeholder="自动选择 javaw.exe"
              />
              <button
                className="btn subtle"
                onClick={() =>
                  void call("java:choose").then(
                    (p) => p && setS({ ...s, javaPath: p }),
                  )
                }
              >
                <FolderOpen size={16} />
                浏览
              </button>
            </div>
          </div>
          {runtime && (
            <pre className="runtime-info">
              {JSON.stringify(runtime, null, 2)}
            </pre>
          )}
        </GlassSurface>
        <GlassSurface className="settings-panel full-span">
          <h3>
            <Settings size={19} />
            工作空间
          </h3>
          <StoreStats call={call} />
          <div className="setting-row">
            <div>
              <strong>游戏启动后最小化</strong>
              <p>让工作台退到后台，专注正在发生的冒险。</p>
            </div>
            <button
              className={`toggle ${s.closeOnLaunch ? "on" : ""}`}
              aria-label="游戏启动后最小化"
              onClick={() => setS({ ...s, closeOnLaunch: !s.closeOnLaunch })}
            >
              <span />
            </button>
          </div>
          <div className="setting-row">
            <div>
              <strong>账号与启动器配置目录</strong>
              <p className="break-word">
                {state.system.dataDir || "桌面版启动后显示"}
              </p>
            </div>
            <button className="btn subtle" onClick={() => void call("folder")}>
              <FolderOpen size={16} />
              打开目录
            </button>
          </div>
          <div className="setting-row">
            <div>
              <strong>LDFCL {state.system.version}</strong>
              <p>{state.system.platform} · 开源桌面启动器</p>
            </div>
            <span className="badge">Minecraft Java Edition</span>
          </div>
        </GlassSurface>
        <GlassSurface className="settings-panel full-span">
          <AISettings call={call} />
        </GlassSurface>
      </div>
    </>
  );
}

function StoreStats({ call }: { call: LauncherAPI["call"] }) {
  const [stats, setStats] = useState<any>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void call("store:stats")
      .then((value) => {
        if (active) setStats(value);
      })
      .catch((error) => {
        if (active) setError(String(error.message || error));
      });
    return () => {
      active = false;
    };
  }, [call]);
  return (
    <div className="setting-row">
      <div>
        <strong>内容存储仓库（SHA-256）</strong>
        <p className="break-word">
          {stats
            ? `${stats.objects ?? stats.objectCount ?? 0} 个独立对象 · ${((stats.bytes ?? stats.totalBytes ?? stats.storedBytes ?? 0) / 1048576).toFixed(1)} MB`
            : error || "正在统计…"}
        </p>
      </div>
      <button
        className="btn subtle"
        onClick={() =>
          void call("store:stats")
            .then(setStats)
            .catch((error) => setError(String(error.message || error)))
        }
      >
        刷新统计
      </button>
    </div>
  );
}
