import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const rendererDist = dirname(resolve(process.env.WEBVIEW_TEST_ENTRY));
const { Renderer } = await import(pathToFileURL(resolve(rendererDist, "../render/renderer.js")));
const { createRenderServer } = await import(pathToFileURL(resolve(rendererDist, "server.js")));
const fixtureRoot = await mkdtemp(join(tmpdir(), "reader-task006-two-route-cases-"));
const targetRequests = [];
const renderedPaths = [];
let edition = "";
let delayedCatalog;
let delayedBody;
const renderer = new Renderer(8000, 3);
const service = createRenderServer({
  render(input, signal) {
    renderedPaths.push(input.url.pathname);
    return renderer.render(input, signal);
  },
}, 8000);

function row(path, marked) {
  const link = marked ? path + ',{&quot;webView&quot;:true}' : path;
  return '<article><span>Fixture Book</span><a href="' + link + '">Detail</a></article>';
}

const site = createServer((req, res) => {
  targetRequests.push(req.url);
  res.setHeader("content-type", "text/html; charset=utf-8");
  switch (req.url) {
    case "/shared-list":
      return res.end(row("/shared-book", true));
    case "/marked-list":
      return res.end(row("/mixed-book", true));
    case "/plain-list":
      return res.end(row("/mixed-book", false));
    case "/shared-book":
      return res.end('<main></main><script>document.querySelector("main").innerHTML = "<h1>Shared detail</h1><article><a href=\'/chapter\'>Chapter 1</a></article>"</script>');
    case "/mixed-book":
      return res.end('<h1>Plain detail</h1><article><a href="/plain-chapter">Plain chapter</a></article><script>document.querySelector("h1").textContent = "Rendered detail"; document.querySelector("article a").textContent = "Rendered chapter"; document.querySelector("article a").href = "/rendered-chapter"</script>');
    case "/body-plain-list":
      return res.end(row("/body-book", false));
    case "/body-rendered-list":
      return res.end(row("/body-book", true));
    case "/body-book":
      return res.end(`<h1>Book with shared chapter</h1><article><a href="/shared-body">Ordinary edition${edition}</a></article><script>const link = document.querySelector("article a"); link.textContent = "Rendered edition${edition}"; link.setAttribute("href", "/shared-body," + JSON.stringify({webView: true}));</script>`);
    case "/extra-catalog": {
      const answer = `<article><a href="/shared-body">Extra edition${edition}</a></article>`;
      if (delayedCatalog) {
        const pending = delayedCatalog;
        delayedCatalog = undefined;
        pending.arrive();
        return void pending.release.then(() => res.end(answer));
      }
      return res.end(answer);
    }
    case "/shared-body": {
      const answer = '<div class="body">Plain chapter text</div><script>document.querySelector(".body").textContent = "Rendered chapter text";</script>';
      if (delayedBody) {
        const pending = delayedBody;
        delayedBody = undefined;
        pending.arrive();
        return void pending.release.then(() => res.end(answer));
      }
      return res.end(answer);
    }
    case "/chapter":
      return res.end('<p>Fixture chapter</p>');
    default:
      return res.writeHead(404).end();
  }
});

const siteOrigin = await listen(site);
const serviceOrigin = await listen(service);
const portProbe = createServer();
const readerOrigin = await listen(portProbe);
await close(portProbe);

const reader = spawn(resolve(process.env.READER_TEST_BIN), [], {
  cwd: fixtureRoot,
  env: {
    ...process.env,
    SERVER_HOST: "127.0.0.1",
    SERVER_PORT: new URL(readerOrigin).port,
    REMOTE_WEBVIEW_URL: serviceOrigin,
    SECURE: "false",
    STORAGE_DIR: "storage",
    DATABASE_URL: "sqlite:storage/reader.db?mode=rwc",
    CHAPTER_UPDATE_INTERVAL_HOURS: "0",
  },
  stdio: ["ignore", "inherit", "inherit"],
});

const rules = {
  bookSourceUrl: siteOrigin,
  bookSourceName: "Independent Task 006 routing fixture",
  enabled: true,
  ruleSearch: { bookList: "article", name: "span@text", bookUrl: "a@href" },
  ruleBookInfo: { name: "h1@text" },
  ruleToc: { chapterList: "article", chapterName: "a@text", chapterUrl: "a@href" },
  ruleContent: { content: ".body@text" },
};

async function call(operation, body) {
  const response = await fetch(readerOrigin + "/reader3/" + operation, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, ...await response.json() };
}

