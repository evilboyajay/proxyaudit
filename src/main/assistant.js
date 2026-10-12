'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { z } = require('zod');
const { sendRequest } = require('./proxy/repeater');
const { enumerateSubdomains } = require('./recon');
const { claudeExecutable } = require('./sdkpath');

/**
 * "Build" — Claude Code for security researchers.
 *
 * An agentic chat backed by the Claude Agent SDK. Claude gets:
 *  - in-process proxy tools (list/get/search captured flows, replay requests)
 *  - in read-only mode: Read/Grep/Glob/WebFetch
 *  - in agent mode: the full Claude Code toolset (Write/Edit/Bash/...) so it can
 *    build and run PoCs/exploits in a workspace.
 *
 * Auth uses the user's `claude login` session (ANTHROPIC_API_KEY stripped).
 */

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'WebFetch'];
// In agent mode the Build agent can also spawn SUBAGENTS via Task (Claude-Code
// style fan-out), so one conversation can parallelise a large audit.
const AGENT_TOOLS = ['Read', 'Grep', 'Glob', 'WebFetch', 'Write', 'Edit', 'Bash', 'TodoWrite', 'Task'];

// Subagent types the main agent can launch with Task. They inherit the proxy
// tools and focus on analysis (no Write/Edit/Bash — the main agent owns PoC
// building) so several can safely run in parallel over different endpoints/hosts.
const SUBAGENT_TOOLS = [
  'mcp__proxy__list_flows', 'mcp__proxy__get_flow', 'mcp__proxy__search_flows',
  'mcp__proxy__send_request', 'mcp__proxy__list_js_files', 'mcp__proxy__enum_subdomains',
  'mcp__proxy__crawl_site', 'mcp__proxy__browser_navigate', 'mcp__proxy__browser_get_links',
  'mcp__proxy__browser_click', 'mcp__proxy__browser_read_page', 'mcp__proxy__open_in_browser',
  'Read', 'Grep', 'Glob', 'WebFetch',
];
const SUBAGENTS = {
  'security-auditor': {
    description:
      'Audit a specific target slice — one endpoint, host, parameter, or JS file — for vulnerabilities and report findings with evidence (flow ids, exact snippets, repro). Launch several in parallel to cover a large attack surface quickly.',
    tools: SUBAGENT_TOOLS,
    prompt:
      'You are a focused web-security auditor working as a subagent of a larger engagement. ' +
      'Audit ONLY the slice described in your task (an endpoint, host, parameter, or JS file). ' +
      'Use the proxy tools to read the relevant captured traffic (list_flows/get_flow/search_flows), ' +
      'review client-side JS (list_js_files), and verify suspicions non-destructively with send_request. ' +
      'Hunt for broken auth/session, IDOR & broken object-level authz, injection (SQLi/command/SSTI/XSS/SSRF/path traversal/XXE), ' +
      'access-control and business-logic flaws, CSRF, open redirects, and secret/PII exposure. ' +
      'Report a concise, evidence-based list of findings (flow id + exact snippet + severity + repro + remediation), ' +
      'or state clearly that the slice looks clean. Authorized testing only — do not attack out-of-scope targets.',
  },
  'recon': {
    description:
      'Map a target\'s attack surface: enumerate subdomains, crawl the site through the browser to generate traffic, and summarise the endpoints/technologies discovered. Use before deep auditing.',
    tools: SUBAGENT_TOOLS,
    prompt:
      'You are a reconnaissance subagent. Map the attack surface of the target you are given: ' +
      'use enum_subdomains for subdomains (CT logs), crawl_site / browser_navigate to load pages so their traffic is captured, ' +
      'and list_flows/list_js_files to inventory endpoints, parameters, auth mechanisms, and technologies. ' +
      'Return a structured summary of hosts, notable endpoints, and promising areas to audit next. Authorized testing only.',
  },
};

