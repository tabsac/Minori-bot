// 查 PRTS 上某关卡的地图图片文件名
const https = require('https');
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
  for (const pref of process.argv.slice(2)) {
    console.log('=== prefix:', pref);
    try {
      const j = JSON.parse(await apiGet({ action: 'query', list: 'allimages', aiprefix: pref, ailimit: 40, format: 'json' }));
      const list = ((j.query || {}).allimages) || [];
      list.forEach((x) => console.log('   ', x.name));
      if (!list.length) console.log('    (无)');
    } catch (e) { console.log('  失败', e.message); }
  }
})();
