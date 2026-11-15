import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronRight,
  Cpu,
  Download,
  FolderOpen,
  Info,
  LoaderCircle,
  MemoryStick,
  Plus,
  RefreshCw,
  Settings,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { GAME_PRESETS, gamePreset } from "@ldfcl/contracts/game-presets";
import type { LauncherAPI, State } from "@ldfcl/contracts/types";
import type { LauncherUpdateState } from "@ldfcl/contracts/updates";
import { SETTINGS_SECTIONS, type SettingsSection } from "../app/navigation";
import GeneralGameSettings from "../components/GeneralGameSettings";
import LauncherUpdates from "../components/LauncherUpdates";
import { GlassSurface } from "../ui/Glass";
import PageTitle from "../ui/PageTitle";
import { errorMessage } from "../ui/format";
export default function LauncherSettings({
  state,
  call,
  refresh,
  notify,
  launcherUpdate,
  section,
  onSectionChange,
}: {
  state: State;
  call: LauncherAPI["call"];
  refresh: () => Promise<void>;
  notify: (s: string) => void;
  launcherUpdate?: LauncherUpdateState;
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
}) {
  const [s, setS] = useState(state.settings),
    [runtime, setRuntime] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [directoryBusy, setDirectoryBusy] = useState(false);
  const baseline = useRef(state.settings);
  useEffect(() => {
    // Adopt refreshed values only for fields that the user has not edited.
    const previous = baseline.current;
    baseline.current = state.settings;
    setS((draft) => {
      const next = { ...draft, ...state.settings };
      for (const key of Object.keys(draft) as (keyof typeof draft)[]) {
        if (JSON.stringify(draft[key]) !== JSON.stringify(previous[key]))
          Object.assign(next, { [key]: draft[key] });
      }
      return next;
    });
  }, [state.settings]);
  const changes = Object.fromEntries(
    Object.entries(s).filter(
      ([key, value]) =>
        ![
          "gameRoot",
          "microsoftClientIdConfigured",
          "microsoftClientIdStorageStatus",
        ].includes(key) &&
        JSON.stringify(value) !==
          JSON.stringify(state.settings[key as keyof typeof s]),
    ),
  );
  const dirty = Object.keys(changes).length > 0;
  const directoryAction = async (method: string, payload?: any) => {
    setDirectoryBusy(true);
    try {
      const result = await call(method, payload);
      if (!result) return;
      await refresh();
      if (method === "game-directory:remove") {
        notify("已移除目录登记，游戏文件保留在原处");
      } else if (method === "game-directory:relocate") {
        notify("已更新游戏目录位置，原有实例和选择保留");
      } else if (method === "game-directory:create-default") {
        notify("已创建程序旁的默认游戏目录，原来移走的文件未作改动");
      } else {
        const warnings = result.warnings || [];
        notify(
          `游戏目录已${method === "game-directory:scan" ? "扫描" : "切换"} · 新发现 ${result.discovered || 0} 个版本${warnings.length ? ` · 有 ${warnings.length} 条兼容提示，可展开查看` : ""}`,
        );
      }
    } catch (e) {
      notify(errorMessage(e));
      await refresh();
    } finally {
      setDirectoryBusy(false);
    }
  };
  const save = async () => {
    setBusy(true);
    try {
      await call("settings", changes);
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
        <span className={`save-state ${dirty ? "dirty" : ""}`} role="status">
          {dirty ? "有未保存的更改" : "所有设置已保存"}
        </span>
        <button
          className="btn subtle"
          disabled={!dirty || busy}
          onClick={() => setS(state.settings)}
        >
          撤销更改
        </button>
        <button
          className="btn primary"
          disabled={busy || directoryBusy || !dirty}
          onClick={() => void save()}
        >
          <Check size={17} />
          保存设置
        </button>
      </PageTitle>
      <div className="settings-workspace">
        <nav className="settings-navigation" aria-label="设置分类">
          {SETTINGS_SECTIONS.map((item) => (
            <button
              key={item.id}
              aria-current={section === item.id ? "page" : undefined}
              className={section === item.id ? "selected" : ""}
              onClick={() => onSectionChange(item.id)}
            >
              <item.icon size={17} />
              <span>
                <strong>{item.name}</strong>
                <small>{item.description}</small>
              </span>
            </button>
          ))}
        </nav>
        <div className="settings-content">
          {section === "appearance" && (
            <div
              className="settings-grid settings-section"
              key="appearance"
              aria-label="appearance"
            >
              <GlassSurface className="settings-panel full-span">
                <h3>
                  <Settings size={19} />
                  外观与动效
                </h3>
                <div className="field">
                  <label htmlFor="launcher-theme">主题</label>
                  <select
                    id="launcher-theme"
                    value={s.theme || "system"}
                    onChange={(event) =>
                      setS({
                        ...s,
                        theme: event.target.value as
                          "system" | "light" | "dark",
                      })
                    }
                  >
                    <option value="system">跟随系统</option>
                    <option value="light">浅色</option>
                    <option value="dark">深色</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="launcher-interface-performance">
                    界面性能
                  </label>
                  <select
                    id="launcher-interface-performance"
                    value={s.interfacePerformance || "efficient"}
                    onChange={(event) =>
                      setS({
                        ...s,
                        interfacePerformance: event.target.value as
                          "efficient" | "quality",
                      })
                    }
                  >
                    <option value="efficient">
                      流畅优先 · 推荐入门电脑与 4GB 内存
                    </option>
                    <option value="quality">视觉优先 · 完整玻璃折射</option>
                  </select>
                </div>
                <p className="muted">
                  流畅优先使用轻量材质与按需皮肤渲染，旋转和操作时保持动画。保存后生效。
                </p>
                <div className="field">
                  <label htmlFor="launcher-motion">动态效果</label>
                  <select
                    id="launcher-motion"
                    value={s.interfaceMotion || "system"}
                    onChange={(event) =>
                      setS({
                        ...s,
                        interfaceMotion: event.target.value as
                          "system" | "full" | "reduced",
                      })
                    }
                  >
                    <option value="system">跟随系统偏好</option>
                    <option value="full">
                      标准动效 · 页面、菜单与操作反馈
                    </option>
                    <option value="reduced">减少动态效果</option>
                  </select>
                </div>
                <div className="motion-sample" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                  <p>轻量过渡 · 按需响应</p>
                </div>
                <p className="muted">
                  动效仅在操作时运行。系统开启减少动态效果时，启动器始终遵循该偏好。
                </p>
              </GlassSurface>
            </div>
          )}
          {section === "game" && (
            <div
              className="settings-grid settings-section"
              key="game"
              aria-label="game"
            >
              <GlassSurface className="settings-panel full-span">
                <h3>
                  <Settings size={19} />
                  启动偏好
                </h3>{" "}
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
                <div className="setting-row">
                  <div>
                    <strong>游戏启动后最小化</strong>
                    <p>让工作台退到后台，专注正在发生的冒险。</p>
                  </div>
                  <button
                    className={`toggle ${s.closeOnLaunch ? "on" : ""}`}
                    aria-label="游戏启动后最小化"
                    onClick={() =>
                      setS({ ...s, closeOnLaunch: !s.closeOnLaunch })
                    }
                  >
                    <span />
                  </button>
                </div>
              </GlassSurface>
              <GeneralGameSettings
                value={s.gameDefaults}
                onChange={(gameDefaults) => setS({ ...s, gameDefaults })}
              />
            </div>
          )}
          {section === "runtime" && (
            <div
              className="settings-grid settings-section"
              key="runtime"
              aria-label="runtime"
            >
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
            </div>
          )}
          {section === "network" && (
            <div
              className="settings-grid settings-section"
              key="network"
              aria-label="network"
            >
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
                        downloadSource: event.target.value as
                          "official" | "bmclapi",
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
                      setS({
                        ...s,
                        downloadConcurrency: Number(e.target.value),
                      })
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
            </div>
          )}
          {section === "directories" && (
            <div
              className="settings-grid settings-section"
              key="directories"
              aria-label="directories"
            >
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
                      onClick={() =>
                        void directoryAction("game-directory:scan")
                      }
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
                  可选择任意位置的 .minecraft
                  或其他游戏文件夹。切换后，版本、Mod 和游戏设置随目录切换。
                </p>
                {state.system.gameDirectoryError && (
                  <div className="notice directory-error" role="alert">
                    <AlertTriangle size={17} />
                    {state.system.gameDirectoryError}
                  </div>
                )}
                {!!state.system.gameDirectoryWarnings?.length && (
                  <details
                    className="directory-notice"
                    key={state.selectedGameDirectoryId}
                  >
                    <summary>
                      <Info size={17} aria-hidden="true" />
                      <span>
                        旧实例兼容提示 ·{" "}
                        {state.system.gameDirectoryWarnings.length} 项
                      </span>
                      <span className="directory-notice-toggle">
                        查看详情 <ChevronRight size={15} aria-hidden="true" />
                      </span>
                    </summary>
                    <div className="directory-notice-content">
                      <p>
                        以下实例还需要确认版本或目录信息。原有文件已保留，请完成确认后再使用这些实例。
                      </p>
                      <ul>
                        {state.system.gameDirectoryWarnings.map(
                          (warning, index) => (
                            <li key={index}>{warning}</li>
                          ),
                        )}
                      </ul>
                    </div>
                  </details>
                )}
                <div className="directory-list">
                  {state.gameDirectories.map((directory) => {
                    const selected =
                      directory.id === state.selectedGameDirectoryId;
                    return (
                      <div
                        className={`game-directory-row ${selected ? "selected" : ""}`}
                        key={directory.id}
                        data-game-directory-id={directory.id}
                      >
                        <span
                          className={`quick-icon ${selected ? "mint" : ""}`}
                        >
                          <FolderOpen size={20} />
                        </span>
                        <div className="directory-details">
                          <div className="directory-label">
                            <strong>{directory.name}</strong>
                            {selected && (
                              <span className="badge">当前使用</span>
                            )}
                            {directory.available === false && (
                              <span className="badge">目录不可用</span>
                            )}
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
                          {directory.available === false && (
                            <p className="directory-error" role="status">
                              {directory.unavailableReason}
                            </p>
                          )}
                        </div>
                        <div className="directory-actions">
                          <button
                            className="btn subtle"
                            disabled={
                              directoryBusy ||
                              busy ||
                              directory.available === false
                            }
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
                              disabled={
                                directoryBusy ||
                                busy ||
                                directory.available === false
                              }
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
                                void directoryAction(
                                  "game-directory:relocate",
                                  {
                                    id: directory.id,
                                  },
                                )
                              }
                            >
                              <FolderOpen size={15} />
                              重新定位
                            </button>
                          )}
                          {directory.isDefault &&
                            directory.available === false && (
                              <button
                                className="btn subtle"
                                disabled={directoryBusy || busy}
                                onClick={() =>
                                  void directoryAction(
                                    "game-directory:create-default",
                                  )
                                }
                              >
                                <Plus size={15} />
                                创建默认目录
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
            </div>
          )}
          {section === "storage" && (
            <div
              className="settings-grid settings-section"
              key="storage"
              aria-label="storage"
            >
              <GlassSurface className="settings-panel full-span">
                <h3>
                  <Settings size={19} />
                  数据与存储
                </h3>
                <StoreStats call={call} />
                <div className="setting-row">
                  <div>
                    <strong>账号与启动器配置目录</strong>
                    <p className="break-word">
                      {state.system.dataDir || "桌面版启动后显示"}
                    </p>
                  </div>
                  <button
                    className="btn subtle"
                    onClick={() => void call("folder")}
                  >
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
            </div>
          )}
          {section === "updates" && (
            <div
              className="settings-grid settings-section"
              key="updates"
              aria-label="updates"
            >
              <LauncherUpdates
                state={launcherUpdate}
                call={call}
                notify={notify}
              />
            </div>
          )}
        </div>
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
