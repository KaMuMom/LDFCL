import {
  lazy,
  memo,
  Suspense,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentPropsWithoutRef,
  type ElementType,
  type CSSProperties,
  type RefObject,
} from "react";
import "./glass-performance.css";

// The default material needs no SVG refraction pipeline or extra JavaScript.
const LiquidGlass = lazy(() => import("liquid-glass-react"));

const stationary = { x: 0, y: 0 };
const performanceSubscribers = new Set<() => void>();
let performanceObserver: MutationObserver | undefined;

function qualityEnabled() {
  return document.documentElement.dataset.performance === "quality";
}

function subscribePerformance(listener: () => void) {
  performanceSubscribers.add(listener);
  if (!performanceObserver) {
    performanceObserver = new MutationObserver(() => {
      performanceSubscribers.forEach((notify) => notify());
    });
    performanceObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-performance"],
    });
  }
  return () => {
    performanceSubscribers.delete(listener);
    if (!performanceSubscribers.size) {
      performanceObserver?.disconnect();
      performanceObserver = undefined;
    }
  };
}

const visibleSubscribers = new Set<() => void>();
const pageVisible = () => document.visibilityState !== "hidden";
const notifyVisibility = () => visibleSubscribers.forEach((notify) => notify());

function subscribeVisibility(listener: () => void) {
  if (!visibleSubscribers.size) {
    document.addEventListener("visibilitychange", notifyVisibility);
  }
  visibleSubscribers.add(listener);
  return () => {
    visibleSubscribers.delete(listener);
    if (!visibleSubscribers.size) {
      document.removeEventListener("visibilitychange", notifyVisibility);
    }
  };
}

const intersectionSubscribers = new Map<Element, (visible: boolean) => void>();
let intersectionObserver: IntersectionObserver | undefined;

function observeVisibility(
  element: Element,
  notify: (visible: boolean) => void,
) {
  if (typeof IntersectionObserver === "undefined") {
    notify(true);
    return () => {};
  }
  intersectionObserver ??= new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      intersectionSubscribers.get(entry.target)?.(entry.isIntersecting);
    });
  });
  intersectionSubscribers.set(element, notify);
  intersectionObserver.observe(element);
  return () => {
    intersectionObserver?.unobserve(element);
    intersectionSubscribers.delete(element);
    if (!intersectionSubscribers.size) {
      intersectionObserver?.disconnect();
      intersectionObserver = undefined;
    }
  };
}

// Upstream measures every mounted panel on window.resize. Batch all local
// ResizeObserver notifications, so one changed layout does not fan out N times.
let resizeFrame = 0;
function scheduleGlassResize() {
  if (resizeFrame) return;
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = 0;
    window.dispatchEvent(new Event("resize"));
  });
}

function QualityRenderer({
  host,
  radius,
}: {
  host: RefObject<HTMLDivElement | null>;
  radius: number;
}) {
  const [intersects, setIntersects] = useState(false);
  const documentVisible = useSyncExternalStore(
    subscribeVisibility,
    pageVisible,
  );
  const active = intersects && documentVisible;

  useEffect(() => {
    const element = host.current;
    if (element) return observeVisibility(element, setIntersects);
  }, [host]);

  useEffect(() => {
    const element = host.current;
    if (!active || !element) return;
    let previous = "";
    const observer = new ResizeObserver(([entry]) => {
      const size = `${Math.round(entry.contentRect.width)}:${Math.round(entry.contentRect.height)}`;
      if (size === previous) return;
      previous = size;
      scheduleGlassResize();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [active, host]);

  if (!active) return null;
  return (
    <Suspense fallback={null}>
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
    </Suspense>
  );
}

/** Keep the upstream refraction behind semantic, selectable application content. */
export const GlassBackdrop = memo(function GlassBackdrop({
  radius = 24,
}: {
  radius?: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const quality = useSyncExternalStore(subscribePerformance, qualityEnabled);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const surface = element.parentElement;
    // Scrollable dialogs keep the material over their viewport while content moves.
    let previousScroll = -1;
    const followViewport = () => {
      const scrollTop = surface?.scrollTop || 0;
      if (scrollTop === previousScroll) return;
      previousScroll = scrollTop;
      element.style.transform = scrollTop ? `translateY(${scrollTop}px)` : "";
    };
    surface?.addEventListener("scroll", followViewport, { passive: true });
    followViewport();
    return () => {
      surface?.removeEventListener("scroll", followViewport);
    };
  }, []);
  return (
    <div
      ref={host}
      className="glass-backdrop"
      style={{ "--glass-radius": `${radius}px` } as CSSProperties}
      aria-hidden="true"
      inert
    >
      {quality && <QualityRenderer host={host} radius={radius} />}
    </div>
  );
});

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
