import {
  ChevronRight,
  FolderOpen,
  Minus,
  Search,
  Square,
  UserRound,
  X,
} from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import type { Account } from "@ldfcl/contracts/types";
import { NAVIGATION, type PageId } from "./navigation";

export default function AppFrame({
  page,
  navigate,
  account,
  workspace,
  openDirectories,
  activeDownloads,
  search,
  children,
  version,
}: {
  page: PageId;
  navigate: (page: PageId) => void;
  account?: Account;
  workspace: string;
  activeDownloads: number;
  search: () => void;
  openDirectories: () => void;
  children: ReactNode;
  version: string;
}) {
  const content = useRef<HTMLElement>(null);
  const current = NAVIGATION.find((item) => item.id === page)!;
  useEffect(() => {
    if (content.current) content.current.scrollTop = 0;
  }, [page]);
  const item = (entry: (typeof NAVIGATION)[number]) => (
    <button
      key={entry.id}
      aria-label={entry.name}
      aria-current={page === entry.id ? "page" : undefined}
      title={entry.name}
      className={`nav-item ${page === entry.id ? "active" : ""}`}
      onClick={() => navigate(entry.id)}
    >
      <entry.icon size={18} />
      <span className="nav-label">{entry.name}</span>
      {entry.id === "downloads" && activeDownloads > 0 && (
        <b className="nav-count">{activeDownloads}</b>
      )}
    </button>
  );
  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="主导航">
        <div className="brand">
          <img
            src="./icon.png"
            alt=""
            width={34}
            height={34}
            draggable={false}
          />
          <div>
            <strong>
              LDFCL<span>●</span>
            </strong>
            <small>YOUR NEXT WORLD</small>
          </div>
        </div>
        <button className="nav-search" aria-label="搜索功能" onClick={search}>
          <Search size={16} />
          <span>快速前往</span>
          <kbd>Ctrl K</kbd>
        </button>
        <nav>
          {["游戏", "资源", "个人", "工具"].map((group) => (
            <div className="nav-group" key={group}>
              <span className="nav-group-label">{group}</span>
              {NAVIGATION.filter(
                (entry) => entry.group === group && entry.id !== "about",
              ).map(item)}
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          {item(NAVIGATION[NAVIGATION.length - 1])}
          <button
            className="sidebar-profile"
            aria-label="前往账号管理"
            onClick={() => navigate("accounts")}
          >
            <span className="avatar">
              <UserRound size={18} />
            </span>
            <span>
              <strong>{account?.name || "尚未登录"}</strong>
              <small>{account ? "管理你的冒险身份" : "添加一个冒险身份"}</small>
            </span>
            <ChevronRight size={14} />
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="titlebar">
          <div className="breadcrumb">
            <span>{current.group}</span>
            <ChevronRight size={12} />
            <b>{current.name}</b>
          </div>
          <div className="title-actions">
            <button
              className="workspace-chip"
              aria-label="管理游戏目录"
              title={workspace}
              onClick={openDirectories}
            >
              <FolderOpen size={14} />
              <span>{workspace}</span>
            </button>
            <span className="app-version">v{version}</span>
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
              className="window-close"
              aria-label="关闭"
              onClick={() => window.launcher?.window("close")}
            >
              <X size={17} />
            </button>
          </div>
        </header>
        <main
          id="main-content"
          ref={content}
          className={`main-content ${page === "home" ? "home-main" : ""}`}
          tabIndex={-1}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
