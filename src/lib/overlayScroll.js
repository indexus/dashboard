import { useEffect, useRef } from "react";

/**
 * Overlay scrollbar: invisible until pointer/scroll activity, then fades out
 * after a short idle (macOS-like), drawn over content without a permanent gutter.
 */
export function useOverlayScroll(deps = []) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;

    el.classList.add("scroll-fade");
    let timer = 0;

    const pulse = () => {
      el.classList.add("is-scrolling");
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        el.classList.remove("is-scrolling");
      }, 900);
    };

    const opts = { passive: true };
    el.addEventListener("scroll", pulse, opts);
    el.addEventListener("mousemove", pulse, opts);
    el.addEventListener("wheel", pulse, opts);
    el.addEventListener("touchmove", pulse, opts);
    el.addEventListener("mouseenter", pulse, opts);

    return () => {
      window.clearTimeout(timer);
      el.classList.remove("is-scrolling", "scroll-fade");
      el.removeEventListener("scroll", pulse);
      el.removeEventListener("mousemove", pulse);
      el.removeEventListener("wheel", pulse);
      el.removeEventListener("touchmove", pulse);
      el.removeEventListener("mouseenter", pulse);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return ref;
}
