import type { SkinViewer } from "skinview3d";

const FRAME_INTERVAL = 1000 / 60;

export interface SkinPreviewRenderer {
  invalidate(): void;
  setRotating(value: boolean): void;
  dispose(): void;
}

/** A visible, idle preview needs one frame, not an always-running WebGL loop. */
export function manageSkinPreview(
  viewer: SkinViewer,
  element: HTMLElement,
): SkinPreviewRenderer {
  viewer.renderPaused = true;
  let disposed = false;
  let frame = 0;
  let dirty = true;
  let visible = true;
  let interacting = false;
  let focused = document.hasFocus();
  let lastFrame = 0;
  let lastAnimation = 0;
  let pendingSize: { width: number; height: number } | undefined;
  let quality = false;
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const canDraw = () =>
    !disposed &&
    !viewer.disposed &&
    visible &&
    !document.hidden &&
    !viewer.renderer.getContext().isContextLost();
  const animating = () =>
    focused &&
    !motion.matches &&
    (viewer.autoRotate || (quality && viewer.animation !== null));
  const schedule = () => {
    if (!frame && canDraw() && (dirty || animating()))
      frame = requestAnimationFrame(draw);
  };
  const invalidate = () => {
    dirty = true;
    schedule();
  };
  const shrinkUnusedComposer = () => {
    if (!quality) {
      // Efficient rendering skips both offscreen passes and their full-size targets.
      viewer.composer.setPixelRatio(1);
      viewer.composer.setSize(1, 1);
    }
  };
  const updateQuality = () => {
    quality = document.documentElement.dataset.performance === "quality";
    const ratio = Math.min(window.devicePixelRatio || 1, quality ? 1.5 : 1);
    if (viewer.pixelRatio !== ratio) viewer.pixelRatio = ratio;
    // Returning to quality restores targets previously reduced by efficient mode.
    if (quality) viewer.setSize(viewer.width, viewer.height);
    else shrinkUnusedComposer();
    invalidate();
  };
  function draw(time: number) {
    frame = 0;
    if (!canDraw()) return;
    const continuous = animating();
    if (!dirty && !continuous) return;
    // Keep interaction invalidations at the display's next frame. Only cap
    // decorative animation on high-refresh displays; never cap the application UI.
    if (!dirty && continuous && time - lastFrame < FRAME_INTERVAL - 0.5) {
      schedule();
      return;
    }
    if (pendingSize) {
      const { width, height } = pendingSize;
      pendingSize = undefined;
      if (viewer.width !== width || viewer.height !== height) {
        viewer.setSize(width, height);
        shrinkUnusedComposer();
      }
    }
    const delta = lastAnimation
      ? Math.min((time - lastAnimation) / 1000, 0.05)
      : 0;
    lastAnimation = continuous ? time : 0;
    if (continuous) {
      viewer.animation?.update(viewer.playerObject, delta);
      if (viewer.autoRotate && !interacting)
        viewer.playerWrapper.rotation.y += delta * viewer.autoRotateSpeed;
    }
    viewer.controls.update();
    if (quality) viewer.render();
    else {
      viewer.renderer.setRenderTarget(null);
      viewer.renderer.render(viewer.scene, viewer.camera);
    }
    dirty = false;
    lastFrame = time - ((time - lastFrame) % FRAME_INTERVAL);
    schedule();
  }
  const updateVisibility = () => {
    if (!canDraw()) {
      cancelAnimationFrame(frame);
      frame = 0;
      lastAnimation = 0;
    } else invalidate();
  };
  const focus = () => {
    focused = true;
    invalidate();
  };
  const blur = () => {
    focused = false;
    lastAnimation = 0;
    invalidate();
  };
  const start = () => {
    interacting = true;
    invalidate();
  };
  const end = () => {
    interacting = false;
    invalidate();
  };
  const resize = new ResizeObserver(([entry]) => {
    const { width, height } = entry.contentRect;
    if (width > 0 && height > 0) {
      pendingSize = { width: Math.round(width), height: Math.round(height) };
      invalidate();
    }
  });
  const intersection = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    updateVisibility();
  });
  const attributes = new MutationObserver(updateQuality);
  attributes.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-performance"],
  });
  resize.observe(element);
  intersection.observe(element);
  viewer.controls.addEventListener("change", invalidate);
  viewer.controls.addEventListener("start", start);
  viewer.controls.addEventListener("end", end);
  viewer.canvas.addEventListener("webglcontextlost", updateVisibility);
  viewer.canvas.addEventListener("webglcontextrestored", updateVisibility);
  document.addEventListener("visibilitychange", updateVisibility);
  window.addEventListener("focus", focus);
  window.addEventListener("blur", blur);
  motion.addEventListener("change", invalidate);
  updateQuality();

  return {
    invalidate,
    setRotating(value) {
      viewer.autoRotate = value;
      lastAnimation = 0;
      invalidate();
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      resize.disconnect();
      intersection.disconnect();
      attributes.disconnect();
      viewer.controls.removeEventListener("change", invalidate);
      viewer.controls.removeEventListener("start", start);
      viewer.controls.removeEventListener("end", end);
      viewer.canvas.removeEventListener("webglcontextlost", updateVisibility);
      viewer.canvas.removeEventListener(
        "webglcontextrestored",
        updateVisibility,
      );
      document.removeEventListener("visibilitychange", updateVisibility);
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", blur);
      motion.removeEventListener("change", invalidate);
      // SkinViewer.dispose() releases textures and the renderer, but upstream
      // leaves the composer's WebGL render targets and FXAA material allocated.
      viewer.composer.dispose();
      viewer.fxaaPass.material.dispose();
    },
  };
}
