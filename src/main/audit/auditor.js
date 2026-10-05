'use strict';

/**
 * Claude-powered security auditor.
 *
 * Uses the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), which drives
 * the bundled Claude Code runtime. When no ANTHROPIC_API_KEY is present it
 * authenticates with the user's `claude login` credentials (their Claude
 * subscription) — so no API key management is required.
 *
 * The SDK is ESM-only; this CommonJS module loads it via dynamic import().
 */

let _sdk = null;
async function getSdk() {
  if (!_sdk) _sdk = await import('@anthropic-ai/claude-agent-sdk');
  return _sdk;
}

/**
 * Environment for the SDK subprocess with the Anthropic API-key variables
 * stripped, so it authenticates with the user's `claude login` (claude.ai
 * OAuth) session instead of a (possibly invalid) ANTHROPIC_API_KEY that would
 * otherwise take precedence and cause 401s.
 */
function sdkEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

const MAX_BODY_CHARS = 20000; // keep prompts bounded

function clip(str, n = MAX_BODY_CHARS) {
  if (str == null) return '';
  str = String(str);
  return str.length > n
    ? str.slice(0, n) + `\n\n...[truncated ${str.length - n} chars]...`
    : str;
}

function headerBlock(headers) {
  if (!headers) return '(none)';
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

const SYSTEM_PROMPT = `You are a senior application security engineer performing a focused security review for an authorized penetration test. You are reviewing traffic captured by the tester's own proxy against targets they are permitted to test.

Report ONLY concrete, evidence-based findings grounded in the material provided. For each finding use exactly this format:

### <Short title>
- **Severity:** Critical | High | Medium | Low | Info
- **Category:** (e.g. Broken Access Control, Injection, Secrets Exposure, Sensitive Data, Security Misconfiguration, CORS, XSS, SSRF, CSRF, Auth)
- **Evidence:** the specific header/parameter/line that shows the issue
- **Impact:** what an attacker could achieve
- **Recommendation:** the concrete fix

If nothing noteworthy is present, say "No significant issues identified." Be concise. Do not invent endpoints, parameters, or values that are not in the provided material. Do not use any tools — analyze only what is given.`;

function buildEndpointPrompt(flow) {
  const req = flow.request || {};
  const res = flow.response || {};
  return `Review this single HTTP endpoint exchange for security issues.

=== REQUEST ===
${flow.method} ${flow.url}
${headerBlock(req.headers)}

${clip(req.body)}

=== RESPONSE ===
HTTP ${res.status || '?'} ${res.statusMessage || ''}
${headerBlock(res.headers)}

${clip(res.body)}

Focus on: authentication/authorization gaps, IDOR, injection reflected in the response, secrets or tokens in URL/headers/body, sensitive data exposure (PII, internal paths, stack traces), insecure CORS, missing security headers, cookie flags (HttpOnly/Secure/SameSite), and verbose error disclosure.`;
}

function buildJsPrompt(url, content) {
  return `Review this JavaScript file served to the browser for security issues.

URL: ${url}

=== SOURCE ===
${clip(content, 45000)}

Focus on: hard-coded secrets / API keys / tokens, internal or hidden API endpoints and parameters, dangerous sinks (innerHTML, document.write, eval, Function, postMessage handlers without origin checks), DOM XSS patterns, insecure direct object references in client-side logic, exposed debug/admin flags, overly permissive CORS or fetch usage, and sensitive comments.`;
}

/**
 * Run one audit. Streams assistant text to onDelta(text) and resolves with
 * the full report plus usage metadata. `model` is an alias the CLI resolves
 * (e.g. 'sonnet', 'opus', 'haiku').
 */
class AuthError extends Error {}

async function runAudit({ prompt, model, onDelta }) {
  const { query } = await getSdk();

  // Abort the whole query as soon as we see an auth failure, instead of
  // letting the runtime burn through ~10 exponential-backoff retries.
  const controller = new AbortController();

  const options = {
    systemPrompt: SYSTEM_PROMPT,
    // Pure analysis: grant no tools so the model only reasons over the input.
    allowedTools: [],
    permissionMode: 'default',
    maxTurns: 1,
    abortController: controller,
    env: sdkEnv(),
  };
  if (model) options.model = model; // falsy => account default

  let text = '';
  let usage = null;
  let cost = null;
  let authFailed = false;

  try {
    for await (const msg of query({ prompt, options })) {
      if (msg.type === 'system' && msg.subtype === 'api_retry') {
        if (msg.error_status === 401 || /auth/i.test(msg.error || '')) {
          authFailed = true;
          controller.abort();
          break;
        }
      } else if (msg.type === 'assistant' && msg.message && msg.message.content) {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text) {
            text += block.text;
            if (onDelta) onDelta(block.text);
          }
        }
      } else if (msg.type === 'result') {
        if (typeof msg.result === 'string' && !text) {
          text = msg.result;
          if (onDelta) onDelta(msg.result);
        }
        usage = msg.usage || null;
        cost = typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : null;
        if (msg.subtype && msg.subtype !== 'success' && !text) {
          text = `Audit did not complete: ${msg.subtype}`;
        }
      }
    }
  } catch (e) {
    // AbortError is expected when we cancel on auth failure.
    if (!authFailed && !/abort/i.test(e.message || '')) throw e;
  }

  if (authFailed) {
    throw new AuthError(
      'Claude authentication failed (401). Run `claude login` in a terminal, or set an ANTHROPIC_API_KEY, then try again.'
    );
  }

  return { report: text.trim(), usage, cost };
}

async function auditEndpoint(flow, opts = {}) {
  return runAudit({ prompt: buildEndpointPrompt(flow), ...opts });
}

async function auditJs(url, content, opts = {}) {
  return runAudit({ prompt: buildJsPrompt(url, content), ...opts });
}

/** Quick connectivity/auth check so the UI can tell the user to run `claude login`. */
async function checkAuth() {
  try {
    const { query } = await getSdk();
    const controller = new AbortController();
    let ok = false;
    let authFailed = false;
    try {
      for await (const msg of query({
        prompt: 'Reply with the single word: OK',
        options: { model: 'haiku', allowedTools: [], maxTurns: 1, abortController: controller, env: sdkEnv() },
      })) {
        if (msg.type === 'system' && msg.subtype === 'api_retry') {
          if (msg.error_status === 401 || /auth/i.test(msg.error || '')) {
            authFailed = true;
            controller.abort();
            break;
          }
        } else if (msg.type === 'result' && msg.subtype === 'success') {
          ok = true;
        }
      }
    } catch (e) {
      if (!authFailed && !/abort/i.test(e.message || '')) throw e;
    }
    if (authFailed) return { authenticated: false, error: 'not logged in (401)' };
    return { authenticated: ok };
  } catch (e) {
    return { authenticated: false, error: e.message };
  }
}

/** Generic one-shot Claude call for plugins (api.ai). Returns the text reply. */
async function ask(prompt, opts = {}) {
  const r = await runAudit({ prompt, model: opts.model });
  return r.report;
}

module.exports = { auditEndpoint, auditJs, checkAuth, ask };
