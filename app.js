const WebSocket = require('ws');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const backendRules = require('./bot_group_routing')();
const backendReplyGate = backendRules.createReplyGate();
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

// ==================== 全局配置 ====================
const CONFIG = {
    BOT_NICKNAME: "Minori_1",
    WS_PORT: 6700,

    IMAGE_GROUPS: [
        {
            type: "full",
            name: "通用",
            saveKeywords: ["发图", "发发图"],
            showKeywords: ["看看图", "看图"],
            dir: "saved",
            saveSuccessMsg: "@{name} 图片已保存",
            saveFailMsg: "@{name} 保存图片失败，请重试",
            noImageMsg: "当前并没有保存任何图片，请使用“发图”功能发送图片",
            showPrefix: "@{name} ",
        },
        {
            type: "full",
            name: "奏",
            saveKeywords: ["发奏", "发发奏", "发发杯面", "发发走", "发走", "发杯面", "发knd", "发发knd", "发Kanade", "发发Kanade", "发发羽毛球", "发羽毛球"],
            showKeywords: ["看奏", "看看奏", "看看杯面", "看看走", "看走", "看杯面", "看knd", "看看knd", "看Kanade", "看看Kanade", "看看羽毛球", "看羽毛球"],
            dir: "kanade",
            saveSuccessMsg: "@{name} 图片已保存",
            saveFailMsg: "@{name} 保存图片失败，请重试",
            noImageMsg: "当前并没有保存任何图片，请使用“发图”功能发送图片",
            showPrefix: "@{name} ",
        },
        {
            type: "full",
            name: "马",
            saveKeywords: ["发马", "发发马", "发发🐴", "发发🐎", "发🐎", "发🐴", "发mfy", "发发mfy", "发Mafuyu", "发发Mafuyu", "发发烤鱿鱼", "发烤鱿鱼"],
            showKeywords: ["看马", "看看马", "看看🐴", "看看🐎", "看🐎", "看🐴", "看mfy", "看看mfy", "看Mafuyu", "看看Mafuyu", "看看烤鱿鱼", "看烤鱿鱼"],
            dir: "Mafuyu",
            saveSuccessMsg: "@{name} 图片已保存",
            saveFailMsg: "@{name} 保存图片失败，请重试",
            noImageMsg: "当前并没有保存任何图片，请使用“发图”功能发送图片",
            showPrefix: "@{name} ",
        },
        {
            type: "full",
            name: "糖",
            saveKeywords: ["发糖", "发发糖", "发发🍬", "发🍬", "发mzk", "发发mzk", "发Mizuki", "发发Mizuki"],
            showKeywords: ["看糖", "看看糖", "看看🍬", "看🍬", "看mzk", "看看mzk", "看Mizuki", "看看Mizuki"],
            dir: "Mizuki",
            saveSuccessMsg: "@{name} 图片已保存",
            saveFailMsg: "@{name} 保存图片失败，请重试",
            noImageMsg: "当前并没有保存任何图片，请使用“发图”功能发送图片",
            showPrefix: "@{name} ",
        },
        {
            type: "readonly",
            name: "吃什么",
            triggerKeywords: ["吃什么"],
            dir: "eatwhat",
            noImageMsg: "暂时没有吃什么相关图片",
            showPrefix: "@{name} ",
        },
    ],

    GROUP_DATA_BASE: path.join(__dirname, 'data', 'groups'),
    SHORT_INTERVAL_MS: 1000,
    LONG_COOLDOWN_MS: 60000,
    MAX_CONSECUTIVE: 5,
    POKE_SHORT_COOLDOWN_MS: 2000,
    POKE_LONG_COOLDOWN_MS: 60000,
    POKE_MAX_STRIKES: 5,
    IMAGE_BASE: path.join(__dirname, 'image'),
    POKE_RESPONSES_FILE: path.join(__dirname, 'data', 'poke_responses.json'),
};

const REPLY_MODIFIERS = []; // 修饰映射已清空（修饰交给 AstrBot AI 配合语）
// 屏蔽名单：这些 QQ 号发的消息不会被转发给任何下游（不触发 bot 回复）
const BLOCK_QOS = (process.env.BLOCK_QQS || '').split(',').map(x=>x.trim()).filter(Boolean);

function getMessagePlainText(message) {
    if (Array.isArray(message)) {
        return message
            .filter(s => s && s.type === 'text' && s.data && s.data.text)
            .map(s => s.data.text)
            .join('');
    }
    if (typeof message === 'string') return getPlainText(message);
    return '';
}

function messageToSegments(message) {
    if (Array.isArray(message)) return message.slice(); // 浅拷贝，避免原地修改原始报文
    if (typeof message === 'string') {
        const segs = [];
        const re = /\[CQ:[^\]]*\]/g;
        let last = 0, m;
        while ((m = re.exec(message)) !== null) {
            if (m.index > last) segs.push({ type: 'text', data: { text: message.slice(last, m.index) } });
            const inner = m[0].slice(4, -1);
            const parts = inner.split(',');
            const seg = { type: parts[0], data: {} };
            for (let i = 1; i < parts.length; i++) {
                const eq = parts[i].indexOf('=');
                if (eq > 0) seg.data[parts[i].slice(0, eq)] = parts[i].slice(eq + 1);
            }
            segs.push(seg);
            last = m.index + m[0].length;
        }
        if (last < message.length) segs.push({ type: 'text', data: { text: message.slice(last) } });
        return segs;
    }
    return [{ type: 'text', data: { text: String(message) } }];
}

function matchModifier(cond, plain) {
    if (!cond) return false;
    switch (cond.type) {
        case 'contains': return plain.includes(cond.text);
        case 'equals': return plain === cond.text;
        case 'regex':
            try { return new RegExp(cond.pattern).test(plain); } catch (e) { return false; }
        default: return false;
    }
}

// 最近一次转发给 haruki 的用户消息纯文本（供 trigger 兜底匹配）
let lastTriggerPlain = '';

function messageHasImage(message) {
    if (Array.isArray(message)) return message.some(s => s && s.type === 'image');
    if (typeof message === 'string') return /\[CQ:image[,\]]/.test(message);
    return false;
}

function messageImageUrls(message) {
    const urls = [];
    if (Array.isArray(message)) {
        for (const s of message) {
            if (s && s.type === 'image' && s.data) {
                if (s.data.url) urls.push(String(s.data.url));
                if (s.data.file) urls.push(String(s.data.file));
            }
        }
    } else if (typeof message === 'string') {
        const re = /\[CQ:image[^\]]*\]/g;
        let m;
        while ((m = re.exec(message)) !== null) {
            const inner = m[0].slice(4, -1);
            for (const part of inner.split(',')) {
                const eq = part.indexOf('=');
                if (eq > 0 && (part.slice(0, eq) === 'url' || part.slice(0, eq) === 'file')) urls.push(part.slice(eq + 1));
            }
        }
    }
    return urls;
}

// 回复报文特征匹配
function matchMessageCondition(cond, message) {
    if (!cond) return true;
    const plain = getMessagePlainText(message);
    switch (cond.type) {
        case 'imageOnly': // 纯图片（无文字）
            return messageHasImage(message) && plain.trim() === '';
        case 'hasImage':
            return messageHasImage(message);
        case 'imageUrlContains':
            return messageImageUrls(message).some(u => u.includes(cond.text));
        case 'imageUrlRegex':
            try { return messageImageUrls(message).some(u => new RegExp(cond.pattern).test(u)); } catch (e) { return false; }
        case 'contains':
        case 'textContains':
            return plain.includes(cond.text);
        case 'equals':
        case 'textEquals':
            return plain === cond.text;
        case 'regex':
        case 'textRegex':
            try { return new RegExp(cond.pattern).test(plain); } catch (e) { return false; }
        default:
            return false;
    }
}

function applyModifiers(message, triggerPlain, source) {
    for (const m of REPLY_MODIFIERS) {
        if (m.source && m.source !== source) continue; // 限定来源下游（如 haruki）；省略 = 作用于所有下游
        let hit = false;
        if (m.match) {
            // 特征优先：有 match 条件就以 match 为准，未命中不降级（防误配）
            hit = matchMessageCondition(m.match, message);
        } else if (m.trigger) {
            // 兜底：报文无特征时，按触发指令匹配
            hit = matchModifier(m.trigger, triggerPlain || '');
        }
        if (hit) {
            let segs = messageToSegments(message);
            for (const op of m.modify || []) {
                switch (op.op) {
                    case 'prependText':
                        segs.unshift({ type: 'text', data: { text: op.text } });
                        break;
                    case 'appendText':
                        segs.push({ type: 'text', data: { text: op.text } });
                        break;
                    case 'replaceText':
                        segs = segs.map(s => {
                            if (s && s.type === 'text' && s.data && s.data.text && s.data.text.includes(op.find)) {
                                return { type: 'text', data: { text: s.data.text.split(op.find).join(op.replace) } };
                            }
                            return s;
                        });
                        break;
                    case 'setText':
                        segs = [{ type: 'text', data: { text: op.text } }];
                        break;
                }
            }
            console.log(`✏️ 修饰命中[${m.name}]:`, JSON.stringify(segs).slice(0, 300));
            return segs;
        }
    }
    return message; // 未命中映射：原样转发
}

// 启动自检：验证映射配置是否生效（每次启动输出一行）
(function selfTestModifiers() {
    try {
        // 特征命中：图片 URL 含个人信息图文件名 → 应加字（且不依赖触发指令）
        const imgHit = [{ type: 'image', data: { file: 'https://example.invalid/images/sample.png' } }];
        const out1 = applyModifiers(imgHit, '');
        console.log('🔧 自检[特征命中→加字]:', JSON.stringify(out1).slice(0, 300));
        // 特征未命中：其它图片 → 原样转发
        const imgMiss = [{ type: 'image', data: { file: 'https://example.invalid/images/sample.png' } }];
        const out2 = applyModifiers(imgMiss, '[CQ:at,qq=0] /个人信息');
        console.log('🔧 自检[特征未命中→原样]:', JSON.stringify(out2).slice(0, 200));
    } catch (e) {
        console.error('🔧 修饰映射自检失败:', e.message);
    }
})();

// ==================== 房间存储（已移除房间管理命令） ====================

// ==================== 工具函数 ====================
function getKey(msg) {
    if (msg.message_type === 'private') return String(msg.sender.user_id);
    if (msg.message_type === 'group') return `${msg.group_id}_${msg.sender.user_id}`;
    return null;
}

function getSenderName(msg) {
    if (msg.message_type === 'private') return msg.sender.nickname || msg.sender.user_id;
    return msg.sender.card || msg.sender.nickname || msg.sender.user_id;
}

function sendReply(ws, action, params) {
    ws.send(JSON.stringify({ action, params }));
}

function getPlainText(raw) {
    if (!raw) return '';
    return raw.replace(/\[CQ:[^\]]*\]/g, '').trim();
}

function isValidNumber(str) {
    return /^-?\d+(\.\d+)?$/.test(str);
}

function downloadImage(url, destPath) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'GET',
            headers: { 'User-Agent': 'Mozilla/5.0' }
        };
        const req = https.get(options, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const buffer = Buffer.concat(chunks);
                fs.writeFile(destPath, buffer, (err) => {
                    if (err) reject(err);
                    else resolve(destPath);
                });
            });
        });
        req.on('error', reject);
    });
}

function getRandomImageFromDir(dirPath) {
    try {
        const files = fs.readdirSync(dirPath);
        const exts = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
        const images = files.filter(f => exts.includes(path.extname(f).toLowerCase()));
        if (images.length === 0) return null;
        return path.join(dirPath, images[Math.floor(Math.random() * images.length)]);
    } catch { return null; }
}

function imageCqFromPath(filePath) {
    return `[CQ:image,file=file:///${filePath.replace(/\\/g, '/')}]`;
}

// ==================== 图片/GIF 取源（本消息 or 引用消息）====================
// 从「消息段数组 或 CQ 字符串」里取第一张图片的 url/file（支持 image 图片/GIF 与 mface 表情包）
function imageSrcOf(message) {
    const types = [];
    if (Array.isArray(message)) {
        for (const s of message) {
            if (!s) continue;
            types.push(s.type);
            if ((s.type === 'image' || s.type === 'mface') && s.data) {
                if (s.data.url) return String(s.data.url);
                if (s.data.file) return String(s.data.file);
            }
        }
        console.log('🔍 无图片段, 段类型=' + JSON.stringify(types));
    } else if (typeof message === 'string') {
        const m = message.match(/\[CQ:(?:image|mface)[^\]]*(?:url|file)=([^,\]]+)/);
        if (m) return m[1];
    }
    return null;
}
function extractFirstImageSrc(msg) {
    if (!msg) return null;
    const src = imageSrcOf(msg.message);
    if (src) return src;
    if (typeof msg.raw_message === 'string') {
        const m = msg.raw_message.match(/\[CQ:(?:image|mface)[^\]]*(?:url|file)=([^,\]]+)/);
        if (m) return m[1];
    }
    return null;
}

// ---- NapCat API 请求/响应（用于读取引用消息内容）----
const napcatPending = new Map();
let napcatEchoSeq = 0;
function napcatApi(action, params, timeoutMs) {
    return new Promise(function (resolve) {
        try { if (!wss || !wss.clients || !wss.clients.size) return resolve(null); } catch (e) { return resolve(null); }
        const echo = 'appjs_' + (++napcatEchoSeq) + '_' + Date.now();
        const timer = setTimeout(function () { napcatPending.delete(echo); resolve(null); }, timeoutMs || 8000);
        napcatPending.set(echo, { resolve: resolve, timer: timer });
        const payload = JSON.stringify({ action: action, params: params || {}, echo: echo });
        let sent = 0;
        for (const c of wss.clients) {
            if (c.readyState === WebSocket.OPEN) { try { c.send(payload); sent++; } catch (e) {} }
        }
        if (!sent) { clearTimeout(timer); napcatPending.delete(echo); resolve(null); }
    });
}

// 取「引用（回复）消息」里的图片源：支持引用表情包 / GIF / 图片
async function quotedImageSrc(msg) {
    const qid = replyQuoteIdOf(msg && msg.message);
    if (!qid) return null;
    const r = await napcatApi('get_msg', { message_id: Number(qid) }, 8000);
    if (!r || r.status !== 'ok' || !r.data) {
        console.log('🔍 引用消息读取失败: ' + JSON.stringify((r && (r.message || r.status)) || null).slice(0, 80));
        return null;
    }
    let src = imageSrcOf(r.data.message);
    if (!src && typeof r.data.raw_message === 'string') {
        const m = r.data.raw_message.match(/\[CQ:(?:image|mface)[^\]]*(?:url|file)=([^,\]]+)/);
        if (m) src = m[1];
    }
    if (src) console.log('🔍 取自引用消息的图片: ' + String(src).slice(0, 90));
    return src || null;
}

// 本消息优先，其次引用消息
async function imageSrcOfMsgOrQuote(msg) {
    const own = extractFirstImageSrc(msg);
    if (own) return own;
    return await quotedImageSrc(msg);
}

// 把图片源解码/下载为本地文件，返回 {dest, ext, delete}
function materializeImageSrc(src, tmpPrefix) {
    return new Promise((resolve, reject) => {
        const outDir = '/tmp';
        const base = tmpPrefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
        if (src && src.startsWith('base64://')) {
            const b64 = src.slice('base64://'.length);
            // 探测格式：GIF=R0lGOD, PNG=iVBORw0KGgo, JPEG=/9j/
            let ext = '.png';
            if (b64.startsWith('R0lGOD')) ext = '.gif';
            else if (b64.startsWith('/9j/')) ext = '.jpg';
            const dest = path.join(outDir, base + ext);
            try {
                fs.writeFileSync(dest, Buffer.from(b64, 'base64'));
                resolve({ dest, ext, delete: true });
            } catch (e) { reject(e); }
        } else if (src && /^https?:/.test(src)) {
            const urlObj = new URL(src);
            let ext = path.extname(urlObj.pathname) || '.png';
            if (!/^\.(gif|png|jpg|jpeg|webp)$/i.test(ext)) ext = '.png';
            const dest = path.join(outDir, base + ext);
            downloadImage(src, dest).then(() => resolve({ dest, ext, delete: true })).catch(reject);
        } else if (src && src.startsWith('file:///')) {
            resolve({ dest: src.slice('file://'.length), ext: path.extname(src), delete: false });
        } else {
            reject(new Error('无法识别的图片来源'));
        }
    });
}

// 用 ffmpeg 处理 gif：op='speed' factor=x（x>1加速）/ op='slow' factor=x（x>1减速到 1/x 速）/ op='reverse'
function runFfmpegFilter(srcFile, op, factor, outFile) {
    return new Promise((resolve, reject) => {
        // 用 complex filtergraph 保留 alpha（palettegen=stats_mode=diff）+ 变速/倒放
        let chain;
        if (op === 'speed') {
            const n = Math.max(0.1, Number(factor) || 1) || 1;
            chain = `[0:v]setpts=PTS/${n},split[a][b];[b]palettegen=stats_mode=diff[p];[a][p]paletteuse`;
        } else if (op === 'slow') {
            const n = Math.max(0.1, Number(factor) || 1) || 1;
            chain = `[0:v]setpts=PTS*${n},split[a][b];[b]palettegen=stats_mode=diff[p];[a][p]paletteuse`;
        } else if (op === 'reverse') {
            chain = `[0:v]reverse,split[a][b];[b]palettegen=stats_mode=diff[p];[a][p]paletteuse`;
        } else {
            chain = `[0:v]null,split[a][b];[b]palettegen=stats_mode=diff[p];[a][p]paletteuse`;
        }
        const args = ['-y', '-i', srcFile, '-filter_complex', chain, '-an', '-loop', '0', outFile];
        const pr = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let errBuf = '';
        pr.stderr.on('data', d => { errBuf += d.toString(); });
        pr.on('close', code => {
            if (code === 0) resolve(outFile);
            else reject(new Error('ffmpeg 处理失败: ' + errBuf.slice(-200)));
        });
        pr.on('error', reject);
    });
}

// 主入口：处理 gif → 返回 {cq, text}
async function processGifRequest(msg, op, factor, srcOverride) {
    const src = srcOverride || extractFirstImageSrc(msg);
    if (!src) return { error: '请发送一张图片/GIF，或引用一张图片/表情包再发指令' };
    const mat = await materializeImageSrc(src, 'gifcmd');
    let outFile = null;
    try {
        outFile = mat.dest.replace(/\.\w+$/, '_out.gif');
        await runFfmpegFilter(mat.dest, op, factor, outFile);
        const buf = fs.readFileSync(outFile);
        const b64 = buf.toString('base64');
        let text;
        if (op === 'speed') {
            const n = Math.max(0.1, Number(factor) || 1);
            text = `已加速${n}倍（gif）`;
        } else if (op === 'slow') {
            const n = Math.max(0.1, Number(factor) || 1);
            text = `已减速${n}倍（gif）`;
        } else {
            text = '已倒放（gif）';
        }
        // 返回图片(base64) + 文字
        const cq = `[CQ:image,file=base64://${b64}]`;
        return { cq, text };
    } catch (e) {
        return { error: e.message || 'GIF 处理失败' };
    } finally {
        // 清理临时文件
        try { if (mat.delete) fs.unlinkSync(mat.dest); } catch (e) {}
        try { if (outFile) fs.unlinkSync(outFile); } catch (e) {}
    }
}

