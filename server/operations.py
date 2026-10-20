"""運用のデータ：配船計画（作業船の割り当て）・深浅測量（測量日ごと）・協議記録・地図に重ねる区域と航路。

- 読み出しは閲覧者から、書き込みは編集者から（手で登録する作業船だけは管理者）
- 削除は deleted_at を入れる論理削除（記録は消さない）
- 監査ログには ID と項目名だけを残す（協議の本文・出席者は写さない）
"""
import base64
import math
import re
import secrets
import unicodedata
from datetime import date, timedelta

from fastapi import APIRouter, HTTPException, Request
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from .db import connect
from .security import require, require_csrf, audit, client_ip, allowed_sites, check_site

router = APIRouter()
KEY_RE = r'^[a-z0-9_]{1,64}$'


def _fin(*xs):
    """NaN・無限大を受け付けない（JSON の NaN は Python では読めてしまう）。"""
    if not all(isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) for x in xs):
        raise HTTPException(400, '数値が正しくありません')


def _site(c, key):
    r = c.execute('SELECT data FROM portal.sites WHERE key=%s', (key,)).fetchone()
    if not r:
        raise HTTPException(400, '現場が見つかりません')
    return r['data']


def _iso(r, *ks):
    for k in ks:
        if r.get(k) is not None:
            r[k] = r[k].isoformat()
    return r


def operations_data(c, keys: set[str] | None = None) -> dict:
    """/api/bootstrap に含める運用データ（測量の格子は大きいので別に取り出す）。keys＝見られる現場（None＝すべて）。
    配船は全社の船を共有するため、範囲外の現場の割り当ても「他支店」として船と期間だけを返す（稼働率・重なりを正しく見せる）。"""
    ok = (lambda k: True) if keys is None else (lambda k: k in keys)
    asg = [_iso(r, 'start_date', 'end_date', 'updated_at') for r in c.execute(
        """SELECT id, vessel_id, site_key, start_date, end_date, role, note, updated_at FROM portal.vessel_assignments
           WHERE deleted_at IS NULL ORDER BY vessel_id, start_date""")]
    srv = [_iso({**r, 'dl_tp_cm': float(r['dl_tp_cm']) if r['dl_tp_cm'] is not None else None}, 'surveyed_on', 'uploaded_at') for r in c.execute(
        """SELECT s.id, s.site_key, s.surveyed_on, s.datum, s.dl_tp_cm, s.nx, s.nz, s.npoints, s.src, s.note, s.uploaded_at, u.email AS by
           FROM portal.surveys s LEFT JOIN portal.users u ON u.id=s.uploaded_by WHERE s.deleted_at IS NULL ORDER BY s.site_key, s.surveyed_on, s.id""")]
    con = [_iso(r, 'held_on', 'updated_at') for r in c.execute(
        """SELECT c.id, c.site_key, c.held_on, c.party, c.attendees, c.summary, c.agreements, c.followups, c.status, c.updated_at, u.email AS by
           FROM portal.consultations c LEFT JOIN portal.users u ON u.id=c.created_by WHERE c.deleted_at IS NULL ORDER BY c.held_on DESC, c.id DESC""")]
    fea = [_iso(r, 'updated_at') for r in c.execute(
        """SELECT id, site_key, kind, name, geometry, note, updated_at FROM portal.map_features WHERE deleted_at IS NULL ORDER BY id""")]
    asg = [a if ok(a['site_key']) else {'id': None, 'vessel_id': a['vessel_id'], 'site_key': None, 'start_date': a['start_date'],
                                        'end_date': a['end_date'], 'role': None, 'note': None, 'updated_at': None, 'masked': True} for a in asg]
    return {'assignments': asg, 'surveys': [x for x in srv if ok(x['site_key'])], 'consultations': [x for x in con if ok(x['site_key'])],
            'mapFeatures': [x for x in fea if x['site_key'] is None or ok(x['site_key'])]}


@router.get('/api/operations')
def get_operations(req: Request):
    """保存の後に画面を更新するための軽い取り出し（作業船・配船・測量の一覧・協議記録・区域）。"""
    u = require(req)
    with connect() as c:
        keys = allowed_sites(c, u)
        out = operations_data(c, keys)
        out['vessels'] = [{**v, 'site': v['site'] if keys is None or v['site'] in keys else None}
                          for v in c.execute('SELECT id, name, type, site_key AS site, source, extra FROM portal.vessels ORDER BY source, id')]
    return out


