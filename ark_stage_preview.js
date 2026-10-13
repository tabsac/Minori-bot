'use strict';
const fs=require('fs'),path=require('path'),https=require('https');
const {ARK_DIR}=require('./ark_fetch');
const pending=new Map(),TTL=7*86400000;
function request(url){return new Promise((resolve,reject)=>{
 const req=https.get(url,{headers:{'User-Agent':'ournotes-bot/1.0'}},res=>{
  if(res.statusCode!==200){res.resume();return reject(Error('preview HTTP '+res.statusCode));}
  let size=0;const chunks=[];
  res.on('data',c=>{size+=c.length;if(size>15*1024*1024)req.destroy(Error('preview too large'));else chunks.push(c);});
  res.on('error',reject);res.on('end',()=>{const b=Buffer.concat(chunks);if(b.length<24||!b.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))return reject(Error('invalid preview'));resolve(b);});
 });const timer=setTimeout(()=>req.destroy(Error('preview timeout')),12000);req.on('close',()=>clearTimeout(timer));req.on('error',reject);
});}
async function stagePreview(levelId){
 const key=String(levelId||'').split('/').pop().replace(/^level_/,'');
 if(!/^[a-z0-9_-]+$/i.test(key))return null;
 const dir=path.join(ARK_DIR,'img','stage-preview'),file=path.join(dir,key+'.png');fs.mkdirSync(dir,{recursive:true});
 let old=false;try{const stat=fs.statSync(file);old=stat.size>24;if(old&&Date.now()-stat.mtimeMs<TTL)return file;}catch{}
 if(pending.has(key))return pending.get(key);
 const job=(async()=>{let tmp;try{const b=await request('https://torappu.prts.wiki/assets/map_preview/'+encodeURIComponent(key)+'.png');tmp=file+'.'+process.pid+'.'+Date.now()+'.part';fs.writeFileSync(tmp,b);fs.renameSync(tmp,file);return file;}catch{return old?file:null;}finally{if(tmp&&fs.existsSync(tmp))fs.unlinkSync(tmp);pending.delete(key);}})();pending.set(key,job);return job;
}
module.exports={stagePreview};
