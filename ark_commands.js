'use strict';
/**
 * 明日方舟指令（/ark*）
 *
 * 与 Our Notes 那套（/on*）分开成独立模块：数据源、渲染器、缓存目录都不同，
 * 只在注册方式上与 app.js 的 commands 数组一致（ignoreAt: true 表示不用 @ 也能触发）。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ark = require('./ark_data');
const pl = require('./ark_payload');
const IMG = ark.IMG;                     // 图片标题构造（IMG.opAvatar 等）

const ARK_DIR = require('./ark_fetch').ARK_DIR;
const CACHE_DIR = path.join(ARK_DIR, 'cache');
const RENDER_DIR = path.join(ARK_DIR, 'render');
const PY = process.env.ARK_PY || 'python3';
const TIMEOUT_MS = 180 * 1000;
const ADMIN = String(process.env.ON_ADMIN || '0');

const HELP_MAIN = [
  '明日方舟指令一览',
  '全部以 /ark 开头，不用 @；回复都是当场画的一张图。',
  '',
  '【查询】',
  '/ark查干员 <干员名>  干员详情图（属性・技能・天赋・综合体能・简介）',
  '/ark查干员 <条件…>  按条件筛干员，出缩略图列表',
  '　条件：稀有度 6星 / 职业 狙击 / 分支 速射手 / 阵营 企鹅物流 / 出生地 拉特兰 / 种族 萨科塔 / 性别 女',
  '　例 /ark查干员 能天使　/ark查干员 6星 狙击　/ark查干员 阵营:企鹅物流　/ark查干员 种族:萨科塔',
  '/ark关卡 <代号|关卡名>  关卡档案图：地图预览・战术示意图・敌人配置・逐波次路线',
  '/ark关卡 <活动|主线名>  该活动/主线的全部关卡一览（含 EX 关，背景用封面）',
  '　例 /ark关卡 JT8-3　/ark关卡 1-7　/ark关卡 空想花庭　/ark关卡 靶向药物',
  '',
  '【账号】',
  '/ark绑定 <UID>  绑定自己的游戏号：按提示把游戏「签名」改成 3 位验证码，之后机器人每分钟自动查、查到即绑定',
  '/ark绑定列表  看自己绑了哪些号（编号 u1 / u2 …，u1 是默认号）',
  '/ark个人信息 [uN]  公开名片图，默认看 u1（每次都是现查，游戏里换了立刻就变）',
  '/ark解绑 uN  解绑某个号　/ark交换绑定 u1 u2  调换编号顺序',
  '',
  '【当期】',
  '/ark卡池  当前开放的限时寻访（标准 / 中坚 / 限定，含「进店」标记）',
  '/ark活动  当前开放的限时活动',
  '/ark剿灭  当前轮换的剿灭作战（含下期预告、模拟战档期与开放关卡）',
  '/ark副本  资源副本：常规星期表 + 今天开放的副本（按副本列，含「全副本特别开放」）',
  '/ark保全  当前赛季的保全派驻（地图・各层关卡・危险等级）',
  '/ark皮肤商店  时装商店当前在售（剩余时间与游戏内同步）',
  '/ark查皮肤 <干员|编号>  干员的全部时装缩略图+编号；按编号直接给原图',
  '',
  '【小游戏】',
  '/arkdle  猜干员：随机一题，8 次机会（与 /on 的小游戏共用一个位置）',
  '　/arkdle 大头  基础属性：性别・星级・职业・国家・种族・源石技艺・身高・感染・生日・标签',
  '　/arkdle 兔头  数值属性：星级・满级生命/攻击/防御/法抗・攻击间隔・上线年份・标签',
  '　/arkdle 小头  像素化立绘：2×2 马赛克逐档细化到 16×16，末档给一次提示（含时装立绘）',
  '　/答 <干员名>  作答（/猜、/回答 同义）；绿=一致，黄=部分一致，↑答案更高，↓答案更低',

  '',
  '【其它】',
  '/arkhelp [指令]  这条帮助；带上指令名看单条用法',
  '/ark更新  管理员：刷新官方数据表与 PRTS 干员页',
  '',
  '数据：Kengxxiao/ArknightsGameData（官方数据表，每周自动更新）+ PRTS.wiki（干员补充字段与图片）',
].join('\n');

const HELP_DETAIL = {
  '查干员': ['/ark查干员（别名 /ark干员、/ark查询）',
    '用法  /ark查干员 <干员名> [精英0|精英2|皮肤N]　/ark查干员 <条件…>',
    '写干员名  发一张详情图：立绘、星级 / 职业 / 分支、阵营・出身地・种族・身高・生日、',
    '　精英 0/1/2 满级三维、技能（含专精三）、天赋、潜能、综合体能检测、干员简介。',
    '　后面可以挑立绘：精英0（不带后缀默认精英2）、精英2、皮肤N（N 写错会告诉你他有哪几套）。',
    '写条件  发缩略图列表，条件之间用空格分隔：',
    '　稀有度（6星 / 6）· 职业（狙击…）· 分支（速射手…）· 阵营（企鹅物流…）·',
    '　出生地（拉特兰…）· 种族（萨科塔…）· 性别（女…），也可以写成 键:值。',
    '　取值写错会给最接近的提示；条件都对但没人命中就写「没有符合条件的干员」。',
    '例  /ark查干员 能天使　/ark查干员 能天使 皮肤1　/ark查干员 6星 狙击　/ark查干员 阵营:企鹅物流'],
  '关卡': ['/ark关卡（别名 /ark地图、/ark作战）',
    '用法  /ark关卡 <关卡代号|关卡名>　/ark关卡 <活动|主线名>',
    '写关卡  关卡档案图：信息条、游戏内地图预览、战术示意图（格子 + 路线 + 图例）、敌人配置、',
    '　逐波次敌人与路径（P1…Pn）、掉落。',
    '写活动或主线名  全部关卡一览（普通 → EX → 剧情 → 教学），背景用活动封面并压一层斜向遮罩，',
    '　文字按背景亮度自动取黑或白。',
    '例  /ark关卡 JT8-3　/ark关卡 1-7　/ark关卡 空想花庭　/ark关卡 靶向药物'],
  '绑定': ['/ark绑定（别名 /arkbind）',
    '用法  /ark绑定 <UID>',
    '两步绑定（确认这个号是你的）：',
    '　① 发 /ark绑定 <UID>，机器人给你一个 3 位数字验证码；',
    '　② 改完不用再发指令：机器人 10 分钟内每分钟自己查一次签名，查到就直接绑定成功并提示（轮询期间不发消息）。',
    '　　（10 分钟还没查到，再发一次 /ark绑定 <UID> 会立刻再查一次并按同样的格式回复。）',
    '　签名里能看到验证码就算验证通过，绑定成功并拿到编号 u1；验证码 30 分钟内有效，绑完可以把签名改回去。',
    '一个人可以绑多个号，每个号都走同样的流程（编号 u1、u2、…，u1 是默认号）。',
    'UID 在游戏内「好友 → 添加好友」搜自己就能看到。'],
  '个人信息': ['/ark个人信息（别名 /ark我的信息、/ark名片）',
    '用法  /ark个人信息 [uN]（不写就是默认号 u1）',
    '发一张名片图 —— 就是游戏内「好友搜索」能看到的那份公开资料：',
    '　称号#编号・UID・等级・服务器・上次在线・好友上限，助理（看板干员，含时装）大立绘，',
    '　入职日・签名・时装保有数・家具保有数・雇佣干员进度（含总数），阵营收集（各阵营已获得干员数），',
    '　助战干员三人（精英化 / 等级 / 技能专精 / 潜能 / 模组 / 信赖）・模组统计。',
    '只看自己绑定的号：/ark个人信息 是 u1，/ark个人信息 u2 是第二个（编号看 /ark绑定列表）。',
    '每次都是现查，游戏里换了看板 / 签名 / 助战，这边发出来就是最新的，不用重新绑定。',
    '不显示生日（按你的要求去掉了）。',
    '例  /ark个人信息　/ark个人信息 u2'],
  '卡池': ['/ark卡池（别名 /ark寻访、/ark招募）',
    '用法  /ark卡池',
    '当前开放的限时寻访，一池一张卡：宣传图、起止时间、剩余时间、池子说明，以及概率提升干员 ——',
    '6★ / 5★ 分开列，进凭证交易所的那位标「进店」。',
    '※ 标准寻访 / 中坚寻访的 UP 与「进店」名单取自 PRTS 卡池一览（官方数据表里没有）。'],
  '活动': ['/ark活动（别名 /ark事件）',
    '用法  /ark活动',
    '当前开放的限时活动：宣传图、起止时间、剩余时间、奖励领取截止、作战关卡数量，并标注复刻。'],
  '剿灭': ['/ark剿灭（别名 /arkcampaign）',
    '用法  /ark剿灭',
    '当前轮换的剿灭作战（地图预览、起止、剩余时间、推荐等级），以及下期轮换与常驻剿灭列表。'],
  '副本': ['/ark副本（别名 /ark资源、/ark日常）',
    '用法  /ark副本',
    '资源收集副本的星期开放表（哪个副本哪几天开）+ 今天开放的关卡与理智消耗。',
    '若官方开了「全副本特别开放」，图上会打横幅并把九个副本全标成开放。'],
  '保全': ['/ark保全（别名 /ark派驻、/arksss）',
    '用法  /ark保全',
    '当前赛季的保全派驻：赛季名与起止、两块地图各自的组织与各层关卡、危险等级效果，以及下期赛季。'],
  '皮肤': ['/ark查皮肤（别名 /ark皮肤、/ark时装）',
    '用法  /ark查皮肤 <干员名>　/ark查皮肤 <编号>',
    '按干员查：这个干员的全部时装缩略图 + 官方编号 + 系列 + 上线日期；',
    '按编号查：直接给那张时装的立绘原图（顺带一句「已展示 干员 皮肤名」）。',
    '　编号就是游戏时装表里的官方序号（目前 2 ～ 522），图里每张缩略图左上角标着。',
    '时装商店在售列表看 /ark皮肤商店。',
    '例  /ark查皮肤 能天使　/ark查皮肤 裁度　/ark查皮肤 475'],
  '皮肤商店': ['/ark皮肤商店（别名 /ark时装商店）',
    '用法  /ark皮肤商店',
    '时装商店当前在售的时装（不是按上架时间猜的）：半身像、时装名、所属干员、系列、剩余时间，',
    '剩余时间与游戏内一致。查某个干员的全部时装用 /ark查皮肤 <干员名>。'],
  '猜干员': ['/arkdle（猜干员 / Wordle 式）',
    '用法  /arkdle（出模式选择图）　/arkdle 大头|兔头|小头（开局）　/答 <干员名>（作答）　/结束',
    '随机一题（题库：所有干员），8 次机会，一局 5 分钟；和其它小游戏一样一次只能开一局：',
    '　绿色 = 完全一致；黄色 = 部分一致（标签命中 / 同月生日）；↑ 答案更高；↓ 答案更低',
    '【大头】基础属性：性别・星级・职业・国家・种族・源石技艺适应性・身高・感染状态・出生日期・标签',
    '【兔头】数值属性：星级・满级生命/攻击/防御/法抗・攻击间隔・上线年份・标签（精英2 满级，不含潜能与信赖）',
    '【小头】像素化立绘：马赛克从 2×2 逐档细化到 16×16，到 16×16 时给一次提示；立绘包含该干员的时装',
    '获胜按 QQ 记一次成绩，会告诉你「你猜出来了 N 次」。',
    '例  /arkdle　/arkdle 兔头　/答 阿米娅　/arkdle 小头　/结束'],
  '帮助': ['/arkhelp（别名 /ark帮助、/ark?）',
    '用法  /arkhelp [指令]',
    '不带参数发总览；带上指令名（如 /arkhelp 关卡）发那一条的详细用法。',
    '例  /arkhelp　/arkhelp 查干员　/arkhelp 猜干员'],
  '更新': ['/ark更新（别名 /arkupdate）—— 仅管理员',
    '用法  /ark更新　/ark更新 干员页',
    '不带参数：重新拉官方数据表（干员 / 关卡 / 活动 / 卡池 / 剿灭 / 保全 / 皮肤 / 道具）。',
    '带「干员页」：重新同步 PRTS 干员页的软字段（分支 / 阵营 / 出身地 / 种族 / 画师 / 声优等）。',
    '平时不用管：每周一 05:30 会自动刷新一次。'],
};

function runPy(args, outPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(PY, args, { cwd: RENDER_DIR });
    let log = '', done = false;
    const timer = setTimeout(() => {
      if (!done) { try { child.kill('SIGKILL'); } catch (e) {} reject(new Error('渲染超时')); }
    }, TIMEOUT_MS);
    child.stdout.on('data', (d) => { log += d.toString(); });
    child.stderr.on('data', (d) => { log += d.toString(); });
    child.on('error', (e) => { done = true; clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      done = true; clearTimeout(timer);
      if (code === 0 && fs.existsSync(outPath)) resolve(outPath);
      else reject(new Error((log || '').trim().split('\n').slice(-3).join(' ') || ('退出码 ' + code)));
    });
  });
}

function register({ commands, sendReply, imageCqFromPath, CONFIG }) {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (e) {}
  const target = (msg) => (msg.message_type === 'private'
    ? { action: 'send_private_msg', base: { user_id: msg.sender.user_id } }
    : { action: 'send_group_msg', base: { group_id: msg.group_id } });
  const replyText = (ws, msg, text) => {
    const t = target(msg);
    sendReply(ws, t.action, Object.assign({}, t.base, { message: text }));
  };
  const replyImage = (ws, msg, file) => {
    const t = target(msg);
    sendReply(ws, t.action, Object.assign({}, t.base, { message: imageCqFromPath(file) }));
  };
  /** 文字 + 图放进同一条消息（用户明确要求别拆成两条） */
  const sendSegs = (ws, msg, segs) => {
    const t = target(msg);
    sendReply(ws, t.action, Object.assign({}, t.base, { message: segs }));
  };
  const errText = (e) => String((e && e.message) || e).slice(0, 160);
  // 缓存 tag 用 md5 短哈希：中文名转 hex 再截断会撞（「皮肤」和「皮肤商店」前 12 个 hex 完全相同）
  const tagHash = (s2, n) => require('crypto').createHash('md5').update(String(s2)).digest('hex').slice(0, n || 10);
  const isAdmin = (msg) => String((msg.sender && msg.sender.user_id) || '') === ADMIN;

  /** 文字也画成图（找不到、帮助等一律出图）：title + lines + 相似度候选 */
  async function replyCard(ws, msg, card, tag) {
    try {
      const t = tag || ('card_' + tagHash(card.title || '', 12));
      const inJson = path.join(CACHE_DIR, t + '.json');
      const out = path.join(CACHE_DIR, t + '.png');
      fs.writeFileSync(inJson, JSON.stringify(card));
      const file = await runPy(['textcard.py', '--in', inJson, '--out', out], out);
      return replyImage(ws, msg, file);
    } catch (e) {
      // 画不出来时退化成文字，总比不说话强
      const body = [card.title, card.subtitle].filter(Boolean).concat(card.lines || []).join('\n');
      return replyText(ws, msg, body + ((card.suggestions || []).length ? '\n你要找的是不是：' + card.suggestions.join('，') : ''));
    }
  }
  function helpCard(arg) {
    const q = String(arg || '').trim();
    if (!q) {
      const lines = HELP_MAIN.split('\n');
      return { title: lines[0] || '明日方舟指令', subtitle: (lines[1] || '').trim(), lines: lines.slice(2) };
    }
    const key = q.replace(/^\/?ark/i, '');
    let hit = HELP_DETAIL[key];
    if (!hit) for (const k of Object.keys(HELP_DETAIL)) if (k.includes(key) || key.includes(k)) { hit = HELP_DETAIL[k]; break; }
    if (!hit) {
      return {
        title: '没有这条指令', subtitle: q,
        lines: ['可以查：' + Object.keys(HELP_DETAIL).join('、')],
        suggestions: Object.keys(HELP_DETAIL).slice(0, 6),
      };
    }
    return { title: hit[0], subtitle: '详细用法', lines: hit.slice(1) };
  }

  /** 把载荷 + 图片写成磁盘文件、跑渲染脚本 */
  async function render(kind, built, tag, script) {
    const inJson = path.join(CACHE_DIR, tag + '.json');
    const imgJson = path.join(CACHE_DIR, tag + '.img.json');
    const out = path.join(CACHE_DIR, tag + '.png');
    const paths = await ark.fetchImages(built.titles || []);
    fs.writeFileSync(inJson, JSON.stringify(built.payload));
    fs.writeFileSync(imgJson, JSON.stringify(paths));
    const scriptName = script || 'lists.py';
    const args = [scriptName];
    if (scriptName === 'lists.py') args.push('--kind', kind);
    args.push('--in', inJson, '--out', out, '--images', imgJson);
    return runPy(args, out);
  }

  // ---------------------------------------------------------------- /ark查干员（含条件检索）
  //  写干员原名 → 干员详情图；写检索条件（6星 / 狙击 / 阵营:企鹅物流 …）→ 缩略图列表；
  //  都对不上 → 出「相似度提示」卡片，干员名与条件取值一起给。
  // 「名字 + 可选后缀」拆开：/ark查干员 能天使 精英0（精英2 / 皮肤N / 时装N 同理）
  function splitOpMod(raw) {
    let m = raw.match(/^(.*?)[\s　]*(?:皮肤|时装|skin)\s*(\d{1,2})$/i);
    if (m && m[1].trim()) return { name: m[1].trim(), skin: Number(m[2]), mod: 'skin' + Number(m[2]) };
    m = raw.match(/^(.*?)[\s　]*(?:精英|精)\s*([012])$/i) || raw.match(/^(.*?)[\s　]*[eE]([012])$/);
    if (m && m[1].trim()) {
      const e = Number(m[2]);
      // 游戏里没有单独的精英1立绘：精英1 沿用精英0 的立绘
      return { name: m[1].trim(), art: e === 2 ? 'e2' : 'e0', elite: e, mod: 'e' + e };
    }
    return { name: raw };
  }

  async function handleOp(ws, msg, arg) {
    const raw = String(arg || '').trim();
    if (!raw) return replyCard(ws, msg, helpCard('查干员'));
    const mod = splitOpMod(raw);
    const name = mod.name;
    // 1) 干员原名/外文名精确命中
    const built = pl.opDetail(name, { art: mod.art, skin: mod.skin });
    if (!built.error) {
      // 皮肤序号先校验：写超了直接告诉有几套，而不是出一张没有立绘的图
      let artLabel = '';
      if (mod.skin) {
        const skins = built.payload.skins || [];
        const hit = skins.find((s, i) => Number(s.idx || i + 1) === mod.skin);
        if (!hit) {
          return replyCard(ws, msg, {
            title: `${built.payload.name} 没有皮肤${mod.skin}`,
            subtitle: '时装',
            lines: skins.length
              ? skins.map((s, i) => `皮肤${s.idx || i + 1}　${s.name}${s.group ? '　' + s.group : ''}`)
              : [`${built.payload.name} 目前没有时装。`],
            note: '用法：/ark查干员 <干员名> 皮肤N（N 用左边的编号）',
          }, 'noskin_' + built.payload.name + '_' + mod.skin);
        }
        artLabel = '时装「' + (hit.name || mod.skin) + '」';
      } else if (mod.elite != null) {
        artLabel = '精英' + mod.elite + ' 立绘';
      }
      try {
        const tag = 'op_' + built.payload.name.replace(/[^\w\u4e00-\u9fa5]/g, '') + (mod.mod ? '_' + mod.mod : '');
        const inJson = path.join(CACHE_DIR, tag + '.json');
        const out = path.join(CACHE_DIR, tag + '.png');
        const paths = await ark.fetchImages(built.titles);
        const payload = Object.assign({}, built.payload, {
          art: paths[built.artKey] || null,
          avatar: paths[built.avatarTitle || ark.IMG.opAvatar(built.payload.name)] || null,
          artLabel,
        });
        fs.writeFileSync(inJson, JSON.stringify(payload));
        const file = await runPy(['opdetail.py', '--in', inJson, '--out', out], out);
        return replyImage(ws, msg, file);
      } catch (e) {
        return replyText(ws, msg, '生成干员图失败：' + errText(e));
      }
    }
    // 2) 当条件用
    const parsed = pl.parseFilters(raw);
    const f = parsed.filters;
    const condKeys = Object.keys(f).filter((k) => (f[k] || []).length);
    if (condKeys.length) {
      const gridBuilt = pl.opList(f, { cap: 48 });
      if (parsed.unknown.length) gridBuilt.payload.condition = (gridBuilt.payload.condition || '全部干员')
        + '　（看不懂：' + parsed.unknown.join('、') + '）';
      try {
        const tag = 'search_' + tagHash(raw, 16);
        const file = await render(null, gridBuilt, tag, 'oplist.py');
        return replyImage(ws, msg, file);
      } catch (e) {
        return replyText(ws, msg, '生成检索图失败：' + errText(e));
      }
    }
    // 3) 都不像 → 干员原名 + 条件取值一起给相似度提示
    const sug = pl.suggestAll(raw);
    return replyCard(ws, msg, {
      title: `没有找到「${raw}」`, subtitle: '干员 / 条件',
      lines: [
        '写干员原名看详情；写条件（6星 / 狙击 / 阵营:企鹅物流 / 出身:拉特兰 / 种族:萨科塔）看缩略图列表。',
      ],
      suggestions: sug.ops.concat(sug.values),
      note: '例：/ark查干员 能天使　/ark查干员 6星 狙击　/ark查干员 阵营:企鹅物流',
    }, 'opmiss2_' + tagHash(raw, 12));
  }

  // ---------------------------------------------------------------- 列表类
  // ---------------------------------------------------------------- /ark查皮肤 / /ark皮肤商店
  /** 一个干员的全部时装（缩略图 + 官方编号） */
  async function handleSkinLookup(ws, msg, arg) {
    const raw = String(arg || '').trim();
    if (!raw) return replyCard(ws, msg, helpCard('皮肤'));
    // 纯数字 = 按官方编号看那一张的原图
    if (/^\d{1,4}$/.test(raw)) {
      const built = pl.skinByNumber(Number(raw));
      if (built.error) {
        return replyCard(ws, msg, {
          title: `没有编号 ${raw} 的时装`, subtitle: '时装编号',
          lines: [`官方编号目前最大到 ${built.max}。`, '编号可以先用 /ark查皮肤 <干员名> 查出来。'],
        }, 'skinnone_' + raw);
      }
      try {
        const paths = await ark.fetchImages(built.titles);
        const file = built.artTitle ? paths[built.artTitle] : null;
        if (!file) throw new Error('PRTS 上没有这张立绘');
        return sendSegs(ws, msg, [
          { type: 'text', data: { text: built.payload.caption } },
          { type: 'image', data: { file: imageCqFromPath(file) } },
        ]);
      } catch (e) {
        return replyText(ws, msg, `${built.payload.caption}（图没取到：${errText(e)}）`);
      }
    }
    const built = pl.skinListOfOperator(raw);
    if (built.error) {
      const lines = (built.similar || []).map((s) => `${s.name}　${Math.round((s.score || 0) * 100)}%`);
      return replyCard(ws, msg, {
        title: `没有叫「${raw}」的干员`, subtitle: '按干员查时装',
        lines: lines.length ? lines : ['试试完整的干员名。'],
        note: '用法：/ark查皮肤 <干员名>　/ark查皮肤 <编号>',
      }, 'skinsim_' + tagHash(raw, 10));
    }
    try {
      const tag = 'skinsop_' + slug(built.payload.opName);
      const file = await render('skinsop', built, tag, 'lists.py');
      return replyImage(ws, msg, file);
    } catch (e) {
      return replyText(ws, msg, '生成时装图失败：' + errText(e));
    }
  }

  const simpleList = (kind, build, tagPrefix) => async (ws, msg, arg) => {
    try {
      const built = await build(arg);   // 允许载荷构造是 async（剿灭要读关卡地图数据）
      const tag = tagPrefix + '_' + Math.floor(Date.now() / 60000);
      const file = await render(kind, built, tag);
      return replyImage(ws, msg, file);
    } catch (e) {
      return replyText(ws, msg, '生成图失败：' + errText(e));
    }
  };

  // ---------------------------------------------------------------- /ark关卡
  async function handleStage(ws, msg, arg) {
    const raw = String(arg || '').trim();
    if (!raw) return replyCard(ws, msg, helpCard('关卡'));
    try {
      // 先按「关卡」找；找不到再按「活动/主线」找
      const one = await pl.stageDetail(raw);
      if (!one.error) return replyImage(ws, msg, await render('stage', one, 'stage_' + slug(one.payload.stage.stageId), 'stage.py'));
      const over = await pl.stageOverview(raw);
      if (!over.error) return replyImage(ws, msg, await render('overview', over, 'overview_' + slug(over.payload.zoneId), 'stageoverview.py'));
      const sug = (one.similar || []).map((x) => `${x.item.name} ${Math.round(x.score * 100)}%`)
        .concat((over.similar || []).map((x) => `${x.item.name} ${Math.round(x.score * 100)}%`));
      const uniq = Array.from(new Set(sug)).slice(0, 6);
      return replyCard(ws, msg, {
        title: `没有找到「${raw}」`, subtitle: '关卡 / 活动',
        lines: ['可以写关卡代号（JT8-3）、关卡名（昂首，足践烈焰），或活动 / 主线名（空想花庭、靶向药物）。'],
        suggestions: uniq,
      }, 'stagemiss_' + tagHash(raw, 12));
    } catch (e) {
      return replyText(ws, msg, '生成关卡图失败：' + errText(e));
    }
  }
  function slug(s) { return String(s || '').replace(/[^\w\u4e00-\u9fa5-]/g, '').slice(0, 40); }

  async function handleUpdate(ws, msg, arg) {
    if (!isAdmin(msg)) return replyText(ws, msg, '这个指令只有管理员能用哦。');
    const t = String(arg || '').trim();
    const script = t.includes('干员页')
      ? ['tools/ark_prts.js', 'sync', '--force']
      : ['ark_fetch.js', 'table', 'character_table.json', 'stage_table.json', 'activity_table.json', 'campaign_table.json', 'climb_tower_table.json', 'skin_table.json', 'gacha_table.json', 'item_table.json', 'zone_table.json', 'enemy_handbook_table.json', 'skill_table.json'];
    try {
      const child = spawn('node', script, { cwd: '/home/admin/bot', detached: true, stdio: 'ignore' });
      child.unref();
      return replyText(ws, msg, t.includes('干员页') ? '开始同步 PRTS 干员页（后台跑，约 2 分钟）。' : '开始更新数据表（后台跑）。');
    } catch (e) {
      return replyText(ws, msg, '更新启动失败：' + errText(e));
    }
  }

  // ---------------------------------------------------------------- /ark绑定、/ark个人信息
  //  官服公开名片（游戏内「好友搜索」那份）：链路见 tools/ark_player.py
  //  grant → u8 getToken → gs account/login(secret) → social/searchPlayer（头 uid/secret/seqnum）
  const PY_ARK = process.env.ARK_PY_BRIDGE || '/opt/miniconda3/bin/python';
  const BRIDGE = path.join('/home/admin/bot', 'tools', 'ark_player.py');

  function runBridge(args, timeoutMs) {
    return new Promise((resolve, reject) => {
      const child = spawn(PY_ARK, [BRIDGE].concat(args), { cwd: '/home/admin/bot' });
      let out = '', err = '', done = false;
      const timer = setTimeout(() => {
        if (!done) { try { child.kill('SIGKILL'); } catch (e) {} reject(new Error('查询超时')); }
      }, timeoutMs || 90000);
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.stderr.on('data', (d) => { err += d.toString(); });
      child.on('error', (e) => { done = true; clearTimeout(timer); reject(e); });
      child.on('close', () => {
        done = true; clearTimeout(timer);
        const line = out.trim().split('\n').filter(Boolean).pop() || '';
        try { resolve(JSON.parse(line)); }
        catch (e) { reject(new Error((err || out || '没有输出').trim().slice(0, 200))); }
      });
    });
  }


  /** 皮肤名（皮肤 id → 时装名），拿不到就退回 id 里的那段 */
  function skinName(skinId) {
    if (!skinId) return '';
    try {
      const sk = (ark.skinsTable().charSkins || {})[skinId];
      const nm = sk && sk.displaySkin && sk.displaySkin.skinName;
      if (nm) return nm;
    } catch (e) {}
    const part = String(skinId).split('@')[1];
    return part ? part.split('#')[0] : '';
  }

  /** 助理立绘：皮肤 id → PRTS 立绘标题；没有皮肤就用精英立绘（#1=精英0，#2=精英2） */
  function secretaryArt(op, skinId, charId) {
    const id = String(skinId || '');
    const skinLabel = skinName(id);
    if (skinLabel) {
      // 时装的 PRTS 序号只在 PRTS 软字段里（ark.profile），operators() 的表数据没有 skins
      const prof = charId ? ark.profile(charId) : null;
      const hit = ((prof && prof.skins) || []).find((s) => s.name === skinLabel);
      if (hit && op) {
        return { title: IMG.opSkinArt(op.name, hit.idx), label: skinLabel, avatar: IMG.opAvatar(op.name, hit.idx) };
      }
      if (op) return { title: IMG.opArt(op.name, 2), label: skinLabel, avatar: IMG.opAvatar(op.name) };
    }
    const lvl = /#(\d)/.exec(id);
    const idx = lvl && Number(lvl[1]) === 2 ? 2 : 1;
    if (op) return { title: IMG.opArt(op.name, idx), label: '', avatar: IMG.opAvatar(op.name) };
    return { title: '', label: '', avatar: '' };
  }

  function buildPlayerPayload(p) {
    const ops = ark.operators().byId;
    const secOp = p.secretary ? ops[p.secretary] : null;
    const assist = (p.assist || []).map((a) => {
      const op = ops[a.char_id];
      const elite = { 0: '精英0', 1: '精英1', 2: '精英2' }[a.evolve_phase] || '';
      const bits = [];
      if (a.main_skill_lvl) bits.push('技能' + a.main_skill_lvl);
      if (a.specialize) bits.push('专精' + a.specialize);
      if (a.potential_rank != null) bits.push('潜' + a.potential_rank);
      if (a.equip_lvl) bits.push('模组' + a.equip_lvl);
      if (a.favor_point) bits.push('信赖' + a.favor_point);
      return {
        name: op ? op.name : a.char_id,
        rarity: op ? op.rarity : 0,
        avatar: op ? IMG.opAvatar(op.name) : '',
        skin: skinName(a.skin_id),
        elite, level: a.level ? 'Lv.' + a.level : '', skill: bits.join(' · '),
      };
    });
    const eq = p.equip_status || {};
    const rows = [
      ['服务器', p.server_name || '泰拉'],
      ['好友上限', p.friend_num_limit != null ? p.friend_num_limit + ' 人' : '-'],
      ['上次在线', p.last_online_text || '-'],
      ['模组', eq.unlock != null ? `解锁 ${eq.unlock} · 三级 ${eq.level3} · 六星 ${eq.chars}` : '-'],
    ].filter((r) => r[1] !== '-');
    // 阵营收集：key → 游戏自己的团队表（中文名 + 配色），只显示有数据的
    const tt = ark.teamTable();
    const teams = Object.keys(p.teams || {}).map((k) => {
      const t = tt[k] || {};
      return { key: k, name: t.powerName || k, color: t.color || '', order: t.orderNum || 999, count: p.teams[k] };
    }).filter((t) => t.count > 0).sort((a, b) => b.count - a.count || a.order - b.order);
    const secArt = secretaryArt(secOp, p.secretary_skin_id, p.secretary);
    return {
      nickname: p.nickname || '', nickNumber: p.nick_number || '', uid: p.uid || '',
      level: p.level, serverName: p.server_name || '泰拉',
      resume: p.resume || '', registerText: p.register_text || '',
      charCnt: p.char_cnt, charTotal: ark.operators().list.length, skinCnt: p.skin_cnt, furnCnt: p.furn_cnt,
      rich: !!p.rich_card, teams,
      mainStage: mainStageText(p.main_stage_progress),
      secretary: secOp ? secOp.name : (p.secretary || ''),
      secretaryEn: secOp ? (secOp.appellation || '') : '',
      secretarySkin: secArt.label,
      secArtTitle: secArt.title, secAvatarTitle: secArt.avatar,
      rows, assist,
      note: p.rich_card
        ? '数据来自游戏内公开名片（好友搜索能看到的那份，不含生日）。'
        : '这次只拿到基础资料（接口没返回入职日・签名・收集度），稍后再试一次通常就好了。',
    };
  }

  /** main_00-07 → 主线 0-7（只做展示用） */
  function mainStageText(s) {
    const m = /^([a-zA-Z_]+?)_?(\d+)-(\d+)$/.exec(String(s || ''));
    if (!m) return '';
    return `${Number(m[2])}-${Number(m[3])}`;
  }

  /** 渲染名片图（出文件，不发送）—— 本地调试也能直接调 */
  async function renderPlayerToFile(p, tagExtra) {
    const payload = buildPlayerPayload(p);
    const titles = payload.assist.map((a) => a.avatar).filter(Boolean);
    if (payload.secArtTitle) titles.push(payload.secArtTitle);
    if (payload.secAvatarTitle) titles.push(payload.secAvatarTitle);
    const paths = await ark.fetchImages(titles);
    // 助战缩略图：payload 里的 avatar 是 PRTS 的「图片标题」，这里换成真实文件路径再交给渲染脚本
    for (const a of payload.assist) a.avatarFile = (a.avatar && paths[a.avatar]) || null;
    if (payload.assist.length && payload.assist[0].avatar) payload.avatarPath = paths[payload.assist[0].avatar] || null;
    payload.secArt = (payload.secArtTitle && paths[payload.secArtTitle]) || null;
    payload.secAvatar = (payload.secAvatarTitle && paths[payload.secAvatarTitle]) || null;
    const tag = 'player_' + (p.uid || 'x') + (tagExtra || '');
    const inJson = path.join(CACHE_DIR, tag + '.json');
    const imgJson = path.join(CACHE_DIR, tag + '.img.json');
    const out = path.join(CACHE_DIR, tag + '.png');
    fs.writeFileSync(inJson, JSON.stringify(payload));
    fs.writeFileSync(imgJson, JSON.stringify(paths));
    const file = await runPy(['player.py', '--in', inJson, '--out', out], out);
    return { payload, paths, file };
  }

  /** 渲染名片图 */
  async function renderPlayer(ws, msg, p, tagExtra) {
    const r = await renderPlayerToFile(p, tagExtra);
    return replyImage(ws, msg, r.file);
  }

  /** 提示卡（查不到 / 出错时） */
  function playerMissCard(title, sub, lines, note) {
    return { title, subtitle: sub, lines, note };
  }

  async function queryPlayer(raw) {
    const isUid = /^\d{5,}$/.test(raw);
    const res = await runBridge(isUid ? ['uid', raw] : ['search', raw], 90000);
    return { isUid, res };
  }

  // ---------------------------------------------------------------- 绑定 / 个人信息
  //  绑定要两步：① /ark绑定 <UID> → 给一串随机码，让用户把游戏内「签名」改成它；
  //             ② 再发一次 /ark绑定 <UID> → 签名里能看到这串码才算绑定成功。
  //  一个人可以绑多个号（编号 u1 / u2 / …），每次绑定都走同样的流程；
  //  名片每次查询都是现查（不缓存结果），所以游戏里换了看板/签名，这边立刻就变。
  const BIND_CODE_TTL = 30 * 60 * 1000;

  function readBinds() {
    let raw = {};
    try { raw = JSON.parse(fs.readFileSync(path.join(ARK_DIR, 'binds.json'), 'utf8')); } catch (e) { return {}; }
    // 旧格式 {qq:{uid,nick,at}} → 新格式 {qq:{list:[{uid,nick,at}]}}，顺手升级
    const out = {};
    for (const k of Object.keys(raw || {})) {
      const v = raw[k];
      if (!v) continue;
      if (Array.isArray(v.list)) { out[k] = { list: v.list.filter((x) => x && x.uid) }; continue; }
      if (v.uid) out[k] = { list: [{ uid: String(v.uid), nick: v.nick || '', at: v.at || 0 }] };
    }
    return out;
  }
  function writeBinds(o) { try { fs.writeFileSync(path.join(ARK_DIR, 'binds.json'), JSON.stringify(o, null, 1)); } catch (e) {} }
  function myList(qq) {
    const b = readBinds();
    return (b[qq] && b[qq].list) || [];
  }
  function saveList(qq, list) {
    const b = readBinds();
    if (list && list.length) b[qq] = { list }; else delete b[qq];
    writeBinds(b);
  }
  /** u1 / U1 / 1 → 下标（0 起）；不写默认 u1 */
  function parseSlot(arg, len) {
    const m = /^[uU]?(\d{1,2})$/.exec(String(arg || '').trim());
    if (!m) return null;
    const n = Number(m[1]);
    if (!n || n > len) return null;
    return n - 1;
  }
  const PENDING_FILE = path.join(ARK_DIR, 'bind_pending.json');
  function readPending() { try { return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')); } catch (e) { return {}; } }
  function writePending(o) { try { fs.writeFileSync(PENDING_FILE, JSON.stringify(o, null, 1)); } catch (e) {} }
  /** 验证码：3 位数字（100~999），不要字母 */
  function newCode() {
    return String(100 + Math.floor(Math.random() * 900));
  }

  // ---------------- 绑定后的静默轮询 ----------------
  //  发完验证码后，后台每分钟查一次签名，10 分钟内查到就直接发成功提示；
  //  轮询本身**不发任何消息**（只在这一步抓到以后发那条成功提示）。
  //  10 分钟没抓到就静默收工，用户再发一次 /ark绑定 <UID> 会立刻抓一次并按现在的格式回复。
  const BIND_POLL_MS = Number(process.env.ARK_POLL_MS || 60 * 1000);   // 默认 1 分钟一次（可用环境变量缩短，方便测试）
  const BIND_POLL_MAX = Number(process.env.ARK_POLL_MAX || 10);        // 默认最多 10 次 = 10 分钟
  const bindPolls = new Map();
  const pollKey = (qq, uid) => qq + ':' + uid;
  function stopBindPoll(key) {
    const rec = bindPolls.get(key);
    if (rec && rec.timer) clearInterval(rec.timer);
    bindPolls.delete(key);
  }

  /** 把 pending 里的待验证号真正写进绑定列表，返回 { slot, text } */
  function completeBind(qq, p) {
    const pending = readPending();
    delete pending[qq];
    writePending(pending);
    const list = myList(qq);
    const nick = `${p.nickname}#${p.nick_number}`;
    const i = list.findIndex((x) => String(x.uid) === String(p.uid));
    if (i >= 0) list[i] = { uid: String(p.uid), nick, at: Date.now() };
    else list.push({ uid: String(p.uid), nick, at: Date.now() });
    saveList(qq, list);
    const slot = i >= 0 ? i + 1 : list.length;
    return {
      slot,
      text: `绑定成功：${nick} → u${slot}（签名已验证）。`
        + `\n共绑定 ${list.length} 个号：/ark绑定列表 看全部，/ark个人信息 [uN] 看名片（默认 u1），/ark解绑 uN 解绑。`,
    };
  }

  /** 往原来那个群/私聊发一条（轮询时用，连接断了就放弃） */
  function sendTo(ws, target, text) {
    try {
      if (!ws || (typeof ws.readyState === 'number' && ws.readyState !== 1)) return false;
      sendReply(ws, target.action, Object.assign({}, target.base, { message: text }));
      return true;
    } catch (e) {
      console.error('[ark] 绑定轮询发消息失败:', errText(e));
      return false;
    }
  }

  function startBindPoll(qq, uid, code, ws, target) {
    const key = pollKey(qq, uid);
    stopBindPoll(key);
    const rec = { n: 0, busy: false, timer: null };
    rec.timer = setInterval(async () => {
      if (rec.busy) return;
      rec.busy = true;
      rec.n += 1;
      try {
        if (rec.n > BIND_POLL_MAX) { stopBindPoll(key); return; }   // 10 分钟没抓到，静默收工
        const { res } = await queryPlayer(uid);
        const p = ((res && res.players) || [])[0];
        if (!p) { console.log(`[ark] 绑定轮询 ${rec.n}/${BIND_POLL_MAX}：查不到名片`); return; }
        const ok = String(p.resume || '').toUpperCase().indexOf(code) >= 0;
        console.log(`[ark] 绑定轮询 ${rec.n}/${BIND_POLL_MAX}：签名${ok ? '命中' : '还没改'}（${qq} → ${p.nickname}）`);
        if (ok) {
          stopBindPoll(key);
          const r = completeBind(qq, p);
          console.log(`[ark] 绑定轮询第 ${rec.n} 次抓到验证码 ${code}（${qq} → ${p.nickname}）`);
          sendTo(ws, target, r.text);
        }
      } catch (e) {
        // 轮询失败不吭声，下一分钟再试
      } finally {
        rec.busy = false;
      }
    }, BIND_POLL_MS);
    if (rec.timer.unref) rec.timer.unref();
    bindPolls.set(key, rec);
  }

  async function handleBind(ws, msg, arg) {
    const uid = String(arg || '').replace(/\D+/g, '');
    if (!uid) return replyCard(ws, msg, helpCard('绑定'));
    const qq = String((msg.sender && msg.sender.user_id) || '');
    const pending = readPending();
    const mine = pending[qq];
    const now = Date.now();
    const where = target(msg);
    try {
      const { res } = await queryPlayer(uid);
      const list = (res && res.players) || [];
      if (!res || !res.ok || !list.length) {
        return replyText(ws, msg, `查不到 UID ${uid} 的公开名片。UID 在游戏内「好友 → 添加好友」搜自己就能看到；号码写错、或该号没开名片都会查不到。`);
      }
      const p = list[0];
      const resume = String(p.resume || '');
      // 已经有待验证的码，且是同一个人 → 立刻抓一次（这就是「2 次发送触发一次抓取」）
      if (mine && String(mine.uid) === String(p.uid) && now - mine.at < BIND_CODE_TTL) {
        if (resume.toUpperCase().indexOf(mine.code) < 0) {
          startBindPoll(qq, uid, mine.code, ws, where);       // 手动再发一次也重新开始 10 分钟轮询
          return replyText(ws, msg, `还没看到验证码。请把游戏内「签名」改成 ${mine.code}（当前签名：${resume ? '「' + resume + '」' : '空的'}）。`
            + `\n改完不用再发指令，这边 10 分钟内每分钟会自己查一次，查到就直接绑定成功；超过 10 分钟还没查到的话再发一次 /ark绑定 ${uid}。`);
        }
        stopBindPoll(pollKey(qq, uid));
        return replyText(ws, msg, completeBind(qq, p).text);
      }
      // 没待验证 / 换了号 → 发一个新码，要求改签名，并开始静默轮询
      const code = newCode();
      pending[qq] = { uid: String(p.uid), code, at: now };
      writePending(pending);
      startBindPoll(qq, uid, code, ws, where);
      return replyText(ws, msg, `要绑定 ${p.nickname}#${p.nick_number}（Lv.${p.level}）需要先验证这个号是你的：`
        + `\n① 把游戏内「签名」改成：${code}`
        + `\n② 改完不用再发指令 —— 这边 10 分钟内每分钟会自己查一次，查到就直接绑定成功`
        + `\n（10 分钟还没查到的话，再发一次 /ark绑定 ${uid} 会立刻再查一次）`
        + `\n验证码 30 分钟内有效；绑定成功后可以把签名改回去。`);
    } catch (e) {
      return replyText(ws, msg, '绑定失败：' + errText(e));
    }
  }

  /** /ark绑定列表 */
  async function handleBindList(ws, msg) {
    const qq = String((msg.sender && msg.sender.user_id) || '');
    const list = myList(qq);
    if (!list.length) {
      return replyCard(ws, msg, playerMissCard('还没有绑定任何账号', '绑定', [
        '用法：/ark绑定 <UID>',
        '　第一次发会给你一个 3 位数字验证码，把游戏内「签名」改成它，机器人 10 分钟内每分钟会自己查一次，查到就绑定成功。',
        'UID 在游戏内「好友 → 添加好友」搜自己就能看到。',
      ]), 'bindlist_empty');
    }
    const lines = [];
    for (let i = 0; i < list.length; i++) {
      lines.push(`u${i + 1}　${list[i].nick || '（昵称待刷新）'}`);
    }
    lines.push('');
    lines.push('u1 是默认号：/ark个人信息 就是看它；看别的号发 /ark个人信息 u2。');
    lines.push('调整顺序 /ark交换绑定 u1 u2，删掉一个 /ark解绑 u2。');
    return replyCard(ws, msg, playerMissCard(`已绑定 ${list.length} 个账号`, '绑定列表', lines), 'bindlist');
  }

  /** /ark解绑 uN */
  async function handleUnbind(ws, msg, arg) {
    const qq = String((msg.sender && msg.sender.user_id) || '');
    const list = myList(qq);
    if (!list.length) return replyText(ws, msg, '你还没有绑定任何账号，先发 /ark绑定 <UID>。');
    const idx = parseSlot(arg, list.length);
    if (idx == null) {
      return replyText(ws, msg, `要解绑哪个？发 /ark解绑 u1 ～ u${list.length}（编号看 /ark绑定列表）。`);
    }
    const gone = list.splice(idx, 1)[0];
    saveList(qq, list);
    return replyText(ws, msg, `已解绑 u${idx + 1}：${gone.nick || gone.uid}。`
      + (list.length ? `\n现在还剩 ${list.length} 个，默认号是 u1（${list[0].nick || list[0].uid}）。` : '\n现在没有绑定任何账号了。'));
  }

  /** /ark交换绑定 u1 u2 */
  async function handleSwapBind(ws, msg, arg) {
    const qq = String((msg.sender && msg.sender.user_id) || '');
    const list = myList(qq);
    if (list.length < 2) return replyText(ws, msg, `至少绑两个号才能换顺序（现在 ${list.length} 个）。`);
    const parts = String(arg || '').trim().split(/[\s　,，]+/).filter(Boolean);
    if (parts.length !== 2) {
      return replyText(ws, msg, `用法：/ark交换绑定 u1 u2（编号看 /ark绑定列表，现在有 u1 ～ u${list.length}）。`);
    }
    const a = parseSlot(parts[0], list.length), b = parseSlot(parts[1], list.length);
    if (a == null || b == null || a === b) {
      return replyText(ws, msg, `编号要写 u1 ～ u${list.length}，而且得是两个不同的编号。`);
    }
    const t = list[a]; list[a] = list[b]; list[b] = t;
    saveList(qq, list);
    return replyText(ws, msg, `已交换 u${a + 1} ↔ u${b + 1}。\n现在默认号（u1）是 ${list[0].nick || list[0].uid}。`);
  }

  /** /ark个人信息 [uN] —— 只能看自己绑定的号，每次都是现查 */
  async function handleMe(ws, msg, arg) {
    const raw = String(arg || '').trim();
    const qq = String((msg.sender && msg.sender.user_id) || '');
    const list = myList(qq);
    if (!list.length) {
      return replyCard(ws, msg, playerMissCard('还没有绑定账号', '/ark个人信息', [
        '用法：/ark绑定 <UID>（第一次会给你一个 3 位数字验证码，改成游戏签名后机器人会自动查，查到就绑好）',
        '绑好之后 /ark个人信息 看默认号（u1），/ark个人信息 u2 看第二个号。',
        '一个人可以绑多个号：/ark绑定列表 看列表，/ark解绑 uN 解绑，/ark交换绑定 u1 u2 调顺序。',
      ]), 'mehint');
    }
    let idx = 0;
    if (raw) {
      const i = parseSlot(raw, list.length);
      if (i == null) {
        return replyText(ws, msg, `编号只到 u${list.length}。发 /ark个人信息 看默认号，或 /ark个人信息 u2 这样指定；编号看 /ark绑定列表。`);
      }
      idx = i;
    }
    const target = list[idx];
    try {
      const { res } = await queryPlayer(String(target.uid));
      const players = (res && res.players) || [];
      if (!res || !res.ok || !players.length) {
        return replyCard(ws, msg, playerMissCard(`u${idx + 1} 的名片暂时查不到`, '接口没返回', [
          `绑定的号：${target.nick || target.uid}`,
          res && res.error ? '接口返回：' + res.error : '',
          '稍后再试；如果一直不行，发 /ark绑定 <UID> 重新走一遍绑定流程。',
        ].filter(Boolean)), 'playermiss_' + tagHash(target.uid, 10));
      }
      const p = players[0];
      // 昵称/等级随时会变，这里顺手把列表里的记录刷新成最新的
      const nick = `${p.nickname}#${p.nick_number}`;
      if (target.nick !== nick) {
        list[idx] = Object.assign({}, target, { nick, at: Date.now() });
        saveList(qq, list);
      }
      return renderPlayer(ws, msg, p, list.length > 1 ? `_u${idx + 1}` : '');
    } catch (e) {
      const em = errText(e);
      if (/未登录|token|账号/i.test(em)) {
        return replyCard(ws, msg, playerMissCard('还没登录官服账号', '需要管理员先做一次短信登录', [
          '在服务器上执行：',
          '　/opt/miniconda3/bin/python tools/ark_player.py send <手机号>',
          '　/opt/miniconda3/bin/python tools/ark_player.py verify <手机号> <验证码>',
          '账号 token 存在 data/ark/hg_auth.json（0600），游戏会话密钥自动换新。',
        ]), 'gflogin');
      }
      return replyText(ws, msg, '查询失败：' + em);
    }
  }


  function helpFor(arg) {
    const q = String(arg || '').trim();
    if (!q) return HELP_MAIN;
    const key = q.replace(/^\/?ark/i, '');
    if (HELP_DETAIL[key]) return HELP_DETAIL[key].join('\n');
    for (const k of Object.keys(HELP_DETAIL)) if (k.includes(key) || key.includes(k)) return HELP_DETAIL[k].join('\n');
    return `没有「${q}」这条指令。可以查：${Object.keys(HELP_DETAIL).join('、')}\n直接发 /arkhelp 看全部。`;
  }

  // ---------------------------------------------------------------- 注册
  const defs = [
    { re: /^\s*\/ark(?:查干员|干员详情|查询|干员|op)\s*([\s\S]*)$/i, run: (ws, msg, m) => handleOp(ws, msg, m[1] || '') },
    { re: /^\s*\/ark(?:检索|筛选|列表|search)\s*([\s\S]*)$/i, run: (ws, msg, m) => handleOp(ws, msg, m[1] || '') },
    // 注意顺序：绑定列表 / 解绑 / 交换绑定 都要排在「绑定」前面，否则会被 绑定 的正则先吃掉参数
    { re: /^\s*\/ark(?:绑定列表|bindlist|账号列表)\s*([\s\S]*)$/i, run: (ws, msg) => handleBindList(ws, msg) },
    { re: /^\s*\/ark(?:解绑|unbind)\s*([\s\S]*)$/i, run: (ws, msg, m) => handleUnbind(ws, msg, m[1] || '') },
    { re: /^\s*\/ark(?:交换绑定|换绑顺序|swapbind)\s*([\s\S]*)$/i, run: (ws, msg, m) => handleSwapBind(ws, msg, m[1] || '') },
    { re: /^\s*\/ark(?:绑定|bind)\s*([\s\S]*)$/i, run: (ws, msg, m) => handleBind(ws, msg, m[1] || '') },
    { re: /^\s*\/ark(?:个人信息|我的信息|名片|me|info)\s*([\s\S]*)$/i, run: (ws, msg, m) => handleMe(ws, msg, m[1] || '') },
    { re: /^\s*\/ark(?:关卡|地图|作战|stage)\s*([\s\S]*)$/i, run: (ws, msg, m) => handleStage(ws, msg, m[1] || '') },
    { re: /^\s*\/ark(?:卡池|寻访|招募|gacha)\s*([\s\S]*)$/i, run: simpleList('gacha', () => pl.gachaList(), 'gacha') },
    { re: /^\s*\/ark(?:活动|事件|activity)\s*([\s\S]*)$/i, run: simpleList('activity', () => pl.activityList(), 'activity') },
    { re: /^\s*\/ark(?:剿灭|campaign)\s*([\s\S]*)$/i, run: simpleList('campaign', () => pl.campaignList(), 'campaign') },
    { re: /^\s*\/ark(?:副本|资源|日常|daily)\s*([\s\S]*)$/i, run: simpleList('daily', () => pl.dailyList(), 'daily') },
    { re: /^\s*\/ark(?:保全|派驻|sss)\s*([\s\S]*)$/i, run: simpleList('sss', () => pl.sssList(), 'sss') },
    { re: /^\s*\/ark(?:皮肤商店|时装商店|skinshop)\s*([\s\S]*)$/i, run: simpleList('skins', (arg) => pl.skinList(Number(String(arg || '').trim()) || 30), 'skins') },
    { re: /^\s*\/ark(?:查皮肤|皮肤|时装|skin)\s*([\s\S]*)$/i, run: (ws, msg, m) => handleSkinLookup(ws, msg, m[1] || '') },
    { re: /^\s*\/ark(?:更新|update)\s*([\s\S]*)$/i, run: (ws, msg, m) => handleUpdate(ws, msg, m[1] || '') },
    { re: /^\s*\/ark(?:help|帮助|说明|\?)\s*([\s\S]*)$/i, run: (ws, msg, m) => replyCard(ws, msg, helpCard(m[1] || ''), 'help_' + tagHash(m[1] || 'main', 12)) },
  ];
  for (const d of defs) {
    commands.push({
      ignoreAt: true,
      shortOnly: true,
      match(plainText) {
        const m = d.re.exec(plainText || '');
        return m ? { m } : false;
      },
      execute(ws, msg, params) { d.run(ws, msg, params.m); },
    });
  }
  console.log('明日方舟指令已注册: /ark查干员 /ark检索 /ark绑定 /ark个人信息 /ark关卡 /ark卡池 /ark活动 /ark剿灭 /ark副本 /ark保全 /ark皮肤 /arkhelp（/arkdle 由 on_commands 统一管）');
  return { helpFor, render, __test: { buildPlayerPayload, renderPlayerToFile, secretaryArt } };
}

module.exports = register;
module.exports.HELP_MAIN = HELP_MAIN;
module.exports.HELP_DETAIL = HELP_DETAIL;
