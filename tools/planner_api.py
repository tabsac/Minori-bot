#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Our Notes 网页版后端 v2：**账号 + 密码** 登录，可选 **QQ 绑定**（绑定要机器人验证码）。

在 v1（机器人一次性码直登）基础上扩展，v1 的 `POST /api/login {code}` 仍然能用（老用户平滑：
用码登录时会自动找到/创建该 QQ 对应的账号）。

环境变量（data/api/api.env，0600）：
  ON_API_DB / ON_API_PORT / ON_ALLOWED_ORIGIN / ON_BOT_SECRET / ON_WEB_URL
接口：
  GET    /data/version.json                    数据版本 / 探活（真实数据，来自 data/web/）
  GET    /data/songs.json                      曲库（87 首，含四难度）
  GET    /data/cards.json                      角色 / 成员卡 / 留影卡 / 等级倍率表
  GET    /data/events.json                     活动（当期 + 加成 / PickUp / 点数奖励）
  POST   /api/register    {username,password}   注册 → {token, account}
  POST   /api/login       {username,password}   登录 → {token, account}
  POST   /api/login       {code}                （兼容 v1）QQ 码登录 → {token, account}
  POST   /api/logout                            退出（撤销当前 token）
  GET    /api/me                               当前账号 {id,username,qq,createdAt}
  POST   /api/account/password {oldPassword,newPassword}
  POST   /api/bind/qq/start  {qq}               生成绑定码 → {code,expiresIn}（去机器人里发 /on绑定网页 <码>）
  POST   /api/bind/qq/remove                    解绑 QQ
  POST   /api/results  /api/results/<id>        结果 CRUD（归属 = 账号）
  内部（仅 127.0.0.1 + X-Bot-Secret）：
  POST   /api/internal/bind-qq    {code,qq}     机器人兑换绑定码
  POST   /api/internal/login-code {qq}          （兼容 v1）机器人发登录码

隐私口径（用户拍板）：
  · 服务器只存「可公开的运算结果」+ 本站自己的登录凭据（用户名 / PBKDF2 哈希 / 绑定的 QQ）。
  · **不存任何游戏侧凭据**：落库前 strip_secrets() 递归剔除 access_key / id_token / credential /
    udid / mid / session 之类字段；命中时响应回 stripped 列表并打一行日志（日志不含 IP）。
  · 展示字段（玩家名、资料ID）保留 —— 那张成绩卡本来就是要给人看的。
  · 限流计数只在内存（不落盘）；nginx 访问日志自定义格式，**不含 IP**。
  · 账号密码只保护「在本站查询自己的结果」，即使被拿到也只影响本站。
"""
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import time
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DB_PATH = os.environ.get("ON_API_DB", "data/api/accounts.db")
# 只读数据的目录（tools/build_webdata.py 的产物）：songs/cards/events/version.json
WEB_DIR = os.environ.get("ON_WEB_DATA",
                         os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "web"))
DATA_FILES = {"version.json", "songs.json", "cards.json", "events.json", "charts.json"}
# 谱面文件：只有 <数字id>_<难度>.json 这一种形状，正则挡掉一切穿越尝试
CHART_NAME_RE = re.compile(r"^\d{3,8}_(EASY|NORMAL|HARD|EXPERT)\.json$")     # 白名单，杜绝路径穿越
PORT = int(os.environ.get("ON_API_PORT", "8080"))
ALLOWED_ORIGIN = os.environ.get("ON_ALLOWED_ORIGIN", "")
BOT_SECRET = os.environ.get("ON_BOT_SECRET", "")
MAX_PAYLOAD = 256 * 1024
MAX_RESULTS = 200
TOKEN_TTL = 30 * 24 * 3600
CODE_TTL = 300          # QQ 登录码
BIND_TTL = 600          # QQ 绑定码
PBKDF2_ROUNDS = 200000
USER_RE = re.compile(r"^[A-Za-z0-9_.\-]{3,24}$")
FAIL_LIMIT, FAIL_WINDOW = 10, 600
_fails = {}             # {(key): [timestamps]} —— 简单的登录失败限流（进程内）

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY, username TEXT NOT NULL, username_lc TEXT NOT NULL UNIQUE,
  pwd TEXT NOT NULL, qq TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_qq ON accounts(qq) WHERE qq IS NOT NULL;
CREATE TABLE IF NOT EXISTS tokens (
  token TEXT PRIMARY KEY, account_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS results (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS results_owner ON results(owner, created_at DESC);
CREATE TABLE IF NOT EXISTS login_codes (
  code TEXT PRIMARY KEY, qq TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS bind_codes (
  code TEXT PRIMARY KEY, account_id TEXT NOT NULL, qq TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
"""


