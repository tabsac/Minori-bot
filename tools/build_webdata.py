#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""给网页版（planner）用的只读数据：`/data/songs.json`、`/data/cards.json`、`/data/events.json`、`/data/version.json`

数据源：
  · `data/on/songs.json`            曲库（bot 从 MasterLiveMusic/MasterLiveMusicScore/MasterVideo/MasterText 整理）
  · `data/on/master/Master*.json`   官方主数据（每 6 小时由 tools/on_master.js 刷新）
  · `data/on/index.json`            角色 / 卡牌索引（bot 用，含中文别名）
  · 活动部分直接复用 `data/on/eventimg.py` 的 `gather()`（MasterEvent / EventEffect / PickUpCard / 点数奖励）

⚠️ 只输出「可以公开」的内容（用户定的原则）：
  · **不发** `songs.json` 里的 `cdn` / `auth`（那是补丁 CDN 的授权串，属于凭据）
  · **不发**内部资源名（bundle / textFile / asset 路径 / ACB 名）
  · **不发**任何图片（曲绘、卡面、活动主视觉都不发；网页端用自己的缓存或官方 CDN）

    build_webdata.py                写到 data/web/
    build_webdata.py --out <dir>    写到指定目录
"""
import argparse
import hashlib
import json
import os
import re
import sys
import time

ON = os.environ.get('ON_DIR', '/home/admin/bot/data/on')
MASTER = os.path.join(ON, 'master')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))     # /home/admin/bot

CHART_DIR = os.path.join(ON, 'chart')                 # 本地谱面缓存（tools/fetch_charts.js 抓取）
CHART_DIFFS = ('EASY', 'NORMAL', 'HARD', 'EXPERT')
CHART_NAME_RE = re.compile(r'^(\d{3,8})_(EASY|NORMAL|HARD|EXPERT)\.json$')

RARITY_LABEL = {2: 'R', 3: 'SR', 4: 'SSR', 10: 'BD', 20: 'EX'}
TYPE_NAME = {1: '绯红', 2: '绀碧', 3: '翡翠', 4: '琉金', 5: '紫苑'}
BONUS_KIND = {2: '成员卡', 3: '留影卡'}


# ------------------------------------------------------------------ 基础
def load_master(name):
    p = os.path.join(MASTER, 'Master%s.json' % name)
    with open(p, encoding='utf-8') as f:
        d = json.load(f)
    if isinstance(d, dict) and '_allData' in d:
        return d['_allData']
    return d if isinstance(d, list) else list(d.values())[0]


def load_json(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def parse_dt(s):
    """主数据里的时间串 → unix 秒（和 eventimg.py 一样按服务器本地时区解释）"""
    if not s or s == 'null':
        return None
    for f in ('%Y/%m/%d %H:%M:%S', '%Y/%m/%d %H:%M', '%Y/%m/%d', '%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M'):
        try:
            return int(time.mktime(time.strptime(s, f)))
        except ValueError:
            continue
    return None


def text_map():
    """MasterText → {_id: {'zh':…, 'jp':…, 'en':…}}"""
    out = {}
    for r in load_master('Text'):
        out[str(r.get('_id'))] = {
            'zh': (r.get('_simplifiedChinese') or '').strip(),
            'tw': (r.get('_traditionalChinese') or '').strip(),
            'jp': (r.get('_japanese') or '').strip(),
            'en': (r.get('_english') or '').strip(),
        }
    return out


def tx(t, tid):
    r = t.get(str(tid)) or {}
    return r.get('zh') or r.get('jp') or ''


def write_json(out_dir, name, payload, pretty=False):
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, name)
    # ⚠️ 带 pid：cron 环境里出现过外部清理把 *.tmp 删掉导致 os.replace ENOENT
    tmp = '%s.tmp%d' % (path, os.getpid())
    with open(tmp, 'w', encoding='utf-8') as f:
        if pretty:
            json.dump(payload, f, ensure_ascii=False, indent=1)
        else:
            json.dump(payload, f, ensure_ascii=False, separators=(',', ':'))
    try:
        os.replace(tmp, path)
    except OSError:
        # 兜底：tmp 被外部删掉时直接写目标文件（宁可短暂非原子，也不能整批失败）
        with open(path, 'w', encoding='utf-8') as fh:
            if pretty:
                json.dump(payload, fh, ensure_ascii=False, indent=1)
            else:
                json.dump(payload, fh, ensure_ascii=False, separators=(',', ':'))
        try:
            os.remove(tmp)
        except OSError:
            pass
    return path, os.path.getsize(path)


# ------------------------------------------------------------------ songs.json
CHART_ORDER = {'EASY': 0, 'NORMAL': 1, 'HARD': 2, 'EXPERT': 3, 'MASTER': 4}


def build_songs(t):
    src = load_json(os.path.join(ON, 'songs.json'))
    out = []
    for s in src.get('songs') or []:
        charts = []
        for c in sorted(s.get('charts') or [], key=lambda x: CHART_ORDER.get(x.get('name'), 9)):
            charts.append({'name': c.get('name'), 'level': c.get('level'),
                           'display': c.get('display'), 'combo': c.get('combo')})
        out.append({
            'id': s.get('id'),
            'title': s.get('title') or s.get('title_jp'),
            'titleJp': s.get('title_jp'), 'titleTw': s.get('title_tw'), 'titleEn': s.get('title_en'),
            'phonetic': s.get('phonetic'),
            'band': [{'id': b.get('id'), 'name': b.get('name')} for b in (s.get('band') or [])],
            'vocals': [{'id': v.get('id'), 'name': v.get('name')} for v in (s.get('vocals') or [])],
            'typeId': s.get('typeId'), 'type': s.get('type'),
            'jacket': s.get('jacket'),                      # 只是资源名，图不发
            'lyricist': s.get('lyricist'), 'composer': s.get('composer'), 'arranger': s.get('arranger'),
            'releaseAt': s.get('releaseAt'),
            'charts': charts,
        })
    return {'generated': iso_now(), 'count': len(out),
            'note': 'BPM / 时长主数据里没有（只在 MasterLiveSettings，非逐曲字段），需要的话另说',
            'songs': out}


# ------------------------------------------------------------------ cards.json
def build_cards(t):
    bands = {b['_id']: b for b in load_master('Band')}
    chars = {c['_id']: c for c in load_master('Character')}
    mcs = load_master('MemberCard')
    scs = load_master('SupportCard')
    idx = load_json(os.path.join(ON, 'index.json'))          # 角色中文别名（bot 维护）

    alias = {c['id']: c.get('aliases') for c in (idx.get('characters') or []) if c.get('id')}

    def band_of(bid):
        b = bands.get(bid)
        return {'id': bid, 'name': tx(t, b['_nameTextID']) if b else '', 'color': (b or {}).get('_mainColorCode')} if b else None

    characters = []
    for cid, c in sorted(chars.items()):
        if c.get('_isNonPlayable'):
            continue
        characters.append({
            'id': cid,
            'name': tx(t, c.get('_nameTextID')),
            'shortName': tx(t, c.get('_shortNameTextID')),
            'nameEn': tx(t, c.get('_enDisplayNameTextId')),
            'band': band_of(c.get('_bandID')),
            'color': c.get('_mainColorCode'), 'subColor': c.get('_subColorCode'),
            'part': c.get('_bandPart'), 'order': c.get('_displayOrder'),
            'birthday': {'month': c.get('_birthdayMonth'), 'day': c.get('_birthdayDay')},
            'alias': alias.get(cid) or [],
        })

    def card_common(row, member):
        return {
            'id': row['_id'],
            'char': row.get('_characterID') if member else (row.get('_characterIDs') or []),
            'rarity': row.get('_rarity'), 'rarityLabel': RARITY_LABEL.get(row.get('_rarity'), ''),
            'typeId': row.get('_cardType'), 'type': TYPE_NAME.get(row.get('_cardType'), ''),
            'power': {'performance': row.get('_performancePowerMax'),
                      'technic': row.get('_technicPowerMax'),
                      'visual': row.get('_visualPowerMax')},
            'startAt': row.get('_startAt'),
        }

    member_cards = []
    for r in sorted(mcs, key=lambda x: x['_id']):
        c = card_common(r, True)
        c.update({
            'name': tx(t, r.get('_nameTextID')),                 # 角色名
            'title': tx(t, r.get('_subtitleTextID')),            # 卡名
            'levelGroup': r.get('_memberCardLevelGroup'),
            'rankGroup': r.get('_memberCardRankGroup'),
            'awakeGroup': r.get('_memberCardAwakeGroup'),
            'leaderSkillId': r.get('_leaderSkillID'),
            'liveSkillId': r.get('_liveSkillID'),
            'gekisouSkillId': r.get('_gekisouSkillID'),
        })
        member_cards.append(c)

    support_cards = []
    for r in sorted(scs, key=lambda x: x['_id']):
        c = card_common(r, False)
        c.update({
            'name': '＆'.join(tx(t, chars[i]['_nameTextID']) for i in (r.get('_characterIDs') or []) if i in chars),
            'title': tx(t, r.get('_descriptionTextID')),          # 留影卡卡名（如「圆圆小憩」）
            'levelGroup': r.get('_supportCardLevelGroup'),
            'rankGroup': r.get('_supportCardRankGroup'),
            'supportSkillIds': [x for x in (r.get('_supportSkillId01'), r.get('_supportSkillId02')) if x],
            'gekisouSupportSkillIds': [x for x in (r.get('_gekisouSupportSkillId01'), r.get('_gekisouSupportSkillId02')) if x],
        })
        support_cards.append(c)

    # 等级 / 界限突破的倍率表（前端要本地算力时用得上，体积很小）
    levels = [{'group': r.get('_group'), 'level': r.get('_level'), 'exp': r.get('_exp'),
               'performanceRate': r.get('_performanceRate'), 'technicRate': r.get('_technicRate'),
               'visualRate': r.get('_visualRate')} for r in load_master('MemberCardLevel')]
    ranks = [{'group': r.get('_group'), 'rank': r.get('_rank'),
              'itemCount': r.get('_requiredRankUpItemCount'),
              'performanceRate': r.get('_performanceRate'), 'technicRate': r.get('_technicRate'),
              'visualRate': r.get('_visualRate'), 'leaderSkillLevel': r.get('_leaderSkillLevel'),
              'musicTypeBonusRate': r.get('_musicTypeBonusRate'), 'musicTagBonusRate': r.get('_musicTagBonusRate')}
             for r in load_master('MemberCardRank')]

    return {
        'generated': iso_now(),
        'rarityLabel': {str(k): v for k, v in RARITY_LABEL.items()},
        'typeName': {str(k): v for k, v in TYPE_NAME.items()},
        'counts': {'characters': len(characters), 'memberCards': len(member_cards),
                   'supportCards': len(support_cards), 'levels': len(levels), 'ranks': len(ranks)},
        'note': '技能效果表（leader/live/gekisou 的数值）暂未导出，先给 ID；要的话下一轮补',
        'bands': [{'id': b['_id'], 'name': tx(t, b['_nameTextID']), 'color': b.get('_mainColorCode')}
                  for b in sorted(bands.values(), key=lambda x: x['_id'])],
        'characters': characters,
        'memberCards': member_cards,
        'supportCards': support_cards,
        'memberCardLevels': levels,
        'memberCardRanks': ranks,
    }


# ------------------------------------------------------------------ events.json
def build_events(t, songs_by_id):
    evs = []
    for e in sorted(load_master('Event'), key=lambda x: x.get('_startAt') or ''):
        evs.append(e)

    challenge = {}
    for r in load_master('ChallengeMusic'):
        if r.get('_eventId') and r.get('_liveMusicId'):
            challenge.setdefault(r['_eventId'], [])
            if r['_liveMusicId'] not in challenge[r['_eventId']]:
                challenge[r['_eventId']].append(r['_liveMusicId'])

    out = []
    now = time.time()
    for e in evs:
        st, en = parse_dt(e.get('_startAt')), parse_dt(e.get('_endAt'))
        mids = list(challenge.get(e['_id']) or [])
        if not mids and e.get('_musicId'):
            mids = [e['_musicId']]
        songs = []
        for mid in mids:
            s = songs_by_id.get(str(mid))
            if s:
                songs.append({'id': s.get('id'), 'title': s.get('title'), 'jacket': s.get('jacket'),
                              'charts': [{'name': c.get('name'), 'level': c.get('level')} for c in (s.get('charts') or [])]})
        out.append({
            'id': e['_id'],
            'name': tx(t, e.get('_nameTextId')),
            'startAt': e.get('_startAt'), 'endAt': e.get('_endAt'),
            'displayEndAt': e.get('_displayEndAt'),
            'startTs': st, 'endTs': en,
            'running': bool(st and en and st <= now <= en),
            'type': e.get('_eventType'),
            'songs': songs,
            'song': songs[0] if songs else None,
            'bonus': [], 'picks': [], 'miles': [],
        })

    # 当期活动：复用 /on活动 的 gather()（加成 / Pick Up / 点数奖励都在里面）
    cur = None
    try:
        sys.path.insert(0, ON)
        import eventimg as EI                                             # noqa: PLC0415
        info = EI.gather()
        if info:
            for row in out:
                if row['id'] == info['id']:
                    row['bonus'] = [{'kind': b.get('kind'), 'who': b.get('who'),
                                     'lo': b.get('lo'), 'hi': b.get('hi'), 'type': b.get('type')}
                                    for b in info.get('bonus') or []]
                    row['picks'] = info.get('picks') or []
                    row['miles'] = info.get('miles') or []
                    row['item'] = info.get('item') or ''
                    cur = row['id']
    except Exception as e:                                                # noqa: BLE001
        sys.stderr.write('活动加成/PickUp 抓取失败（只发基础字段）：%s\n' % e)

    if cur is None:
        running = [r for r in out if r['running']]
        cur = (running or out or [{}])[-1].get('id')

    return {'generated': iso_now(), 'count': len(out), 'currentEventId': cur,
            'note': '时间同时给原始串（startAt/endAt，按服务器时区解释）和 unix 秒（startTs/endTs）；以原串为准。活动图片（主视觉/logo）不开放。',
            'events': out}


def iso_now():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def data_version():
    """数据版本 = 主数据目录里最新文件的日期 + 曲库文件的日期"""
    latest = 0
    for base in (MASTER, ON):
        try:
            for n in os.listdir(base):
                if n.endswith('.json'):
                    latest = max(latest, int(os.path.getmtime(os.path.join(base, n))))
        except OSError:
            pass
    return time.strftime('%Y-%m-%d', time.localtime(latest or time.time()))


# 会随每次构建变化的字段：算「内容摘要」时要先去掉
VOLATILE_KEYS = ('generated', 'updatedAt')


def content_digest(payload):
    """规范化 JSON（键排序、去时间戳）的 sha256 —— 数据没变就不会变。"""
    def strip(x):
        if isinstance(x, dict):
            return {k: strip(v) for k, v in sorted(x.items()) if k not in VOLATILE_KEYS}
        if isinstance(x, list):
            return [strip(v) for v in x]
        return x
    blob = json.dumps(strip(payload), ensure_ascii=False, sort_keys=True,
                      separators=(',', ':'))
    return hashlib.sha256(blob.encode('utf-8')).hexdigest()


# ------------------------------------------------------------------ 谱面
def publish_charts(out_dir, songs):
    """把 ON/chart/*.json 发布成 <out>/charts/*.json，并返回清单。

    · 只保留 `meta` / `score` 两个顶层键（白名单）—— 将来上游多带什么字段都不会被发出去
    · 清单里带每个文件的 sha256 / bytes / notes 数，网页端可以据此只拉变化的谱面
    · `missing` 列出「songs.json 里有这个难度、但本地还没抓到」的文件，方便发现缺口
    """
    dst_dir = os.path.join(out_dir, 'charts')
    os.makedirs(dst_dir, exist_ok=True)

    wanted = set()
    for s in songs['songs']:
        for c in (s.get('charts') or []):
            if c.get('name') in CHART_DIFFS:
                wanted.add('%s_%s.json' % (s['id'], c['name']))

    files, published = {}, set()
    names = sorted(os.listdir(CHART_DIR)) if os.path.isdir(CHART_DIR) else []
    for name in names:
        if not CHART_NAME_RE.match(name):
            continue
        try:
            with open(os.path.join(CHART_DIR, name), encoding='utf-8') as fh:
                doc = json.load(fh)
            payload = {'meta': doc.get('meta') or {}, 'score': doc.get('score') or {}}
            path, size = write_json(dst_dir, name, payload)
            with open(path, 'rb') as fh:
                digest = hashlib.sha256(fh.read()).hexdigest()
            notes = payload['score'].get('notes')
            files[name] = {'song': int(name.split('_')[0]),
                           'diff': name.split('_')[1][:-5],
                           'sha256': digest, 'bytes': size,
                           'notes': len(notes) if isinstance(notes, list) else None}
            published.add(name)
        except Exception as exc:                        # 单个谱面坏掉不该拖垮整批
            print('  !! 谱面发布失败 %s: %s' % (name, exc))

    for old in os.listdir(dst_dir):                     # 清掉已不在来源里的旧文件
        if old not in published:
            os.remove(os.path.join(dst_dir, old))

    return {
        'generated': iso_now(),
        'count': len(files),
        'songs': len(set(v['song'] for v in files.values())),
        'diffs': list(CHART_DIFFS),
        'dir': 'charts/',                               # 完整地址：/data/charts/<文件名>
        'note': ('谱面数据，只含 meta / score 两个顶层键，数值原样。按 <曲目id>_<难度>.json 分文件。'
                 '注意：files[].notes 是 notes 数组长度，与 songs.json 的 combo（物量）不是同一个量。'),
        'source': 'game chart bundle（tools/fetch_charts.js 抓取并用 unitysrc 解包）',
        'files': files,
        'missing': sorted(n for n in wanted if n not in published),
    }


# ------------------------------------------------------------------ main
def main():
    # 同一时间只允许一个构建（并发会互相踩 tmp / 目录）
    global _LOCK
    try:
        import fcntl
        _LOCK = open('/tmp/on_webdata.lock', 'w')
        fcntl.flock(_LOCK, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print('另一个 build_webdata 正在跑，本次退出')
        return
    except ImportError:
        pass

    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(ROOT, 'data', 'web'))
    ap.add_argument('--pretty', action='store_true')
    args = ap.parse_args()

    t0 = time.time()
    t = text_map()

    songs = build_songs(t)
    cards = build_cards(t)
    songs_by_id = {str(s['id']): s for s in songs['songs']}
    events = build_events(t, songs_by_id)

    # 先写三份数据文件，再对它们算 sha256 塞进 version.json
    # 网页端门禁可以拿 fileDigests 钉死「线上数据没被换过」，比只比 dataVersion 硬
    digests = {}
    content_digests = {}
    for name, payload in (('songs.json', songs), ('cards.json', cards),
                          ('events.json', events)):
        path, size = write_json(args.out, name, payload, args.pretty)
        with open(path, 'rb') as fh:
            digests[name] = {'sha256': hashlib.sha256(fh.read()).hexdigest(),
                             'bytes': size}
        content_digests[name] = content_digest(payload)
        print('  %-14s %8.1f KB  \u2192  %s' % (name, size / 1024.0, path))

    # 谱面：发布到 <out>/charts/，并生成清单 charts.json
    charts = publish_charts(args.out, songs)
    cpath, csize = write_json(args.out, 'charts.json', charts, args.pretty)
    with open(cpath, 'rb') as fh:
        digests['charts.json'] = {'sha256': hashlib.sha256(fh.read()).hexdigest(), 'bytes': csize}
    content_digests['charts.json'] = content_digest(charts)
    print('  %-14s %8.1f KB  \u2192  %s（%d 份谱面%s）' % (
        'charts.json', csize / 1024.0, cpath, charts['count'],
        '，缺 %d 份' % len(charts['missing']) if charts['missing'] else ''))

    ver = {
        'dataVersion': data_version(),
        'updatedAt': iso_now(),
        'counts': {'songs': songs['count'],
                   'characters': cards['counts']['characters'],
                   'memberCards': cards['counts']['memberCards'],
                   'supportCards': cards['counts']['supportCards'],
                   'events': events['count'],
                   'charts': charts['count']},
        'files': ['songs.json', 'cards.json', 'events.json', 'charts.json'],
        'charts': {'manifest': 'charts.json', 'dir': 'charts/',
                   'count': charts['count'], 'songs': charts['songs'],
                   'missing': charts['missing']},
        'fileDigests': digests,
        'contentDigests': content_digests,
        'source': '\u6e38\u620f\u4e3b\u6570\u636e Master*\uff08tools/on_master.js \u6bcf 6 \u5c0f\u65f6\u5237\u65b0\uff09',
        'images': 'not-available',      # \u66f2\u7ed8 / \u5361\u9762 / \u6d3b\u52a8\u56fe\u90fd\u4e0d\u53d1
        'generatedBy': 'tools/build_webdata.py',
    }
    path, size = write_json(args.out, 'version.json', ver, args.pretty)
    print('  %-14s %8.1f KB  \u2192  %s' % ('version.json', size / 1024.0, path))
    print('汇总：曲 %d / 角色 %d / 成员卡 %d / 留影卡 %d / 活动 %d（%.2fs）'
          % (songs['count'], cards['counts']['characters'], cards['counts']['memberCards'],
             cards['counts']['supportCards'], events['count'], time.time() - t0))


if __name__ == '__main__':
    main()
