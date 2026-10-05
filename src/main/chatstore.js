'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

/**
 * Persistent chat history for the "Build" tab — Claude.ai-style conversations.
 *
 * Each conversation is one JSON file under ~/.proxyaudit/chats/<id>.json, and a
 * lightweight index.json keeps the list (id/title/updatedAt/messageCount) so the
 * sidebar renders without reading every conversation. Everything is defensive:
 * missing/corrupt files degrade gracefully rather than throwing.
 *
 *   list()                      -> [{id,title,updatedAt,messageCount}]  (newest first)
 *   create(title?)              -> {id,title,sessionId,messages,createdAt,updatedAt}
 *   get(id)                     -> full record or null
 *   appendMessage(id, {role,content,meta}) -> message record
 *   setSession(id, sessionId)   -> record
 *   rename(id, title)           -> record
 *   remove(id)                  -> true/false
 *   clear()                     -> true
 *
 * role is one of 'user' | 'assistant' | 'tool' | 'tool_result'.
 * The title is derived from the first user message when a chat is untitled.
 */
class ChatStore {
  constructor(opts = {}) {
    this.dir =
      opts.dir || path.join(os.homedir(), '.proxyaudit', 'chats');
    this.indexPath = path.join(this.dir, 'index.json');
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch (_) {
      /* ignore */
    }
  }

  // ---- low-level helpers -------------------------------------------------
  _chatPath(id) {
    // Guard against path traversal from a malformed id.
    const safe = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
    return path.join(this.dir, safe + '.json');
  }

  _readJson(p, fallback) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (_) {
      return fallback;
    }
  }

  _writeJson(p, data) {
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(data, null, 2));
      return true;
    } catch (_) {
      return false;
    }
  }

  _readIndex() {
    const idx = this._readJson(this.indexPath, []);
    return Array.isArray(idx) ? idx : [];
  }

  _writeIndex(list) {
    this._writeJson(this.indexPath, list);
  }

  _readChat(id) {
    const rec = this._readJson(this._chatPath(id), null);
    if (!rec || typeof rec !== 'object') return null;
    if (!Array.isArray(rec.messages)) rec.messages = [];
    rec.id = rec.id || id;
    return rec;
  }

  /** Recompute one chat's index entry and persist the index (newest first). */
  _touchIndex(rec) {
    const list = this._readIndex().filter((e) => e && e.id !== rec.id);
    list.unshift({
      id: rec.id,
      title: rec.title || 'Untitled chat',
      updatedAt: rec.updatedAt || Date.now(),
      messageCount: Array.isArray(rec.messages) ? rec.messages.length : 0,
    });
    list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    this._writeIndex(list);
  }

  _deriveTitle(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return 'Untitled chat';
    return t.length > 60 ? t.slice(0, 57) + '…' : t;
  }

  // ---- public API --------------------------------------------------------
  /**
   * The conversation list for the sidebar. Rebuilt from on-disk chat files if
   * the index is missing or stale, so it survives a wiped index.json.
   */
  list() {
    const idx = this._readIndex();
    if (idx.length) return idx.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    // Rebuild from chat files if the index is absent/empty.
    let files = [];
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json') && f !== 'index.json');
    } catch (_) {
      return [];
    }
    const rebuilt = [];
    for (const f of files) {
      const rec = this._readChat(f.replace(/\.json$/, ''));
      if (!rec) continue;
      rebuilt.push({
        id: rec.id,
        title: rec.title || 'Untitled chat',
        updatedAt: rec.updatedAt || rec.createdAt || 0,
        messageCount: rec.messages.length,
      });
    }
    rebuilt.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (rebuilt.length) this._writeIndex(rebuilt);
    return rebuilt;
  }

  create(title) {
    const id = crypto.randomBytes(8).toString('hex');
    const now = Date.now();
    const rec = {
      id,
      title: title && String(title).trim() ? String(title).trim() : '',
      sessionId: null,
      messages: [],
      createdAt: now,
      updatedAt: now,
      titled: !!(title && String(title).trim()),
    };
    this._writeJson(this._chatPath(id), rec);
    this._touchIndex({ ...rec, title: rec.title || 'New chat' });
    return rec;
  }

  get(id) {
    return this._readChat(id);
  }

  appendMessage(id, msg = {}) {
    let rec = this._readChat(id);
    if (!rec) rec = this.create();  // tolerate append to a vanished chat
    const entry = {
      role: msg.role || 'assistant',
      content: msg.content != null ? String(msg.content) : '',
      ts: Date.now(),
    };
    if (msg.meta !== undefined) entry.meta = msg.meta;
    rec.messages.push(entry);
    rec.updatedAt = entry.ts;
    // Derive the title from the first user message if still untitled.
    if (!rec.titled && entry.role === 'user' && entry.content.trim()) {
      rec.title = this._deriveTitle(entry.content);
      rec.titled = true;
    }
    this._writeJson(this._chatPath(rec.id), rec);
    this._touchIndex(rec);
    return entry;
  }

  setSession(id, sessionId) {
    const rec = this._readChat(id);
    if (!rec) return null;
    rec.sessionId = sessionId || null;
    rec.updatedAt = Date.now();
    this._writeJson(this._chatPath(rec.id), rec);
    this._touchIndex(rec);
    return rec;
  }

  rename(id, title) {
    const rec = this._readChat(id);
    if (!rec) return null;
    rec.title = title && String(title).trim() ? String(title).trim() : 'Untitled chat';
    rec.titled = true;
    rec.updatedAt = Date.now();
    this._writeJson(this._chatPath(rec.id), rec);
    this._touchIndex(rec);
    return rec;
  }

  remove(id) {
    let ok = false;
    try {
      fs.unlinkSync(this._chatPath(id));
      ok = true;
    } catch (_) {
      /* already gone */
    }
    const list = this._readIndex().filter((e) => e && e.id !== id);
    this._writeIndex(list);
    return ok;
  }

  clear() {
    let files = [];
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    } catch (_) {
      files = [];
    }
    for (const f of files) {
      try {
        fs.unlinkSync(path.join(this.dir, f));
      } catch (_) {
        /* ignore */
      }
    }
    this._writeIndex([]);
    return true;
  }
}

module.exports = { ChatStore };
