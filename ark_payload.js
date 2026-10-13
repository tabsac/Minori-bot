'use strict';
/**
 * 渲染载荷组装：把 ark_data 的原始数据整理成「Python 画图脚本要的那一份 JSON」，
 * 顺带列出需要下载的图片标题。命令层只负责：build → fetchImages → runPy。
 */
const ark = require('./ark_data');
const IMG = ark.IMG;

// ---------------------------------------------------------------- 文本处理
/** 技能描述里的占位符替换：{times} / {atk_scale:0%} + <@ba.vup>…</> 标记清除 */
function fillDesc(desc, blackboard) {
  let s = String(desc == null ? '' : desc);
  const bb = {};
  for (const b of (blackboard || [])) {
    let v = b.value;
    if (b.valueStr != null) v = b.valueStr;
    bb[b.key] = v;
  }
  s = s.replace(/\{([a-zA-Z0-9_@.]+)(?::([^}]*))?\}/g, (m, key, fmt) => {
    const v = bb[key];
    if (v === undefined) return m;
    if (typeof v !== 'number') return String(v);
    if (fmt && /%$/.test(fmt)) return (v * 100).toFixed(v * 100 % 1 ? 1 : 0) + '%';
    if (fmt === 'F0' || fmt === '0') return String(Math.round(v));
    if (fmt === 'F1') return v.toFixed(1);
    return String(Number.isInteger(v) ? v : Number(v.toFixed(3)));
  });
  return ark.stripTags(s);
}
function cleanText(s) { return ark.stripTags(String(s == null ? '' : s)); }
const PHASE_LABEL = ['精英0', '精英1', '精英2', '精英3', '精英4'];

// ---------------------------------------------------------------- 干员详情
function opDetail(nameOrId, opts) {
  const o = opts || {};
  const p = ark.profile(nameOrId);
  if (!p) {
    const list = ark.operators().list.map((x) => ({ name: x.name, names: [x.name, x.appellation].filter(Boolean), id: x.id }));
    return { error: 'notfound', similar: ark.similar(nameOrId, list, 5) };
  }
  const sk = ark.skillTable();
  const phases = p.phases || [];
  const stats = [];
  for (let i = 0; i < phases.length; i++) {
    const ph = phases[i];
    const fr = ph.frames || [];
    const last = fr[fr.length - 1] || {};
    const pn = Number(ph.phase != null ? String(ph.phase).replace('PHASE_', '') : i);
    stats.push({ label: `${PHASE_LABEL[isNaN(pn) ? i : pn] || '精英' + (isNaN(pn) ? i : pn)} Lv.${ph.maxLevel}`, data: last.data || {} });
  }
  const firstData = ((phases[0] || {}).frames || [{}])[0].data || {};
  const topData = stats.length ? stats[stats.length - 1].data : {};
  const trust = (p.trust || [])[(p.trust || []).length - 1] || {};

  const skills = (p.skills || []).map((s) => {
    const raw = sk[s.skillId] || {};
    const levels = raw.levels || [];
    const top = levels[levels.length - 1] || {};
    const lv7 = levels[6] || top;
    return {
      id: s.skillId,
      name: top.name || s.skillId,
      unlock: PHASE_LABEL[Number(String(s.unlockPhase).replace('PHASE_', '')) || 0] || '精英0',
      desc: fillDesc(top.description, top.blackboard),
      desc7: fillDesc(lv7.description, lv7.blackboard),
      sp: spText(top.spData),
      type: skillTypeCn(top.skillType),
      mastery: s.mastery || 0,
    };
  });

  const talents = (p.talents || []).map((t) => {
    const cands = t.candidates || [];
    const last = cands[cands.length - 1] || {};
    const potentials = cands.map((c) => c.desc).filter(Boolean);
    return {
      name: last.name || '天赋',
      phase: PHASE_LABEL[Number(String(t.unlockPhase).replace('PHASE_', '')) || 0] || '',
      desc: last.desc || '',
      levels: potentials,
    };
  });

  const artIdx = o.art === 'e0' ? 1 : (phases.length > 1 ? 2 : 1);
  const skinN = o.skin || 0;
  const artTitle = skinN ? IMG.opSkinArt(p.name, skinN) : IMG.opArt(p.name, artIdx);
  const avatarTitle = skinN ? IMG.opAvatar(p.name, skinN) : IMG.opAvatar(p.name);

  const payload = {
    name: p.name, appellation: p.appellation || '', rarity: p.rarity,
    profession: p.professionCn, branch: p.branch || '', position: posCn(p.position),
    tags: p.tags || [], nation: p.nation || '', org: [p.org, p.team].filter(Boolean).join(' / '),
    race: p.race || '', gender: p.gender || '', birthplace: p.birthplace || '',
    birthday: p.birthday || '', height: p.height || '', combatExp: p.combatExp || '',
    drawer: p.drawer || '', cvJp: p.cvJp || '', cvCn: p.cvCn || '',
    onlineTime: p.onlineTime || '', obtain: p.obtainWay || p.obtain || '', trait: p.trait || cleanText(p.desc),
    usage: cleanText(p.usage), desc: cleanText(p.desc),
    stats,
    extra: {
      再部署: p.redeploy ? p.redeploy + 's' : '-',
      部署费用: (firstData.cost != null && topData.cost != null) ? `${firstData.cost}→${topData.cost}` : '-',
      阻挡数: topData.blockCnt != null ? String(topData.blockCnt) : '-',
      攻击间隔: p.atkInterval ? p.atkInterval.toFixed(1) + 's' : '-',
    },
    trust: trustBonus(trust),
    six: p.six || {},
    skills, talents,
    potentials: (p.potentials || []).map(cleanText).filter(Boolean),
    skins: (p.skins || []).map((s, i) => ({ idx: Number(s.idx || i + 1), name: s.name, group: s.group })),
    version: ark.dataVersion().split('\n').pop().replace('VersionControl:', ''),
  };
  return { payload, titles: [artTitle, avatarTitle, IMG.classIcon(p.professionCn)], artKey: artTitle, avatarTitle };
}

function trustBonus(t) {
  const parts = [];
  if (t.maxHp) parts.push('生命+' + t.maxHp);
  if (t.atk) parts.push('攻击+' + t.atk);
  if (t.def) parts.push('防御+' + t.def);
  if (t.magicResistance) parts.push('法抗+' + t.magicResistance);
  return parts.join('　');
}
function posCn(p) { return { MELEE: '近战位', RANGED: '远程位', ALL: '任意位' }[p] || p || ''; }
function skillTypeCn(t) {
  return { AUTO: '自动回复', MANUAL: '手动触发', PASSIVE: '被动', EQUIP: '装备' }[t] || t || '';
}
function spText(sp) {
  if (!sp) return '';
  const type = { INCREASE_WHEN_ATTACK: '攻击回复', INCREASE_WHEN_HURT: '受击回复', INCREASE_WITH_TIME: '自动回复' }[sp.spType] || sp.spType || '';
  const bits = [];
  if (sp.spCost) bits.push(`消耗 ${sp.spCost}`);
  if (sp.initSp) bits.push(`初始 ${sp.initSp}`);
  return [type].concat(bits).join(' · ');
}

