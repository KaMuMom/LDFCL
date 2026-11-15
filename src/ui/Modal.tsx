import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Native dialog owns focus, Escape and inert background, including nested dialogs. */
export default function Modal({
  title,
  subtitle,
  close,
  children,
  wide = false,
  className = "",
  closeLabel = "关闭弹窗",
}: {
  title: string;
  subtitle?: string;
  close: () => void;
  children: ReactNode;
  wide?: boolean;
  className?: string;
  closeLabel?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current!;
    if (!element.open) element.showModal();
    return () => {
      element.close();
      if (previous?.isConnected && previous.getClientRects().length)
        previous.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      className={`modal ${wide ? "wide" : ""} ${className}`}
      onCancel={(event) => {
        event.preventDefault();
        closeRef.current();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          closeRef.current();
      }}
    >
      <div className="modal-heading">
        <div>
          <h2 id={titleId}>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button className="icon-button" onClick={close} aria-label={closeLabel}>
          <X size={19} />
        </button>
      </div>
      {children}
    </dialog>,
    document.body,
  );
}
