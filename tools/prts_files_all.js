// 拉 PRTS 全部「地图」开头的文件，存到 /tmp，方便 grep
const https = require('https');
const fs = require('fs');
const UA = 'ournotes-bot/1.0 (+https://github.com/tabsac/ournotes-bot)';
function apiGet(params) {
  const qs = Object.keys(params).map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
  const u = new URL('https://prts.wiki/api.php?' + qs);
  return new Promise((resolve, reject) => {
    const req = https.get({ host: u.hostname, path: u.pathname + u.search, headers: { 'User-Agent': UA, 'Accept-Encoding': 'identity' }, timeout: 60000 },
      (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve(Buffer.concat(c).toString('utf8'))); });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
(async () => {
  const pref = process.argv[2] || '地图';
  const out = [];
  let cont = '';
  for (let i = 0; i < 12; i++) {
    const p = { action: 'query', list: 'allimages', aiprefix: pref, ailimit: 500, format: 'json' };
    if (cont) p.aicontinue = cont;
    const j = JSON.parse(await apiGet(p));
    const list = ((j.query || {}).allimages) || [];
    list.forEach((x) => out.push(x.name));
    cont = j.continue && j.continue.aicontinue;
    if (!cont) break;
  }
  fs.writeFileSync('/tmp/prts_mapfiles.txt', out.join('\n'));
  console.log('total', out.length, '→ /tmp/prts_mapfiles.txt');
})();
