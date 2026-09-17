/**
 * Top-left map chrome: click toggles Aggregate ↔ Nearby.
 */
export default function MapModeSwitch({ mode, onMode, detail = "" }) {
  const current = mode === "nearby" ? "nearby" : "aggregate";
  const next = current === "aggregate" ? "nearby" : "aggregate";
  const label = detail ? `${current} · ${detail}` : current;

  return (
    <button
      type="button"
      className="map-mode-badge map-mode-badge--switch"
      onClick={() => onMode?.(next)}
      title={`Switch to ${next}`}
      aria-label={`View mode ${current}. Click to switch to ${next}.`}
    >
      {label}
    </button>
  );
}
