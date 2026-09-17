import { COLLECTION_PRESETS } from "../lib/sdk.js";
import ResourceDropdown from "./ResourceDropdown.jsx";

/**
 * Topbar nav cluster: Network/Client switch (+ Client: collection, refresh…).
 * Mode Aggregate/Nearby lives on the map badge; read knobs live in Contrôles.
 */
export default function CollectionBar({
  tab,
  onTab,
  networks = [],
  activeNetworkId,
  onNetwork,
  onCreateNetwork,
  onDeleteNetwork,
  collections = [],
  collection,
  onCollection,
  onCreateCollection,
  onDeleteCollection,
  peerHint,
  onReset,
  busy,
}) {
  const client = tab === "client";
  const next = client ? "network" : "client";
  const currentLabel = client ? "Client" : "Network";
  const networkItems = networks.map((network) => ({
    ...network,
    label: network.label || network.id,
    meta: `${network.state}${Number.isFinite(network.nodes) ? ` · ${network.nodes} nodes` : ""}`,
  }));
  const collectionItems = [
    ...new Map(
      [
        ...COLLECTION_PRESETS,
        ...collections.map((id) => ({ id, label: id })),
      ].map((item) => [item.id, item]),
    ).values(),
  ];

  return (
    <div className="topbar-nav">
      <button
        type="button"
        className="section-switch"
        onClick={() => onTab?.(next)}
        title={`Switch to ${next === "client" ? "Client" : "Network"}`}
        aria-label={`Section ${currentLabel}. Click to switch to ${
          next === "client" ? "Client" : "Network"
        }.`}
      >
        {currentLabel}
      </button>

      <span className="topbar-sep" aria-hidden="true" />

      {networkItems.length === 0 ? (
        <button
          type="button"
          className="primary compact resource-add-network"
          disabled={busy || !onCreateNetwork}
          onClick={onCreateNetwork}
        >
          + Add network
        </button>
      ) : (
        <ResourceDropdown
          compact
          label="Network"
          items={networkItems}
          value={activeNetworkId}
          onSelect={onNetwork}
          onCreate={onCreateNetwork}
          onDelete={onDeleteNetwork}
          disabled={busy}
        />
      )}

      {client ? (
        <>
          <ResourceDropdown
            compact
            label="Collection"
            items={collectionItems}
            value={collection}
            onSelect={onCollection}
            onCreate={onCreateCollection}
            onDelete={onDeleteCollection}
            disabled={busy}
          />

          {onReset ? (
            <button
              type="button"
              className="ghost compact"
              disabled={busy}
              onClick={onReset}
              title="Clear saved peers, refresh mesh hosts, remount Aggregate / Nearby"
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