def now():
    return int(time.time())


def compact(value):
    """必须和浏览器 JSON.stringify 一致（无空格），否则 size 对不上（v1 踩过：10141 → 11163）。"""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


# ---------------------------------------------------------------- 只存「可公开」的内容
# 服务器把每条结果都当成「可以公开的运算结果」来存（用户定的原则）。所以落库前先过一道筛子：
# 抓包/账号包里的鉴权字段绝不允许进库（它们在库里就等于把游戏账号交出去）。展示字段（玩家名、资料ID）保留。
SECRET_KEYS = {
    "access_key", "accesskey", "access_token", "accesstoken", "id_token", "idtoken",
    "refresh_token", "refreshtoken", "credential", "credentials", "token", "auth",
    "authorization", "password", "passwd", "pwd", "secret", "sign", "signature",
    "session", "session_id", "sessionid", "ssid", "udid", "device_id", "deviceid",
    "mid", "openid", "open_id", "cookie", "cookies", "private_key", "privatekey",
}
# 复合键名（myPassword / myAccessKey / userIdToken…）按词拆开判断，避免只认整名
SENSITIVE_WORDS = {
    "password", "passwd", "pwd", "token", "secret", "credential", "credentials",
    "signature", "sign", "cookie", "cookies", "udid", "openid", "ssid", "authorization",
}


def _key_parts(key):
    text = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", str(key))
    return [p for p in re.split(r"[^A-Za-z0-9]+", text.lower()) if p]


def is_secret_key(key):
    """判断这个键名是不是「鉴权类」（会被剔除）。宁可多删一个可疑字段，也不让凭据进库。"""
    low = str(key).strip().lower()
    if low in SECRET_KEYS:
        return True
    parts = _key_parts(key)
    if not parts:
        return False
    if "".join(parts) in SECRET_KEYS:                 # idToken / sessionId / accessKey
        return True
    if any(p in SENSITIVE_WORDS for p in parts):      # MY_password / userSecret
        return True
    for n in (2, 3):                                  # myAccessKey / userIdToken
        for i in range(len(parts) - n + 1):
            if "".join(parts[i:i + n]) in SECRET_KEYS:
                return True
    return False


def strip_secrets(value, path="payload", out=None, depth=0):
    """递归删掉鉴权类字段，返回 (干净副本, 被删掉的路径列表)。只删键名可疑的，不动展示字段。"""
    if out is None:
        out = []
    if depth > 32:
        return value, out
    if isinstance(value, dict):
        clean = {}
        for k, v in value.items():
            here = path + "." + str(k)
            if is_secret_key(k):
                out.append(here)
                continue
            clean[k], _ = strip_secrets(v, here, out, depth + 1)
        return clean, out
    if isinstance(value, list):
        return [strip_secrets(v, path + "[%d]" % i, out, depth + 1)[0] for i, v in enumerate(value)], out
    return value, out


def db():
    os.makedirs(os.path.dirname(os.path.abspath(DB_PATH)), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init():
    with closing(db()) as conn, conn:
        conn.executescript(SCHEMA)


# ---------------------------------------------------------------- 账号与密码
def hash_pwd(password):
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ROUNDS)
    return "pbkdf2_sha256$%d$%s$%s" % (PBKDF2_ROUNDS, base64.b64encode(salt).decode(), base64.b64encode(dk).decode())


def check_pwd(stored, password):
    try:
        algo, rounds, salt_b64, hash_b64 = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), base64.b64decode(salt_b64), int(rounds))
        return hmac.compare_digest(dk, base64.b64decode(hash_b64))
    except Exception:
        return False


def account_public(row):
    return {"id": row["id"], "username": row["username"], "qq": row["qq"], "createdAt": row["created_at"]}


def make_token(conn, account_id):
    token = secrets.token_urlsafe(32)
    conn.execute("INSERT INTO tokens VALUES (?,?,?,?)", (token, account_id, now(), now() + TOKEN_TTL))
    return token


