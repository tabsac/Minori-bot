// PRTS 搜索
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
  for (const q of process.argv.slice(2)) {
    console.log('=== search:', q);
    try {
      const j = JSON.parse(await apiGet({ action: 'query', list: 'search', srsearch: q, srlimit: 8, format: 'json' }));
      ((j.query || {}).search || []).forEach((x) => console.log('   ', x.title));
      const j2 = JSON.parse(await apiGet({ action: 'query', list: 'allimages', aiprefix: q, ailimit: 15, format: 'json' }));
      ((j2.query || {}).allimages || []).forEach((x) => console.log('    [file]', x.name));
    } catch (e) { console.log('  失败', e.message); }
  }
})();
