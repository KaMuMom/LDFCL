import {
  useEffect,
  useRef,
  type ComponentPropsWithoutRef,
  type ElementType,
  type CSSProperties,
} from "react";
import LiquidGlass from "liquid-glass-react";

const stationary = { x: 0, y: 0 };

/** Keep the upstream refraction behind semantic, selectable application content. */
export function GlassBackdrop({ radius = 24 }: { radius?: number }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const surface = element.parentElement;
    // Scrollable dialogs keep the material over their viewport while content moves.
    const followViewport = () => {
      element.style.transform = `translateY(${surface?.scrollTop || 0}px)`;
    };
    surface?.addEventListener("scroll", followViewport, { passive: true });
    followViewport();
    let frame = 0;
    let previous = "";
    const observer = new ResizeObserver(([entry]) => {
      const size = `${Math.round(entry.contentRect.width)}:${Math.round(entry.contentRect.height)}`;
      if (size === previous) return;
      previous = size;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() =>
        window.dispatchEvent(new Event("resize")),
      );
    });
    observer.observe(element);
    return () => {
      surface?.removeEventListener("scroll", followViewport);
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);
  return (
    <div ref={host} className="glass-backdrop" aria-hidden="true" inert>
      <LiquidGlass
        className="liquid-renderer"
        displacementScale={36}
        blurAmount={0.12}
        saturation={135}
        aberrationIntensity={1.4}
        elasticity={0}
        cornerRadius={radius}
        padding="0"
        mode="standard"
        globalMousePos={stationary}
        mouseOffset={stationary}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
        }}
      >
        <span className="liquid-fill" />
      </LiquidGlass>
    </div>
  );
}

type SurfaceProps<T extends ElementType> = {
  as?: T;
  radius?: number;
  className?: string;
} & Omit<ComponentPropsWithoutRef<T>, "as" | "radius" | "className">;

export function GlassSurface<T extends ElementType = "section">({
  as,
  radius = 24,
  className = "",
  children,
  style,
  ...props
}: SurfaceProps<T>) {
  const Component: ElementType = as || "section";
  return (
    <Component
      {...props}
      className={`glass-surface ${className}`}
      style={{ "--surface-radius": `${radius}px`, ...style } as CSSProperties}
    >
      <GlassBackdrop radius={radius} />
      {children}
    </Component>
  );
}
