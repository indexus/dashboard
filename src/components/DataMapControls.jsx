import { AREA_MODE_CELL, AREA_MODE_DISK } from "@himo/lib/heatmap.js";
import Tip from "./Tip.jsx";

/**
 * Aggregate controls — stacked groups (like Ops Node), each param with a
 * visible hover tooltip explaining what it does.
 */

function Group({ title, tip, children }) {
  return (
    <section className="ops-kv-group">
      <Tip tip={tip} as="h3" className="ops-kv-group-title">
        {title}
      </Tip>
      <div className="ops-kv-rows">{children}</div>
    </section>
  );
}

function MetricRow({ label, tip, value }) {
  return (
    <Tip tip={tip} className="ops-kv-row">
      <span className="ops-kv-label">{label}</span>
      <span className="ops-kv-value">{value}</span>
    </Tip>
  );
}

function SliderRow({ label, tip, valueLabel, children, disabled }) {
  return (
    <Tip
      tip={tip}
      as="label"
      className={`ops-kv-ctrl${disabled ? " is-disabled" : ""}`}
    >
      <span className="ops-kv-ctrl-head">
        <span className="ops-kv-label">{label}</span>
        {valueLabel != null ? (
          <em className="ops-kv-ctrl-value">{valueLabel}</em>
        ) : null}
      </span>
      {children}
    </Tip>
  );
}

