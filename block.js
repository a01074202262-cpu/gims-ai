/**
 * block.js — Gims AI 입력 방어 모듈 (의존성 없음)
 * SQL/NoSQL/XSS/경로순회/명령인젝션/프로토타입오염/CRLF + 레이트리밋
 */
'use strict';

const PATTERNS = {
  sql: [
    /(\b)(UNION\s+(ALL\s+)?SELECT|SELECT\s+\S[\s\S]{0,80}?\s+FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+(TABLE|DATABASE)|ALTER\s+TABLE|TRUNCATE\s+TABLE|CREATE\s+(TABLE|DATABASE)|xp_cmdshell|sp_executesql)(\b)/i,
    /('|")\s*(OR|AND)\s*('|")?\s*\d+\s*(=|<|>|LIKE)\s*('|")?\s*\d+/i,
    /('|")\s*(OR|AND)\s+['"]?\w+['"]?\s*=\s*['"]?\w+/i,
    /;\s*(DROP|DELETE|UPDATE|INSERT|ALTER|CREATE|TRUNCATE)\b/i,
    /\b(INFORMATION_SCHEMA|SYSOBJECTS|SYSCOLUMNS|PG_CATALOG)\b/i,
    /\b(BENCHMARK|SLEEP|WAITFOR\s+DELAY|PG_SLEEP)\s*\(/i,
    /\bLOAD_FILE\s*\(|INTO\s+(OUT|DUMP)FILE\b/i,
    // SQL 주석: Accept */* 오탐 방지 — 앞에 공백/세미콜론이 있을 때만
    /(?:^|[\s;])(--)\s/,
    /(?:^|[\s;])\/\*[\s\S]*?\*\//,
  ],
  nosql: [
    /\$where\b/i,
    /\$(?:ne|gt|gte|lt|lte|in|nin|regex|exists|or|and|not|nor|expr)\b/i,
    /\{\s*["']\$/,
  ],
  xss: [
    /<\s*script\b/i,
    /<\s*\/\s*script\s*>/i,
    /javascript\s*:/i,
    /vbscript\s*:/i,
    /\bon(?:error|load|click|mouse\w*|focus|blur|submit|change|input|key\w*|touch\w*|drag\w*|drop|scroll|wheel|pointer\w*|animation\w*|transition\w*)\s*=/i,
    /<\s*(iframe|object|embed|applet|svg)\b/i,
    /expression\s*\(/i,
    /data\s*:\s*text\/html/i,
    /\bsrcdoc\s*=/i,
  ],
  path: [
    /\.\.[\\/]/,
    /%2e%2e[\\/]|%252e%252e/i,
    /\0/,
  ],
  cmd: [
    /(?:^|[\s;|&])(?:ls|cat|id|whoami|uname|curl|wget|nc|ncat|bash|sh|cmd|powershell|chmod|chown)\s/i,
    /\$\([^)]{1,80}\)|`[^`]{1,80}`/,
    /\|\s*(?:bash|sh|cmd|powershell)\b/i,
  ],
  proto: [
    /__proto__/i,
    /constructor\s*[.\[]\s*['"]?prototype/i,
  ],
  crlf: [
    /\r\n\s*(?:Set-Cookie|Location|Content-|X-)/i,
    /%0d%0a|%0a%0d/i,
  ],
};

const ALL_KEYS = Object.keys(PATTERNS);

// 브라우저가 항상 보내는 헤더는 검사 제외 (오탐 방지)
const SKIP_HEADERS = new Set([
  'accept', 'accept-language', 'accept-encoding', 'accept-charset',
  'user-agent', 'connection', 'content-length', 'content-type',
  'host', 'origin', 'referer', 'referrer', 'cookie',
  'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'sec-ch-ua-full-version-list',
  'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user',
  'cache-control', 'pragma', 'upgrade-insecure-requests',
  'dnt', 'te', 'priority', 'purpose', 'x-requested-with',
]);

const SAFE_ID = /^[a-z0-9_가-힣]{1,64}$/i;
const SAFE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SAFE_HEX = /^[a-f0-9]+$/i;

function scan(input, opts = {}) {
  if (input == null) return null;
  const str = typeof input === 'string' ? input : String(input);
  if (!str) return null;
  const maxLen = opts.maxLen != null ? opts.maxLen : 2_000_000;
  if (str.length > maxLen) return { type: 'size', pattern: 'payload too large' };
  const types = opts.types || ALL_KEYS;
  for (const type of types) {
    const list = PATTERNS[type];
    if (!list) continue;
    for (const re of list) {
      if (re.test(str)) return { type, pattern: String(re) };
    }
  }
  return null;
}

function scanDeep(value, opts = {}, depth = 0) {
  if (depth > (opts.maxDepth || 12)) return { type: 'depth', pattern: 'too deep' };
  if (value == null) return null;
  if (typeof value === 'string') return scan(value, opts);
  if (typeof value === 'number' || typeof value === 'boolean') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = scanDeep(item, opts, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value === 'object') {
    for (const k of Object.keys(value)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
        return { type: 'proto', pattern: k };
      }
      const keyHit = scan(k, { ...opts, types: ['sql', 'nosql', 'proto', 'crlf'] });
      if (keyHit) return keyHit;
      // 비밀번호 필드는 XSS/cmd 검사 제외 (특수문자 허용)
      const lower = k.toLowerCase();
      if (lower === 'password' || lower === 'pass' || lower === 'pwd') {
        const v = value[k];
        if (typeof v === 'string' && v.length > 200) return { type: 'size', pattern: 'password too long' };
        continue;
      }
      const valHit = scanDeep(value[k], opts, depth + 1);
      if (valHit) return valHit;
    }
  }
  return null;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safePath(baseDir, userPath) {
  const path = require('path');
  if (userPath == null || typeof userPath !== 'string') return null;
  if (scan(userPath, { types: ['path', 'crlf'] })) return null;
  const resolved = path.resolve(baseDir, userPath);
  const base = path.resolve(baseDir);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

function isSafeId(s) {
  return typeof s === 'string' && SAFE_ID.test(s);
}
function isSafeEmail(s) {
  return typeof s === 'string' && s.length <= 254 && SAFE_EMAIL.test(s);
}
function isSafeHex(s, min = 1, max = 128) {
  return typeof s === 'string' && s.length >= min && s.length <= max && SAFE_HEX.test(s);
}

function sanitizeObject(input, depth = 0) {
  if (input == null || typeof input !== 'object') return input;
  if (depth > 12) return null;
  if (Array.isArray(input)) return input.map(v => sanitizeObject(v, depth + 1));
  const out = Object.create(null);
  for (const k of Object.keys(input)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = sanitizeObject(input[k], depth + 1);
  }
  return out;
}

function guard(req, res, body, opts = {}) {
  const targets = [];
  if (req.url) targets.push(req.url);
  if (req.headers) {
    for (const [k, v] of Object.entries(req.headers)) {
      if (SKIP_HEADERS.has(String(k).toLowerCase())) continue;
      if (typeof v === 'string') targets.push(v);
      else if (Array.isArray(v)) for (const x of v) targets.push(x);
    }
  }
  if (body !== undefined) {
    const hit = scanDeep(body, opts);
    if (hit) {
      _reject(res, hit);
      return true;
    }
  }
  for (const t of targets) {
    const hit = scan(t, { ...opts, maxLen: opts.headerMaxLen || 8192 });
    if (hit) {
      _reject(res, hit);
      return true;
    }
  }
  return false;
}

function _reject(res, hit) {
  if (res.headersSent) return;
  res.writeHead(400, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify({
    error: {
      message: '차단된 입력이 포함되어 있습니다.',
      code: 'BLOCKED',
      type: hit.type,
    },
  }));
  if (typeof console !== 'undefined' && console.warn) {
    console.warn('[block] rejected', hit.type, hit.pattern && String(hit.pattern).slice(0, 80));
  }
}

function securityHeaders(res) {
  const h = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'X-XSS-Protection': '0',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self'; base-uri 'self'; form-action 'self'",
  };
  for (const [k, v] of Object.entries(h)) {
    if (!res.headersSent) try { res.setHeader(k, v); } catch (_) {}
  }
}

const _buckets = new Map();
function rateLimit(ip, { windowMs = 60_000, max = 120 } = {}) {
  const now = Date.now();
  let b = _buckets.get(ip);
  if (!b || now - b.start > windowMs) {
    b = { start: now, n: 0 };
    _buckets.set(ip, b);
  }
  b.n += 1;
  if (_buckets.size > 20_000) {
    for (const [k, v] of _buckets) {
      if (now - v.start > windowMs * 2) _buckets.delete(k);
    }
  }
  return b.n > max;
}

module.exports = {
  scan, scanDeep, escapeHtml, safePath,
  isSafeId, isSafeEmail, isSafeHex,
  sanitizeObject, guard, securityHeaders, rateLimit, PATTERNS,
};
