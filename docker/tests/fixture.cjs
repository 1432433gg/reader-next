const http = require('node:http');
let forbiddenHits = 0;
let emptyGets = 0;
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/stats') return res.end(JSON.stringify({ forbiddenHits, emptyGets }));
  if (req.url === '/redirect') {
    res.writeHead(302, { Location: 'http://fixture:19091/private' });
    return res.end();
  }
  if (req.url === '/post') {
    return res.end(`<body>${JSON.stringify({ method: req.method, body, type: req.headers['content-type'], header: req.headers['x-bundle-check'] })}</body>`);
  }
  if (req.url === '/empty') {
    if (req.method === 'GET') { emptyGets++; return res.end('UNEXPECTED_SECOND_GET'); }
    return res.end('');
  }
  res.end('<body><script>document.body.textContent="BUNDLED_WEBKIT_GET_OK"</script></body>');
});
server.listen(19090, '0.0.0.0');
http.createServer((req, res) => {
  forbiddenHits++;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end('BUNDLED_FORBIDDEN_MARKER');
}).listen(19091, '0.0.0.0');