def _soft_delete(table, label, action, rid, req):
    require_csrf(req)
    u = require(req, 'editor')
    with connect() as c:
        row = c.execute(f'SELECT site_key FROM portal.{table} WHERE id=%s AND deleted_at IS NULL', (rid,)).fetchone()
        if not row:
            raise HTTPException(404, f'{label}が見つかりません')
        check_site(c, u, row['site_key'], label)      # 保存されている行の現場で確かめる（範囲外は「見つからない」）
        c.execute(f'UPDATE portal.{table} SET deleted_at=now() WHERE id=%s', (rid,))
        audit(c, u['id'], action, {'id': rid}, client_ip(req))
    return {'ok': True}


# ---------- 作業船（手で登録：自社・傭船） ----------
VESSEL_TYPES = {'grab': 'グラブ浚渫船', 'pump': 'ポンプ浚渫船', 'barge': '土運船', 'pusher': '押船・引船', 'crane': '起重機船', 'other': 'その他'}


class VesselIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    type: str
    site_key: str = Field(pattern=KEY_RE)          # 所属（地図に出す位置）
    len: float | None = Field(default=None, ge=5, le=300, allow_inf_nan=False)
    beam: float | None = Field(default=None, ge=2, le=80, allow_inf_nan=False)


@router.post('/api/vessels/manual')
def add_vessel(body: VesselIn, req: Request):
    require_csrf(req)
    u = require(req, 'admin')
    name = body.name.strip()
    if not name:
        raise HTTPException(400, '船名を入力してください')
    if body.type not in VESSEL_TYPES:
        raise HTTPException(400, '船の種類が正しくありません')
    with connect() as c:
        s = _site(c, body.site_key)
        vid = 'M-' + secrets.token_hex(4)
        extra = {'len': body.len or 40, 'beam': body.beam or 14, 'color': '#0f766e', 'radius': 0, 'period': 1, 'phase': 0}
        c.execute("INSERT INTO portal.vessels(id, name, type, site_key, lon, lat, source, extra) VALUES (%s,%s,%s,%s,%s,%s,'manual',%s)",
                  (vid, name, body.type, body.site_key, s['lon'], s['lat'], Jsonb(extra)))
        audit(c, u['id'], 'vessel_add', {'id': vid, 'type': body.type}, client_ip(req))
    return {'ok': True, 'id': vid}


# ---------- 配船計画 ----------
class AssignmentIn(BaseModel):
    vessel_id: str = Field(min_length=1, max_length=40)
    site_key: str = Field(pattern=KEY_RE)
    start_date: date
    end_date: date
    role: str | None = Field(default=None, max_length=40)
    note: str | None = Field(default=None, max_length=500)


def _check_assignment(c, u, body: AssignmentIn, exclude_id=None):
    if body.end_date < body.start_date:
        raise HTTPException(400, '終了日は開始日より後にしてください')
    if (body.end_date - body.start_date).days > 1100:
        raise HTTPException(400, '期間が長すぎます（3年まで）')
    _site(c, body.site_key)
    check_site(c, u, body.site_key)
    # 同じ船の割り当てを同時に保存して重なるのを防ぐ：船の行を ID の順に固定してから重なりを調べる
    ids = sorted({body.vessel_id} | ({exclude_id[1]} if exclude_id else set()))
    found = {r['id'] for vid in ids for r in c.execute('SELECT id FROM portal.vessels WHERE id=%s FOR UPDATE', (vid,))}
    if body.vessel_id not in found:
        raise HTTPException(400, '作業船が見つかりません')
    clash = list(c.execute("""SELECT id, site_key, start_date, end_date FROM portal.vessel_assignments
                              WHERE vessel_id=%s AND deleted_at IS NULL AND start_date <= %s AND end_date >= %s AND id <> %s""",
                           (body.vessel_id, body.end_date, body.start_date, exclude_id[0] if exclude_id else -1)))
    if clash:   # 範囲外（他支店）の現場は伏せて、期間だけを返す
        keys = allowed_sites(c, u)
        raise HTTPException(409, {'message': 'この作業船は同じ期間に別の割り当てがあります',
                                  'conflicts': [_iso(r if keys is None or r['site_key'] in keys else {**r, 'id': None, 'site_key': None, 'masked': True},
                                                     'start_date', 'end_date') for r in clash]})


