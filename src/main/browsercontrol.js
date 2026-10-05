'use strict';

const CDP = require('chrome-remote-interface');

/**
 * Drives the proxied Chromium over the Chrome DevTools Protocol so the Build
 * agent can navigate, read links, click, and crawl a whole site — every page
 * loaded goes through the proxy and is captured. A persistent CDP client is
 * kept to the first page target; it auto-(re)connects, launching the browser
 * via the injected `launch(url)` when nothing is listening yet.
 */
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

class BrowserControl {
  constructor(opts = {}) {
    this.port = opts.port || 9333;
    this.launch = opts.launch; // (url) => Promise | void  — opens the proxied browser w/ CDP
    this.client = null;
  }

  async _connect() {
    const client = await CDP({ host: '127.0.0.1', port: this.port });
    await client.Page.enable();
    await client.Runtime.enable();
    client.on('disconnect', () => {
      if (this.client === client) this.client = null;
    });
    this.client = client;
    return client;
  }

  async ensureClient(startUrl) {
    if (this.client) return this.client;
    // Try to connect to an already-open browser first.
    for (let i = 0; i < 2; i++) {
      try {
        return await this._connect();
      } catch (_) {
        /* not up yet */
      }
      await delay(400);
    }
    // Launch the proxied browser, then wait for CDP to come up.
    if (this.launch) {
      try { await this.launch(startUrl || 'about:blank'); } catch (_) {}
    }
    for (let i = 0; i < 25; i++) {
      await delay(500);
      try {
        return await this._connect();
      } catch (_) {
        /* keep waiting */
      }
    }
    throw new Error('Could not connect to the browser (CDP). Make sure the proxy browser can launch.');
  }

  async navigate(url, timeoutMs = 20000) {
    const client = await this.ensureClient(url);
    const { Page } = client;
    const loaded = Page.loadEventFired();
    await Page.navigate({ url });
    await Promise.race([loaded, delay(timeoutMs)]);
    await delay(600); // let late XHR/fetch fire through the proxy
    const cur = await this.currentUrl();
    return { ok: true, url: cur };
  }

  async evaluate(expression) {
    const client = await this.ensureClient();
    const { Runtime } = client;
    const res = await Runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.text || 'evaluation error');
    }
    return res.result && res.result.value;
  }

  async currentUrl() {
    try { return await this.evaluate('document.location.href'); } catch (_) { return null; }
  }

  async getLinks(sameOriginOnly = true) {
    const expr = `(() => {
      const origin = location.origin;
      const set = new Set();
      for (const a of document.querySelectorAll('a[href]')) {
        try {
          const u = new URL(a.href, location.href);
          if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
          if (${sameOriginOnly ? 'u.origin === origin' : 'true'}) set.add(u.href.split('#')[0]);
        } catch (_) {}
      }
      return Array.from(set);
    })()`;
    return (await this.evaluate(expr)) || [];
  }

  async click(selector) {
    const expr = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok:false, error:'no element matches ' + ${JSON.stringify(selector)} };
      el.click();
      return { ok:true };
    })()`;
    return await this.evaluate(expr);
  }

  /**
   * Breadth-first crawl: visit the start page, discover same-origin links, and
   * navigate each in turn (up to maxPages), generating captured traffic.
   * Also auto-submits/clicks nothing destructive by default.
   */
  async crawl(startUrl, opts = {}) {
    const maxPages = Math.min(opts.maxPages || 40, 300);
    await this.ensureClient(startUrl);
    let origin;
    try { origin = new URL(startUrl).origin; } catch (e) { return { error: 'Invalid start URL' }; }

    const visited = new Set();
    const queue = [startUrl];
    const pages = [];
    while (queue.length && visited.size < maxPages) {
      const url = queue.shift();
      if (visited.has(url)) continue;
      visited.add(url);
      try {
        await this.navigate(url);
        const links = await this.getLinks(true);
        pages.push({ url, links: links.length });
        for (const l of links) {
          if (!visited.has(l) && l.startsWith(origin) && queue.length + visited.size < maxPages) {
            queue.push(l);
          }
        }
      } catch (e) {
        pages.push({ url, error: String(e && e.message ? e.message : e) });
      }
    }
    return { crawled: pages.length, startUrl, pages };
  }

  async close() {
    if (this.client) {
      try { await this.client.close(); } catch (_) {}
      this.client = null;
    }
  }
}

module.exports = { BrowserControl };