// ==================== 群主消息存储 ====================
function getGroupDir(groupId) {
    return path.join(CONFIG.GROUP_DATA_BASE, String(groupId));
}

function getMessagesFilePath(groupId) {
    return path.join(getGroupDir(groupId), 'messages.json');
}

function ensureGroupDir(groupId) {
    const dir = getGroupDir(groupId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

// 处理消息中的图片：下载到本地，并返回修改后的raw_message
async function processMessageForStorage(msg) {
    const groupId = msg.group_id;
    const raw = msg.raw_message || '';
    const messageArray = msg.message || [];
    if (!messageArray.some(seg => seg.type === 'image')) {
        return raw;
    }
    const imgDir = path.join(getGroupDir(groupId), 'images');
    if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
    let newRaw = raw;
    const imageSegs = messageArray.filter(seg => seg.type === 'image');
    for (const seg of imageSegs) {
        const url = seg.data?.url;
        if (!url) continue;
        const ext = path.extname(new URL(url).pathname) || '.png';
        const filename = `${Date.now()}_${Math.random().toString(36).slice(2,6)}${ext}`;
        const localPath = path.join(imgDir, filename);
        try {
            await downloadImage(url, localPath);
            const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const cqRegex = new RegExp(`\\[CQ:image[^\\]]*url=${escapedUrl}[^\\]]*\\]`, 'g');
            const localCq = `[CQ:image,file=file:///${localPath.replace(/\\/g, '/')}]`;
            newRaw = newRaw.replace(cqRegex, localCq);
        } catch (e) {
            console.error(`下载群主图片失败: ${url}`, e);
        }
    }
    return newRaw;
}

async function saveOwnerMessage(msg) {
    if (msg.message_type !== 'group') return;
    if (msg.sender.role !== 'owner') return;
    const groupId = msg.group_id;
    const senderName = getSenderName(msg);
    const time = new Date(msg.time * 1000);
    const timeStr = `${time.getFullYear()}年${time.getMonth()+1}月${time.getDate()}日 ${time.getHours()}:${time.getMinutes().toString().padStart(2,'0')}`;
    let processedRaw = await processMessageForStorage(msg);
    const filePath = getMessagesFilePath(groupId);
    let records = [];
    if (fs.existsSync(filePath)) {
        try {
            const data = fs.readFileSync(filePath, 'utf8');
            records = JSON.parse(data);
        } catch (e) {
            records = [];
        }
    }
    const MAX_RECORDS = 1000;
    records.push({
        time: msg.time,
        timeStr: timeStr,
        nickname: senderName,
        raw_message: processedRaw
    });
    if (records.length > MAX_RECORDS) {
        records = records.slice(-MAX_RECORDS);
    }
    fs.writeFileSync(filePath, JSON.stringify(records, null, 2));
    console.log(`💾 已保存群主消息: ${senderName} in ${groupId}`);
}

// ==================== 冷却管理器 ====================
const cooldown = {
    long: new Map(),
    last: new Map(),
    count: new Map(),
    /** skipLong=true：不看长冷却、也不累计触发长冷却（管理员用）；短冷却照旧生效 */
    check(key, now, opts) {
        const skipLong = !!(opts && opts.skipLong);
        const longEnd = this.long.get(key);
        if (!skipLong && longEnd && now < longEnd) {
            return { allowed: false, reason: 'long' };
        }
        if (longEnd) {
            this.long.delete(key);
            this.count.delete(key);
        }
        const last = this.last.get(key);
        if (last && (now - last) < CONFIG.SHORT_INTERVAL_MS) {
            return { allowed: false, reason: 'short' };
        }
        this.last.set(key, now);
        if (skipLong) return { allowed: true, count: 0, triggered: false };
        let c = (this.count.get(key) || 0) + 1;
        this.count.set(key, c);
        let triggered = false;
        if (c >= CONFIG.MAX_CONSECUTIVE) {
            this.long.set(key, now + CONFIG.LONG_COOLDOWN_MS);
            this.count.delete(key);
            triggered = true;
        }
        return { allowed: true, count: c, triggered };
    }
};

// 管理员（和 on_commands.js 的 ADMIN 同一个人）只免长冷却：连发刷屏时仍受 1 秒短冷却限制。
// 用函数而不是常量，免得依赖后面才定义的 ALBUM_ADMIN。
function botAdminQq() { return String(process.env.ON_ADMIN || ALBUM_ADMIN || ''); }
// 私聊里的 AI（AstrBot）只对管理员开放：除了管理员，其他人的私聊不转发给 AI、也不请求 AI 修饰。
// 支持 ON_ADMIN 里写多个号（逗号 / 空格分隔）。
function isAdminUser(userId) {
    const u = String(userId || '');
    if (!u) return false;
    const list = String(botAdminQq() || '').split(/[,，\s]+/).filter(Boolean);
    return list.indexOf(u) >= 0;
}
function checkCooldown(msg, key, now, cmd) {
    const uid = String((msg && (msg.user_id || (msg.sender && msg.sender.user_id))) || '');
    // 管理员只免长冷却，1 秒短冷却保留；标了 shortOnly 的指令（如小游戏来回互动）同样只受短冷却
    const skipLong = !!(cmd && cmd.shortOnly) || (!!botAdminQq() && uid === botAdminQq());
    return cooldown.check(key, now, { skipLong: skipLong });
}

// ==================== 命令定义 ====================
const commands = [];
require('./q_bounce_commands')({ commands, sendReply, imageSrcOfMsgOrQuote, backendRules });

// ---- 图片分组动态命令 ----
CONFIG.IMAGE_GROUPS.forEach((group) => {
    if (group.type === 'full') {
        // 保存图片
        commands.push({
            match(plainText, { hasImage, imageUrl }) {
                const matchedSave = group.saveKeywords.some(kw => plainText.includes(kw));
                if (matchedSave && hasImage && imageUrl) {
                    return { imageUrl, group };
                }
                if (matchedSave) {
                    return { imageUrl: null, group };
                }
                return false;
            },
            execute(ws, msg, { imageUrl, group }, { count, triggered }) {
                const name = getSenderName(msg);
                if (!imageUrl) {
                    sendReply(ws, msg.message_type === 'private' ? 'send_private_msg' : 'send_group_msg',
                        msg.message_type === 'private' ? { user_id: msg.sender.user_id, message: `请附带一张图片` } : { group_id: msg.group_id, message: `请附带一张图片` });
                    return;
                }
                const dir = path.join(CONFIG.IMAGE_BASE, group.dir);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                const ext = path.extname(new URL(imageUrl).pathname) || '.png';
                const filename = `${group.dir}_${Date.now()}_${Math.random().toString(36).slice(2,6)}${ext}`;
                const dest = path.join(dir, filename);
                downloadImage(imageUrl, dest)
                    .then(() => {
                        console.log(`💾 保存到 ${group.name}: ${dest}`);
                        if (triggered) console.log('🔥 触发长冷却');
                    })
                    .catch(err => {
                        console.error('保存失败:', err);
                    });
            }
        });

        // 查看图片
        commands.push({
            match(plainText) {
                const matchedShow = group.showKeywords.some(kw => plainText.includes(kw));
                if (matchedShow) return { group };
                return false;
            },
            execute(ws, msg, { group }, { count, triggered }) {
                const name = getSenderName(msg);
                const dir = path.join(CONFIG.IMAGE_BASE, group.dir);
                const file = getRandomImageFromDir(dir);
                if (!file) {
                    console.log(`🖼️ ${group.name} 暂无图片（静默）`);
                    return;
                }
                const cq = imageCqFromPath(file);
                const action = msg.message_type === 'private' ? 'send_private_msg' : 'send_group_msg';
                const params = msg.message_type === 'private' ? { user_id: msg.sender.user_id, message: cq } : { group_id: msg.group_id, message: cq };
                queueReplyForMerge('bot', action, params); // 进合并队列，与 AstrBot 的配合语一起发出
                console.log(`🖼️ 查看 ${group.name} 图片: ${file}`);
                if (triggered) console.log('🔥 触发长冷却');
            }
        });
    } else if (group.type === 'readonly') {
        commands.push({
            match(plainText) {
                const matched = group.triggerKeywords.some(kw => plainText.includes(kw));
                if (matched) return { group };
                return false;
            },
            execute(ws, msg, { group }, { count, triggered }) {
                const dir = path.join(CONFIG.IMAGE_BASE, group.dir);
                const file = getRandomImageFromDir(dir);
                if (!file) {
                    console.log(`🍽️ ${group.name} 暂无图片（静默）`);
                    return;
                }
                const cq = imageCqFromPath(file);
                const action = msg.message_type === 'private' ? 'send_private_msg' : 'send_group_msg';
                const params = msg.message_type === 'private' ? { user_id: msg.sender.user_id, message: cq } : { group_id: msg.group_id, message: cq };
                queueReplyForMerge('bot', action, params); // 进合并队列，与 AstrBot 的配合语一起发出
                console.log(`🍽️ 查看 ${group.name} 图片: ${file}`);
                if (triggered) console.log('🔥 触发长冷却');
            }
        });
    }
});

// ---- GIF 处理指令：/加速 <倍数> /减速 <倍数> /倒放（需消息带图片/GIF）----
[['/加速', '加速', 'speed'], ['/减速', '减速', 'speed'], ['/倒放', '倒放', 'reverse']].forEach(([kw, label, op]) => {
    commands.push({
        ignoreAt: true,
        match(plainText, opts) {
            const hasImage = opts && opts.hasImage;
            if (!plainText) return false;
            // 根据指令决定 op/label（不依赖闭包变量，避免被覆盖）
            const m = plainText.match(/^\s*\/\s*(加速|减速|倒放)/i);
            if (!m) return false;
            const kw = m[1].toLowerCase();
            const op = kw === '加速' ? 'speed' : (kw === '减速' ? 'slow' : 'reverse');
            const label = kw === '倒放' ? '倒放' : (kw === '减速' ? '减速' : '加速');
            let factor = 1;
            const numM = plainText.match(/(\d+(?:\.\d+)?)/);
            if (numM) factor = parseFloat(numM[1]);
            return { op, factor, label };
        },
        async execute(ws, msg, { op, factor, label }, ctx) {
            let r;
            try {
                // 图片来源：本消息附带的图片/GIF，或引用（回复）的消息里的图片/表情包
                const src = await imageSrcOfMsgOrQuote(msg);
                if (!src) {
                    sendReply(ws, msg.message_type === 'private' ? 'send_private_msg' : 'send_group_msg',
                        msg.message_type === 'private' ? { user_id: msg.sender.user_id, message: '请发送或引用一张图片/表情包/GIF' } : { group_id: msg.group_id, message: '请发送或引用一张图片/表情包/GIF' });
                    return;
                }
                r = await processGifRequest(msg, op, factor, src);
            } catch (e) {
                console.log('🎞️ GIF 处理异常:', e.message);
                r = { error: e.message || 'GIF 处理失败' };
            }
            if (r.error) {
                sendReply(ws, msg.message_type === 'private' ? 'send_private_msg' : 'send_group_msg',
                    msg.message_type === 'private' ? { user_id: msg.sender.user_id, message: r.error } : { group_id: msg.group_id, message: r.error });
                return;
            }
            const text = r.text;
            // 用字符串 CQ 格式（base64 image + 文字），与手动测试成功的格式一致
            const message = r.cq ? (r.cq + ' ' + text) : text;
            const action = msg.message_type === 'private' ? 'send_private_msg' : 'send_group_msg';
            const params = msg.message_type === 'private' ? { user_id: msg.sender.user_id, message } : { group_id: msg.group_id, message };
            // 直接发给触发这条消息的 NapCat 连接（GIF 指令不接 AI 修饰）
            sendReply(ws, action, params);
            console.log(`🎞️ ${label} GIF 处理完成: ${text.slice(0, 40)}`);
        }
    });
});

// ---- B站关注指令：/关注 <uid>（视频） /关注直播 <uid>（直播） ----
commands.push({
    ignoreAt: true,
    match(plainText) {
        if (!plainText) return false;
        const m = plainText.match(/^\s*\/(关注直播|关注|取关直播|取关)\s*(\d+)\s*$/);
        if (m) return { uid: m[2], live: /直播/.test(m[1]), plain: plainText };
        return false;
    },
    async execute(ws, msg, { uid, live, plain }, ctx) {
        if (msg.message_type !== 'group') { sendReply(ws, 'send_private_msg', { user_id: msg.sender.user_id, message: '请在其他群聊里使用 /关注 指令' }); return; }
        if (!BiliFollow) { sendReply(ws, 'send_group_msg', { group_id: msg.group_id, message: 'B站关注模块未加载' }); return; }
        try {
            const r = await BiliFollow.handleCommand(String(msg.group_id), plain);
            if (r && r.text) {
                sendReply(ws, 'send_group_msg', { group_id: msg.group_id, message: r.text });
            }
        } catch (e) { console.error('B站指令错误:', e.message); }
    }
});

// ==================== 歌曲库：/随机 与 /听 ====================
const SONGS_FILE = path.join(__dirname, 'data', 'songs.json');
let SONGS = [];
let SONGS_MTIME = 0;
function loadSongs(quiet) {
    try {
        const parsed = JSON.parse(fs.readFileSync(SONGS_FILE, 'utf8'));
        const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.songs) ? parsed.songs : []);
        if (!list.length) throw new Error('内容为空');
        SONGS = list;
        SONGS_MTIME = fs.statSync(SONGS_FILE).mtimeMs;
        if (!quiet) console.log('🎵 歌曲库已加载：' + SONGS.length + ' 首');
    } catch (e) {
        console.error('🎵 歌曲库加载失败:', e.message);
    }
}
// 歌曲库被外部更新（sekai-data 自动更新）后热加载，无需重启 app.js
function maybeReloadSongs() {
    try {
        const m = fs.statSync(SONGS_FILE).mtimeMs;
        if (m !== SONGS_MTIME) {
            const before = SONGS.length;
            loadSongs(true);
            if (SONGS.length !== before) console.log('🔄 歌曲库已热加载：' + before + ' → ' + SONGS.length + ' 首');
            else SONGS_MTIME = m;
        }
    } catch (e) {}
}
loadSongs(false);

// 资源域名：JP 曲走 sekai-jp-assets；国服独占曲走 sekai-cn-assets
const ASSETS_JP = 'https://storage.sekai.best/sekai-jp-assets';
const ASSETS_CN = 'https://storage.sekai.best/sekai-cn-assets';

// 演唱者缩写映射（CHAR_FULL 用来反查：写全名也认）
const CHAR_ALIAS = {
    ick: '星乃一歌', saki: '天馬咲希', hnm: '望月穂波', shiho: '日野森志歩',
    mnr: '花里みのり', hrk: '桐谷遥', airi: '桃井愛莉', szk: '日野森雫',
    khn: '小豆沢こはね', an: '白石杏', akt: '東雲彰人', toya: '青柳冬弥',
    tks: '天馬司', emu: '鳳えむ', nene: '草薙寧々', rui: '神代類',
    knd: '宵崎奏', mfy: '朝比奈まふゆ', ena: '東雲絵名', mzk: '暁山瑞希',
    miku: '初音ミク', rin: '鏡音リン', len: '鏡音レン', luka: '巡音ルカ',
    meiko: 'MEIKO', kaito: 'KAITO'
};
const CHAR_FULL = (function () {
    const m = {};
    Object.keys(CHAR_ALIAS).forEach(function (k) { m[CHAR_ALIAS[k]] = k; });
    return m;
})();
// 组合缩写映射
const UNIT_ALIAS = {
    ln: 'Leo/need', mmj: 'MORE MORE JUMP！', vbs: 'Vivid BAD SQUAD',
    ws: 'ワンダーランズ×ショウタイム',
    '25时': '25時、ナイトコードで。', '25時': '25時、ナイトコードで。',
    v: 'バーチャル・シンガー'
};
// 难度缩写映射
const DIFF_ALIAS = {
    apd: 'append', append: 'append',
    ma: 'master', mas: 'master', master: 'master',
    ex: 'expert', exp: 'expert', expert: 'expert',
    ha: 'hard', hard: 'hard',
    no: 'normal', normal: 'normal',
    ea: 'easy', easy: 'easy'
};
// 数据中出现过的全部角色名（用于模糊匹配）
const ALL_CHARS = (function () {
    const set = new Set(Object.keys(CHAR_ALIAS).map(k => CHAR_ALIAS[k]));
    for (const s of SONGS) {
        for (const v of (s.vocals || [])) {
            for (const c of (v.characters || [])) set.add(c);
        }
    }
    return [...set];
})();