@router.post('/api/assignments')
def add_assignment(body: AssignmentIn, req: Request):
    require_csrf(req)
    u = require(req, 'editor')
    with connect() as c:
        _check_assignment(c, u, body)
        r = c.execute("""INSERT INTO portal.vessel_assignments(vessel_id, site_key, start_date, end_date, role, note, created_by)
                         VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
                      (body.vessel_id, body.site_key, body.start_date, body.end_date, body.role, body.note, u['id'])).fetchone()
        audit(c, u['id'], 'assignment_add', {'id': r['id'], 'vessel': body.vessel_id, 'site': body.site_key}, client_ip(req))
    return {'ok': True, 'id': r['id']}


@router.put('/api/assignments/{aid}')
def put_assignment(aid: int, body: AssignmentIn, req: Request):
    require_csrf(req)
    u = require(req, 'editor')
    with connect() as c:
        old = c.execute('SELECT vessel_id, site_key FROM portal.vessel_assignments WHERE id=%s AND deleted_at IS NULL', (aid,)).fetchone()
        if not old:
            raise HTTPException(404, '割り当てが見つかりません')
        check_site(c, u, old['site_key'], '割り当て')       # 今の行と、変更後の現場（_check_assignment）の両方で確かめる
        _check_assignment(c, u, body, (aid, old['vessel_id']))
        c.execute("""UPDATE portal.vessel_assignments SET vessel_id=%s, site_key=%s, start_date=%s, end_date=%s, role=%s, note=%s, updated_at=now()
                     WHERE id=%s""", (body.vessel_id, body.site_key, body.start_date, body.end_date, body.role, body.note, aid))
        audit(c, u['id'], 'assignment_update', {'id': aid, 'vessel': body.vessel_id, 'site': body.site_key}, client_ip(req))
    return {'ok': True}


@router.delete('/api/assignments/{aid}')
def del_assignment(aid: int, req: Request):
    return _soft_delete('vessel_assignments', '割り当て', 'assignment_delete', aid, req)


# ---------- 深浅測量（測量日ごと） ----------
class SurveyIn(BaseModel):
    site_key: str = Field(pattern=KEY_RE)
    surveyed_on: date
    datum: str                       # 元の値の基準（格子はどちらでも T.P. に換算して送る）
    dl_tp_cm: float | None = Field(default=None, ge=-500, le=500, allow_inf_nan=False)
    nx: int = Field(ge=1, le=200)
    nz: int = Field(ge=1, le=200)
    grid: str = Field(max_length=200000)   # 各頂点の T.P. 高さ（0.1m 単位の int16、リトルエンディアン）を base64
    npoints: int = Field(ge=20, le=10_000_000)
    src: str | None = Field(default=None, max_length=120)
    note: str | None = Field(default=None, max_length=500)


@router.post('/api/surveys')
def add_survey(body: SurveyIn, req: Request):
    require_csrf(req)
    u = require(req, 'editor')
    if body.datum not in ('TP', 'DL'):
        raise HTTPException(400, '基準は TP か DL にしてください')
    if body.datum == 'DL' and body.dl_tp_cm is None:
        raise HTTPException(400, 'DL 基準のときは DL の T.P. からの高さが必要です')
    if not date(2000, 1, 1) <= body.surveyed_on <= date.today() + timedelta(days=1):
        raise HTTPException(400, '測量日が正しくありません')
    try:
        raw = base64.b64decode(body.grid, validate=True)
    except Exception:
        raise HTTPException(400, '格子のデータが正しくありません')
    if len(raw) != (body.nx + 1) * (body.nz + 1) * 2:
        raise HTTPException(400, '格子の点の数が合いません')
    vals = memoryview(raw).cast('h')
    if min(vals) < -1000 or max(vals) > 500:          # T.P. -100m〜+50m
        raise HTTPException(400, '高さが想定の範囲（T.P. -100〜+50 m）を外れています')
    with connect() as c:
        s = _site(c, body.site_key)
        check_site(c, u, body.site_key)
        sv = s.get('survey')
        if not s.get('marine') and s.get('kind') not in ('dredge', 'landfill') or not sv:
            raise HTTPException(400, '深浅測量は海上工事（浚渫・埋立）の現場だけです')
        if (sv['nx'], sv['nz']) != (body.nx, body.nz):
            raise HTTPException(400, f"格子の大きさが現場と合いません（{sv['nx']}×{sv['nz']}）")
        r = c.execute("""INSERT INTO portal.surveys(site_key, surveyed_on, datum, dl_tp_cm, nx, nz, grid, npoints, src, note, uploaded_by)
                         VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
                      (body.site_key, body.surveyed_on, body.datum, body.dl_tp_cm, body.nx, body.nz, body.grid, body.npoints,
                       body.src, body.note, u['id'])).fetchone()
        audit(c, u['id'], 'survey_add', {'id': r['id'], 'site': body.site_key}, client_ip(req))
    return {'ok': True, 'id': r['id']}


