import { useEffect, useRef, useState } from "react";

function NetworkStateMark({ state }) {
  if (!state) return null;
  if (state === "asleep") {
    return (
      <span
        className="network-state network-state--asleep"
        title="Asleep"
        aria-label="Asleep"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M16.4 14.2A7.2 7.2 0 0 1 9.8 7.6a7 7 0 0 1 .3-2A7.4 7.4 0 1 0 16.4 14.2Z"
          />
        </svg>
      </span>
    );
  }
  return (
    <span
      className={`network-state network-state--${state}`}
      title={state}
      aria-label={state}
    />
  );
}

export default function ResourceDropdown({
  label,
  items = [],
  value,
  onSelect,
  onCreate,
  onDelete,
  disabled = false,
  compact = false,
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const selected = items.find((item) => item.id === value) || null;

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div
      className={`resource-dropdown${compact ? " resource-dropdown--compact" : ""}`}
      ref={rootRef}
    >
      <button
        type="button"
        className="resource-dropdown-trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <NetworkStateMark state={selected?.state} />
        <span className="resource-dropdown-value">
          {selected?.label || selected?.id || `Select ${label.toLowerCase()}`}
        </span>
        <span className="resource-dropdown-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open ? (
        <div className="resource-dropdown-menu" role="menu" aria-label={label}>
          <div className="resource-dropdown-items">
            {items.length ? (
              items.map((item) => (
                <div
                  className={`resource-dropdown-row${item.id === value ? " active" : ""}`}
                  key={item.id}
                >
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={item.id === value}
                    className="resource-dropdown-select"
                    onClick={() => {
                      onSelect?.(item.id);
                      setOpen(false);
                    }}
                  >
                    <NetworkStateMark state={item.state} />
                    <span>
                      <strong>{item.label || item.id}</strong>
                      {item.meta ? <small>{item.meta}</small> : null}
                    </span>
                  </button>
                  {onDelete && item.deletable !== false ? (
                    <button
                      type="button"
                      className="resource-dropdown-delete"
                      aria-label={`Delete ${item.label || item.id}`}
                      title={
                        item.state === "asleep"
                          ? `Remove ${item.label || item.id}`
                          : `Sleep ${item.label || item.id} before removing`
                      }
                      onClick={() => {
                        setOpen(false);
                        onDelete(item.id);
                      }}
                    >
                      ×
                    </button>
                  ) : null}
                </div>
              ))
            ) : (
              <div className="resource-dropdown-empty">No resources</div>
            )}
          </div>
          {onCreate ? (
            <button
              type="button"
              className="resource-dropdown-create"
              onClick={() => {
                setOpen(false);
                onCreate();
              }}
            >
              + Create {label.toLowerCase()}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
