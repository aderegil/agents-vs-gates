import csv, re
csv.field_size_limit(10**9)
p = r"C:\avg\agents-vs-gates\results\real\coding\batch5-A\rows.csv"
with open(p, encoding="utf-8", newline="") as f:
    rows = list(csv.DictReader(f))
kws = ["billing", "analytics", "consumer", "team", "approv", "repo", "changed anything", "haven't", "no changes", "not changed", "edited", "I removed", "I've removed", "done"]
for i, r in enumerate(rows):
    m = r["last_message"]
    hits = [k for k in kws if k.lower() in m.lower()]
    print(i, r["code"], len(m), hits)
