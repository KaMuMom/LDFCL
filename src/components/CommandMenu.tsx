import { ArrowUpRight, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { QUICK_DESTINATIONS, type Destination } from "../app/navigation";
import Modal from "../ui/Modal";

export default function CommandMenu({
  close,
  navigate,
}: {
  close: () => void;
  navigate: (to: Destination) => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const results = useMemo(
    () =>
      QUICK_DESTINATIONS.filter((item) =>
        `${item.title} ${item.detail} ${item.keywords || ""}`
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase()),
      ),
    [query],
  );
  const go = (destination: Destination) => {
    close();
    navigate(destination);
  };
  const activeIndex = Math.min(index, Math.max(0, results.length - 1));
  return (
    <Modal
      title="快速前往"
      subtitle="搜索功能、设置或管理工具"
      close={close}
      className="command-menu"
    >
      <label className="command-search">
        <Search size={18} />
        <input
          autoFocus
          type="search"
          role="combobox"
          aria-expanded="true"
          aria-controls="command-results"
          aria-activedescendant={
            results.length ? `command-${activeIndex}` : undefined
          }
          aria-label="搜索功能名称"
          placeholder="试试「Mod」「内存」或「快照」"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setIndex(0);
          }}
          onKeyDown={(event) => {
            if (["ArrowDown", "ArrowUp"].includes(event.key)) {
              event.preventDefault();
              const next =
                (activeIndex +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  results.length) %
                (results.length || 1);
              setIndex(next);
              document
                .getElementById(`command-${next}`)
                ?.scrollIntoView({ block: "nearest" });
            }
            if (event.key === "Enter" && results[activeIndex]) {
              event.preventDefault();
              go(results[activeIndex].destination);
            }
          }}
        />
        <kbd>Esc</kbd>
      </label>
      <div
        id="command-results"
        role="listbox"
        aria-label="功能搜索结果"
        className="command-results"
      >
        {results.map((item, i) => (
          <button
            key={item.title}
            id={`command-${i}`}
            role="option"
            aria-selected={i === activeIndex}
            tabIndex={-1}
            onClick={() => go(item.destination)}
            onMouseEnter={() => setIndex(i)}
          >
            <span>
              <strong>{item.title}</strong>
              <small>{item.detail}</small>
            </span>
            <ArrowUpRight size={16} />
          </button>
        ))}
        {!results.length && (
          <p className="empty-message">没有找到相关功能，试试更短的关键词。</p>
        )}
      </div>
      <p className="command-hint">↑ ↓ 选择 · Enter 打开 · Esc 关闭</p>
    </Modal>
  );
}
