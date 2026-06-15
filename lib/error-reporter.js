// =============================================================================
// Error Reporter & Sanitizer  (lib/error-reporter.js)
// =============================================================================
//
// Lets every cron record errors that are SAFE to surface publicly on the System
// Health page. Two-layer safety:
//   1. ALLOWLIST — the reporter builds a clean { step, message, code, at } object
//      from known-safe inputs, never dumps a raw Error/stack.
//   2. SCRUB — a regex pass on the message text strips anything secret-looking
//      that slipped through (tokens, auth headers, creds-in-URLs, server paths,
//      internal IPs, env values).
//
// NEVER surfaced: GITHUB_TOKEN, Authorization headers, credentials, internal
// paths/IPs, env var values, secret-looking blobs.
// KEPT (safe + useful): the human message, which step failed, HTTP status,
// counts, public host names (without creds), timestamps.
//
// Usage in a cron:
//   const { ErrorLog, sanitizeMessage } = require('../lib/error-reporter.js');
//   const errors = new ErrorLog();
//   try { ... } catch (e) { errors.add('publishing data/current.json', e); }
//   // then include in heartbeat:  recent_errors: errors.list(), error_count: errors.count()
// =============================================================================

'use strict';

// --- patterns to scrub from any message text (defense layer 2) ---------------
const SCRUB = [
    // GitHub tokens
    [/gh[pousr]_[A-Za-z0-9]{20,}/g, '[token]'],
    [/github_pat_[A-Za-z0-9_]{20,}/g, '[token]'],
    // Authorization headers / bearer / token kv — capture the whole credential
    // that follows (JWTs, dotted tokens, base64), up to a clear delimiter.
    [/(authorization|bearer|token)\s*[:=]?\s*[A-Za-z0-9._\-+/=]{8,}/gi, '$1 [redacted]'],
    // creds embedded in URLs  user:pass@host
    [/\/\/[^/\s:@]+:[^/\s@]+@/g, '//[creds]@'],
    // secret-ish query params
    [/([?&](?:token|key|apikey|api_key|secret|password|pwd|auth|access_token)=)[^&\s]+/gi, '$1[redacted]'],
    // absolute server paths
    [/\/(?:home|opt|usr|root|mnt|var|tmp|etc)\/[^\s'":]+/g, '[path]'],
    // windows paths
    [/[A-Za-z]:\\[^\s'":]+/g, '[path]'],
    // internal IPs
    [/\b(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b/g, '[internal-ip]'],
    // long base64/hex blobs that look like secrets (40+ chars)
    [/\b[A-Za-z0-9+/=_-]{40,}\b/g, '[redacted-blob]'],
];

// Known env var names whose VALUES must never appear (scrubbed if present).
const SECRET_ENV_KEYS = ['GITHUB_TOKEN', 'GH_TOKEN', 'TOKEN', 'API_KEY', 'SECRET', 'PASSWORD', 'PRIVATE_KEY'];

function sanitizeMessage(input) {
    let msg = '';
    if (input == null) msg = '';
    else if (typeof input === 'string') msg = input;
    else if (input instanceof Error) msg = input.message || String(input);
    else { try { msg = String(input.message || input); } catch { msg = 'unprintable error'; } }

    // First: strip any literal env secret values that appear in the text.
    for (const k of SECRET_ENV_KEYS) {
        const v = process.env[k];
        if (v && v.length >= 6) {
            // escape regex specials in the value
            const esc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            msg = msg.replace(new RegExp(esc, 'g'), '[redacted]');
        }
    }
    // Then: pattern scrub.
    for (const [re, rep] of SCRUB) msg = msg.replace(re, rep);

    // Trim length — surface the gist, not a wall of text.
    msg = msg.replace(/\s+/g, ' ').trim();
    if (msg.length > 240) msg = msg.slice(0, 237) + '…';
    return msg || 'unspecified error';
}

// Extract a safe HTTP-ish status code if present, without leaking the URL.
function extractCode(input) {
    const s = (input && (input.status || input.statusCode || input.code)) || null;
    if (typeof s === 'number') return s;
    const m = String(input && input.message || input || '').match(/\b([1-5]\d{2})\b/);
    return m ? Number(m[1]) : null;
}

class ErrorLog {
    constructor(max = 25) { this._errs = []; this._max = max; }

    /**
     * Record an error safely.
     * @param {string} step  human-readable safe label of WHAT was happening
     *                        (e.g. "querying lock_info", "publishing data/current.json")
     * @param {Error|string} err  the error (will be sanitized)
     * @param {object} [extra]  optional safe counters, e.g. { batch: '3/7' }
     */
    add(step, err, extra = {}) {
        const entry = {
            step: sanitizeMessage(String(step)).slice(0, 120),  // step label is also scrubbed
            message: sanitizeMessage(err),
            code: extractCode(err),
            at: new Date().toISOString(),
        };
        // only allow safe, primitive extras (no objects that could carry secrets)
        for (const [k, v] of Object.entries(extra || {})) {
            if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
                entry[k] = typeof v === 'string' ? sanitizeMessage(v).slice(0, 80) : v;
            }
        }
        this._errs.push(entry);
        if (this._errs.length > this._max) this._errs.shift();
        return entry;
    }

    count() { return this._errs.length; }
    list() { return this._errs.slice(); }
    hasErrors() { return this._errs.length > 0; }

    /** Suggested heartbeat status from error volume + a total-attempts hint. */
    statusFor(totalAttempts = null) {
        if (this._errs.length === 0) return 'ok';
        if (totalAttempts && this._errs.length >= totalAttempts) return 'error'; // everything failed
        return 'partial'; // some failed
    }
}

module.exports = { ErrorLog, sanitizeMessage, extractCode };
