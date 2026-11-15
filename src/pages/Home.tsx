import {
  Box,
  ChevronRight,
  Layers,
  LoaderCircle,
  Package,
  Pause,
  Play,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import HealthPanel from "../components/HealthPanel";
import HomeSkinPreview from "../components/HomeSkinPreview";
import type useLauncher from "../hooks/useLauncher";
import { GlassSurface } from "../ui/Glass";
import { loaderName } from "../ui/format";
export default function HomePage({
  controller,
}: {
  controller: ReturnType<typeof useLauncher>;
}) {
  const {
    state,
    instance,
    account,
    selectAccount,
    call,
    notify,
    manageAccounts,
    setModal,
    setInstancePageTab,
    setPage,
    busy,
    running,
    setRunning,
    action,
    launch,
  } = controller;
  return (
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
          onSelect={selectAccount}
          onManage={manageAccounts}
        />
        <div className="home-game-area">
          <GlassSurface className="home-version-card" aria-label="当前游戏版本">
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
                  {instance ? loaderName(instance.loader) : "从第一个版本开始"}
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
              <button className="btn" onClick={() => setModal("versions")}>
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
                    : String(state.settings.memoryMb / 1024) + " GB 内存"}{" "}
                  ·{" "}
                  {instance?.javaPath || state.settings.javaPath
                    ? "指定 Java"
                    : "自动匹配 Java"}
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
  );
}
