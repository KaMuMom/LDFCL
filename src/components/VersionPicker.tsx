import { Box, CheckCircle2, Plus, Search } from "lucide-react";
import { useState } from "react";
import type useLauncher from "../hooks/useLauncher";
import Modal from "../ui/Modal";
import { loaderName } from "../ui/format";
export default function VersionPicker({
  controller: c,
}: {
  controller: ReturnType<typeof useLauncher>;
}) {
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(40);
  const filtered = c.state.instances.filter((i) =>
    `${i.name} ${i.version} ${i.loader}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <Modal
      title="切换游戏版本"
      subtitle="每个实例都有独立的存档、Mod 和游戏设置。"
      close={() => c.setModal(null)}
    >
      <div className="search-field">
        <Search size={16} />
        <input
          autoFocus
          aria-label="搜索已安装版本"
          placeholder="搜索名称或版本号"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setLimit(40);
          }}
        />
      </div>
      <div className="home-instance-picker">
        {filtered.slice(0, limit).map((i) => (
          <button
            key={i.id}
            className={i.id === c.instance?.id ? "selected" : ""}
            disabled={!!c.busy}
            onClick={() =>
              void c.action("select", async () => {
                await c.select({ instanceId: i.id });
                c.setModal(null);
              })
            }
          >
            <span className="instance-icon">
              <Box size={23} />
            </span>
            <span>
              <strong>{i.name}</strong>
              <small>
                Minecraft {i.version} · {loaderName(i.loader)}
              </small>
            </span>
            {i.id === c.instance?.id && <CheckCircle2 size={18} />}
          </button>
        ))}
        {!filtered.length && (
          <p className="muted">
            {search
              ? "没有匹配的版本，试试其他名称。"
              : "还没有安装游戏，先下载一个版本吧。"}
          </p>
        )}
        {filtered.length > limit && (
          <button className="btn full" onClick={() => setLimit((v) => v + 40)}>
            加载更多（剩余 {filtered.length - limit}）
          </button>
        )}
      </div>
      <button
        className="btn primary full"
        onClick={() => {
          c.setModal(null);
          c.openGameDownloads();
        }}
      >
        <Plus size={16} />
        下载新版本
      </button>
    </Modal>
  );
}
