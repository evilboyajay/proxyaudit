'use strict';

const { EventEmitter } = require('events');
const { sendRequest } = require('./proxy/repeater');

/**
 * Content discovery — directory/file brute-forcing against a target, in the
 * spirit of dirb / gobuster. For every word in a wordlist (optionally combined
 * with extension suffixes such as '', '.php', '/') it issues a GET to
 * `${baseUrl}/${word}${ext}` through the shared repeater request helper.
 *
 * A response is treated as a "hit" when the server answered with any status
 * other than 404 and the request did not fail at the connection level. Hits,
 * progress, and completion are streamed as events so the renderer can fill a
 * results table live.
 *
 * Events:
 *   'disc-result'   { jobId, row: { path, status, length, mime } }
 *   'disc-progress' { jobId, done, total }
 *   'disc-done'     { jobId, hits }
 */

// Max hits retained per job (memory cap — the renderer keeps its own copy).
const MAX_RESULTS = 5000;

// A compact built-in list of ~150 commonly interesting paths. Used when the
// caller does not supply its own wordlist.
const DEFAULT_WORDLIST = [
  'admin', 'administrator', 'admin.php', 'admin/login', 'login', 'logout',
  'signin', 'signup', 'register', 'account', 'accounts', 'user', 'users',
  'profile', 'dashboard', 'panel', 'cpanel', 'controlpanel', 'wp-admin',
  'wp-login.php', 'wp-content', 'wp-includes', 'wp-json', 'xmlrpc.php',
  'administrator/index.php', 'phpmyadmin', 'pma', 'mysql', 'dbadmin',
  'adminer.php', 'server-status', 'server-info', 'status', 'health',
  'healthz', 'ping', 'metrics', 'debug', 'trace', 'test', 'tests', 'testing',
  'dev', 'development', 'staging', 'stage', 'demo', 'sandbox', 'tmp', 'temp',
  'api', 'api/v1', 'api/v2', 'api/v3', 'graphql', 'graphiql', 'rest',
  'swagger', 'swagger-ui', 'swagger.json', 'openapi.json', 'api-docs',
  'docs', 'documentation', 'doc', 'redoc', 'console', 'actuator',
  'actuator/health', 'actuator/env', 'env', '.env', '.env.local',
  '.env.backup', 'config', 'config.php', 'config.json', 'config.yml',
  'config.yaml', 'configuration', 'settings', 'settings.py', 'setup',
  'install', 'installer', 'web.config', 'app.config', 'appsettings.json',
  'robots.txt', 'sitemap.xml', 'humans.txt', 'security.txt',
  '.well-known/security.txt', 'crossdomain.xml', 'clientaccesspolicy.xml',
  'favicon.ico', '.htaccess', '.htpasswd', '.git', '.git/HEAD',
  '.git/config', '.gitignore', '.svn', '.svn/entries', '.hg', '.bzr',
  '.DS_Store', '.vscode', '.idea', 'backup', 'backups', 'backup.zip',
  'backup.sql', 'backup.tar.gz', 'db.sql', 'dump.sql', 'database.sql',
  'data', 'data.json', 'export', 'exports', 'download', 'downloads',
  'uploads', 'upload', 'files', 'file', 'media', 'images', 'img', 'assets',
  'static', 'public', 'private', 'secret', 'secrets', 'internal', 'includes',
  'inc', 'lib', 'libs', 'vendor', 'node_modules', 'src', 'app', 'application',
  'cgi-bin', 'bin', 'scripts', 'js', 'css', 'tmp/', 'logs', 'log',
  'error.log', 'access.log', 'debug.log', 'errors', 'old', 'new', 'archive',
  'cache', 'session', 'sessions', 'cookies', 'token', 'tokens', 'auth',
  'oauth', 'sso', 'saml', 'jwt', 'key', 'keys', 'id_rsa', 'credentials',
  'password', 'passwd', 'users.json', 'info.php', 'phpinfo.php', 'test.php',
  'shell.php', 'cmd.php', 'upload.php', 'index.php', 'index.html',
  'index.bak', 'README', 'README.md', 'CHANGELOG.md', 'LICENSE',
  'package.json', 'composer.json', 'composer.lock', 'yarn.lock',
  'Dockerfile', 'docker-compose.yml', 'Makefile', 'webpack.config.js',
];

class Discovery extends EventEmitter {
  constructor() {
    super();
    this.jobs = new Map(); // jobId -> { stopped, done, total, results, running }
  }

  /**
   * Begin a discovery job. Resolves to { jobId, hits } when the scan finishes
   * (or is stopped). Progress is streamed via events in the meantime.
   */
  async start(opts = {}) {
    const {
      jobId,
      baseUrl,
      wordlist,
      extensions,
      concurrency = 15,
      timeoutMs = 10000,
    } = opts;

    if (!jobId) return { error: 'Missing jobId' };
    if (!baseUrl) return { error: 'Missing baseUrl' };

    const base = String(baseUrl).replace(/\/+$/, '');
    const words =
      Array.isArray(wordlist) && wordlist.length ? wordlist : DEFAULT_WORDLIST;
    const exts =
      Array.isArray(extensions) && extensions.length ? extensions : [''];

    // Build the full candidate path list (word x extension).
    const paths = [];
    for (const raw of words) {
      const word = String(raw).trim().replace(/^\/+/, '');
      if (!word) continue;
      for (const ext of exts) {
        paths.push(word + String(ext || ''));
      }
    }

    const job = {
      stopped: false,
      running: true,
      done: 0,
      total: paths.length,
      results: [],
    };
    this.jobs.set(jobId, job);

    const workers = Math.max(1, Math.min(Number(concurrency) || 15, 100));
    let next = 0;

    const worker = async () => {
      while (true) {
        if (job.stopped) return;
        const i = next++;
        if (i >= paths.length) return;
        const candidate = paths[i];
        const url = base + '/' + candidate;
        let res;
        try {
          res = await sendRequest({ method: 'GET', url, timeoutMs });
        } catch (e) {
          res = { error: e.message };
        }
        job.done += 1;
        // A hit = reachable (no connection error) and not a 404.
        if (res && !res.error && res.status !== 404) {
          const row = {
            path: '/' + candidate,
            status: res.status,
            length: res.length,
            mime: res.mime || '',
          };
          if (job.results.length < MAX_RESULTS) job.results.push(row);
          if (!job.stopped) this.emit('disc-result', { jobId, row });
        }
        if (!job.stopped) {
          this.emit('disc-progress', { jobId, done: job.done, total: job.total });
        }
      }
    };

    const pool = [];
    for (let w = 0; w < workers; w++) pool.push(worker());
    await Promise.all(pool);

    job.running = false;
    const hits = job.results.length;
    this.emit('disc-done', { jobId, hits });
    return { jobId, hits };
  }

  /** Signal a running job to stop after in-flight requests settle. */
  stop(jobId) {
    const job = this.jobs.get(jobId);
    if (job) job.stopped = true;
    return !!job;
  }

  /** Current results (hits) collected for a job. */
  getResults(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return { error: 'Unknown job' };
    return {
      jobId,
      done: job.done,
      total: job.total,
      running: job.running,
      stopped: job.stopped,
      rows: job.results,
    };
  }
}

module.exports = { Discovery, DEFAULT_WORDLIST };
