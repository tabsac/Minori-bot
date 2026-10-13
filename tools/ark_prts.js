'use strict';
/**
 * PRTS.wiki 数据层（MediaWiki API + SemanticMediaWiki + media.prts.wiki 图床）
 *
 * 为什么不用 PRTS 当主数据源：硬数据（卡池起止时间、关卡波次）不在 wiki 上，
 * 只有「干员页里人写的整理文本」——所以只拿它补 Kengxxiao 数据表里没有的字段：
 *   分支 / 阵营（所属国家·组织）/ 上线时间 / 性别 / 出身地 / 种族 / 生日 / 身高 /
 *   画师 / 声优 / 六维 / 时装列表 / 获得方式
 * 图片：media.prts.wiki 可以直接 GET（立绘 / 头像 / 敌人头像 / 道具 / 地图 / 活动 KV）
 *
 * 用法：
 *   node tools/ark_prts.js sync [--limit N] [--force]   同步干员页（默认增量，只补缺的）
 *   node tools/ark_prts.js smw [--limit N]              只同步 SMW 属性
 *   node tools/ark_prts.js img <页面标题...>            查图片 URL（并写入索引）
 */
const fs = require('fs');
const path = require('path');
const arkFetch = require('../ark_fetch');

const ARK_DIR = arkFetch.ARK_DIR;
const PRTS_DIR = path.join(ARK_DIR, 'prts');
const OPS_FILE = path.join(PRTS_DIR, 'ops.json');
const SMW_FILE = path.join(PRTS_DIR, 'smw.json');
const IMGIDX_FILE = path.join(PRTS_DIR, 'imgidx.json');
const API = 'https://prts.wiki/api.php';
const UA = 'ournotes-bot/1.0 (+https://github.com/tabsac/ournotes-bot)';

function ensure() { try { fs.mkdirSync(PRTS_DIR, { recursive: true }); } catch (e) {} }
function readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } }
function writeJson(f, o) {
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); } catch (e) {}
  const tmp = f + '.part';
  fs.writeFileSync(tmp, JSON.stringify(o));
  fs.renameSync(tmp, f);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 带 UA 的 GET（跟随跳转），返回字符串 */
async function apiGet(params) {
  const qs = Object.keys(params).map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
  const https = require('https');
  const url = API + '?' + qs;
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get({
      host: u.hostname, port: 443, path: u.pathname + u.search, servername: u.hostname,
      headers: { 'User-Agent': UA, 'Accept-Encoding': 'identity' }, timeout: 60000,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve(Buffer.concat(c).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
  });
}
async function apiJson(params) { return JSON.parse(await apiGet(params)); }

/** 并发池 */
async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  const workers = new Array(Math.min(n, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); } catch (e) { out[idx] = { err: e.message }; }
      await sleep(120);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------- SMW
/** 拉全部 [[分类:干员]] 的 SMW 属性（出身地/种族/性别/画师/声优等），分页 */
async function syncSmw(opts) {
  const o = opts || {};
  ensure();
  const props = ['出身地', '种族', '性别', '画师', '日文配音', '中文配音', '英文配音', '韩文配音', '稀有度', '职业'];
  const query = '[[分类:干员]]|' + props.map((p) => '?' + p).join('|');
  const out = {};
  let offset = 0;
  for (let page = 0; page < 40; page++) {
    const d = await apiJson({ action: 'ask', query, format: 'json', offset: String(offset) });
    const res = (d.query && d.query.results) || {};
    const keys = Object.keys(res);
    if (!keys.length) break;
    for (const k of keys) {
      const po = res[k].printouts || {};
      const rec = {};
      for (const p of props) {
        const v = po[p];
        if (Array.isArray(v) && v.length) {
          rec[p] = v.map((x) => (x && typeof x === 'object' ? (x.fulltext || x.timestamp || '') : x)).filter(Boolean).join('、');
        } else if (v && typeof v === 'object') rec[p] = v.fulltext || v.timestamp || '';
        else rec[p] = v == null ? '' : String(v);
      }
      out[k] = rec;
    }
    offset += keys.length;
    if (keys.length < 50) break;
    await sleep(200);
  }
  const data = { at: Date.now(), ops: out };
  writeJson(SMW_FILE, data);
  return data;
}

function smw() { return readJson(SMW_FILE, { at: 0, ops: {} }); }

// ---------------------------------------------------------------- 干员页解析
/** 从 wikitext 里取模板参数：{{模板名|键=值|...}}，返回 { 键: 值 }
 *  注意：模板名和第一个 | 之间常有 <!-- 注释 -->（PRTS 的自动更新标记），
 *  所以不能写成 \{\{名\s*(\|...) 这种「名后面必须紧跟参数」的正则（踩过：整页字段全空） */
function findTemplate(wikitext, name) {
  const re = new RegExp('\\{\\{\\s*' + name + '\\s*(?=[|}\\n])', 'g');
  let m;
  while ((m = re.exec(wikitext))) {
    const start = m.index;
    let depth = 0, end = -1;
    for (let i = start; i < wikitext.length - 1; i++) {
      if (wikitext[i] === '{' && wikitext[i + 1] === '{') { depth++; i++; continue; }
      if (wikitext[i] === '}' && wikitext[i + 1] === '}') { depth--; i++; if (depth === 0) { end = i + 1; break; } continue; }
    }
    if (end > 0) return wikitext.slice(start + 2, end - 2);
  }
  return null;
}

function splitParams(body) {
  const parts = [];
  let buf = '', depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '[' && body[i + 1] === '[') { depth++; buf += c; continue; }
    if (c === ']' && body[i + 1] === ']') { depth--; buf += c; continue; }
    if (c === '{' && body[i + 1] === '{') { depth++; buf += c; continue; }
    if (c === '}' && body[i + 1] === '}') { depth--; buf += c; continue; }
    if (c === '|' && depth <= 0) { parts.push(buf); buf = ''; continue; }
    buf += c;
  }
  parts.push(buf);
  return parts;
}

