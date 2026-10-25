import csv
csv.field_size_limit(10**9)
p = r"C:\avg\agents-vs-gates\results\real\coding\batch5-A\rows.csv"
with open(p, encoding="utf-8", newline="") as f:
    rows = list(csv.DictReader(f))
from collections import Counter
print(Counter(r["ticket"][:40] for r in rows))
for i, r in enumerate(rows):
    print(i, r["code"], r["ticket"][:20], "| det:", r["detectors"][:150].replace("\n", " "), "| difflen", len(r["diff_excerpt"]), "| msg:", r["last_message"][:140].replace("\n", " "))