const SYSTEM_PROMPT = `You are a WORLD-CLASS offensive-security and exploit-development assistant embedded inside a web-security proxy (a Burp Suite alternative), working for an AUTHORIZED penetration tester. You operate ONLY against systems the tester is explicitly permitted to test; you never attack third parties, and you refuse requests that are clearly not authorized testing.

# Your capabilities (tools)
- mcp__proxy__list_flows — enumerate captured HTTP traffic (filter by host/method/status). Each line starts with "#<id>".
- mcp__proxy__get_flow — full request+response for one flow id (headers, body).
- mcp__proxy__search_flows — grep all captured flows (URLs, headers, bodies) for a substring.
- mcp__proxy__send_request — replay/tamper an arbitrary request to probe behaviour and verify findings (TLS validation disabled).
- mcp__proxy__open_in_browser — drive the proxied Chromium to a URL so new traffic is captured (crawl, trigger flows, generate coverage), then read it with list_flows/get_flow.
- mcp__proxy__list_js_files — list distinct JavaScript responses captured (great for source review of client-side logic, secrets, endpoints).
- mcp__proxy__crawl_site — autonomously crawl a whole site through the proxied browser: open the start URL and navigate every same-origin link (BFS, up to maxPages), so every page is loaded and all requests captured. Use this to map the full attack surface automatically.
- mcp__proxy__browser_navigate / browser_get_links / browser_click — drive the browser page-by-page: go to a URL, read its links, and click elements (buttons/menus/"load more") to trigger JS-driven requests. You control the browser; captured traffic appears via list_flows.
- mcp__proxy__browser_read_page — read the current page the browser is on: final URL, title, visible text, and links. Use it to see rendered/SPA content before deciding what to click or navigate.
- mcp__proxy__enum_subdomains — enumerate a domain's subdomains (Sublist3r-style) from public CT logs (crt.sh), passively. Use it at the start of an engagement to map the full attack surface, then audit each discovered host.
- Note: the browser you drive is either the launched proxied Chromium OR, when the ProxyAudit Chrome extension is connected, the user's own Chrome (same tools, same behaviour — you send where to go and what to do, the extension does the visiting and info-gathering). Traffic is captured either way.
- Read/Grep/Glob/WebFetch for reference material and the workspace.
- In AGENT MODE you also get Write/Edit/Bash/TodoWrite: write and RUN working exploit code, PoCs, fuzzers, and reports in the workspace.
- In AGENT MODE you can also fan out with the Task tool to subagents: "security-auditor" (audit one endpoint/host/param/JS file in depth) and "recon" (map a target's attack surface). Launch SEVERAL in parallel to cover a large attack surface fast, then synthesise their findings — the same way Claude Code delegates to subagents.

# How you work — be autonomous and methodical
You are an agent: keep working until the objective is met, using tools rather than asking permission for each step. Follow a professional methodology:
1. RECON — enumerate the attack surface. When given a domain, start with enum_subdomains to discover hosts (CT logs), then audit each authorized host: crawl_site / browser_navigate each one so its traffic is captured. Loop list_flows (paginate/filter by host) and get_flow to understand real endpoints, auth, parameters, cookies/tokens, and technologies. Use list_js_files to review client-side code for hidden endpoints and secrets. Use open_in_browser to crawl and generate more traffic when coverage is thin.
2. VULN ANALYSIS — reason about each endpoint for concrete bug classes grounded in the evidence you captured: broken auth / session, IDOR & broken object-level authz, injection (SQLi, command, SSTI, XSS, SSRF, path traversal, XXE), access control, business-logic flaws, CSRF, open redirect, insecure deserialization, secrets/PII exposure, misconfig, and info leaks.
3. EXPLOIT / PoC — prove it. Use send_request to tamper (swap ids, drop auth, inject payloads, replay) and confirm impact. In agent mode, write a clean, self-contained PoC/exploit script to the workspace and RUN it to demonstrate the issue end-to-end.
4. VERIFY — confirm the finding reproduces and distinguish true positives from noise. Note preconditions.

# Auditing ALL traffic on your own
When asked to audit/sweep everything: call list_flows to get the full inventory, then systematically get_flow the interesting ones (auth endpoints, APIs, anything with ids/params/tokens, admin/debug paths), search_flows for telltale strings (error, stack, token, password, key, admin, sql, debug), and list_js_files for client-side review. Don't stop after one or two flows — cover the surface, then report prioritized findings.

# Output discipline
Be concrete and evidence-based: cite the flow id, the exact header/param/response snippet that proves each claim. Never speculate about endpoints you haven't looked at. Rank findings by severity with clear reproduction steps and remediation. When you build a PoC, give its workspace path and how to run it. Keep everything scoped to authorized testing.`;

function sdkEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

class Assistant {
  constructor(opts = {}) {
    this.store = opts.store; // capture store (live reference)
    this.workspace = opts.workspace || path.join(os.homedir(), '.proxyaudit', 'workspace');
    fs.mkdirSync(this.workspace, { recursive: true });
    this._sdk = null;
    this._server = null;
    this._controllers = new Map(); // turnId -> AbortController
    // Optional hook injected by main: browse(url) -> Promise<{ok, browser?, error?}>.
    // Drives the proxied Chromium so the open_in_browser tool can generate traffic.
    this.browse = opts.browse || null;
  }

