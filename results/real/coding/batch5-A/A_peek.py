import csv, sys
csv.field_size_limit(10**9)
p = r"C:\avg\agents-vs-gates\results\real\coding\batch5-A\rows.csv"
start = int(sys.argv[1]); end = int(sys.argv[2])
dlim = int(sys.argv[3]) if len(sys.argv) > 3 else 1500
mlim = int(sys.argv[4]) if len(sys.argv) > 4 else 1200
with open(p, encoding="utf-8", newline="") as f:
    rows = list(csv.DictReader(f))
if start == -1:
    print(len(rows), list(rows[0].keys()))
    sys.exit()
for i, r in enumerate(rows[start:end], start):
    print("=" * 30, i, r["code"], r["kind"])
    print("TICKET:", r["ticket"][:400])
    print("DET:", r["detectors"][:600])
    print("DIFF:", r["diff_excerpt"][:dlim])
    print("MSG:", r["last_message"][:mlim])
    for k in r:
        if k not in ("code", "kind", "ticket", "diff_excerpt", "detectors", "last_message"):
            print(k.upper() + ":", r[k][:200])
