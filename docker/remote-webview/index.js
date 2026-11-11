const http = require('http');
const url = require('url');
const { webkit, devices } = require('playwright');
const https = require('https')

// Exception messages and stacks may contain credentials, URLs or page content.
process.on('uncaughtException', () => {
    console.error('renderer: uncaught_exception');
});
process.on('unhandledRejection', () => {
    console.error('renderer: unhandled_rejection');
});

let renderingCount = 0;
let renderedCount = 0;

async function post(uri, headers, body, encode, signal) {
    body = body ?? "";
    return new Promise((resolve, reject) => {
        const parsedUrl = url.parse(uri);
        let httpModule = http;
        if (parsedUrl.protocol === 'https:') {
            httpModule = https;
        }
        let isJson = false;
        try {
            JSON.parse(body);
            isJson = true;
        } catch (error) {

        }
        const requestHeaders = { ...headers };
        for (const name of Object.keys(requestHeaders)) {
            if (name.toLowerCase() === "content-length") delete requestHeaders[name];
        }
        if (!Object.keys(requestHeaders).some(name => name.toLowerCase() === "content-type")) {
            requestHeaders["Content-Type"] = isJson ? "application/json; charset=UTF-8" : "application/x-www-form-urlencoded; charset=UTF-8";
        }
        requestHeaders["Content-Length"] = Buffer.byteLength(body, "utf8");
        const req = httpModule.request(uri, {
            method: "POST",
            signal,
            headers: requestHeaders
        }, res => {
            let list = [];
            res.on('data', chunk => {
                list.push(chunk);
            });
            res.on('error', reject);
            res.on('aborted', () => reject(new Error('response aborted')));
            res.on('end', () => {
                const data = Buffer.concat(list).toString(encode || 'utf-8');
                resolve(data);
            });
        }).on('error', err => {
            reject(err);
        });
        req.write(body);
        req.end();
    });
}


function cancelled(signal) {
    if (signal.aborted) throw new Error('render cancelled');
}

function waitForResult(promise, signal) {
    cancelled(signal);
    return new Promise((resolve, reject) => {
        const abort = () => reject(new Error('render cancelled'));
        signal.addEventListener('abort', abort, { once: true });
        promise.then(resolve, reject).finally(() => {
            signal.removeEventListener('abort', abort);
        });
    });
}

async function renderHtml(options, signal) {
    const { url, headers, js_source, proxy, http_method, body, encode, sourceRegex } = options;
    let { html } = options;
    cancelled(signal);
    if (http_method === 'POST') {
        html = await post(url, headers, body, encode, signal);
    }
    cancelled(signal);
    const launchOptions = { headless: true, timeout: 15000, baseURL: url };
    if (proxy) {
        const match = proxy.match(/(http|socks4|socks5):\/\/(.*)?:(\d{2,5})?(@.*@.*)?/);
        if (match) {
            launchOptions.proxy = { server: match[1] + '://' + match[2] + ':' + match[3] };
            if (match[4]) {
                launchOptions.proxy.username = match[4].split('@')[1];
                launchOptions.proxy.password = match[4].split('@')[2];
            }
        }
    }
    // Launch is bounded. If cancellation occurs during launch, close the browser
    // immediately after it becomes available, before the next queued task starts.
    const browser = await webkit.launch(launchOptions);
    const abort = () => {
        browser.close().catch(() => console.error('renderer: close_failed'));
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
        cancelled(signal);
        const context = await browser.newContext({
            ...devices['Desktop Safari'],
            acceptDownloads: false,
            baseURL: url,
            bypassCSP: true,
            extraHTTPHeaders: headers,
            ignoreHTTPSErrors: true,
            ...(headers && headers['User-Agent'] ? { userAgent: headers['User-Agent'] } : {})
        });
        const page = await context.newPage();
        await page.route('**/*.{png,jpg,jpeg,mp4,mp3}', route => route.abort());
        let responseResult;
        if (sourceRegex) {
            const pattern = new RegExp(sourceRegex);
            responseResult = new Promise((resolve, reject) => {
                page.on('response', response => {
                    if (pattern.test(response.url())) {
                        response.text().then(resolve, reject);
                    }
                });
            });
            // A response can fail before navigation finishes.
            responseResult.catch(() => {});
        }
        const loadOptions = { timeout: 15000, waitUntil: 'load' };
        if (html !== undefined && html !== null) {
            await page.setContent(html, loadOptions);
        } else {
            await page.goto(url, loadOptions);
        }
        cancelled(signal);
        if (sourceRegex) {
            if (js_source) await page.evaluate(js_source);
            return await waitForResult(responseResult, signal);
        }
        if (!js_source) return await page.content();
        for (let attempt = 0; attempt < 30; attempt++) {
            cancelled(signal);
            const result = await page.evaluate(js_source);
            if (result && result !== 'null') {
                return typeof result === 'string' ? result : JSON.stringify(result);
            }
            await waitForResult(new Promise(resolve => setTimeout(resolve, 100)), signal);
        }
        throw new Error('render script returned no result');
    } finally {
        signal.removeEventListener('abort', abort);
        // This promise remains active until the browser actually closes.
        await browser.close();
    }
}

// The queue includes browser cleanup. A disconnected caller cannot open a
// second browser while the cancelled task is still closing its first browser.
let renderQueue = Promise.resolve();
const server = http.createServer((req, res) => {
    const pathname = url.parse(req.url).pathname;
    if (pathname === '/health') {
        res.setHeader('Content-Type', 'application/json; charset=UTF-8');
        res.end(JSON.stringify({ renderingCount, renderedCount }));
        return;
    }
    if (pathname !== '/render.html') {
        res.writeHead(404);
        res.end();
        return;
    }
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 15000);
    const disconnect = () => {
        if (!res.writableEnded) controller.abort();
    };
    res.on('close', disconnect);
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('aborted', () => controller.abort());
    req.on('end', () => {
        let options;
        try {
            options = JSON.parse(body);
        } catch {
            clearTimeout(deadline);
            res.writeHead(400);
            res.end('Invalid render request');
            return;
        }
        const run = async () => {
            if (controller.signal.aborted) return;
            renderingCount++;
            try {
                const result = await renderHtml(options, controller.signal);
                if (!controller.signal.aborted && !res.destroyed) res.end(result);
            } catch {
                console.error('renderer: render_failed');
                if (!res.destroyed) res.end('Error: page.render: render failed');
            } finally {
                renderingCount--;
                renderedCount++;
            }
        };
        const task = renderQueue.then(run);
        renderQueue = task.catch(() => console.error('renderer: task_failed'));
        task.finally(() => {
            clearTimeout(deadline);
            res.removeListener('close', disconnect);
            if (!res.writableEnded && !res.destroyed) {
                res.end('Error: page.render: render failed');
            }
        }).catch(() => {});
    });
});
server.listen(8050);
console.log('Server listening on http://0.0.0.0:8050');
