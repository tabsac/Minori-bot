'use strict';
/**
 * 明日方舟（Arknights）数据抓取层
 *
 * 数据源：Kengxxiao/ArknightsGameData（国服，官方包解包，每周自动更新）
 *   1) cdn.jsdelivr.net   2) gcore.jsdelivr.net   3) raw.githubusercontent（DNS 被污染，固定 IP）
 *   4) api.github.com/contents（限流，兜底）
 *
 * 这个文件只做「下载 + 校验 + 落盘」，不做任何业务解释：
 *   - JSON 必须能 JSON.parse，否则换镜像重下（踩过：jsDelivr 断流导致 stage_table 半截）
 *   - 先写 .part 再 rename，避免半截文件被当成缓存
 *   - 缓存可被 force 覆盖；默认命中缓存直接返回
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');

const ARK_DIR = process.env.ARK_DIR || '/home/admin/bot/data/ark';
const TABLE_DIR = path.join(ARK_DIR, 'tables');
const LEVEL_DIR = path.join(ARK_DIR, 'levels');
const IMG_DIR = path.join(ARK_DIR, 'img');
const REPO = 'Kengxxiao/ArknightsGameData';
const BRANCH = 'master';
const RAW_IPS = ['185.199.110.133', '185.199.108.133', '185.199.109.133', '185.199.111.133'];
const UA = 'ournotes-bot/1.0 (+https://github.com/tabsac/ournotes-bot)';

function ensureDirs() {
  for (const d of [ARK_DIR, TABLE_DIR, LEVEL_DIR, IMG_DIR]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
  }
}

/** 单次 GET，返回 Buffer；resolveIp 用于 raw.githubusercontent 的固定 IP */
function getOnce(url, resolveIp, redirects) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    const opts = {
      host: u.hostname,
      port: u.port || 443,
      path: u.pathname + (u.search || ''),
      method: 'GET',
      servername: u.hostname,
      headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip', Accept: '*/*' },
      timeout: 120000,
    };
    if (resolveIp) opts.lookup = (host, o, cb) => cb(null, resolveIp, 4);
    const req = https.get(opts, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        const ip = /raw\.githubusercontent\.com/.test(next) ? RAW_IPS[0] : null;
        return resolve(getOnce(next, ip, redirects - 1));
      }
      if (code !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + code));
      }
      const enc = String(res.headers['content-encoding'] || '');
      let stream = res;
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('下载超时')));
    req.on('error', reject);
  });
}

/** 多镜像轮询下载；json=true 时校验 JSON 可解析 */
async function fetchBuf(rel, opts) {
  const o = opts || {};
  const urls = [
    `https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}/zh_CN/gamedata/${rel}`,
    `https://gcore.jsdelivr.net/gh/${REPO}@${BRANCH}/zh_CN/gamedata/${rel}`,
    { url: `https://raw.githubusercontent.com/${REPO}/${BRANCH}/zh_CN/gamedata/${rel}`, ip: true },
    { url: `https://api.github.com/repos/${REPO}/contents/zh_CN/gamedata/${rel}`, gh: true },
  ];
  let lastErr = null;
  for (let round = 0; round < 2; round++) {
    for (const item of urls) {
      const url = typeof item === 'string' ? item : item.url;
      let ip = null;
      if (typeof item === 'object' && item.ip) ip = RAW_IPS[round % RAW_IPS.length];
      if (typeof item === 'object' && item.gh) continue; // api.github.com 兜底放到最后单独走
      try {
        const buf = await getOnce(url, ip, 5);
        if (!buf || buf.length < 16) throw new Error('内容过短 ' + (buf ? buf.length : 0));
        if (o.json) JSON.parse(buf.toString('utf8'));
        return buf;
      } catch (e) { lastErr = e; }
    }
  }
  // 兜底：GitHub contents API（每小时 60 次，仅救急）
  try {
    const buf = await getOnce(`https://api.github.com/repos/${REPO}/contents/zh_CN/gamedata/${rel}?ref=${BRANCH}`, null, 5);
    if (o.json) JSON.parse(buf.toString('utf8'));
    return buf;
  } catch (e) { lastErr = lastErr || e; }
  throw new Error(`下载失败 ${rel}: ${lastErr && lastErr.message}`);
}

function writeAtomic(file, buf) {
  const tmp = file + '.part';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
}

/** 取一张数据表（缓存到 data/ark/tables/<name>.json） */
async function table(name, opts) {
  ensureDirs();
  const o = opts || {};
  const base = name.replace(/^excel\//, '');
  const isJson = /\.json$/.test(base);
  const dest = path.join(TABLE_DIR, base);
  if (!o.force && fs.existsSync(dest) && fs.statSync(dest).size > 32) {
    try { return isJson ? JSON.parse(fs.readFileSync(dest, 'utf8')) : fs.readFileSync(dest, 'utf8'); } catch (e) { /* 半截缓存 → 重下 */ }
  }
  const buf = await fetchBuf('excel/' + base, { json: isJson });
  writeAtomic(dest, buf);
  return isJson ? JSON.parse(buf.toString('utf8')) : buf.toString('utf8');
}

/** 取关卡文件（缓存到 data/ark/levels/<levelId 扁平化>.json） */
async function level(levelId, opts) {
  ensureDirs();
  const o = opts || {};
  const flat = String(levelId).toLowerCase().replace(/[^a-z0-9_.-]+/g, '_');
  const dest = path.join(LEVEL_DIR, flat + '.json');
  if (!o.force && fs.existsSync(dest) && fs.statSync(dest).size > 64) {
    try { return JSON.parse(fs.readFileSync(dest, 'utf8')); } catch (e) {}
  }
  const rel = 'levels/' + levelId + '.json';
  const relLower = 'levels/' + String(levelId).toLowerCase() + '.json';
  let buf;
  try {
    buf = await fetchBuf(rel, { json: true });
  } catch (e) {
    // levelId 形如 Obt/Main/level_main_08-17，而仓库里是小写 obt/main/...（踩过）
    buf = await fetchBuf(relLower, { json: true });
  }
  writeAtomic(dest, buf);
  return JSON.parse(buf.toString('utf8'));
}

/** 取任意图片（缓存到 data/ark/img/...）；返回本地路径 */
async function image(rel, opts) {
  ensureDirs();
  const o = opts || {};
  const dest = path.join(IMG_DIR, rel);
  if (!o.force && fs.existsSync(dest) && fs.statSync(dest).size > 64) return dest;
  try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch (e) {}
  const buf = await fetchBuf(o.raw ? rel : 'levels/' + rel, { json: false });
  writeAtomic(dest, buf);
  return dest;
}

module.exports = { ARK_DIR, TABLE_DIR, LEVEL_DIR, IMG_DIR, ensureDirs, fetchBuf, table, level, image, getOnce };

// CLI：node ark_fetch.js <table|level> <名称...>
if (require.main === module) {
  (async () => {
    const [kind, ...names] = process.argv.slice(2);
    if (!kind || !names.length) {
      console.log('用法: node ark_fetch.js table <表名...> | level <levelId...>');
      process.exit(1);
    }
    for (const n of names) {
      const t0 = Date.now();
      try {
        const r = kind === 'level' ? await level(n, { force: true }) : await table(n, { force: true });
        const size = JSON.stringify(r).length;
        console.log(`  ✓ ${kind} ${n} (${(size / 1048576).toFixed(2)} MB, ${Date.now() - t0} ms)`);
      } catch (e) {
        console.log(`  ✗ ${kind} ${n}: ${e.message}`);
      }
    }
  })();
}
