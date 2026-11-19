import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { once } from "node:events";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const rendererRoot = resolve(dirname(process.env.WEBVIEW_TEST_ENTRY), "../..");
const { chromium } = await import(pathToFileURL(resolve(rendererRoot, "node_modules/playwright/index.mjs")));
const moduleSource = stripTypeScriptTypes(await readFile(new URL("../frontend/src/utils/browserCache.ts", import.meta.url), "utf8"));
const server = createServer((req, res) => {
  if (req.url === "/cache.mjs") {
    res.setHeader("content-type", "text/javascript");
    res.end(moduleSource);
  } else {
    res.setHeader("content-type", "text/html");
    res.end("<!doctype html><title>Browser cache regression fixture</title>");
  }
});
const browser = await chromium.launch({ chromiumSandbox: true });
try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const actual = await page.evaluate(async () => {
    const cache = await import("/cache.mjs");
    const bookUrl = "https://fixture.invalid/book";
    const chapterUrl = "https://fixture.invalid/chapter";
    const rendered = [{ url: chapterUrl, chapterRequestId: "render-request" }];
    const plain = [{ url: chapterUrl, chapterRequestId: "http" }];
    const chapter = { bookUrl, chapterUrl, content: "old ordinary text" };
    await cache.setBrowserCachedChapter(chapter);
    const before = [
      await cache.getBrowserCachedChapter(bookUrl, chapterUrl, "http"),
      await cache.getBrowserCachedChapter(bookUrl, chapterUrl, "render-request"),
      await cache.countBrowserBookCache(bookUrl, rendered),
    ];
    await cache.setBrowserCachedChapter({ ...chapter, chapterRequestId: "render-request", content: "rendered text" });
    await cache.setBrowserCachedChapter({ ...chapter, chapterRequestId: "http", content: "refreshed ordinary text" });
    const after = [
      await cache.getBrowserCachedChapter(bookUrl, chapterUrl, "render-request"),
      await cache.getBrowserCachedChapter(bookUrl, chapterUrl),
      await cache.countBrowserBookCache(bookUrl, rendered),
      await cache.countBrowserBookCache(bookUrl, plain),
      (await cache.listBrowserCacheSummary())[0].cachedChapterCount,
    ];
    await cache.deleteBrowserBookCache(bookUrl);
    return { before, after, remaining: await cache.countBrowserBookCache(bookUrl) };
  });
  assert.deepEqual(actual, {
    before: ["old ordinary text", null, 0],
    after: ["rendered text", "refreshed ordinary text", 1, 1, 1],
    remaining: 0,
  });
  console.log("PASS Chromium IndexedDB isolates both routes and preserves the ordinary cache key");
} finally {
  await browser.close();
  if (server.listening) await new Promise((done, fail) => server.close(error => error ? fail(error) : done()));
}
