'use strict';
const TEXT=[
'全局帮助',
'',
'游戏指令入口',
'• PJSK / 世界计划：/pjskhelp；查询用 /pjsk<指令>。',
'  /pjskb30、/cnpjskb30、/b39 默认交给开启的 Sakura。',
'• Our Notes：/onhelp；单条说明 /onhelp <指令>。',
'  查卡、留影、查曲、谱面、表情、贴纸、个人信息、B25、打歌奖励及各类组卡。',
'• BanG Dream：/banghelp；例如 /bang查卡 灯、/bang查曲 迷星叫。',
'• 明日方舟：/arkhelp；关卡等功能用 /ark<指令>。/arkble 必须完整输入。',
'',
'图片 / 动图工具（附图或引用图片）',
'• /q弹、/弹跳',
'• /加速 [倍率]、/减速 [倍率]、/倒放',
'',
'其他功能',
'• /随机 [条件]、/cn随机 [条件]、/jp随机 [条件]：PJSK 随机选曲；设置其他默认前缀时用 /pjsk随机。',
'• /听歌 <歌曲>：PJSK 试听；也可用 /pjsk听歌 <歌曲>。',
'• /bilibili <链接或BV号>、/bilibili 听视频 <链接或BV号>',
'• /关注 <UID>、/取关 <UID>、/关注直播 <UID>、/取关直播 <UID>',
'• 相册：/相册列表、/新建相册 <名称>、/上传 <相册>（附图）、/看 <相册>、/看全部相册',
'• 相册管理：/删除图片、/添加相册别名、/删除相册别名、/相册黑名单、/取消相册黑名单、/开启相册功能、/关闭相册功能（按现有权限执行）',
'',
'群规则：/修改规则 查看当前设置；群主、群管理员或 Bot 管理员可修改。',
'• 默认pjsk / 默认on / 默认bang / 默认ark：无游戏前缀的指令按本群默认功能解析；显式前缀优先。',
'• 优先sakura / 优先haruki；开启sakura / 关闭sakura；开启haruki / 关闭haruki',
'• 动图首帧（默认）/ 动图截断 / 动图完整 / 动图变速：作用于 /q弹、/弹跳',
'',
'网页：https://on.tabsac.com/',
'/help 为本地全局帮助，不需要 @；具体接口的帮助内容由对应接口提供。'
].join('\n');
module.exports={text:TEXT,matches:plain=>/^\s*\/\s*help\s*$/i.test(plain||'')};

let imagePromise;
module.exports.image=function(){
 if(imagePromise)return imagePromise;
 imagePromise=Promise.resolve().then(async()=>{
  const path=require('path');const {createCanvas,GlobalFonts}=require(path.join(__dirname,'data/on/b25-runtime/node_modules/@napi-rs/canvas'));
  GlobalFonts.registerFromPath('/www/wwwroot/ournotes-web/static-data/b25-font.ttf','HelpFont');
  const width=1180,pad=45,size=25,step=40,probe=createCanvas(1,1).getContext('2d');probe.font=size+'px HelpFont';
  const lines=[];for(const source of TEXT.split('\n')){let line='';for(const char of source){if(probe.measureText(line+char).width>width-pad*2){lines.push(line);line='';}line+=char;}lines.push(line);}
  const canvas=createCanvas(width,pad*2+lines.length*step),ctx=canvas.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#111111';ctx.textBaseline='top';
  lines.forEach((line,i)=>{ctx.font=(i===0?'bold 34':'25')+'px HelpFont';ctx.fillText(line,pad,pad+i*step);});return canvas.encode('png');
 }).catch(e=>{imagePromise=null;throw e;});return imagePromise;
};