// ---------------------------------------------------------------- 干员检索
/** filters: {rarity:[6], profession:['狙击'], branch:[], camp:[], birth:[], race:[]} */
function opList(filters, opts) {
  const o = opts || {};
  const f = filters || {};
  const all = ark.operators().list;
  const profiles = {};
  const pf = (op) => (profiles[op.id] || (profiles[op.id] = ark.profile(op.id)));
  const match = (op, ff) => {
    const p = pf(op);
    if (ff.rarity && ff.rarity.length && !ff.rarity.includes(op.rarity)) return false;
    if (ff.profession && ff.profession.length && !ff.profession.includes(op.professionCn) && !ff.profession.includes(op.profession)) return false;
    if (ff.branch && ff.branch.length && !ff.branch.some((b) => (p.branch || '').includes(b))) return false;
    if (ff.camp && ff.camp.length && !ff.camp.some((c) => ((p.nation || '') + (p.org || '') + (p.team || '')).includes(c))) return false;
    if (ff.birth && ff.birth.length && !ff.birth.some((c) => (p.birthplace || '') === c)) return false;
    if (ff.race && ff.race.length && !ff.race.some((c) => (p.race || '') === c)) return false;
    if (ff.gender && ff.gender.length && !ff.gender.some((c) => (p.gender || '') === c)) return false;
    return true;
  };
  const hit = [];
  for (const op of all) {
    if (!match(op, f)) continue;
    const p = pf(op);
    hit.push({
      id: op.id, name: op.name, rarity: op.rarity, profession: op.professionCn,
      branch: p.branch || '', nation: p.nation || '', org: p.org || '',
      birthplace: p.birthplace || '', race: p.race || '', gender: p.gender || '',
      onlineTime: p.onlineTime || '', avatar: IMG.opAvatar(op.name),
    });
  }
  hit.sort((a, b) => b.rarity - a.rarity || a.name.localeCompare(b.name, 'zh'));
  const cap = o.cap || 60;
  const shown = hit.slice(0, cap);
  // 命中为 0 时只保留「取值不存在」的相似度提示（不放宽建议）
  let hints = [];
  if (!hit.length) hints = conditionHints(f, all);
  return {
    payload: {
      title: '干员检索',
      condition: describeFilters(f),
      total: hit.length, shown: shown.length,
      items: shown,
      hints,
      version: ark.dataVersion().split('\n').pop().replace('VersionControl:', ''),
    },
    titles: shown.map((x) => x.avatar),
  };
}
const FILTER_CN = {
  rarity: '稀有度', profession: '职业', branch: '分支', camp: '阵营',
  birth: '出生地', race: '种族', gender: '性别',
};

function describeFilters(f) {
  const bits = [];
  if (f.rarity && f.rarity.length) bits.push(f.rarity.map((r) => r + '★').join('/'));
  if (f.profession && f.profession.length) bits.push(f.profession.join('/'));
  if (f.branch && f.branch.length) bits.push(f.branch.join('/'));
  if (f.camp && f.camp.length) bits.push('阵营 ' + f.camp.join('/'));
  if (f.birth && f.birth.length) bits.push('出身 ' + f.birth.join('/'));
  if (f.race && f.race.length) bits.push('种族 ' + f.race.join('/'));
  if (f.gender && f.gender.length) bits.push('性别 ' + f.gender.join('/'));
  return bits.join('　');
}

/** 条件没命中时：告诉用户哪个条件没人满足，并给出相近的取值 */
function conditionHints(f, all) {
  const profiles = all.map((op) => ark.profile(op.id));
  const hints = [];
  const pool = {
    branch: new Set(), camp: new Set(), birth: new Set(), race: new Set(), profession: new Set(),
  };
  for (const p of profiles) {
    if (p.branch) pool.branch.add(p.branch);
    if (p.nation) pool.camp.add(p.nation);
    if (p.org) pool.camp.add(p.org);
    if (p.birthplace) pool.birth.add(p.birthplace);
    if (p.race) pool.race.add(p.race);
    if (p.professionCn) pool.profession.add(p.professionCn);
  }
  const check = (key, vals) => {
    for (const v of (vals || [])) {
      const list = Array.from(pool[key] || []);
      if (list.some((x) => x.includes(v))) continue;
      const sim = ark.similar(v, list.map((x) => ({ name: x })), 3, 0.3);
      hints.push({ key, value: v, suggest: sim.map((s) => `${s.item.name}(${Math.round(s.score * 100)}%)`) });
    }
  };
  check('profession', f.profession); check('branch', f.branch); check('camp', f.camp);
  check('birth', f.birth); check('race', f.race);
  return hints;
}

// ---------------------------------------------------------------- 卡池
function gachaList(now) {
  const t = (now || Date.now() / 1000);
  const pools = ark.gachaNow(t).filter((p) => {
    // 「限时」：有明确起止且不是常驻（归航/新人这种动辄几年的池子排除）
    const span = (p.endTime || 0) - (p.openTime || 0);
    if (span > 366 * 86400) return false;
    return true;
  });
  const prts = require('./tools/ark_prts');
  const rot = (() => { try { return prts.bannerRotationSync ? prts.bannerRotationSync() : readBanners(); } catch (e) { return []; } })();
  const items = pools.map((p) => {
    const detail = cleanText((p.dynMeta && (p.dynMeta.detailInfo || p.dynMeta.homeIntroDesc)) ||
      (typeof p.gachaPoolDetail === 'string' ? p.gachaPoolDetail : '') || p.gachaPoolSummary || '');
    // 轮换池的 UP 与「进店」来自 PRTS 卡池一览（官方数据表里没有标准池 UP）
    const kind = p.gachaRuleType === 'DOUBLE' ? 'standard'
      : (p.gachaRuleType === 'CLASSIC_DOUBLE' ? 'mid' : 'limited');
    let row = rot.find((r) => r.kind === kind && Math.abs(r.start - p.openTime) <= 3 * 86400);
    if (!row) row = rot.find((r) => r.start <= p.openTime + 86400 && p.openTime <= r.end + 86400 && r.kind === kind);
    let six = row ? row.six : [];
    let five = row ? row.five : [];
    if (!six.length && p.dynMeta) {
      // 兜底：定向甄选这类「自选锁定」池的 dynMeta 里有干员 id / 候选字典
      const dm = p.dynMeta || {};
      const pick = [];
      const pushId = (id) => {
        const it = ark.operators().byId[id];
        if (it && !pick.some((x) => x.id === id)) pick.push({ id, name: it.name, rarity: it.rarity });
      };
      if (dm.main6RarityCharId) pushId(dm.main6RarityCharId);
      if (dm.sub6RarityCharId) pushId(dm.sub6RarityCharId);
      for (const c of (dm.rare5CharList || [])) pushId(c);
      if (dm.rarityPickCharDict && typeof dm.rarityPickCharDict === 'object') {
        for (const k of Object.keys(dm.rarityPickCharDict)) {
          const v = dm.rarityPickCharDict[k];
          const arr = Array.isArray(v) ? v : [v];
          for (const c of arr) pushId(typeof c === 'string' ? c : (c && (c.charId || c.id)));
        }
      }
      six = pick.filter((x) => x.rarity === 6).map((x) => ({ name: x.name, shop: false }));
      five = pick.filter((x) => x.rarity === 5).map((x) => ({ name: x.name, shop: false }));
    }
    const upList = six.map((x) => ({ name: x.name, star: 6, shop: !!x.shop }))
      .concat(five.map((x) => ({ name: x.name, star: 5, shop: !!x.shop })));
    for (const u of upList) {
      const op = ark.operators().byName[u.name];
      if (op) { u.rarity = op.rarity; u.avatar = IMG.opAvatar(op.name); }
    }
    const titles = row && row.banner ? [row.banner.replace(/\.(png|jpg|jpeg)$/i, '')] : [];
    return {
      id: p.gachaPoolId, name: p.gachaPoolName, title: ruleCn(p.gachaRuleType), rule: ruleCn(p.gachaRuleType), ruleRaw: p.gachaRuleType,
      start: p.openTime, end: p.endTime, left: p.endTime - t,
      detail: detail === '-' ? '' : detail, summary: cleanText(p.gachaPoolSummary || ''),
      banner: titles.concat(gachaBannerCandidates(p.gachaPoolName)),
      up: upList, hasUp: upList.length > 0,
      fromPrts: !!row,
    };
  });
  return {
    payload: { title: '限时寻访', now: t, items, version: ark.dataVersion().split('\n').pop().replace('VersionControl:', '') },
    titles: items.flatMap((x) => x.banner).concat(items.flatMap((x) => (x.up || []).map((u) => u.avatar)).filter(Boolean)),
  };
}
function readBanners() {
  try {
    const fs = require('fs');
    const path = require('path');
    const f = path.join(require('./ark_fetch').ARK_DIR, 'prts', 'banners.json');
    return (JSON.parse(fs.readFileSync(f, 'utf8')).rows) || [];
  } catch (e) { return []; }
}
/** 卡池 banner 在 PRTS 上叫「<卡池名>NN.jpg」（如 定向甄选08.JPG），从新到旧试 */
function gachaBannerCandidates(name) {
  const out = [];
  for (let i = 12; i >= 1; i--) out.push(`${name}${i < 10 ? '0' + i : i}`);
  out.push(name);
  return out;
}
function ruleCn(r) {
  return {
    NORMAL: '标准寻访', DOUBLE: '标准寻访', CLASSIC_DOUBLE: '中坚寻访', CLASSIC: '中坚寻访',
    SPECIAL: '定向甄选', LIMITED: '限定寻访', LINKAGE: '联动寻访', SINGLE: '单 UP 寻访',
    BACKFLOW: '归航寻访', FES: '庆典寻访', ATTAIN: '中坚寻访',
  }[r] || r || '';
}

