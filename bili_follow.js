// ==================== bili_follow.js - B站关注功能模块（多关注版） ====================
// 支持：每群关注多个UP（视频+动态 / 直播），/关注 /关注直播 /取关 /取关直播
const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');

const STATE_FILE = path.join(__dirname, 'data', 'bili_follow.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let sendToGroup = null;
let getCookie = () => '';

function init(deps) {
    if (deps.sendToGroup) sendToGroup = deps.sendToGroup;
    if (deps.getCookie) getCookie = deps.getCookie;
    console.log('📺 B站关注模块已初始化');
}

function loadState() {
    try { if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) {}
    return {};
}
function saveState(st) {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2)); } catch (e) { console.error('保存B站状态失败:', e.message); }
}

function biliGet(urlStr) {
    return new Promise((resolve) => {
        try {
            const url = new URL(urlStr);
            const req = https.get(url, { headers: { 'User-Agent': UA, 'Referer': 'https://space.bilibili.com/', 'Cookie': getCookie(), 'Accept': 'application/json' } }, res => {
                let data = ''; res.on('data', c => data += c);
                res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve(null); } });
            });
            req.on('error', () => resolve(null));
            req.setTimeout(15000, () => { req.destroy(); resolve(null); });
        } catch (e) { resolve(null); }
    });
}

// UP账号信息（名字/头像/签名）
async function getUserInfo(uid) {
    const d = await biliGet(`https://api.bilibili.com/x/web-interface/card?mid=${uid}`);
    if (!d || d.code !== 0) return null;
    const card = (d.data && d.data.card) || {};
    return { name: card.name || '', face: card.face || '', sign: card.sign || '' };
}

// 最新动态（视频DYNAMIC_TYPE_AV + 图文DRAW等），返回最新一条
async function getLatestDynamic(uid) {
    const d = await biliGet(`https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?host_mid=${uid}&offset=&timezone_offset=-480`);
    if (!d || d.code !== 0) return null;
    const items = (d.data && d.data.items) || [];
    // 过滤置顶(is_top)，按 pub_ts 排序（新→旧）
    const list = items
        .filter(it => it && !(it.is_top === true))
        .sort((a, b) => ((b.modules||{}).module_author || {}).pub_ts - ((a.modules||{}).module_author || {}).pub_ts);
    let video = null, dyn = null;
    // 记录最近看到的动态 id（无论类型），用于判断"最新动态变化"
    let lastSeenId = null;
    for (const it of list) {
        const tp = it.type;
        const mod = (it.modules || {}).module_dynamic || {};
        // 找时间最新的视频（DYNAMIC_TYPE_AV）
        if (tp === 'DYNAMIC_TYPE_AV') {
            const arch = (mod.major || {}).archive || {};
            if (arch.bvid && !video) video = { bvid: arch.bvid, title: arch.title || '', url: `https://www.bilibili.com/video/${arch.bvid}` };
        }
        // 找时间最新的动态 id（只取非视频类型，避免视频被当"新动态"重复推送）
        if (it.id_str) {
            if (!lastSeenId) lastSeenId = it.id_str;
            if (!dyn && tp !== 'DYNAMIC_TYPE_AV') {
                let dt = (mod.desc || {}).text || '';
                let ptts = (((it.modules||{}).module_author || {}).pub_ts) || 0;
                dyn = { id: it.id_str, kind: (tp === 'DYNAMIC_TYPE_DRAW' ? 'draw' : 'other'), title: dt.slice(0, 40), kindType: tp, pub_ts: ptts };
            }
        }
        if (video && (dyn || lastSeenId)) break;
    }
    return { video: video, dyn: dyn, lastId: lastSeenId };
}

