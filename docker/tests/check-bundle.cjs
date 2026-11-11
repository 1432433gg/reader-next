const assert = require('node:assert/strict');
const base = 'http://remote-webview:8050';
const control = 'http://control-webview:8050';
async function ready(url) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(1000) }); if (r.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Service not ready: ' + url);
}
async function render(renderer, options) {
  const r = await fetch(renderer + '/render.html', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options), signal: AbortSignal.timeout(22000)
  });
  assert.equal(r.status, 200);
  return r.text();
}
async function stats() { return (await fetch('http://fixture:19090/stats')).json(); }
(async () => {
  await ready(base + '/health');
  await ready(control + '/health');
  await ready('http://reader:8080/');
  console.log('READER_AND_RENDERER_STARTUP_PASS');
  const dynamic = await render(base, { url: 'http://fixture:19090/', js_source: 'document.body.textContent' });
  assert.equal(dynamic, 'BUNDLED_WEBKIT_GET_OK');
  console.log('WEBKIT_DYNAMIC_GET_PASS');
  const post = await render(base, {
    url: 'http://fixture:19090/post', http_method: 'POST',
    headers: { 'Content-Type': 'text/plain; charset=UTF-8', 'X-Bundle-Check': 'preserved' },
    body: '中文正文=你好', js_source: 'document.body.textContent'
  });
  assert.deepEqual(JSON.parse(post), { method: 'POST', body: '中文正文=你好', type: 'text/plain; charset=UTF-8', header: 'preserved' });
  const empty = await render(base, { url: 'http://fixture:19090/empty', http_method: 'POST', body: '' });
  assert.ok(empty.includes('<html>') && !empty.startsWith('Error: page.render:'));
  assert.equal((await stats()).emptyGets, 0);
  console.log('POST_UTF8_HEADERS_AND_EMPTY_RESPONSE_PASS');
  const denied = 'http://fixture:19091/private';
  const script = '(async()=>{try{return await(await fetch(' + JSON.stringify(denied) + ')).text()}catch{return "FETCH_BLOCKED"}})()';
  for (const options of [
    { url: denied }, { url: 'http://fixture:19090/redirect' },
    { url: 'http://fixture:19090/', js_source: script }
  ]) {
    assert.ok((await render(control, options)).includes('BUNDLED_FORBIDDEN_MARKER'), 'unprotected control must reach marker');
  }
  const before = (await stats()).forbiddenHits;
  assert.equal(before, 3);
  for (const options of [
    { url: denied }, { url: 'http://fixture:19090/redirect' },
    { url: 'http://fixture:19090/', js_source: script },
    { url: 'http://127.0.0.1:8050/health' },
    { url: 'http://127.0.0.11:8050/health' },
    { url: 'http://[::1]:8050/health' }
  ]) {
    const result = await render(base, options);
    assert.ok(!result.includes('BUNDLED_FORBIDDEN_MARKER'));
    assert.ok(result.startsWith('Error: page.render:') || result === 'FETCH_BLOCKED', result);
  }
  assert.equal((await stats()).forbiddenHits, before);
  console.log('PROTECTED_DIRECT_REDIRECT_SUBREQUEST_LOOPBACK_IPV6_PASS');
  // A timed-out browser task must finish cleanup and allow the next task.
  const cancelled = await render(base, { url: 'http://fixture:19090/', js_source: 'new Promise(()=>{})' });
  assert.ok(cancelled.startsWith('Error: page.render:'));
  assert.equal(await render(base, { url: 'http://fixture:19090/', js_source: 'document.body.textContent' }), 'BUNDLED_WEBKIT_GET_OK');
  assert.equal((await (await fetch(base + '/health')).json()).renderingCount, 0);
  console.log('TIMEOUT_CLEANUP_AND_NEXT_REQUEST_PASS');
  console.log('BUNDLE_SMOKE_PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
