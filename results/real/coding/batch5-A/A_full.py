import csv, sys, re
csv.field_size_limit(10**9)
p = r"C:\avg\agents-vs-gates\results\real\coding\batch5-A\rows.csv"
with open(p, encoding="utf-8", newline="") as f:
    rows = list(csv.DictReader(f))
mode = sys.argv[1]
if mode == "full":
    for i in map(int, sys.argv[2].split(",")):
        print("=" * 20, i, rows[i]["code"], rows[i]["ticket"][:300])
        print(rows[i]["last_message"])
else:
    pat = re.compile(sys.argv[2], re.I)
    for i, r in enumerate(rows):
        for mm in pat.finditer(r["last_message"]):
            s = r["last_message"]
            print(i, r["code"], "...", s[max(0, mm.start()-150):mm.end()+150].replace("\n", " "))
