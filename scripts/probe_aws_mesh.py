#!/usr/bin/env python3
"""AWS mesh integrity + latency probe (safe while ingest is running)."""
from __future__ import annotations

import json
import statistics
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

ROOT = "@"
DASH = "http://127.0.0.1:3847/api/mesh"


def fetch(url, headers=None, timeout=8, method="GET", data=None):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read()
        if not body:
            return r.status, None
        try:
            return r.status, json.loads(body)
        except Exception:
            return r.status, body


def pct(xs, p):
    if not xs:
        return None
    s = sorted(xs)
    i = min(len(s) - 1, max(0, int(round((len(s) - 1) * p))))
    return s[i]


def parent(zone: str) -> str:
    if zone == ROOT:
        return ""
    if len(zone) == 1:
        return ROOT
    return zone[:-1]


def summarize(s):
    if not isinstance(s, dict):
        return 0, 0
    total = sum(int(v.get("count") or 0) for v in s.values() if isinstance(v, dict))
    return len(s), total


def main():
    _, mesh = fetch(DASH, timeout=15)
    issuer = mesh["issuer"]
    boot = mesh["boot"]
    hosts = []
    for n in mesh.get("nodes") or []:
        if not n.get("up"):
            continue
        hosts.append(
            {
                "name": n.get("name"),
                "ip": n["ip"],
                "p2p": n.get("p2p") or 21000,
                "mon": n.get("mon") or 19000,
                "role": n.get("role"),
                "items": n.get("items"),
                "zones": n.get("zones"),
            }
        )
    print("=" * 60)
    print(f"MESH boot={boot} issuer={issuer} nodes={len(hosts)}")
    for h in hosts:
        print(
            f"  {h['role']:10} {h['name']} {h['ip']}:{h['p2p']} "
            f"items={h['items']} zones={h['zones']}"
        )

    _, tokbody = fetch(
        f"{issuer}/v1/issue/token",
        headers={"Content-Type": "application/json"},
        method="POST",
        data=json.dumps({"client_id": "aws-probe", "scopes": ["read"]}).encode(),
    )
    auth = {"Authorization": f"Bearer {tokbody['token']}"}

    print("\n" + "=" * 60)
    print("NODE HEALTH")
    nodes = {}
    total_items = 0
    total_prep = 0
    problems = []
    for h in hosts:
        ip = h["ip"]
        mon = h["mon"]
        try:
            _, status = fetch(f"http://{ip}:{mon}/status", timeout=5)
            _, ownership = fetch(f"http://{ip}:{mon}/ownership", timeout=8)
            _, queue = fetch(f"http://{ip}:{mon}/queue", timeout=5)
        except Exception as e:
            problems.append(f"unreachable mon {ip}:{mon}: {e}")
            continue
        name = status.get("name") or h["name"]
        items = int(status.get("items") or 0)
        prep = 0  # removed from /status
        total_items += items
        total_prep += prep
        qpend = (queue or {}).get("pending") or 0
        qpark = (queue or {}).get("parked") or 0
        auto = status.get("autoscale") or {}
        press = auto.get("pressure") or {}
        mem = press.get("mem_pct")
        print(
            f"  {name} {ip} items={items} zones={status.get('zones')} "
            f"q={status.get('queue')} pending={qpend} parked={qpark} "
            f"ready={status.get('write_ready')} rebal={status.get('rebalancing')} "
            f"admit={auto.get('admit_blocked')} hot={press.get('hot_signal') or '-'} "
            f"mem={None if mem is None else round(mem, 1)} "
            f"inserts_w={press.get('inserts_window')}"
        )
        if qpend or qpark:
            print(
                f"    queue pending={qpend} parked={qpark} "
                f"requeues={queue.get('requeues')} stalls={queue.get('stalls')}"
            )
            for s in (queue.get("samples") or [])[:3]:
                print(f"    sample {s}")
        nodes[name] = {
            "ip": ip,
            "p2p": h["p2p"],
            "mon": mon,
            "status": status,
            "ownership": ownership or {},
            "queue": queue or {},
            "items": items,
            "prep": prep,
        }

    print(f"\n  SUM items={total_items} prep={total_prep}")
    cols = set()
    for n in nodes.values():
        cols.update((n["ownership"] or {}).keys())
    print(f"  collections={sorted(cols)}")

    print("\n" + "=" * 60)
    print("INTEGRITY (ownership / aggregates)")

    def aggregates(node_name, collection, location):
        n = nodes[node_name]
        q = urllib.parse.urlencode(
            {
                "collection": collection,
                "location": location,
                "refresh": "true",
            }
        )
        url = f"http://{n['ip']}:{n['p2p']}/aggregates?{q}"
        try:
            _, body = fetch(url, headers=auth, timeout=10)
            return (body.get("aggregates") or {}).get(location)
        except Exception:
            return None

    for col in sorted(cols):
        owners, marks = {}, {}
        for name, n in nodes.items():
            zones = (n["ownership"] or {}).get(col) or {}
            for zone, children in zones.items():
                owners.setdefault(zone, []).append(name)
                if isinstance(children, dict) and children:
                    marks.setdefault(zone, {}).update({c: name for c in children})

        for zone, holders in owners.items():
            if len(holders) > 1:
                problems.append(f"[{col}] zone {zone!r} owned by {holders}")

        for parent_zone, children in marks.items():
            for child, marker in children.items():
                if child in owners:
                    continue
                agg = None
                for name in nodes:
                    agg = aggregates(name, col, child)
                    if agg:
                        break
                if not agg:
                    problems.append(
                        f"[{col}] {parent_zone!r}->{child!r} delegated by {marker} "
                        f"but nobody owns/answers"
                    )

        for zone in owners:
            if zone == ROOT:
                continue
            hop, anc = zone, parent(zone)
            while anc:
                if anc in owners:
                    if hop not in marks.get(anc, {}):
                        problems.append(
                            f"[{col}] zone {zone!r} owned by {owners[zone]} invisible: "
                            f"ancestor {anc!r} does not mark hop {hop!r}"
                        )
                    break
                hop, anc = anc, parent(anc)

        root_owner = (owners.get(ROOT) or [None])[0]
        agg = aggregates(root_owner, col, ROOT) if root_owner else None
        agg_count = agg.get("count") if agg else None
        print(
            f"  [{col}] zones_owned={len(owners)} @-agg={agg_count} "
            f"root_owner={root_owner}"
        )
        if agg_count is not None and len(cols) == 1:
            total_q = sum((n["queue"].get("pending") or 0) for n in nodes.values())
            slack = total_q + total_prep + 500
            drift = agg_count - total_items
            if abs(drift) > slack:
                problems.append(
                    f"[{col}] @ says {agg_count} but sum(items)={total_items} "
                    f"(queued={total_q} prep={total_prep})"
                )
            else:
                print(f"    @ vs sum(items) drift={drift} (tol={slack}) OK under ingest")

    print("\n" + "=" * 60)
    print("READ CONSISTENCY (@ /set deep follow)")

    def get_set(ip, p2p, collection, loc, deep=True, refresh=False, timeout=20):
        q = {
            "collection": collection,
            "location": loc,
            "deep": "true" if deep else "false",
        }
        if refresh:
            q["refresh"] = "true"
        url = f"http://{ip}:{p2p}/set?{urllib.parse.urlencode(q)}"
        _, body = fetch(url, headers=auth, timeout=timeout)
        return body

    def follow(entry, collection, loc, hops=8):
        cur_ip, cur_p2p = entry["ip"], entry["p2p"]
        trail = []
        body = None
        for _ in range(hops):
            body = get_set(cur_ip, cur_p2p, collection, loc, deep=True)
            trail.append(f"{cur_ip}:{cur_p2p}")
            if body.get("set") is not None:
                return body["set"], trail, body
            c = body.get("contact") or {}
            nip = c.get("ip")
            nport = c.get("port")
            if not nip or not nport:
                return None, trail, body
            if nip == cur_ip and int(nport) == cur_p2p:
                return None, trail, body
            cur_ip, cur_p2p = nip, int(nport)
        return None, trail, body

    primary = None
    for c in sorted(cols):
        if "DvF" in c or "dvf" in c.lower() or "2020" in c:
            primary = c
            break
    if not primary and cols:
        primary = sorted(cols)[0]
    print(f"  primary collection={primary}")

    entries = [
        {"ip": n["ip"], "p2p": n["p2p"], "name": name} for name, n in nodes.items()
    ]

    if primary:
        root_sums = {}
        for e in entries:
            try:
                s, trail, _ = follow(e, primary, ROOT)
                nkeys, sm = summarize(s)
                root_sums[e["name"]] = sm
                print(f"  @{e['name']} sum={sm} keys={nkeys} trail={trail}")
            except Exception as ex:
                problems.append(f"root read failed via {e['name']}: {ex}")
                print(f"  @{e['name']} FAIL {ex}")

        vals = [v for v in root_sums.values() if v is not None]
        if vals and (max(vals) - min(vals)) > max(200, int(0.001 * max(vals))):
            problems.append(f"ROOT inconsistent across peers: {root_sums}")
            print(f"  !! ROOT spread {root_sums}")
        elif vals:
            print(f"  OK root consistent-ish (live) sums={root_sums}")

        root, _, _ = follow(entries[0], primary, ROOT)
        if root:
            print("\n  depth-1 stub vs children_sum (sample up to 8):")
            for child in sorted(root.keys())[:8]:
                claim = int(root[child].get("count") or 0)
                try:
                    s, trail, _ = follow(entries[0], primary, child)
                    _, sm = summarize(s)
                    delta = sm - claim
                    mark = "OK" if abs(delta) <= max(50, claim * 0.002) else "DRIFT"
                    if mark != "OK":
                        problems.append(
                            f"[{primary}] {child} stub={claim} children={sm} delta={delta}"
                        )
                    print(
                        f"    {child} stub={claim} children={sm} delta={delta} "
                        f"{mark} trail_len={len(trail)}"
                    )
                except Exception as ex:
                    print(f"    {child} FAIL {ex}")
                    problems.append(f"depth-1 read {child}: {ex}")

    print("\n" + "=" * 60)
    print("LATENCY")

    def timed(fn, n=20):
        times = []
        err = 0
        for _ in range(n):
            t0 = time.perf_counter()
            try:
                fn()
                times.append((time.perf_counter() - t0) * 1000)
            except Exception:
                err += 1
        return times, err

    boot_node = next(n for n in nodes.values() if n["ip"] == boot)

    def one_set_root():
        get_set(
            boot_node["ip"],
            boot_node["p2p"],
            primary or "x",
            ROOT,
            deep=False,
            refresh=True,
        )

    times, err = timed(one_set_root, 25)
    if times:
        print(
            f"  GET /set @ (deep=false refresh) x{len(times)} err={err}: "
            f"min={min(times):.0f} p50={pct(times, 0.5):.0f} "
            f"avg={statistics.mean(times):.0f} p95={pct(times, 0.95):.0f} "
            f"max={max(times):.0f} ms"
        )

    def get_sets(ip, p2p, collection, locs, refresh=True):
        q = urllib.parse.urlencode(
            {
                "collection": collection,
                "locations": ",".join(locs),
                "deep": "true",
                "refresh": "true" if refresh else "false",
            }
        )
        url = f"http://{ip}:{p2p}/sets?{q}"
        return fetch(url, headers=auth, timeout=30)

    locs = []
    if primary:
        root, _, _ = follow(entries[0], primary, ROOT)
        if root:
            locs = sorted(root.keys())[:32]
    print(f"  depth-1 locs for batch: {len(locs)}")

    for batch in (1, 4, 8, 16):
        if not locs:
            break
        pool = locs[: max(batch, min(len(locs), batch * 4))]
        times = []
        err = 0
        t_wall0 = time.perf_counter()
        for i in range(0, len(pool), batch):
            chunk = pool[i : i + batch]
            t0 = time.perf_counter()
            try:
                get_sets(boot_node["ip"], boot_node["p2p"], primary, chunk)
                times.append((time.perf_counter() - t0) * 1000)
            except Exception:
                err += 1
                try:
                    t0 = time.perf_counter()
                    for loc in chunk:
                        get_set(
                            boot_node["ip"],
                            boot_node["p2p"],
                            primary,
                            loc,
                            deep=True,
                            refresh=True,
                        )
                    times.append((time.perf_counter() - t0) * 1000)
                except Exception:
                    pass
        wall = (time.perf_counter() - t_wall0) * 1000
        if times:
            print(
                f"  batch={batch:2d} n_req={len(times)} err={err} wall={wall:.0f}ms "
                f"p50={pct(times, 0.5):.0f} avg={statistics.mean(times):.0f} "
                f"p95={pct(times, 0.95):.0f} max={max(times):.0f} ms "
                f"({len(pool) / (wall / 1000):.1f} zones/s)"
            )

    if locs:
        sample = locs[:16]
        t0 = time.perf_counter()
        err = 0
        with ThreadPoolExecutor(max_workers=8) as ex:
            futs = [
                ex.submit(
                    get_set,
                    boot_node["ip"],
                    boot_node["p2p"],
                    primary,
                    loc,
                    True,
                    True,
                )
                for loc in sample
            ]
            for f in as_completed(futs):
                try:
                    f.result()
                except Exception:
                    err += 1
        wall = (time.perf_counter() - t0) * 1000
        print(
            f"  concurrent /set x{len(sample)} workers=8 wall={wall:.0f}ms "
            f"err={err} ({len(sample) / (wall / 1000):.1f} zones/s)"
        )

    print("\n  per-peer GET /set @ (x10 each):")
    for name, n in nodes.items():

        def make(n=n):
            def fn():
                get_set(n["ip"], n["p2p"], primary, ROOT, deep=False, refresh=True)

            return fn

        times, err = timed(make(), 10)
        if times:
            print(
                f"    {name:20} {n['ip']:15} p50={pct(times, 0.5):.0f} "
                f"avg={statistics.mean(times):.0f} p95={pct(times, 0.95):.0f} "
                f"max={max(times):.0f} ms err={err}"
            )

    print("\n" + "=" * 60)
    print("WRITE SMOKE (1 item)")
    _, wtok = fetch(
        f"{issuer}/v1/issue/token",
        headers={"Content-Type": "application/json"},
        method="POST",
        data=json.dumps(
            {"client_id": "aws-probe-w", "scopes": ["write", "read"]}
        ).encode(),
    )
    wauth = {
        "Authorization": f"Bearer {wtok['token']}",
        "Content-Type": "application/json",
    }
    coll = primary or "probe"
    body = json.dumps(
        {
            "item": {
                "collection": coll,
                "location": "z",
                "id": f"probe-{int(time.time())}",
                "metrics": [1],
            },
            "root": "@",
            "current": "z",
        }
    ).encode()
    t0 = time.perf_counter()
    try:
        code, resp = fetch(
            f"http://{boot_node['ip']}:{boot_node['p2p']}/item",
            headers=wauth,
            method="POST",
            data=body,
            timeout=15,
        )
        ms = (time.perf_counter() - t0) * 1000
        print(f"  POST /item -> {code} in {ms:.0f}ms resp={resp}")
    except urllib.error.HTTPError as e:
        ms = (time.perf_counter() - t0) * 1000
        print(f"  POST /item -> {e.code} in {ms:.0f}ms body={e.read()[:200]}")
    except Exception as e:
        print(f"  POST /item FAIL {e}")

    print("\n" + "=" * 60)
    print("VERDICT")
    if problems:
        print(f"  issues={len(problems)}")
        for p in problems[:40]:
            print(f"  x {p}")
        if len(problems) > 40:
            print(f"  ... +{len(problems) - 40} more")
        return 1
    print(
        f"  no structural issues flagged ({len(nodes)} nodes, sum_items={total_items})"
    )
    print("  note: ingest still running — counts may drift between checks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
