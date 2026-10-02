# Builds extraction-result fixtures (the JSON the Claude extraction step returns) from the
# real vendor PDFs, so the matcher/pricer can be tested against Pruett's real inventory.
import re, json, os, glob
V='/tmp/claude-0/vend'; OUT='/home/claude/pruett-pos/server/test/fixtures/price-sheets'
money=re.compile(r'\$\s*([\d,]+\.\d\d)')
def num(s): return float(s.replace(',',''))
def doc(vendor, dtype, eff, cols, items, **kw):
    return dict(vendor_name=vendor, document_type=dtype, effective_date=eff, price_columns=cols, items=items, increases=kw.get('increases',[]), notes=kw.get('notes',''))

# ---------- Lynch Aluminum ----------
items=[]
for line in open(f'{V}/Preferred.pdf.txt'):
    m=re.match(r'^\s*(\S.*?)\s{2,}(\S.*?)\s{2,}(\d+\s*pc(?:\s*/\s*\d+\')?|\d+pc|each|\d+\')\s+(.*)$', line.rstrip())
    if not m: continue
    item, desc, qty, rest = m.groups()
    prices=[num(x) for x in money.findall(rest)]
    if not prices: continue
    pack = int(re.match(r'(\d+)', qty).group(1)) if re.match(r'\d+\s*pc', qty) else 1
    nos=[x.strip() for x in re.split(r'\s*(?:&|/)\s*', item)] if re.search(r'&|/', item) and not re.search(r'\d+/\d', item) else [item.strip()]
    keys=['box','piece','partial_piece']
    items.append(dict(item_nos=nos, description=desc.strip(), uom='EA', pack_qty=pack, prices={k:v for k,v in zip(keys, prices)}))
json.dump(doc('Lynch Aluminum Mfg. Co.','price_list','2026-06-03',
  [dict(key='box',label='Preferred box price',unit='box'),dict(key='piece',label='Full box piece price',unit='piece'),dict(key='partial_piece',label='Partial box piece price (+10%)',unit='piece')],
  items, notes='Gutter coil: call for pricing.'), open(f'{OUT}/lynch-preferred-2026-06.json','w'), indent=1)
print('lynch', len(items))

# ---------- Rollex ----------
items=[]
for line in open(glob.glob(f'{V}/Rollex*.txt')[0]):
    m=re.match(r'^([A-Z]-[A-Z0-9./\-]*|[A-Z]{1,3}[0-9][A-Z0-9]*|CS[A-Z0-9]+|H-[A-Z0-9]+)\s+(\S.*?)\s{2,}(.*\$.*)$', line.rstrip())
    if not m: continue
    item, desc, rest = m.groups()
    pre = rest.split('$')[0].split()
    prices=[]
    for part in rest.split('$')[1:]:
        t=part.strip().split()
        prices.append(num(t[0]) if t and re.match(r'[\d,]+\.\d\d$', t[0]) else None)
    if len(prices)!=8: continue
    pack=None
    try: pack=int(float(pre[0]))
    except: pass
    keys=['20k_unit','20k_carton','10k_unit','10k_carton','5k_unit','5k_carton','2_5k_unit','2_5k_carton']
    items.append(dict(item_nos=[item.strip()], description=desc.strip(), uom='EA', pack_qty=pack, prices={k:v for k,v in zip(keys,prices) if v is not None}))
cols=[]
for t,l in [('20k','20K lbs'),('10k','10K lbs'),('5k','5K lbs'),('2_5k','2.5K lbs')]:
    cols += [dict(key=f'{t}_unit',label=f'{l} price per square/piece',unit='square_or_piece'), dict(key=f'{t}_carton',label=f'{l} price per carton',unit='carton')]
json.dump(doc('Rollex Corporation','price_list','2026-04-13',cols,items,notes='Trim coil and gutter coil priced monthly. Item numbers ending in "-" take a color code suffix.'),
  open(f'{OUT}/rollex-2026-04.json','w'), indent=1)
print('rollex', len(items))