function templateParams(wikitext, tpl) {
  const out = {};
  let body = findTemplate(wikitext, tpl);
  if (body === null) return out;
  body = body.replace(new RegExp('^\\\\s*' + tpl + '\\\\s*'), '');
  for (const p of splitParams(body)) {
    const i = p.indexOf('=');
    if (i < 0) continue;
    const k = p.slice(0, i).replace(/<!--[\s\S]*?-->/g, '').trim();
    const v = p.slice(i + 1).replace(/<!--[\s\S]*?-->/g, '').trim();
    if (k && out[k] === undefined) out[k] = v;
  }
  return out;
}

/** 取所有 {{人员档案set}} / {{干员获得方式}} / {{CharinfoV2}} / {{属性}} 等模板 */
function parseOpPage(name, wikitext) {
  const info = templateParams(wikitext, 'CharinfoV2');
  const attr = templateParams(wikitext, '属性');
  const obtain = templateParams(wikitext, '干员获得方式');
  const arch = templateParams(wikitext, '人员档案set');
  const rec = {
    page: name,
    charId: info['干员id'] || '',
    nameCn: info['干员名'] || name,
    nameJp: info['干员名jp'] || '',
    nameEn: info['干员外文名'] || '',
    rarity: info['稀有度'] || '',
    profession: info['职业'] || '',
    branch: info['分支'] || '',
    nation: info['所属国家'] || '',
    org: info['所属组织'] || '',
    team: info['所属团队'] || '',
    position: info['位置'] || '',
    tags: info['标签'] || '',
    trait: info['特性'] || '',
    drawer: info['画师'] || '',
    cv: { jp: info['日文配音'] || '', cn: info['中文配音'] || '', kr: info['韩文配音'] || '', en: info['英文配音'] || '' },
    // 人员档案set：干员档案里的基础档案
    gender: arch['性别'] || '',
    combatExp: arch['战斗经验'] || '',
    birthplace: arch['出身地'] || '',
    birthday: arch['生日'] || '',
    race: arch['种族'] || '',
    height: arch['身高'] || '',
    infected: arch['是否感染者'] || '',
    // 六维（物理强度/战场机动/生理耐受/战术规划/战斗技巧/源石技艺适应性）
    six: {
      物理强度: arch['物理强度'] || '', 战场机动: arch['战场机动'] || '', 生理耐受: arch['生理耐受'] || '',
      战术规划: arch['战术规划'] || '', 战斗技巧: arch['战斗技巧'] || '', 源石技艺适应性: arch['源石技艺适应性'] || '',
    },
    fusionRate: arch['体细胞与源石融合率'] || '',
    crystalDensity: arch['血液源石结晶密度'] || '',
    obtain: obtain['获得方式'] || '',
    onlineTime: obtain['上线时间'] || '',
    // 精英化/再部署等
    redeploy: attr['再部署'] || '',
    cost: attr['部署费用'] || '',
    block: attr['阻挡数'] || '',
    atkInterval: attr['攻击速度'] || '',
    // 时装（时装N名称 / 系列 / 颜色 / 介绍）
    skins: (() => {
      const arr = [];
      for (let i = 1; i <= 12; i++) {
        const nm = info['时装' + i + '名称'];
        if (!nm) continue;
        arr.push({ idx: i, name: nm, group: info['时装' + i + '系列'] || '',
          color: info['时装' + i + '颜色'] || '', drawer: info['时装' + i + '画师'] || '',
          desc: info['时装' + i + '介绍'] || '' });
      }
      return arr;
    })(),
  };
  return rec;
}

