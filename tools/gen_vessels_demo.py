#!/usr/bin/env python3
"""作業船のデモ位置（架空）を作る。現場の水域側の沖に置き、国土地理院の標高データが無い点（＝水域）であることを確かめる。
使い方：python3 tools/gen_vessels_demo.py tools/sites.json tools/vessels_demo.json
実際の AIS とは関係ない。AIS を接続したらこのデモは使わない。
"""
import json, math, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gen_sites import Elev, KX, KY

PLAN = [  # (現場キー, 船名, 種類, 長さm, 幅m, 色, 沖へ出す距離m, 横ずれm)
    ('tk_tokyo', 'グラブ浚渫船 サンプル1号', 'grab', 45, 16, '#1e3a8a', 320, -120),
    ('tk_tokyo', '土運船 サンプル2号', 'barge', 50, 12, '#7c2d12', 420, 160),
    ('cb_nagoya', '起重機船 サンプル3号', 'grab', 55, 22, '#334155', 380, 60),
    ('ks_hibiki', 'グラブ浚渫船 サンプル4号', 'grab', 45, 16, '#1e3a8a', 330, -80),
    ('ks_hibiki', '押船 サンプル5号', 'tug', 22, 8, '#0f766e', 460, 120),
    ('th_sendai', '作業船 サンプル6号', 'tug', 25, 8, '#0f766e', 300, 0),
    ('hk_tomakomai', '土運船 サンプル7号', 'barge', 50, 12, '#7c2d12', 350, 40),
]
sites = {s['sel']['key']: s['sel'] for s in json.load(open(sys.argv[1], encoding='utf-8'))}
out = []
for i, (key, name, typ, L, B, col, off, side) in enumerate(PLAN):
    s = sites[key]; sea = s['sea']; w, d = s['w'], s['d']
    dx, dz = {'E': (w / 2 + off, side), 'W': (-(w / 2 + off), side), 'N': (side, -(d / 2 + off)), 'S': (side, d / 2 + off)}[sea]
    lon = s['lon'] + dx / KX(s['lat']); lat = s['lat'] - dz / KY
    el = Elev(lon, lat, 300); h, _ = el.sample(__import__('numpy').array([lon]), __import__('numpy').array([lat]))
    if not math.isnan(h[0]): sys.exit(f'{name}: 水域ではありません（標高 {h[0]:.1f} m）')
    out.append({'id': f'V{i+1:02d}', 'name': name, 'type': typ, 'len': L, 'beam': B, 'color': col, 'site': key, 'pref': s['pref'],
                'lon': round(lon, 6), 'lat': round(lat, 6), 'radius': 90 if typ != 'tug' else 160, 'period': 600 + 120 * i, 'phase': i * 1.3})
    print(name, key, sea, round(lon, 5), round(lat, 5))
json.dump({'note': '作業船のデモ位置（架空）。AIS 未接続', 'vessels': out}, open(sys.argv[2], 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
