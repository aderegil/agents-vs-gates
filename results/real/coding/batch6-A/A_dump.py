import csv,sys
rows=list(csv.DictReader(open('rows.csv',encoding='utf-8')))
print(len(rows), list(rows[0].keys()))
a,b=int(sys.argv[1]),int(sys.argv[2])
for r in rows[a:b]:
    print('='*100)
    for k,v in r.items():
        if k in('diff_excerpt',): v=v[:3500]
        if k=='last_message': v=v[:2000]
        print(f'[{k}] {v}')
