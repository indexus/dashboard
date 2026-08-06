import { useEffect, useRef } from "react";

/** Lat/lng/id fields for addGeoItem — used inside AddItemModal. */
export default function AddItemForm({
  lat,
  lng,
  id,
  onLat,
  onLng,
  onId,
  onAdd,
  busy,
  compact = false,
}) {
  return (
    <div className={compact ? "add-item-fields" : "panel"}>
      {!compact && (
        <div className="section-head" style={{ margin: 0 }}>
          <h2>add item</h2>
          <span className="hint">click map or edit coords</span>
        </div>
      )}
      <div className={`row${compact ? "" : ""}`} style={compact ? undefined : { marginTop: "0.65rem" }}>
        <label className="field">
          lat
          <input
            type="number"
            step="0.0001"
            value={lat}
            onChange={(e) => onLat(parseFloat(e.target.value))}
          />
        </label>
        <label className="field">
          lng
          <input
            type="number"
            step="0.0001"
            value={lng}
            onChange={(e) => onLng(parseFloat(e.target.value))}
          />
        </label>
        <label className="field">
          id
          <input
            value={id}
            onChange={(e) => onId(e.target.value)}
            placeholder="auto"
            style={{ minWidth: "8rem" }}
          />
        </label>
        {!compact && (
          <button type="button" className="primary" disabled={busy} onClick={onAdd}>
            Add
          </button>
        )}
      </div>
    </div>
  );
}

/** Overlay modal to add a geo item. Escape / backdrop / Cancel close. */
export function AddItemModal({
  open,
  onClose,
  lat,
  lng,
  id,
  onLat,
  onLng,
  onId,
  onAdd,
  busy,
}) {
  const dialogRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    const t = setTimeout(() => {
      dialogRef.current?.querySelector("input")?.focus();
    }, 0);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(t);
    };
  }, [open, onClose]);

  if (!open) return null;

  async function handleAdd() {
    await onAdd?.();
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div
        className="modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-item-title"
        ref={dialogRef}
      >
        <div className="modal-head">
          <h2 id="add-item-title">Add item</h2>
          <button
            type="button"
            className="ghost compact modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <p className="modal-hint">Click the map to set origin, or edit coordinates.</p>
        <AddItemForm
          compact
          lat={lat}
          lng={lng}
          id={id}
          onLat={onLat}
          onLng={onLng}
          onId={onId}
          onAdd={handleAdd}
          busy={busy}
        />
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" disabled={busy} onClick={handleAdd}>
            {busy ? "Adding…" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}