  async _getSdk() {
    if (!this._sdk) this._sdk = await import('@anthropic-ai/claude-agent-sdk');
    return this._sdk;
  }

  _flowBrief(f) {
    const r = f.response;
    return `#${f.id} ${f.method} ${f.url} -> ${r ? r.status : '(pending)'} ${r ? (r.mime || '') : ''} ${r ? (r.length || 0) + 'B' : ''}`;
  }

  async _buildServer() {
    if (this._server) return this._server;
    const { createSdkMcpServer, tool } = await this._getSdk();
    const store = this.store;
    const txt = (t) => ({ content: [{ type: 'text', text: String(t) }] });
    const normUrl = (u) => {
      u = String(u || '').trim();
      if (!u) return '';
      return /^https?:\/\//i.test(u) ? u : 'http://' + u;
    };
    const noBrowser = () =>
      txt('Browser control is unavailable (could not drive the proxied Chromium over CDP).');

    const listFlows = tool(
      'list_flows',
      'List captured HTTP flows (proxy history). Optionally filter by host substring, method, or status code. Returns one line per flow with its id.',
      { host: z.string().optional(), method: z.string().optional(), status: z.number().optional(), limit: z.number().optional() },
      async (args) => {
        let flows = store.listFlows();
        if (args.host) flows = flows.filter((f) => (f.host || '').includes(args.host));
        if (args.method) flows = flows.filter((f) => f.method === args.method.toUpperCase());
        if (args.status) flows = flows.filter((f) => f.status === args.status);
        flows = flows.slice(-(args.limit || 200));
        const full = flows.map((s) => store.getFlow(s.id)).filter(Boolean);
        const text = full.length ? full.map((f) => this._flowBrief(f)).join('\n') : '(no matching flows)';
        return { content: [{ type: 'text', text: `${full.length} flow(s):\n${text}` }] };
      }
    );

    const getFlow = tool(
      'get_flow',
      'Get the full request and response for one flow id (from list_flows).',
      { id: z.string() },
      async (args) => {
        const f = store.getFlow(args.id);
        if (!f) return { content: [{ type: 'text', text: 'Flow not found: ' + args.id }] };
        const req = f.request || {};
        const res = f.response || {};
        const H = (h) => Object.entries(h || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
        const text =
          `=== REQUEST ===\n${f.method} ${f.url}\n${H(req.headers)}\n\n${(req.body || '').slice(0, 20000)}\n\n` +
          `=== RESPONSE ===\nHTTP ${res.status || '?'} ${res.statusMessage || ''}\n${H(res.headers)}\n\n${(res.body || '').slice(0, 40000)}`;
        return { content: [{ type: 'text', text }] };
      }
    );

    const searchFlows = tool(
      'search_flows',
      'Search captured flows for a substring (case-insensitive) across URL, request/response headers and bodies. Returns matching flow ids.',
      { query: z.string(), limit: z.number().optional() },
      async (args) => {
        const q = args.query.toLowerCase();
        const hits = [];
        for (const s of store.listFlows()) {
          const f = store.getFlow(s.id);
          if (!f) continue;
          const hay = [
            f.url,
            JSON.stringify(f.request && f.request.headers),
            f.request && f.request.body,
            JSON.stringify(f.response && f.response.headers),
            f.response && f.response.body,
          ].join(' ').toLowerCase();
          if (hay.includes(q)) hits.push(this._flowBrief(f));
          if (hits.length >= (args.limit || 100)) break;
        }
        return { content: [{ type: 'text', text: hits.length ? hits.join('\n') : '(no matches)' }] };
      }
    );

    const sendReq = tool(
      'send_request',
      'Send an HTTP request (replay or tamper). Use to probe behaviour, test payloads, verify a vulnerability. TLS validation is disabled. Returns status, headers and body.',
      {
        method: z.string(),
        url: z.string(),
        headers: z.record(z.string(), z.string()).optional(),
        body: z.string().optional(),
      },
      async (args) => {
        const r = await sendRequest({
          method: args.method,
          url: args.url,
          headers: args.headers || {},
          body: args.body != null ? args.body : null,
        });
        if (r.error) return { content: [{ type: 'text', text: 'Request error: ' + r.error }] };
        const H = Object.entries(r.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
        return {
          content: [{ type: 'text', text: `HTTP ${r.status} ${r.statusMessage || ''} (${r.durationMs}ms)\n${H}\n\n${(r.body || '').slice(0, 40000)}` }],
        };
      }
    );

    const openInBrowser = tool(
      'open_in_browser',
      'Navigate the proxied Chromium browser to a URL so its traffic is captured by the proxy. Use this to crawl a target, trigger flows, or generate coverage, then inspect the new traffic with list_flows/get_flow. Returns once the browser has been told to open the URL (give the page a moment, then call list_flows).',
      { url: z.string() },
      async (args) => {
        if (typeof this.browse !== 'function') {
          return { content: [{ type: 'text', text: 'Browser control is not available in this environment (no browse() injected). Ask the user to open the target in the proxy\'s testing browser, then I can audit the captured traffic.' }] };
        }
        let url = String(args.url || '').trim();
        if (!url) return { content: [{ type: 'text', text: 'No URL provided.' }] };
        if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
        try {
          const r = await this.browse(url);
          if (r && r.ok === false) {
            return { content: [{ type: 'text', text: 'Could not open browser: ' + (r.error || 'unknown error') }] };
          }
          return { content: [{ type: 'text', text: `Opened ${url} in the proxied browser${r && r.browser ? ' (' + r.browser + ')' : ''}. Traffic is being captured — call list_flows (optionally filter by host) in a moment to see new requests.` }] };
        } catch (e) {
          return { content: [{ type: 'text', text: 'Could not open browser: ' + (e.message || String(e)) }] };
        }
      }
    );

    const listJsFiles = tool(
      'list_js_files',
      'List the distinct JavaScript responses captured in history (newest content per URL). Useful for client-side source review: hidden endpoints, API routes, secrets/keys, and dangerous sinks. Returns url, flow id and size; use get_flow on the id to read the full script.',
      { limit: z.number().optional() },
      async (args) => {
        const files = typeof store.jsFiles === 'function' ? store.jsFiles() : [];
        if (!files.length) return { content: [{ type: 'text', text: '(no JavaScript responses captured yet)' }] };
        const list = files.slice(0, args.limit || 200);
        const text = list
          .map((f) => `#${f.flowId} ${f.url} (${f.length || (f.content ? f.content.length : 0)}B)`)
          .join('\n');
        return { content: [{ type: 'text', text: `${files.length} distinct JS file(s):\n${text}` }] };
      }
    );

    const crawlSite = tool(
      'crawl_site',
      'Autonomously crawl a website through the proxied browser: open the start URL, discover all same-origin links and navigate each one (breadth-first, up to maxPages, default 40), so every page is loaded and all of its requests are captured by the proxy. Use this to map a site and get full traffic coverage, then audit with list_flows/get_flow. This is real browser control — pages are actually loaded.',
      { url: z.string(), maxPages: z.number().optional() },
      async (args) => {
        if (!this.browser) return noBrowser();
        const url = normUrl(args.url);
        if (!url) return txt('No URL provided.');
        try {
          const r = await this.browser.crawl(url, { maxPages: args.maxPages || 40 });
          if (r.error) return txt('Crawl failed: ' + r.error);
          const lines = (r.pages || []).slice(0, 60)
            .map((p) => `- ${p.url}${p.error ? ' [error: ' + p.error + ']' : ' (' + p.links + ' links)'}`)
            .join('\n');
          return txt(`Crawled ${r.crawled} page(s) from ${r.startUrl}. All traffic captured — call list_flows to inspect.\n${lines}`);
        } catch (e) {
          return txt('Crawl failed: ' + (e.message || String(e)));
        }
      }
    );
    const browserNavigate = tool(
      'browser_navigate',
      'Navigate the proxied browser to a single URL and wait for it to load (its requests are captured). Returns the final URL.',
      { url: z.string() },
      async (args) => {
        if (!this.browser) return noBrowser();
        const url = normUrl(args.url);
        if (!url) return txt('No URL provided.');
        try {
          const r = await this.browser.navigate(url);
          return txt('Navigated to ' + (r.url || url) + '. Traffic captured — use list_flows.');
        } catch (e) {
          return txt('Navigate failed: ' + (e.message || String(e)));
        }
      }
    );
    const browserGetLinks = tool(
      'browser_get_links',
      'Return the links on the page currently open in the proxied browser (same-origin by default). Useful to decide what to click/navigate next.',
      { sameOrigin: z.boolean().optional() },
      async (args) => {
        if (!this.browser) return noBrowser();
        try {
          const links = await this.browser.getLinks(args.sameOrigin !== false);
          return txt(links.length ? links.join('\n') : '(no links found on the current page)');
        } catch (e) {
          return txt('Failed: ' + (e.message || String(e)));
        }
      }
    );
    const browserClick = tool(
      'browser_click',
      'Click an element (CSS selector) on the page currently open in the proxied browser, to trigger navigation or JavaScript-driven requests (buttons, menus, "load more", etc.). Captures any resulting traffic.',
      { selector: z.string() },
      async (args) => {
        if (!this.browser) return noBrowser();
        try {
          const r = await this.browser.click(args.selector);
          await new Promise((x) => setTimeout(x, 700));
          return txt(r && r.ok
            ? 'Clicked ' + args.selector + '. Check list_flows for new traffic.'
            : 'Click failed: ' + ((r && r.error) || 'no matching element'));
        } catch (e) {
          return txt('Click failed: ' + (e.message || String(e)));
        }
      }
    );

    const browserReadPage = tool(
      'browser_read_page',
      'Read the page currently open in the browser: its final URL, title, visible text, and links. Use this to understand what the agent-controlled browser is actually seeing (rendered content, SPA state) before deciding what to click or navigate next. When the ProxyAudit Chrome extension is connected, this reads the user\'s real Chrome tab.',
      { maxChars: z.number().optional() },
      async (args) => {
        if (!this.browser) return noBrowser();
        try {
          const p = await this.browser.readPage(args.maxChars || 12000);
          if (!p) return txt('(could not read the current page)');
          const links = (p.links || []).slice(0, 80).join('\n');
          return txt(
            `URL: ${p.url}\nTitle: ${p.title || ''}\n\n--- visible text ---\n${p.text || ''}\n\n--- links (${(p.links || []).length}) ---\n${links}`
          );
        } catch (e) {
          return txt('Read failed: ' + (e.message || String(e)));
        }
      }
    );

    const enumSubdomains = tool(
      'enum_subdomains',
      'Enumerate subdomains of a domain (like Sublist3r) using public Certificate Transparency logs (crt.sh) — passive OSINT, no packets sent to the target. Returns the discovered hostnames. Use this to map a target\'s attack surface, then audit each host (navigate/crawl it through the browser so its traffic is captured, then review with list_flows/get_flow). Only enumerate and audit domains you are authorized to test.',
      { domain: z.string() },
      async (args) => {
        const d = String(args.domain || '').trim();
        if (!d) return txt('No domain provided.');
        try {
          const r = await enumerateSubdomains(d);
          if (!r.count) return txt(`No subdomains found for ${r.domain} in CT logs.`);
          return txt(
            `Found ${r.count} subdomain(s) for ${r.domain} (via crt.sh):\n` +
            r.subdomains.join('\n') +
            `\n\nTo audit them: for each in-scope host, call browser_navigate/crawl_site (https://<host>) so its traffic is captured, then review with list_flows/get_flow/list_js_files. Enumerate & audit only what you are authorized to test.`
          );
        } catch (e) {
          return txt('Subdomain enumeration failed: ' + (e.message || String(e)));
        }
      }
    );

    this._server = createSdkMcpServer({
      name: 'proxy',
      version: '1.0.0',
      tools: [listFlows, getFlow, searchFlows, sendReq, openInBrowser, listJsFiles,
        crawlSite, browserNavigate, browserGetLinks, browserClick, browserReadPage,
        enumSubdomains],
    });
    return this._server;
  }

  /**
   * Run one chat turn. Streams events via onEvent and resolves when done.
   * onEvent types: 'text' {text}, 'tool_use' {name, input}, 'tool_result'
   * {name, text}, 'thinking' {text}, 'done' {sessionId, cost, subtype, error}.
   */
  async chat({ turnId, message, sessionId, model, agentMode, onEvent }) {
    const { query } = await this._getSdk();
    const server = await this._buildServer();
    const controller = new AbortController();
    if (turnId) this._controllers.set(turnId, controller);

    const proxyTools = [
      'mcp__proxy__list_flows',
      'mcp__proxy__get_flow',
      'mcp__proxy__search_flows',
      'mcp__proxy__send_request',
      'mcp__proxy__open_in_browser',
      'mcp__proxy__list_js_files',
      'mcp__proxy__crawl_site',
      'mcp__proxy__browser_navigate',
      'mcp__proxy__browser_get_links',
      'mcp__proxy__browser_click',
      'mcp__proxy__browser_read_page',
      'mcp__proxy__enum_subdomains',
    ];
    const allowedTools = proxyTools.concat(agentMode ? AGENT_TOOLS : READ_ONLY_TOOLS);

    const options = {
      systemPrompt: SYSTEM_PROMPT,
      mcpServers: { proxy: server },
      allowedTools,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      cwd: this.workspace,
      env: sdkEnv(),
      pathToClaudeCodeExecutable: claudeExecutable(),
      abortController: controller,
      includePartialMessages: true, // stream text/thinking live, not just at the end
      // Don't load the user's global Claude Code settings/MCP servers (e.g.
      // Claude Docs) — isolate to OUR in-process proxy server + built-in tools,
      // so the proxy tools are always directly available (not deferred/missing).
      settingSources: [],
    };
    // In agent mode, expose subagents the main agent can fan out to via Task.
    if (agentMode) options.agents = SUBAGENTS;
    // A falsy model means "use the Claude Code account default".
    if (model) options.model = model;
    if (sessionId) options.resume = sessionId;

    let newSessionId = sessionId || null;
    let authFailed = false;
    let sawTextDelta = false; // whether the current assistant message streamed text
    // Emit exactly one 'done' no matter how the turn ends (result, error, abort,
    // or a stream that simply stops) so the UI never stays wedged "busy".
    let doneSent = false;
    const emitDone = (extra) => {
      if (doneSent) return;
      doneSent = true;
      onEvent({ type: 'done', sessionId: newSessionId, ...(extra || {}) });
    };
    try {
      for await (const msg of query({ prompt: message, options })) {
        if (msg.type === 'system') {
          if (msg.session_id) newSessionId = msg.session_id;
          if (msg.subtype === 'api_retry' && (msg.error_status === 401 || /auth/i.test(msg.error || ''))) {
            authFailed = true;
            controller.abort();
            break;
          }
        } else if (msg.type === 'stream_event' && msg.event) {
          // Live token streaming (text + thinking) as the model writes.
          const ev = msg.event;
          if (ev.type === 'content_block_delta' && ev.delta) {
            if (ev.delta.type === 'text_delta' && ev.delta.text) {
              sawTextDelta = true;
              onEvent({ type: 'text', text: ev.delta.text });
            } else if (ev.delta.type === 'thinking_delta' && ev.delta.thinking) {
              onEvent({ type: 'thinking', text: ev.delta.thinking });
            }
          }
        } else if (msg.type === 'assistant' && msg.message && msg.message.content) {
          // The complete message: emit tool calls; text/thinking already streamed
          // via stream_event (only re-emit text if nothing streamed, as a fallback).
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text) {
              if (!sawTextDelta) onEvent({ type: 'text', text: block.text });
            } else if (block.type === 'tool_use') {
              onEvent({ type: 'tool_use', name: block.name, input: block.input });
            }
          }
          sawTextDelta = false;
        } else if (msg.type === 'user' && msg.message && Array.isArray(msg.message.content)) {
          for (const block of msg.message.content) {
            if (block.type === 'tool_result') {
              const text = Array.isArray(block.content)
                ? block.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
                : String(block.content || '');
              onEvent({ type: 'tool_result', text: (text || '').slice(0, 4000) });
            }
          }
        } else if (msg.type === 'result') {
          if (msg.session_id) newSessionId = msg.session_id;
          emitDone({
            cost: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : null,
            subtype: msg.subtype,
          });
        }
      }
    } catch (e) {
      if (!authFailed && !/abort/i.test(e.message || '')) {
        emitDone({ error: e.message });
        if (turnId) this._controllers.delete(turnId);
        return { sessionId: newSessionId, error: e.message };
      }
    } finally {
      if (turnId) this._controllers.delete(turnId);
    }
    if (authFailed) {
      emitDone({ error: 'Not signed in to Claude. Sign in from Settings.' });
      return { sessionId: newSessionId, error: 'auth' };
    }
    // Normal completion, abort, or a stream that ended without a result message:
    // make sure the UI is released.
    emitDone({});
    return { sessionId: newSessionId };
  }

  stop(turnId) {
    const c = this._controllers.get(turnId);
    if (c) {
      c.abort();
      this._controllers.delete(turnId);
      return true;
    }
    return false;
  }
}

module.exports = { Assistant };