@router.get('/api/surveys/{sid}')
def get_survey(sid: int, req: Request):
    u = require(req)
    with connect() as c:
        r = c.execute('SELECT id, site_key, surveyed_on, nx, nz, grid FROM portal.surveys WHERE id=%s AND deleted_at IS NULL', (sid,)).fetchone()
        if not r:
            raise HTTPException(404, '測量が見つかりません')
        check_site(c, u, r['site_key'], '測量')
    return _iso(r, 'surveyed_on')


@router.delete('/api/surveys/{sid}')
def del_survey(sid: int, req: Request):
    return _soft_delete('surveys', '測量', 'survey_delete', sid, req)


# ---------- 協議記録 ----------
PARTIES = ('漁協', '港湾管理者', '海上保安部', '発注者', '地元', 'その他')
# 個人の連絡先（メールアドレス・電話番号）。全角は NFKC で半角にしてから調べる。漢字の隣でも数字の境目で判定する（\b は使わない）
PII_RE = re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]+|(?<!\d)0\d{1,4}[-‐‑−ー‒–—(（)） ]\d{1,4}[-‐‑−ー‒–—)） ]\d{3,4}(?!\d)|(?<!\d)0\d{9,10}(?!\d)')


class ConsultIn(BaseModel):
    site_key: str = Field(pattern=KEY_RE)
    held_on: date
    party: str
    attendees: str | None = Field(default=None, max_length=300)
    summary: str = Field(min_length=1, max_length=2000)
    agreements: str | None = Field(default=None, max_length=2000)
    followups: str | None = Field(default=None, max_length=1000)
    status: str = '対応中'


def _check_consult(body: ConsultIn):
    if not body.summary.strip():
        raise HTTPException(400, '協議の内容を入力してください')
    if body.party not in PARTIES:
        raise HTTPException(400, '相手先の区分が正しくありません')
    if body.status not in ('対応中', '完了'):
        raise HTTPException(400, '状態が正しくありません')
    if not date(2000, 1, 1) <= body.held_on <= date.today() + timedelta(days=366):
        raise HTTPException(400, '日付が正しくありません')
    if any(PII_RE.search(unicodedata.normalize('NFKC', x or '')) for x in (body.attendees, body.summary, body.agreements, body.followups)):
        raise HTTPException(400, 'メールアドレス・電話番号などの個人の連絡先は書かないでください（組織・役職までにしてください）')


