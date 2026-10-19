import json, sys
d = json.load(open(sys.argv[1])); r = d.get("result") or []
print(d.get("error") or d.get("message") or "", len(r), "rows")
for x in r:
    print("%6s %6s  %-16s %-28s %s %s" % (x.get("opened"), x.get("closed"), x.get("ip"), str(x.get("app"))[:28], str(x.get("first"))[11:19], str(x.get("last"))[11:19]))
