import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const hits = [];
const renders = [];
const assetDirectory = "storage/data/default";
const externalReader = process.env.READER_TEST_URL;
const mode = process.env.READER_TEST_MODE ?? "both";
const stage = process.env.WEBVIEW_TEST_SITE_HOST ?? "127.0.0.1";
let renderFailure = false;
let legacyRenderer = false;

const marked = (path, hop) => path + "," + JSON.stringify({
  headers: { "X-Fixture-Hop": hop },
  webView: true,
  webViewDelayTime: 60,
  webJs: "window.renderScriptRuns = (window.renderScriptRuns ?? 0) + 1; document.querySelectorAll('.runs').forEach(el => el.textContent = window.renderScriptRuns)",
});
const escaped = text => text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
const link = (selector, href, label) => `<a class="${selector}" href="${escaped(href)}">${label}</a>`;
const bookRow = (href, name) => `<article><span>${name}</span>${link("book", href, "Detail")}</article>`;
const dynamic = html => `<main></main><script>document.querySelector("main").innerHTML = ${JSON.stringify(html).replaceAll("<", "\\u003c")}</script>`;

const fixture = createServer((req, res) => {
  const path = new URL(req.url, "http://local").pathname;
  hits.push([path, req.headers["x-fixture-hop"] ?? ""]);
  res.setHeader("content-type", "text/html; charset=utf-8");
  switch (path) {
    case "/search-plain":
      return res.end(bookRow("/plain/book", "Plain book"));
    case "/search":
    case "/explore":
      return res.end(dynamic(bookRow(marked("/book-start", "detail"), "Dynamic book")));
    case "/book-start":
      return res.writeHead(302, { location: "/rendered/detail" }).end();
    case "/rendered/detail":
      return res.end(dynamic(`<h1>Dynamic book</h1>${link("catalog", marked("toc", "catalog"), "Catalog")}`));
    case "/rendered/toc":
      return res.end(dynamic(`<article>${link("chapter", marked("chapter-1", "chapter"), "Chapter 1")}</article>${link("next-toc", marked("toc-next", "catalog-page"), "More")}`));
    case "/rendered/toc-next":
      return res.end(dynamic(`<article>${link("chapter", marked("chapter-2", "chapter-two"), "Chapter 2")}</article>`));
    case "/rendered/chapter-1":
      return res.end(dynamic(`<div class="body">First body <b class="runs"></b></div>${link("next-page", marked("chapter-1_2", "chapter-page"), "Next page")}`));
    case "/rendered/chapter-1_2":
      return res.end(dynamic(`<div class="body">Second body <b class="runs"></b></div>${link("next-page", marked("chapter-2", "other-chapter"), "Next chapter")}`));
    case "/rendered/chapter-2":
      return res.end(dynamic('<div class="body">Other chapter <b class="runs"></b></div>'));
    case "/plain/book":
      return res.end('<h1>Plain book</h1><a class="catalog" href="/plain/toc">Catalog</a>');
    case "/plain/toc":
      return res.end('<article><a class="chapter" href="/plain/chapter">Plain chapter</a></article>');
    case "/plain/chapter":
      return res.end('<div class="body">Plain body</div>');
    case "/login":
      return res.end('<h1>Login preview fixture</h1>');
    case "/cover":
      return res.writeHead(200, { "content-type": "image/png" }).end(
        Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==", "base64")
      );
    default:
      return res.writeHead(404).end();
  }
});
await listen(fixture, Number(process.env.WEBVIEW_TEST_SITE_PORT ?? 0), externalReader ? "0.0.0.0" : "127.0.0.1");
const origin = `http://${stage}:${fixture.address().port}`;
const rules = {
  bookSourceUrl: origin,
  bookSourceName: "WebView test fixture",
  enabled: true,
  searchUrl: marked("/search", "search"),
  loginUrl: marked("/login", "login"),
  ruleSearch: { bookList: "article", name: "span@text", bookUrl: "a@href" },
  ruleBookInfo: { name: "h1@text", tocUrl: ".catalog@href" },
  ruleToc: { chapterList: "article", chapterName: "a@text", chapterUrl: "a@href", nextTocUrl: ".next-toc@href" },
  ruleContent: { content: ".body@text", nextContentUrl: ".next-page@href" },
};
let scratch;
let child;
let bridge;
let rendererChild;

