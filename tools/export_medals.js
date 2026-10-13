'use strict';
// 从 item_assets_all_<hash>.bundle 里把 medal / badge 图标导出来（Sprite 会按图集矩形裁好）
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ON = '/home/admin/bot/data/on';
const songs = JSON.parse(fs.readFileSync(ON + '/songs.json', 'utf8'));
const BUNDLE = process.argv[2] || 'item_assets_all_de742e86cdf93301fd6a66dbafe82113.bundle';
const FILTER = new RegExp(process.argv[3] || 'medal|badge', 'i');
const OUT = process.argv[4] || '/tmp/medals';

fs.mkdirSync(OUT, { recursive: true });
const bfile = '/tmp/' + BUNDLE;
if (!fs.existsSync(bfile) || fs.statSync(bfile).size < 10240) {
  const code = execFileSync('curl', ['-s', '-m', '300', '-o', bfile, '-w', '%{http_code}',
    '-u', songs.auth, songs.cdn + '/' + BUNDLE], { encoding: 'utf8' }).trim();
  console.log('下载 ' + BUNDLE + ' → HTTP ' + code + '  ' + (fs.existsSync(bfile) ? fs.statSync(bfile).size + 'B' : ''));
}

const { Bundle } = require(path.join(ON, 'unitysrc', 'bundle.js'));
const { exportObject } = require(path.join(ON, 'unitysrc', 'exporter.js'));

(async () => {
  const b = Bundle.load(bfile);
  const objs = b.listObjects();
  console.log('包里对象共 ' + objs.length + ' 个');
  const sprites = objs.filter((e) => e.className === 'Sprite');
  const texes = objs.filter((e) => e.className === 'Texture2D');
  console.log('Sprite ' + sprites.length + ' / Texture2D ' + texes.length);
  const hitNames = sprites.map((e) => e.name || e.path || '').filter((n) => FILTER.test(n));
  console.log('名字命中 ' + FILTER + ' 的 Sprite ' + hitNames.length + ' 个：');
  hitNames.slice(0, 40).forEach((n) => console.log('   ' + n));

  const want = sprites.filter((e) => FILTER.test(e.name || e.path || ''));
  let ok = 0;
  for (const e of want) {
    try {
      const r = await exportObject(b, e);
      if (r && r.data) {
        const f = path.join(OUT, String(e.name || ('sprite_' + ok)).replace(/[^\w.-]/g, '_') + (r.ext || '.png'));
        fs.writeFileSync(f, r.data);
        ok++;
        if (ok <= 12) console.log('   → ' + f + '  ' + (r.meta ? JSON.stringify(r.meta) : ''));
      }
    } catch (err) { console.log('   导出失败 ' + (e.name || '?') + ': ' + err.message.slice(0, 80)); }
  }
  console.log('导出成功 ' + ok + ' 张 → ' + OUT);
})().catch((e) => { console.error('失败: ' + (e && e.message ? e.message : e)); process.exit(1); });
