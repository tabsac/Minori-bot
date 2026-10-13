#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""官服（官服 = 鹰角官方服）登录态 + 公开名片查询

链路完全按 2026-10-02 的抓包结论（见 ark-frida/ 交付物 + ARK-抓包结论-官服.md）：
  ① POST {as}/user/oauth2/v2/grant            → data.code（extension 里要用的 code）
  ② POST {as}/u8/user/v1/getToken              → uid（游戏 uid）+ token（u8 token）；sign 服务端不校验，不传
  ③ POST {gs}/account/login                    → secret（每次会话都换）
  ④ POST {gs}/social/searchPlayer  头 uid/secret/seqnum   → 别人的公开名片（最多 10 个/次）
     POST {gs}/social/getSortListInfo           → 按昵称搜 uid

用法：
  python ark_player.py login                      # 跑一遍链路，打印 uid/secret/设备号
  python ark_player.py uid <UID>                   # 按 UID 查名片
  python ark_player.py search <昵称> [--nick-number 1234]
  python ark_player.py raw <service/method> '<json body>'
"""
import argparse
import asyncio
import base64
import json
import os
import random
import string
import sys
import time

import aiohttp

AS = 'https://as.hypergryph.com'
U8 = AS + '/u8'
GS = 'https://ak-gs-gf.hypergryph.com'
APP_CODE_SDK = '7318def77669979d'          # 抓包得到的 SDK appCode（不是 launcher 的 GzD1...）
UA_SDK = 'okhttp/3.12.1'
UA_GAME = 'BestHTTP'
AUTH_FILE = os.environ.get('ARK_HG_AUTH') or '/home/admin/bot/data/ark/hg_auth.json'
SESSION_FILE = os.environ.get('ARK_GF_SESSION') or '/home/admin/bot/data/ark/gf_session.json'
CONF_VER = 'https://ak-conf.hypergryph.com/config/prod/official/Android/version'


def read_json(p, d=None):
    try:
        with open(p, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return d


def write_json(p, o, mode=0o600):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(o, f, ensure_ascii=False)
    try:
        os.chmod(p, mode)
    except Exception:
        pass


def rand_hex(n):
    return ''.join(random.choice('0123456789abcdef') for _ in range(n))


def device_token():
    """grant 里的 deviceToken：抓包里是 16 字符 base64（12 字节）。服务端查得不严，先给个随机值。"""
    return base64.b64encode(bytes(random.getrandbits(8) for _ in range(12))).decode()


async def post(url, body, headers=None, timeout=25):
    h = {'Content-Type': 'application/json', 'Accept-Encoding': 'gzip'}
    if headers:
        h.update(headers)
    async with aiohttp.ClientSession() as s:
        async with s.post(url, json=body, headers=h, timeout=timeout) as r:
            txt = await r.text()
            try:
                return r.status, json.loads(txt)
            except Exception:
                return r.status, {'_raw': txt[:400]}


async def get_json(url, headers=None, timeout=20):
    h = {'Accept-Encoding': 'gzip'}
    if headers:
        h.update(headers)
    async with aiohttp.ClientSession() as s:
        async with s.get(url, headers=h, timeout=timeout) as r:
            try:
                return r.status, json.loads(await r.text())
            except Exception:
                return r.status, {}


async def versions():
    """资源/客户端版本：ak-conf 现取；udtVersion 从主数据版本串里来（v077 → 77.0.0）。"""
    st, d = await get_json(CONF_VER)
    res = (d or {}).get('resVersion') or '26-09-22-07-47-20_6c71fa'
    cli = (d or {}).get('clientVersion') or '2.7.71'
    udt = '77.0.0'
    try:
        with open('/home/admin/bot/data/ark/tables/data_version.txt', encoding='utf-8') as f:
            txt = f.read()
        import re
        m = re.search(r'/v(\d+)/', txt)
        if m:
            udt = '%d.0.0' % int(m.group(1))
    except Exception:
        pass
    return res, cli, udt


async def full_login(verbose=True):
    """跑完整链路：grant → getToken → account/login → secret（并落盘会话）"""
    auth = read_json(AUTH_FILE, {}) or {}
    acc_token = auth.get('token')
    if not acc_token:
        raise SystemExit('未登录鹰角账号：先跑 tools/ark_player.py send/verify 拿账号 token')
    sess = read_json(SESSION_FILE, {}) or {}
    dev = sess.get('deviceId') or rand_hex(32)

    # ① grant：拿 extension 要用的 code
    gbody = {'token': acc_token, 'type': 0, 'appCode': APP_CODE_SDK, 'deviceToken': device_token()}
    ghead = {'User-Agent': UA_SDK, 'X-Captcha-Version': '4.0', 'X-DeviceModel': (sess.get('deviceModel') or 'PCHM30'),
             'X-DeviceType': '1', 'X-OSVer': '11', 'X-DeviceId': dev}
    st, g = await post(AS + '/user/oauth2/v2/grant', gbody, ghead)
    gd = (g or {}).get('data') or {}
    code = gd.get('code')
    if not code:
        return {'ok': False, 'step': 'grant', 'http': st, 'resp': g}
    channel_uid = gd.get('uid') or ''

    # ② getToken：extension = {code, isSuc, type:1}（sign 不校验，不传）
    ext = json.dumps({'code': code, 'isSuc': True, 'type': 1}, separators=(',', ':'))
    tbody = {'appId': '1', 'channelId': '1', 'extension': ext, 'worldId': '1', 'platform': 1,
             'subChannel': '1', 'deviceId': dev, 'deviceId2': '', 'deviceId3': ''}
    st2, t = await post(U8 + '/user/v1/getToken', tbody, {'User-Agent': UA_GAME})
    uid, u8token = (t or {}).get('uid'), (t or {}).get('token')
    if not uid or not u8token:
        return {'ok': False, 'step': 'getToken', 'http': st2, 'resp': t}

    # ③ account/login：u8 token → secret
    res, cli, udt = await versions()
    lbody = {'uid': uid, 'token': u8token, 'assetsVersion': res, 'clientVersion': cli, 'platform': 1,
             'deviceId': dev, 'deviceId2': '', 'deviceId3': '', 'networkVersion': '5', 'udtVersion': udt}
    st3, l = await post(GS + '/account/login', lbody, {'User-Agent': UA_GAME, 'seqnum': '0'})
    secret = (l or {}).get('secret')
    if not secret:
        return {'ok': False, 'step': 'account/login', 'http': st3, 'resp': l}
    out = {'ok': True, 'uid': uid, 'secret': secret, 'deviceId': dev, 'seqnum': 1,
           'assetsVersion': res, 'clientVersion': cli, 'udtVersion': udt,
           'channelUid': channel_uid, 'at': int(time.time())}
    write_json(SESSION_FILE, out)
    if verbose:
        print(json.dumps({'ok': True, 'uid': uid, 'secret': secret[:20] + '…', 'channelUid': channel_uid,
                          'assetsVersion': res, 'clientVersion': cli, 'udtVersion': udt}, ensure_ascii=False))
    return out


async def ensure_session(force=False):
    sess = read_json(SESSION_FILE, {}) or {}
    fresh = sess.get('secret') and (time.time() - (sess.get('at') or 0) < 20 * 60)
    if fresh and not force:
        return sess
    return await full_login(verbose=False)


async def gs_call(service_path, body, retry=True):
    """带 uid/secret/seqnum 的游戏服请求；secret 失效自动重登一次"""
    sess = await ensure_session()
    if not sess.get('secret'):
        return {'error': 'no-session', 'detail': sess}
    seq = int(sess.get('seqnum') or 1)
    head = {'User-Agent': UA_GAME, 'uid': str(sess['uid']), 'secret': sess['secret'], 'seqnum': str(seq)}
    st, d = await post(GS + '/' + service_path.lstrip('/'), body, head)
    sess['seqnum'] = seq + 1
    write_json(SESSION_FILE, sess)
    msg = ((d or {}).get('message') or '')
    if retry and st == 401 and 'session' in msg.lower():
        await full_login(verbose=False)
        return await gs_call(service_path, body, retry=False)
    return {'http': st, 'resp': d}


def slim_player(p):
    """压成渲染要的字段"""
    def fmt_ts(t):
        try:
            return time.strftime('%Y-%m-%d %H:%M', time.localtime(int(t))) if t else ''
        except Exception:
            return ''

    def fmt_date(t):
        try:
            return time.strftime('%Y-%m-%d', time.localtime(int(t))) if t else ''
        except Exception:
            return ''

    assists = []
    for c in [x for x in (p.get('assistCharList') or []) if x]:   # 自己的号里可能有 null 占位
        skills = c.get('skills') or []
        idx = int(c.get('skillIndex') or 0)
        cur = skills[idx] if 0 <= idx < len(skills) else (skills[-1] if skills else {})
        equips = c.get('equip') or {}
        cur_equip = c.get('currentEquip') or ''
        equip_lv = ((equips.get(cur_equip) or {}).get('level')) if cur_equip else None
        assists.append({
            'char_id': c.get('charId'), 'skin_id': c.get('skinId'),
            'level': c.get('level'), 'evolve_phase': c.get('evolvePhase'),
            'potential_rank': c.get('potentialRank'), 'favor_point': c.get('favorPoint'),
            'main_skill_lvl': c.get('mainSkillLvl'),
            'skill_id': cur.get('skillId'), 'specialize': cur.get('specializeLevel'),
            'equip_id': cur_equip, 'equip_lvl': equip_lv,
        })
    eq = p.get('equipStatus') or {}
    bd = p.get('birthday') or {}
    teams = p.get('teamV2') or {}
    return {
        'uid': str(p.get('uid') or ''), 'nickname': p.get('nickName') or '', 'nick_number': p.get('nickNumber') or '',
        'level': p.get('level'), 'server_name': p.get('serverName') or '', 'friend_num_limit': p.get('friendNumLimit'),
        'secretary': p.get('secretary') or '', 'secretary_skin_id': p.get('secretarySkinId') or '',
        'avatar_id': p.get('avatarId') or '', 'avatar': p.get('avatar') or {},
        'last_online_time': p.get('lastOnlineTime'), 'last_online_text': fmt_ts(p.get('lastOnlineTime')),
        'birthday': (('%d月%d日' % (bd.get('month'), bd.get('day'))) if bd.get('month') else ''),
        # ---- 只有「好友」这条接口（social/getFriendList）才有的字段 ----
        'register_ts': p.get('registerTs'), 'register_text': fmt_date(p.get('registerTs')),
        'resume': p.get('resume') or '', 'char_cnt': p.get('charCnt'), 'skin_cnt': p.get('skinCnt'),
        'furn_cnt': p.get('furnCnt'), 'main_stage_progress': p.get('mainStageProgress') or '',
        'teams': teams, 'rich_card': bool(p.get('registerTs') or teams),
        'equip_status': {'unlock': eq.get('unlockCnt'), 'limited': eq.get('limitedEquipCnt'),
                         'level3': eq.get('level3EquipCnt'), 'chars': eq.get('equipCharCnt'),
                         'limited_chars': eq.get('limitedCharCnt')},
        'medal': {'type': (p.get('medalBoard') or {}).get('type'), 'count': len(((p.get('medalBoard') or {}).get('custom') or {}).get('layout') or [])},
        'skin_selected': (p.get('skin') or {}).get('selected') or '',
        'magazine_count': len(p.get('magazineBoard') or []),
        'activity': p.get('activity') or {},
        'assist': assists,
        'raw_keys': list(p.keys()),
    }


async def enrich_friends(players):
    """把 social/getFriendList 里的「好友完整名片」并进 searchPlayer 的结果。

    searchPlayer 对任何人都能查，但只有基础字段；getFriendList 只有好友（和自己）才有
    registerTs / resume / charCnt / skinCnt / furnCnt / teamV2（阵营收集）。两边并起来取并集。
    """
    ids = [p['uid'] for p in players if p.get('uid')]
    if not ids:
        return players, None
    r = await gs_call('social/getFriendList', {'idList': ids})
    if r.get('error'):
        return players, r.get('error')
    full = {}
    for f in ((r.get('resp') or {}).get('friends') or []):
        if f and f.get('uid'):
            full[str(f['uid'])] = slim_player(f)
    for i, p in enumerate(players):
        f = full.get(p['uid'])
        if not f:
            continue
        merged = dict(p)
        for k, v in f.items():
            if v not in (None, '', {}, [], 0) or k in ('char_cnt', 'skin_cnt', 'furn_cnt'):
                merged[k] = v
        merged['rich_card'] = True
        players[i] = merged
    return players, None


async def cmd_uid(uid):
    r = await gs_call('social/searchPlayer', {'idList': [str(uid)]})
    if r.get('error'):
        print(json.dumps({'ok': False, 'error': r['error'], 'detail': r.get('detail')}, ensure_ascii=False)); return
    d = r.get('resp') or {}
    players = [slim_player(p) for p in (d.get('players') or []) if p]
    players, ferr = await enrich_friends(players)
    print(json.dumps({'ok': bool(players), 'count': len(players), 'players': players,
                      'friend_error': ferr, 'rich': bool(players and players[0].get('rich_card')),
                      'http': r.get('http'), 'raw': (d if not players else None)}, ensure_ascii=False)[:20000])


async def cmd_search(nick, nick_number=''):
    r = await gs_call('social/getSortListInfo', {'type': 0, 'sortKeyList': ['level'],
                                                'param': {'nickName': nick, 'nickNumber': nick_number}})
    if r.get('error'):
        print(json.dumps({'ok': False, 'error': r['error'], 'detail': r.get('detail')}, ensure_ascii=False)); return
    ids = [(x.get('uid'), x.get('level')) for x in ((r.get('resp') or {}).get('result') or []) if x.get('uid')]
    if not ids:
        print(json.dumps({'ok': False, 'error': 'not-found', 'http': r.get('http'), 'resp': r.get('resp')}, ensure_ascii=False)); return
    r2 = await gs_call('social/searchPlayer', {'idList': [u for u, _ in ids[:10]]})
    players = [slim_player(p) for p in (((r2.get('resp') or {}).get('players')) or []) if p]
    players, _ferr = await enrich_friends(players)
    # 完全同名的排前面
    players.sort(key=lambda p: (p['nickname'] != nick, -int(p.get('level') or 0)))
    print(json.dumps({'ok': bool(players), 'count': len(players), 'players': players, 'http': r2.get('http')}, ensure_ascii=False)[:20000])


async def cmd_raw(path, body_text):
    try:
        body = json.loads(body_text)
    except Exception:
        print(json.dumps({'ok': False, 'error': 'bad-json'}, ensure_ascii=False)); return
    r = await gs_call(path, body)
    print(json.dumps(r, ensure_ascii=False)[:8000])


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('login')
    p1 = sub.add_parser('uid'); p1.add_argument('query')
    p2 = sub.add_parser('search'); p2.add_argument('query'); p2.add_argument('--nick-number', default='')
    p3 = sub.add_parser('raw'); p3.add_argument('path'); p3.add_argument('body')
    # 老接口：短信登录（第一次拿账号 token）
    p4 = sub.add_parser('send'); p4.add_argument('phone')
    p5 = sub.add_parser('verify'); p5.add_argument('phone'); p5.add_argument('code')
    args = ap.parse_args()

    if args.cmd == 'login':
        asyncio.run(full_login(verbose=True)); return
    if args.cmd == 'uid':
        asyncio.run(cmd_uid(args.query)); return
    if args.cmd == 'search':
        asyncio.run(cmd_search(args.query, args.nick_number)); return
    if args.cmd == 'raw':
        asyncio.run(cmd_raw(args.path, args.body)); return
    if args.cmd == 'send':
        st, d = asyncio.run(post(AS + '/general/v1/send_phone_code', {'phone': args.phone, 'type': 2}))
        print(json.dumps({'http': st, 'resp': d}, ensure_ascii=False)); return
    if args.cmd == 'verify':
        st, d = asyncio.run(post(AS + '/user/auth/v2/token_by_phone_code', {'phone': args.phone, 'code': args.code}))
        tok = ((d or {}).get('data') or {}).get('token')
        if not tok:
            print(json.dumps({'ok': False, 'http': st, 'resp': d}, ensure_ascii=False)); return
        st2, b2 = asyncio.run(get_json(AS + '/user/info/v1/basic?token=' + tok))
        data2 = (b2 or {}).get('data') or {}
        write_json(AUTH_FILE, {'uid': data2.get('uid') or data2.get('hgId'), 'token': tok,
                               'phone': args.phone, 'at': int(time.time())})
        print(json.dumps({'ok': True, 'uid': data2.get('uid') or data2.get('hgId'),
                          'phone': data2.get('phone'), 'token_len': len(tok)}, ensure_ascii=False)); return


if __name__ == '__main__':
    main()