async function getLiveStatus(uid) {
    const d = await biliGet(`https://api.live.bilibili.com/room/v1/Room/getRoomInfoOld?mid=${uid}`);
    if (!d || d.code !== 0) return null;
    const dd = d.data || {};
    // 用 getInfoByRoom 补主播名（开播时展示用）
    let aname = '', cover = (dd.cover || '').replace('http://', 'https://'), title = dd.title || '', online = dd.online || 0, url = dd.url || '';
    if (dd.roomid) {
        const d2 = await biliGet(`https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByRoom?room_id=${dd.roomid}`);
        if (d2 && d2.code === 0) {
            const ai = (d2.data || {}).anchor_info || {};
            const base = ai.base_info || {};
            const room = (d2.data || {}).room_info || {};
            if (base.uname) aname = base.uname;
            if (room.cover) cover = room.cover.replace('http://', 'https://');
            if (room.title) title = room.title;
            if (room.online !== undefined) online = room.online;
        }
    }
    return { liveStatus: dd.liveStatus || 0, url, title, cover, online, roomid: dd.roomid || '', aname };
}

// ==================== 指令处理 ====================
async function handleCommand(groupId, plain) {
    // /取关直播 <uid>, /取关 <uid>
    const mUnsubLive = plain.match(/^\s*\/取关直播\s*(\d+)\s*$/);
    const mUnsub = plain.match(/^\s*\/取关\s*(\d+)\s*$/);
    // /关注直播 <uid>, /关注 <uid>
    const mFollowLive = plain.match(/^\s*\/关注直播\s*(\d+)\s*$/);
    const mFollow = plain.match(/^\s*\/关注\s*(\d+)\s*$/);

    let st = loadState();
    if (!Array.isArray(st[groupId])) st[groupId] = [];

    // === 取关 ===
    if (mUnsubLive) {
        const uid = mUnsubLive[1];
        const before = st[groupId].length;
        st[groupId] = st[groupId].filter(r => !(String(r.uid) === uid && r.type === 'live'));
        if (st[groupId].length !== before) { saveState(st); return { text: `已取关UID${uid}的直播` }; }
        return { text: `未关注UID${uid}的直播` };
    }
    if (mUnsub) {
        const uid = mUnsub[1];
        const before = st[groupId].length;
        st[groupId] = st[groupId].filter(r => !(String(r.uid) === uid && (r.type === 'video' || r.type === 'dynamic')));
        if (st[groupId].length !== before) { saveState(st); return { text: `已取关UID${uid}的视频/动态` }; }
        return { text: `未关注UID${uid}的视频/动态` };
    }

    // === 关注 ===
    let uid = null, type = null;
    if (mFollowLive) { uid = mFollowLive[1]; type = 'live'; }
    else if (mFollow) { uid = mFollow[1]; type = 'video'; }
    if (!uid) return null;

    // 验证UID
    const uinfo = await getUserInfo(uid);
    if (!uinfo) return { text: `关注失败，错误码：接口不可用或无此UP` };
    const name = uinfo.name || ('UID' + uid);
    const bio = (uinfo.sign && uinfo.sign.trim()) ? '签名：' + uinfo.sign : '';
    const face = (uinfo.face && uinfo.face.trim()) ? `[CQ:image,file=${uinfo.face}]` : '';

    // 已关注同类（重复关注也显示基本信息）
    if (st[groupId].some(r => String(r.uid) === uid && (type === 'live' ? r.type === 'live' : (r.type === 'video' || r.type === 'dynamic')))) {
        return { text: `${face}已成功关注UID${uid}\nUP：${name}（UID ${uid}）${bio ? '\n' + bio : ''}\n（已关注：${type === 'live' ? '直播' : '视频+动态'}）` };
    }

    const now = Date.now();
    if (type === 'live') {
        st[groupId].push({ uid, type: 'live', last_live: 0, updated: now });
        saveState(st);
        return { text: `${face}已成功关注UID${uid}（直播）\nUP：${name}（UID ${uid}）${bio ? '\n' + bio : ''}` };
    }
    // video/dynamic 合并关注：记录视频+动态
    st[groupId].push({ uid, type: 'video', last_bvid: null, last_dyn_id: null, updated: now });
    saveState(st);
    return { text: `${face}已成功关注UID${uid}（视频+动态）\nUP：${name}（UID ${uid}）${bio ? '\n' + bio : ''}` };
}

// ==================== 轮询 ====================
let timer = null;
function startPolling(intervalMs) {
    if (timer) clearInterval(timer);
    timer = setInterval(() => { checkAll().catch(e => console.error('B站轮询错误:', e.message)); }, intervalMs || 60000);
    setTimeout(() => checkAll().catch(e => console.error('B站轮询错误:', e.message)), 5000);
    console.log('📺 B站轮询已启动，间隔 ' + ((intervalMs || 60000) / 1000) + ' 秒');
}

