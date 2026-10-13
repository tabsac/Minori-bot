'use strict';
/**
 * 明日方舟数据层：把 Kengxxiao 的官方数据表 + PRTS 的补充字段整理成「一个索引」
 *
 * 分工：
 *   Kengxxiao 数据表（data/ark/tables）＝硬数据：干员三维/技能/天赋、关卡/波次/路线、卡池起止、
 *                                        剿灭轮换、资源副本星期表、保全派驻赛季、皮肤表
 *   PRTS（data/ark/prts）            ＝软字段：分支/阵营/出生地/种族/性别/生日/身高/画师/声优 +
 *                                        所有图片（立绘/头像/敌人/道具/地图/活动 KV）
 *
 * 所有表都是懒加载 + 磁盘缓存，命令触发的只是读文件；抓取用 ark_fetch.js。
 */
const fs = require('fs');
const path = require('path');
const arkFetch = require('./ark_fetch');

const TABLES = arkFetch.TABLE_DIR;
const PRTS_DIR = path.join(arkFetch.ARK_DIR, 'prts');

const PROFESSION_CN = {
  PIONEER: '先锋', WARRIOR: '近卫', SNIPER: '狙击', TANK: '重装',
  MEDIC: '医疗', CASTER: '术师', SUPPORT: '辅助', SPECIAL: '特种',
};
const PROFESSION_EN = Object.keys(PROFESSION_CN);
const RARITY_CN = { 0: '0', 1: '1', 2: '2', 3: '3', 4: '4', 5: '5', 6: '6' };

function readJson(f, d) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; }
}
function tableFile(name) {
  const p = path.join(TABLES, name);
  if (!fs.existsSync(p)) {
    throw new Error(`缺少数据表 ${name}，请先跑：node ark_fetch.js table ${name}`);
  }
  const d = readJson(p, null);
  if (!d) throw new Error(`数据表 ${name} 解析失败（半截文件？删掉重抓）`);
  return d;
}

const _cache = {};
function cached(key, fn) {
  if (_cache[key] === undefined) _cache[key] = fn();
  return _cache[key];
}
function clearCache() { for (const k of Object.keys(_cache)) delete _cache[k]; }

// ---------------------------------------------------------------- 干员
function operators() {
  return cached('ops', () => {
    const ct = tableFile('character_table.json');
    const list = [];
    for (const id of Object.keys(ct)) {
      const v = ct[id];
      if (!v || typeof v !== 'object') continue;
      if (v.profession === 'TOKEN' || v.profession === 'TRAP') continue;
      if (!v.name) continue;
      const phases = v.phases || [];
      const maxPhase = phases[phases.length - 1] || {};
      const frames = maxPhase.attributesKeyFrames || [];
      const top = (frames[frames.length - 1] || {}).data || {};
      const elite0 = ((phases[0] || {}).attributesKeyFrames || [])[0] || {};
      list.push({
        id,
        name: v.name,
        appellation: v.appellation || '',
        rarity: Number(String(v.rarity || 'TIER_1').replace('TIER_', '')) || 1,
        profession: v.profession || '',
        professionCn: PROFESSION_CN[v.profession] || v.profession || '',
        subProfessionId: v.subProfessionId || '',
        nationId: v.nationId || '',
        groupId: v.groupId || '',
        teamId: v.teamId || '',
        tags: v.tagList || [],
        position: v.position || '',
        desc: v.description || '',
        usage: v.itemUsage || '',
        obtain: v.itemObtainApproach || '',
        maxHp: top.maxHp || 0, atk: top.atk || 0, def: top.def || 0,
        res: top.magicResistance || 0, cost: top.cost || 0, block: top.blockCnt || 0,
        redeploy: top.respawnTime || 0, atkInterval: top.baseAttackTime || 0,
        baseHp: (elite0.data || {}).maxHp || 0, baseAtk: (elite0.data || {}).atk || 0,
        baseDef: (elite0.data || {}).def || 0,
        phases: phases.map((p) => ({
          phase: p.phase, maxLevel: p.maxLevel,
          frames: (p.attributesKeyFrames || []).map((f) => ({ level: f.level, data: f.data })),
        })),
        skills: (v.skills || []).map((s) => ({
          skillId: s.skillId, unlockPhase: (s.unlockCond && s.unlockCond.phase) || 0,
          mastery: (s.levelUpCostCond || []).length,
        })),
        talents: (v.talents || []).map((t) => ({
          unlockPhase: t.unlockCondition ? t.unlockCondition.phase : 0,
          candidates: (t.candidates || []).map((c) => ({ name: c.name, desc: stripTags(c.description || '') })),
        })),
        potentials: (v.potentialRanks || []).map((p) => stripTags(p.description || '')),
        trust: (v.favorKeyFrames || []).map((f) => f.data || {}),
        allSkillLvlup: (v.allSkillLvlup || []).length,
      });
    }
    const byName = {}, byId = {};
    for (const x of list) { byName[x.name] = x; byId[x.id] = x; }
    return { list, byName, byId };
  });
}

