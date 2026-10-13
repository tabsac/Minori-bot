'use strict';
// 瀵煎嚭 atlas 閲岀殑 medal/badge 鍥炬爣锛氬悕瀛楄绛?exportObject 瑙ｅ嚭鏉ユ墠鐭ラ亾锛屾墍浠ュ厛鍏ㄥ鍐嶇湅鍚嶅瓧
const fs = require('fs');
const path = require('path');
const ON = '/home/admin/bot/data/on';
const BUNDLE = process.argv[2] || '/tmp/item_assets_all_de742e86cdf93301fd6a66dbafe82113.bundle';
const OUT = process.argv[3] || '/tmp/medals';
fs.mkdirSync(OUT, { recursive: true });

const { Bundle } = require(path.join(ON, 'unitysrc', 'bundle.js'));
const { exportObject } = require(path.join(ON, 'unitysrc', 'exporter.js'));

(async () => {
  const b = Bundle.load(BUNDLE);
  const sprites = b.listObjects().filter((e) => e.className === 'Sprite');
  console.log('Sprite 鍏?' + sprites.length + ' 涓紝寮€濮嬪鍑衡€?);
  const names = [];
  let saved = 0, failed = 0;
  for (const e of sprites) {
    try {
      const r = await exportObject(b, e);
      if (!r || !r.data) { failed++; continue; }
      const nm = r.name || 'unnamed';
      names.push(nm);
      if (/medal|badge|star|seal/i.test(nm)) {
        const f = path.join(OUT, nm.replace(/[^\w.\-]/g, '_') + (r.ext || '.png'));
        fs.writeFileSync(f, r.data);
        saved++;
        if (saved <= 15) console.log('   鉁?' + nm + '  ' + (r.meta ? JSON.stringify(r.meta) : '') + ' 鈫?' + f);
      }
    } catch (err) { failed++; }
  }
  console.log('\n瀵煎嚭鎴愬姛(medal/badge) ' + saved + ' 寮狅紝澶辫触 ' + failed + ' 涓?);
  console.log('鍚嶅瓧鏍蜂緥锛堝墠 30锛?');
  names.slice(0, 30).forEach((n) => console.log('   ' + n));
  fs.writeFileSync('/tmp/medals_names.txt', names.join('\n'));
  console.log('\n鍏ㄩ儴鍚嶅瓧宸插啓鍒?/tmp/medals_names.txt锛? + names.length + ' 琛岋級');
})().catch((e) => { console.error('澶辫触: ' + (e && e.message ? e.message : e)); process.exit(1); });

