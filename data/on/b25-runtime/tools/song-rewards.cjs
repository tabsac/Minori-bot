'use strict';
const fs=require('fs'),path=require('path');
function summarize(progress,master,now=Date.now()){
 if(!progress||progress.version!==1||progress.known!==true||!Array.isArray(progress.records))throw Error('账号缺少奖励领取记录，请重新上传账号包。');
 const records=new Map(progress.records.map(r=>[Number(r._mLiveMusicId),r]));
 const charts=new Map(master.MasterLiveMusicScore.map(r=>[r._id,r]));
 const difficulties=['Easy','Normal','Hard','Expert'];
 const panels=difficulties.map(name=>({name,levels:[]}));const buckets=panels.map(()=>new Map());
 let scoreStars=0,unknown=0,songCount=0;const scoreByRank={};
 for(const song of master.MasterLiveMusic){
  const start=Date.parse(String(song._startAt||'').replace(/\//g,'-'));if(Number.isFinite(start)&&start>now)continue;
  songCount++;const row=records.get(song._id);
  const available=(field)=>!row?false:typeof row[field]==='boolean'?row[field]:null;
  for(const reward of master.MasterLiveMusicScoreReward.filter(r=>r._group===song._scoreRankRewardGroup)){
   const rank={3:'C',4:'B',5:'A',6:'S',7:'Ss'}[reward._liveScoreRank];if(!rank)continue;
   const state=available('_receivedScore'+rank+'Reward');if(state===null){unknown++;continue;}
   if(!state&&reward._resourceId===1){scoreStars+=reward._resourceCount;scoreByRank[rank]=(scoreByRank[rank]||0)+reward._resourceCount;}
  }
  difficulties.forEach((difficulty,index)=>{
   const chart=charts.get(song['_'+difficulty.toLowerCase()+'ID']);if(!chart)return;
   const level=Math.floor(Number(chart._musicScoreDisplayLevel??chart._musicScoreLevel));if(!Number.isFinite(level))return;
   for(const reward of master.MasterLiveMusicComboReward.filter(r=>r._group===song._comboRewardGroup&&r._difficulty===index)){
    const tier=['Quarter','Half','ThreeQuarter','Full'][reward._comboRateType];if(!tier)continue;
    const state=available('_received'+difficulty+tier+'ComboReward');if(state===null){unknown++;continue;}if(state)continue;
    const currency=reward._resourceId===1?'stars':reward._resourceId===3?'coins':null;if(!currency)continue;
    if(!buckets[index].has(level))buckets[index].set(level,{level,coins:0,stars:0});buckets[index].get(level)[currency]+=reward._resourceCount;
   }
  });
 }
 panels.forEach((panel,index)=>{let coins=0,stars=0;panel.levels=[...buckets[index].values()].sort((a,b)=>a.level-b.level).map(r=>({...r,totalCoins:coins+=r.coins,totalStars:stars+=r.stars}));panel.coins=coins;panel.stars=stars;});
 return {panels,scoreStars,scoreByRank,songCount,unknown,totalCoins:panels.reduce((s,p)=>s+p.coins,0),totalStars:scoreStars+panels.reduce((s,p)=>s+p.stars,0)};
}
module.exports={summarize};
