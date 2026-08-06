import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Hover tooltip that portals to document.body so it isn't clipped by
 * overflow:auto panels. Prefer this over native title= attributes.
 */
export default function Tip({
  tip,
  children,
  as: Tag = "div",
  className = "",
  delay = 120,
  ...rest
}) {
  const id = useId();
  const anchorRef = useRef(null);
  const timerRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0, place: "above" });

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const place = useCallback(() => {
    const el = anchorRef.current;
    if (!el || !tip) return;
    const r = el.getBoundingClientRect();
    const gap = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const preferAbove = r.top > vh * 0.35;
    const top = preferAbove ? r.top - gap : r.bottom + gap;
    let left = r.left + r.width / 2;
    left = Math.max(12, Math.min(vw - 12, left));
    setCoords({
      top,
      left,
      place: preferAbove ? "above" : "below",
    });
  }, [tip]);

  const show = () => {
    if (!tip) return;
    clearTimer();
    timerRef.current = setTimeout(() => {
      place();
      setOpen(true);
    }, delay);
  };

  const hide = () => {
    clearTimer();
    setOpen(false);
  };

  useEffect(() => () => clearTimer(), []);

  useEffect(() => {
    if (!open) return undefined;
    const onMove = () => place();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open, place]);

  if (!tip) {
    return (
      <Tag className={className} {...rest}>
        {children}
      </Tag>
    );
  }

  return (
    <>
      <Tag
        ref={anchorRef}
        className={`tip-anchor${className ? ` ${className}` : ""}`}
        aria-describedby={open ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        {...rest}
      >
        {children}
      </Tag>
      {open
        ? createPortal(
            <div
              id={id}
              role="tooltip"
              className={`ui-tip ui-tip--${coords.place}`}
              style={{ top: coords.top, left: coords.left }}
            >
              {tip}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