// ---------------------------------------------------------------- 活动
function activityList(now) {
  const t = (now || Date.now() / 1000);
  const acts = ark.activityNow(t);
  const actsTable = ark.activities();
  const zoneToAct = {};
  for (const zid of Object.keys(actsTable.zoneToActivity || {})) zoneToAct[actsTable.zoneToActivity[zid]] = zid;
  const items = acts.map((a) => {
    let stages = [];
    const zid = zoneToAct[a.id];
    if (zid) stages = ark.zoneStages(zid);
    return {
      id: a.id, name: a.name, type: a.type, displayType: a.displayType,
      start: a.startTime, end: a.endTime, left: a.endTime - t,
      rewardEnd: a.rewardEndTime || 0,
      hasStage: !!a.hasStage, stageCount: stages.length,
      zoneId: zid || '', isReplica: !!a.isReplicate,
      logo: actLogoCandidates(a.name), kv: actKvCandidates(a.name),
    };
  });
  items.sort((a, b) => (b.hasStage ? 1 : 0) - (a.hasStage ? 1 : 0) || b.start - a.start);
  return { payload: { title: '限时活动', now: t, items }, titles: items.flatMap((x) => x.logo.concat(x.kv)) };
}

// ---------------------------------------------------------------- 剿灭
async function campaignList(now) {
  const t = (now || Date.now() / 1000);
  const arkFetch = require('./ark_fetch');
  const ct = ark.campaignTable();
  const rot = (ct.campaignRotateStageOpenTimes || []);
  const cur = rot.filter((e) => e.startTs <= t && t <= e.endTs);
  const upcoming = rot.filter((e) => e.startTs > t).sort((a, b) => a.startTs - b.startTs).slice(0, 2);
  const all = ark.stages();
  const pack = (e) => {
    const s = all[e.stageId] || {};
    return {
      stageId: e.stageId, code: s.code || '', name: s.name || e.stageId,
      start: e.startTs, end: e.endTs, left: e.endTs - t,
      apCost: s.apCost || 0, danger: s.dangerLevel || '',
      mapTitle: s.code ? IMG.stageMap(s.code, s.name) : '',
      levelId: s.levelId || '',
    };
  };
  // 地图数据：PRTS 上没有剿灭的宣传图（拉特兰/龙门外环那几个页面都没配图），
  // 所以没图时由 lists.py 用官方关卡数据自绘一张地图顶上
  const curPacked = cur.map(pack);
  for (const it of curPacked) {
    if (!it.levelId) continue;
    try { it.level = await arkFetch.level(it.levelId); } catch (e) { it.level = null; }
  }
  // 模拟战：常驻剿灭按周期轮换开放（campaignTrainingStageOpenTimes），
  // 另有「全部开放」档（campaignTrainingAllOpenTimes）
  const tr = (ct.campaignTrainingStageOpenTimes || []);
  const trAll = (ct.campaignTrainingAllOpenTimes || []);
  const trCur = tr.filter((e) => e.startTs <= t && t <= e.endTs)[0] || null;
  const trAllCur = trAll.filter((e) => e.startTs <= t && t <= e.endTs)[0] || null;
  const stageBrief = (id) => {
    const s = all[id] || {};
    return { stageId: id, code: s.code || '', name: s.name || id, apCost: s.apCost || 0 };
  };
  const training = {
    start: trCur ? trCur.startTs : null,
    end: trCur ? trCur.endTs : null,
    left: trCur ? trCur.endTs - t : null,
    allOpen: !!trAllCur,
    allOpenStart: trAllCur ? trAllCur.startTs : null,
    allOpenEnd: trAllCur ? trAllCur.endTs : null,
    stages: trCur ? (trCur.stages || []).map(stageBrief) : [],
  };
  return {
    payload: {
      title: '剿灭作战', now: t,
      current: curPacked, upcoming: upcoming.map(pack),
      permanent: Object.keys(all).filter((id) => /^camp_0\d$/.test(id)).map(stageBrief),
      training,
    },
    titles: curPacked.map((it) => it.mapTitle).filter(Boolean),
  };
}

// ---------------------------------------------------------------- 资源副本
function dailyList(now) {
  const d = ark.dailyNow();
  // dailyNow 里的 forceOpen 只会在「当前正处在特别开放档期内」时非空
  const fo = d.forceOpen ? { start: d.forceOpen.start, end: d.forceOpen.end } : null;
  const items = d.all.map((z) => {
    const days = (z.days || []).slice();
    return {
      zoneId: z.zoneId, name: z.name, type: z.type, days,
      // 特别开放期间「今天」全开，但星期表仍然画常规作息 —— 别把周一也标成全部开放
      open: fo ? true : days.indexOf(d.dow) >= 0,
      forceOpen: !!fo,
      stages: z.stages.map((s) => ({
        stageId: s.stageId, code: s.code, name: s.name, apCost: s.apCost, danger: s.dangerLevel,
        drop: firstDrop(s),
      })),
    };
  });
  // 星期表里哪几列落在特别开放档期内（按「本周那一天的日期」判断）：
  // 落进去的那天画黄点 = 全副本开放，其余照常规作息画蓝点
  let forceDays = [];
  if (fo) {
    const nowD = new Date((now || Date.now() / 1000) * 1000);
    const today = new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate());
    const dow = d.dow;                                  // 1=周一 … 7=周日
    const monday = new Date(today.getTime() - (dow - 1) * 86400000);
    for (let i = 0; i < 7; i++) {
      const t = Math.floor((monday.getTime() + i * 86400000) / 1000);
      if (t + 86399 >= fo.start && t <= fo.end) forceDays.push(i + 1);
    }
  }
  return {
    payload: {
      title: '资源收集', dow: d.dow, items,
      forceOpen: fo,
      forceDays,
      today: Date.now() / 1000,
    },
    titles: [],
  };
}
function firstDrop(s) {
  const sd = s.stageDropInfo || {};
  const disp = (sd.displayDetailRewards || [])[0];
  if (disp && disp.id) {
    const it = ark.items()[disp.id];
    return it ? it.name : '';
  }
  return '';
}

