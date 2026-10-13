'use strict';
const fs=require('fs'),path=require('path');
const DEFAULT={priority:'haruki',sakura:true,haruki:true};
const RULES=['优先sakura','优先haruki','关闭sakura','关闭haruki','开启sakura','开启haruki','默认pjsk','默认on','默认bang','默认ark'];
function family(name){return name==='haruki'?'haruki':String(name).startsWith('sakura')?'sakura':null;}
function special(plain){return /^\/(?:[a-z]{1,6})?(?:pjskb30|b39)(?=\s|$)/i.test(String(plain).trim().replace(/^(?:\/\s*)+/,'/'));}
module.exports=function create({filePath=path.join(__dirname,'data','bot_group_rules.json')}={}){
 function read(){if(!fs.existsSync(filePath))return {};const data=JSON.parse(fs.readFileSync(filePath,'utf8').replace(/^\uFEFF/,''));if(!data||Array.isArray(data)||typeof data!=='object')throw Error('接口群规则文件无效');for(const [id,v] of Object.entries(data)){if(!/^\d+$/.test(id)||!v||!['sakura','haruki'].includes(v.priority)||typeof v.sakura!=='boolean'||typeof v.haruki!=='boolean'||(v.defaultDomain!=null&&!['pjsk','on','bang','ark'].includes(v.defaultDomain)))throw Error('接口群规则文件无效');}return data;}
 function get(groupId){return groupId==null?{...DEFAULT}:{...DEFAULT,...read()[String(groupId)]};}
 function set(groupId,rule){const id=String(groupId);if(!/^\d+$/.test(id)||!RULES.includes(rule))throw Error('接口规则无效');const all=read(),v=get(id);if(rule.startsWith('优先'))v.priority=rule.slice(2);else if(rule.startsWith('默认'))v.defaultDomain=rule.slice(2);else v[rule.slice(2)]=rule.startsWith('开启');all[id]=v;fs.mkdirSync(path.dirname(filePath),{recursive:true});const tmp=filePath+'.'+process.pid+'.'+Date.now()+'.tmp';try{fs.writeFileSync(tmp,JSON.stringify(all,null,2)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(tmp,filePath);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}return v;}
 function resolve(groupId,plain){
 const text=String(plain||'').trim();if(!text.startsWith('/'))return {plain:text,domain:null};
 if(/^\/help\s*$/i.test(text))return {plain:text,domain:'global'};
 if(/^\/修改规则(?:\s|$)/.test(text))return {plain:text,domain:'global'};
 if(special(text))return {plain:text,domain:'pjsk'};
 const explicit=/^\/(pjsk|on|bang|ark)/i.exec(text);
 if(explicit)return {plain:text,domain:explicit[1].toLowerCase()};
 // 通用工具与管理指令保留独立入口；ble 不提供 ark 的简写。
 if(/^\/(?:q弹|弹跳|加速|减速|倒放|bilibili|关注|取关|新建相册|上传|看|删除图片|添加相册别名|删除相册别名|相册黑名单|取消相册黑名单|开启相册功能|关闭相册功能|ble)(?:\s|$)/i.test(text))return {plain:text,domain:'global'};
 const domain=get(groupId).defaultDomain;if(!domain)return {plain:text,domain:null};
 return {plain:'/'+domain+text.slice(1),domain};
 }
 function describe(groupId){const v=get(groupId);return '冲突优先：'+v.priority+'；sakura：'+(v.sakura?'开启':'关闭')+'；haruki：'+(v.haruki?'开启':'关闭')+'；默认前缀：'+(v.defaultDomain||'未设置');}
 function permit(name,msg,plain){if(msg?.post_type==='message'&&/^\s*\/\s*help\s*$/i.test(plain))return false;const f=family(name);if(!f||!msg?.post_type)return true;const groupId=msg.group_id??null,v=get(groupId);const domain=resolve(groupId,plain).domain;if(msg.post_type==='message'&&['on','ark','bang','global'].includes(domain))return false;if(domain==='pjsk'&&f==='sakura'&&name!=='sakura-pjsk')return false;if(!v[f])return false;if(msg.post_type==='message'&&special(plain)&&v.sakura)return name==='sakura-pjsk';if(msg.post_type==='message'&&/^\s*\/\s*修改规则(?:\s|$)/.test(plain))return false;return true;}
 function createReplyGate({waitMs=12000,ttlMs=120000}={}){
  const records=new Map();let sequence=0;
  function clean(){for(const [id,r] of records){if(Date.now()-r.created>ttlMs){if(r.timer)clearTimeout(r.timer);records.delete(id);}}while(records.size>1000){const [id,r]=records.entries().next().value;if(r.timer)clearTimeout(r.timer);records.delete(id);}}
  function record(msg,trigger){if(msg.post_type!=='message'||!['group','private'].includes(msg.message_type))return;clean();const key=msg.message_type==='group'?'g:'+msg.group_id:'p:'+msg.user_id,id=key+':'+(msg.message_id??('auto'+(++sequence)));if(records.has(id))return;records.set(id,{id,key,messageId:msg.message_id,groupId:msg.message_type==='group'?msg.group_id:null,trigger,plain:trigger?.plain||'',created:Date.now(),pending:[],winner:null,timer:null});}
  function find(action,params){const key=params?.group_id?'g:'+params.group_id:params?.user_id?'p:'+params.user_id:null;if(!key)return null;const message=params.message;let quote=null;if(Array.isArray(message))quote=message.find(s=>s?.type==='reply')?.data?.id;else if(typeof message==='string')quote=/\[CQ:reply,id=([^,\]]+)/.exec(message)?.[1];const candidates=[...records.values()].filter(r=>r.key===key&&Date.now()-r.created<ttlMs);return quote!=null?candidates.find(r=>String(r.messageId)===String(quote))||null:candidates[candidates.length-1]||null;}
  function expected(r,v){return special(r.plain)&&v.sakura?'sakura':v[v.priority]?v.priority:v.haruki?'haruki':v.sakura?'sakura':null;}
  function emit(r,f){r.winner=f;if(r.timer)clearTimeout(r.timer);r.timer=null;const pending=r.pending;r.pending=[];for(const p of pending)if(p.family===f&&get(r.groupId)[f])p.deliver(r.trigger);}
  function submit(name,action,params,deliver){const f=family(name);if(!f){deliver(null);return false;}clean();const groupId=params?.group_id??null,v=get(groupId);if(!v[f])return true;const r=find(action,params);if(!r){deliver(null);return false;}if(!/^\s*\//.test(r.plain)){deliver(r.trigger);return false;}const selected=expected(r,v);if(!selected)return true;if(special(r.plain)&&v.sakura&&name!=='sakura-pjsk')return true;if(r.winner){if(r.winner===f)deliver(r.trigger);return true;}r.pending.push({family:f,deliver});if(f===selected){emit(r,f);return true;}if(!r.timer){r.timer=setTimeout(()=>{try{const current=get(r.groupId),want=expected(r,current),available=r.pending.filter(p=>current[p.family]);const winner=available.find(p=>p.family===want)?.family||available[0]?.family;if(winner)emit(r,winner);else r.pending=[];}catch(e){r.pending=[];r.timer=null;console.error('接口群规则读取失败，未发送待处理回复');}},waitMs);r.timer.unref?.();}return true;}
  function close(){for(const r of records.values())if(r.timer)clearTimeout(r.timer);records.clear();}
  return{record,submit,close};
 }
 return{ruleNames:RULES,get,set,resolve,describe,permit,createReplyGate,special,family};
};
module.exports.special=special;module.exports.family=family;
