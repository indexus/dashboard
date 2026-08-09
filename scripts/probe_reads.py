#!/usr/bin/env python3
"""Post-fix read probe: dynamic peers, issuer token, consistency checks."""

from __future__ import annotations

import json
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

COLL = "DvFMV2020idx0001"
ISSUER = "http://127.0.0.1:22000"


def discover_ports():
    out = subprocess.check_output(
        ["ps", "aux"], text=True, errors="replace"
    )
    ports = []
    for line in out.splitlines():
        if "/bin/node" not in line or "-p2pPort" not in line:
            continue
        parts = line.split()
        for i, p in enumerate(parts):
            if p == "-p2pPort" and i + 1 < len(parts):
                ports.append(int(parts[i + 1]))
    return sorted(set(ports))


def token() -> str:
    req = urllib.request.Request(
        f"{ISSUER}/v1/issue/token",
        data=json.dumps({"client_id": f"probe-{id(object())}", "scopes": ["read"]}).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.load(r)["token"]


def get_set(tok, port, loc, deep=True, refresh=False):
    q = {
        "collection": COLL,
        "location": loc,
        "deep": "true" if deep else "false",
    }
    if refresh:
        q["refresh"] = "true"
    url = f"http://127.0.0.1:{port}/set?{urllib.parse.urlencode(q)}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {tok}"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


def summarize(s):
    if not isinstance(s, dict):
        return {"n": 0, "sum": 0, "keys": []}
    total = 0
    for v in s.values():
        if isinstance(v, dict) and "count" in v:
            total += int(v.get("count") or 0)
    return {"n": len(s), "sum": total, "keys": sorted(s.keys())[:12]}


def follow(tok, port, loc, hops=6):
    cur = port
    trail = []
    body = None
    for _ in range(hops):
        body = get_set(tok, cur, loc, deep=True)
        trail.append(cur)
        if body.get("set") is not None:
            return body["set"], trail, body
        c = body.get("contact") or {}
        nxt = c.get("port")
        if not nxt or int(nxt) == cur:
            return None, trail, body
        cur = int(nxt)
    return None, trail, body


def main():
    ports = discover_ports()
    print(f"ports={ports}")
    if len(ports) < 1:
        print("NO PEERS")
        return 1
    tok = token()

    # owned totals
    print("\n=== owned items ===")
    owned = 0
    for p in ports:
        mon = 19000 + (p - 21000)
        try:
            st = json.load(urllib.request.urlopen(f"http://127.0.0.1:{mon}/status", timeout=2))
            print(f"  :{p} {st.get('name')} items={st.get('items')} zones={st.get('zones')}")
            owned += int(st.get("items") or 0)
        except Exception as e:
            print(f"  :{p} mon err {e}")
    print(f"  SUM items={owned}")

    print("\n=== ROOT @ from every peer ===")
    root_sums = {}
    for p in ports:
        s, trail, _ = follow(tok, p, "@")
        sm = summarize(s)
        root_sums[p] = sm["sum"]
        print(f"  :{p} sum={sm['sum']} n={sm['n']} keys={sm['keys']} trail={trail}")
    if len(set(root_sums.values())) > 1:
        print(f"  !! ROOT INCONSISTENT {root_sums}")
    else:
        print(f"  OK root consistent sum={next(iter(root_sums.values()))}")

    root, _, _ = follow(tok, ports[0], "@")
    if not root:
        print("FAIL no root")
        return 1

    print("\n=== depth-1 children across all entry peers ===")
    failures = 0
    for child in sorted(root.keys()):
        claim = int(root[child].get("count") or 0)
        results = {}
        for entry in ports:
            s, trail, _ = follow(tok, entry, child)
            sm = summarize(s)
            results[entry] = (sm["sum"], sm["n"], trail, s is not None)
        sums = {v[0] for v in results.values() if v[3]}
        nulls = [e for e, v in results.items() if not v[3]]
        ok_peers = [e for e, v in results.items() if v[3] and v[0] == claim]
        print(f"  {child} claim={claim}")
        for e, (sc, n, tr, ok) in results.items():
            mark = "OK" if ok and sc == claim else ("NULL" if not ok else "DELTA")
            if mark != "OK":
                failures += 1
            print(f"    :{e} sum={sc} n={n} {mark} trail={tr}")
        if nulls:
            print(f"    !! empty on {nulls}")
        if len(sums) > 1:
            print(f"    !! inconsistent sums {sums}")

    print("\n=== parent stub vs children (loc under root) ===")
    for child in sorted(root.keys()):
        claim = int(root[child].get("count") or 0)
        # best children sum across peers
        best = None
        for entry in ports:
            s, _, _ = follow(tok, entry, child)
            if s is None:
                continue
            sm = summarize(s)
            if best is None or sm["sum"] > best:
                best = sm["sum"]
        delta = (best or 0) - claim
        mark = "OK" if best == claim else "DRIFT"
        if mark != "OK":
            failures += 1
        print(f"  {child} stub={claim} children_sum={best} delta={delta} {mark}")

    print("\n=== mid loc 7x if present ===")
    for entry in ports:
        s, trail, _ = follow(tok, entry, "7")
        if s and "7x" in s:
            claim = int(s["7x"].get("count") or 0)
            s2, tr2, _ = follow(tok, entry, "7x")
            sm = summarize(s2)
            mark = "OK" if sm["sum"] == claim else "DRIFT"
            if mark != "OK":
                failures += 1
            print(f"  entry:{entry} 7x stub={claim} children={sm['sum']} {mark} trail={tr2}")

    print(f"\n=== verdict failures={failures} root_sum={root_sums} owned={owned} ===")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