function assetsBaseOf(song) { return (song && song.in_jp) ? ASSETS_JP : ASSETS_CN; }
function jacketUrlOf(song) {
    const abn = song.assetbundleName;
    return assetsBaseOf(song) + '/music/jacket/' + abn + '/' + abn + '.png';
}
function longUrlOf(base, vocalAbn) {
    return base + '/music/long/' + vocalAbn + '/' + vocalAbn + '.mp3';
}
function songDisplayName(song) {
    const cn = song.localized_title_cn;
    if (cn && cn !== song.title) return song.title + '(' + cn + ')';
    return song.title;
}
function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ==================== /听歌：曲名匹配 + 版本（翻唱 / v / anvo）====================
/** 版本标签 → 说明。默认（不写）＝セカイver.（翻唱）优先，没有就退回原来的顺序 */
const VOCAL_DEFAULT_ORDER = ['sekai', 'original_song', 'virtual_singer', 'another_vocal'];
const VOCAL_TYPE_CN = {
    sekai: 'セカイver.', original_song: 'バーチャル・シンガーver.', virtual_singer: 'バーチャル・シンガーver.',
    another_vocal: 'アナザーボーカルver.', april_fool_2022: 'エイプリルフールver.'
};
function normTitle(s) {
    return String(s || '').toLowerCase()
        .replace(/[\s　\-–—‐・·:：;；!！?？'"“”‘’()（）\[\]【】{}<>《》,.。、~～_/\\|+＋&＆]/g, '');
}
/** 最长公共子序列占比（0~1），两串都归一化后再比 */
function lcsRatio(a, b) {
    if (!a || !b) return 0;
    const m = a.length, n = b.length;
    let prev = new Array(n + 1).fill(0), cur = new Array(n + 1).fill(0);
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
        }
        const t = prev; prev = cur; cur = t;
        cur.fill(0);
    }
    return prev[n] / Math.max(m, n);
}
function songNames(song) {
    return [song.title, song.localized_title_cn, song.pronunciation, song.artist, song.cn_artist].filter(Boolean);
}
/** 曲名模糊搜索：精确 → 包含 → 相似度（>=0.72 直接算命中，其余进候选） */
function findSongSmart(q) {
    const raw = String(q || '').trim();
    const qn = normTitle(raw);
    if (!qn) return { song: null, candidates: [] };
    if (/^\d{1,6}$/.test(raw)) {
        const num = Number(raw);
        const byNum = SONGS.find(function (s) { return s.id === num; })
            || SONGS.find(function (s) { return s.no === num; })
            || SONGS.find(function (s) { return s.default_id === num; });
        if (byNum) return { song: byNum, exact: true, candidates: [] };
    }
    let exact = null, sub = null, fuzzy = null;
    const scored = [];
    for (const song of SONGS) {
        for (const name of songNames(song)) {
            const n = normTitle(name);
            if (!n) continue;
            if (n === qn) { exact = exact || song; break; }
            if (n.indexOf(qn) >= 0 || qn.indexOf(n) >= 0) {
                if (!sub || n.length > sub.len) sub = { song: song, len: n.length };
            }
            const r = lcsRatio(n, qn);
            if (r >= 0.45) scored.push({ song: song, r: r });
            if (r >= 0.72 && (!fuzzy || r > fuzzy.r)) fuzzy = { song: song, r: r };
        }
        if (exact) break;
    }
    scored.sort(function (a, b) { return b.r - a.r; });
    const cands = [];
    for (const s of scored) {
        if (!cands.some(function (c) { return c.song.id === s.song.id; })) cands.push(s);
        if (cands.length >= 5) break;
    }
    return { song: exact || (sub && sub.song) || (fuzzy && fuzzy.song) || null, exact: !!exact, candidates: cands };
}
/** 「mnr&airi」→ { names:[花里みのり, 桃井愛莉], unknown:['hsk'] }；也认全名（花里みのり / 花里みのり&桃井愛莉） */
function parseCharTokens(s) {
    const names = [], unknown = [];
    for (const part of String(s || '').split(/[&＆,，、+＋/\s　]+/)) {
        const k = part.trim();
        if (!k) continue;
        // 先认缩写，再认全名（CHAR_FULL 是 CHAR_ALIAS 的值集合）
        const full = CHAR_FULL[k] ? k : null;
        const name = CHAR_ALIAS[k.toLowerCase()] || full;
        if (name) { if (names.indexOf(name) < 0) names.push(name); }
        else if (unknown.indexOf(k) < 0) unknown.push(k);
    }
    return { names: names, unknown: unknown };
}
/** 把「曲名 [版本标签]」拆开；标签认不出就当曲名的一部分 */
function splitVocalTag(raw) {
    const s = String(raw || '').trim();
    const m = /^(.*?)[\s　]+(\S+)$/.exec(s);
    if (!m || !m[1].trim()) return { q: s, want: null };
    const name = m[1].trim(), tag = m[2].trim(), low = tag.toLowerCase();
    if (low === '翻唱' || low === 'sekai' || tag === 'セカイ') {
        return { q: name, want: { type: 'sekai', label: '翻唱（セカイver.）' } };
    }
    if (low === 'v' || low === 'vs' || tag === 'バーチャル' || low === '虚拟' || low === '虚拟歌手') {
        return { q: name, want: { type: 'virtual_singer', label: '虚拟歌手（バーチャル・シンガーver.）' } };
    }
    if (low === '原曲' || low === 'original' || low === 'orig') {
        return { q: name, want: { type: 'original_song', label: '原曲（バーチャル・シンガーver.）' } };
    }
    if (low === 'af' || low === '愚人节' || tag === 'エイプリルフール') {
        return { q: name, want: { type: 'april_fool', label: 'エイプリルフールver.' } };
    }
    const am = /^(.*?)(anvo)?$/i.exec(low);
    if (am && am[1]) {
        const parsedChars = parseCharTokens(am[1]);
        const isAnvo = !!am[2];
        // 「mnr&airi」「花里みのり」这种全是角色的写法，写不写 anvo 都当 anvo 请求
        if (parsedChars.names.length && (!parsedChars.unknown.length || isAnvo)) {
            return { q: name, want: { type: 'another_vocal', chars: parsedChars.names, unknown: parsedChars.unknown,
                label: parsedChars.names.join('&') + ' 的 anvo（アナザーボーカルver.）' } };
        }
        if (isAnvo && !am[1]) {
            // 只写了 anvo：列出这首歌有哪些 anvo
            return { q: name, want: { type: 'another_vocal', chars: [], listOnly: true, label: 'anvo' } };
        }
    }
    return { q: s, want: null };
}
function sameCharSet(a, b) {
    if (a.length !== b.length) return false;
    return a.every(function (x) { return b.indexOf(x) >= 0; });
}
/** 挑一条 vocal：请求的版本没有就退回默认（并把原因带回去） */
function pickVocal(song, want) {
    const vocals = (song.vocals || []).filter(function (v) { return v && v.assetbundleName; });
    if (!vocals.length) return { vocal: null };
    const byType = function (t) {
        return vocals.filter(function (v) {
            return t === 'april_fool' ? /^april_fool/.test(v.musicVocalType) : v.musicVocalType === t;
        });
    };
    if (want && want.type === 'another_vocal') {
        const avs = byType('another_vocal');
        const have = avs.map(function (v) { return (v.characters || []).join('&'); });
        if (want.listOnly) return { vocal: null, wantMiss: 'anvo', haveAnvo: have, listOnly: true };
        const exact = avs.filter(function (v) { return sameCharSet(v.characters || [], want.chars); })[0];
        if (exact) return { vocal: exact };
        const sup = avs.filter(function (v) {
            return want.chars.every(function (c) { return (v.characters || []).indexOf(c) >= 0; });
        }).sort(function (a, b) { return (a.characters || []).length - (b.characters || []).length; });
        if (sup.length) return { vocal: sup[0], note: '没有完全对应的 anvo，这条最接近' };
        // 这首歌根本没有这个人的 anvo：把有的 anvo 列出来
        return { vocal: null, wantMiss: want.label, haveAnvo: have };
    }
    if (want && want.type) {
        const hit = byType(want.type);
        if (hit.length) return { vocal: hit[0] };
        if (want.type === 'virtual_singer') {
            const o = byType('original_song');
            if (o.length) return { vocal: o[0], note: '这首歌没有 vs 版，给你放原曲（バーチャル・シンガーver.）' };
        }
        return { vocal: null, wantMiss: want.label };
    }
    for (const t of VOCAL_DEFAULT_ORDER) {
        const hit = byType(t);
        if (hit.length) return { vocal: hit[0] };
    }
    return { vocal: vocals[0] };
}
function vocalLabel(v) {
    if (!v) return '';
    const t = VOCAL_TYPE_CN[v.musicVocalType] || v.caption || v.musicVocalType || '';
    const chars = (v.characters || []).join(' / ');
    return chars ? (t + '　' + chars) : t;
}
/** 曲名用哪个写法去查（优先中文名，没有就用原名） */
function songQueryName(song) {
    return song.localized_title_cn || song.title || '';
}
/** [花里みのり, 桃井愛莉] → 「mnr&airi」（有缩写就用缩写，提示里更好抄） */
function comboAbbr(names) {
    return (names || []).map(function (n) { return CHAR_FULL[n] || n; }).join('&');
}

// 通用下载（跟随跳转 + 状态码校验）
function downloadFile(url, destPath, depth) {
    if (depth === undefined) depth = 0;
    return new Promise(function (resolve, reject) {
        let urlObj;
        try { urlObj = new URL(url); } catch (e) { return reject(e); }
        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'GET',
            headers: { 'User-Agent': 'Mozilla/5.0' }
        };
        const req = https.get(options, function (res) {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                if (depth > 5) return reject(new Error('跳转过多'));
                let next;
                try { next = new URL(res.headers.location, url).toString(); } catch (e) { return reject(e); }
                return downloadFile(next, destPath, depth + 1).then(resolve, reject);
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error('HTTP ' + res.statusCode));
            }
            const chunks = [];
            res.on('data', function (c) { chunks.push(c); });
            res.on('end', function () {
                fs.writeFile(destPath, Buffer.concat(chunks), function (err) {
                    if (err) reject(err); else resolve(destPath);
                });
            });
        });
        req.on('error', reject);
        req.setTimeout(30000, function () { req.destroy(new Error('下载超时')); });
    });
}

// ---- 解析 /随机 参数 ----
// opts.server: 'jp' | 'cn'（由指令前缀决定）；opts.allowBoth: 是否允许“除独占”（仅 /cn随机）
function parseRandomArgs(argStr, opts) {
    const allowBoth = !!(opts && opts.allowBoth);
    const cond = {
        difficulties: [], chars: [], units: [], levels: [],
        server: (opts && opts.server) ? opts.server : 'jp',
        exclusiveBoth: false
    };
    const unknown = [];
    const tokens = String(argStr || '').split(/\s+/).filter(Boolean);
    for (const t of tokens) {
        const low = t.toLowerCase();
        // 难度
        if (DIFF_ALIAS[low]) { cond.difficulties.push(DIFF_ALIAS[low]); continue; }
        // 除独占：仅 /cn随机 支持（要求 in_cn 且 in_jp）
        if (t === '除独占') {
            if (allowBoth) { cond.exclusiveBoth = true; continue; }
        }
        // 组合
        if (UNIT_ALIAS[t]) { cond.units.push(UNIT_ALIAS[t]); continue; }
        if (UNIT_ALIAS[low]) { cond.units.push(UNIT_ALIAS[low]); continue; }
        // 等级区间 25-28
        const rm = t.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
        if (rm) {
            const a = parseInt(rm[1], 10), b = parseInt(rm[2], 10);
            cond.levels.push({ min: Math.min(a, b), max: Math.max(a, b) });
            continue;
        }
        // 单个等级
        if (/^\d{1,2}$/.test(t)) {
            const n = parseInt(t, 10);
            if (n >= 1 && n <= 38) { cond.levels.push({ min: n, max: n }); continue; }
        }
        // 演唱者：先查缩写表，再按角色名模糊匹配
        if (CHAR_ALIAS[low]) { cond.chars.push(CHAR_ALIAS[low]); continue; }
        const hit = ALL_CHARS.filter(function (c) { return c.indexOf(t) >= 0 || t.indexOf(c) >= 0; });
        if (hit.length) { for (const h of hit) cond.chars.push(h); continue; }
        unknown.push(t);
    }
    cond.difficulties = [...new Set(cond.difficulties)];
    cond.chars = [...new Set(cond.chars)];
    cond.units = [...new Set(cond.units)];
    return { cond: cond, unknown: unknown };
}

// 歌曲是否满足条件；满足则返回其所有命中的难度，否则返回 null
function matchSongDiffs(song, cond) {
    // 服务器：由指令前缀决定（/随机、/jp随机 → 需 in_jp；/cn随机 → 需 in_cn，可加“除独占” → 还需 in_jp）
    if (cond.server === 'cn') {
        if (!song.in_cn) return null;
        if (cond.exclusiveBoth && !song.in_jp) return null;
    } else {
        if (!song.in_jp) return null;
    }
    // 组合（or）
    if (cond.units.length && cond.units.indexOf(song.unit) < 0) return null;
    // 演唱者（or，包含匹配）
    if (cond.chars.length) {
        const vocals = song.vocals || [];
        const ok = vocals.some(function (v) {
            return (v.characters || []).some(function (c) {
                return cond.chars.some(function (sel) { return c.indexOf(sel) >= 0 || sel.indexOf(c) >= 0; });
            });
        });
        if (!ok) return null;
    }
    // 难度 + 等级（同类型 or，不同类型 and）
    const diffs = (song.difficulties || []).filter(function (d) {
        if (cond.difficulties.length && cond.difficulties.indexOf(d.musicDifficulty) < 0) return false;
        if (cond.levels.length) {
            const lvOk = cond.levels.some(function (r) { return d.playLevel >= r.min && d.playLevel <= r.max; });
            if (!lvOk) return false;
        }
        return true;
    });
    if (!diffs.length) return null;
    return diffs;
}

// 找到歌曲可用的 long mp3（vocal 类型优先级 + JP/CN 域名回退）
async function fetchLongMp3(song, vocal) {
    const vocals = vocal ? [vocal] : (song.vocals || []).filter(function (v) { return v && v.assetbundleName; });
    if (!vocals.length) return null;
    const pref = { sekai: 0, original_song: 1, virtual_singer: 2, another_vocal: 3 };
    vocals.sort(function (a, b) {
        const pa = pref[a.musicVocalType] === undefined ? 9 : pref[a.musicVocalType];
        const pb = pref[b.musicVocalType] === undefined ? 9 : pref[b.musicVocalType];
        return pa - pb;
    });
    const bases = song.in_jp ? [ASSETS_JP, ASSETS_CN] : [ASSETS_CN, ASSETS_JP];
    for (const base of bases) {
        for (const v of vocals) {
            const url = longUrlOf(base, v.assetbundleName);
            const dest = path.join('/tmp', 'minori_song_' + Date.now() + '_' + v.assetbundleName + '.mp3');
            try {
                await downloadFile(url, dest);
                const st = fs.statSync(dest);
                if (st.size > 1024) return { dest: dest, url: url, size: st.size };
                try { fs.unlinkSync(dest); } catch (e) {}
            } catch (e) {
                try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch (e2) {}
            }
        }
    }
    return null;
}

// ---- /随机 /jp随机 /cn随机：随机点歌（可带条件；/随机 等同 /jp随机）----
commands.push({
    ignoreAt: true,
    match(plainText) {
        if (!plainText) return false;
        const m = plainText.match(/^\s*\/\s*(cn|jp)?\s*随机\s*([\s\S]*)$/i);
        if (!m) return false;
        return { server: (m[1] ? m[1].toLowerCase() : 'jp'), args: m[2] || '' };
    },
    async execute(ws, msg, { server, args }, ctx) {
        const isPrivate = msg.message_type === 'private';
        const action = isPrivate ? 'send_private_msg' : 'send_group_msg';
        const target = isPrivate ? { user_id: msg.sender.user_id } : { group_id: msg.group_id };
        const reply = function (message) { sendReply(ws, action, Object.assign({}, target, { message: message })); };

        maybeReloadSongs();
        if (!SONGS.length) { reply('歌曲库未加载'); return; }

        // 除独占 仅 /cn随机 支持
        const parsed = parseRandomArgs(args, { server: server, allowBoth: server === 'cn' });
        if (parsed.unknown.length) { reply('你所输入的演唱者不存在。'); return; }

        const pool = [];
        for (const song of SONGS) {
            const diffs = matchSongDiffs(song, parsed.cond);
            if (diffs) pool.push({ song: song, diffs: diffs });
        }
        if (!pool.length) { reply('满足条件的歌曲不存在。'); return; }

        const pick = pickRandom(pool);
        const song = pick.song;
        const diff = pickRandom(pick.diffs);
        const message = [
            { type: 'text', data: { text: '随机到了 ' + songDisplayName(song) + ' 歌曲\n' } },
            { type: 'image', data: { file: jacketUrlOf(song) } },
            { type: 'text', data: { text: '\n的 ' + diff.musicDifficulty + '难度 Lv.' + diff.playLevel } }
        ];
        // 直接发送（/随机 不接 AI 修饰）
        reply(message);
        console.log('🎲 ' + ((server === 'cn') ? '/cn随机' : '/jp随机') + ' -> ' + song.title + ' [' + diff.musicDifficulty + ' Lv.' + diff.playLevel + '] 条件=' + JSON.stringify(parsed.cond));
    }
});

// ---- /听歌：发送歌曲 long 版语音 ----
commands.push({
    ignoreAt: true,
    match(plainText) {
        if (!plainText) return false;
        const m = plainText.match(/^\s*\/\s*听歌\s*([\s\S]+)$/);
        if (!m) return false;
        const q = m[1].trim();
        if (!q) return false;
        return { q: q };
    },
    async execute(ws, msg, { q }, ctx) {
        const isPrivate = msg.message_type === 'private';
        const action = isPrivate ? 'send_private_msg' : 'send_group_msg';
        const target = isPrivate ? { user_id: msg.sender.user_id } : { group_id: msg.group_id };
        const reply = function (message) { sendReply(ws, action, Object.assign({}, target, { message: message })); };

        maybeReloadSongs();
        if (!SONGS.length) { reply('歌曲库未加载'); return; }

        // 先按「曲名 + 版本标签」拆（/听歌 快乐万岁 mnr&airianvo）；
        // 再试「曲名紧贴 anvo」的写法（/听歌 快乐万岁mnranvo）；
        // 最后才把整串当曲名。顺序很重要：整串先试会被「包含匹配」吃掉，anvo 标签就白写了
        const tries = [];
        const sp = splitVocalTag(q);
        if (sp.want) tries.push(sp);
        const tight = /^(.*?)([A-Za-z&＆]{2,}anvo)$/i.exec(String(q).trim());
        if (tight) {
            const inner = splitVocalTag(tight[1] + ' ' + tight[2]);
            if (inner.want) tries.push({ q: inner.q, want: inner.want });
        }
        tries.push({ q: q, want: null });
        let found = null, want = null;
        for (const t of tries) {
            const f = findSongSmart(t.q);
            if (f.song) { found = f; want = t.want; break; }
            if (!found) found = f;                       // 留最后一份候选给相似度提示
        }
        if (!found || !found.song) {
            const cands = (found && found.candidates) || [];
            if (!cands.length) { reply('没有找到「' + q + '」这首歌。'); return; }
            reply('没有找到「' + q + '」这首歌。你要找的是不是：\n'
                + cands.map(function (c) { return '　' + songDisplayName(c.song) + '　' + Math.round(c.r * 100) + '%'; }).join('\n'));
            return;
        }
        const song = found.song;
        const picked = pickVocal(song, want);
        if (!picked.vocal) {
            if (picked.haveAnvo && picked.haveAnvo.length) {
                const head = picked.listOnly
                    ? '「' + songDisplayName(song) + '」有的 anvo 版本：'
                    : '「' + songDisplayName(song) + '」没有 ' + picked.wantMiss + '。这首歌有的是：';
                reply(head + '\n' + picked.haveAnvo.map(function (x) {
                    // 提示里给缩写形式（mnr&airianvo），抄进聊天框就能直接用
                    return '　/听歌 ' + songQueryName(song) + ' ' + comboAbbr(String(x).split('&')) + 'anvo';
                }).join('\n'));
            } else if (picked.wantMiss) {
                reply('「' + songDisplayName(song) + '」没有 ' + picked.wantMiss + '，这首歌也没有别的可用音轨。');
            } else {
                reply('这首歌的音频暂时拿不到。');
            }
            return;
        }

        let got = null;
        try {
            got = await fetchLongMp3(song, picked.vocal);
        } catch (e) {
            console.log('🎧 语音下载异常:', e.message);
        }
        if (!got) { reply('这首歌的音频暂时拿不到。'); return; }

        // 语音单独一条发出：不与文字混在同一条消息里
        // （QQ 对「文字+语音」混排消息常只显示文字、语音不出现）
        reply([{ type: 'record', data: { file: 'file://' + got.dest } }]);
        console.log('🎧 /听歌 ' + song.title + ' [' + (picked.vocal.musicVocalType || '?') + ' ' + picked.vocal.assetbundleName
            + (picked.vocal.characters ? ' ' + picked.vocal.characters.join('&') : '') + '] -> ' + got.url
            + ' (' + (got.size / 1048576).toFixed(2) + 'MB) 语音已单独发出');

        // 文字（播放说明 + 封面）另发一条，并走 AI 修饰把 みのり 的配合语合并进来
        let text = '播放 ' + songDisplayName(song) + '\n' + vocalLabel(picked.vocal);
        if (picked.note) text += '\n（' + picked.note + '）';
        if (want && want.unknown && want.unknown.length) {
            text += '\n（不认识 ' + want.unknown.join('、') + ' 这个简称，按 ' + (want.chars || []).join('&') + ' 找的）';
        }
        const key = isPrivate ? ('p:' + msg.sender.user_id) : ('g:' + msg.group_id);
        const q2 = pendingTriggers.get(key);
        const tr = (q2 && q2.length) ? (q2.find(function (t) { return t && t.messageId === msg.message_id; }) || q2[q2.length - 1]) : null;
        const textMessage = [
            { type: 'text', data: { text: text } },
            { type: 'image', data: { file: jacketUrlOf(song) } }
        ];
        modifyAndEmitResult(key, '/听歌', action, Object.assign({}, target, { message: textMessage }), text, tr);
        // 发送后清理本地临时文件（留出上传时间）
        setTimeout(function () {
            try { fs.unlinkSync(got.dest); console.log('🧹 已清理语音临时文件'); } catch (e) {}
        }, 60000);
    }
});