/** 去掉游戏富文本标记：<@ba.kw>…</>、<color=#fff>…</color>、{{color|#fff|…}}、{占位符}、\n */
function stripTags(s) {
  let t = String(s == null ? '' : s);
  t = t.replace(/\\n/g, '\n');
  // {{color|#xxx|正文}} / {{color|darkgrey|正文}} → 正文（可能嵌套，多跑几轮）
  for (let i = 0; i < 4; i++) {
    const before = t;
    t = t.replace(/\{\{color\|[^|{}]*\|([^{}]*)\}\}/g, '$1');
    t = t.replace(/\{\{([a-zA-Z]+)\|([^{}]*)\}\}/g, (m, k, rest) => {
      const parts = String(rest).split('|');
      return parts.length > 1 ? parts[parts.length - 1] : m;
    });
    if (t === before) break;
  }
  t = t.replace(/<@[^>]*>/g, '');          // <@ba.kw> / <@lv.item>
  t = t.replace(/<\/>/g, '');             // 闭合标记
  t = t.replace(/<\/?(?:color|b|i|u|s|size|align|font|em|strong)(?:\s+[^>]*)?>/gi, '');
  t = t.replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  t = t.replace(/\{[a-zA-Z0-9_@.]+(?::[^}]*)?\}/g, '');  // 残留 {atk_scale:0%} 之类
  return t.replace(/[ \t]+\n/g, '\n').trim();
}

// ---------------------------------------------------------------- PRTS 补充
function prtsOps() {
  return cached('prtsOps', () => readJson(path.join(PRTS_DIR, 'ops.json'), { at: 0, byName: {}, byId: {} }));
}
function prtsSmw() {
  return cached('prtsSmw', () => readJson(path.join(PRTS_DIR, 'smw.json'), { at: 0, ops: {} }));
}
/** 合并后的干员档案（Kengxxiao 硬数据 + PRTS 软字段） */
function profile(nameOrId) {
  const { byName, byId } = operators();
  const op = byId[nameOrId] || byName[nameOrId];
  if (!op) return null;
  const p = prtsOps();
  const s = prtsSmw().ops || {};
  const d = p.byId[op.id] || p.byName[op.name] || {};
  const m = s[op.name] || {};
  const merged = Object.assign({}, op, {
    branch: d.branch || '',
    nation: d.nation || '', org: d.org || '', team: d.team || '',
    gender: d.gender || m['性别'] || '', birthplace: d.birthplace || m['出身地'] || '',
    race: d.race || m['种族'] || '', birthday: d.birthday || '', height: d.height || '',
    combatExp: d.combatExp || '', infected: d.infected || '',
    drawer: d.drawer || m['画师'] || '', cv: d.cv || {},
    cvJp: (d.cv && d.cv.jp) || m['日文配音'] || '', cvCn: (d.cv && d.cv.cn) || m['中文配音'] || '',
    onlineTime: d.onlineTime || '', obtainWay: d.obtain || '', trait: d.trait || '',
    six: d.six || {}, skins: d.skins || [], fusionRate: d.fusionRate || '', crystalDensity: d.crystalDensity || '',
    hasPrts: !!(d.charId || m['性别']),
  });
  return merged;
}

