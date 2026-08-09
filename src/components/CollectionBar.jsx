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
  readNavigation,
  onReadNavigation,
  readMethod,
  onReadMethod,
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

          <label className="data-toolbar-field tight">
            <span className="sr-only">read navigation</span>
            <select
              value={readNavigation}
              onChange={(e) => onReadNavigation?.(e.target.value)}
              aria-label="Read navigation"
              title="direct: the client follows zone owners with deep=false redirects. ingress: one sticky peer near the session key deep-fills server-side. Shared by Nearby and Aggregate."
            >
              <option value="direct">direct</option>
              <option value="ingress">ingress</option>
            </select>
          </label>

          <label className="data-toolbar-field tight">
            <span className="sr-only">read granularity</span>
            <select
              value={readMethod}
              onChange={(e) => onReadMethod?.(e.target.value)}
              aria-label="Read granularity"
              title="getSets: many parents coalesced into shared batches. getSet: one location per request. Both speak the same /sets protocol."
            >
              <option value="getSets">getSets</option>
              <option value="getSet">getSet</option>
            </select>
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
