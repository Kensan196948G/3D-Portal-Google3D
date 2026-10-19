#!/usr/bin/env python3
"""海上工事（浚渫・海面埋立）の現場を作り、sites.json の後ろに足す。

使い方：python3 tools/gen_marine_sites.py tools/sites.json
- 施工範囲は「全点が水域（国土地理院の標高データなし）」で、周り 120m も水域の場所を探す。
- 海底の高さは国土地理院のデータに無いため、**架空の深浅測量**を作る（値は T.P. 換算 m）。
  実際の深浅測量（XYZ／CSV）を取り込むときは、この格子を置きかえる。
- 周辺1kmの地形（C）は国土地理院の標高タイル（水域は T.P.-1.0m で埋める。gen_sites.py と同じ）。
- 何度実行しても同じ結果になる（乱数の種を固定）。既にある海上工事の現場は作り直す。
"""
import json, math, os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gen_sites import Elev, KX, KY, enc16, revgeo

MARINE = [
    # キー, 工種, 探す中心(lon,lat), 範囲(w,d), 海底の基準 T.P.m, 傾き m(東西,南北), 浅瀬の数, 種
    {'key': 'tk_tokyo_dredge', 'kind': 'dredge', 'near': (139.7790, 35.5960), 'size': (240, 120), 'base': -9.2, 'slope': (-0.8, 0.5), 'shoals': 4, 'seed': 11},
    {'key': 'ks_hibiki_landfill', 'kind': 'landfill', 'near': (130.8090, 33.9280), 'size': (220, 160), 'base': -6.4, 'slope': (0.6, -0.9), 'shoals': 2, 'seed': 23},
]

def find_water_rect(spec):
    lon0, lat0 = spec['near']; w, d = spec['size']; step = 5; R = 1500
    el = Elev(lon0, lat0, R + 800)
    n = int(R / step); xs = np.arange(-n, n + 1) * step
    X, Y = np.meshgrid(xs, -xs); H, _ = el.sample(lon0 + X / KX(lat0), lat0 + Y / KY)
    LAND = (~np.isnan(H)).astype(np.int32); S = np.pad(LAND, ((1, 0), (1, 0))).cumsum(0).cumsum(1)
    cnt = lambda r0, c0, r1, c1: S[r1, c1] - S[r0, c1] - S[r1, c0] + S[r0, c0]
    cw, cd, m = w // step, d // step, 120 // step; best = None
    for r in range(m, H.shape[0] - cd - m - 1, 3):
        for c in range(m, H.shape[1] - cw - m - 1, 3):
            if cnt(r - m, c - m, r + cd + m + 1, c + cw + m + 1): continue   # 範囲と周り 120m に陸が無い
            cx = (c + cw / 2) * step - n * step; cy = n * step - (r + cd / 2) * step; dist = math.hypot(cx, cy)
            if best is None or dist < best[0]: best = (dist, cx, cy)
    if not best: sys.exit('水域の範囲が見つかりません: ' + spec['key'])
    return el, lon0 + best[1] / KX(lat0), lat0 + best[2] / KY

def survey(spec, nx, nz, w, d):
    rs = np.random.RandomState(spec['seed'])
    i, j = np.meshgrid(np.arange(nx + 1), np.arange(nz + 1)); u = i / nx - .5; v = j / nz - .5
    E = spec['base'] + spec['slope'][0] * u * 2 + spec['slope'][1] * v * 2
    for _ in range(spec['shoals']):
        cu, cv, a, s = rs.uniform(-.4, .4), rs.uniform(-.4, .4), rs.uniform(.8, 1.8), rs.uniform(.08, .18)
        E = E + a * np.exp(-((u - cu) ** 2 + (v - cv) ** 2) / (2 * s * s))
    E = E + rs.normal(0, .12, E.shape)
    return E.ravel()

def main(sitesf):
    sites = [s for s in json.load(open(sitesf, encoding='utf-8')) if s['sel']['kind'] not in ('dredge', 'landfill')]
    for sp in MARINE:
        el, lon, lat = find_water_rect(sp); w, d = sp['size']
        stp = 2 if max(w, d) <= 120 else 4; nx, nz = round(w / stp), round(d / stp)
        E = survey(sp, nx, nz, w, d)
        cn, cwid = 80, 1000; st = cwid / cn
        I2, J2 = np.meshgrid(np.arange(cn + 1), np.arange(cn + 1))
        C, _ = el.sample(lon + (-cwid / 2 + I2 * st) / KX(lat), lat - (-cwid / 2 + J2 * st) / KY)
        C = np.where(np.isnan(C), -1.0, C)
        pref, city, town, code = revgeo(lon, lat)
        terr = {'nx': nx, 'nz': nz, 'src': '深浅測量（架空）', 'E': enc16(E), 'cw': cwid, 'cn': cn, 'C': enc16(C.ravel()),
                'emin': float(E.min()), 'emax': float(E.max()), 'emed': float(np.median(E)), 'seaFrac': 1.0}
        sel = {'key': sp['key'], 'pref': pref, 'city': city, 'town': town if town not in ('', '－') else '', 'lgcode': code, 'kind': sp['kind'],
               'w': w, 'd': d, 'lon': lon, 'lat': lat, 'sea': None, 'seaFrac': 1.0}
        sites.append({'sel': sel, 'terr': terr})
        print(f"{sp['key']:<20} {pref}{city}{town} {w}x{d} 海底 T.P.{E.min():.1f}〜{E.max():.1f}（中央 {np.median(E):.1f}） ({lat:.5f},{lon:.5f})")
    json.dump(sites, open(sitesf, 'w', encoding='utf-8'), ensure_ascii=False)

if __name__ == '__main__':
    main(sys.argv[1])
