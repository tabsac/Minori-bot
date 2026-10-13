const fs=require('fs'),path=require('path');const {summarize}=require('./song-rewards.cjs');
async function main(){
 const a=process.argv.slice(2),v=k=>a[a.indexOf(k)+1];const input=JSON.parse(fs.readFileSync(v('--in'))),root='/www/wwwroot/ournotes-web',master={};
 for(const name of ['MasterLiveMusic','MasterLiveMusicScore','MasterLiveMusicScoreReward','MasterLiveMusicComboReward'])master[name]=JSON.parse(fs.readFileSync(path.join('/home/admin/bot/data/on/master',name+'.json')))._allData;
 const stats=summarize(input.progress,master),{createCanvas,loadImage,GlobalFonts}=require('@napi-rs/canvas');GlobalFonts.registerFromPath(path.join(root,'static-data/b25-font.ttf'),'OurNotesB25');
 const panels=stats.panels.filter(p=>p.stars>0||['Hard','Expert'].includes(p.name));const width=1580,height=Math.max(830,470+Math.max(...panels.map(p=>p.levels.filter(r=>r.stars>0).length),0)*46),canvas=createCanvas(width,height),ctx=canvas.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,width,height);ctx.fillStyle='#7667de';ctx.fillRect(0,0,width,6);
 const text=(str,x,y,size=22,color='#33435f',align='left')=>{ctx.fillStyle=color;ctx.font=`${size}px OurNotesB25`;ctx.textAlign=align;ctx.fillText(String(str),x,y);ctx.textAlign='left';};
 const box=(x,y,w,h)=>{ctx.fillStyle='#ffffff';ctx.strokeStyle='#dce2ef';ctx.lineWidth=1;ctx.beginPath();ctx.roundRect(x,y,w,h,14);ctx.fill();ctx.stroke();};
 const line=(x,y,w,color='#e5e8ef')=>{ctx.strokeStyle=color;ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+w,y);ctx.stroke();};
 const star=await loadImage(path.join(root,'ui-images/star.webp')),coin=await loadImage(path.join(root,'ui-images/coin.webp'));
 const icon=(im,x,y,size=32)=>ctx.drawImage(im,x,y,size,size);
 box(25,25,870,140);const p=input.player||{};try{if(p.avatarCardId){const im=await loadImage(path.join(root,'avatar-images','avatar-'+Number(p.avatarCardId)+'.webp'));ctx.drawImage(im,40,40,108,108);}}catch{}
 text(p.name||input.name||'上传账号',170,66,30);text('UID '+String(input.accountId||p.profileId||'—')+'    Lv.'+(p.rank||'—'),170,105,22);text('账号包更新：'+String(input.updatedAt||'未知').replace('T',' ').slice(0,19),170,140,20,'#536581');
 text('打歌奖励 · 尚未领取',935,66,32);icon(star,935,85);text(stats.totalStars.toLocaleString()+' 星石',979,110,23);icon(coin,935,126);text(stats.totalCoins.toLocaleString()+' 金币',979,151,23);
 box(25,185,1530,76);icon(star,43,201,38);text('歌曲评级奖励：'+stats.scoreStars+' 星石',93,219,26);text(['C','B','A','S','Ss'].map(k=>(k==='Ss'?'SS':k)+' '+(stats.scoreByRank[k]||0)).join('    '),93,245,20);
 const mainWidth=1060,gap=18,panelWidth=(mainWidth-gap*(panels.length-1))/panels.length;
 panels.forEach((panel,i)=>{const x=25+i*(panelWidth+gap),color={Easy:'#309e6c',Normal:'#3676b3',Hard:'#c49727',Expert:'#d6424a'}[panel.name];box(x,280,panelWidth,height-350);ctx.fillStyle=color;ctx.fillRect(x+15,297,4,28);text(panel.name.toUpperCase(),x+29,321,28,color);icon(star,x+panelWidth-54,294,30);
 const col=[x+50,x+panelWidth*.58,x+panelWidth-26];text('等级',col[0],361,19,'#536581','center');text('星石',col[1],361,19,'#536581','right');text('累计',col[2],361,19,'#536581','right');line(x+15,373,panelWidth-30);
 const rows=panel.levels.filter(r=>r.stars>0);rows.forEach((row,j)=>{const y=412+j*46;text(row.level,col[0],y,22,color,'center');text(row.stars,col[1],y,22,'#33435f','right');text(row.totalStars,col[2],y,22,'#33435f','right');line(x+15,y+13,panelWidth-30);});if(!rows.length)text('没有未领取的星石奖励',x+25,417,21);
 });
 const sideX=1110,sideW=445;box(sideX,280,sideW,height-350);icon(coin,sideX+17,295,34);text('金币 · 按难度汇总',sideX+63,321,25);const col=[sideX+20,sideX+265,sideX+sideW-22];text('难度',col[0],361,19,'#536581');text('金币',col[1],361,19,'#536581','right');text('累计',col[2],361,19,'#536581','right');line(sideX+15,373,sideW-30);let cumulative=0;stats.panels.forEach((panel,i)=>{const y=412+i*58;cumulative+=panel.coins;text(panel.name.toLowerCase(),col[0],y,22);text(panel.coins.toLocaleString(),col[1],y,22,'#33435f','right');text(cumulative.toLocaleString(),col[2],y,22,'#33435f','right');line(sideX+15,y+15,sideW-30);});text('累计按上方难度顺序相加。',sideX+20,674,18,'#536581');text('Easy / Normal 无连击星石奖励，',sideX+20,708,18,'#536581');text('金币统一列于此栏。',sideX+20,735,18,'#536581');
 text('统计 '+stats.songCount+' 首已发布歌曲；等级向下取整。奖励按上传时的领取标记统计。',25,height-42,18,'#536581');text(stats.unknown?'有 '+stats.unknown+' 项领取状态缺失，未计入。':'包含未游玩歌曲；后续领取请重新上传账号包。',25,height-17,18,'#536581');
 fs.writeFileSync(v('--out'),await canvas.encode('png'));console.log(JSON.stringify({width,height,totalCoins:stats.totalCoins,totalStars:stats.totalStars}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
