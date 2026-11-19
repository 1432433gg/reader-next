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
