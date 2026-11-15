import { Info, LoaderCircle, X } from "lucide-react";
import { lazy, memo, Suspense, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { LauncherAPI } from "@ldfcl/contracts/types";
import AppFrame from "./app/AppFrame";
import type { Destination, SettingsSection } from "./app/navigation";
import LauncherUpdates from "./components/LauncherUpdates";
import useLauncher from "./hooks/useLauncher";
import PageTitle from "./ui/PageTitle";

const Home = lazy(() => import("./pages/Home"));
const Accounts = lazy(() => import("./pages/Accounts"));
const Downloads = lazy(() => import("./pages/Downloads"));
const Settings = lazy(() => import("./pages/Settings"));
const AccountDialog = lazy(() => import("./components/AccountDialog"));
const VersionPicker = lazy(() => import("./components/VersionPicker"));
const CommandMenu = lazy(() => import("./components/CommandMenu"));
const Wardrobe = lazy(() => import("./components/Wardrobe"));
const Instances = lazy(() => import("./components/Instances"));
const Diagnostics = lazy(() => import("./components/Diagnostics"));
const About = lazy(() => import("./components/About"));
const Resources = lazy(() =>
  import("./components/ResourceDownloads").then((m) => ({
    default: memo(m.default),
  })),
);
declare global {
  interface Window {
    launcher?: LauncherAPI;
  }
}

const Loading = () => (
  <div className="route-loading" role="status">
    <LoaderCircle className="spin" size={20} />
    正在打开…
  </div>
);

export default function App() {
  const c = useLauncher();
  const { state, page, setPage, instance, account, call, notify, refresh } = c;
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("appearance");
  const [settingsVisited, setSettingsVisited] = useState(false);
  const [commands, setCommands] = useState(false);
  useEffect(() => {
    if (page === "settings") setSettingsVisited(true);
  }, [page]);
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      // Do not open another global surface over an in-progress dialog.
      if (document.querySelector("dialog[open]") && e.key.toLowerCase() !== "k")
        return;
      if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (!document.querySelector("dialog[open]") || commands)
          setCommands((v) => !v);
      }
      if (e.key === ",") {
        e.preventDefault();
        setPage("settings");
      }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [commands, setPage]);
  const navigate = (destination: Destination) => {
    if (destination.settingsSection)
      setSettingsSection(destination.settingsSection);
    if (destination.instanceTab) c.setInstancePageTab(destination.instanceTab);
    if (destination.resource) c.setResourceKind(destination.resource);
    setPage(destination.page);
    setCommands(false);
  };
  return (
    <>
      <AppFrame
        page={page}
        navigate={setPage}
        account={account}
        workspace={
          state.gameDirectories.find(
            (d) => d.id === state.selectedGameDirectoryId,
          )?.name || "默认游戏目录"
        }
        openDirectories={() =>
          navigate({ page: "settings", settingsSection: "directories" })
        }
        activeDownloads={c.activeTasks.length}
        search={() => setCommands(true)}
        version={state.system.version}
      >
        {(c.resourcesVisited || page === "discover") && (
          <div className="route-view" hidden={page !== "discover"}>
            <Suspense fallback={<Loading />}>
              <Resources
                key={state.selectedGameDirectoryId}
                active={page === "discover"}
                instances={state.instances}
                kind={c.resourceKind}
                setKind={c.setResourceKind}
                instance={instance}
                call={call}
                notify={notify}
                onInstalled={refresh}
                showTasks={c.showTasks}
              />
            </Suspense>
          </div>
        )}
        {(settingsVisited || page === "settings") && (
          <div className="route-view" hidden={page !== "settings"}>
            <Suspense fallback={<Loading />}>
              <Settings
                state={state}
                call={call}
                refresh={refresh}
                notify={notify}
                launcherUpdate={c.launcherUpdate}
                section={settingsSection}
                onSectionChange={setSettingsSection}
              />
            </Suspense>
          </div>
        )}
        {!["discover", "settings"].includes(page) && (
          <div className="route-view" key={page}>
            <Suspense fallback={<Loading />}>
              {page === "home" && <Home controller={c} />}
              {page === "accounts" && <Accounts controller={c} />}
              {page === "downloads" && <Downloads controller={c} />}
              {page === "instances" && (
                <Instances
                  key={state.selectedGameDirectoryId}
                  initialTab={c.instancePageTab}
                  gameRoot={state.system.gameRoot}
                  gameDefaults={state.settings.gameDefaults}
                  instances={state.instances}
                  instance={instance}
                  call={call}
                  notify={notify}
                  refresh={refresh}
                  select={c.select}
                  install={c.openGameDownloads}
                  launch={c.launch}
                  busy={c.busy}
                />
              )}
              {page === "wardrobe" && (
                <>
                  <PageTitle
                    eyebrow="YOUR OWN IDENTITY"
                    title="皮肤与披风"
                    subtitle="从一套新皮肤，开始下一段冒险。"
                  />
                  <Wardrobe
                    accounts={state.accounts}
                    selectedAccountId={account?.id}
                    call={call}
                    notify={notify}
                  />
                </>
              )}
              {page === "logs" && (
                <Diagnostics
                  call={call}
                  instanceId={instance?.id}
                  instances={state.instances}
                  logs={c.logs}
                />
              )}
              {page === "about" && (
                <About
                  version={state.system.version}
                  call={call}
                  notify={notify}
                />
              )}
            </Suspense>
          </div>
        )}
      </AppFrame>
      <LauncherUpdates
        state={c.launcherUpdate}
        call={call}
        notify={notify}
        compact
        suppressPopup={page === "settings" && settingsSection === "updates"}
      />
      {c.toast &&
        createPortal(
          <div role="status" className="toast">
            <Info size={18} />
            <span>{c.toast}</span>
            <button
              className="icon-button"
              aria-label="关闭提示"
              onClick={() => c.setToast("")}
            >
              <X size={16} />
            </button>
          </div>,
          document.body,
        )}
      <Suspense fallback={null}>
        {commands && (
          <CommandMenu close={() => setCommands(false)} navigate={navigate} />
        )}
        {c.modal === "versions" && <VersionPicker controller={c} />}
        {c.modal === "account" && (
          <AccountDialog
            state={state}
            call={call}
            auth={c.auth}
            refresh={refresh}
            notify={notify}
            close={() => c.setModal(null)}
          />
        )}
      </Suspense>
    </>
  );
}