async function firstResult(searchUrl) {
  const result = await call("searchBook", { key: "Fixture", bookSource: { ...rules, searchUrl } });
  assert.equal(result.isSuccess, true, JSON.stringify(result));
  return result.data[0];
}

async function detail({ bookUrl: url, bookRequestId }) {
  const result = await call("getBookInfo", { url, bookRequestId, bookSource: rules });
  assert.equal(result.isSuccess, true, JSON.stringify(result));
  return result.data;
}

async function check(name, action) {
  try {
    await action();
    console.log("PASS", name);
  } catch (error) {
    console.error("FAIL", name, error.message);
    process.exitCode = 1;
  }
}

try {
  let healthy = false;
  for (let attempt = 0; attempt < 100 && reader.exitCode === null; attempt++) {
    healthy = await fetch(readerOrigin + "/health").then(response => response.ok, () => false);
    if (healthy) break;
    await delay(100);
  }
  assert.ok(healthy, "Reader did not become healthy");

  await check("AC-05 catalog sharing the marked detail URL", async () => {
    const item = await firstResult("/shared-list");
    const { bookUrl } = item;
    const book = await detail(item);
    assert.equal(book.name, "Shared detail");
    assert.equal(book.bookUrl, siteOrigin + "/shared-book");
    assert.equal(book.tocUrl, book.bookUrl);
    const renderStart = renderedPaths.length;
    const hitStart = targetRequests.length;
    const payload = { bookUrl, tocUrl: book.tocUrl, tocRequestId: book.tocRequestId, bookSource: rules };
    const result = await call("getChapterList", payload);
    const renders = renderedPaths.slice(renderStart);
    const hits = targetRequests.slice(hitStart);
    console.log(JSON.stringify({ case: "shared-detail-catalog", result, renders, hits }));
    assert.equal(result.isSuccess, true, "The catalog should reuse the marked detail page");
    assert.equal(result.data[0].title, "Chapter 1");
    assert.deepEqual(renders, ["/shared-book"]);
    const cached = await call("getChapterList", payload);
    assert.deepEqual(cached.data, result.data);
    assert.equal(targetRequests.length, hitStart + hits.length);
  });

  await check("AC-04/05 marked and unmarked results sharing a URL", async () => {
    const orders = [
      [await firstResult("/plain-list"), await firstResult("/marked-list")],
      [await firstResult("/marked-list"), await firstResult("/plain-list")],
    ];
    for (const items of orders) {
      assert.equal(items[0].bookUrl, items[1].bookUrl);
      assert.notEqual(items[0].bookRequestId, items[1].bookRequestId);
      for (const item of items) {
        const isMarked = item.bookRequestId !== "http";
        const before = renderedPaths.length;
        const book = await detail(item);
        assert.equal(book.bookUrl, item.bookUrl);
        assert.equal(book.tocUrl, item.bookUrl);
        assert.equal(book.name, isMarked ? "Rendered detail" : "Plain detail");
        assert.deepEqual(renderedPaths.slice(before), isMarked ? ["/mixed-book"] : []);
        const catalog = await call("getChapterList", {
          bookUrl: item.bookUrl, bookRequestId: item.bookRequestId, bookSource: rules,
        });
        assert.equal(catalog.isSuccess, true, JSON.stringify(catalog));
        assert.equal(catalog.data[0].title, isMarked ? "Rendered chapter" : "Plain chapter");
        const hits = targetRequests.length;
        const cached = await call("getChapterList", {
          bookUrl: item.bookUrl, tocUrl: book.tocUrl, tocRequestId: book.tocRequestId,
          bookSource: rules,
        });
        assert.deepEqual(cached.data, catalog.data);
        assert.equal(targetRequests.length, hits);
      }
    }
  });
  async function loadCatalog(item) {
    const book = await detail(item);
    const result = await call("getChapterList", {
      bookUrl: book.bookUrl, tocUrl: book.tocUrl, tocRequestId: book.tocRequestId,
      bookSource: rules, refresh: 1,
    });
    assert.equal(result.isSuccess, true, JSON.stringify(result));
    return result.data[0];
  }

  const normal = await firstResult("/body-plain-list");
  const marked = await firstResult("/body-rendered-list");
  assert.equal(normal.bookUrl, marked.bookUrl);
  assert.notEqual(normal.bookRequestId, marked.bookRequestId);

  function readChapter(item, chapter, refresh) {
    return call("getBookContent", {
      bookUrl: item.bookUrl, bookRequestId: item.bookRequestId,
      chapterUrl: chapter.url, bookSource: rules, refresh,
    });
  }

  await check("AC-05 same chapter URL loses its selected renderer after another catalog", async () => {
    const renderedChapter = await loadCatalog(marked);
    const ordinaryChapter = await loadCatalog(normal);
    assert.equal(renderedChapter.title, "Rendered edition");
    assert.equal(ordinaryChapter.title, "Ordinary edition");
    assert.equal(renderedChapter.url, ordinaryChapter.url);
    const renderStart = renderedPaths.length;
    const hitStart = targetRequests.length;
    const content = await readChapter(marked, renderedChapter, 1);
    const renders = renderedPaths.slice(renderStart);
    const hits = targetRequests.slice(hitStart);
    console.log(JSON.stringify({ case: "same-chapter-route", content, renders, hits }));
    assert.equal(content.isSuccess, true, JSON.stringify(content));
    assert.equal(content.data, "Rendered chapter text");
    assert.deepEqual(renders, ["/shared-body"]);
  });

  await check("AC-06 same chapter URL returns cached content from the other route", async () => {
    const renderedChapter = await loadCatalog(marked);
    const beforeWarm = renderedPaths.length;
    const warmed = await readChapter(marked, renderedChapter, 1);
    assert.equal(warmed.isSuccess, true, JSON.stringify(warmed));
    assert.equal(warmed.data, "Rendered chapter text");
    assert.deepEqual(renderedPaths.slice(beforeWarm), ["/shared-body"]);
    const ordinaryChapter = await loadCatalog(normal);
    assert.equal(renderedChapter.url, ordinaryChapter.url);
    const renderStart = renderedPaths.length;
    const hitStart = targetRequests.length;
    const content = await readChapter(normal, ordinaryChapter);
    const renders = renderedPaths.slice(renderStart);
    const hits = targetRequests.slice(hitStart);
    console.log(JSON.stringify({ case: "same-chapter-cache", content, renders, hits }));
    assert.equal(content.isSuccess, true, JSON.stringify(content));
    assert.equal(content.data, "Plain chapter text");
  });

  await check("AC-06 explicit chapter IDs isolate refresh, hot reads and bulk cache", async () => {
    const plainChapter = await loadCatalog(normal);
    const renderedChapter = await loadCatalog(marked);
    assert.equal(plainChapter.url, renderedChapter.url);
    assert.equal(plainChapter.chapterRequestId, "http");
    assert.match(renderedChapter.chapterRequestId, /^[0-9a-f]{32}$/);
    async function content(item, chapter, refresh) {
      const r = await call("getBookContent", {
        bookUrl: item.bookUrl, chapterUrl: chapter.url, chapterRequestId: chapter.chapterRequestId,
        bookRequestId: item.bookRequestId, bookSource: rules, refresh,
      });
      assert.equal(r.isSuccess, true, JSON.stringify(r));
      return r.data;
    }
    assert.equal(await content(marked, renderedChapter, 1), "Rendered chapter text");
    assert.equal(await content(normal, plainChapter, 1), "Plain chapter text");
    const before = targetRequests.length;
    assert.equal(await content(marked, renderedChapter), "Rendered chapter text");
    assert.equal(await content(normal, plainChapter), "Plain chapter text");
    assert.equal(targetRequests.length, before);

    const savedSource = await call("saveBookSource", rules);
    assert.equal(savedSource.isSuccess, true, JSON.stringify(savedSource));
    const savedBook = await call("saveBook", await detail(marked));
    assert.equal(savedBook.isSuccess, true, JSON.stringify(savedBook));
    for (const [item, chapter, expectedRenders] of [[normal, plainChapter, []], [marked, renderedChapter, ["/shared-body"]]]) {
      const renders = renderedPaths.length;
      const response = await fetch(readerOrigin + "/reader3/cacheBookSSE", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ bookUrl: item.bookUrl, bookSourceUrl: rules.bookSourceUrl,
          bookRequestId: item.bookRequestId, refresh: 1, count: 1 }),
      });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /"successCount":1/);
      assert.deepEqual(renderedPaths.slice(renders), expectedRenders);
      const network = targetRequests.length;
      assert.equal(await content(item, chapter), item === marked ? "Rendered chapter text" : "Plain chapter text");
      assert.equal(targetRequests.length, network);
    }
  });

  await check("AC-06 clearing a book invalidates its catalogs and leaves a sibling's shared-URL caches hot", async () => {
    const book = await detail(marked);
    const sibling = siteOrigin + "/other-book";
    const plainPayload = { bookUrl: book.bookUrl, tocUrl: book.tocUrl, bookSource: rules };
    const renderedPayload = { ...plainPayload, tocRequestId: book.tocRequestId };
    const extraPayload = { bookUrl: book.bookUrl, tocUrl: siteOrigin + "/extra-catalog", bookSource: rules };
    async function chapterAt(payload) {
      const catalog = await call("getChapterList", payload);
      assert.equal(catalog.isSuccess, true, JSON.stringify(catalog));
      return catalog.data[0];
    }
    async function bodyAt(bookUrl, chapter, refresh) {
      const body = await call("getBookContent", {
        bookUrl, chapterUrl: chapter.url, chapterRequestId: chapter.chapterRequestId, bookSource: rules, refresh,
      });
      assert.equal(body.isSuccess, true, JSON.stringify(body));
      return body.data;
    }
    const plain = await chapterAt(plainPayload);
    const rendered = await chapterAt(renderedPayload);
    const otherPlain = await chapterAt({ ...plainPayload, bookUrl: sibling });
    const otherRendered = await chapterAt({ ...renderedPayload, bookUrl: sibling });
    await chapterAt(extraPayload);
    for (const [url, chapter] of [[book.bookUrl, plain], [book.bookUrl, rendered], [sibling, otherPlain], [sibling, otherRendered]]) {
      await bodyAt(url, chapter);
    }

    let announce;
    let unblock;
    const arrived = new Promise(resolve => { announce = resolve; });
    const release = new Promise(resolve => { unblock = resolve; });
    let announceBody;
    const bodyArrived = new Promise(resolve => { announceBody = resolve; });
    delayedCatalog = { arrive: announce, release };
    delayedBody = { arrive: announceBody, release };
    const inFlight = chapterAt({ ...extraPayload, refresh: 1 });
    const inFlightBody = bodyAt(book.bookUrl, plain, 1);
    try {
      await Promise.race([Promise.all([arrived, bodyArrived]), delay(4000).then(() => { throw new Error("pending requests did not arrive"); })]);
      edition = " revised";
      const deleted = await call("deleteBookCache", { bookUrl: book.bookUrl });
      assert.deepEqual(deleted.data, { deleted: true, contentCache: true, chapterListCache: true });
    } finally {
      unblock();
    }
    assert.equal((await inFlight).title, "Extra edition", "the earlier response may finish, but must not repopulate the cache");
    assert.equal(await inFlightBody, "Plain chapter text");

    let start = targetRequests.length;
    assert.equal((await chapterAt({ ...plainPayload, bookUrl: sibling })).title, "Ordinary edition");
    assert.equal((await chapterAt({ ...renderedPayload, bookUrl: sibling })).title, "Rendered edition");
    assert.equal(await bodyAt(sibling, otherPlain), "Plain chapter text");
    assert.equal(await bodyAt(sibling, otherRendered), "Rendered chapter text");
    assert.equal(targetRequests.length, start);

    const renderStart = renderedPaths.length;
    assert.equal((await chapterAt(plainPayload)).title, "Ordinary edition revised");
    assert.equal((await chapterAt(renderedPayload)).title, "Rendered edition revised");
    assert.equal((await chapterAt(extraPayload)).title, "Extra edition revised");
    assert.deepEqual(targetRequests.slice(start), ["/body-book", "/body-book", "/extra-catalog"]);
    assert.deepEqual(renderedPaths.slice(renderStart), ["/body-book"]);
    start = targetRequests.length;
    assert.equal(await bodyAt(book.bookUrl, plain), "Plain chapter text");
    assert.equal(await bodyAt(book.bookUrl, rendered), "Rendered chapter text");
    assert.deepEqual(targetRequests.slice(start), ["/shared-body", "/shared-body"]);
  });
} finally {
  if (reader.exitCode === null) {
    const stopped = once(reader, "exit");
    reader.kill();
    await stopped;
  }
  await renderer.close();
  await Promise.all([close(service), close(site)]);
  await rm(fixtureRoot, { recursive: true, force: true });
}

async function listen(server) {
  const ready = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await ready;
  return "http://127.0.0.1:" + server.address().port;
}

async function close(server) {
  const stopped = once(server, "close");
  server.close();
  server.closeAllConnections();
  await stopped;
}
