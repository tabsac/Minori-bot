// ==================== cookie_server.js - 接收App提交的bilibilicookie ====================
// 独立HTTPS服务，端口9443，接收POST /cookie 写入 data/bilibili_cookie.txt
// 自签证书 /etc/nginx/ssl/self.crt + self.key（已生成）
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = 9443;
const CERT = '/etc/nginx/ssl/self.crt';
const KEY = '/etc/nginx/ssl/self.key';
const COOKIE_FILE = path.join(__dirname, 'data', 'bilibili_cookie.txt');
// 简单鉴权key（App填 cookie时附带，防陌生人乱写）
const AUTH_KEY = (process.env.MINORI_AUTH_KEY || '');

const server = https.createServer({
    cert: fs.readFileSync(CERT),
    key: fs.readFileSync(KEY)
}, (req, res) => {
    // 处理 POST /cookie?key=xxx，body为 cookie 明文
    if (req.method === 'POST' && req.url.startsWith('/cookie')) {
        const u = new URL(req.url, 'http://x');
        if (u.searchParams.get('key') !== AUTH_KEY) {
            res.writeHead(403, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ status: 'forbidden' }));
            return;
        }
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                // 允许 JSON {cookie: "..."} 或纯文本
                let cookie = body;
                try { const j = JSON.parse(body); if (j.cookie) cookie = j.cookie; } catch (e) {}
                cookie = String(cookie).trim();
                if (!cookie) { res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ status: 'error', message: 'empty cookie' })); return; }
                fs.mkdirSync(path.dirname(COOKIE_FILE), { recursive: true });
                fs.writeFileSync(COOKIE_FILE, cookie, 'utf8');
                console.log('📺 cookie 已更新到 ' + COOKIE_FILE + '（长度 ' + cookie.length + '）');
                res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ status: 'ok', saved: true }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ status: 'error', message: e.message }));
            }
        });
        return;
    }
    // 其他路径
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ status: 'not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('📺 cookie HTTPS 服务已启动: https://0.0.0.0:' + PORT + '/cookie?key=' + AUTH_KEY);
});
