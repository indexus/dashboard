import { useEffect, useMemo, useState } from "react";

const fmtSize = (n) => {
  if (n == null || Number.isNaN(n)) return "—";
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (Math.abs(n) >= 1e4) return (n / 1e3).toFixed(1) + "k";
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 10) / 10);
};

/**
 * Object-store keys look like:
 *   nodes/<nodeId>/manifest.json | wal/...
 *   zones/<collection>/<zoneId>/<n>.snap
 *   snapshots/...
 * Browse by prefix with breadcrumb drill-down.
 */
function normalizeObj(o) {
  return {
    key: o.key || o.Key || "",
    size: o.size ?? o.Size ?? 0,
  };
}

function partsOf(key) {
  return String(key)
    .split("/")
    .filter(Boolean);
}

/**
 * @param {{ key: string, size: number }[]} objects
 * @param {string[]} path segments already drilled into
 */
function listAtPath(objects, path) {
  const prefix = path.length ? path.join("/") + "/" : "";
  /** @type {Map<string, { name: string, kind: 'dir'|'file', size: number, count: number, key?: string }>} */
  const kids = new Map();

  for (const o of objects) {
    if (!o.key) continue;
    if (prefix && !o.key.startsWith(prefix)) continue;
    const rest = prefix ? o.key.slice(prefix.length) : o.key;
    if (!rest) continue;
    const slash = rest.indexOf("/");
    if (slash < 0) {
      // leaf file at this level
      kids.set(rest, {
        name: rest,
        kind: "file",
        size: o.size,
        count: 1,
        key: o.key,
      });
    } else {
      const name = rest.slice(0, slash);
      const prev = kids.get(name);
      if (prev && prev.kind === "dir") {
        prev.size += o.size;
        prev.count += 1;
      } else if (!prev) {
        kids.set(name, {
          name,
          kind: "dir",
          size: o.size,
          count: 1,
        });
      }
    }
  }

  const rows = [...kids.values()];
  rows.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return rows;
}

function pathLabel(seg, i, path) {
  // Friendly labels for known top-level / second-level prefixes
  if (i === 0) {
    if (seg === "zones") return "zones · collections";
    if (seg === "nodes") return "nodes";
    if (seg === "snapshots") return "snapshots";
  }
  if (path[0] === "zones" && i === 1) return seg; // collection id
  return seg;
}

/**
 * @param {{
 *   objects?: object[],
 *   available?: boolean,
 *   error?: string,
 *   onPathChange?: (prefix: string) => void,
 * }} props
 */
export default function SnapshotsBrowser({ objects = [], onPathChange }) {
  const [path, setPath] = useState(/** @type {string[]} */ ([]));

  useEffect(() => {
    onPathChange?.(path.join("/"));
  }, [onPathChange, path]);

  const objs = useMemo(
    () => (objects || []).map(normalizeObj).filter((o) => o.key),
    [objects],
  );

  const rows = useMemo(() => listAtPath(objs, path), [objs, path]);

  const totalUnder = useMemo(() => {
    if (!path.length) return objs.length;
    const prefix = path.join("/") + "/";
    return objs.filter((o) => o.key.startsWith(prefix) || o.key === path.join("/"))
      .length;
  }, [objs, path]);

  function enter(name) {
    setPath((p) => [...p, name]);
  }

  function goUp(toIndex) {
    if (toIndex < 0) setPath([]);
    else setPath((p) => p.slice(0, toIndex + 1));
  }

  return (
    <div className="snap-browser">
      <nav className="snap-crumbs" aria-label="snapshot path">
        <button
          type="button"
          className={!path.length ? "active" : ""}
          onClick={() => goUp(-1)}
          title="object store root"
        >
          store
        </button>
        {path.map((seg, i) => (
          <span key={`${i}-${seg}`} className="snap-crumb-seg">
            <span className="snap-crumb-sep" aria-hidden="true">
              /
            </span>
            <button
              type="button"
              className={i === path.length - 1 ? "active" : ""}
              onClick={() => goUp(i)}
              title={seg}
            >
              {pathLabel(seg, i, path)}
            </button>
          </span>
        ))}
      </nav>
      <div className="snap-browser-meta">
        {totalUnder} object{totalUnder === 1 ? "" : "s"}
        {path.length ? ` under ${path.join("/")}` : ""}
      </div>
      <div className="snap-list snap-list--tree">
        {path.length > 0 ? (
          <button
            type="button"
            className="snap-row snap-row--nav"
            onClick={() => goUp(path.length - 2)}
          >
            <span>‥ parent</span>
            <span className="sz" />
          </button>
        ) : null}
        {rows.length === 0 ? (
          <div className="snap-row snap-row--empty">
            <span>empty</span>
          </div>
        ) : (
          rows.map((r) =>
            r.kind === "dir" ? (
              <button
                type="button"
                className="snap-row snap-row--dir"
                key={`d:${r.name}`}
                onClick={() => enter(r.name)}
                title={`${path.concat(r.name).join("/")} · ${r.count} objects`}
              >
                <span className="snap-name">
                  <span className="snap-kind" aria-hidden="true">
                    ▸
                  </span>
                  {r.name}
                  <em className="snap-count">{r.count}</em>
                </span>
                <span className="sz">{fmtSize(r.size)}</span>
              </button>
            ) : (
              <div
                className="snap-row snap-row--file"
                key={`f:${r.key}`}
                title={r.key}
              >
                <span className="snap-name">{r.name}</span>
                <span className="sz">{fmtSize(r.size)}</span>
              </div>
            ),
          )
        )}
      </div>
    </div>
  );
}

export { partsOf, listAtPath };
