import { ArrowUpRight, Trash2 } from "lucide-react";
import { useState } from "react";
import DownloadTasks from "../components/DownloadTasks";
import type useLauncher from "../hooks/useLauncher";
import PageTitle from "../ui/PageTitle";
import Tabs from "../ui/Tabs";
const filters = [
  { id: "all", label: "全部" },
  { id: "active", label: "进行中" },
  { id: "completed", label: "已完成" },
  { id: "error", label: "需处理" },
] as const;
export default function Downloads({
  controller: c,
}: {
  controller: ReturnType<typeof useLauncher>;
}) {
  const [filter, setFilter] = useState<(typeof filters)[number]["id"]>("all");
  const matches = (status: string, f = filter) =>
    f === "all" ||
    (f === "active"
      ? ["running", "downloading", "paused", "queued"].includes(status)
      : f === "completed"
        ? status === "completed"
        : ["failed", "error", "cancelled"].includes(status));
  const ids = new Set(
    c.rootTasks.filter((t) => matches(t.status)).map((t) => t.id),
  );
  const visible = c.list.filter(
    (t) =>
      ids.has(t.id) || (!!t.download?.planId && ids.has(t.download.planId)),
  );
  const clear = () =>
    c.setTasks((old) => {
      const completed = new Set(
        c.rootTasks.filter((t) => t.status === "completed").map((t) => t.id),
      );
      return Object.fromEntries(
        Object.entries(old).filter(
          ([id, t]) =>
            !completed.has(id) &&
            !(t.download?.planId && completed.has(t.download.planId)),
        ),
      );
    });
  return (
    <>
      <PageTitle
        eyebrow="DOWNLOAD CENTER"
        title="下载任务"
        subtitle={`${c.state.settings.downloadConcurrency} 线程并发 · 自动重试与完整性校验`}
      >
        <button className="btn subtle" onClick={() => c.setPage("discover")}>
          发现资源
          <ArrowUpRight size={16} />
        </button>
        <button
          className="btn"
          disabled={!c.rootTasks.some((t) => t.status === "completed")}
          onClick={clear}
        >
          <Trash2 size={15} />
          清除已完成
        </button>
      </PageTitle>
      <Tabs
        label="下载状态"
        value={filter}
        onChange={setFilter}
        items={filters.map((f) => ({
          ...f,
          count: c.rootTasks.filter((t) => matches(t.status, f.id)).length,
        }))}
      />
      <DownloadTasks
        tasks={visible}
        call={c.call}
        notify={c.notify}
        source={c.state.settings.downloadSource}
      />
    </>
  );
}
