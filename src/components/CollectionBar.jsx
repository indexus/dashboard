import { COLLECTION_PRESETS, VIEW_MODES } from "../lib/sdk.js";

/**
 * Topbar nav cluster: Ops/Data (+ Data submenu: Nearby/Aggregate, collection…).
 * Rendered inline inside Header on the same row as brand / theme / LIVE.
 */
export default function CollectionBar({
  tab,
  onTab,
  collection,
  onCollection,
  mode,
  onMode,
  peerHint,
  onReset,
  busy,
}) {
  const data = tab === "data";

  return (
    <div className="topbar-nav">
      <nav className="seg" role="tablist" aria-label="sections">
        <button
          type="button"
          role="tab"
          className={tab === "ops" ? "seg-active" : ""}
          aria-selected={tab === "ops"}
          onClick={() => onTab?.("ops")}
        >
          Ops
        </button>
        <button
          type="button"
          role="tab"
          className={tab === "data" ? "seg-active" : ""}
          aria-selected={tab === "data"}
          onClick={() => onTab?.("data")}
        >
          Data
        </button>
      </nav>

      {data ? (
        <>
          <span className="topbar-sep" aria-hidden="true" />

          <label className="data-toolbar-field">
            <span className="sr-only">view mode</span>
            <select
              value={mode}
              onChange={(e) => onMode(e.target.value)}
              aria-label="View mode"
              title="Nearby or Aggregate"
            >
              {VIEW_MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>

          <label className="data-toolbar-field">
            <span className="sr-only">collection</span>
            <input
              list="mesh-dash-collections"
              value={collection}
              onChange={(e) => onCollection(e.target.value)}
              spellCheck={false}
              placeholder="collection"
              title={collection}
            />
            <datalist id="mesh-dash-collections">
              {COLLECTION_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </datalist>
          </label>

          {onReset ? (
            <button
              type="button"
              className="ghost compact"
              disabled={busy}
              onClick={onReset}
              title="Refresh peers and remount Aggregate / Nearby"
            >
              Refresh
            </button>
          ) : null}

          {peerHint ? (
            <span className="data-toolbar-hint">{peerHint}</span>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
