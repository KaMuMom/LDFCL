import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { State, Task } from "@ldfcl/contracts/types";
import type { ResourceKind } from "../components/ResourceDownloads";
import type { PageId } from "../app/navigation";
import { LAUNCHER_VERSION } from "@ldfcl/contracts/launcher";
import { createUiEventBuffer } from "@ldfcl/contracts/ui-event-buffer";
import { useLauncherUpdates } from "../components/LauncherUpdates";
import { errorMessage } from "../ui/format";
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
    interfacePerformance: "efficient",
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

export default function useLauncher() {
  const launcherUpdate = useLauncherUpdates(window.launcher);
  const [state, setState] = useState<State>(empty),
    [page, setPage] = useState<PageId>("home"),
    [modal, setModal] = useState<null | "account" | "versions">(null),
    [instancePageTab, setInstancePageTab] = useState("overview"),
    [resourceKind, setResourceKind] = useState<ResourceKind>("minecraft"),
    [tasks, setTasks] = useState<Record<string, Task>>({}),
    [toast, setToast] = useState(""),
    [busy, setBusy] = useState(""),
    [running, setRunning] = useState<string[]>([]),
    [auth, setAuth] = useState<any>(null);
  const instance =
    state.instances.find((i) => i.id === state.selectedInstanceId) ||
    state.instances[0];
  const account =
    state.accounts.find((a) => a.id === state.selectedAccountId) ||
    state.accounts[0];
  const logsByInstance = useRef<Record<string, string[]>>({});
  const [, setLogRevision] = useState(0);
  const currentPage = useRef(page);
  currentPage.current = page;
  const [resourcesVisited, setResourcesVisited] = useState(false);
  const logs = logsByInstance.current[instance?.id || "launcher"] || [];
  const notify = useCallback((text: string) => setToast(text), []);
  const call = useCallback(
    async <T = any>(method: string, payload?: any): Promise<T> => {
      if (window.launcher) return window.launcher.call<T>(method, payload);
      if (method === "state") return empty as T;
      throw Error("请在 LDFCL 桌面版中使用此功能");
    },
    [],
  );
  const refreshRequest = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++refreshRequest.current;
    try {
      const nextState = await call<State>("state");
      if (request === refreshRequest.current) {
        setState(nextState);
        if (nextState.runningInstanceIds)
          setRunning(nextState.runningInstanceIds);
      }
    } catch (e) {
      if (request === refreshRequest.current) notify(errorMessage(e));
    }
  }, [call, notify]);
  const action = useCallback(
    async (name: string, fn: () => Promise<any>) => {
      setBusy(name);
      try {
        await fn();
      } catch (e) {
        notify(errorMessage(e));
      } finally {
        setBusy("");
      }
    },
    [notify],
  );
  useEffect(() => {
    void refresh();
    const buffer = createUiEventBuffer((batch) => {
      for (const [id, lines] of Object.entries(batch.logs))
        logsByInstance.current[id] = [
          ...(logsByInstance.current[id] || []),
          ...lines,
        ].slice(-500);
      startTransition(() => {
        if (Object.keys(batch.tasks).length)
          setTasks((old) => ({ ...old, ...batch.tasks }));
        if (currentPage.current === "logs" && Object.keys(batch.logs).length)
          setLogRevision((revision) => revision + 1);
      });
    });
    const unsubscribe = window.launcher?.onEvent((e) => {
      if (e.type === "task") {
        const t = e.task || e;
        buffer.task(t);
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
        buffer.log(
          e.instanceId || "launcher",
          String(e.line || e.message || ""),
        );
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
    return () => {
      unsubscribe?.();
      buffer.dispose();
    };
  }, [refresh, notify]);
  useEffect(() => {
    document.documentElement.dataset.performance =
      state.settings.interfacePerformance === "quality"
        ? "quality"
        : "efficient";
  }, [state.settings.interfacePerformance]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      document.documentElement.dataset.motion =
        media.matches || state.settings.interfaceMotion === "reduced"
          ? "reduced"
          : "full";
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [state.settings.interfaceMotion]);
  useEffect(() => {
    if (page === "discover") setResourcesVisited(true);
  }, [page]);
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
  const openGameDownloads = useCallback(() => {
    setResourceKind("minecraft");
    setPage("discover");
  }, []);
  const launch = useCallback(
    () =>
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
        setRunning((old) =>
          r.running === false
            ? old.filter((id) => id !== instance.id)
            : [...new Set([...old, instance.id])],
        );
        notify(
          `${r.running === false ? "Minecraft 进程已结束" : `Minecraft 已启动 · PID ${r.pid}`}${r.warnings?.length ? ` · ${r.warnings.join(" ")}` : ""}`,
        );
        void refresh();
      }),
    [instance, account, action, call, notify, refresh, openGameDownloads],
  );
  const select = useCallback(
    async (p: any) => {
      await call("select", p);
      await refresh();
    },
    [call, refresh],
  );
  const selectAccount = useCallback(
    (id: string) => select({ accountId: id }),
    [select],
  );
  const manageAccounts = useCallback(() => setPage("accounts"), []);
  const showTasks = useCallback(() => setPage("downloads"), []);
  const list = useMemo(() => Object.values(tasks), [tasks]);
  const parentTaskIds = useMemo(
    () =>
      new Set(
        list
          .filter((task) => task.download?.kind === "plan")
          .map((task) => task.id),
      ),
    [list],
  );
  const rootTasks = useMemo(
    () =>
      list.filter(
        (task) =>
          !task.download?.planId || !parentTaskIds.has(task.download.planId),
      ),
    [list, parentTaskIds],
  );
  const activeTasks = useMemo(
    () =>
      rootTasks.filter((task) =>
        ["running", "downloading", "paused", "queued"].includes(task.status),
      ),
    [rootTasks],
  );

  return {
    state,
    page,
    setPage,
    modal,
    setModal,
    instancePageTab,
    setInstancePageTab,
    resourceKind,
    setResourceKind,
    tasks,
    setTasks,
    toast,
    setToast,
    busy,
    running,
    setRunning,
    auth,
    instance,
    account,
    logs,
    notify,
    call,
    refresh,
    action,
    openGameDownloads,
    launch,
    select,
    selectAccount,
    manageAccounts,
    showTasks,
    list,
    rootTasks,
    activeTasks,
    resourcesVisited,
    launcherUpdate,
  };
}
