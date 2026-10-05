'use strict';

/**
 * In-memory capture store. Holds HTTP flows and WebSocket connections for the
 * life of the session. Kept deliberately simple; the renderer gets light
 * summaries for lists and fetches full detail on demand.
 */
class Store {
  constructor(limit = 10000) {
    this.limit = limit;
    this.flows = [];
    this.flowIndex = new Map(); // id -> flow
    this.ws = [];
    this.wsIndex = new Map(); // id -> { ...conn, messages: [] }
  }

  addFlow(flow) {
    if (this.flowIndex.has(flow.id)) return;
    this.flows.push(flow);
    this.flowIndex.set(flow.id, flow);
    if (this.flows.length > this.limit) {
      const removed = this.flows.shift();
      this.flowIndex.delete(removed.id);
    }
  }

  updateFlow(flow) {
    // flow objects are mutated in place by the engine; just ensure presence
    if (!this.flowIndex.has(flow.id)) this.addFlow(flow);
  }

  getFlow(id) {
    return this.flowIndex.get(id) || null;
  }

  summary(flow) {
    return {
      id: flow.id,
      ts: flow.ts,
      method: flow.method,
      scheme: flow.scheme,
      host: flow.host,
      path: flow.path,
      url: flow.url,
      status: flow.response ? flow.response.status : null,
      mime: flow.response ? flow.response.mime : '',
      length: flow.response ? flow.response.length || 0 : 0,
      durationMs: flow.durationMs,
      intercepted: !!flow.intercepted,
    };
  }

  listFlows() {
    return this.flows.map((f) => this.summary(f));
  }

  /**
   * Distinct JavaScript responses captured, newest content wins per URL.
   * Used by the "Audit all JS" feature.
   */
  jsFiles() {
    const byUrl = new Map();
    for (const f of this.flows) {
      const res = f.response;
      if (!res || !res.body) continue;
      const mime = (res.mime || '').toLowerCase();
      const looksJs =
        mime.includes('javascript') ||
        mime.includes('ecmascript') ||
        /\.m?js(\?|$)/i.test(f.path || '');
      if (!looksJs) continue;
      byUrl.set(f.url, {
        url: f.url,
        flowId: f.id,
        length: res.body.length,
        content: res.body,
      });
    }
    return Array.from(byUrl.values());
  }

  // ---- WebSocket ----
  addWs(conn) {
    const record = { ...conn, messages: [], closed: false };
    this.ws.push(record);
    this.wsIndex.set(conn.id, record);
    if (this.ws.length > 500) {
      const removed = this.ws.shift();
      this.wsIndex.delete(removed.id);
    }
  }

  addWsMessage(connId, frame) {
    const rec = this.wsIndex.get(connId);
    if (!rec) return;
    rec.messages.push(frame);
    if (rec.messages.length > 5000) rec.messages.shift();
  }

  closeWs(connId) {
    const rec = this.wsIndex.get(connId);
    if (rec) rec.closed = true;
  }

  getWs(id) {
    return this.wsIndex.get(id) || null;
  }

  listWs() {
    return this.ws.map((w) => ({
      id: w.id,
      ts: w.ts,
      url: w.url,
      host: w.host,
      messageCount: w.messages.length,
      closed: w.closed,
    }));
  }

  clear() {
    this.flows = [];
    this.flowIndex.clear();
    this.ws = [];
    this.wsIndex.clear();
  }
}

module.exports = { Store };