// ---------------------------------------------------------------- 保全派驻
function sssList(now) {
  const t = (now || Date.now() / 1000);
  const s = ark.sssNow(t);
  const ct = ark.climbTable();
  const lv = ct.levels || {};
  const pack = (x) => {
    if (!x) return null;
    const levels = (x.towerList || []).map((tw) => ({
      id: tw.id, name: tw.name, sub: tw.subName, desc: cleanText(tw.desc),
      danger: cleanText(tw.dangerDesc), type: tw.towerType,
      levels: (tw.levels || []).map((lid) => ({ id: lid, name: (lv[lid] || {}).name || lid, code: (lv[lid] || {}).code || '', layer: (lv[lid] || {}).layerNum || 0 })),
    }));
    return { id: x.id, name: x.name, num: x.seasonNum, start: x.startTs, end: x.endTs, left: x.endTs - t, towers: levels };
  };
  return { payload: { title: '保全派驻', now: t, current: pack(s.cur), next: pack(s.next) }, titles: [] };
}

// ---------------------------------------------------------------- 皮肤（时装商店在售）
/** 当前在售时装 = shop_client_table.recommendList 里 cmd=SKINSHOP 且时间窗口覆盖当前的条目
 *  （官方数据表没有单独的「时装商店」表；这是游戏里「剩余N天」的来源，踩过：按 getTime 取近 30 天是错的） */
function skinsInShop(now) {
  const t = now || Date.now() / 1000;
  const sc = ark.tableFile('shop_client_table.json');
  const skins = ark.skinsTable().charSkins || {};
  const ops = ark.operators().byId;
  const rows = [];
  for (const r of (sc.recommendList || [])) {
    const s = Number(r.startDatetime || 0), e = Number(r.endDatetime || 0);
    if (!(s <= t && t <= e)) continue;
    for (const g of (r.groupList || [])) {
      for (const d of (g.dataList || [])) {
        if (d.cmd !== 'SKINSHOP' || !d.skinId) continue;
        const sk = skins[d.skinId] || {};
        const ds = sk.displaySkin || {};
        const charId = sk.charId || String(d.skinId).split('@')[0];
        const op = ops[charId];
        rows.push({
          skinId: d.skinId, name: ds.skinName || d.skinId, opName: op ? op.name : charId,
          rarity: op ? op.rarity : 0, group: ds.skinGroupName || r.tagName || '',
          series: r.tagName || ds.skinGroupName || '', drawer: (ds.drawerList || [])[0] || '',
          end: e, left: e - t, dynamic: !!(sk.dynIllustId || sk.spDynIllustId),
          content: cleanText(ds.content || ''), charId,
        });
      }
    }
  }
  const seen = {};
  const uniq = rows.filter((x) => (seen[x.skinId] ? false : (seen[x.skinId] = 1)));
  uniq.sort((a, b) => b.left - a.left || a.name.localeCompare(b.name, 'zh'));
  return uniq;
}
function skinList(days, now) {
  const t = (now || Date.now() / 1000);
  const shop = skinsInShop(t).map((s) => {
    const skinN = ark.skinIndex(s.opName, s.skinId, s.name);
    return Object.assign({}, s, {
      avatar: skinN ? IMG.opAvatar(s.opName, skinN) : IMG.opAvatar(s.opName),
      half: skinN ? IMG.opSkinHalf(s.opName, skinN) : IMG.opHalf(s.opName, 1),
      art: skinN ? IMG.opSkinArt(s.opName, skinN) : IMG.opArt(s.opName, 2),
      skinN,
    });
  });
  return {
    payload: {
      title: '时装商店', mode: 'shop', days: days || 30, items: shop,
      version: ark.dataVersion().split('\n').pop().replace('VersionControl:', ''),
    },
    titles: shop.flatMap((x) => [x.half, x.avatar]),
  };
}

// ---------------------------------------------------------------- /ark查皮肤
/** 一个干员的全部皮肤（缩略图 + 编号） */
function skinListOfOperator(query) {
  const arkOps = ark.operators();
  const raw = String(query || '').trim();
  let op = arkOps.byName[raw];
  if (!op) {
    const hit = ark.findOp ? ark.findOp(raw) : null;   // 找不到就按相似度提示
    return { error: 'notfound', similar: ark.similar(raw, arkOps.list.map((x) => ({ name: x.name, names: [x.name, x.appellation].filter(Boolean), id: x.id })), 5).map((s) => ({ name: s.item.name, hint: s.item.id })) };
  }
  const prof = ark.profile(op.id) || {};
  const byName = {};
  for (const s of (prof.skins || [])) byName[s.name] = s.idx;
  const list = ark.skinsOfOperator(op.id).map((s) => {
    const idx = byName[s.name] || 0;
    return {
      no: s.no, name: s.name, group: s.group, getTime: s.getTime, drawer: s.drawer,
      art: idx ? IMG.opSkinArt(op.name, idx) : '',
      thumb: idx ? IMG.opSkinHalf(op.name, idx) : '',
      prtsIdx: idx,
    };
  }).sort((a, b) => b.getTime - a.getTime);
  const titles = [];
  for (const s of list) { if (s.art) titles.push(s.art); }
  return {
    payload: {
      title: op.name, mode: 'op', opName: op.name, appellation: op.appellation || '',
      rarity: op.rarity, count: list.length, items: list,
      version: ark.dataVersion().split('\n').pop().replace('VersionControl:', ''),
    },
    titles,
  };
}

/** 按编号拿一张皮肤的原图 */
function skinByNumber(no) {
  const s = ark.skinByNo(no);
  if (!s) {
    const max = ark.skinsAll().reduce((m, x) => Math.max(m, x.no), 0);
    return { error: 'nofound', max };
  }
  const op = ark.operators().byId[s.charId] || {};
  const prof = ark.profile(s.charId) || {};
  const hit = (prof.skins || []).find((x) => x.name === s.name);
  const title = hit ? IMG.opSkinArt(op.name, hit.idx) : '';
  return {
    payload: {
      title: s.name, caption: `已展示 ${op.name || s.charId} ${s.name}`,
      no: s.no, opName: op.name || s.charId, skinName: s.name, group: s.group,
      drawer: s.drawer, getTime: s.getTime,
    },
    titles: title ? [title] : [],
    artTitle: title,
  };
}