function CheckRow({ label, tip, checked, onChange }) {
  return (
    <Tip tip={tip} as="label" className="ops-kv-ctrl ops-kv-ctrl--check">
      <input
        type="checkbox"
        checked={!!checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="ops-kv-label">{label}</span>
    </Tip>
  );
}

export default function DataMapControls({
  resolution,
  onResolution,
  maxPoints,
  onMaxPoints,
  zoneLimit,
  onZoneLimit,
  multiplier,
  onMultiplier,
  areaMode,
  onAreaMode,
  dynamicCenter,
  onDynamicCenter,
  requireCompleteChildren,
  onRequireCompleteChildren,
  childVirtualization,
  onChildVirtualization,
  normalizer,
  onNormalizer,
  polygonFilter,
  onPolygonFilter,
  visualPolygonFilter,
  onVisualPolygonFilter,
  metrics,
}) {
  const squareCells = areaMode === AREA_MODE_CELL;
  const modeLabel =
    metrics?.mode === "points"
      ? `points · ${metrics.pointCount ?? 0}`
      : "heatmap";

  return (
    <div className="ops-kv data-map-kv">
      <Group
        title="Visualisation"
        tip="Rendu carte : profondeur d’affichage, forme des zones, bascule heatmap ↔ points."
      >
        <SliderRow
          label="résolution"
          tip="Profondeur de la grille Grid/Cube (LOD). Plus haut = cellules plus petites et plus détaillées à un zoom donné. Plage 1–12."
          valueLabel={resolution}
        >
          <input
            type="range"
            min={1}
            max={12}
            step={1}
            value={resolution}
            onChange={(e) => onResolution(Number(e.target.value))}
          />
        </SliderRow>

        <SliderRow
          label="seuil items"
          tip="Si le nombre d’items visibles dans le viewport tombe sous ce seuil, la carte bascule du heatmap vers des points individuels (€/m²). Remonter le seuil force plus souvent le mode points."
          valueLabel={maxPoints}
        >
          <input
            type="range"
            min={50}
            max={5000}
            step={50}
            value={maxPoints}
            onChange={(e) => onMaxPoints(Number(e.target.value))}
          />
        </SliderRow>

        <CheckRow
          label="cellules carrées"
          tip="On : chaque zone est un quadrilatère exact (bounds de la cellule). Off : disques dont le rayon suit le multiplicateur « rayon disque »."
          checked={squareCells}
          onChange={(v) =>
            onAreaMode(v ? AREA_MODE_CELL : AREA_MODE_DISK)
          }
        />

        <CheckRow
          label="centre dynamique"
          tip="On : le centre rendu d’une zone utilise les lat/lng agrégées des ventes (centroïde métrique). Off : centre géométrique des bounds de la cellule."
          checked={!!dynamicCenter}
          onChange={onDynamicCenter}
        />

        <SliderRow
          label="rayon disque"
          tip="Multiplicateur du rayon des disques en mode disque (ignoré si cellules carrées). 1× = rayon nominal ; plus haut = disques plus larges qui se chevauchent davantage."
          valueLabel={`${Number(multiplier).toFixed(2)}×`}
          disabled={squareCells}
        >
          <input
            type="range"
            min={0.45}
            max={5}
            step={0.05}
            value={multiplier}
            disabled={squareCells}
            onChange={(e) => onMultiplier(Number(e.target.value))}
          />
        </SliderRow>
      </Group>

      <Group
        title="Agrégation"
        tip="Paramètres du Cube / Grid côté worker : quand subdiviser, et comment gérer les enfants manquants."
      >
        <SliderRow
          label="seuil zones"
          tip="Cube limit : une zone ne se subdivise plus si son count d’items tombe sous ce seuil. 0 = subdivision agressive ; plus haut = zones plus grosses / moins de profondeur."
          valueLabel={zoneLimit}
        >
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={zoneLimit}
            onChange={(e) => onZoneLimit(Number(e.target.value))}
          />
        </SliderRow>

        <CheckRow
          label="enfants complets"
          tip="Strict : la subdivision n’avance que si tous les enfants requis sont présents. Off : accepte une subdivision partielle (zones incomplètes possibles)."
          checked={!!requireCompleteChildren}
          onChange={onRequireCompleteChildren}
        />

        <CheckRow
          label="virtualisation enfants"
          tip="Crée localement des enfants virtuels pour poursuivre la subdivision / le LOD même quand le mesh n’a pas encore renvoyé tous les enfants réels."
          checked={!!childVirtualization}
          onChange={onChildVirtualization}
        />
      </Group>

      <Group
        title="Métriques"
        tip="Échelle de couleur €/m² et indicateurs calculés sur le viewport courant."
      >
        <SliderRow
          label="normalizer €/m²"
          tip="Plafond de saturation de la ramp de couleur. Couleur = clamp((€/m²) / normalizer). Ex. 10 000 : au-delà de 10k €/m² la couleur est saturée au max."
          valueLabel={normalizer}
        >
          <input
            type="range"
            min={1000}
            max={30000}
            step={500}
            value={normalizer}
            onChange={(e) => onNormalizer(Number(e.target.value))}
          />
        </SliderRow>

        <MetricRow
          label="mode"
          tip="heatmap = agrégats WebGPU ; points = ventes individuelles quand le count visible ≤ seuil items."
          value={modeLabel}
        />
        <MetricRow
          label="€/m² moyen"
          tip="Moyenne du prix au m² (valeur foncière / surface) sur les zones ou points visibles."
          value={metrics?.avgEuroM2Label ?? "—"}
        />
        <MetricRow
          label="items zones parentes"
          tip="Somme des counts Abelian des zones parentes visibles dans le viewport (pondérée par l’intersection des bounds)."
          value={
            metrics?.parentItemTotal != null && metrics.parentItemTotal > 0
              ? metrics.parentItemTotal.toLocaleString("fr-FR")
              : metrics?.visibleItemCount != null && metrics.visibleItemCount > 0
                ? metrics.visibleItemCount.toLocaleString("fr-FR")
                : "—"
          }
        />
        <MetricRow
          label="transactions"
          tip="Nombre de transactions (ventes) agrégées dans le viewport (alias DVF du total items)."
          value={metrics?.transactions ?? "—"}
        />
        <MetricRow
          label="zones / disks"
          tip="Nombre d’instances de grille rendues (cellules ou disques) dans le frame courant."
          value={metrics?.instances ?? 0}
        />
        <MetricRow
          label="seuil bascule"
          tip="Count pondéré utilisé pour la bascule heatmap ↔ points (seuil items)."
          value={metrics?.visibleItemCount ?? "—"}
        />
      </Group>

      <Group
        title="Filtres"
        tip="Masque France : filtre les données et/ou le rendu hors polygone métropolitain."
      >
        <CheckRow
          label="données France"
          tip="Filtre côté worker : subdivision et collecte d’items limitées au polygone France (ignore hors territoire)."
          checked={!!polygonFilter}
          onChange={onPolygonFilter}
        />
        <CheckRow
          label="visuel France"
          tip="Masque GPU uniquement : coupe le rendu heatmap hors France sans changer la requête / subdivision des données."
          checked={!!visualPolygonFilter}
          onChange={onVisualPolygonFilter}
        />
      </Group>
    </div>
  );
}