async function checkAll() {
    const st = loadState();
    const cookie = getCookie();
    if (!cookie) return;
    for (const gid of Object.keys(st)) {
        if (!Array.isArray(st[gid])) continue;
        for (const rec of st[gid]) {
            try {
                // 视频+动态检测
                if (rec.type === 'video' || rec.type === 'dynamic') {
                    const res = await getLatestDynamic(rec.uid);
                    if (res) {
                        // 视频检测（新 bvid）
                        if (res.video) {
                            if (rec.last_bvid && rec.last_bvid !== res.video.bvid) {
                                const vd = await getVideoDetail(res.video.bvid);
                                if (vd) {
                                    const pubT = formatTs(vd.pubdate);
                                    const cover = vd.pic ? `[CQ:image,file=${vd.pic.replace('http://','https://')}]` : '';
                                    // 统一格式：UP发布了新视频，快去看哦！ + 空行 + 标题/封面/发布人/发布时间/BV/简介/url（无emoji无前缀）
                                    const msg = [
                                        'UP发布了新视频，快去看哦！', '',
                                        vd.title || '',
                                        cover || '',
                                        vd.name || '',
                                        pubT || '',
                                        vd.bvid || '',
                                        vd.desc ? vd.desc.slice(0, 50) : '',
                                        res.video.url || ''
                                    ].join('\n');
                                    sendToGroup(gid, msg);
                                }
                            }
                            rec.last_bvid = res.video.bvid;
                        }
                        // 动态检测：仅当最新的非视频动态 id 变化时推送（图文动态只发链接+日期）
                        if (res.dyn && res.dyn.id && rec.last_dyn_id && rec.last_dyn_id !== res.dyn.id) {
                            const dy = res.dyn;
                            const dtxt = formatTs(dy.pub_ts);
                            // 图文动态：只发链接 + 日期（不带图片/标题）
                            let m = 'UP发布了新动态，快去看哦！\n\n';
                            if (dtxt) m += dtxt + '\n\n';
                            m += 'https://t.bilibili.com/' + dy.id;
                            sendToGroup(gid, m);
                        }
                        // 用最新动态 id 更新 last_dyn_id（视频也用其 id 记录，避免重复）
                        if (res.lastId) rec.last_dyn_id = res.lastId;
                    }
                }
                // 直播检测
                const lv = await getLiveStatus(rec.uid);
                if (lv) {
                    if (lv.liveStatus === 1 && rec.last_live !== 1) {
                        const cover = lv.cover ? `[CQ:image,file=${lv.cover}]` : '';
                        const m = `UP开播啦，快去看哦！\n\n${lv.title || ''}\n${cover}\n${lv.aname || ''}\n人气值：${lv.online}\n${lv.url || ''}`;
                        sendToGroup(gid, m);
                    } else if (lv.liveStatus === 0 && rec.last_live === 1) {
                        sendToGroup(gid, `UP已下播`);
                    }
                    rec.last_live = lv.liveStatus;
                }
            } catch (e) { console.error(`B站查询 ${gid}/${rec.uid} 失败:`, e.message); }
        }
    }
    saveState(st);
}

module.exports = { init, handleCommand, startPolling, checkAll };

// ==================== 视频详情（封面/UP/时间/简介/BV号）====================
// 按"封面图 → 发布人 → 发布时间 → 简介 → BV号"的顺序提取
async function getVideoDetail(bvid) {
    const d = await biliGet(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
    if (!d || d.code !== 0) return null;
    const v = d.data || {};
    const owner = v.owner || {};
    return {
        face: owner.face || '',      // UP头像
        name: owner.name || '',      // 发布人(UP名)
        pubdate: v.pubdate || 0,     // 发布时间(时间戳)
        desc: (v.desc || '').trim(), // 简介
        bvid: v.bvid || '',          // BV号
        pic: v.pic || '',            // 封面图
        title: v.title || '',        // 标题
        aid: v.aid || '',
    };
}


// 时间戳转可读时间
function formatTs(ts) {
    if (!ts) return "";
    const d = new Date(ts * 1000);
    const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