try {
  if (externalReader) {
    await runMode(externalReader, mode);
  } else {
    const binary = resolve(process.env.READER_TEST_BIN ?? "target/debug/reader-next");
    const rendererUrl = process.env.WEBVIEW_TEST_URL ?? await startRenderer(process.env.WEBVIEW_TEST_ENTRY);
    scratch = await mkdtemp(join(tmpdir(), "reader-webview-"));
    await seedLegacy(scratch);
    bridge = createServer(async (req, res) => {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        renders.push(JSON.parse(body.toString()));
        if (renderFailure) {
          res.writeHead(503).end('{"error":"fixture_unavailable"}');
          return;
        }
        const service = await fetch(new URL(req.url, rendererUrl), { method: req.method, body });
        const headers = { "content-type": service.headers.get("content-type") ?? "text/html" };
        for (const key of ["x-webview-final-url", "x-webview-status"]) {
          if (!legacyRenderer && service.headers.has(key)) headers[key] = service.headers.get(key);
        }
        res.writeHead(service.status, headers).end(await service.text());
      } catch (error) {
        res.writeHead(502).end(String(error));
      }
    });
    await listen(bridge);
    const renderer = `http://127.0.0.1:${bridge.address().port}`;
    if (mode !== "configured") {
      const reader = await startReader(binary, scratch, "");
      await runMode(reader, "plain");
      await stopReader();
    }
    if (mode !== "plain") {
      const reader = await startReader(binary, scratch, renderer);
      await runMode(reader, "configured");
      await stopReader();
      const restarted = await startReader(binary, scratch, renderer);
      const before = hits.length;
      const book = (await call(restarted, "getBookshelf", undefined, { method: "GET" })).find(book => book.bookUrl === origin + "/book-start");
      const list = await call(restarted, "getChapterList", { bookUrl: book.bookUrl, tocUrl: book.tocUrl, tocRequestId: book.tocRequestId, bookSource: rules });
      assert.equal(list[0].url, origin + "/rendered/chapter-1");
      assert.equal(hits.length, before, "catalog must load from saved cache");
      const refreshed = await call(restarted, "getBookContent", { bookUrl: origin + "/book-start", chapterUrl: list[0].url, chapterRequestId: list[0].chapterRequestId, bookSource: rules, refresh: 1 });
      assert.match(refreshed, /First body\s+1/);
      assert.match(refreshed, /Second body\s+1/);
      console.log("Renderer link options survive Reader restart and cached catalog readback");
      await stopReader();
    }
  }
} finally {
  await stopReader();
  await stopChild(rendererChild);
  for (const server of [bridge, fixture]) {
    if (server) {
      server.closeAllConnections();
      await new Promise((done, fail) => server.close(error => error ? fail(error) : done()));
    }
  }
  if (scratch) await rm(scratch, { recursive: true, force: true });
}

async function call(reader, operation, data, { error, method = "POST", raw = false } = {}) {
  const response = await fetch(`${reader}/reader3/${operation}`, {
    method,
    headers: data ? { "content-type": "application/json" } : undefined,
    body: data ? JSON.stringify(data) : undefined,
  });
  if (raw) {
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return text;
  }
  const payload = await response.json();
  if (error) {
    assert.equal(payload.isSuccess, false, JSON.stringify(payload));
    assert.match(payload.errorMsg, error);
  } else {
    assert.equal(payload.isSuccess, true, `${operation} ${response.status} ${JSON.stringify(payload)}`);
  }
  return payload.data;
}