@router.post('/api/consultations')
def add_consult(body: ConsultIn, req: Request):
    require_csrf(req)
    u = require(req, 'editor')
    _check_consult(body)
    with connect() as c:
        _site(c, body.site_key)
        check_site(c, u, body.site_key)
        r = c.execute("""INSERT INTO portal.consultations(site_key, held_on, party, attendees, summary, agreements, followups, status, created_by)
                         VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
                      (body.site_key, body.held_on, body.party, body.attendees, body.summary, body.agreements, body.followups, body.status, u['id'])).fetchone()
        audit(c, u['id'], 'consultation_add', {'id': r['id'], 'site': body.site_key}, client_ip(req))
    return {'ok': True, 'id': r['id']}


@router.put('/api/consultations/{cid}')
def put_consult(cid: int, body: ConsultIn, req: Request):
    require_csrf(req)
    u = require(req, 'editor')
    _check_consult(body)
    with connect() as c:
        _site(c, body.site_key)
        old = c.execute('SELECT site_key FROM portal.consultations WHERE id=%s AND deleted_at IS NULL', (cid,)).fetchone()
        if not old:
            raise HTTPException(404, '協議記録が見つかりません')
        check_site(c, u, old['site_key'], '協議記録')    # 今の行と、変更後の現場の両方
        check_site(c, u, body.site_key)
        n = c.execute("""UPDATE portal.consultations SET site_key=%s, held_on=%s, party=%s, attendees=%s, summary=%s, agreements=%s, followups=%s,
                         status=%s, updated_at=now() WHERE id=%s AND deleted_at IS NULL""",
                      (body.site_key, body.held_on, body.party, body.attendees, body.summary, body.agreements, body.followups, body.status, cid)).rowcount
        if not n:
            raise HTTPException(404, '協議記録が見つかりません')
        audit(c, u['id'], 'consultation_update', {'id': cid, 'fields': sorted(body.model_fields_set)}, client_ip(req))
    return {'ok': True}


@router.delete('/api/consultations/{cid}')
def del_consult(cid: int, req: Request):
    return _soft_delete('consultations', '協議記録', 'consultation_delete', cid, req)


# ---------- 地図に重ねる区域・航路（経度・緯度の GeoJSON） ----------
FEATURE_KINDS = ('work_area', 'channel', 'fishing', 'restricted', 'other')


class FeatureIn(BaseModel):
    site_key: str | None = Field(default=None, pattern=KEY_RE)
    kind: str
    name: str = Field(min_length=1, max_length=80)
    geometry: dict
    note: str | None = Field(default=None, max_length=500)


def _check_geometry(g: dict, site: dict | None) -> dict:
    t, co = g.get('type'), g.get('coordinates')
    pts = co if t == 'LineString' else (co[0] if t == 'Polygon' and isinstance(co, list) and len(co) == 1 else None)
    if not isinstance(pts, list) or not 2 <= len(pts) <= 500:
        raise HTTPException(400, '線（LineString）か面（Polygon・外周1つ）で、点は 2〜500 にしてください')
    out = []
    for p in pts:
        if not isinstance(p, list) or len(p) != 2:
            raise HTTPException(400, '座標は [経度, 緯度] にしてください')
        _fin(*p)
        lon, lat = float(p[0]), float(p[1])
        if not (120 <= lon <= 155 and 20 <= lat <= 47):
            raise HTTPException(400, '座標が日本の範囲を外れています')
        if site and math.hypot((lon - site['lon']) * 91, (lat - site['lat']) * 111) > 30:
            raise HTTPException(400, '座標が現場から 30 km 以上離れています')
        out.append([round(lon, 7), round(lat, 7)])
    if t == 'Polygon':
        if out[0] != out[-1]:
            out.append(out[0])
        if len(out) < 4:
            raise HTTPException(400, '面は 3 点以上にしてください')
        return {'type': 'Polygon', 'coordinates': [out]}
    return {'type': 'LineString', 'coordinates': out}


@router.post('/api/map-features')
def add_feature(body: FeatureIn, req: Request):
    require_csrf(req)
    u = require(req, 'editor')
    if body.kind not in FEATURE_KINDS:
        raise HTTPException(400, '区域の種類が正しくありません')
    if not body.name.strip():
        raise HTTPException(400, '名前を入力してください')
    with connect() as c:
        site = _site(c, body.site_key) if body.site_key else None
        check_site(c, u, body.site_key)        # 現場の無い（全社共通の）区域は、全支店を見られる人だけ
        geo = _check_geometry(body.geometry, site)
        r = c.execute("""INSERT INTO portal.map_features(site_key, kind, name, geometry, note, created_by) VALUES (%s,%s,%s,%s,%s,%s) RETURNING id""",
                      (body.site_key, body.kind, body.name.strip(), Jsonb(geo), body.note, u['id'])).fetchone()
        audit(c, u['id'], 'map_feature_add', {'id': r['id'], 'kind': body.kind, 'site': body.site_key}, client_ip(req))
    return {'ok': True, 'id': r['id'], 'geometry': geo}


@router.delete('/api/map-features/{fid}')
def del_feature(fid: int, req: Request):
    return _soft_delete('map_features', '区域', 'map_feature_delete', fid, req)
