import csv, sys
csv.field_size_limit(10**9)
path = r"C:\avg\agents-vs-gates\results\real\coding\batch7-A\rows.csv"
start = int(sys.argv[1]) if len(sys.argv) > 1 else 0
end = int(sys.argv[2]) if len(sys.argv) > 2 else 10**6
maxlen = int(sys.argv[3]) if len(sys.argv) > 3 else 6000
with open(path, encoding="utf-8", newline="") as f:
    rows = list(csv.DictReader(f))
if start == -1:
    print(len(rows), list(rows[0].keys()))
    for i, r in enumerate(rows):
        print(i, r["code"], r["kind"], "det=", len(r.get("detectors", "")), "diff=", len(r.get("diff_excerpt", "")), "msg=", len(r.get("last_message", "")))
    sys.exit()
for i, r in enumerate(rows[start:end], start):
    print("=" * 30, i, r["code"], r["kind"])
    for k, v in r.items():
        if k in ("code", "kind"):
            continue
        v = v or ""
        if len(v) > maxlen:
            v = v[:maxlen] + f"\n...[truncated {len(v)-maxlen}]"
        print(f"--- {k}:\n{v}")