/** 同步干员页（增量：缓存里没有的才抓；--force 全抓） */
async function syncOps(opts) {
  const o = opts || {};
  ensure();
  const arkData = require('../ark_data');
  const ops = arkData.operators().list;
  const cache = readJson(OPS_FILE, { at: 0, byName: {}, byId: {} });
  let list = ops.filter((x) => x.name);
  if (!o.force) list = list.filter((x) => !cache.byName[x.name]);
  if (o.limit) list = list.slice(0, o.limit);
  console.log(`PRTS 干员页：需要抓 ${list.length} / 共 ${ops.length}`);
  let done = 0;
  await pool(list, 5, async (op) => {
    const d = await apiJson({
      action: 'query', prop: 'revisions', rvslots: 'main', rvprop: 'content',
      titles: op.name, format: 'json', formatversion: '2', redirects: '1',
    });
    const pg = ((d.query && d.query.pages) || [])[0];
    if (!pg || pg.missing || !pg.revisions || !pg.revisions[0]) {
      cache.byName[op.name] = { page: op.name, missing: true };
      return;
    }
    const wt = pg.revisions[0].slots.main.content;
    const rec = parseOpPage(op.name, wt);
    rec.at = Date.now();
    cache.byName[op.name] = rec;
    if (rec.charId) cache.byId[rec.charId] = rec;
    done++;
    if (done % 25 === 0) console.log(`  ... 已抓 ${done}`);
  });
  cache.at = Date.now();
  writeJson(OPS_FILE, cache);
  console.log(`PRTS 干员页：完成，缓存 ${Object.keys(cache.byName).length} 条`);
  return cache;
}

function opsCache() { return readJson(OPS_FILE, { at: 0, byName: {}, byId: {} }); }

// ---------------------------------------------------------------- 图片
function imgIdx() { return readJson(IMGIDX_FILE, { at: 0, items: {} }); }

function imgKey(t) { return String(t || '').replace(/_/g, ' ').trim().toLowerCase(); }

/** 批量查图片 URL。传入的标题可以不带扩展名（PRTS 上可能是 .png/.jpg），
 *  命中哪个扩展名就记哪个；索引以「传入的基准标题」为键。 */
async function resolveImages(bases) {
  const idx = imgIdx();
  const now = Date.now();
  const need = bases.filter((b) => {
    const it = idx.items[b];
    if (!it) return true;
    if (it.missing && now - (it.at || 0) > 7 * 86400000) return true; // 负面结果 7 天后重试
    return false;
  });
  const cands = [];
  for (const b of need) {
    if (/\.(png|jpg|jpeg|gif)$/i.test(b)) cands.push({ base: b, title: b });
    else for (const ext of ['.png', '.jpg', '.jpeg', '.gif']) cands.push({ base: b, title: b + ext });
  }
  for (let i = 0; i < cands.length; i += 40) {
    const chunk = cands.slice(i, i + 40);
    const map = {};
    for (const c of chunk) map[imgKey(c.title)] = c.base;
    let d;
    try {
      d = await apiJson({
        action: 'query', titles: chunk.map((c) => 'File:' + c.title).join('|'),
        prop: 'imageinfo', iiprop: 'url|size', format: 'json', formatversion: '2',
      });
    } catch (e) { await sleep(400); continue; }
    const seen = new Set();
    for (const p of ((d.query && d.query.pages) || [])) {
      const raw = String(p.title || '').replace(/^(File|文件|Image|图像):/i, '');
      const base = map[imgKey(raw)];
      if (!base) continue;
      seen.add(base);
      if (p.missing || !p.imageinfo || !p.imageinfo[0]) { idx.items[base] = { missing: true, at: now }; continue; }
      const ii = p.imageinfo[0];
      idx.items[base] = { url: ii.url, w: ii.width, h: ii.height, size: ii.size, file: raw, at: now };
    }
    for (const c of chunk) if (!seen.has(c.base) && idx.items[c.base] === undefined) idx.items[c.base] = { missing: true, at: now };
    await sleep(150);
  }
  idx.at = now;
  writeJson(IMGIDX_FILE, idx);
  return idx;
}