// ==================== /bilibili：B站搜索（返回搜索到的第一个视频） ====================
const BILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function biliSearchCookie() {
    try {
        if (fs.existsSync('/home/admin/bot/data/bilibili_cookie.txt')) {
            return fs.readFileSync('/home/admin/bot/data/bilibili_cookie.txt', 'utf8').trim();
        }
    } catch (e) {}
    return '';
}

// 可选 cookie 的 GET，返回 JSON 或 null（非 200 / 风控 412 均视为失败）
function biliApiGet(urlStr, useCookie) {
    return new Promise(function (resolve) {
        try {
            const url = new URL(urlStr);
            const headers = {
                'User-Agent': BILI_UA,
                'Referer': 'https://www.bilibili.com/',
                'Accept': 'application/json, text/plain, */*'
            };
            if (useCookie) {
                const ck = biliSearchCookie();
                if (ck) headers['Cookie'] = ck;
            }
            const req = https.get(url, { headers: headers }, function (res) {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', function (c) { data += c; });
                res.on('end', function () {
                    if (res.statusCode !== 200) return resolve(null); // 412 风控等
                    try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
                });
            });
            req.on('error', function () { resolve(null); });
            req.setTimeout(15000, function () { req.destroy(); resolve(null); });
        } catch (e) { resolve(null); }
    });
}

// 搜索第一个视频：优先不使用 cookie，无结果/被风控再用 cookie
async function biliSearchFirstVideo(keyword) {
    const q = encodeURIComponent(keyword);
    for (const useCookie of [false, true]) {
        const j = await biliApiGet('https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=' + q + '&page=1', useCookie);
        const list = (j && j.code === 0 && j.data && Array.isArray(j.data.result)) ? j.data.result : null;
        if (list) {
            const v = list.find(function (x) { return x && x.bvid; });
            if (v) {
                console.log('🔎 B站搜索[' + (useCookie ? '带cookie' : '无cookie') + '] "' + keyword + '" -> ' + v.bvid);
                return v;
            }
        }
        console.log('🔎 B站搜索[' + (useCookie ? '带cookie' : '无cookie') + '] "' + keyword + '" 无结果 ' + (j ? '(code=' + j.code + ')' : '(请求失败/风控)'));
    }
    return null;
}

