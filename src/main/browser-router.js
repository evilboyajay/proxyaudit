'use strict';

/**
 * BrowserRouter — one browser-control surface the agent uses, backed by two
 * executors:
 *   1. the ProxyAudit Chrome extension (the user's own Chrome), when connected
 *   2. the launched, CDP-controlled proxied Chromium, as a fallback
 *
 * The extension is preferred whenever it is connected, so the agent drives the
 * user's real browser ("all visiting/info-gathering done by our extension; what
 * to do and where to go sent by our Claude build"). If the extension is not
 * loaded, everything transparently falls back to the CDP browser, so existing
 * behavior is unchanged.
 *
 * Exposes the BrowserControl surface the agent's MCP tools call:
 * navigate / getLinks / click / evaluate / currentUrl / crawl, plus readPage.
 */
class BrowserRouter {
  constructor(opts = {}) {
    this.cdp = opts.cdp || null; // BrowserControl
    this.ext = opts.ext || null; // ExtensionBridge
  }

  /** Which executor handles calls right now. */
  _active() {
    if (this.ext && this.ext.isConnected()) return this.ext;
    return this.cdp;
  }

  /** Human-readable name of the active channel (for status/log). */
  activeChannel() {
    return this.ext && this.ext.isConnected() ? 'extension' : 'cdp';
  }

  async navigate(url, timeoutMs) {
    return this._active().navigate(url, timeoutMs);
  }

  async getLinks(sameOriginOnly = true) {
    return this._active().getLinks(sameOriginOnly);
  }

  async click(selector) {
    return this._active().click(selector);
  }

  async evaluate(expression) {
    return this._active().evaluate(expression);
  }

  async currentUrl() {
    return this._active().currentUrl();
  }

  async crawl(startUrl, opts) {
    return this._active().crawl(startUrl, opts);
  }

  /** Rich page read — only the extension implements it; CDP approximates. */
  async readPage(maxChars = 12000) {
    const a = this._active();
    if (typeof a.readPage === 'function') return a.readPage(maxChars);
    // CDP fallback: title + visible text + links via evaluate.
    const expr = `(() => ({
      url: location.href,
      title: document.title,
      text: (document.body ? document.body.innerText : '').slice(0, ${Number(maxChars) || 12000}),
      links: Array.from(document.querySelectorAll('a[href]')).map(a => a.href).slice(0, 300)
    }))()`;
    return a.evaluate(expr);
  }
}

module.exports = { BrowserRouter };