def find_or_create_account_for_qq(conn, qq):
    """v1 兼容：用 QQ 码登录时，找到/创建该 QQ 的账号（用户名 qq_xxxx，随机密码）。"""
    row = conn.execute("SELECT * FROM accounts WHERE qq=?", (str(qq),)).fetchone()
    if row:
        return row
    aid = "acc_" + secrets.token_hex(6)
    username = "qq_" + str(qq)
    conn.execute("INSERT INTO accounts VALUES (?,?,?,?,?,?,?)",
                 (aid, username, username.lower(), hash_pwd(secrets.token_urlsafe(16)), str(qq), now(), now()))
    return conn.execute("SELECT * FROM accounts WHERE id=?", (aid,)).fetchone()


def rate_limited(key):
    hits = [t for t in _fails.get(key, []) if t > now() - FAIL_WINDOW]
    _fails[key] = hits
    return len(hits) >= FAIL_LIMIT


def note_fail(key):
    _fails.setdefault(key, []).append(now())


class Api(BaseHTTPRequestHandler):
    server_version = "ournotes-api/2"
    protocol_version = "HTTP/1.1"
    _raw = None        # 请求体只读一次并缓存：提前 return 的路径也不会有残留字节

    # ---------------------------------------------------------------- 工具
    def _send(self, status, body=None, extra=None):
        payload = b"" if body is None else compact(body).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            if ALLOWED_ORIGIN:
                self.send_header("Access-Control-Allow-Origin", ALLOWED_ORIGIN)
                self.send_header("Vary", "Origin")
            for key, value in (extra or {}).items():
                self.send_header(key, value)
            self.end_headers()
            if self.command != "HEAD" and payload:
                self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass          # 客户端提前断开（curl -o /dev/null 之类）不必打回溯

    def _fail(self, status, error, message):
        self._send(status, {"error": error, "message": message})

    def _serve_data(self, name):
        """只读数据文件：ETag 用「mtime-size」算，支持 If-None-Match → 304（省流量）"""
        p = os.path.join(WEB_DIR, name)
        try:
            st = os.stat(p)
            raw = open(p, "rb").read()
        except OSError:
            return self._fail(503, "no_data",
                              "数据还没生成：在服务器上跑 /usr/bin/python3 tools/build_webdata.py")
        etag = '"%x-%x"' % (int(st.st_mtime), st.st_size)
        if self.headers.get("If-None-Match") == etag:
            try:
                self.send_response(304)
                self.send_header("ETag", etag)
                self.send_header("Cache-Control", "no-cache" if name == "version.json" else "public, max-age=300")
                self.send_header("Content-Length", "0")
                self.end_headers()
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        try:
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", "no-cache" if name == "version.json" else "public, max-age=300")
            if ALLOWED_ORIGIN:
                self.send_header("Access-Control-Allow-Origin", ALLOWED_ORIGIN)
                self.send_header("Vary", "Origin")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _begin(self):
        """每个请求开头调用一次：连接是 keep-alive 复用的，缓存必须重置。"""
        self._raw = None
        return self._drain()

    def _drain(self):
        """把请求体读干净。HTTP/1.1 keep-alive 下，提前 return（401/403/404）而没读 body
        时残留字节会被当成下一个请求的请求行 —— 客户端（Node 19+ / 浏览器）复用连接就会串包。"""
        if self._raw is None:
            length = int(self.headers.get("Content-Length") or 0)
            try:
                self._raw = self.rfile.read(length) if length > 0 else b""
            except (ValueError, OSError):
                self._raw = b""
        return self._raw

    def _body(self):
        raw = self._drain()
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except ValueError:
            return None

    def do_OPTIONS(self):
        self._begin()
        self.send_response(204)
        if ALLOWED_ORIGIN:
            self.send_header("Access-Control-Allow-Origin", ALLOWED_ORIGIN)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, If-None-Match")
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _auth(self):
        header = self.headers.get("Authorization") or ""
        if not header.startswith("Bearer "):
            return None
        token = header[7:].strip()
        with closing(db()) as conn:
            row = conn.execute("SELECT t.account_id, t.expires_at, a.* FROM tokens t"
                               " JOIN accounts a ON a.id=t.account_id WHERE t.token=?", (token,)).fetchone()
        if not row or row["expires_at"] < now():
            return None
        return row, token

    def _is_local_bot(self):
        return (self.client_address[0] in ("127.0.0.1", "::1")
                and bool(BOT_SECRET) and self.headers.get("X-Bot-Secret") == BOT_SECRET)

    # ---------------------------------------------------------------- 路由
    def _route(self):
        self._begin()
        path = self.path.split("?", 1)[0]
        method = self.command
        ip = self.client_address[0]

        # ① 只读数据：真实文件（tools/build_webdata.py 生成）→ 带 ETag / 304
        #    HEAD 也走这里（只回头不回体），网页端/curl -I 都能拿到 ETag
        if (method in ("GET", "HEAD") and path.startswith("/data/charts/")
                and path.count("/") == 3):
            base = path[len("/data/charts/"):]
            if not CHART_NAME_RE.match(base):
                return self._fail(404, "not_found", "没有这个谱面文件")
            return self._serve_data("charts/" + base)

        if method in ("GET", "HEAD") and path.startswith("/data/") and path.count("/") == 2:
            name = path[len("/data/"):]
            if name not in DATA_FILES:
                return self._fail(404, "not_found", "没有这个数据文件")
            return self._serve_data(name)

        # ② 内部接口（仅本机机器人）
        if path.startswith("/api/internal/"):
            if not self._is_local_bot():
                return self._fail(403, "forbidden", "内部接口")
            body = self._body() or {}
            if path == "/api/internal/login-code":          # v1 兼容
                qq = str(body.get("qq") or "")
                if not qq:
                    return self._fail(422, "unprocessable", "缺少 qq")
                code = "%06d" % secrets.randbelow(1000000)
                with closing(db()) as conn, conn:
                    conn.execute("INSERT OR REPLACE INTO login_codes VALUES (?,?,?,0)", (code, qq, now() + CODE_TTL))
                return self._send(200, {"code": code, "expiresIn": CODE_TTL})
            if path == "/api/internal/bind-qq":
                code, qq = str(body.get("code") or "").strip(), str(body.get("qq") or "").strip()
                if not code or not qq:
                    return self._fail(422, "unprocessable", "缺少 code 或 qq")
                with closing(db()) as conn, conn:
                    row = conn.execute("SELECT * FROM bind_codes WHERE code=?", (code,)).fetchone()
                    if not row or row["used"] or row["expires_at"] < now():
                        return self._fail(401, "unauthorized", "绑定码不对或已过期")
                    if str(row["qq"]) != qq:
                        return self._fail(403, "forbidden", "这个码不是发给这个 QQ 的")
                    taken = conn.execute("SELECT username FROM accounts WHERE qq=? AND id<>?",
                                         (qq, row["account_id"])).fetchone()
                    if taken:
                        return self._fail(409, "conflict", "这个 QQ 已经绑过账号「%s」了" % taken["username"])
                    conn.execute("UPDATE bind_codes SET used=1 WHERE code=?", (code,))
                    conn.execute("UPDATE accounts SET qq=?, updated_at=? WHERE id=?",
                                 (qq, now(), row["account_id"]))
                    acc = conn.execute("SELECT username FROM accounts WHERE id=?", (row["account_id"],)).fetchone()
                return self._send(200, {"ok": True, "username": acc["username"] if acc else ""})
            return self._fail(404, "not_found", "没有这个内部接口")

        # ③ 注册
        if method == "POST" and path == "/api/register":
            body = self._body()
            if not isinstance(body, dict):
                return self._fail(422, "unprocessable", "请求体不是 JSON")
            username = str(body.get("username") or "").strip()
            password = str(body.get("password") or "")
            if not USER_RE.match(username):
                return self._fail(422, "unprocessable", "用户名 3–24 位，只能用字母数字和 _ . -")
            if len(password) < 8:
                return self._fail(422, "unprocessable", "密码至少 8 位")
            if rate_limited("reg:" + ip):
                return self._fail(429, "rate_limited", "操作太频繁，稍后再试")
            with closing(db()) as conn, conn:
                if conn.execute("SELECT 1 FROM accounts WHERE username_lc=?", (username.lower(),)).fetchone():
                    return self._fail(409, "conflict", "用户名已被占用")
                aid = "acc_" + secrets.token_hex(6)
                conn.execute("INSERT INTO accounts VALUES (?,?,?,?,NULL,?,?)",
                             (aid, username, username.lower(), hash_pwd(password), now(), now()))
                row = conn.execute("SELECT * FROM accounts WHERE id=?", (aid,)).fetchone()
                token = make_token(conn, aid)
            return self._send(201, {"token": token, "account": account_public(row), "expiresIn": TOKEN_TTL})

        # ④ 登录（账号密码 / v1 的 QQ 码）
        if method == "POST" and path == "/api/login":
            body = self._body()
            if not isinstance(body, dict):
                return self._fail(422, "unprocessable", "请求体不是 JSON")
            # v1：QQ 一次性码
            if body.get("code") and not body.get("username"):
                code = str(body["code"])
                with closing(db()) as conn, conn:
                    row = conn.execute("SELECT * FROM login_codes WHERE code=?", (code,)).fetchone()
                    if not row or row["used"] or row["expires_at"] < now():
                        return self._fail(401, "unauthorized", "登录码不对或已过期")
                    conn.execute("UPDATE login_codes SET used=1 WHERE code=?", (code,))
                    acc = find_or_create_account_for_qq(conn, row["qq"])
                    token = make_token(conn, acc["id"])
                return self._send(200, {"token": token, "account": account_public(acc), "expiresIn": TOKEN_TTL})
            # 账号 + 密码
            username = str(body.get("username") or "").strip()
            password = str(body.get("password") or "")
            key = "login:" + username.lower() + ":" + ip
            if rate_limited(key):
                return self._fail(429, "rate_limited", "密码错太多次了，10 分钟后再试")
            with closing(db()) as conn, conn:
                row = conn.execute("SELECT * FROM accounts WHERE username_lc=?", (username.lower(),)).fetchone()
                if not row or not check_pwd(row["pwd"], password):
                    note_fail(key)
                    return self._fail(401, "unauthorized", "用户名或密码不对")
                token = make_token(conn, row["id"])
            return self._send(200, {"token": token, "account": account_public(row), "expiresIn": TOKEN_TTL})

        # ⑤ 以下都要登录
        who = self._auth()
        if not who:
            return self._fail(401, "unauthorized", "未登录或登录已过期")
        acc, tok = who

        if method == "POST" and path == "/api/logout":
            with closing(db()) as conn, conn:
                conn.execute("DELETE FROM tokens WHERE token=?", (tok,))
            return self._send(204)

        if method == "GET" and path == "/api/me":
            return self._send(200, {"account": account_public(acc)})

        if method == "POST" and path == "/api/account/password":
            body = self._body() or {}
            old, new = str(body.get("oldPassword") or ""), str(body.get("newPassword") or "")
            if len(new) < 8:
                return self._fail(422, "unprocessable", "新密码至少 8 位")
            if not check_pwd(acc["pwd"], old):
                return self._fail(401, "unauthorized", "原密码不对")
            with closing(db()) as conn, conn:
                conn.execute("UPDATE accounts SET pwd=?, updated_at=? WHERE id=?", (hash_pwd(new), now(), acc["id"]))
                conn.execute("DELETE FROM tokens WHERE account_id=?", (acc["id"],))   # 改密后强制重新登录
            return self._send(204)

        if method == "POST" and path == "/api/bind/qq/start":
            body = self._body() or {}
            qq = str(body.get("qq") or "").strip()
            if not re.match(r"^\d{5,12}$", qq):
                return self._fail(422, "unprocessable", "QQ 号看起来不对")
            with closing(db()) as conn, conn:
                taken = conn.execute("SELECT username FROM accounts WHERE qq=? AND id<>?",
                                     (qq, acc["id"])).fetchone()
                if taken:
                    return self._fail(409, "conflict", "这个 QQ 已经绑过账号「%s」了" % taken["username"])
                code = "%06d" % secrets.randbelow(1000000)
                conn.execute("INSERT OR REPLACE INTO bind_codes VALUES (?,?,?,?,0)",
                             (code, acc["id"], qq, now() + BIND_TTL))
            return self._send(200, {"code": code, "expiresIn": BIND_TTL,
                                    "hint": "在机器人里发：/on绑定网页 %s" % code})

        if method == "POST" and path == "/api/bind/qq/remove":
            with closing(db()) as conn, conn:
                conn.execute("UPDATE accounts SET qq=NULL, updated_at=? WHERE id=?", (now(), acc["id"]))
            return self._send(204)

        # ⑥ 结果 CRUD（归属 = 账号）
        if path == "/api/results":
            if method == "GET":
                with closing(db()) as conn:
                    rows = conn.execute("SELECT id,title,summary,payload,created_at FROM results"
                                        " WHERE owner=? ORDER BY created_at DESC", (acc["id"],)).fetchall()
                return self._send(200, [{"id": r["id"], "title": r["title"], "summary": r["summary"],
                                         "createdAt": r["created_at"], "size": len(r["payload"].encode("utf-8"))}
                                        for r in rows])
            if method == "POST":
                body = self._body()
                if not isinstance(body, dict) or "payload" not in body:
                    return self._fail(422, "unprocessable", "缺少 payload")
                payload, stripped = strip_secrets(body["payload"])
                blob = compact(payload)
                if len(blob.encode("utf-8")) > MAX_PAYLOAD:
                    return self._fail(413, "too_large", "单条上限 256 KB")
                with closing(db()) as conn, conn:
                    count = conn.execute("SELECT COUNT(*) AS c FROM results WHERE owner=?",
                                         (acc["id"],)).fetchone()["c"]
                    if count >= MAX_RESULTS:
                        return self._fail(422, "too_many", "单个账号最多 %d 条" % MAX_RESULTS)
                    rid = "r_" + secrets.token_hex(6)
                    conn.execute("INSERT INTO results VALUES (?,?,?,?,?,1,?,?)",
                                 (rid, acc["id"], str(body.get("title") or ""), str(body.get("summary") or ""),
                                  blob, now(), now()))
                if stripped:
                    print("[strip] 新建 %s 时剔除鉴权字段 %d 个：%s"
                          % (rid, len(stripped), ", ".join(stripped[:8])), flush=True)
                    return self._send(201, {"id": rid, "version": 1,
                                            "stripped": stripped[:20],
                                            "notice": "服务器只保存可公开的运算结果，已剔除鉴权类字段"})
                return self._send(201, {"id": rid, "version": 1})

        if path.startswith("/api/results/"):
            rid = path[len("/api/results/"):]
            with closing(db()) as conn:
                row = conn.execute("SELECT * FROM results WHERE id=? AND owner=?", (rid, acc["id"])).fetchone()
            if not row:
                return self._fail(404, "not_found", "没有这条结果")
            if method == "GET":
                return self._send(200, {"id": row["id"], "title": row["title"], "summary": row["summary"],
                                        "payload": json.loads(row["payload"]), "version": row["version"],
                                        "createdAt": row["created_at"], "updatedAt": row["updated_at"]})
            if method == "PUT":
                body = self._body()
                if not isinstance(body, dict) or "payload" not in body:
                    return self._fail(422, "unprocessable", "缺少 payload")
                if int(body.get("version") or 0) != row["version"]:
                    return self._fail(409, "conflict", "另一端改过这条结果")
                payload, stripped = strip_secrets(body["payload"])
                blob = compact(payload)
                if len(blob.encode("utf-8")) > MAX_PAYLOAD:
                    return self._fail(413, "too_large", "单条上限 256 KB")
                with closing(db()) as conn, conn:
                    conn.execute("UPDATE results SET payload=?, version=version+1, updated_at=? WHERE id=?",
                                 (blob, now(), rid))
                    version = conn.execute("SELECT version FROM results WHERE id=?", (rid,)).fetchone()["version"]
                if stripped:
                    print("[strip] 更新 %s 时剔除鉴权字段 %d 个：%s"
                          % (rid, len(stripped), ", ".join(stripped[:8])), flush=True)
                    return self._send(200, {"version": version, "stripped": stripped[:20]})
                return self._send(200, {"version": version})
            if method == "DELETE":
                with closing(db()) as conn, conn:
                    conn.execute("DELETE FROM results WHERE id=?", (rid,))
                return self._send(204)

        return self._fail(404, "not_found", "没有这个接口：" + path)

    do_GET = do_POST = do_PUT = do_DELETE = do_HEAD = _route

    def log_message(self, fmt, *args):
        """访问日志里可能有 token —— 不打；要日志请自己过滤 Authorization。"""


if __name__ == "__main__":
    init()
    print("ournotes api v2 on http://127.0.0.1:%d  (db=%s)" % (PORT, DB_PATH), flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Api).serve_forever()
