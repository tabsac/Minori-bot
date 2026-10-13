#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本机 API 转发：127.0.0.1:8080 → https://on.tabsac.com

网页与账号库搬到东京后，阿里云这台的 bot 仍按老样子调 http://127.0.0.1:8080/api/internal/*。
这里起一个只监听本机的转发，把请求送到东京（保持「只有本机能调」的性质，bot 代码一个字不改）。
"""
import http.client
import http.server
import json
import os
import socketserver
import ssl
import sys

UPSTREAM_HOST = os.environ.get('ON_API_UPSTREAM_HOST', 'on.tabsac.com')
LISTEN_PORT = int(os.environ.get('ON_API_PORT', '8080'))

ctx = ssl.create_default_context()
if os.environ.get('ON_API_INSECURE') == '1':
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def _proxy(self, method):
        length = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(length) if length else None
        headers = {k: v for k, v in self.headers.items()
                   if k.lower() not in ('host', 'connection', 'content-length')}
        headers['Host'] = UPSTREAM_HOST
        conn = None
        try:
            conn = http.client.HTTPSConnection(UPSTREAM_HOST, 443, context=ctx, timeout=15)
            conn.request(method, self.path, body=body, headers=headers)
            resp = conn.getresponse()
            data = resp.read()
            status, hdrs = resp.status, resp.getheaders()
        except Exception as exc:
            msg = json.dumps({'error': 'forward_failed', 'message': str(exc)},
                             ensure_ascii=False).encode('utf-8')
            self.send_response(502)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(msg)))
            self.end_headers()
            if method != 'HEAD':
                self.wfile.write(msg)
            sys.stderr.write('[forward] 失败: %s %s -> %s\n' % (method, self.path, exc))
            return
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass
        self.send_response(status)
        for k, v in hdrs:
            if k.lower() in ('transfer-encoding', 'connection', 'content-length'):
                continue
            self.send_header(k, v)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        if method != 'HEAD':
            self.wfile.write(data)

    def do_GET(self):
        self._proxy('GET')

    def do_POST(self):
        self._proxy('POST')

    def do_HEAD(self):
        self._proxy('HEAD')

    def do_DELETE(self):
        self._proxy('DELETE')

    def do_PUT(self):
        self._proxy('PUT')

    def log_message(self, fmt, *args):
        sys.stderr.write('[forward] ' + (fmt % args) + '\n')


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == '__main__':
    srv = ThreadingServer(('127.0.0.1', LISTEN_PORT), Handler)
    print('api forward: 127.0.0.1:%d -> https://%s' % (LISTEN_PORT, UPSTREAM_HOST))
    srv.serve_forever()