async function runMode(reader, currentMode) {
  const start = renders.length;
  const plainRules = { ...rules, searchUrl: "/search-plain" };
  const plain = await call(reader, "searchBook", { key: "Plain", bookSource: plainRules });
  assert.equal(plain[0].bookUrl, origin + "/plain/book");
  const staticInfo = await call(reader, "getBookInfo", { url: plain[0].bookUrl, bookSource: plainRules });
  assert.equal(staticInfo.tocUrl, origin + "/plain/toc");
  assert.equal(renders.length, start);
  if (currentMode === "plain") {
    const absent = await call(reader, "searchBook", { key: "Dynamic", bookSource: rules });
    assert.deepEqual(absent, []);
    assert.equal(renders.length, start);
    assert.ok(hits.some(([path, hop]) => path === "/search" && hop === "search"));
    if (scratch) await assertLegacy(reader);
    console.log("HTTP compatibility passed with WebView disabled (marked and unmarked)");
    return;
  }
  await call(reader, "saveBookSource", rules);
  for (const [operation, payload] of [
    ["searchBook", { key: "Dynamic", bookSource: rules }],
    ["exploreBook", { ruleFindUrl: marked("/explore", "explore"), bookSource: rules }],
  ]) {
    const results = await call(reader, operation, payload);
    assert.equal(results[0].name, "Dynamic book");
    assert.equal(results[0].bookUrl, origin + "/book-start");
    const detail = await call(reader, "getBookInfo", { url: results[0].bookUrl, bookRequestId: results[0].bookRequestId, bookSource: rules });
    assert.equal(detail.name, "Dynamic book");
    assert.equal(detail.bookUrl, origin + "/book-start");
    assert.equal(detail.tocUrl, origin + "/rendered/toc");
    const catalogPayload = { bookUrl: detail.bookUrl, tocUrl: detail.tocUrl, tocRequestId: detail.tocRequestId, bookSource: rules };
    const legacyCatalog = Boolean(scratch) && operation === "searchBook";
    if (legacyCatalog) {
      const before = hits.length;
      const old = await call(reader, "getChapterList", { ...catalogPayload, tocRequestId: undefined });
      assert.equal(old[0].title, "Cached chapter");
      assert.equal(hits.length, before, "legacy catalog remains usable without fetching");
    }
    const list = await call(reader, "getChapterList", { ...catalogPayload, refresh: legacyCatalog ? 1 : undefined });
    assert.equal(list[0].title, "Chapter 1");
    assert.deepEqual(list.map(chapter => chapter.url), [
      origin + "/rendered/chapter-1", origin + "/rendered/chapter-2",
    ]);
    const contentPayload = { bookUrl: detail.bookUrl, chapterUrl: list[0].url, chapterRequestId: list[0].chapterRequestId, bookSource: rules };
    if (bridge) {
      renderFailure = true;
      await call(reader, "getBookContent", { ...contentPayload, refresh: 1 }, { error: /WebView/ });
      renderFailure = false;
    }
    const content = await call(reader, "getBookContent", contentPayload);
    assert.match(content, /First body\s+1/);
    assert.match(content, /Second body\s+1/);
    assert.doesNotMatch(content, /Other chapter/);
    const beforeCacheRead = hits.length;
    assert.deepEqual(await call(reader, "getChapterList", { tocUrl: detail.tocUrl, tocRequestId: detail.tocRequestId, bookSource: rules }), list);
    assert.equal(hits.length, beforeCacheRead);
    await call(reader, "saveBook", detail);
    const sse = await call(reader, "cacheBookSSE", { bookUrl: detail.bookUrl, count: 2 }, { raw: true });
    assert.match(sse, /event:.*(?:done|end)|"completed":2|缓存完成/);
    const requests = hits.length;
    const other = await call(reader, "getBookContent", { ...contentPayload, chapterUrl: list[1].url, chapterRequestId: list[1].chapterRequestId });
    assert.match(other, /Other chapter\s+1/);
    assert.equal(hits.length, requests, "bulk cache must save chapter body");
  }
  const beforeLogin = renders.length;
  const login = await call(reader, "loginBookSource", { bookSourceUrl: origin });
  assert.match(login.bodyPreview ?? login.bodyHtml ?? login.url, /Login preview|\/login/);
  const cover = await fetch(`${reader}/reader3/cover?${new URLSearchParams({ path: origin + "/cover" })}`);
  assert.equal(cover.status, 200);
  assert.match(cover.headers.get("content-type"), /image\//);
  assert.equal(renders.length, beforeLogin);
  if (bridge) {
    for (const hop of ["search", "explore", "detail", "catalog", "catalog-page", "chapter", "chapter-page", "chapter-two"]) {
      assert.ok(renders.some(request => request.headers["x-fixture-hop"] === hop), `Missing render hop: ${hop}`);
    }
    assert.ok(!renders.some(request => request.headers["x-fixture-hop"] === "other-chapter"));
    legacyRenderer = true;
    const results = await call(reader, "searchBook", { key: "Dynamic", bookSource: rules });
    legacyRenderer = false;
    assert.equal(results[0].bookUrl, origin + "/book-start");
    await assertLegacy(reader);
  }
  console.log("Search, discover, redirects, TOC paging, chapter paging, retry, bulk cache, login and cover passed");
}

async function seedLegacy(root) {
  const base = join(root, assetDirectory);
  const bookUrl = origin + "/legacy/book";
  const tocUrl = origin + "/legacy/toc";
  const chapterUrl = origin + "/legacy/chapter";
  const key = value => createHash("md5").update(value).digest("hex");
  const path = join(root, "storage/cache/default", key(bookUrl));
  await mkdir(path, { recursive: true });
  await mkdir(join(base, "chapters"), { recursive: true });
  await writeFile(join(base, "bookshelf.json"), JSON.stringify([{ name: "Legacy", author: "Old", bookUrl, tocUrl, origin, durChapterIndex: 3, durChapterPos: 12 }]));
  await writeFile(join(base, "chapters", key(tocUrl) + ".json"), JSON.stringify([{ title: "Legacy chapter", url: chapterUrl, index: 0 }]));
  await writeFile(join(path, key(chapterUrl) + ".txt"), "Legacy cached body");
  const oldDynamicCatalog = join(base, "chapters", key(origin + "/rendered/toc") + ".json");
  await writeFile(oldDynamicCatalog, JSON.stringify([
    { title: "Cached chapter", url: origin + "/rendered/chapter-1", index: 0 },
  ]));
}

async function assertLegacy(reader) {
  const shelf = await call(reader, "getBookshelf", undefined, { method: "GET" });
  const legacy = shelf.find(book => book.name === "Legacy");
  assert.equal(legacy.bookUrl, origin + "/legacy/book");
  assert.equal(legacy.durChapterIndex, 3);
  assert.equal(legacy.durChapterPos, 12);
  const chapters = await call(reader, "getChapterList", { tocUrl: legacy.tocUrl, bookSource: rules });
  assert.equal(chapters[0].url, origin + "/legacy/chapter");
  const text = await call(reader, "getBookContent", { bookUrl: legacy.bookUrl, chapterUrl: chapters[0].url, bookSource: rules });
  assert.equal(text, "Legacy cached body");
}

async function freePort() {
  const socket = createServer();
  await listen(socket);
  const port = socket.address().port;
  await new Promise(done => socket.close(done));
  return port;
}

async function startRenderer(entry) {
  assert.ok(entry, "provide WEBVIEW_TEST_ENTRY or WEBVIEW_TEST_URL");
  const port = await freePort();
  rendererChild = spawn(process.execPath, [resolve(entry)], {
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "inherit", "inherit"],
  });
  return waitForHealth(port, rendererChild, "Renderer");
}

async function startReader(bin, dir, renderer) {
  const port = await freePort();
  child = spawn(bin, [], {
    cwd: dir,
    env: {
      ...process.env,
      SERVER_HOST: "127.0.0.1",
      SERVER_PORT: String(port),
      REMOTE_WEBVIEW_URL: renderer,
      SECURE: "false",
      STORAGE_DIR: "storage",
      DATABASE_URL: "sqlite:storage/reader.db?mode=rwc",
      CHAPTER_UPDATE_INTERVAL_HOURS: "0",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  return waitForHealth(port, child, "Reader");
}

async function waitForHealth(port, process, name) {
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (process.exitCode !== null) throw new Error(`${name} stopped with ${process.exitCode}`);
    if (await fetch(url + "/health").then(res => res.ok, () => false)) return url;
    await sleep(100);
  }
  throw new Error(`${name} did not become healthy`);
}

async function stopChild(process) {
  if (process && process.exitCode === null && process.signalCode === null) {
    const exited = once(process, "exit");
    process.kill();
    await exited;
  }
}

async function stopReader() {
  await stopChild(child);
  child = undefined;
}

async function listen(server, port = 0, host = "127.0.0.1") {
  server.listen(port, host);
  await once(server, "listening");
}