/** 活动 KV / 名称 logo 在 PRTS 上的几种命名，全试一遍 */
// 活动宣传图候选。官方活动名常见形态：「矢量突破#3 拟生态」「空想花庭·复刻」「稳态测定签到活动」，
// PRTS 上的文件名却常常只取主干（如「矢量突破 头图」「图标 矢量突破-3」），所以要逐级去尾再试。
function actNameVariants(name) {
  const raw = String(name || '').trim();
  const out = [];
  const push = (s) => { const v = String(s || '').trim(); if (v && out.indexOf(v) < 0) out.push(v); };
  const stripReplica = raw.replace(/[·・]复刻.*$/, '');
  push(raw); push(stripReplica);
  // 「矢量突破#3 拟生态」→ 主干「矢量突破」+ 期数 3
  const m = /^(.*?)#(\d+)/.exec(stripReplica);
  if (m) {
    push(m[1]); push(`${m[1]}#${m[2]}`);
  } else {
    push(stripReplica.replace(/[#＃]\d+.*$/, ''));
  }
  const parts = stripReplica.split(/[\s　·・]+/).filter(Boolean);
  if (parts.length) push(parts[0]);
  // 「稳态测定签到活动」→ 去掉「签到活动」这种后缀
  push(stripReplica.replace(/(签到活动|限时活动|活动)$/, ''));
  return { list: out, base: out[out.length - 1] || raw, num: m ? m[2] : '' };
}

function actKvCandidates(name) {
  const v = actNameVariants(name);
  const out = [];
  const push = (s) => { if (s && out.indexOf(s) < 0) out.push(s); };
  for (const n of v.list) {
    push(`活动预告 ${n} 01`);
    push(`${n} 头图`);
    push(`${n}_头图`);
  }
  for (const n of v.list) push(`活动名称 ${n}`);
  if (v.num) { push(`图标 ${v.base}-${v.num}`); push(`图标 ${v.base}#${v.num}`); }
  for (const n of v.list) push(`图标 ${n}`);
  return out;
}

function actLogoCandidates(name) {
  const v = actNameVariants(name);
  const out = [];
  const push = (s) => { if (s && out.indexOf(s) < 0) out.push(s); };
  if (v.num) { push(`图标 ${v.base}-${v.num}`); push(`图标 ${v.base}#${v.num}`); }
  for (const n of v.list) push(`图标 ${n}`);
  for (const n of v.list) push(`活动名称 ${n}`);
  return out;
}

// ---------------------------------------------------------------- 检索条件解析
let _vocab = null;
function vocab() {
  if (_vocab) return _vocab;
  const ops = ark.operators().list;
  const v = { branch: new Set(), camp: new Set(), birth: new Set(), race: new Set(), profession: new Set(), gender: new Set() };
  for (const op of ops) {
    const p = ark.profile(op.id);
    if (p.branch) v.branch.add(p.branch);
    for (const c of [p.nation, p.org, p.team]) if (c) { v.camp.add(c); v.camp.add(String(c).split(/[-—·]/).pop()); }
    if (p.birthplace) v.birth.add(p.birthplace);
    if (p.race) v.race.add(p.race);
    if (p.professionCn) v.profession.add(p.professionCn);
    if (p.gender) v.gender.add(p.gender);
  }
  _vocab = { v, ops };
  return _vocab;
}
const PROFESSION_ALIAS = {
  先锋: '先锋', 近卫: '近卫', 狙击: '狙击', 重装: '重装', 医疗: '医疗', 术师: '术师', 术士: '术师',
  辅助: '辅助', 特种: '特种',
  pioneer: '先锋', warrior: '近卫', sniper: '狙击', tank: '重装', defender: '重装',
  medic: '医疗', caster: '术师', support: '辅助', specialist: '特种',
};
const RARITY_WORD = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6 };

/** 把 "/ark检索 6星 狙击 阵营:企鹅物流" 解析成 filters */
function parseFilters(text) {
  const { v } = vocab();
  const f = { rarity: [], profession: [], branch: [], camp: [], birth: [], race: [], gender: [] };
  const unknown = [];
  const tokens = String(text || '').split(/[\s,，、+]+/).filter(Boolean);
  const put = (key, val) => {
    const target = { 星级: 'rarity', 稀有度: 'rarity', 职业: 'profession', 分支: 'branch', 阵营: 'camp', 出身: 'birth', 出生地: 'birth', 种族: 'race', 性别: 'gender' }[key] || key;
    if (target === 'rarity') {
      const n = RARITY_WORD[val] || parseInt(val, 10);
      if (n >= 1 && n <= 6) { f.rarity.push(n); return true; }
      return false;
    }
    if (f[target]) { f[target].push(val); return true; }
    return false;
  };
  for (const tk of tokens) {
    const m = /^([^:：]+)[:：](.+)$/.exec(tk);
    if (m) { if (!put(m[1].trim(), m[2].trim())) unknown.push(tk); continue; }
    const rm = /^([1-6一二三四五六])\s*星$/.exec(tk);
    if (rm) { f.rarity.push(RARITY_WORD[rm[1]]); continue; }
    if (/^[1-6]$/.test(tk)) { f.rarity.push(Number(tk)); continue; }
    const pa = PROFESSION_ALIAS[tk] || PROFESSION_ALIAS[tk.toLowerCase()];
    if (pa) { f.profession.push(pa); continue; }
    if (v.branch.has(tk)) { f.branch.push(tk); continue; }
    if (v.camp.has(tk)) { f.camp.push(tk); continue; }
    if (v.birth.has(tk)) { f.birth.push(tk); continue; }
    if (v.race.has(tk)) { f.race.push(tk); continue; }
    if (v.gender.has(tk)) { f.gender.push(tk); continue; }
    // 模糊：分支/阵营/出生地/种族 里最像的
    const pool = []
      .concat(Array.from(v.branch).map((x) => ({ key: 'branch', x })))
      .concat(Array.from(v.camp).map((x) => ({ key: 'camp', x })))
      .concat(Array.from(v.birth).map((x) => ({ key: 'birth', x })))
      .concat(Array.from(v.race).map((x) => ({ key: 'race', x })));
    const sim = ark.similar(tk, pool.map((p) => ({ name: p.x, key: p.key })), 1, 0.5);
    if (sim.length) { f[sim[0].item.key].push(sim[0].item.name); continue; }
    unknown.push(tk);
  }
  return { filters: f, unknown, vocab: v };
}

// ---------------------------------------------------------------- 导出
// ---------------------------------------------------------------- 关卡
/** 关卡详情载荷（需要读关卡文件，异步） */
async function stageDetail(query) {
  const arkFetch = require('./ark_fetch');
  const f = ark.findStage(query);
  if (!f) {
    const list = Object.keys(ark.stages()).map((id) => {
      const s = ark.stages()[id];
      return { name: s.name, names: [s.code ? `${s.code} ${s.name}` : s.name, s.name, s.code].filter(Boolean), id };
    });
    return { error: 'notfound', similar: ark.similar(query, list, 5) };
  }
  const st = f.stage;
  let lv = {};
  try { lv = await arkFetch.level(st.levelId); } catch (e) { lv = {}; }
  const zones = ark.zones();
  const z = zones[st.zoneId] || {};
  const enemyData = ark.enemies();

  const dbRefs = lv.enemyDbRefs || [];
  const levelOf = {};
  for (const r of dbRefs) levelOf[r.id] = (r.level || 0);

  const spawns = [];
  const waves = lv.waves || [];
  waves.forEach((wv, wi) => {
    const base = Number(wv.preDelay || 0);
    let cursor = base;
    let gated = false;
    for (const fr of (wv.fragments || [])) {
      const fbase = cursor + Number(fr.preDelay || 0);
      let duration = 0;
      for (const action of (fr.actions || [])) {
        const count = action.count == null ? 1 : Number(action.count);
        if (count <= 0) continue;
        duration = Math.max(duration, Number(action.preDelay || 0) + Math.max(0, count - 1) * Number(action.interval || 0));
      }
      for (const ac of (fr.actions || [])) {
        const key = String(ac.key || '');
        // 只有 SPAWN 才是真的出兵：DISPLAY_ENEMY_INFO / PREVIEW_CURSOR / PLAY_OPERA 也带 enemy 键，
        // 早先把它们算进去导致人数虚高（JT8-3 算成 54 人，实际 44）（踩过）
        if (String(ac.actionType || '').toUpperCase() !== 'SPAWN') continue;
        if (!key) continue;
        const cnt = ac.count == null ? 1 : Math.max(0, Number(ac.count));
        const interval = Number(ac.interval || 0);
        for (let i = 0; i < cnt; i++) {
          spawns.push({
            wave: wi, time: fbase + Number(ac.preDelay || 0) + i * interval,
            enemyId: key, routeIndex: ac.routeIndex == null ? null : Number(ac.routeIndex),
            random: !!ac.randomSpawnGroupKey, gated,
          });
        }
      }
      cursor = fbase + duration;
      if ((fr.actions || []).some(a => a.blockFragment)) gated = true;
    }
  });
  // 路径标签：同一条实际路线（起点+途经点+终点相同）合并成一个 P 号，按首次出现顺序编号
  const routes = lv.routes || [];
  const sigOf = (ri) => {
    const rt = routes[ri];
    if (!rt) return 'r' + ri;
    return JSON.stringify([rt.motionMode, rt.startPosition, (rt.checkpoints || [])
      .filter(c => ['MOVE','APPEAR_AT_POS','DISAPPEAR'].includes(String(c.type).toUpperCase()))
      .map(c => [c.type, c.type === 'DISAPPEAR' ? null : c.position]), rt.endPosition]);
  };
  const sigLabel = {};
  const routeLabels = {};
  for (const s of spawns.slice().sort((a, b) => a.wave - b.wave || a.time - b.time)) {
    if (s.routeIndex == null) continue;
    const sig = sigOf(s.routeIndex);
    if (!sigLabel[sig]) sigLabel[sig] = 'P' + (Object.keys(sigLabel).length + 1);
    routeLabels[s.routeIndex] = sigLabel[sig];
  }
  const enemyName = (id) => {
    const e = enemyData[id];
    if (e && e.name) return e.name;
    return String(id || '').replace(/^enemy_/, '');
  };
  const waveList = waves.map((wv, wi) => ({
    preDelay: Number(wv.preDelay || 0),
    enemies: spawns.filter((s) => s.wave === wi)
      .sort((a, b) => a.time - b.time || a.routeIndex - b.routeIndex)
      .map((s) => ({
        time: Number(s.time.toFixed(1)), name: enemyName(s.enemyId) + (s.random ? "（随机）" : ""),
        route: s.routeIndex == null ? '-' : (routeLabels[s.routeIndex] || ('P' + (s.routeIndex + 1))),
        id: s.enemyId, gated: s.gated,
      })),
  }));

  const cfgMap = {};
  for (const s of spawns) {
    const k = s.enemyId;
    if (!cfgMap[k]) cfgMap[k] = { id: k, name: enemyName(k), count: 0, phases: new Set(), routes: new Set() };
    cfgMap[k].count++;
    if (s.routeIndex != null && routeLabels[s.routeIndex]) cfgMap[k].routes.add(routeLabels[s.routeIndex]);
    cfgMap[k].phases.add((levelOf[k] || 0) + 1);
  }
  const enemyConfig = Object.keys(cfgMap).map((k) => ({
    id: k, name: cfgMap[k].name, count: cfgMap[k].count,
    phases: Array.from(cfgMap[k].phases).sort((a, b) => a - b),
    routes: Array.from(cfgMap[k].routes).sort((a,b) => Number(a.slice(1))-Number(b.slice(1))),
    icon: IMG.enemyAvatar(cfgMap[k].name),
  })).sort((a, b) => b.count - a.count);

  // 掉落
  const items = ark.items();
  const drops = [];
  const dd = ((st.stageDropInfo || {}).displayDetailRewards) || [];
  for (const r of dd.slice(0, 12)) {
    const it = items[r.id] || {};
    if (!it.name) continue;
    drops.push({ name: it.name, rate: dropTypeCn(r.dropType), icon: IMG.itemIcon(it.name) });
  }

  const payload = {
    previewFile: await require('./ark_stage_preview').stagePreview(st.levelId),
    stage: { code: st.code, name: st.name, description: A0(st.description), apCost: st.apCost, dangerLevel: st.dangerLevel, stageId: st.stageId, levelId: st.levelId, stageType: st.stageType },
    zoneName: [z.zoneNameFirst, z.zoneNameSecond].filter(Boolean).join(' '),
    subTitle: [st.stageType === 'MAIN' ? '主线' : (st.stageType === 'ACTIVITY' ? '活动' : st.stageType),
      st.difficulty === 'FOUR_STAR' ? '突袭' : '', st.bossMark ? 'BOSS' : ''].filter(Boolean).join(' · '),
    level: { mapData: lv.mapData || {}, routes: lv.routes || [] },
    routeLabels, waveList, enemyConfig, drops,
    enemyCount: st.enemyCnt != null ? st.enemyCnt : spawns.length,
    maxSlot: (lv.options || {}).characterLimit, initialCost: (lv.options || {}).initialCost,
    maxCost: (lv.options || {}).maxCost, maxLife: (lv.options || {}).maxLifePoint,
    // 只认「<code> <name> 地图」这张干净的地图预览；辅助地图上盖了一层可部署格标记（红蓝小方块），
    // 用户明确说不要那张 —— 没有就自绘一张（stage.py 里根据地图数据画格子）
    mapTitles: st.code ? [IMG.stageMap(st.code, st.name), `地图 ${st.code} ${st.name}`] : [],
    version: ark.dataVersion().split('\n').pop().replace('VersionControl:', ''),
  };
  const titles = payload.mapTitles.concat(enemyConfig.map((e) => e.icon)).concat(drops.map((x) => x.icon));
  if (f.how === 'like' && f.candidates) payload.likeHint = f.candidates;
  return { payload, titles, how: f.how };
}
function A0(s) { return ark.stripTags(String(s == null ? '' : s)); }
function dropTypeCn(t) {
  return { ONCE: '首次', NORMAL: '常规', SPECIAL: '特殊', ADDITIONAL: '额外', COMPLETE: '三星', PASS: '通关' }[t] || (t || '');
}

/** 活动/主线总览载荷 */
async function stageOverview(query) {
  const f = ark.findZone(query);
  if (!f) {
    const zs = ark.zones();
    const list = Object.keys(zs).map((id) => {
      const z = zs[id];
      const nm = [z.zoneNameFirst, z.zoneNameSecond, z.zoneNameThird].filter(Boolean);
      return { name: nm[nm.length - 1] || id, names: nm.concat([id]), id };
    }).filter((x) => x.names.some(Boolean));
    return { error: 'notfound', similar: ark.similar(query, list, 5) };
  }
  const z = f.zone;
  // 活动：把同一活动的所有 zone 合并（普通关 + EX 关），主线：本身一个 zone
  const zids = (z.actZones && z.actZones.length) ? z.actZones : [z.zoneId];
  const seen = {};
  let stages = [];
  for (const zid of zids) {
    for (const s of ark.zoneStages(zid)) {
      if (/#f#$/.test(String(s.stageId))) continue;
      if (seen[s.stageId]) continue;
      seen[s.stageId] = 1;
      stages.push(s);
    }
  }
  const isMain = /MAINLINE|BRANCHLINE/.test(String(z.type || ''));
  const sortKey = (s) => {
    const code = String(s.code || '');
    let m;
    if (isMain) {
      m = /^(\d+)-(\d+)$/.exec(code);
      if (m) return [0, Number(m[1]) * 1000 + Number(m[2])];
      m = /^H(\d+)-(\d+)$/.exec(code);
      if (m) return [1, Number(m[1]) * 1000 + Number(m[2])];
      m = /^S(\d+)-(\d+)$/.exec(code);
      if (m) return [2, Number(m[1]) * 1000 + Number(m[2])];
      return [3, 0];
    }
    m = /^([A-Za-z]+)-EX-(\d+)$/.exec(code);
    if (m) return [1, Number(m[2])];
    m = /^([A-Za-z]+)-(\d+)$/.exec(code);
    if (m) return [0, Number(m[2])];
    m = /-ST-(\d+)$/.exec(code);
    if (m) return [2, Number(m[1] || 0)];
    m = /-TR-(\d+)$/.exec(code);
    if (m) return [3, Number(m[1] || 0)];
    return [4, 0];
  };
  stages.sort((a, b) => {
    const ka = sortKey(a), kb = sortKey(b);
    return (ka[0] - kb[0]) || (ka[1] - kb[1]) || String(a.code || a.stageId).localeCompare(String(b.code || b.stageId));
  });
  const acts = ark.activities();
  const act = z.actId ? acts.basicInfo[z.actId] : null;
  const payload = {
    title: (act && act.name) || z.title,
    zoneId: z.zoneId,
    zoneName: z.names.join(' · '),
    zoneType: { MAINLINE: '主线', ACTIVITY: '活动', SIDESTORY: '故事集', WEEKLY: '资源', CAMPAIGN: '剿灭', MAINLINE_ACTIVITY: '主线活动', BRANCHLINE: '支线', MAINLINE_RETRO: '主线回顾' }[z.type] || z.type,
    actId: z.actId || '', actName: act ? act.name : '',
    start: act ? act.startTime : 0, end: act ? act.endTime : 0,
    stageCount: stages.length,
    stages: stages.map((s) => ({
      stageId: s.stageId, code: s.code || '', name: s.name || '', apCost: s.apCost,
      danger: s.dangerLevel || '', desc: A0(s.description || '').slice(0, 60),
      boss: !!s.bossMark, difficulty: s.difficulty,
    })),
    cover: (act ? actKvCandidates(act.name).concat(actLogoCandidates(act.name)) : [])
      .concat([
        `章节名称 ${z.names[0] || ''}`, `章节名称 ${z.title || ''}`,
        (stages[0] && stages[0].code) ? IMG.stageMap(stages[0].code, stages[0].name) : '',
        z.title ? `${z.title}_头图` : '', z.title ? `活动名称 ${z.title}` : '',
      ].filter(Boolean)),
    version: ark.dataVersion().split('\n').pop().replace('VersionControl:', ''),
  };
  const titles = payload.cover.slice(0, 6);
  if (f.how === 'like' && f.candidates) payload.likeHint = f.candidates;
  return { payload, titles, how: f.how };
}

// ---------------------------------------------------------------- 猜干员（对齐 mer.dev/arknights-wordle）
/** 大头 easy 基础属性猜测 / 兔头 hard 数值属性猜测 / 小头 puzzle 像素化立绘猜测
 *  小头：马赛克从 2×2 逐档细化到 16×16，到 16×16 时给一次提示；立绘池含该干员的时装 */
const DLE_MODES = {
  easy: {
    id: 'easy', name: '大头', desc: '基础属性猜测',
    cols: [
      { key: 'gender', label: '性别' },
      { key: 'rarity', label: '星级', num: true },
      { key: 'profession', label: '职业' },
      { key: 'nation', label: '国家' },
      { key: 'race', label: '种族' },
      { key: 'adapt', label: '源石技艺适应性', short: '源石技艺', ord: true },
      { key: 'height', label: '身高', short: '身高', num: true, unit: 'cm' },
      { key: 'infected', label: '感染状态', short: '感染' },
      { key: 'birthday', label: '出生日期', short: '生日', date: true },
      { key: 'tags', label: '标签', multi: true },
    ],
  },
  hard: {
    id: 'hard', name: '兔头', desc: '数值属性猜测',
    cols: [
      { key: 'rarity', label: '星级', num: true },
      { key: 'hp', label: '满级生命', short: '生命', num: true },
      { key: 'atk', label: '满级攻击', short: '攻击', num: true },
      { key: 'def', label: '满级防御', short: '防御', num: true },
      { key: 'res', label: '满级法术抗性', short: '法抗', num: true },
      { key: 'atkInterval', label: '攻击间隔', short: '攻速', num: true, unit: 's' },
      { key: 'year', label: '上线年份', short: '上线年', num: true },
      { key: 'tags', label: '标签', multi: true },
    ],
  },
  puzzle: { id: 'puzzle', name: '小头', desc: '像素化立绘猜测', cols: [] },
};
/** 小头：第 n 次猜错后的马赛克档位（N×N 块），最后一档 16×16 给一次提示 */
const DLE_GRID = [2, 4, 6, 8, 10, 12, 14, 16];
const ADAPT_ORDER = { '缺陷': 0, '普通': 1, '标准': 2, '优良': 3, '卓越': 4 };

function dleAttrs(nameOrId) {
  const op = ark.operators().byId[nameOrId] || ark.operators().byName[nameOrId];
  if (!op) return null;
  const p = ark.profile(op.id);
  const year = Number((p.onlineTime || '').slice(0, 4)) || 0;
  return {
    id: op.id,
    name: op.name,
    rarity: op.rarity,
    profession: op.profession,
    professionCn: op.professionCn,
    branch: p.branch || '—',
    nation: p.nation || p.org || '—',
    race: p.race || '—',
    gender: p.gender || '—',
    birthday: p.birthday || '—',
    height: Number(String(p.height || '').replace(/[^\d.]/g, '')) || 0,
    year,
    yearText: year ? String(year) : '—',
    infected: (p.infected || '').includes('非') ? '非感染者' : (p.infected ? '感染者' : '—'),
    adapt: (p.six && p.six['源石技艺适应性']) || '—',
    tags: (op.tags || []).slice(),
    hp: op.maxHp, atk: op.atk, def: op.def, res: op.res,
    atkInterval: Number((op.atkInterval || 0).toFixed(1)),
    avatar: IMG.opAvatar(op.name),
    skins: (p.skins || []),
  };
}

/** 随机一局：范围 = 所有干员（不按日期固定，也不限稀有度） */
function dleStart(mode) {
  const m = DLE_MODES[mode] ? mode : 'easy';
  const all = ark.operators().list;
  const op = all[Math.floor(Math.random() * all.length)];
  const a = dleAttrs(op.id);
  const out = { mode: m, answerId: op.id, answerName: a.name, titles: [], imageTitle: '', imageLabel: '' };
  if (m === 'puzzle') {
    // 立绘池：精英0 / 精英2 立绘 + 该干员每一套时装（PRTS 的「立绘 <名> skinN」）
    const cands = [
      { title: IMG.opArt(a.name, 2), label: '精英2 立绘' },
      { title: IMG.opArt(a.name, 1), label: '精英0 立绘' },
    ];
    (a.skins || []).forEach((sk, i) => cands.push({ title: IMG.opSkinArt(a.name, i + 1), label: sk.name || ('时装' + (i + 1)) }));
    const pick = cands[Math.floor(Math.random() * cands.length)];
    out.imageTitle = pick.title;
    out.imageLabel = pick.label;
    out.titles = [pick.title].concat(cands.map((c) => c.title));
  }
  return out;
}

function dleCell(col, g, a) {
  const dv = (o) => (col.key === 'profession' ? (o.professionCn || o.profession) : o[col.key]);
  const gv = dv(g), av = dv(a);
  if (col.multi) {
    const gset = String(gv || '').split(/[、,，\s]+/).filter(Boolean);
    const aset = String(av || '').split(/[、,，\s]+/).filter(Boolean);
    const hit = gset.filter((x) => aset.includes(x));
    return {
      key: col.key, label: col.label, v: gset.join(' ') || '—',
      tokens: gset, hit, state: hit.length === 0 ? 'no' : (hit.length === gset.length && gset.length === aset.length ? 'eq' : 'part'),
    };
  }
  if (col.date) {
    const same = gv === av;
    const sameMonth = !same && String(gv).split('月')[0] === String(av).split('月')[0];
    return { key: col.key, label: col.label, v: gv || '—', state: same ? 'eq' : (sameMonth ? 'part' : 'no') };
  }
  if (col.num || col.ord) {
    const gn = col.ord ? (ADAPT_ORDER[String(gv)] != null ? ADAPT_ORDER[String(gv)] : -1) : Number(gv) || 0;
    const an = col.ord ? (ADAPT_ORDER[String(av)] != null ? ADAPT_ORDER[String(av)] : -1) : Number(av) || 0;
    return {
      key: col.key, label: col.label,
      v: col.ord ? String(gv) : (col.unit === 'cm' ? String(gv) + 'cm' : (col.unit === 's' ? String(gv) + 's' : String(gv))),
      num: true,
      state: gn === an ? 'eq' : 'no',
      arrow: gn === an ? null : (gn > an ? '↓' : '↑'),
    };
  }
  const same = String(gv || '') === String(av || '');
  return { key: col.key, label: col.label, v: gv || '—', state: same ? 'eq' : 'no' };
}

/** 棋盘载荷：表格模式（大头/兔头）与拼图模式（小头）共用 */
function dlePage(opts) {
  const o = opts || {};
  const mode = DLE_MODES[o.mode] ? o.mode : 'easy';
  const cfg = DLE_MODES[mode];
  const answer = o.answer ? dleAttrs(o.answer) : null;
  const guesses = (o.guesses || []).map((gid) => dleAttrs(gid)).filter(Boolean);
  const rows = guesses.map((g) => ({
    name: g.name, rarity: g.rarity, avatar: g.avatar,
    cells: (answer && cfg.cols.length) ? cfg.cols.map((c) => dleCell(c, g, answer)) : [],
    correct: !!answer && g.id === answer.id,
  }));
  const titles = [];
  let puzzle = null;
  if (mode === 'puzzle' && answer) {
    const step = Math.min(guesses.length, DLE_GRID.length - 1);
    const grid = DLE_GRID[step];
    puzzle = {
      imageTitle: o.imageTitle || IMG.opArt(answer.name, 2),
      imageLabel: o.imageLabel || '',
      grid,
      tried: guesses.length,
      maxGrid: DLE_GRID[DLE_GRID.length - 1],
      tries: guesses.map((g) => ({ name: g.name, ok: g.id === answer.id })),
      hint: grid >= DLE_GRID[DLE_GRID.length - 1]
        ? ('提示：' + answer.rarity + '★ · ' + answer.professionCn + ' · ' + (answer.branch || '—'))
        : '',
    };
    titles.push(puzzle.imageTitle);
  } else {
    rows.forEach((r) => titles.push(r.avatar));
  }
  if (o.done && answer) titles.push(answer.avatar);
  return {
    payload: {
      mode, modeName: cfg.name, modeDesc: cfg.desc,
      max: o.max || 8, used: rows.length,
      note: o.note || '',
      cols: cfg.cols.map((c) => ({ label: c.short || c.label, key: c.key })),
      rows, puzzle,
      done: !!o.done, win: !!o.win,
      answerRow: (o.done && answer && cfg.cols.length) ? {
        name: answer.name, rarity: answer.rarity, avatar: answer.avatar,
        cells: cfg.cols.map((c) => dleCell(c, answer, answer)),
      } : null,
      answerName: (o.done && answer) ? answer.name : '',
      answerLabel: (o.done && puzzle) ? puzzle.imageLabel : '',
      count: o.count != null ? o.count : null,
      pool: ark.operators().list.length,
    },
    titles,
  };
}

/** /arkdle 不带参数时固定只回这一张：模式选择 */
function dleMenu(count) {
  return {
    payload: {
      menu: true,
      modes: [
        { name: '大头', desc: '基础属性猜测', cols: '性别・星级・职业・国家・种族・源石技艺适应性・身高・感染状态・出生日期・标签' },
        { name: '兔头', desc: '数值属性猜测', cols: '星级・满级生命/攻击/防御/法抗・攻击间隔・上线年份・标签' },
        { name: '小头', desc: '像素化立绘猜测', cols: '立绘从 2×2 马赛克逐档细化到 16×16，最后一档给一次提示；立绘包含该干员的时装' },
      ],
      howto: [
        '开始：/arkdle 大头　/arkdle 兔头　/arkdle 小头',
        '猜：  /答 <干员名>（/猜、/回答 同义）',
        '放弃：/结束',
        '　共 8 次机会；绿色 = 完全一致，黄色 = 部分一致，↑ 答案更高，↓ 答案更低',
      ],
      count: count != null ? count : null,
      pool: ark.operators().list.length,
    },
    titles: [],
  };
}


/** 相似度提示：干员原名 + 条件取值都匹配一遍（/ark查干员 找不到时用） */
function suggestAll(query) {
  const ops = ark.operators().list.map((x) => ({ name: x.name, names: [x.name, x.appellation].filter(Boolean), id: x.id }));
  const opSim = ark.similar(query, ops, 4, 0.33).map((x) => `${x.item.name} ${Math.round(x.score * 100)}%`);
  const { v } = vocab();
  const pool = [];
  for (const key of ['profession', 'branch', 'camp', 'birth', 'race', 'gender']) {
    for (const val of v[key]) pool.push({ name: val, key });
  }
  const valSim = ark.similar(query, pool, 4, 0.4).map((x) => `${x.item.name}（${FILTER_CN[x.item.key] || x.item.key}）`);
  return { ops: opSim, values: valSim };
}

module.exports = {
  opDetail, opList, gachaList, activityList, campaignList, dailyList, sssList, skinList,
  skinListOfOperator, skinByNumber,
  stageDetail, stageOverview,
  dleAttrs, dleStart, dleCell, dlePage, dleMenu, DLE_MODES, DLE_GRID,
  fillDesc, cleanText, ruleCn, describeFilters, gachaBannerCandidates, actKvCandidates, actLogoCandidates,
  parseFilters, vocab, suggestAll, skinsInShop,
};
