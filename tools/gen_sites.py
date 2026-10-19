#!/usr/bin/env python3
"""みらい建設工業版 3D現場ポータル：港湾背後地の現場データ（位置・地形・住所）を生成する。

入力：国土地理院 標高タイル（DEM5A/DEM5B/DEM10B）、国土地理院 逆ジオコーダ、地方公共団体コード表（muni.js）
出力：sites.json（GEO.sel / GEO.terr と同じ形式）
- 施工範囲（矩形）は「全点が陸域（標高あり）」かつ条件（標高・起伏・水域への接し方）を満たす位置を自動探索する。
- 海・河川などの欠測（NA）は周辺1kmの地形では T.P.-1.0m で埋め、水域として扱う。
"""
import io, json, math, os, sys, time, urllib.request, base64, struct
import numpy as np
from PIL import Image

CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cache')
os.makedirs(CACHE, exist_ok=True)
UA = {'User-Agent': 'mirai-site-portal-build/1.0'}

def fetch(url, name):
    p = os.path.join(CACHE, name)
    if os.path.exists(p):
        return open(p, 'rb').read() or None
    for a in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
                b = r.read()
            open(p, 'wb').write(b); time.sleep(0.05); return b
        except urllib.error.HTTPError as e:
            if e.code == 404:
                open(p, 'wb').write(b''); return None
            time.sleep(1 + a)
        except Exception:
            time.sleep(1 + a)
    raise RuntimeError('fetch failed: ' + url)

SRC = {'DEM5A': ('dem5a_png', 15), 'DEM5B': ('dem5b_png', 15), 'DEM10B': ('dem_png', 14)}

def tile(src, x, y):
    lay, z = SRC[src]
    b = fetch(f'https://cyberjapandata.gsi.go.jp/xyz/{lay}/{z}/{x}/{y}.png', f'{lay}_{z}_{x}_{y}.png')
    if not b:
        return None
    a = np.asarray(Image.open(io.BytesIO(b)).convert('RGB')).astype(np.int64)
    v = a[..., 0] * 65536 + a[..., 1] * 256 + a[..., 2]
    h = np.where(v < 2 ** 23, v * 0.01, (v - 2 ** 24) * 0.01).astype(np.float64)
    h[v == 2 ** 23] = np.nan
    return h