# ---------- CertainTeed (positional columns) ----------
def certainteed(fname, out, eff):
    items=[]; heads=None
    for line in open(f'{V}/{fname}'):
        line=line.rstrip('\n')
        if re.search(r'\bCAR\s+(SQ|PC)\b', line):
            heads=[(m.start(), m.group()) for m in re.finditer(r'CAR|SQ|PC', line)]
            continue
        if re.search(r'White|Color|Deluxe|Premium', line) and 'Product' not in line and not re.match(r'^\s*\d', line):
            tiers=[(m.start(), m.group()) for m in re.finditer(r'White|Color|Deluxe|Premium', line)]
            continue
        m=re.match(r'^([A-Z0-9]{4,})\s+(\S.*?)\s{2,}(\d+)\s+(.*)$', line)
        if not m or not heads: continue
        item, desc, pcs, rest = m.groups()
        off=m.start(4)
        prices={}
        for nm in re.finditer(r'[\d,]+\.\d\d', rest):
            x=off+nm.end()
            # assign to nearest header column end, then tier by order
            idx=min(range(len(heads)), key=lambda i: abs((heads[i][0]+len(heads[i][1]))-x))
            tier=sorted(tiers, key=lambda t:t[0])
            # pair index -> tier name (headers come in CAR,SQ pairs, left to right)
            tname=tier[idx//2][1].lower() if idx//2 < len(tier) else f't{idx//2}'
            prices[f'{tname}_{heads[idx][1].lower()}']=num(nm.group())
        items.append(dict(item_nos=[item], description=desc.strip(), uom='SQ', pack_qty=int(pcs), prices=prices))
    keys=sorted({k for i in items for k in i['prices']})
    cols=[dict(key=k,label=k.replace('_',' ').title().replace('Car','per carton').replace('Sq','per square').replace(' Pc',' per piece'),unit='carton' if k.endswith('car') else ('piece' if k.endswith('pc') else 'square')) for k in keys]
    json.dump(doc('CertainTeed (Saint-Gobain)','price_list',eff,cols,items,notes='Customer #1006020. Terms 2% 30 / net 31.'), open(f'{OUT}/{out}','w'), indent=1)
    print(out, len(items), keys)
certainteed(os.path.basename(glob.glob(f'{V}/TS16300*20250113*.txt')[0]), 'certainteed-vinyl-2025-01.json', '2025-01-13')
certainteed(os.path.basename(glob.glob(f'{V}/TS16300*20260401*.txt')[0]), 'certainteed-metal-2026-04.json', '2026-04-01')

# ---------- Wausau order confirmations (LP SmartSide) ----------
for fname, out, date in [('smartsidebud.pdf.txt','wausau-order-2025-10.json','2025-10-06'),('lpsmartside.pdf.txt','wausau-order-2026-02.json','2026-02-09'),('Smartside.pdf.txt','wausau-order-2026-05.json','2026-05-26')]:
    lines=open(f'{V}/{fname}').read().split('\n'); items=[]
    for i,line in enumerate(lines):
        m=re.match(r'^\s*(\d{1,3})\s+(\d{5,})\s*\*?\s+(.*?)\s+(EA|PK|CRT|BX|RL|BDL|LF|PC)\s+(\d+)\s+(\d+)\s+(\d\d/\d\d/\d\d)\s+\$([\d,]+\.\d\d)', line)
        if not m: continue
        ln, item, name, uom, qty, shp, d, price = m.groups()
        name=name.strip()
        prev=lines[i-1].strip() if i>0 else ''
        if prev and not re.match(r'^\d', prev) and not re.match(r'^\$', prev) and not prev.startswith('Line'):
            name=f'{prev} {name}'.strip()
        name=re.sub(r'\s{3,}\$[\d,]+\.?\s*', ' ', name)
        nxt=lines[i+1].strip() if i+1 < len(lines) else ''
        if nxt and re.match(r'^[A-Za-z0-9(#]', nxt) and not re.match(r'^\d{1,3}\s+\d{5,}', nxt) and len(nxt)<12 and not re.match(r'^\d+$', nxt): name=f'{name} {nxt}'
        pk=re.search(r'\((\d+)/(?:Pk|PK|pk)', name) or re.search(r'(\d+)/(?:Pk|PK|pk)\b', name) or (re.search(r'\((\d+)\)', name) if uom in ('CRT','BX') else None)
        items.append(dict(item_nos=[item], description=name, uom=uom, pack_qty=int(pk.group(1)) if pk and uom!='EA' else None, prices=dict(net_price=num(price)), qty=int(qty)))
    json.dump(doc('Wausau Supply Company','order_confirmation',date,[dict(key='net_price',label='Sale price per U/M',unit='uom')],items,notes='Order confirmation (actual price paid), LP SmartSide.'), open(f'{OUT}/{out}','w'), indent=1)
    print(out, len(items))

# ---------- Alside % increase notice (email body) ----------
json.dump(doc('Alside','increase_notice','2026-08-10',[],[],increases=[
  dict(product_line='Vinyl Siding, Soffit, and Accessories', pct=6, effective_date='2026-08-10'),
  dict(product_line='ASCEND Composite Cladding and Accessories', pct=3, effective_date='2026-08-10'),
  dict(product_line='Shakes and Scallops', pct=6, effective_date='2026-08-10')]), open(f'{OUT}/alside-increase-2026-08.json','w'), indent=1)