function biliStripEm(s) {
    return String(s === undefined || s === null ? '' : s).replace(/<\/?em[^>]*>/g, '').trim();
}
function biliFmtDate(ts) {
    if (!ts) return '';
    const d = new Date(Number(ts) * 1000);
    const p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function biliNum(n) {
    if (n === undefined || n === null || n === '') return '0';
    return String(n);
}
function biliClip(s, max) {
    const t = String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim();
    return t.length > max ? (t.slice(0, max) + '…') : t;
}

// ---- /bilibili <搜索词>：返回搜索到的第一个视频 ----
commands.push({
    ignoreAt: true,
    match(plainText) {
        if (!plainText) return false;
        const m = plainText.match(/^\s*\/\s*bilibili(?=\s|$)\s*([\s\S]*)$/i);
        if (!m) return false;
        let kw = (m[1] || '').trim();
        // 去掉包裹的引号（中英文皆可）
        kw = kw.replace(/^["'“”‘’]+/, '').replace(/["'“”‘’]+$/, '').trim();
        return { keyword: kw };
    },
    async execute(ws, msg, { keyword }, ctx) {
        const isPrivate = msg.message_type === 'private';
        const action = isPrivate ? 'send_private_msg' : 'send_group_msg';
        const target = isPrivate ? { user_id: msg.sender.user_id } : { group_id: msg.group_id };
        const reply = function (message) { sendReply(ws, action, Object.assign({}, target, { message: message })); };

        if (!keyword) { reply('缺少搜索词，要记得给搜索词呀'); return; }

        const v = await biliSearchFirstVideo(keyword);
        if (!v) { reply('没有搜索到视频'); return; }

        const bvid = v.bvid;
        // 详情接口取完整数据（搜索接口不返回硬币）；失败则退回搜索结果自带字段
        let j = await biliApiGet('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid), false);
        if (!j || j.code !== 0 || !j.data) {
            j = await biliApiGet('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid), true);
        }
        const det = (j && j.code === 0 && j.data) ? j.data : null;

        let title, up, cover, desc, dateStr, play, danmaku, like, coin, fav;
        if (det) {
            title = det.title || biliStripEm(v.title);
            up = (det.owner && det.owner.name) || v.author || '';
            cover = det.pic || v.pic || '';
            desc = (det.desc !== undefined && det.desc !== null) ? det.desc : (v.description || '');
            dateStr = biliFmtDate(det.pubdate || v.pubdate);
            const st = det.stat || {};
            play = st.view; danmaku = st.danmaku; like = st.like; coin = st.coin; fav = st.favorite;
        } else {
            title = biliStripEm(v.title);
            up = v.author || '';
            cover = v.pic || '';
            desc = v.description || '';
            dateStr = biliFmtDate(v.pubdate);
            play = v.play;
            danmaku = (v.video_review !== undefined) ? v.video_review : v.danmaku;
            like = v.like; coin = ''; fav = v.favorites;
        }
        // 封面统一 https
        cover = String(cover || '');
        if (cover.indexOf('//') === 0) cover = 'https:' + cover;
        cover = cover.replace(/^http:\/\//i, 'https://');

        const body = '标题：' + title + '\n'
            + 'up：' + up + '\n'
            + 'https://www.bilibili.com/video/' + bvid + '\n'
            + '简介：' + biliClip(desc, 200) + '\n'
            + dateStr + '\n\n'
            + '播放量：' + biliNum(play) + '|弹幕：' + biliNum(danmaku) + '\n'
            + '点赞：' + biliNum(like) + '|硬币：' + biliNum(coin) + '|收藏：' + biliNum(fav);

        const message = [
            { type: 'text', data: { text: '小花搜索到了\n' } },
            { type: 'image', data: { file: cover } },
            { type: 'text', data: { text: '\n' + body } }
        ];
        reply(message);
        console.log('🔎 /bilibili "' + keyword + '" -> ' + title + ' | ' + bvid);
    }
});

// ==================== /bilibili听视频 <BV号>：抓 B 站音频，以语音形式发送 ====================
// 规格：只接受 BV 号；回执 = 正在听 + 封面 + 标题 + up主：
// 语音单独一条发（QQ 对「文字+语音」混排常只显示文字、语音不出现 —— 见 /听歌 那处的注释）
const BILI_VOICE_DIR = path.join(__dirname, 'data', 'bili_voice');
const BILI_VOICE_MAX_SEC = 360;                       // 上限 6 分钟
const BILI_VOICE_MAX_BYTES = 8 * 1024 * 1024;         // 上限 8 MB
const BILI_VOICE_KEEP = 30;                           // 缓存保留最近 30 条
const BILI_VOICE_USER_COOLDOWN_MS = 60 * 1000;        // 每人 60 秒；且只有真的发出语音才计（见下面 stamp）
const BILI_VOICE_MAX_CONCURRENT = 2;                  // 同时最多 2 个下载任务
const biliVoiceLastAt = new Map();
const biliVoiceInflight = new Map();
let biliVoiceBusy = 0;

function biliVoiceCooldownLeft(userId) {
    const last = biliVoiceLastAt.get(String(userId)) || 0;
    const left = BILI_VOICE_USER_COOLDOWN_MS - (Date.now() - last);
    return left > 0 ? Math.ceil(left / 1000) : 0;
}

/** 带 Referer/UA 的下载（B 站 upos 音频流必须带 Referer，否则 403） */
function biliVoiceDownload(urlStr, destPath, depth) {
    if (depth === undefined) depth = 0;
    return new Promise(function (resolve, reject) {
        let u;
        try { u = new URL(urlStr); } catch (e) { return reject(e); }
        const req = https.get({
            hostname: u.hostname,
            path: u.pathname + u.search,
            method: 'GET',
            headers: {
                'User-Agent': BILI_UA,
                'Referer': 'https://www.bilibili.com/',
                'Origin': 'https://www.bilibili.com',
                'Accept': '*/*'
            }
        }, function (res) {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                if (depth > 5) return reject(new Error('跳转过多'));
                let next;
                try { next = new URL(res.headers.location, urlStr).toString(); } catch (e) { return reject(e); }
                return biliVoiceDownload(next, destPath, depth + 1).then(resolve, reject);
            }
            if (res.statusCode !== 200 && res.statusCode !== 206) {
                res.resume();
                return reject(new Error('HTTP ' + res.statusCode));
            }
            const out = fs.createWriteStream(destPath);
            res.pipe(out);
            out.on('finish', function () { out.close(function () { resolve(destPath); }); });
            out.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(180000, function () { req.destroy(); reject(new Error('下载超时')); });
    });
}

/** 用 ffprobe 取时长（秒）；失败给 0 */
function biliVoiceSeconds(file) {
    return new Promise(function (resolve) {
        let out = '';
        let p;
        try {
            p = require('child_process').spawn('ffprobe',
                ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
        } catch (e) { return resolve(0); }
        p.stdout.on('data', function (d) { out += d.toString(); });
        p.on('error', function () { resolve(0); });
        p.on('close', function () {
            const v = parseFloat(String(out).trim());
            resolve(isFinite(v) ? v : 0);
        });
    });
}

/** m4s(AAC) → mp3（QQ 语音走 NapCat 的 ffmpeg 转码，这里先给一个通用 mp3） */
function biliVoiceToMp3(src, dest) {
    return new Promise(function (resolve, reject) {
        const c = require('child_process').spawn('ffmpeg',
            ['-hide_banner', '-loglevel', 'error', '-y', '-i', src,
                '-vn', '-codec:a', 'libmp3lame', '-b:a', '128k', dest]);
        let log = '';
        c.stderr.on('data', function (d) { log += d.toString(); });
        c.on('error', function (e) { reject(e); });
        c.on('close', function (code) {
            if (code === 0 && fs.existsSync(dest) && fs.statSync(dest).size > 1024) return resolve(dest);
            reject(new Error('转码失败: ' + String(log).slice(-160)));
        });
    });
}

/** 缓存只留最近 N 条，别把 12G 的盘塞满 */
function biliVoiceTrimCache() {
    try {
        const list = fs.readdirSync(BILI_VOICE_DIR)
            .filter(function (n) { return /\.mp3$/.test(n); })
            .map(function (n) {
                const p = path.join(BILI_VOICE_DIR, n);
                return { p: p, t: fs.statSync(p).mtimeMs };
            })
            .sort(function (a, b) { return b.t - a.t; });
        list.slice(BILI_VOICE_KEEP).forEach(function (f) { try { fs.unlinkSync(f.p); } catch (e) {} });
    } catch (e) {}
}

/** BV → mp3；同一个 BV 并发只下一次（在途去重） */
function biliVoiceFetch(bvid, cid) {
    if (biliVoiceInflight.has(bvid)) return biliVoiceInflight.get(bvid);
    const job = (async function () {
        try { fs.mkdirSync(BILI_VOICE_DIR, { recursive: true }); } catch (e) {}
        const mp3 = path.join(BILI_VOICE_DIR, bvid + '.mp3');
        if (fs.existsSync(mp3) && fs.statSync(mp3).size > 1024) {
            return { file: mp3, seconds: await biliVoiceSeconds(mp3), bytes: fs.statSync(mp3).size, cached: true };
        }
        const p = await biliApiGet('https://api.bilibili.com/x/player/playurl?bvid=' + encodeURIComponent(bvid)
            + '&cid=' + encodeURIComponent(cid) + '&fnval=16&fnver=0&fourk=0', false);
        const audios = (p && p.code === 0 && p.data && p.data.dash && Array.isArray(p.data.dash.audio))
            ? p.data.dash.audio.slice() : [];
        if (!audios.length) throw new Error('这个视频拿不到音频流（番剧 / 付费 / 直播类不支持）');
        const rank = { 30232: 0, 30216: 1, 30280: 2 };   // 默认取 129k：够听、体积约一半
        audios.sort(function (a, b) {
            const ra = rank[a.id] === undefined ? 9 : rank[a.id];
            const rb = rank[b.id] === undefined ? 9 : rank[b.id];
            return ra - rb;
        });
        const m4s = path.join('/tmp', 'bili_' + bvid + '_' + Date.now() + '.m4s');
        let lastErr = null;
        for (const a of audios.slice(0, 3)) {
            const urls = [a.baseUrl || a.base_url].concat(a.backupUrl || a.backup_url || []).filter(Boolean);
            for (const url of urls) {
                try {
                    await biliVoiceDownload(url, m4s);
                    const raw = fs.existsSync(m4s) ? fs.statSync(m4s).size : 0;
                    if (raw < 10240) throw new Error('音频流太小（' + raw + ' 字节）');
                    await biliVoiceToMp3(m4s, mp3);
                    try { fs.unlinkSync(m4s); } catch (e) {}
                    const bytes = fs.statSync(mp3).size;
                    const seconds = await biliVoiceSeconds(mp3);
                    biliVoiceTrimCache();
                    return { file: mp3, seconds: seconds, bytes: bytes, cached: false };
                } catch (e) {
                    lastErr = e;
                    try { if (fs.existsSync(m4s)) fs.unlinkSync(m4s); } catch (e2) {}
                }
            }
        }
        try { if (fs.existsSync(mp3)) fs.unlinkSync(mp3); } catch (e) {}
        throw (lastErr || new Error('音频下载失败'));
    })();
    biliVoiceInflight.set(bvid, job);
    job.catch(function () {}).then(function () { biliVoiceInflight.delete(bvid); });
    return job;
}

// ---- /bilibili听视频 <BV号> ----
commands.push({
    ignoreAt: true,
    match(plainText) {
        if (!plainText) return false;
        const m = plainText.match(/^\s*\/\s*bilibili\s*听视频\s*([\s\S]*)$/i);
        if (!m) return false;
        return { bvid: String(m[1] || '').trim() };
    },
    async execute(ws, msg, { bvid }, ctx) {
        const isPrivate = msg.message_type === 'private';
        const action = isPrivate ? 'send_private_msg' : 'send_group_msg';
        const target = isPrivate ? { user_id: msg.sender.user_id } : { group_id: msg.group_id };
        const reply = function (message) { sendReply(ws, action, Object.assign({}, target, { message: message })); };
        const uid = msg.user_id || (msg.sender && msg.sender.user_id);

        if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) {
            reply('用法：/bilibili听视频 BV号\n只认 BV 号（例如 BV1GJ411x7h7），链接和 av 号都不收。');
            return;
        }
        const left = biliVoiceCooldownLeft(uid);
        if (left) { reply('刚点过一首，' + left + ' 秒后再点。'); return; }
        if (biliVoiceBusy >= BILI_VOICE_MAX_CONCURRENT) { reply('前面还有视频在下载，稍等一下再发。'); return; }

        biliVoiceBusy++;
        try {
            const api = 'https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid);
            let j = await biliApiGet(api, false);
            if (!j || j.code !== 0 || !j.data) j = await biliApiGet(api, true);
            const det = (j && j.code === 0 && j.data) ? j.data : null;
            if (!det) { reply('这个 BV 号取不到视频（号不对 / 已删除 / 被风控）。'); return; }

            const title = det.title || '';
            const up = (det.owner && det.owner.name) || '';
            let cover = String(det.pic || '');
            if (cover.indexOf('//') === 0) cover = 'https:' + cover;
            cover = cover.replace(/^http:\/\//i, 'https://');
            const dur = Number(det.duration || 0);
            const link = 'https://www.bilibili.com/video/' + bvid;

            if (dur > BILI_VOICE_MAX_SEC) {
                reply(title + '\nup主：' + up + '\n太长了（' + Math.round(dur / 60) + ' 分钟），上限 '
                    + (BILI_VOICE_MAX_SEC / 60) + ' 分钟，这条就不发了。\n' + link);
                return;
            }

            // 先给回执（正在听 + 封面 + 标题 + up主），再单独发语音
            const head = [{ type: 'text', data: { text: '正在听' } }];
            if (cover) head.push({ type: 'image', data: { file: cover } });
            head.push({ type: 'text', data: { text: '\n' + title + '\nup主：' + up } });
            reply(head);

            const got = await biliVoiceFetch(bvid, det.cid);
            if (got.bytes > BILI_VOICE_MAX_BYTES) {
                reply('音频太大（' + (got.bytes / 1048576).toFixed(1) + ' MB），超过 '
                    + (BILI_VOICE_MAX_BYTES / 1048576) + ' MB 上限，这条就不发了。');
                return;
            }
            biliVoiceLastAt.set(String(uid), Date.now());   // 只有真的发出语音才算一次「听过」
            reply([{ type: 'record', data: { file: 'file://' + got.file } }]);
            console.log('🎧 /bilibili听视频 ' + bvid + ' -> ' + title + ' | '
                + got.seconds.toFixed(1) + 's ' + (got.bytes / 1048576).toFixed(2) + 'MB'
                + (got.cached ? ' (缓存)' : ''));
        } catch (e) {
            console.error('[/bilibili听视频] 失败:', (e && e.message) ? e.message : e);
            reply('音频没拿到：' + String((e && e.message) || e).slice(0, 120));
        } finally {
            biliVoiceBusy--;
        }
    }
});

// ==================== 相册功能 ====================
// 相册【全局共享】（所有群聊同一套相册与黑名单）
// 开启/关闭【按群生效】；黑名单与开关仅管理员（0）可用
// 数据： data/albums/album.json（相册+黑名单） data/albums/groups.json（各群开关） data/albums/album_<id>/*
const ALBUM_BASE = path.join(__dirname, 'data', 'albums');
const ALBUM_ADMIN = String(process.env.ON_ADMIN || '0');
let albumIdxCache = null;
let albumGroupsCache = null;

function albumJsonPath() { return path.join(ALBUM_BASE, 'album.json'); }
function albumGroupsPath() { return path.join(ALBUM_BASE, 'groups.json'); }
function albumDirOf(id) { return path.join(ALBUM_BASE, 'album_' + id); }

// ---- 全局相册索引 ----
function getAlbumIdx() {
    if (albumIdxCache) return albumIdxCache;
    const idx = { nextId: 1, blacklist: [], albums: {} };
    try {
        if (fs.existsSync(albumJsonPath())) {
            const j = JSON.parse(fs.readFileSync(albumJsonPath(), 'utf8'));
            idx.nextId = j.nextId || 1;
            idx.blacklist = Array.isArray(j.blacklist) ? j.blacklist : [];
            idx.albums = (j.albums && typeof j.albums === 'object') ? j.albums : {};
        }
    } catch (e) { console.error('相册索引读取失败:', e.message); }
    albumIdxCache = idx;
    return idx;
}
function saveAlbumIdx() {
    const idx = albumIdxCache;
    if (!idx) return;
    try {
        fs.mkdirSync(ALBUM_BASE, { recursive: true });
        fs.writeFileSync(albumJsonPath() + '.tmp', JSON.stringify(idx, null, 1));
        fs.renameSync(albumJsonPath() + '.tmp', albumJsonPath());
    } catch (e) { console.error('相册索引保存失败:', e.message); }
}
// ---- 各群开关（默认开启）----
function getGroupsCfg() {
    if (albumGroupsCache) return albumGroupsCache;
    let cfg = {};
    try {
        if (fs.existsSync(albumGroupsPath())) cfg = JSON.parse(fs.readFileSync(albumGroupsPath(), 'utf8')) || {};
    } catch (e) { console.error('相册群配置读取失败:', e.message); }
    albumGroupsCache = cfg;
    return cfg;
}
function saveGroupsCfg() {
    try {
        fs.mkdirSync(ALBUM_BASE, { recursive: true });
        fs.writeFileSync(albumGroupsPath() + '.tmp', JSON.stringify(albumGroupsCache || {}, null, 1));
        fs.renameSync(albumGroupsPath() + '.tmp', albumGroupsPath());
    } catch (e) { console.error('相册群配置保存失败:', e.message); }
}
function albumEnabledIn(groupId) {
    const cfg = getGroupsCfg();
    const g = cfg[String(groupId)];
    return !(g && g.enabled === false); // 默认开启
}
function isAlbumAdmin(userId) { return String(userId) === ALBUM_ADMIN; }

// 查找：相册名优先，其次别名
function findAlbum(idx, q) {
    const key = String(q === undefined || q === null ? '' : q).trim();
    if (!key) return null;
    for (const id of Object.keys(idx.albums)) {
        const a = idx.albums[id];
        if (a && a.name === key) return { id: id, album: a };
    }
    for (const id of Object.keys(idx.albums)) {
        const a = idx.albums[id];
        if (a && (a.aliases || []).indexOf(key) >= 0) return { id: id, album: a };
    }
    return null;
}
// 黑名单命中：查询词、相册名、任一别名在名单内都算
function albumBlacklisted(idx, q, album) {
    const key = String(q === undefined || q === null ? '' : q).trim();
    if (key && idx.blacklist.indexOf(key) >= 0) return true;
    if (!album) return false;
    if (idx.blacklist.indexOf(album.name) >= 0) return true;
    return (album.aliases || []).some(function (a) { return idx.blacklist.indexOf(a) >= 0; });
}
function albumExistingFiles(id, album) {
    const d = albumDirOf(id);
    return (album.files || []).map(function (f) { return path.join(d, f); }).filter(function (p) {
        try { return fs.statSync(p).size > 0; } catch (e) { return false; }
    });
}
// 与现有「图片分组」关键词冲突（/看图 /看马 …）时不认领，让位给原功能
function albumConflictsImageKeywords(plain) {
    for (const g of CONFIG.IMAGE_GROUPS) {
        const kws = [].concat(g.showKeywords || [], g.saveKeywords || [], g.triggerKeywords || []);
        for (const k of kws) { if (k && plain.indexOf(k) >= 0) return true; }
    }
    return false;
}

// ---- 回复（文字/图片，默认引用触发指令）----
function albumTarget(msg) {
    return msg.message_type === 'private'
        ? { action: 'send_private_msg', params: { user_id: msg.sender.user_id } }
        : { action: 'send_group_msg', params: { group_id: msg.group_id } };
}
function albumSend(ws, msg, segs, quote) {
    if (!ws) return;
    const t = albumTarget(msg);
    const arr = Array.isArray(segs) ? segs.slice() : [{ type: 'text', data: { text: String(segs) } }];
    if (quote !== false) arr.unshift({ type: 'reply', data: { id: String(msg.message_id) } });
    sendReply(ws, t.action, Object.assign({}, t.params, { message: arr }));
}
function albumText(ws, msg, text) { albumSend(ws, msg, text, true); }
function albumImage(ws, msg, filePath) {
    albumSend(ws, msg, [{ type: 'image', data: { file: 'file://' + String(filePath).replace(/\\/g, '/') } }], true);
}

// ---- 转发（聊天记录）里的图片 ----
function extractForwardId(msg) {
    const segs = (msg && Array.isArray(msg.message)) ? msg.message : [];
    for (const s of segs) if (s && s.type === 'forward' && s.data && s.data.id) return String(s.data.id);
    return null;
}

/** 取一条聊天记录里的全部图片源（支持嵌套转发、CQ 串两种形态） */
async function forwardImageSrcs(fid, depth) {
    const out = [];
    if (!fid || (depth || 0) > 3) return out;
    const r = await napcatApi('get_forward_msg', { id: String(fid) }, 20000);
    if (!r || r.status !== 'ok' || !r.data) {
        console.log('🔍 聊天记录读取失败: ' + JSON.stringify((r && (r.message || r.status)) || null).slice(0, 80));
        return out;
    }
    for (const nd of (r.data.messages || r.data.message || [])) {
        const segs = (nd && nd.message) || [];
        if (typeof segs === 'string') {
            const re = /\[CQ:(?:image|mface)[^\]]*(?:url|file)=([^,\]]+)/g;
            let m;
            while ((m = re.exec(segs))) out.push(m[1]);
            continue;
        }
        for (const s of segs) {
            if (!s || !s.data) continue;
            if (s.type === 'image' || s.type === 'mface') {
                const src = s.data.url || s.data.file || '';
                if (src) out.push(src);
            } else if (s.type === 'forward' && s.data.id) {
                const inner = await forwardImageSrcs(s.data.id, (depth || 0) + 1);
                for (const x of inner) out.push(x);
            }
        }
    }
    return out;
}

/** 引用（回复）消息里的转发 id —— 常见用法是「引用一条聊天记录，再发 /上传 相册名」 */
async function quotedForwardId(msg) {
    const qid = replyQuoteIdOf(msg && msg.message);
    if (!qid) return null;
    const r = await napcatApi('get_msg', { message_id: Number(qid) }, 8000);
    if (!r || r.status !== 'ok' || !r.data) return null;
    return extractForwardId({ message: r.data.message });
}

/** 存一张图进相册（带内容去重）：返回 'ok' | 'dup' | 'fail' */
async function albumAddImage(hit, src) {
    let file = null;
    try { file = await saveAlbumImage(hit.id, src); } catch (e) { console.error('相册图片保存失败:', e.message); }
    if (!file) return 'fail';
    const newPath = path.join(albumDirOf(hit.id), file);
    const newHash = albumFileHash(newPath);
    if (newHash) {
        for (const f of albumExistingFiles(hit.id, hit.album)) {
            if (albumFileHash(f) === newHash) {
                try { fs.unlinkSync(newPath); } catch (e) {}
                console.log('🖼️ 相册去重: ' + hit.album.name + ' 已存在相同图片 ' + path.basename(f));
                return 'dup';
            }
        }
    }
    hit.album.files = (hit.album.files || []).concat([file]);
    return 'ok';
}

/** 全部相册的所有图片，按文件名里的时间戳升序 → 全局编号（位置编号，删一张后面自动前移） */
function albumGlobalImages() {
    const idx = getAlbumIdx();
    const rows = [];
    for (const id of Object.keys(idx.albums)) {
        const a = idx.albums[id];
        for (const f of albumExistingFiles(id, a)) {
            const b = path.basename(f);
            const t = Number((b.split('_')[0]) || 0) || 0;
            rows.push({ path: f, name: b, albumId: id, album: a.name, at: t });
        }
    }
    rows.sort(function (x, y) { return (x.at - y.at) || (x.path < y.path ? -1 : 1); });
    rows.forEach(function (r, i) { r.id = i + 1; });
    return rows;
}

function albumFindImage(no) {
    const rows = albumGlobalImages();
    const n = Number(no);
    if (!isFinite(n) || n < 1 || n > rows.length) return { rows: rows, miss: true, n: n };
    return { rows: rows, row: rows[n - 1], n: n };
}

/** /看全部相册：每个相册取第一张图当封面 + 相册名，渲染成网格发出 */
async function albumShowAlbumIndex(ws, msg) {
    const idx = getAlbumIdx();
    const items = [];
    const order = Object.keys(idx.albums).sort(function (a, b) {
        const x = String((idx.albums[a] || {}).name || ''), y = String((idx.albums[b] || {}).name || '');
        try { return x.localeCompare(y, 'zh-Hans-CN'); } catch (e) { return x < y ? -1 : (x > y ? 1 : 0); }
    });
    for (const id of order) {
        const a = idx.albums[id];
        const files = albumExistingFiles(id, a);
        items.push({ path: files.length ? files[0] : '', album: a.name, id: Number(id) });
    }
    if (!items.length) return albumText(ws, msg, '还没有任何相册，用 /新建相册 相册名 创建一个吧');
    const empty = items.filter(function (x) { return !x.path; }).length;
    const manifest = path.join('/tmp', 'album_index_' + Date.now() + '.json');
    const out = path.join(ALBUM_BASE, 'albumindex.png');
    try {
        fs.writeFileSync(manifest, JSON.stringify({
            title: '相册一览',
            sub: '共 ' + items.length + ' 个相册' + (empty ? '（其中 ' + empty + ' 个还没有图片）' : ''),
            showIds: false,
            showAlbum: true,
            empty: '还没有图片',
            note: ['/新建相册 <名>　/相册列表　/看全部相册　/删除图片 <编号>',
                   '/上传 <名>（附图 / 引用一张图 / 引用一条聊天记录＝整条导入）',
                   '/看 <名> 随机一张　/看 <编号> 看该图　/看全部 <名> 看该相册编号总览',
                   '/添加相册别名 <名> <别名>　/删除相册别名 <名> <别名>',
                   '/相册黑名单 <别名或相册名>　/取消相册黑名单 <别名或相册名>（管理员）',
                   '/开启相册功能　/关闭相册功能（管理员，仅本群生效）'].join('\n'),
            items: items,
        }));
        const execFile = require('child_process').execFile;
        await new Promise(function (resolve, reject) {
            execFile('python3', [path.join(__dirname, 'tools', 'albumgrid.py'), '--manifest', manifest, '--out', out],
                { timeout: 120000 }, function (err, stdout, stderr) {
                    if (err) return reject(new Error(String(stderr || err.message).slice(-160)));
                    resolve();
                });
        });
        albumImage(ws, msg, out);
        console.log('🖼️ 看全部相册：' + items.length + ' 个相册的封面图');
    } catch (e) {
        console.error('相册一览图失败:', e.message);
        albumText(ws, msg, '相册一览图生成失败：' + String(e.message).slice(0, 120));
    } finally {
        try { fs.unlinkSync(manifest); } catch (e) {}
    }
}

/** /看全部 <相册名>：渲染「缩略图 + 编号」总览图并发出 */
async function albumShowAll(ws, msg, hit) {
    if (!hit) return albumListText(ws, msg);
    const use = albumGlobalImages().filter(function (r) { return r.albumId === hit.id; });
    if (!use.length) {
        return albumText(ws, msg, '相册「' + hit.album.name + '」还没有图片，用 /上传' + hit.album.name + ' 添加吧');
    }
    const list = use.slice(0, 300);
    const manifest = path.join('/tmp', 'album_grid_' + Date.now() + '.json');
    const out = path.join(ALBUM_BASE, 'grid.png');
    try {
        fs.writeFileSync(manifest, JSON.stringify({
            title: '相册「' + hit.album.name + '」',
            showIds: true,
            showAlbum: false,
            empty: '图片缺失',
            sub: '共 ' + use.length + ' 张' + (list.length < use.length ? '（图上前 ' + list.length + ' 张）' : ''),
            items: list.map(function (r) { return { id: r.id, path: r.path, album: r.album }; }),
        }));
        const execFile = require('child_process').execFile;
        await new Promise(function (resolve, reject) {
            execFile('python3', [path.join(__dirname, 'tools', 'albumgrid.py'), '--manifest', manifest, '--out', out],
                { timeout: 120000 }, function (err, stdout, stderr) {
                    if (err) return reject(new Error(String(stderr || err.message).slice(-160)));
                    resolve();
                });
        });
        albumImage(ws, msg, out);
        console.log('🖼️ 看全部总览图 ' + use.length + ' 张（相册 ' + hit.album.name + '）');
    } catch (e) {
        console.error('相册总览图失败:', e.message);
        albumText(ws, msg, '总览图生成失败：' + String(e.message).slice(0, 120));
    } finally {
        try { fs.unlinkSync(manifest); } catch (e) {}
    }
}

// ---- 开关 / 权限 ----
function albumGate(ws, msg) {
    if (msg.message_type !== 'group') { albumText(ws, msg, '相册功能仅支持在群聊中使用'); return false; }
    if (!albumEnabledIn(msg.group_id)) { albumText(ws, msg, '本群相册功能已被管理员关闭'); return false; }
    return true;
}
function albumAdminGate(ws, msg) {
    if (!isAlbumAdmin(msg.sender && msg.sender.user_id)) { albumText(ws, msg, '该指令仅限管理员使用'); return false; }
    return true;
}
function albumListText(ws, msg) {
    const idx = getAlbumIdx();
    const lines = Object.keys(idx.albums).map(function (id) {
        const a = idx.albums[id];
        const n = albumExistingFiles(id, a).length;
        const al = (a.aliases || []).length ? '（别名：' + a.aliases.join('、') + '）' : '';
        const bl = albumBlacklisted(idx, a.name, a) ? '［黑名单］' : '';
        return '· ' + a.name + al + bl + '　' + n + ' 张';
    });
    if (!lines.length) return albumText(ws, msg, '还没有任何相册，用 /新建相册 相册名 创建一个吧（/看全部相册 看封面一览）');
    albumText(ws, msg, '相册列表（' + lines.length + '，所有群共享）\n' + lines.join('\n'));
}

// ---- 图片内容哈希（用于上传去重）----
const albumHashCache = new Map(); // 文件路径 -> {size, mtimeMs, hash}
function albumFileHash(p) {
    try {
        const st = fs.statSync(p);
        const c = albumHashCache.get(p);
        if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.hash;
        const h = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
        albumHashCache.set(p, { size: st.size, mtimeMs: st.mtimeMs, hash: h });
        return h;
    } catch (e) { return null; }
}

// ---- 保存图片到相册目录 ----
async function saveAlbumImage(id, src) {
    const dir = albumDirOf(id);
    fs.mkdirSync(dir, { recursive: true });
    const base = Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    let dest = null;
    if (/^base64:\/\//i.test(src)) {
        const b64 = src.replace(/^base64:\/\//i, '');
        let ext = '.jpg';
        if (b64.startsWith('R0lGOD')) ext = '.gif';
        else if (b64.startsWith('iVBOR')) ext = '.png';
        else if (b64.startsWith('/9j/')) ext = '.jpg';
        dest = path.join(dir, base + ext);
        fs.writeFileSync(dest, Buffer.from(b64, 'base64'));
    } else if (/^https?:\/\//i.test(src)) {
        let ext = '.jpg';
        try {
            const e = path.extname(new URL(src).pathname).toLowerCase();
            if (/^\.(gif|png|jpg|jpeg|webp)$/.test(e)) ext = e;
        } catch (e) {}
        dest = path.join(dir, base + ext);
        await downloadFile(src, dest);
    } else if (/^file:\/\//i.test(src)) {
        const p = src.replace(/^file:\/\//i, '');
        dest = path.join(dir, base + (path.extname(p) || '.jpg'));
        fs.copyFileSync(p, dest);
    } else {
        return null;
    }
    let size = 0;
    try { size = fs.statSync(dest).size; } catch (e) {}
    if (!size) { try { fs.unlinkSync(dest); } catch (e) {} return null; }
    return path.basename(dest);
}

// ---- /新建相册 <名称> ----
commands.push({
    ignoreAt: true,
    match(plain) {
        const m = plain.match(/^\s*\/\s*新建相册\s*([\s\S]*)$/);
        return m ? { name: (m[1] || '').trim() } : false;
    },
    execute(ws, msg, p) {
        if (!albumGate(ws, msg)) return;
        if (!p.name) return albumText(ws, msg, '用法：/新建相册 相册名');
        const idx = getAlbumIdx();
        if (findAlbum(idx, p.name)) return albumText(ws, msg, '相册「' + p.name + '」已存在');
        const id = String(idx.nextId++);
        idx.albums[id] = { name: p.name, aliases: [], files: [], by: String(msg.sender.user_id), at: Date.now() };
        saveAlbumIdx();
        console.log('🖼️ 新建相册 ' + p.name + ' (id=' + id + ') by ' + msg.sender.user_id);
        albumText(ws, msg, '已新建相册「' + p.name + '」（所有群共享）\n上传：/上传' + p.name + '（附图 / 引用一张图片 / 引用一条聊天记录＝整条记录全传）'
            + '\n随机看：/看' + p.name + '　本相册总览：/看全部' + p.name + '　相册一览：/看全部相册'
            + '\n按编号看：/看 <编号>　删除：/删除图片 <编号>');
    }
});

// ---- /上传 <相册名> ----
commands.push({
    ignoreAt: true,
    match(plain) {
        const m = plain.match(/^\s*\/\s*上传\s*([\s\S]*)$/);
        return m ? { name: (m[1] || '').trim() } : false;
    },
    async execute(ws, msg, p) {
        if (!albumGate(ws, msg)) return;
        if (!p.name) return albumText(ws, msg, '用法：/上传 相册名（并附带图片/GIF，或引用一张图片/表情包）');
        const idx = getAlbumIdx();
        const hit = findAlbum(idx, p.name);
        if (!hit) return albumText(ws, msg, '相册「' + p.name + '」不存在，先用 /新建相册 ' + p.name + ' 创建');
        if (albumBlacklisted(idx, p.name, hit.album)) return albumText(ws, msg, '相册「' + hit.album.name + '」已被加入黑名单');
        // 1) 聊天记录（合并转发）：本消息里的转发，或引用消息里的转发 → 整条记录里的图片全传
        const fid = extractForwardId(msg) || await quotedForwardId(msg);
        if (fid) {
            const srcs = await forwardImageSrcs(fid);
            if (!srcs.length) return albumText(ws, msg, '这条聊天记录里没有图片（或读取失败）');
            albumText(ws, msg, '聊天记录里有 ' + srcs.length + ' 张图，正在保存…');
            let ok = 0, dup = 0, fail = 0;
            for (const s of srcs) {
                const r = await albumAddImage(hit, s);
                if (r === 'ok') ok++;
                else if (r === 'dup') dup++;
                else fail++;
            }
            saveAlbumIdx();
            const total = albumExistingFiles(hit.id, hit.album).length;
            console.log('🖼️ 聊天记录上传 ' + hit.album.name + '：新增 ' + ok + ' 去重 ' + dup + ' 失败 ' + fail);
            return albumText(ws, msg, '已从聊天记录上传到相册「' + hit.album.name + '」\n新增 ' + ok + ' 张'
                + (dup ? '，重复跳过 ' + dup + ' 张' : '') + (fail ? '，失败 ' + fail + ' 张' : '')
                + '\n当前共 ' + total + ' 张（发 /看全部 看编号总览）');
        }
        // 2) 单张图（本消息附带，或引用一张图片）
        const src = await imageSrcOfMsgOrQuote(msg);
        if (!src) return albumText(ws, msg, '请附带图片/GIF、引用一张图片，或引用一条聊天记录（整条记录一起上传）');
        const r2 = await albumAddImage(hit, src);
        const total2 = albumExistingFiles(hit.id, hit.album).length;
        if (r2 === 'fail') return albumText(ws, msg, '图片保存失败，请重试');
        if (r2 === 'dup') return albumText(ws, msg, '这张图已经在相册「' + hit.album.name + '」里了，未重复添加（当前共 ' + total2 + ' 张）');
        saveAlbumIdx();
        console.log('🖼️ 上传相册 ' + hit.album.name + ' by ' + msg.sender.user_id);
        albumText(ws, msg, '已上传到相册「' + hit.album.name + '」，当前共 ' + total2 + ' 张（发 /看全部 看编号总览）');
    }
});

// ---- /看看<相册名> / /看<相册名>（无参则列出相册）----
commands.push({
    ignoreAt: true,
    match(plain, msg) {
        const m = plain.match(/^\s*\/\s*(看全部相册|看全部|看看|看)\s*([\s\S]*)$/);
        if (!m) return false;
        if (m[1] === '看全部相册') return { albums: true };                // 相册封面总览
        const all = m[1] === '看全部';
        const name = (m[2] || '').trim();
        if (/^\d+$/.test(name)) return { name: name, byId: Number(name), all: false };   // /看 23 = 按全局编号看
        if (!name) return { name: '', list: true };                        // 不带相册名 → 相册列表
        const hit = findAlbum(getAlbumIdx(), name);
        if (hit) return { name: name, hit: hit, all: all };
        if (albumConflictsImageKeywords(plain)) return false; // 让位给 /看图 /看马 等原功能
        return { name: name, miss: true, all: all };
    },
    execute(ws, msg, p) {
        if (!albumGate(ws, msg)) return;
        if (p.albums) return albumShowAlbumIndex(ws, msg);   // /看全部相册
        if (p.byId) {                                  // /看 <编号>
            const r = albumFindImage(p.byId);
            if (r.miss) return albumText(ws, msg, '没有编号 ' + p.byId + ' 的图片（当前共 ' + r.rows.length + ' 张，发 /看全部 看编号总览）');
            albumImage(ws, msg, r.row.path);
            console.log('🖼️ 看图 #' + p.byId + ' -> ' + r.row.album + '/' + r.row.name);
            return;
        }
        if (p.all) return albumShowAll(ws, msg, p.hit || null);       // /看全部 <相册名> → 该相册总览图
        if (p.list) return albumListText(ws, msg);
        const idx = getAlbumIdx();
        if (p.miss) return albumText(ws, msg, '相册「' + p.name + '」不存在（发 /看看 可查看相册列表）');
        const hit = p.hit || findAlbum(idx, p.name);
        if (!hit) return albumText(ws, msg, '相册「' + p.name + '」不存在');
        if (albumBlacklisted(idx, p.name, hit.album)) return albumText(ws, msg, '相册「' + hit.album.name + '」已被加入黑名单');
        const files = albumExistingFiles(hit.id, hit.album);
        if (!files.length) return albumText(ws, msg, '相册「' + hit.album.name + '」还没有图片，用 /上传' + hit.album.name + ' 添加吧');
        const f = files[Math.floor(Math.random() * files.length)];
        albumImage(ws, msg, f);
        console.log('🖼️ 查看相册 ' + hit.album.name + ' -> ' + path.basename(f) + '（共 ' + files.length + '）');
    }
});

// ---- /删除图片 <编号>（删掉后后面的编号前移）----
commands.push({
    ignoreAt: true,
    match(plain) {
        const m = plain.match(/^\s*\/\s*删除图片\s*([\s\S]*)$/);
        return m ? { arg: (m[1] || '').trim() } : false;
    },
    execute(ws, msg, p) {
        if (!albumGate(ws, msg)) return;
        if (!/^\d+$/.test(p.arg)) return albumText(ws, msg, '用法：/删除图片 <编号>（编号见 /看全部）');
        const r = albumFindImage(Number(p.arg));
        if (r.miss) return albumText(ws, msg, '没有编号 ' + p.arg + ' 的图片（当前共 ' + r.rows.length + ' 张）');
        const row = r.row;
        try { fs.unlinkSync(row.path); } catch (e) { console.error('删除图片失败:', e.message); }
        const idx = getAlbumIdx();
        const a = idx.albums[row.albumId];
        if (a) {
            a.files = (a.files || []).filter(function (f) { return f !== row.name; });
            saveAlbumIdx();
        }
        const left = albumGlobalImages().length;
        console.log('🖼️ 删除图片 #' + p.arg + ' -> ' + row.album + '/' + row.name + '（剩 ' + left + ' 张）');
        albumText(ws, msg, '已删除 #' + p.arg + '（' + row.album + '）\n剩余 ' + left + ' 张，编号已前移（发 /看全部 看新的编号）');
    }
});

// ---- /添加相册别名 <相册名> <别名> ----
commands.push({
    ignoreAt: true,
    match(plain) {
        const m = plain.match(/^\s*\/\s*添加相册别名\s*([\s\S]*)$/);
        return m ? { parts: (m[1] || '').trim().split(/\s+/).filter(Boolean) } : false;
    },
    execute(ws, msg, p) {
        if (!albumGate(ws, msg)) return;
        if (p.parts.length < 2) return albumText(ws, msg, '用法：/添加相册别名 相册名 别名');
        const albumName = p.parts[0], alias = p.parts[1];
        const idx = getAlbumIdx();
        const hit = findAlbum(idx, albumName);
        if (!hit) return albumText(ws, msg, '相册「' + albumName + '」不存在');
        const other = findAlbum(idx, alias);
        if (other && other.id !== hit.id) return albumText(ws, msg, '「' + alias + '」已被相册「' + other.album.name + '」使用');
        hit.album.aliases = hit.album.aliases || [];
        if (hit.album.aliases.indexOf(alias) < 0) hit.album.aliases.push(alias);
        saveAlbumIdx();
        console.log('🖼️ 相册别名 ' + hit.album.name + ' += ' + alias);
        albumText(ws, msg, '已为相册「' + hit.album.name + '」添加别名「' + alias + '」');
    }
});

// ---- /删除相册别名 <相册名> <别名> ----
commands.push({
    ignoreAt: true,
    match(plain) {
        const m = plain.match(/^\s*\/\s*删除相册别名\s*([\s\S]*)$/);
        return m ? { parts: (m[1] || '').trim().split(/\s+/).filter(Boolean) } : false;
    },
    execute(ws, msg, p) {
        if (!albumGate(ws, msg)) return;
        if (p.parts.length < 2) return albumText(ws, msg, '用法：/删除相册别名 相册名 别名');
        const albumName = p.parts[0], alias = p.parts[1];
        const idx = getAlbumIdx();
        const hit = findAlbum(idx, albumName);
        if (!hit) return albumText(ws, msg, '相册「' + albumName + '」不存在');
        const before = (hit.album.aliases || []).length;
        hit.album.aliases = (hit.album.aliases || []).filter(function (a) { return a !== alias; });
        if (hit.album.aliases.length === before) return albumText(ws, msg, '相册「' + hit.album.name + '」没有别名「' + alias + '」');
        saveAlbumIdx();
        console.log('🖼️ 删除相册别名 ' + hit.album.name + ' -= ' + alias);
        albumText(ws, msg, '已删除相册「' + hit.album.name + '」的别名「' + alias + '」');
    }
});

// ---- /相册黑名单 [别名或相册名]（管理员，全局）----
commands.push({
    ignoreAt: true,
    match(plain) {
        const m = plain.match(/^\s*\/\s*相册黑名单\s*([\s\S]*)$/);
        return m ? { arg: (m[1] || '').trim() } : false;
    },
    execute(ws, msg, p) {
        if (!albumAdminGate(ws, msg)) return;
        const idx = getAlbumIdx();
        if (!p.arg) {
            if (!idx.blacklist.length) return albumText(ws, msg, '相册黑名单为空（用法：/相册黑名单 别名或相册名）');
            return albumText(ws, msg, '相册黑名单（' + idx.blacklist.length + '，全局）：\n· ' + idx.blacklist.join('\n· '));
        }
        const hit = findAlbum(idx, p.arg);
        const keys = hit ? [hit.album.name].concat(hit.album.aliases || [], [p.arg]).filter(function (v, i, a) { return v && a.indexOf(v) === i; }) : [p.arg];
        let added = 0;
        for (const k of keys) { if (idx.blacklist.indexOf(k) < 0) { idx.blacklist.push(k); added++; } }
        if (!added) return albumText(ws, msg, '「' + p.arg + '」已在黑名单中');
        saveAlbumIdx();
        console.log('🖼️ 相册黑名单 += ' + keys.join(','));
        albumText(ws, msg, '已加入相册黑名单：' + keys.join('、') + (hit ? '（对应相册「' + hit.album.name + '」）' : ''));
    }
});

// ---- /取消相册黑名单 <别名或相册名>（管理员）----
commands.push({
    ignoreAt: true,
    match(plain) {
        const m = plain.match(/^\s*\/\s*取消相册黑名单\s*([\s\S]*)$/);
        return m ? { arg: (m[1] || '').trim() } : false;
    },
    execute(ws, msg, p) {
        if (!albumAdminGate(ws, msg)) return;
        if (!p.arg) return albumText(ws, msg, '用法：/取消相册黑名单 别名或相册名');
        const idx = getAlbumIdx();
        const before = idx.blacklist.length;
        const hit = findAlbum(idx, p.arg);
        // 连同该相册的全部别名一起移出
        const keys = hit ? [hit.album.name].concat(hit.album.aliases || [], [p.arg]) : [p.arg];
        idx.blacklist = idx.blacklist.filter(function (k) { return keys.indexOf(k) < 0; });
        if (idx.blacklist.length === before) return albumText(ws, msg, '「' + p.arg + '」不在黑名单中');
        saveAlbumIdx();
        console.log('🖼️ 取消相册黑名单 -= ' + p.arg);
        albumText(ws, msg, '已移出相册黑名单：' + p.arg);
    }
});

// ---- /开启相册功能 / /关闭相册功能（管理员，仅本群）----
commands.push({
    ignoreAt: true,
    match(plain) {
        const m = plain.match(/^\s*\/\s*(开启|关闭)相册功能\s*$/);
        return m ? { enable: m[1] === '开启' } : false;
    },
    execute(ws, msg, p) {
        if (msg.message_type !== 'group') return albumText(ws, msg, '该指令仅支持群聊');
        if (!albumAdminGate(ws, msg)) return;
        const cfg = getGroupsCfg();
        cfg[String(msg.group_id)] = Object.assign({}, cfg[String(msg.group_id)], { enabled: p.enable });
        saveGroupsCfg();
        console.log('🖼️ 相册功能群[' + msg.group_id + '] ' + (p.enable ? '开启' : '关闭'));
        albumText(ws, msg, '本群相册功能已' + (p.enable ? '开启' : '关闭') + '（其它群不受影响）');
    }
});

// ---- /相册列表 ----
commands.push({
    ignoreAt: true,
    match(plain) {
        return /^\s*\/\s*相册列表\s*$/.test(plain) ? { list: true } : false;
    },
    execute(ws, msg, p) {
        if (!albumGate(ws, msg)) return;
        albumListText(ws, msg);
    }
});

// ==================== 戳一戳 ====================

const pokeCooldown = {
    short: new Map(),
    count: new Map(),
    long: new Map()
};

function handlePoke(ws, msg) {
    if (msg.notice_type !== 'notify' || msg.sub_type !== 'poke') return;
    if (msg.target_id !== msg.self_id) return;
    const sender = msg.user_id;
    const group = msg.group_id;
    const now = Date.now();
    // 防刷：短冷却内不重复
    const last = pokeCooldown.short.get(sender);
    if (last && (now - last) < CONFIG.POKE_SHORT_COOLDOWN_MS) return;
    pokeCooldown.short.set(sender, now);

    // 构造一条消息事件转发给 AstrBot，由 AI 回复戳一戳（@ 机器人自己触发 AstrBot）
    const senderName = (msg.sender && (msg.sender.card || msg.sender.nickname)) || String(sender);
    const fake = {
        time: Math.floor(Date.now() / 1000),
        self_id: msg.self_id,
        post_type: 'message',
        message_type: group ? 'group' : 'private',
        group_id: group || undefined,
        user_id: sender,
        raw_message: `[CQ:at,qq=${msg.self_id}] ${senderName} 戳了戳我`,
        message: [
            { type: 'at', data: { qq: String(msg.self_id) } },
            { type: 'text', data: { text: ` ${senderName} 戳了戳我` } }
        ],
        sender: msg.sender || { user_id: sender, nickname: senderName }
    };
    forwardToDownstreams(JSON.stringify(fake));
    console.log(`👆 戳一戳(${sender}) → ` + ((group || isAdminUser(sender))
        ? '转发 AstrBot AI 回复'
        : '私聊非管理员，AI 已禁用（只转发其它下游）'));
}

// ==================== WebSocket 服务 ====================
// ---- Our Notes（/on* 指令）模块：独立文件，仅注册指令，不改动其它逻辑
try {
    const start=commands.length; require('./on_commands')({ commands, sendReply, imageCqFromPath, CONFIG }); commands.slice(start).forEach(c=>c.commandDomain='on');
} catch (e) {
    console.error('⚠️ Our Notes 指令模块加载失败:', e.message);
}

// ---- 明日方舟（/ark* 指令）模块：独立文件，数据与渲染都在 data/ark 下
try {
    const start=commands.length; require('./ark_commands')({ commands, sendReply, imageCqFromPath, CONFIG }); commands.slice(start).forEach(c=>c.commandDomain='ark');
} catch (e) {
    console.error('⚠️ 明日方舟指令模块加载失败:', e.message);
}

const wss = new WebSocket.Server({ host: '127.0.0.1', port: CONFIG.WS_PORT });
console.log(`✅ WebSocket 启动，端口 ${CONFIG.WS_PORT}`);

wss.on('connection', (ws) => {
    console.log('🔗 NapCat 已连接');
    ws.on('message', (data) => {
        let raw = data.toString();
        console.log('📨 收到原始:', raw.slice(0, 120));
        try {
            const msg = JSON.parse(raw);
            // 全局帮助在默认前缀解析、记录触发和任何下游转发之前处理。
            if(msg.post_type==='message'&&['group','private'].includes(msg.message_type)&&require('./global_help').matches(getMessagePlainText(msg.message||msg.raw_message||''))){
                const action=msg.message_type==='group'?'send_group_msg':'send_private_msg';
                const params=msg.message_type==='group'?{group_id:msg.group_id}:{user_id:msg.user_id||msg.sender?.user_id};
                require('./global_help').image().then(buffer=>sendReply(ws,action,Object.assign(params,{message:[{type:'image',data:{file:'base64://'+buffer.toString('base64')}}]}))).catch(e=>{console.error('Global help image:',e.message);sendReply(ws,action,Object.assign(params,{message:require('./global_help').text}));});return;
            }

            if(msg.post_type==='message'){
                const original=getMessagePlainText(msg.message||msg.raw_message||'');
                const resolved=backendRules.resolve(msg.group_id,original);
                if(resolved.plain!==original.trim()){
                    const arr=Array.isArray(msg.message)?msg.message:[];
                    msg.message=arr.filter(x=>x.type!=='text');msg.message.push({type:'text',data:{text:resolved.plain}});
                    msg.raw_message=msg.message.filter(x=>x.type==='at').map(x=>'[CQ:at,qq='+x.data.qq+'] ').join('')+resolved.plain;
                    raw=JSON.stringify(msg);
                }
            }
            // ===== 黑名单用户：其发的所有消息直接忽略（不回复、不转发、不进任何命令）=====
            try {
                if (msg && msg.post_type === 'message') {
                    const u = String(msg.user_id || (msg.sender && msg.sender.user_id) || '');
                    if (u && BLOCK_QOS.includes(u)) {
                        console.log('🚫 黑名单用户消息已忽略 user_id=' + u);
                        return;
                    }
                }
            } catch (e) {}
            // ===== @xxx 1 检测：纯 [@某人]+"1" → 回复 @发送者 1，作为对话功能检测 =====
            if (msg.post_type === 'message' && msg.message_type === 'group' &&
                Array.isArray(msg.message) && msg.message.length === 2 &&
                msg.message[0] && msg.message[0].type === 'at' &&
                msg.message[1] && msg.message[1].type === 'text' &&
                msg.message[1].data && String(msg.message[1].data.text).trim() === '1') {
                sendReply(ws, 'send_group_msg', { group_id: msg.group_id, message: `[CQ:at,qq=${msg.sender.user_id}] 1` });
                console.log('🔔 对话检测回复 [@' + msg.sender.user_id + ' 1]（已拦截，不转发下游）');
                return; // 拦截：不转发下游，避免污染 AstrBot 会话上下文
            }
            // ===== 代理转发 =====
            if (msg.post_type) {
                // 事件（message/notice/request/meta）广播给所有下游
                if (msg.post_type === 'message') {
                    lastTriggerPlain = getMessagePlainText(msg.message || msg.raw_message || '');
                    const ek = eventKeyOf(msg);
                    if (ek) {
                        const nowT = Date.now();
                        if (!pendingTriggers.has(ek)) pendingTriggers.set(ek, []);
                        const q = pendingTriggers.get(ek);
                        while (q.length && nowT - q[0].time > TRIGGER_WINDOW_MS) q.shift(); // 清理过期
                        q.push({ seq: ++msgSeq, time: nowT, messageId: msg.message_id, userId: msg.user_id, plain: lastTriggerPlain });
                        backendReplyGate.record(msg,q[q.length-1]);
                        logAIReply('触发事件 g/p=' + ek + ' msgId=' + msg.message_id + ' user=' + msg.user_id + ' 内容="' + lastTriggerPlain.slice(0, 30) + '"');
                    }
                }
                // DEBUG：打印收到的消息类型，排查图片/GIF 不在 message 数组的问题
                try {
                    if (msg.post_type === 'message') {
                        const types = (Array.isArray(msg.message) ? msg.message : []).map(s => s && s.type);
                        const img = (Array.isArray(msg.message) ? msg.message : []).find(s => s && s.type === 'image');
                        const imgUrl = img && img.data ? (img.data.url || img.data.file || '') : '';
                        console.log('🔍 收到消息 segTypes=' + JSON.stringify(types) + ' group=' + msg.group_id + ' plain=' + getMessagePlainText(msg.message || '').slice(0, 30) + ' IMGURL=' + String(imgUrl).slice(0, 300));
                        // 卡片/转发消息：完整打印所有段（抓到 json/forward/卡片格式）
                        if (types.some(t => t === 'json' || t === 'forward' || t === 'face' || t === 'mface' || t === 'card')) {
                            console.log('🔍 卡片报文 ' + msg.group_id + ': ' + JSON.stringify(msg.message).slice(0, 2000));
                        }
                    }
                } catch (e) {}
                forwardToDownstreams(raw);
            } else if (msg.status !== undefined || msg.retcode !== undefined) {
                // app.js 自己发起的 API 请求（如 get_msg 读引用消息）→ 直接兑现，不再转发给下游
                if (msg.echo && napcatPending.has(msg.echo)) {
                    const p = napcatPending.get(msg.echo);
                    napcatPending.delete(msg.echo);
                    clearTimeout(p.timer);
                    try { p.resolve(msg); } catch (e) {}
                } else {
                    // NapCat 对下游动作的响应，回传下游（保证各下游能收到自己发送动作的确认）
                    forwardToDownstreams(JSON.stringify(msg));
                }
            }
            // ====================
            if (msg.post_type === 'message') {
                // 保存群主消息（异步）
                if (msg.message_type === 'group' && msg.sender?.role === 'owner') {
                    saveOwnerMessage(msg).catch(err => console.error('保存群主消息失败:', err));
                }

                const resolvedLocal=backendRules.resolve(msg.group_id,getPlainText(msg.raw_message));
                const localDomain=resolvedLocal.domain;
                const plain=localDomain==='pjsk'&&!backendRules.special(resolvedLocal.plain)?resolvedLocal.plain.replace(/^\/pjsk/i,'/'):resolvedLocal.plain;
                console.log(`📝 纯文本: "${plain}"`);

                // 1. 先匹配 ignoreAt 命令（删除、保存）
                let matched = null;
                for (const cmd of commands) {
                    if(cmd.commandDomain&&cmd.commandDomain!==localDomain)continue;
                    if(!cmd.commandDomain&&['on','ark','bang'].includes(localDomain))continue;
                    if (cmd.ignoreAt) {
                        const result = cmd.match(plain, msg); // 第2参传消息：相册等指令需要按群判断
                        console.log('🔍 ignoreAt试 match plain="' + plain + '" result=' + JSON.stringify(result).slice(0, 60));
                        if (result !== false) {
                            matched = { cmd, params: result };
                            break;
                        }
                    }
                }

                if (matched) {
                    const key = getKey(msg);
                    if (!key) return;
                    const now = Date.now();
                    const cd = checkCooldown(msg, key, now, matched.cmd);
                    if (!cd.allowed) {
                        if (cd.reason === 'long') {
                            console.log(`⏳ 长冷却（不回复文字）`);
                        } else {
                            console.log(`⏳ 短冷却静默`);
                        }
                        return;
                    }
                    matched.cmd.execute(ws, msg, matched.params, { count: cd.count, triggered: cd.triggered });
                    if (cd.triggered) console.log('🔥 触发长冷却');
                    return;
                }

                // 2. 检查 @ 条件（私聊或群聊被@）
                const shouldReply = (localDomain==='pjsk'&&/^\//.test(plain)) || msg.message_type === 'private' ||
                    (msg.message_type === 'group' && (
                        (Array.isArray(msg.message) && msg.message.some(seg => seg.type === 'at' && seg.data?.qq === msg.self_id)) ||
                        msg.raw_message.includes(`[CQ:at,qq=${msg.self_id}]`)
                    ));
                if (!shouldReply) return;

                const hasImage = Array.isArray(msg.message) && msg.message.some(seg => seg.type === 'image');
                let imageUrl = null;
                if (hasImage) {
                    const seg = msg.message.find(seg => seg.type === 'image');
                    imageUrl = seg?.data?.url || null;
                }

                // 3. 匹配其他命令
                matched = null;
                for (const cmd of commands) {
                    if(cmd.commandDomain&&cmd.commandDomain!==localDomain)continue;
                    if(!cmd.commandDomain&&['on','ark','bang'].includes(localDomain))continue;
                    if (cmd.ignoreAt) continue;
                    const result = cmd.match(plain, { hasImage, imageUrl });
                    if (result !== false) {
                        matched = { cmd, params: result };
                        break;
                    }
                }
                if (!matched) {
                    console.log('⏭️ 无匹配');
                    return;
                }

                const key = getKey(msg);
                if (!key) return;
                const now = Date.now();
                const cd = checkCooldown(msg, key, now, matched.cmd);
                if (!cd.allowed) {
                    if (cd.reason === 'long') console.log(`⏳ 长冷却（不回复文字）`);
                    else console.log(`⏳ 短冷却静默`);
                    return;
                }

                matched.cmd.execute(ws, msg, matched.params, { count: cd.count, triggered: cd.triggered });
                if (cd.triggered) console.log('🔥 触发长冷却');
            } else if (msg.post_type === 'notice') {
                handlePoke(ws, msg);
            }
        } catch (e) {
            console.error('❌ 解析错误:', e);
        }
    });
    ws.on('close', () => console.log('🔌 断开'));
});

console.log('✅ 机器人已启动');

// ==================== OneBot 代理链：app.js 作为 NapCat ↔ 下游(haruki/SakuraBot) 的中间层 ====================
// 事件方向：NapCat → app.js(:6700) → 广播转发 → 各下游
// 回复方向：各下游 → app.js → 修饰映射(REPLY_MODIFIERS) → 转发 → NapCat
// 下游连接：haruki(本地) + SakuraBot(远程功能端，握手需带 X-Self-ID 声明 QQ 号)
// tsugu（Koishi 指令）里必须有参数的指令：不给参数时后端会返回 422，
// 前端只能挤出一句「错误: 后端服务器连接出错」，所以在 app.js 侧就先提示用法。
// /bang 里这些写法都算「求助」：转发给 tsugu 的 help 之后，再补一句 /bang 用法提示
const BANG_HELP_WORDS = ['help', '?', '？', '帮助', '说明', '指令', '菜单', 'menu'];
const BANG_HINT = '提示：这些指令前面加 /bang 就能触发 BanG Dream（tsugu）查询，'
    + '例：/bang查卡 灯　/bang查曲 迷星叫　/banghelp 看全部指令';

const BANG_NEEDS_ARG = {
    查卡: '<关键词|卡牌ID>', 查卡面: '<卡牌ID>', 查角色: '<关键词>', 查活动: '<关键词>',
    查曲: '<关键词|曲目ID>', 查谱面: '<曲目ID> [难度]', 查玩家: '<玩家ID> [服务器]',
    查卡池: '<卡池ID>', 查试炼: '<活动ID>', 绑定玩家: '[服务器名]', 主服务器: '<服务器名>',
    玩家默认ID: '<序号>', ycx: '<档位> [活动ID] [服务器]', lsycx: '<档位> [活动ID] [服务器]',
};

const DOWNSTREAM_WS = [
    // tsugu（BanG Dream 查询 bot，Koishi + koishi-plugin-tsugu-bangdream-bot）：
    // 只有 /bang 开头的消息才转给它，且会去掉 /bang 前缀；它的回复也直接发，不掺 AI 修饰 / 合并。
    // Koishi 的 ws-reverse 握手要求这两个头
    { name: "tsugu",         url: "ws://127.0.0.1:5150/onebot", bang: true,
      headers: { "X-Client-Role": "Universal", "X-Self-ID": String(process.env.BOT_SELF_ID || '0') } },
    { name: "haruki",        url: "ws://127.0.0.1:8111/ws" },
    { name: "astrbot",       url: "ws://127.0.0.1:6199/ws", headers: { "X-Client-Role": "Universal", "X-Self-ID": String(process.env.BOT_SELF_ID || '0') } },
    { name: "sakura-pjsk",   url: (process.env.SAKURA_PJSK_URL || '') },
    { name: "sakura-舞萌",   url: (process.env.SAKURA_MAIMAI_URL || '') },
    { name: "sakura-太鼓",   url: (process.env.SAKURA_TAIKO_URL || '') },
];
// SakuraBot 端点要求的握手头（声明 QQ 号）
const DOWNSTREAM_HEADERS = { "X-Self-ID": String(process.env.BOT_SELF_ID || '0'), "X-OneBot-Version": "11" };
const downstreamClients = {}; // name -> ws
// 收到求助类 /bang 之后的「待补提示」：等 tsugu 的帮助列表发完再发提示，免得顺序颠倒；
// tsugu 3 秒没回就自己发（万一 help 指令不可用）
const bangHelpPending = new Map();   // 'g:群号' / 'p:QQ' -> { timer }
const bangKeyOfParams = (params) => (!params ? null
    : (params.group_id ? 'g:' + params.group_id : (params.user_id ? 'p:' + params.user_id : null)));
function sendByKey(key, text) {
    if (!key) return;
    forwardToNapCat(key.startsWith('g:')
        ? { action: 'send_group_msg', params: { group_id: key.slice(2), message: text } }
        : { action: 'send_private_msg', params: { user_id: key.slice(2), message: text } });
}

// ==================== 回复合并：同一触发的多下游回复合并为一条发出 ====================
// 例如用户发 /个人信息：haruki 回复图片、AstrBot 回复一句话，
// app.js 等待两者都到（窗口内），合并为 [haruki内容]\n[astr内容] 一条消息发出。
const MERGE_WINDOW_MS = 2500;    // 合并等待窗口（毫秒），可调整
const TRIGGER_WINDOW_MS = 10000; // 触发事件关联有效期（毫秒）
let msgSeq = 0;
const pendingTriggers = new Map(); // 'g:群号' 或 'p:QQ' -> [{ seq, time, messageId, userId }]（FIFO 消息队列，astrbot 回复时消费最早一条）
const pendingMerges = new Map();  // seq -> { replies: [], timer }

// AI 回复时序日志（独立文件，便于排查响应慢）
const AI_LOG_FILE = '/tmp/ai_reply.log';
function logAIReply(msg) {
    const line = '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ' + msg;
    console.log(line);
    try { fs.appendFileSync(AI_LOG_FILE, line + '\n'); } catch (e) {}
}

function eventKeyOf(msg) {
    if (msg.post_type !== 'message') return null;
    if (msg.message_type === 'group') return 'g:' + msg.group_id;
    if (msg.message_type === 'private') return 'p:' + msg.user_id;
    return null;
}

function actionKeyOf(action, params) {
    if (action === 'send_group_msg') return params && 'g:' + params.group_id;
    if (action === 'send_private_msg') return params && 'p:' + params.user_id;
    if (action === 'send_msg' && params) {
        if (params.message_type === 'group') return params && 'g:' + params.group_id;
        if (params.message_type === 'private') return params && 'p:' + params.user_id;
    }
    return null;
}

function flushMerge(seq) {
    const pm = pendingMerges.get(seq);
    if (!pm) return;
    pendingMerges.delete(seq);
    if (pm.timer) clearTimeout(pm.timer);
    if (!pm.replies.length) return;
    logAIReply('⏱️ [AI回复] 触发→发出耗时 ' + (Date.now() - pm.triggerTime) + 'ms（' + pm.replies.map(r => r.name).join('+') + '）');
    if (pm.replies.length === 1) {
        forwardToNapCat(pm.replies[0]); // 只有一条回复，直接发
        return;
    }
    // 合并：取第一个动作的参数，message 段数组拼接，段间插入换行（引用由 AstrBot 自带）
    const first = pm.replies[0];
    let segs = [];
    pm.replies.forEach((r, i) => {
        const m = messageToSegments(r.params.message);
        if (m && m.length) {
            if (i > 0 && segs.length) segs.push({ type: 'text', data: { text: '\n' } });
            segs = segs.concat(m);
        }
    });
    const merged = { action: first.action, params: Object.assign({}, first.params, { message: segs }) };
    console.log('🔀 合并回复 [' + pm.replies.map(r => r.name).join('+') + ']:', JSON.stringify(merged).slice(0, 400));
    forwardToNapCat(merged);
}


// ==================== 功能结果→AI修饰（确定性合并） ====================
// 功能结果暂存：key('g:群号'或'p:QQ) -> { groupId, params, timer, triggered }
const pendingResultNotify = new Map();

// 构造一条"功能结果"消息发给 astrbot 下游，让 AI 对该结果修饰
// 调用前必须确认 astrbot 处于 OPEN 状态（不在线则上游直接发，不调此函数）
function notifyAstrbotForResult(key, groupId, userId, resultText) {
    const aws = downstreamClients['astrbot'];
    const selfId = String(process.env.BOT_SELF_ID || '0');
    const fake = {
        time: Math.floor(Date.now() / 1000),
        self_id: selfId,
        post_type: 'message',
        message_type: groupId ? 'group' : 'private',
        group_id: groupId || undefined,
        user_id: userId || selfId,
        // 提示词：把功能结果作为"用户消息"给 AI，让 AI 修饰
        raw_message: `[CQ:at,qq=${selfId}] 功能结果：${resultText}\n请根据这个功能结果，用みのり的语气说一句配合的话（一句话，不要重复结果内容）`,
        message: [
            { type: 'at', data: { qq: String(selfId) } },
            { type: 'text', data: { text: ` 功能结果：${resultText}\n请根据这个功能结果，用みのり的语气说一句配合的话（一句话，不要重复结果内容）` } }
        ],
        sender: { user_id: userId || selfId, nickname: '功能结果' }
    };
    console.log(`🤖 [AI修饰] 已把功能结果发给astrbot（${String(resultText).slice(0,30)}...）`);
    aws.send(JSON.stringify(fake));
}

// 把暂存的【所有】下游结果合并成段数组（多条结果之间插入换行；重复的引用段只保留第一条）
function mergedResultSegments(rec) {
    const items = (rec && rec.items) || [];
    let segs = [];
    let replySeen = false;
    items.forEach(function (it) {
        const m = messageToSegments(it.params && it.params.message) || [];
        const out = [];
        for (const s of m) {
            // 同一触发的多个下游结果常各自带一条相同的引用段 → 只保留第一条，避免重复引用
            if (s && s.type === 'reply') {
                if (replySeen) continue;
                replySeen = true;
            }
            out.push(s);
        }
        if (!out.length) return;
        if (segs.length) segs.push({ type: 'text', data: { text: '\n' } });
        segs = segs.concat(out);
    });
    return segs;
}

// 超时兜底：把已暂存的【所有】功能结果合并直接发出
function emitResultDirect(key) {
    const rec = pendingResultNotify.get(key);
    if (!rec) return;
    pendingResultNotify.delete(key);
    if (rec.aiTimer) clearTimeout(rec.aiTimer);
    if (rec.timer) clearTimeout(rec.timer);
    const segs = mergedResultSegments(rec);
    if (segs.length) {
        forwardToNapCat({ action: rec.action, params: Object.assign({}, rec.params, { message: segs }) });
    }
    console.log('⏱️ [AI修饰] 超时/无astrbot，直接发出功能结果（' + ((rec.items || []).length) + ' 条）');
}

function queueReplyForMerge(name, action, params) {
    return backendReplyGate.submit(name,action,params,trigger=>queueSelectedReplyForMerge(name,action,params,trigger));
}
function queueSelectedReplyForMerge(name, action, params, triggerOverride=null) {
    const key = actionKeyOf(action, params);
    const q = key ? pendingTriggers.get(key) : null;
    if (q) { while (q.length && Date.now() - q[0].time > TRIGGER_WINDOW_MS) q.shift(); } // 清理过期
    const reply = { name, action, params };

    if (name === 'astrbot') {
        // AstrBot 回复自带精确引用（AstrBot 端已开启 reply_with_quote/mention）
        // 若该群已有 haruki/bot 回复在合并等待（如 /个人信息 场景）→ 并入合并队列（图+话一条发出）
        // 否则直接发出（日常提问场景，避免合并窗口延迟，更快）
        let found = null;
        for (const [seq, pm] of pendingMerges) {
            if (pm.trigger && pm.trigger.key === key && pm.replies.some(r => r.name !== 'astrbot')) {
                found = { seq, pm };
                break;
            }
        }
        if (found) {
            found.pm.replies.push(reply);
            clearTimeout(found.pm.timer);
            logAIReply('⏱️ [AI回复] 并入合并（与 ' + found.pm.replies.map(r => r.name).join('+') + ' 一条发出）');
            flushMerge(found.seq);
            return;
        }
        logAIReply('⏱️ [AI回复] 直接发出（无合并等待，快速）');
        forwardToNapCat(reply);
        return;
    }

    // haruki/bot（功能回复）——确定性等 AI 修饰后合并发出
    // 触发归属：优先用功能结果里 reply 段引用的原消息 id 精确定位（避免 @ 错人）；
    // 定位不到时取该群队列中【最新】一条 —— q[0] 是最旧的，活跃群里极易张冠李戴
    const replyId = replyQuoteIdOf(params && params.message);
    let tr = null;
    let src = null;
    if (q && q.length) {
        if (replyId) {
            src = q.find(t => String(t.messageId) === String(replyId)) || null;
            tr = src;
        }
        if (!tr) tr = q[q.length - 1];
    }
    if(triggerOverride){tr=triggerOverride;src=triggerOverride;}
    // 构造功能结果文本（供 AI 修饰 + 最终合并用）
    let resultText = getMessagePlainText(params && params.message) || tagsTextOf(params && params.message);
    // 抓引用原文：让 AI 修饰有语境（如 /个人信息）
    if (src && src.plain && src.plain.trim()) {
        resultText = src.plain + '\n' + resultText;
    }
    modifyAndEmitResult(key, name, action, params, resultText, tr);
}

// 功能结果——确定性修饰：暂存结果，请求 astrbot 修饰，等修饰回复后合并一条发出；超时/无astrbot则直接发
// 同一触发的多个下游结果会累积到同一个暂存里，最后合并成一条发出（不再丢弃后续结果）
function modifyAndEmitResult(key, name, action, params, resultText, tr) {
    const existing = pendingResultNotify.get(key);
    if (existing) {
        // 同一触发的其它下游结果：并入同一暂存（haruki 谱面图 + sakura 结果 + …）
        existing.items.push({ action: action, params: params });
        existing.texts.push(resultText);
        logAIReply('⏭️ [功能回复] ' + name + ' 结果并入合并（共 ' + existing.items.length + ' 条）');
        return;
    }
    const rec = {
        groupId: params && params.group_id, userId: tr ? tr.userId : (params && params.user_id),
        action: action, params: params,
        items: [{ action: action, params: params }],
        texts: [resultText],
        key: key,
        trMessageId: tr ? tr.messageId : null
    };
    pendingResultNotify.set(key, rec);
    // 私聊（非管理员）：AI 已禁用，不请求修饰，功能结果直接发（少等 1 秒 + 少等 10 秒兜底）
    const priv = /^p:(\d+)$/.exec(String(key || ''));
    const aiAllowed = !(priv && !isAdminUser(priv[1]));
    const aws = aiAllowed ? downstreamClients['astrbot'] : null;
    if (aws && aws.readyState === WebSocket.OPEN) {
        // 稍等一下再请求 AI：让同一触发的多个下游结果都到齐，AI 才能看到完整内容
        rec.aiTimer = setTimeout(function () {
            notifyAstrbotForResult(key, rec.groupId, rec.userId, (rec.texts || []).join('\n'));
        }, 1000);
        // 超时兜底：10s 内没有 AI 修饰则把已累积的结果直接发出
        rec.timer = setTimeout(function () { emitResultDirect(key); }, 10000);
        logAIReply('⏱️ [功能回复] ' + name + ' 已暂存并请求astrbot修饰');
    } else {
        // astrbot 不在线（或私聊里 AI 已禁用）：无修饰可等，直接发功能结果，不残留暂存
        emitResultDirect(key);
        logAIReply('⏱️ [功能回复] ' + name + (aiAllowed ? ' astrbot不在线，直接发出功能结果' : ' 私聊非管理员，不走AI修饰，直接发出'));
    }
}

// 文本/段转字符串（从 message 提取文本）
function tagsTextOf(message) {
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) {
        return message.map(s => (s && s.type === 'text') ? (s.data && s.data.text || '') : (s && s.type === 'image' ? '[图片]' : '')).join(' ');
    }
    return '';
}

// 提取消息中的引用段（reply）的原消息 id，用于反查引用原文
function replyQuoteIdOf(message) {
    if (Array.isArray(message)) {
        for (const s of message) {
            if (s && s.type === 'reply' && s.data && s.data.id != null) return s.data.id;
        }
    }
    return null;
}

function forwardToDownstreams(payload) {
    const str = typeof payload === 'string' ? payload : JSON.stringify(payload);
    let tag = '?';
    let msg = null, isGroup = false, atSelf = false;
    try {
        const o = JSON.parse(str);
        tag = o.post_type ? (o.post_type + (o.message_type ? '/' + o.message_type : '')) : '?';
        msg = o;
        isGroup = (o.post_type === 'message' && o.message_type === 'group');
    } catch (e) {}
    if(msg?.post_type==='message'&&require('./global_help').matches(getMessagePlainText(msg.message||msg.raw_message||'')))return;
    // 私聊里的 AI 只对管理员开放：非管理员的私聊消息不发给 astrbot（AI 不回复），其余下游照旧。
    // 私聊通知（戳一戳等）没有 group_id，也算私聊 —— 否则 AI 仍能从 notice 事件看到私聊互动。
    let aiBlockedPrivate = false;
    try {
        if (msg && (msg.post_type === 'message' || msg.post_type === 'notice')) {
            const isPrivateChat = (msg.post_type === 'message')
                ? msg.message_type === 'private'
                : !msg.group_id;
            if (isPrivateChat && !isAdminUser(msg.user_id || (msg.sender && msg.sender.user_id))) {
                aiBlockedPrivate = true;
            }
        }
    } catch (e) {}
    // ===== /bang<指令> → 只推给 tsugu，并且把 /bang 去掉 =====
    // tsugu 是 Koishi 指令（查卡/查曲/查谱面…），Koishi 认「@机器人 + 指令」这种形式，
    // 所以这里把 /bang 换成 @自己，其余原样保留（群号 / 用户 / self_id 都不动）。
    let bangPayload = null;
    try {
        if (msg && msg.post_type === 'message') {
            const plain = getMessagePlainText(msg.message || msg.raw_message || '');
            const m = /^\s*\/bang\s*([\s\S]*)$/.exec(plain);
            if (m && m[1].trim()) {
                // /bang/help、/bang/查卡 这类多写一个斜杠的也认：只去掉最前面那个斜杠
                const cmd = m[1].trim().replace(/^[\/／]+\s*/, '').trim();
                const selfId = String(msg.self_id || '');
                bangPayload = JSON.stringify(Object.assign({}, msg, {
                    message: [
                        { type: 'at', data: { qq: selfId } },
                        { type: 'text', data: { text: ' ' + cmd } },
                    ],
                    raw_message: `[CQ:at,qq=${selfId}] ${cmd}`,
                }));
                const parts = cmd.split(/[\s　]+/).filter(Boolean);
                const needArg = parts.length < 2 ? BANG_NEEDS_ARG[parts[0]] : null;
                if (needArg) {
                    const hint = `用法：/bang${parts[0]} ${needArg}`;
                    forwardToNapCat(msg.message_type === 'private'
                        ? { action: 'send_private_msg', params: { user_id: msg.user_id, message: hint } }
                        : { action: 'send_group_msg', params: { group_id: msg.group_id, message: hint } });
                    console.log(`🎴 /bang${cmd} 缺参数 → 提示用法（不发 tsugu）`);
                    return;
                }
                // 求助类（help / ? / 帮助 …）：等 tsugu 的指令列表发完，再补一句 /bang 用法提示
                const head = String(parts[0] || cmd).toLowerCase();
                if (BANG_HELP_WORDS.indexOf(head) >= 0 || BANG_HELP_WORDS.indexOf(cmd.toLowerCase()) >= 0) {
                    const bk = msg.message_type === 'private' ? 'p:' + msg.user_id : 'g:' + msg.group_id;
                    const old0 = bangHelpPending.get(bk);
                    if (old0 && old0.timer) clearTimeout(old0.timer);
                    bangHelpPending.set(bk, {
                        timer: setTimeout(() => {
                            if (bangHelpPending.get(bk)) { bangHelpPending.delete(bk); sendByKey(bk, BANG_HINT); }
                        }, 3000),
                    });
                }
                console.log(`🎴 /bang → tsugu：「${cmd}」（只发 tsugu）`);
            }
        }
    } catch (e) {}
    // 屏蔽指定 QQ 号发的消息：该用户的消息不转发给任何下游（不触发 bot 回复）
    try {
        if (msg && msg.post_type === 'message') {
            const uid = String(msg.user_id || msg.sender?.user_id || '');
            if (uid && BLOCK_QOS.includes(uid)) {
                console.log('🚫 已屏蔽用户消息 user_id=' + uid);
                return;
            }
        }
    } catch (e) {}
    // Sakura 功能仅在被 @ 主号时触发：群聊消息里没有 @ 主号(self_id) 则不转发给 sakura
    if (isGroup && msg) {
        const selfId = String(msg.self_id || '');
        const arr = Array.isArray(msg.message) ? msg.message : [];
        atSelf = arr.some(s => s && s.type === 'at' && String(s.data && s.data.qq) === selfId);
        if (!atSelf && typeof msg.raw_message === 'string') {
            atSelf = msg.raw_message.includes('[CQ:at,qq=' + selfId + ']');
        }
        // 判断是否为 / 功能指令：只要开头是 /（含 "/@bot /cmd" 被剥离 CQ 后变成 "/ /cmd" 的情况）就不让 AI 抢答
        isSlashCmd = false;
        if (isGroup) {
            const plain = getMessagePlainText(msg.message || msg.raw_message || '');
            if (/^\s*\//.test(plain)) isSlashCmd = true;
        }
    }
    const isEvent = !!(msg && msg.post_type);            // 事件（message/notice/…）；否则是 NapCat 的动作响应
    for (const name of Object.keys(downstreamClients)) {
        const c = downstreamClients[name];
        if (c && c.readyState === WebSocket.OPEN) {
            if(isEvent&&!backendRules.permit(name,msg,getMessagePlainText(msg?.message||msg?.raw_message||'')))continue;
            // tsugu：事件只有 /bang 才推给它；但 NapCat 对 tsugu 动作的响应（带 echo）必须回传，
            // 否则 Koishi 等不到回执，每条 send_group_msg 都要拖到 60 秒超时（踩过）
            if (name === 'tsugu') {
                if (!isEvent) c.send(str);
                else if (bangPayload) c.send(bangPayload);
                continue;
            }
            // /bang 的消息不打扰其它下游（haruki / astrbot / sakura）
            if (isEvent && bangPayload) continue;
            // 功能指令(/xxx)：不转发给 astrbot（AI 不抢答），仍转发给 haruki/sakura/本地
            if (isGroup && isSlashCmd && name === 'astrbot') {
                if (Math.random() < 0.05) console.log('🔇 /功能指令未转发astrbot（AI不抢答）');
                continue;
            }
            // 私聊（非管理员）：AI 功能禁用，不转发给 astrbot
            if (aiBlockedPrivate && name === 'astrbot') {
                console.log('🔇 私聊未转发astrbot（非管理员，AI 私聊已禁用）');
                continue;
            }
            // Sakura 功能仅在被 @ 主号时触发：群聊消息里没有 @ 主号(self_id) 则不转发给 sakura
            if (isGroup && name.startsWith('sakura') && !atSelf && !backendRules.special(getMessagePlainText(msg.message||msg.raw_message||'')) && !/^\/pjsk/i.test(getMessagePlainText(msg.message||msg.raw_message||'').trim()) && !(isSlashCmd&&backendRules.get(msg.group_id).priority==='sakura')) {
                continue;
            }
            // 日志降噪：sakura 转发不打印（活跃群日志刷屏会拖慢事件循环）
            if (name === 'haruki' || name === 'astrbot' || tag === 'notice') {
                console.log(`📤 转发 [${tag}] → ${name}`);
            }
            let outbound = str;
            const commandPlain=getMessagePlainText(msg?.message||msg?.raw_message||'');
            if(isEvent&&msg.post_type==='message'&&/^\/pjsk/i.test(commandPlain.trim())&&!backendRules.special(commandPlain)&&['haruki','sakura-pjsk'].includes(name)){
                const cmd=commandPlain.trim().replace(/^\/pjsk/i,'');
                const selfId=String(msg.self_id||DOWNSTREAM_HEADERS['X-Self-ID']);
                const text=name==='haruki'?'/'+cmd:cmd;
                outbound=JSON.stringify(Object.assign({},msg,{message:[{type:'at',data:{qq:selfId}},{type:'text',data:{text:' '+text}}],raw_message:'[CQ:at,qq='+selfId+'] '+text,to_me:true}));
            }
            if (outbound===str && isGroup && name.startsWith('sakura') && !atSelf && isSlashCmd) {
                const selfId=String(msg.self_id||DOWNSTREAM_HEADERS['X-Self-ID']||'');
                if(selfId){
                    const segments=Array.isArray(msg.message)?msg.message:[{type:'text',data:{text:getMessagePlainText(msg.message||msg.raw_message||'')}}];
                    outbound=JSON.stringify(Object.assign({},msg,{message:[{type:'at',data:{qq:selfId}},{type:'text',data:{text:' '}}].concat(segments),raw_message:'[CQ:at,qq='+selfId+'] '+(msg.raw_message||getMessagePlainText(msg.message||'')),to_me:true}));
                }
            }
            // Sakura 专用指令不接受斜杠前缀；仅转换下游事件，保留原始触发用于路由和回复关联。
            if(name==='sakura-pjsk'&&backendRules.special(getMessagePlainText(msg?.message||msg?.raw_message||''))){
                const selfId=String(msg.self_id||DOWNSTREAM_HEADERS['X-Self-ID']);
                const command=getMessagePlainText(msg.message||msg.raw_message||'').trim().replace(/^\/+\s*/,'');
                outbound=JSON.stringify(Object.assign({},msg,{message:[{type:'at',data:{qq:selfId}},{type:'text',data:{text:' '+command}}],raw_message:'[CQ:at,qq='+selfId+'] '+command,to_me:true}));
            }
            if(name==='sakura-pjsk'&&backendRules.special(getMessagePlainText(msg?.message||msg?.raw_message||'')))console.log('🎯 Sakura-PJSK 专用路由 group='+msg.group_id+' msgId='+msg.message_id+' normalizedAt='+(!atSelf));
            c.send(outbound);
        }
    }
}

function forwardToNapCat(payload) {
    const str = typeof payload === 'string' ? payload : JSON.stringify(payload);
    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(str);
    }
}

function handleDownstreamMessage(name, data) {
    const raw = data.toString();
    try {
        const obj = JSON.parse(raw);
        if (obj && typeof obj.action === 'string') {
            if(backendRules.family(name)&&obj.params?.group_id&&!backendRules.get(obj.params.group_id)[backendRules.family(name)]){
                if(obj.echo!=null&&downstreamClients[name]?.readyState===WebSocket.OPEN)downstreamClients[name].send(JSON.stringify({status:'failed',retcode:1403,message:'本群接口已关闭',echo:obj.echo}));
                return;
            }
            // 下游发出的 API 动作（send_group_msg / send_private_msg 等）
            if (obj.params && obj.params.message !== undefined && /^send_.*_msg$/.test(obj.action)) {
                const msg = obj.params.message;
                console.log(`📊 ${name} 回复摘要:`, JSON.stringify({
                    segTypes: Array.isArray(msg) ? msg.map(s => s && s.type) : (typeof msg === 'string' ? 'string' : 'unknown'),
                    text: getMessagePlainText(msg).slice(0, 80),
                    imageUrls: messageImageUrls(msg).slice(0, 2).map(u => u.slice(0, 150)),
                }));
                obj.params.message = applyModifiers(msg, lastTriggerPlain, name);
            }
            console.log(`📨 ${name} 动作:`, obj.action, JSON.stringify(obj.params || {}).slice(0, 200));
            if (obj.action === 'send_group_msg' || obj.action === 'send_private_msg' || obj.action === 'send_msg') {
                // tsugu 的回复原样直接发（不合并、不等 AI 修饰）
                if (name === 'tsugu') {
                    forwardToNapCat(obj);
                    // 刚才是求助类 /bang → 跟在帮助列表后面补一句用法提示
                    const bk = bangKeyOfParams(obj.params);
                    const pend = bk && bangHelpPending.get(bk);
                    if (pend) {
                        if (pend.timer) clearTimeout(pend.timer);
                        bangHelpPending.delete(bk);
                        sendByKey(bk, BANG_HINT);
                    }
                    return;
                }
                // === astrbot 的 AI 修饰回复：若该群有暂存的功能结果，合并发出（功能结果+AI话）===
                if (name === 'astrbot' && obj.params) {
                    const gkey = obj.params.group_id ? ('g:' + obj.params.group_id) : (obj.params.user_id ? ('p:' + obj.params.user_id) : null);
                    if (gkey && pendingResultNotify.has(gkey)) {
                        const rec = pendingResultNotify.get(gkey);
                        if (rec.aiTimer) clearTimeout(rec.aiTimer);
                        if (rec.timer) clearTimeout(rec.timer);
                        pendingResultNotify.delete(gkey);
                        // 合成：该触发的【所有】下游结果段 + AI话段
                        const resultSegs = mergedResultSegments(rec);
                        // 清洗 AI 段：去掉 reply 段里 id 为空/"None"/undefined 的无效引用
                        const cleanedAi = (messageToSegments(obj.params.message) || []).filter(s => {
                            if (s && s.type === 'reply') {
                                const rid = s.data && s.data.id;
                                return !(rid == null || rid === 'None' || rid === '' || rid === 'null');
                            }
                            return true;
                        });
                        // 功能结果段本身若不带 reply 引用（如本地 GIF），且 AI 段也无有效引用 → 补一个指向触发消息的引用段
                        let headSegs = resultSegs || [];
                        const hasValidReply = (headSegs || []).some(s => s && s.type === 'reply' && s.data && s.data.id != null && s.data.id !== 'None' && s.data.id !== '')
                            || cleanedAi.some(s => s && s.type === 'reply');
                        if (!hasValidReply && rec.trMessageId != null) {
                            headSegs = [{ type: 'reply', data: { id: String(rec.trMessageId) } }].concat(headSegs);
                        }
                        const mergedSegs = headSegs.concat((headSegs && headSegs.length) ? [{ type: 'text', data: { text: '\n' } }] : [], cleanedAi || []);
                        const merged = { action: obj.action, params: Object.assign({}, obj.params, { message: mergedSegs }) };
                        logAIReply('🤖 [AI修饰] 已合并功能结果+AI话 -> ' + String(getMessagePlainText(mergedSegs)).slice(0, 40));
                        forwardToNapCat(merged);
                        return;
                    }
                }
                const intercepted=queueReplyForMerge(name, obj.action, obj.params);
                if(intercepted&&obj.echo!=null&&downstreamClients[name]?.readyState===WebSocket.OPEN)downstreamClients[name].send(JSON.stringify({status:'ok',retcode:0,data:{message_id:0},echo:obj.echo})); // 进入合并队列（同触发多下游回复合并一条发出）
            } else {
                if(backendRules.family(name)&&/^send_.*msg$/.test(obj.action)){backendReplyGate.submit(name,obj.action,obj.params,()=>forwardToNapCat(obj));if(obj.echo!=null&&downstreamClients[name]?.readyState===WebSocket.OPEN)downstreamClients[name].send(JSON.stringify({status:'ok',retcode:0,data:{message_id:0},echo:obj.echo}));}
                else forwardToNapCat(obj);
            }
        } else {
            console.log(`📨 ${name} 其他消息:`, raw.slice(0, 200));
        }
    } catch (e) {
        console.error(`❌ ${name} 消息解析错误:`, e.message);
    }
}

function connectDownstream(cfg) {
    const opts = { headers: {} };
    if (cfg.headers) Object.assign(opts.headers, cfg.headers);
    if (cfg.name.startsWith('sakura')) Object.assign(opts.headers, DOWNSTREAM_HEADERS);
    const ws = new WebSocket(cfg.url, opts);
    downstreamClients[cfg.name] = ws;
    ws.on('open', () => console.log(`🔗 下游已连接 [${cfg.name}] ${cfg.url}`));
    ws.on('message', (d) => handleDownstreamMessage(cfg.name, d));
    ws.on('close', () => {
        console.log(`🔌 下游断开 [${cfg.name}]，5 秒后重连`);
        if (downstreamClients[cfg.name] === ws) delete downstreamClients[cfg.name];
        setTimeout(() => connectDownstream(cfg), 5000);
    });
    ws.on('error', (e) => console.error(`❌ 下游连接错误 [${cfg.name}]:`, e.message.slice(0, 120)));
}
for (const cfg of DOWNSTREAM_WS) { if(cfg.url) connectDownstream(cfg); }

// ==================== B站关注功能（整合 bili_follow 模块）====================
let BiliFollow = null;
try {
    BiliFollow = require('./bili_follow.js');
    // 发群消息：复用 forwardToNapCat
    const biliSendToGroup = (groupId, text) => {
        forwardToNapCat({ action: 'send_group_msg', params: { group_id: groupId, message: text } });
    };
    // 读 cookie 文件
    const biliGetCookie = () => {
        try {
            if (fs.existsSync('/home/admin/bot/data/bilibili_cookie.txt')) {
                return fs.readFileSync('/home/admin/bot/data/bilibili_cookie.txt', 'utf8').trim();
            }
        } catch (e) {}
        return '';
    };
    BiliFollow.init({ sendToGroup: biliSendToGroup, getCookie: biliGetCookie });
    BiliFollow.startPolling(60000); // 1分钟轮询
    console.log('✅ B站关注功能已集成');
} catch (e) {
    console.error('❌ B站关注模块加载失败:', e.message);
}

/*
node app.js
*/

/*
$env:NAPCAT_QUICK_PASSWORD = "YOUR_PASSWORD"
node ./index.js -q 0
*/