import { useId, type CSSProperties, type ReactNode } from "react";

export interface TabOption<T extends string> {
  id: T;
  label: string;
  icon?: ReactNode;
  count?: number;
}

/** One tab stop, arrow/Home/End navigation, and a compositor-only active pill. */
export default function Tabs<T extends string>({
  value,
  onChange,
  items,
  label,
  className = "",
  controls,
}: {
  value: T;
  onChange: (value: T) => void;
  items: readonly TabOption<T>[];
  label: string;
  className?: string;
  controls?: string;
}) {
  const id = useId();
  const selected = Math.max(
    0,
    items.findIndex((item) => item.id === value),
  );
  return (
    <div
      className={`ui-tabs ${className}`}
      role="tablist"
      aria-label={label}
      style={
        {
          "--tab-count": items.length,
          "--tab-index": selected,
        } as CSSProperties
      }
      onKeyDown={(event) => {
        const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
        if (!keys.includes(event.key)) return;
        event.preventDefault();
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : (selected +
                  (event.key === "ArrowRight" ? 1 : -1) +
                  items.length) %
                items.length;
        onChange(items[next].id);
        event.currentTarget
          .querySelectorAll<HTMLButtonElement>('[role="tab"]')
          [next]?.focus();
      }}
    >
      <span className="ui-tab-indicator" aria-hidden="true" />
      {items.map((item) => (
        <button
          key={item.id}
          id={`${id}-${item.id}`}
          role="tab"
          aria-selected={value === item.id}
          aria-controls={controls}
          tabIndex={value === item.id ? 0 : -1}
          className={`ui-tab ${value === item.id ? "selected active" : ""}`}
          onClick={() => onChange(item.id)}
        >
          {item.icon}
          <span>{item.label}</span>
          {item.count !== undefined && <b>{item.count}</b>}
        </button>
      ))}
    </div>
  );
}
