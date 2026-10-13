'use strict';
const fs=require('fs'),fsp=fs.promises,path=require('path'),os=require('os');
const http=require('http'),https=require('https');
const {execFile}=require('child_process');
const LIMIT=12*1024*1024;
function decodeCQ(s){return s.replace(/&#44;/g,',').replace(/&#91;/g,'[').replace(/&#93;/g,']').replace(/&amp;/g,'&');}
async function readSource(src) {
 src=decodeCQ(String(src));
 if(src.startsWith('base64://')) {
  if(src.length>Math.ceil(LIMIT/3)*4+20)throw Error('图片文件过大，请使用 12 MB 以内的图片');
  return Buffer.from(src.slice(9),'base64');
 }
 if(src.startsWith('file:///')) {
  const p=src.slice(7);if((await fsp.stat(p)).size>LIMIT)throw Error('图片文件过大，请使用 12 MB 以内的图片');
  return fsp.readFile(p);
 }
 const original=new URL(src);
 if(!['http:','https:'].includes(original.protocol))throw Error('无法读取图片，请直接发送图片 后重试');
 return new Promise((resolve,reject)=>{
  let done=false,total=0,current;const chunks=[];
  const timer=setTimeout(()=>finish(Error('图片下载超时，请重试')),15000);
  function finish(err,value){if(done)return;done=true;clearTimeout(timer);if(current)current.destroy();err?reject(err):resolve(value);}
  function get(url,hop){
   current=(url.protocol==='https:'?https:http).get(url,{headers:{'User-Agent':'OurNotes/q-bounce'}},res=>{
    if(res.statusCode>=300&&res.statusCode<400&&res.headers.location){
     res.resume();if(hop>=3)return finish(Error('图片地址重定向过多'));
     const next=new URL(res.headers.location,url);if(!['http:','https:'].includes(next.protocol))return finish(Error('图片地址无效'));
     return get(next,hop+1);
    }
    if(res.statusCode!==200){res.resume();return finish(Error('图片下载失败，请重新发送图片'));}
    res.on('data',b=>{total+=b.length;if(total>LIMIT){res.destroy();finish(Error('图片文件过大，请使用 12 MB 以内的图片'));}else chunks.push(b);});
    res.on('end',()=>finish(null,Buffer.concat(chunks)));res.on('error',e=>finish(e));
   });current.on('error',e=>finish(e));
  }get(original,0);
 });
}
module.exports=function register({commands,sendReply,imageSrcOfMsgOrQuote,profilePath,rendererPath,jumpProfilePath,rulesPath,adminId,backendRules}) {
 let busy=false;
 const rules={'动图截断':'truncate','动图首帧':'first','动图完整':'complete','动图变速':'speed'};
 rulesPath=rulesPath||path.join(__dirname,'data','animation_group_rules.json');
 adminId=String(adminId||process.env.ON_ADMIN||'0');
 function groupId(msg){const id=String(msg.group_id||'');if(!/^\d+$/.test(id))throw Error('群聊信息无效');return id;}
 function loadRules(){
  if(!fs.existsSync(rulesPath))return {};
  const data=JSON.parse(fs.readFileSync(rulesPath,'utf8').replace(/^\uFEFF/,''));
  if(!data||Array.isArray(data)||typeof data!=='object'||Object.entries(data).some(([id,rule])=>!/^\d+$/.test(id)||!Object.hasOwn(rules,rule)))throw Error('群动画规则文件无效，请联系管理员');
  return data;
 }
 function ruleFor(msg){return msg.message_type==='group'?(loadRules()[groupId(msg)]||'动图首帧'):'动图首帧';}
 function saveRule(id,rule){
  const data=loadRules();data[id]=rule;
  fs.mkdirSync(path.dirname(rulesPath),{recursive:true});
  const tmp=rulesPath+'.'+process.pid+'.'+Date.now()+'.tmp';
  try{fs.writeFileSync(tmp,JSON.stringify(data,null,2)+'\n',{encoding:'utf8',mode:0o600,flag:'wx'});fs.renameSync(tmp,rulesPath);}
  finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
 }
 profilePath=profilePath||path.join(__dirname,'tools','q_bounce_scale.json');
 rendererPath=rendererPath||path.join(__dirname,'tools','q_bounce_render.py');
 commands.push({
  ignoreAt:true,
  match(plain){const m=/^\s*\/\s*(q弹|弹跳)\s*$/i.exec(plain||'');return m?(m[1]==='弹跳'?{command:m[1]}:{}):false;},
  async execute(ws,msg,params={}){
   const command=params.command||'q弹';const motion=command==='弹跳'?(jumpProfilePath||path.join(__dirname,'tools','jump_motion.json')):profilePath;
   const privateChat=msg.message_type==='private';
   const reply=message=>sendReply(ws,privateChat?'send_private_msg':'send_group_msg',privateChat?{user_id:msg.user_id||msg.sender.user_id,message}:{group_id:msg.group_id,message});
   if(busy){reply('图片正在处理中，请稍后再试');return;}
   busy=true;let dir;
   try{
    const mode=rules[ruleFor(msg)];
    const src=await imageSrcOfMsgOrQuote(msg);
    if(!src){reply('发送图片时附上 /'+command+'，或引用一张图片后发送 /'+command);return;}
    const bytes=await readSource(src);
    if(!fs.existsSync(motion))throw Error('动画预设尚未配置完成');
    dir=await fsp.mkdtemp(path.join(os.tmpdir(),'on-q-bounce-'));
    const input=path.join(dir,'input.png'),output=path.join(dir,'output.gif');
    await fsp.writeFile(input,bytes);
    await new Promise((resolve,reject)=>execFile('python3',[rendererPath,input,output,motion,mode],{timeout:25000,maxBuffer:4096},(e,stdout,stderr)=>{
     if(e)return reject(Error(e.killed?'生成超时，请使用更小的图片':(stderr.trim().split('\n').pop()||'GIF 生成失败，请重试')));resolve();
    }));
    const gif=await fsp.readFile(output);
    reply(`[CQ:image,file=base64://${gif.toString('base64')}]`);
   }catch(e){reply(e.message||'GIF 生成失败，请重试');}
   finally{if(dir)await fsp.rm(dir,{recursive:true,force:true}).catch(()=>{});busy=false;}
  }
 });
 commands.push({
  ignoreAt:true,shortOnly:true,
  match(plain){const m=/^\s*\/\s*修改规则(?:\s+(.+?))?\s*$/.exec(plain||'');return m?{rule:(m[1]||'').trim()}:false;},
  async execute(ws,msg,params={}){
   const reply=message=>sendReply(ws,msg.message_type==='private'?'send_private_msg':'send_group_msg',msg.message_type==='private'?{user_id:msg.user_id||msg.sender?.user_id,message}:{group_id:msg.group_id,message});
   if(msg.message_type!=='group'){reply('请在群聊中使用 /修改规则，规则只对当前群生效；私聊默认动图首帧。');return;}
   try{
    const current=ruleFor(msg),rule=(params.rule||'').toLowerCase();const interfaceRule=backendRules?.ruleNames.includes(rule);
    if(!rule){reply('本群当前规则：'+current+'\n/修改规则 动图截断：保留原动图，取目标动画一圈的时长\n/修改规则 动图首帧：只使用原动图第一帧（默认）\n/修改规则 动图完整：按两个周期的最小公倍数保留完整循环\n/修改规则 动图变速：将原动图完整周期变速到目标动作时长\n规则适用于本群 /q弹 和 /弹跳，群主、群管理员或 Bot 管理员可修改。'+(backendRules?'\n'+backendRules.describe(msg.group_id)+'\n接口规则：优先sakura、优先haruki、关闭sakura、关闭haruki、开启sakura、开启haruki；默认前缀：默认pjsk、默认on、默认bang、默认ark。显式前缀优先，/arkble 不支持 /ble 简写；只对本群生效。':'')+'');return;}
    if(!Object.hasOwn(rules,rule)&&!interfaceRule){reply('可选规则：动图截断、动图首帧、动图完整、动图变速。'+(backendRules?' 接口规则：'+backendRules.ruleNames.join('、')+'。':''));return;}
    if(!['owner','admin'].includes(msg.sender?.role)&&String(msg.user_id||msg.sender?.user_id)!==adminId){reply('仅群主、群管理员或 Bot 管理员可以修改本群规则。');return;}
    if(interfaceRule){backendRules.set(groupId(msg),rule);reply('本群接口规则已修改：'+backendRules.describe(msg.group_id));return;}saveRule(groupId(msg),rule);reply('本群动画规则已设为「'+rule+'」，对本群 /q弹 和 /弹跳 生效。');
   }catch(e){reply('修改规则失败：'+e.message);}
  }
 });
};
module.exports.readSource=readSource;
