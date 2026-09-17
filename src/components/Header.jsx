import CollectionBar from "./CollectionBar.jsx";

export default function Header({
  error,
  theme,
  onTheme,
  tab,
  onTab,
  networks,
  activeNetworkId,
  onNetwork,
  onCreateNetwork,
  onDeleteNetwork,
  collections,
  onCreateCollection,
  onDeleteCollection,
  collection,
  onCollection,
  peerHint,
  onReset,
  busy,
}) {
  const isDark = theme !== "white";

  return (
    <header className="topbar">
      <div className="topbar-left">
        <div className="brand-row">
          <img
            className="brand-mark"
            src="/indexus-mark.png"
            alt=""
            width={32}
            height={32}
          />
          <div className="brand">indexus</div>
        </div>

        <button
          type="button"
          className="theme-toggle"
          onClick={() => onTheme?.(isDark ? "white" : "dark")}
          aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
          title={isDark ? "Light" : "Dark"}
        >
          {isDark ? (
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="4" fill="currentColor" />
              <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <path d="M12 2v2.2M12 19.8V22M2 12h2.2M19.8 12H22M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M4.9 19.1l1.6-1.6M17.5 6.5l1.6-1.6" />
              </g>
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="currentColor"
                d="M16.4 14.2A7.2 7.2 0 0 1 9.8 7.6a7 7 0 0 1 .3-2A7.4 7.4 0 1 0 16.4 14.2Z"
              />
            </svg>
          )}
        </button>

        <CollectionBar
          tab={tab}
          onTab={onTab}
          networks={networks}
          activeNetworkId={activeNetworkId}
          onNetwork={onNetwork}
          onCreateNetwork={onCreateNetwork}
          onDeleteNetwork={onDeleteNetwork}
          collections={collections}
          onCreateCollection={onCreateCollection}
          onDeleteCollection={onDeleteCollection}
          collection={collection}
          onCollection={onCollection}
          peerHint={peerHint}
          onReset={onReset}
          busy={busy}
        />
      </div>

      <div className="topbar-right">
        <div
          className={`topbar-status${error ? " err" : ""}`}
          title={typeof error === "string" && error ? error : undefined}
        >
          <span className={`live-dot${error ? " err" : ""}`}>
            <i />
            <span>{error ? "error" : "live"}</span>
          </span>
        </div>
      </div>
    </header>
  );
}