def merc(lon, lat, z):
    n = 2 ** z
    x = (lon + 180) / 360 * n
    y = (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n
    return x, y

class Mosaic:
    """1ソースの標高を (lon,lat) 配列で双線形サンプリングする。"""
    def __init__(self, src, lon0, lat0, lon1, lat1):
        self.src = src; z = SRC[src][1]; self.z = z
        x0, y0 = merc(lon0, lat1, z); x1, y1 = merc(lon1, lat0, z)
        self.tx0, self.ty0 = int(x0), int(y0); tx1, ty1 = int(x1), int(y1)
        W = (tx1 - self.tx0 + 1) * 256; H = (ty1 - self.ty0 + 1) * 256
        self.a = np.full((H, W), np.nan)
        for ty in range(self.ty0, ty1 + 1):
            for tx in range(self.tx0, tx1 + 1):
                h = tile(src, tx, ty)
                if h is not None:
                    self.a[(ty - self.ty0) * 256:(ty - self.ty0 + 1) * 256, (tx - self.tx0) * 256:(tx - self.tx0 + 1) * 256] = h
    def sample(self, lon, lat):
        n = 2 ** self.z
        px = (lon + 180) / 360 * n * 256 - self.tx0 * 256 - .5
        lr = np.radians(lat)
        py = (1 - np.log(np.tan(lr) + 1 / np.cos(lr)) / np.pi) / 2 * n * 256 - self.ty0 * 256 - .5
        i = np.floor(px).astype(int); j = np.floor(py).astype(int); u = px - i; v = py - j
        H, W = self.a.shape
        ok = (i >= 0) & (j >= 0) & (i < W - 1) & (j < H - 1)
        i = np.clip(i, 0, W - 2); j = np.clip(j, 0, H - 2)
        A = self.a
        r = (A[j, i] * (1 - u) * (1 - v) + A[j, i + 1] * u * (1 - v) + A[j + 1, i] * (1 - u) * v + A[j + 1, i + 1] * u * v)
        r[~ok] = np.nan
        return r

class Elev:
    def __init__(self, lon, lat, R):
        dlat = R / 110574; dlon = R / (111320 * math.cos(math.radians(lat)))
        bb = (lon - dlon, lat - dlat, lon + dlon, lat + dlat)
        self.m = [Mosaic(s, *bb) for s in ('DEM5A', 'DEM5B', 'DEM10B')]
    def sample(self, lon, lat):
        out = np.full(np.shape(lon), np.nan); src = np.full(np.shape(lon), -1)
        for k, m in enumerate(self.m):
            h = m.sample(lon, lat); f = np.isnan(out) & ~np.isnan(h)
            out[f] = h[f]; src[f] = k
        return out, src

KX = lambda lat: 111320 * math.cos(math.radians(lat))
KY = 110574

def search(spec):
    lon0, lat0 = spec['near']; R = spec.get('radius', 2500); step = 5
    el = Elev(lon0, lat0, R + 1200)
    n = int(R / step)
    xs = np.arange(-n, n + 1) * step
    X, Y = np.meshgrid(xs, -xs)  # 行=北→南
    LON = lon0 + X / KX(lat0); LAT = lat0 + Y / KY
    H, _ = el.sample(LON, LAT)
    NA = np.isnan(H).astype(np.int32)
    S = np.pad(NA, ((1, 0), (1, 0))).cumsum(0).cumsum(1)
    def cnt(r0, c0, r1, c1):  # [r0,r1) x [c0,c1)
        return S[r1, c1] - S[r0, c1] - S[r1, c0] + S[r0, c0]
    best = None
    for sz in spec['sizes']:
        w, d = sz[0], sz[1]; allowed = sz[2] if len(sz) > 2 else spec.get('seaSides', 'NSEW')
        cw, cd = w // step, d // step; band = max(2, spec.get('band', 50) // step)
        for r in range(band + 1, H.shape[0] - cd - band - 1, 4):
            for c in range(band + 1, H.shape[1] - cw - band - 1, 4):
                if cnt(r, c, r + cd + 1, c + cw + 1):
                    continue
                win = H[r:r + cd + 1:2, c:c + cw + 1:2]
                med = float(np.median(win)); rel = float(win.max() - win.min())
                if not (spec['emed'][0] <= med <= spec['emed'][1]): continue
                if not (spec['relief'][0] <= rel <= spec['relief'][1]): continue
                sides = {'N': cnt(r - band, c, r, c + cw + 1) / (band * (cw + 1)),
                         'S': cnt(r + cd + 1, c, r + cd + 1 + band, c + cw + 1) / (band * (cw + 1)),
                         'W': cnt(r, c - band, r + cd + 1, c) / (band * (cd + 1)),
                         'E': cnt(r, c + cw + 1, r + cd + 1, c + cw + 1 + band) / (band * (cd + 1))}
                sea = max((k for k in sides if k in allowed), key=lambda k: sides[k])
                if spec.get('needSea') and sides[sea] < .35: continue
                cx = (c + cw / 2) * step - n * step; cy = n * step - (r + cd / 2) * step
                dist = math.hypot(cx, cy)
                score = dist / 1000 + (rel * .05 if spec['relief'][1] < 20 else -rel * .02) - (sides[sea] if spec.get('needSea') else 0)
                if best is None or score < best[0]:
                    best = (score, w, d, cx, cy, med, rel, sea if spec.get('needSea') else None, sides[sea])
    if not best:
        raise SystemExit('no site found: ' + spec['name'])
    _, w, d, cx, cy, med, rel, sea, seaFrac = best
    lon = lon0 + cx / KX(lat0); lat = lat0 + cy / KY
    return el, lon, lat, w, d, sea, seaFrac

def enc16(arr):
    v = np.clip(np.round(arr * 10), -32768, 32767).astype('<i2')
    return base64.b64encode(v.tobytes()).decode()

def terrain(el, lon, lat, w, d):
    stp = 2 if max(w, d) <= 120 else 4
    nx, nz = round(w / stp), round(d / stp)
    i = np.arange(nx + 1); j = np.arange(nz + 1)
    I, J = np.meshgrid(i, j)
    x = -w / 2 + I * (w / nx); z = -d / 2 + J * (d / nz)  # z=南向き正
    E, src = el.sample(lon + x / KX(lat), lat - z / KY)
    assert not np.isnan(E).any(), 'area has NA'
    cn, cwid = 80, 1000; st = cwid / cn
    I2, J2 = np.meshgrid(np.arange(cn + 1), np.arange(cn + 1))
    x2 = -cwid / 2 + I2 * st; z2 = -cwid / 2 + J2 * st
    C, _ = el.sample(lon + x2 / KX(lat), lat - z2 / KY)
    sea = float(np.isnan(C).mean())
    C = np.where(np.isnan(C), -1.0, C)
    names = ['DEM5A', 'DEM5B', 'DEM10B']
    vals, cnts = np.unique(src, return_counts=True)
    s = names[int(vals[np.argmax(cnts)])]
    Ef = E.ravel()
    return {'nx': nx, 'nz': nz, 'src': s, 'E': enc16(Ef), 'cw': cwid, 'cn': cn, 'C': enc16(C.ravel()),
            'emin': float(Ef.min()), 'emax': float(Ef.max()), 'emed': float(np.median(Ef)), 'seaFrac': round(sea, 3)}

_MUNI = None
def muni():
    global _MUNI
    if _MUNI is None:
        b = fetch('https://maps.gsi.go.jp/js/muni.js', 'muni.js').decode('utf-8')
        _MUNI = {}
        import re
        for m in re.finditer(r"GSI\.MUNI_ARRAY\[\"(\d+)\"\]\s*=\s*'([^']*)'", b):
            p = m.group(2).split(',')
            _MUNI[int(m.group(1))] = (p[1], p[3].replace('　', ''))
    return _MUNI

def revgeo(lon, lat):
    # 埋立地などで中心点が行政界データの外になる場合は、近い点から順に試す
    for R in (0, 60, 120, 250, 500, 1000, 2000, 3000):
        for k in range(1 if R == 0 else 8):
            a = k * math.pi / 4
            lo = lon + R * math.cos(a) / KX(lat); la = lat + R * math.sin(a) / KY
            b = fetch(f'https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat={la:.6f}&lon={lo:.6f}', f'rg_{la:.6f}_{lo:.6f}.json')
            r = json.loads(b or b'{}').get('results')
            if r and r.get('muniCd'):
                pref, city = muni()[int(r['muniCd'])]
                return pref, city, (r.get('lv01Nm') or '').strip(), int(r['muniCd'])
    raise SystemExit(f'reverse geocode failed {lat},{lon}')

def main(specf, outf):
    specs = json.load(open(specf, encoding='utf-8'))
    out = []
    for sp in specs:
        el, lon, lat, w, d, sea, seaFrac = search(sp)
        t = terrain(el, lon, lat, w, d)
        pref, city, town, code = revgeo(lon, lat)
        rec = {'key': sp['key'], 'pref': pref, 'city': city, 'town': town if town not in ('', '－') else '', 'lgcode': code,
               'kind': sp['kind'], 'w': w, 'd': d, 'lon': lon, 'lat': lat,  # 地形の計算に使った値をそのまま残す（オンライン版が同じ点で標高を取り直すため）
               'sea': sea, 'seaFrac': round(seaFrac, 2)}
        print(f"{sp['key']:<10} {pref}{city}{town:<10} {w}x{d} sea={sea}({seaFrac:.2f}) emed={t['emed']:.1f} "
              f"rel={t['emax']-t['emin']:.1f} {t['src']} ctxSea={t['seaFrac']} ({lat:.5f},{lon:.5f})", flush=True)
        out.append({'sel': rec, 'terr': t})
    json.dump(out, open(outf, 'w', encoding='utf-8'), ensure_ascii=False)

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
