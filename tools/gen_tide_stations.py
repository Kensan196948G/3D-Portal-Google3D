#!/usr/bin/env python3
"""気象庁「潮位表掲載地点一覧表」から、潮位表の地点（記号・名称・位置・基準面）を取り出して JSON にする。
使い方：python3 tools/gen_tide_stations.py tools/tide_stations.json
出典：気象庁ホームページ https://www.data.jma.go.jp/kaiyou/db/tide/suisan/station.php
- msl_dl：平均海面（MSL）と潮位表基準面（DL）の差 cm
- msl_tp：MSL の標高（T.P. からの高さ）cm。不明は null
- dl_tp ：潮位表基準面の標高 cm。不明は null
"""
import html, json, re, sys, urllib.request
from datetime import date

URL = 'https://www.data.jma.go.jp/kaiyou/db/tide/suisan/station.php'
t = urllib.request.urlopen(URL, timeout=30).read().decode('utf-8', 'ignore')
num = lambda s: None if s.strip() in ('-', '', '－') else float(s)
def deg(s):
    m = re.match(r"\s*(\d+)\D+(\d+)", s)
    return round(int(m.group(1)) + int(m.group(2)) / 60, 4)
out = []
for row in re.findall(r'<tr[^>]*>(.*?)</tr>', t, re.S):
    c = [html.unescape(re.sub(r'<[^>]+>', '', x)).strip() for x in re.findall(r'<t[hd][^>]*>(.*?)</t[hd]>', row, re.S)]
    if len(c) >= 8 and c[0].isdigit() and re.fullmatch(r'[A-Z0-9]{2}', c[1]):
        out.append({'code': c[1], 'name': c[2], 'lat': deg(c[3]), 'lon': deg(c[4]), 'msl_dl': num(c[5]), 'msl_tp': num(c[6]), 'dl_tp': num(c[7])})
if len(out) < 100:
    sys.exit(f'地点が少なすぎます（{len(out)}）。ページの形式が変わった可能性があります')
json.dump({'source': URL, 'retrieved': date.today().isoformat(), 'stations': out}, open(sys.argv[1], 'w', encoding='utf-8'), ensure_ascii=False, indent=0)
print(len(out), '地点')