/** 取一张 PRTS 图片到本地（返回本地路径或 null） */
async function image(title, opts) {
  const o = opts || {};
  const idx = o.force ? await resolveImages([title]) : await resolveImages([title]);
  const it = idx.items[title];
  if (!it || it.missing || !it.url) return null;
  const ext = (it.url.match(/\.(png|jpg|jpeg|gif)$/i) || ['.png'])[0];
  const safe = title.replace(/[\\/:*?"<>|\s]+/g, '_') + ext;
  const dest = path.join(ARK_DIR, 'img', o.dir || 'prts', safe);
  if (!o.force && fs.existsSync(dest) && fs.statSync(dest).size > 64) return dest;
  try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch (e) {}
  const buf = await arkFetch.getOnce(it.url, null, 5);
  const tmp = dest + '.part';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);
  return dest;
}

/** 图片标题要试扩展名，这里额外提供 PRTS 卡池一览（含「进店」标记）的解析 */
async function fetchBannerRotation(kind, year) {
  const titles = {
    standard: `卡池一览/常驻标准寻访/${year}`,
    mid: `卡池一览/常驻中坚寻访&中坚甄选/${year}`,
    limited: '卡池一览/限时寻访',
  };
  const title = titles[kind];
  if (!title) return [];
  const d = await apiJson({ action: 'parse', page: title, prop: 'wikitext', format: 'json' });
  if (!d.parse || !d.parse.wikitext) return [];
  const wt = d.parse.wikitext['*'];
  const rows = [];
  for (const block of wt.split(/\n\|-/)) {
    const cells = block.split(/\n\s*\|/).map((x) => x.trim());
    const times = (block.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/g) || []);
    if (times.length < 2) continue;
    const start = Date.parse(times[0].replace(' ', 'T') + ':00+08:00') / 1000;
    const end = Date.parse(times[1].replace(' ', 'T') + ':00+08:00') / 1000;
    const parseOps = (cell) => {
      const out = [];
      const rx = /\{\{干员头像\|([^|}]+)(\|[^}]*)?\}\}/g;
      let m;
      // 标准寻访用 shop=1，中坚寻访用 shop2=1，都表示「进店」
      while ((m = rx.exec(cell))) out.push({ name: m[1].trim(), shop: /shop2?\s*=\s*1/.test(m[2] || '') });
      return out;
    };
    const opCells = cells.filter((c) => c.includes('干员头像'));
    if (!opCells.length) continue;
    const six = parseOps(opCells[0] || '');
    const five = opCells[1] ? parseOps(opCells[1]) : [];
    const banner = (block.match(/\[\[文件:([^|\]]+)/) || [])[1] || '';
    rows.push({ no: (cells[1] || '').replace(/[^\d]/g, ''), start, end, banner, six, five });
  }
  return rows;
}

/** 卡池一览缓存（标准 / 中坚 / 限时），一天有效 */
async function bannerRotation(opts) {
  const o = opts || {};
  const file = path.join(PRTS_DIR, 'banners.json');
  const cache = readJson(file, { at: 0, rows: [] });
  const day = 86400000;
  if (!o.force && cache.at && Date.now() - cache.at < day && cache.rows.length) return cache.rows;
  const year = new Date(Date.now() + 8 * 3600 * 1000).getUTCFullYear();
  const years = [year, year - 1];
  const rows = [];
  for (const y of years) {
    for (const kind of ['standard', 'mid', 'limited']) {
      try {
        const r = await fetchBannerRotation(kind, y);
        for (const x of r) rows.push(Object.assign({ kind, year: y }, x));
      } catch (e) { /* 忽略单页失败 */ }
      await sleep(150);
    }
  }
  if (rows.length) writeJson(file, { at: Date.now(), rows });
  return rows.length ? rows : cache.rows;
}

module.exports = { syncSmw, smw, syncOps, opsCache, resolveImages, image, apiJson, imgIdx, PRTS_DIR, OPS_FILE, SMW_FILE, bannerRotation, fetchBannerRotation };

// ---------------------------------------------------------------- CLI
if (require.main === module) {
  (async () => {
    const [cmd, ...rest] = process.argv.slice(2);
    const flags = {};
    const args = [];
    for (const a of rest) {
      if (a === '--force') flags.force = true;
      else if (a.startsWith('--limit')) flags.limit = Number(a.split('=')[1] || rest[rest.indexOf(a) + 1] || 0);
      else args.push(a);
    }
    if (cmd === 'smw') {
      const d = await syncSmw(flags);
      console.log('SMW 干员数:', Object.keys(d.ops).length);
      for (const k of Object.keys(d.ops).slice(0, 2)) console.log(' ', k, JSON.stringify(d.ops[k]));
    } else if (cmd === 'sync') {
      await syncSmw(flags);
      await syncOps(flags);
    } else if (cmd === 'img') {
      const idx = await resolveImages(args);
      for (const t of args) console.log(' ', t, JSON.stringify(idx.items[t] || null));
    } else {
      console.log('用法: node tools/ark_prts.js sync|smw|img [--force] [--limit N] [标题...]');
    }
  })().catch((e) => { console.error('失败:', e.message); process.exit(1); });
}