// ---------------------------------------------------------------- 模糊匹配
function normText(s) {
  return String(s || '').toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[·・'’"“”()（）\[\]【】<>《》,，.。:：;；!！?？~～\-—_/\\]/g, '');
}
function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = [];
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
function simScore(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  let sc;
  if (a.includes(b) || b.includes(a)) sc = 0.9 + 0.09 * Math.min(a.length, b.length) / Math.max(a.length, b.length);
  else {
    const d = editDistance(a, b);
    sc = 1 - d / Math.max(a.length, b.length);
    if (a.slice(0, 2) === b.slice(0, 2)) sc += 0.08;
  }
  return Math.min(0.99, Math.max(0, sc));
}
/** 在一组条目里找最像的（用于「你要找的是不是：…」） */
function similar(query, list, n, floor) {
  const s = normText(query);
  const out = [];
  for (const it of list) {
    const names = it.names || [it.name];
    let best = 0;
    for (const nm of names) { const v = simScore(s, normText(nm)); if (v > best) best = v; }
    if (best >= (floor || 0.34)) out.push({ item: it, score: best });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, n || 5);
}

// ---------------------------------------------------------------- 关卡
function stages() {
  return cached('stages', () => tableFile('stage_table.json').stages || {});
}
function zones() {
  return cached('zones', () => tableFile('zone_table.json').zones || {});
}
function zoneTable() { return cached('zoneTable', () => tableFile('zone_table.json')); }
function activities() {
  return cached('acts', () => {
    const a = tableFile('activity_table.json');
    return { basicInfo: a.basicInfo || {}, zoneToActivity: a.zoneToActivity || {}, activity: a.activity || {} };
  });
}
function campaignTable() { return cached('campaign', () => tableFile('campaign_table.json')); }
function climbTable() { return cached('climb', () => tableFile('climb_tower_table.json')); }
function skinsTable() { return cached('skins', () => tableFile('skin_table.json')); }
/** 游戏自己的「阵营/团队」表：key（rhodes/penguin…）→ 中文名 + 配色，好友名片的阵营收集用它 */
function teamTable() { return cached('teams', () => tableFile('handbook_team_table.json')); }
/** 全部「真皮肤」（有皮肤名的才算，默认/精英立绘不算），按官方 sortId 排序 —— 这个号就是 /ark查皮肤 的编号 */
function skinsAll() {
  return cached('skinsAll', () => {
    const cs = skinsTable().charSkins || {};
    const out = [];
    for (const id of Object.keys(cs)) {
      const s = cs[id] || {};
      const d = s.displaySkin || {};
      if (!d.skinName) continue;                       // 默认服装 / 精英立绘没有 skinName
      out.push({
        id, charId: s.charId, name: d.skinName, group: d.skinGroupName || '',
        no: Number(d.sortId || 0), getTime: Number(d.getTime || 0), drawer: (d.drawerList || [])[0] || '',
      });
    }
    out.sort((a, b) => a.no - b.no || String(a.id).localeCompare(String(b.id)));
    return out;
  });
}
function skinByNo(n) { return skinsAll().find((s) => Number(s.no) === Number(n)) || null; }
function skinsOfOperator(charId) { return skinsAll().filter((s) => s.charId === charId); }
function enemyTable() { return cached('enemy', () => tableFile('enemy_handbook_table.json')); }
function itemTable() { return cached('item', () => tableFile('item_table.json')); }
function skillTable() { return cached('skill', () => tableFile('skill_table.json')); }
function gachaTable() { return cached('gacha', () => tableFile('gacha_table.json')); }

/** 关卡：按代号或名字找；返回 { stage, fuzzy } */
function findStage(query) {
  const all = stages();
  const q = String(query || '').trim();
  const nq = normText(q);
  const eq = q.toUpperCase();
  let hit = null, candidates = [];
  for (const id of Object.keys(all)) {
    const s = all[id];
    const code = String(s.code || '');
    const name = String(s.name || '');
    const label = code ? `${code} ${name}` : name;
    if (code && code.toUpperCase() === eq) { hit = { stage: s, id, how: '' }; break; }
    if (nq && normText(name) === nq) { candidates.push({ stage: s, id, label, exact: true }); continue; }
    if (nq && normText(label) === nq) { candidates.push({ stage: s, id, label, exact: true }); }
  }
  if (hit) return hit;
  const exacts = candidates.filter((c) => c.exact);
  if (exacts.length) {
    // 同名取常驻（非复刻/非突袭）
    exacts.sort((a, b) => String(a.id).length - String(b.id).length);
    return { stage: exacts[0].stage, id: exacts[0].id, how: '' };
  }
  const list = Object.keys(all).map((id) => ({
    id, name: all[id].name || '', names: [all[id].code ? `${all[id].code} ${all[id].name}` : all[id].name, all[id].name, all[id].code].filter(Boolean),
    stage: all[id],
  }));
  const sim = similar(q, list, 5);
  if (sim.length) {
    const c = sim[0];
    return { stage: c.item.stage, id: c.item.id, how: 'like', candidates: sim.map((x) => ({ label: x.item.names[0], score: x.score })) };
  }
  return null;
}

/** 区域（章节/活动）里的所有关卡，按 stageId 排序 */
function zoneStages(zoneId) {
  const all = stages();
  const out = [];
  for (const id of Object.keys(all)) {
    const s = all[id];
    if (s.zoneId !== zoneId) continue;
    if (s.stageType === 'ACTIVITY' && /#f#$/.test(String(s.stageId))) continue; // 突袭关跳过
    if (/#f#$/.test(String(s.stageId))) continue;
    out.push(s);
  }
  // 主线按 code 里的数字；活动按 unlockCondition 顺序，退化为 stageId
  out.sort((a, b) => {
    const ca = String(a.code || ''), cb = String(b.code || '');
    const na = (ca.match(/(\d+)-(\d+)/) || []).slice(1).map(Number);
    const nb = (cb.match(/(\d+)-(\d+)/) || []).slice(1).map(Number);
    if (na.length === 2 && nb.length === 2) return (na[0] - nb[0]) || (na[1] - nb[1]);
    return String(a.stageId).localeCompare(String(b.stageId));
  });
  return out;
}

/** 找区域：支持活动名 / 主线章节名（如 靶向药物、空想花庭） */
function findZone(query) {
  const zs = zones();
  const acts = activities();
  const q = String(query || '').trim();
  const nq = normText(q);
  const rows = [];
  for (const zid of Object.keys(zs)) {
    const z = zs[zid];
    const names = [z.zoneNameFirst, z.zoneNameSecond, z.zoneNameThird].filter(Boolean);
    if (!names.length) continue;
    // 主线章节：[第五章, 靶向药物, EPISODE 05] → 取「靶向药物」这种真正的名字
    const real = names.filter((n) => !/^第.+章$/.test(n) && !/^EPISODE/i.test(n));
    const title = real.length ? real.slice(-1)[0] : names[0];
    const stageCount = zoneStages(zid).length;
    if (!stageCount) continue;
    rows.push({ zoneId: zid, type: z.type, names, title, label: names.join(' '), stageCount });
  }
  // 活动名 → zoneId（zoneToActivity 反查）；同时把同一活动的所有 zone 归组（EX 关在 zone2）
  const actByZone = {};
  for (const zid of Object.keys(acts.zoneToActivity || {})) actByZone[zid] = acts.zoneToActivity[zid];
  const zonesOfAct = {};
  for (const zid of Object.keys(actByZone)) {
    const aid = actByZone[zid];
    (zonesOfAct[aid] = zonesOfAct[aid] || []).push(zid);
  }
  for (const r of rows) {
    const actId = actByZone[r.zoneId];
    const bi = actId && acts.basicInfo[actId];
    if (bi) {
      r.actId = actId;
      r.actName = bi.name;
      r.actZones = (zonesOfAct[actId] || []).slice().sort();
      r.label = `${bi.name}（${r.label}）`;
      r.names.push(bi.name);
    }
  }
  let exact = rows.filter((r) => r.names.some((n) => normText(n) === nq));
  if (exact.length) {
    exact.sort((a, b) => (b.type === 'ACTIVITY' ? 1 : 0) - (a.type === 'ACTIVITY' ? 1 : 0) || a.zoneId.localeCompare(b.zoneId));
    return { zone: exact[0], how: '' };
  }
  const sim = similar(q, rows.map((r) => ({ name: r.title, names: r.names.concat(r.actName ? [r.actName] : []), row: r })), 5, 0.3);
  if (sim.length) return { zone: sim[0].item.row, how: 'like', candidates: sim.map((x) => ({ label: x.item.row.label, score: x.score })) };
  return null;
}

// ---------------------------------------------------------------- 限时内容
/** 当前开放的限时卡池（只保留有时间段的） */
function gachaNow(now) {
  const t = now || Date.now() / 1000;
  const pool = (gachaTable().gachaPoolClient || []).filter((p) => p.openTime && p.endTime);
  // 保持官方表里的顺序（就是游戏内「寻访」页的顺序：标准 → 中坚 → 定向…），
  // 不要按开启时间/剩余时间重排（用户明确要求按最初那个顺序）
  return pool.filter((p) => p.openTime <= t && t <= p.endTime);
}
/** 当前限时活动（有时间段 + 有开启） */
function activityNow(now) {
  const t = now || Date.now() / 1000;
  const bi = activities().basicInfo || {};
  const out = [];
  for (const id of Object.keys(bi)) {
    const a = bi[id];
    if (!a.startTime || !a.endTime) continue;
    if (a.startTime <= t && t <= a.endTime) out.push(Object.assign({ id }, a));
  }
  out.sort((a, b) => b.startTime - a.startTime);
  return out;
}
/** 当前剿灭轮换（限时剿灭） */
function campaignNow(now) {
  const t = now || Date.now() / 1000;
  const ct = campaignTable();
  const rot = (ct.campaignRotateStageOpenTimes || []).filter((e) => e.startTs <= t && t <= e.endTs);
  return rot.map((e) => Object.assign({}, e, { stage: stages()[e.stageId] || {}, zone: (ct.campaignZones || {})[e.zoneId] || {} }));
}
/** 当天开放的资源副本（用 zone_table.weeklyAdditionInfo 的星期表；若官方开了「全副本特别开放」就全开） */
function dailyNow(date) {
  const d = date || new Date();
  // 游戏内周一 = 1；JS getDay() 周日 = 0
  const dow = d.getDay() === 0 ? 7 : d.getDay();
  const zt = zoneTable();
  const add = zt.weeklyAdditionInfo || {};
  const zs = zones();
  const now = Math.floor(Date.now() / 1000);
  // forceOpenTable：官方会整段时间把所有资源关都打开（如 2026-09-29 → 10-19）
  const force = Object.keys(zt.forceOpenTable || {}).length ? null : null;
  let forceOpen = null;
  try {
    const st = tableFile('stage_table.json');
    const list = Object.values(st.forceOpenTable || {})
      .filter((x) => x.startTime <= now && now <= x.endTime)
      .sort((a, b) => b.startTime - a.startTime);
    if (list.length && Array.isArray(list[0].forceOpenList)) forceOpen = list[0];
  } catch (e) {}
  const out = [];
  for (const zid of Object.keys(add)) {
    const info = add[zid];
    if (!info || !Array.isArray(info.daysOfWeek)) continue;
    const byWeek = info.daysOfWeek.includes(dow);
    const all = !!(forceOpen && forceOpen.forceOpenList.includes(zid));
    const z = zs[zid] || {};
    const list = zoneStages(zid).filter((s) => s.stageType === 'DAILY');
    out.push({
      zoneId: zid, name: z.zoneNameSecond || z.zoneNameFirst || zid, type: info.type,
      days: info.daysOfWeek, open: byWeek || all, forceOpen: all, stages: list,
    });
  }
  out.sort((a, b) => String(a.zoneId).localeCompare(String(b.zoneId)));
  return {
    dow, all: out, open: out.filter((x) => x.open),
    forceOpen: forceOpen ? { start: forceOpen.startTime, end: forceOpen.endTime } : null,
  };
}
/** 当前保全派驻赛季 */
function sssNow(now) {
  const t = now || Date.now() / 1000;
  const ct = climbTable();
  const infos = ct.seasonInfos || {};
  const towers = ct.towers || {};
  let cur = null, next = null;
  for (const id of Object.keys(infos)) {
    const s = infos[id];
    if (s.startTs <= t && t <= s.endTs) cur = Object.assign({ id }, s);
    if (s.startTs > t && (!next || s.startTs < next.startTs)) next = Object.assign({ id }, s);
  }
  const pack = (s) => (s ? Object.assign({}, s, { towerList: (s.towers || []).map((tid) => Object.assign({ id: tid }, towers[tid] || {})) }) : null);
  return { cur: pack(cur), next: pack(next) };
}
/** 皮肤：最近 days 天上架的（游戏内 getTime） */
function skinsRecent(now, days) {
  const t = now || Date.now() / 1000;
  const cs = skinsTable().charSkins || {};
  const ops = operators().byId;
  const out = [];
  for (const sid of Object.keys(cs)) {
    const s = cs[sid];
    const ds = s.displaySkin || {};
    if (!ds.skinName) continue;
    if (!ds.getTime) continue;
    const gap = (t - ds.getTime) / 86400;
    if (gap < 0 || gap > (days || 30)) continue;
    const charId = s.charId || String(sid).split('@')[0];
    const op = ops[charId];
    out.push({
      skinId: sid, name: ds.skinName, group: ds.skinGroupName || '', groupId: ds.skinGroupId || '',
      content: ds.content || '', drawer: (ds.drawerList || [])[0] || '', getTime: ds.getTime,
      obtain: ds.obtainApproach || '', charId, opName: op ? op.name : charId, rarity: op ? op.rarity : 0,
      days: Math.floor(gap),
    });
  }
  out.sort((a, b) => b.getTime - a.getTime);
  return out;
}
/** 皮肤立绘/头像在 PRTS 上的编号：该干员第 N 套时装 → skinN（按时装中文名对齐） */
function skinIndex(opName, skinId, skinName) {
  const p = prtsOps();
  const rec = p.byName[opName];
  const skins = (rec && rec.skins) || [];
  const nm = normText(skinName || '');
  if (nm) {
    for (let i = 0; i < skins.length; i++) {
      const sn = normText(skins[i].name || '');
      if (sn && (sn === nm || sn.includes(nm) || nm.includes(sn))) return i + 1;
    }
  }
  const short = String(skinId).split('@')[1] || '';
  if (short) {
    for (let i = 0; i < skins.length; i++) {
      const idPart = String(skins[i].group || '');
      if (idPart && idPart.includes(short)) return i + 1;
    }
  }
  return 0;
}

// ---------------------------------------------------------------- 敌人 / 道具
function enemies() {
  return cached('enemies', () => (enemyTable().enemyData) || {});
}
function enemyById(id) { return enemies()[id] || null; }
function items() { return cached('items', () => (itemTable().items) || {}); }

// ---------------------------------------------------------------- 图片标题 & 批量下载
const IMG = {
  opAvatar: (name, skinN) => (skinN ? `头像 ${name}_skin${skinN}` : `头像 ${name}`),
  opHalf: (name, idx) => `半身像 ${name}_${idx || 1}`,
  opArt: (name, idx) => `立绘 ${name} ${idx || 1}`,
  opSkinArt: (name, skinN) => `立绘 ${name} skin${skinN}`,
  opSkinHalf: (name, skinN) => `半身像 ${name}_skin${skinN}`,
  enemyAvatar: (name) => `头像 敌人 ${name}`,
  itemIcon: (name) => `道具 带框 ${name}`,
  classIcon: (cn) => `图标 职业 ${cn}`,
  stageMap: (code, name) => `${code} ${name} 地图`,
  stageAuxMap: (code, name) => `${code} ${name} 辅助地图`,
  actLogo: (name) => `活动名称 ${name}`,
  actKv: (name) => `活动预告 ${name} 01`,
  chapterLogo: (name) => `章节名称 ${name}`,
};

/** 批量取图（去重、并发、失败返回 null）；返回 { 标题: 本地路径 } */
async function fetchImages(titles, opts) {
  const prts = require('./tools/ark_prts');
  const uniq = Array.from(new Set(titles.filter(Boolean)));
  const out = {};
  await prts.resolveImages(uniq);
  const conc = (opts && opts.conc) || 6;
  let i = 0;
  await Promise.all(new Array(Math.min(conc, uniq.length)).fill(0).map(async () => {
    while (i < uniq.length) {
      const t = uniq[i++];
      try { out[t] = await prts.image(t, opts); } catch (e) { out[t] = null; }
    }
  }));
  return out;
}

/** 数据版本（用于缓存失效判断） */
function dataVersion() {
  try { return fs.readFileSync(path.join(TABLES, 'data_version.txt'), 'utf8').trim(); } catch (e) { return ''; }
}
/** 数据表最后更新时间 */
function tableStamp() {
  let t = 0;
  try {
    for (const f of fs.readdirSync(TABLES)) t = Math.max(t, fs.statSync(path.join(TABLES, f)).mtimeMs);
  } catch (e) {}
  return t;
}

module.exports = {
  PROFESSION_CN, PROFESSION_EN, RARITY_CN, IMG,
  operators, profile, prtsOps, prtsSmw, stripTags,
  stages, zones, zoneTable, activities, campaignTable, climbTable, skinsTable, teamTable, skinsAll, skinByNo, skinsOfOperator, enemyTable, itemTable, skillTable, gachaTable,
  findStage, findZone, zoneStages, stageById: (id) => stages()[id] || null,
  gachaNow, activityNow, campaignNow, dailyNow, sssNow, skinsRecent, skinIndex,
  enemies, enemyById, items,
  fetchImages, similar, simScore, normText, editDistance,
  dataVersion, tableStamp, clearCache, tableFile,
};
