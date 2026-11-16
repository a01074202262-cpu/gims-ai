'use strict';
/**
 * vserver.js — AI 전용 가상 웹 서버
 * 작업 공간 HTML/CSS/JS 또는 직접 넘긴 HTML을 메모리에서 서빙하고,
 * 페이지 로드·스크립트 실행을 흉내 내 오류를 잡는다. (실제 브라우저/외부 포트 없음)
 */
const vm = require('vm');
const path = require('path');
const WS = require('./workspace');

const MAX_HTML = 400_000;
const MAX_JS = 200_000;
const RUN_MS = 2500;
const spaces = new Map(); // owner -> { files: Map<path,string>, entry, hits, errors, t }

const S = (type, description, extra = {}) => ({ type, description, ...extra });
const OBJ = (properties, required) => ({ type: 'OBJECT', properties, required });

function space(owner, create = false) {
  if (!owner) throw new Error('로그인한 사용자만 가상 서버를 쓸 수 있습니다');
  let s = spaces.get(owner);
  if (!s && create) {
    s = { files: new Map(), entry: 'index.html', hits: [], errors: [], t: Date.now() };
    spaces.set(owner, s);
  }
  if (s) s.t = Date.now();
  return s || null;
}

function normPath(p) {
  p = String(p || 'index.html').replace(/^\/+/, '').replace(/\\/g, '/');
  if (!p || p.includes('..')) throw new Error('잘못된 경로');
  return p || 'index.html';
}

function mimeOf(p) {
  const e = path.extname(p).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8', '.xml': 'application/xml'
  })[e] || 'application/octet-stream';
}

function resolveBody(s, reqPath) {
  const p = normPath(reqPath);
  if (s.files.has(p)) return { path: p, body: s.files.get(p), status: 200 };
  if (p.endsWith('/')) {
    const idx = p + 'index.html';
    if (s.files.has(idx)) return { path: idx, body: s.files.get(idx), status: 200 };
  }
  if (!path.extname(p) && s.files.has(p + '.html')) return { path: p + '.html', body: s.files.get(p + '.html'), status: 200 };
  if (p === '' || p === '/') {
    if (s.files.has(s.entry)) return { path: s.entry, body: s.files.get(s.entry), status: 200 };
    if (s.files.has('index.html')) return { path: 'index.html', body: s.files.get('index.html'), status: 200 };
  }
  return { path: p, body: null, status: 404 };
}

// ---------- HTML / JS 정적 + 가상 실행 검사 ----------
function extractScripts(html) {
  const scripts = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m, i = 0;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    const src = /src\s*=\s*["']([^"']+)["']/i.exec(attrs);
    const type = /type\s*=\s*["']([^"']+)["']/i.exec(attrs);
    if (type && /module/i.test(type[1])) {
      scripts.push({ index: i++, kind: 'module', src: src ? src[1] : null, code: m[2] || '', note: 'ES module — 가상 실행은 제한적' });
    } else if (src) {
      scripts.push({ index: i++, kind: 'external', src: src[1], code: '' });
    } else {
      scripts.push({ index: i++, kind: 'inline', src: null, code: m[2] || '' });
    }
  }
  return scripts;
}

function staticHtmlIssues(html) {
  const issues = [];
  if (!/<html[\s>]/i.test(html) && !/<!doctype/i.test(html)) issues.push({ severity: 'info', message: 'DOCTYPE/html 루트가 없습니다' });
  if (!/<body[\s>]/i.test(html)) issues.push({ severity: 'warning', message: '<body> 가 없습니다' });
  const openScript = (html.match(/<script\b/gi) || []).length;
  const closeScript = (html.match(/<\/script>/gi) || []).length;
  if (openScript !== closeScript) issues.push({ severity: 'error', message: `script 태그 짝 불일치 (open ${openScript}, close ${closeScript})` });
  if (/<\/html>[\s\S]+?\S/i.test(html)) issues.push({ severity: 'warning', message: '</html> 뒤에 내용이 있습니다' });
  if (/\bon\w+\s*=\s*["'][^"']{0,40}eval\s*\(/i.test(html)) issues.push({ severity: 'warning', message: '인라인 이벤트에서 eval 사용' });
  // 흔한 오타
  if (/<scirpt\b/i.test(html)) issues.push({ severity: 'error', message: '<scirpt> 오타' });
  if (/document\.getElementById\([^)]+\)\.(innerHTML|textContent|value)\s*=/.test(html) === false && /getElementById/i.test(html)) {
    // no-op, just presence
  }
  return issues;
}

function makeBrowserMock(logs) {
  const store = new Map();
  const el = (tag = 'div') => {
    const attrs = {};
    const children = [];
    const node = {
      tagName: String(tag).toUpperCase(),
      style: {},
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      children,
      childNodes: children,
      appendChild(c) { children.push(c); return c; },
      removeChild() { return null; },
      setAttribute(k, v) { attrs[k] = v; },
      getAttribute(k) { return attrs[k] ?? null; },
      addEventListener() {},
      removeEventListener() {},
      getContext() {
        return {
          fillRect() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {},
          arc() {}, fillText() {}, measureText() { return { width: 0 }; }, drawImage() {},
          save() {}, restore() {}, translate() {}, scale() {}, rotate() {},
          canvas: { width: 300, height: 150 }
        };
      },
      getBoundingClientRect() { return { x: 0, y: 0, width: 100, height: 100, top: 0, left: 0, right: 100, bottom: 100 }; },
      focus() {}, blur() {}, click() {},
      value: '', innerHTML: '', textContent: '', innerText: '', id: '', className: '',
      width: 300, height: 150, checked: false, disabled: false,
      parentNode: null, parentElement: null, style: {}
    };
    return node;
  };
  const body = el('body');
  const document = {
    body,
    documentElement: el('html'),
    head: el('head'),
    title: '',
    readyState: 'complete',
    getElementById(id) { return store.get('id:' + id) || (store.set('id:' + id, el('div')), store.get('id:' + id)); },
    querySelector() { return el('div'); },
    querySelectorAll() { return []; },
    getElementsByTagName() { return []; },
    getElementsByClassName() { return []; },
    createElement: el,
    createTextNode(t) { return { textContent: t }; },
    addEventListener() {},
    removeEventListener() {},
    cookie: '',
    location: { href: 'http://vserver.local/', pathname: '/', search: '', hash: '' }
  };
  // canvas id convenience
  const canvas = el('canvas');
  canvas.width = 480; canvas.height = 320;
  store.set('id:game', canvas);
  store.set('id:canvas', canvas);
  const window = {
    document,
    console: {
      log: (...a) => logs.push({ level: 'log', msg: a.map(String).join(' ').slice(0, 500) }),
      warn: (...a) => logs.push({ level: 'warn', msg: a.map(String).join(' ').slice(0, 500) }),
      error: (...a) => logs.push({ level: 'error', msg: a.map(String).join(' ').slice(0, 500) }),
      info: (...a) => logs.push({ level: 'info', msg: a.map(String).join(' ').slice(0, 500) })
    },
    setTimeout(fn) { try { if (typeof fn === 'function') fn(); } catch (e) { logs.push({ level: 'error', msg: String(e.message || e) }); } return 1; },
    setInterval() { return 1; },
    clearTimeout() {}, clearInterval() {},
    requestAnimationFrame(fn) { try { if (typeof fn === 'function') fn(0); } catch (e) { logs.push({ level: 'error', msg: String(e.message || e) }); } return 1; },
    cancelAnimationFrame() {},
    addEventListener() {}, removeEventListener() {},
    innerWidth: 1024, innerHeight: 768, devicePixelRatio: 1,
    location: document.location,
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {}, clear() {} },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {}, clear() {} },
    fetch() { return Promise.reject(new Error('vserver: 외부 fetch 차단')); },
    alert() {}, confirm() { return true; }, prompt() { return ''; },
    navigator: { userAgent: 'GimsVServer/1.0' },
    performance: { now: () => 0 },
    Image: function Image() { this.src = ''; this.onload = null; },
    Audio: function Audio() { this.play = async () => {}; this.pause = () => {}; },
    Math, JSON, Date, Number, String, Boolean, Array, Object, RegExp, Error, TypeError, SyntaxError,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
    Promise, Map, Set, WeakMap, WeakSet, Symbol, Proxy, Reflect,
    Uint8Array, Int32Array, Float64Array, ArrayBuffer, DataView,
    undefined
  };
  window.window = window;
  window.self = window;
  window.globalThis = window;
  window.document = document;
  return { window, document, logs };
}

function runJsInVm(code, label = 'script') {
  const logs = [];
  const errors = [];
  if (!code || !String(code).trim()) return { ok: true, logs, errors, label };
  const src = String(code).slice(0, MAX_JS);
  // 문법만 먼저
  try {
    new vm.Script(src, { filename: label });
  } catch (e) {
    errors.push({ type: 'SyntaxError', message: e.message, label });
    return { ok: false, logs, errors, label };
  }
  const { window } = makeBrowserMock(logs);
  const context = vm.createContext(window);
  try {
    const script = new vm.Script(src, { filename: label, timeout: RUN_MS });
    script.runInContext(context, { timeout: RUN_MS });
  } catch (e) {
    errors.push({ type: e.name || 'Error', message: e.message, label });
  }
  return { ok: errors.length === 0, logs: logs.slice(0, 30), errors, label };
}

function checkPage(html, resolveExternal) {
  const issues = staticHtmlIssues(html);
  const scripts = extractScripts(html);
  const runs = [];
  for (const sc of scripts) {
    if (sc.kind === 'external' && resolveExternal) {
      const rel = normPath(sc.src.replace(/^\.\//, ''));
      const body = resolveExternal(rel);
      if (body == null) {
        issues.push({ severity: 'error', message: `외부 스크립트를 찾을 수 없음: ${sc.src}` });
        continue;
      }
      runs.push(runJsInVm(body, sc.src));
    } else if (sc.kind === 'inline' || sc.kind === 'module') {
      runs.push(runJsInVm(sc.code, sc.kind + '#' + sc.index));
    }
  }
  // onclick 등 인라인 핸들러 간단 추출
  const onRe = /\bon([a-z]+)\s*=\s*["']([^"']+)["']/gi;
  let om;
  while ((om = onRe.exec(html))) {
    runs.push(runJsInVm(om[2], 'on' + om[1]));
  }
  for (const r of runs) {
    for (const e of r.errors) {
      issues.push({ severity: 'error', message: `[${e.label}] ${e.type}: ${e.message}` });
    }
  }
  const errorCount = issues.filter(i => i.severity === 'error').length;
  return {
    ok: errorCount === 0,
    errorCount,
    warningCount: issues.filter(i => i.severity === 'warning').length,
    scripts: scripts.map(s => ({ kind: s.kind, src: s.src, bytes: (s.code || '').length })),
    issues: issues.slice(0, 40),
    console: runs.flatMap(r => r.logs).slice(0, 40)
  };
}

// ---------- 도구 구현 ----------
const IMPL = {};

IMPL.vserver_deploy = ({ entry = 'index.html', html, from_workspace = true } = {}, ctx = {}) => {
  const owner = ctx.owner;
  const s = space(owner, true);
  s.files.clear();
  s.errors = [];
  s.hits = [];
  s.entry = normPath(entry);
  if (typeof html === 'string' && html.trim()) {
    if (html.length > MAX_HTML) throw new Error('html 이 너무 큽니다');
    s.files.set(s.entry, html);
  } else if (from_workspace !== false) {
    const files = WS.allFiles(owner);
    if (!files.length) throw new Error('작업 공간에 파일이 없습니다. 먼저 ws_write_file 로 만들거나 html 인자를 주세요');
    for (const f of files) {
      try { s.files.set(normPath(f.path), f.content); } catch { /* skip bad paths */ }
    }
    if (!s.files.has(s.entry) && s.files.has('index.html')) s.entry = 'index.html';
  } else {
    throw new Error('html 또는 from_workspace 파일이 필요합니다');
  }
  // 배포 직후 엔트리 검사
  const body = s.files.get(s.entry);
  let check = null;
  if (body && /\.html?$/i.test(s.entry)) {
    check = checkPage(body, p => s.files.has(p) ? s.files.get(p) : null);
    s.errors = check.issues.filter(i => i.severity === 'error');
  }
  return {
    ok: true,
    entry: s.entry,
    files: [...s.files.keys()].sort(),
    bytes: [...s.files.values()].reduce((n, c) => n + Buffer.byteLength(c, 'utf8'), 0),
    check: check ? { ok: check.ok, errorCount: check.errorCount, issues: check.issues.slice(0, 15) } : null,
    note: 'vserver_request 로 경로를 요청하고, vserver_check_page 로 오류를 재확인할 수 있습니다'
  };
};

IMPL.vserver_request = ({ path: reqPath = '/', method = 'GET' } = {}, ctx = {}) => {
  const s = space(ctx.owner);
  if (!s || !s.files.size) throw new Error('배포된 가상 서버가 없습니다. vserver_deploy 를 먼저 호출하세요');
  const methodU = String(method || 'GET').toUpperCase();
  if (methodU !== 'GET' && methodU !== 'HEAD') throw new Error('가상 서버는 GET/HEAD 만 지원합니다');
  const resolved = resolveBody(s, reqPath === '/' ? s.entry : reqPath);
  s.hits.push({ path: reqPath, status: resolved.status, at: Date.now() });
  if (s.hits.length > 50) s.hits.shift();
  if (!resolved.body) {
    return { status: 404, path: resolved.path, error: 'Not Found', headers: { 'content-type': 'text/plain' }, body: '404 Not Found' };
  }
  const headers = { 'content-type': mimeOf(resolved.path), 'content-length': Buffer.byteLength(resolved.body, 'utf8') };
  return {
    status: 200,
    path: resolved.path,
    headers,
    body: methodU === 'HEAD' ? '' : (resolved.body.length > 12000 ? resolved.body.slice(0, 12000) + '\n…(잘림)' : resolved.body),
    bytes: Buffer.byteLength(resolved.body, 'utf8')
  };
};

IMPL.vserver_check_page = ({ path: reqPath, html } = {}, ctx = {}) => {
  let body = typeof html === 'string' ? html : null;
  let label = 'inline';
  if (body == null) {
    const s = space(ctx.owner);
    if (!s || !s.files.size) throw new Error('배포된 서버가 없거나 html 인자가 필요합니다');
    const r = resolveBody(s, reqPath || s.entry);
    if (!r.body) throw new Error(`페이지 없음: ${reqPath || s.entry}`);
    body = r.body;
    label = r.path;
  }
  if (body.length > MAX_HTML) throw new Error('html 이 너무 큽니다');
  const s = space(ctx.owner);
  const resolve = p => {
    if (s && s.files.has(p)) return s.files.get(p);
    return null;
  };
  const result = checkPage(body, resolve);
  return { path: label, ...result, tip: result.ok ? '가상 실행에서 치명적 오류 없음' : '오류를 고친 뒤 ws_write_file → vserver_deploy → vserver_check_page 순으로 다시 확인' };
};

IMPL.vserver_run_js = ({ code, label = 'snippet.js' } = {}, ctx = {}) => {
  if (typeof code !== 'string' || !code.trim()) throw new Error('code 가 필요합니다');
  if (code.length > MAX_JS) throw new Error('code 가 너무 깁니다');
  const r = runJsInVm(code, label);
  return {
    ok: r.ok,
    errors: r.errors,
    console: r.logs,
    note: '브라우저 API는 목(mock)입니다. DOM 렌더링·레이아웃·네트워크는 검증하지 않습니다'
  };
};

IMPL.vserver_status = (a, ctx = {}) => {
  const s = space(ctx.owner);
  if (!s) return { deployed: false, files: [], hits: [] };
  return {
    deployed: s.files.size > 0,
    entry: s.entry,
    files: [...s.files.keys()].sort(),
    fileCount: s.files.size,
    recentHits: s.hits.slice(-10),
    lastErrors: (s.errors || []).slice(0, 10)
  };
};

IMPL.vserver_stop = (a, ctx = {}) => {
  const ok = spaces.delete(ctx.owner);
  return { ok, stopped: ok };
};

const DECL = [
  { name: 'vserver_deploy', description: '작업 공간 파일 또는 주어진 HTML을 AI 가상 웹 서버에 배포한다. 배포 직후 엔트리 HTML의 스크립트 오류를 자동 검사한다.',
    parameters: OBJ({
      entry: S('STRING', '엔트리 경로 (기본 index.html)'),
      html: S('STRING', '직접 배포할 HTML (있으면 작업 공간 대신 사용)'),
      from_workspace: S('BOOLEAN', '작업 공간 파일을 배포할지 (기본 true)')
    }, []) },
  { name: 'vserver_request', description: '가상 서버에 GET/HEAD 요청을 보내 상태 코드·본문을 확인한다. 404·경로 문제 점검용.',
    parameters: OBJ({
      path: S('STRING', '요청 경로 예: / 또는 /index.html 또는 /app.js'),
      method: S('STRING', 'GET 또는 HEAD', { enum: ['GET', 'HEAD'] })
    }, []) },
  { name: 'vserver_check_page', description: 'HTML 페이지를 가상 브라우저에서 검사한다: 태그 짝, 인라인/외부 스크립트 문법·런타임 오류, console 출력. 코딩 후 반드시 호출해 오류를 확인하라.',
    parameters: OBJ({
      path: S('STRING', '배포된 서버 경로 (기본 엔트리)'),
      html: S('STRING', '서버 대신 직접 검사할 HTML')
    }, []) },
  { name: 'vserver_run_js', description: 'JavaScript 코드만 가상 브라우저 컨텍스트에서 실행해 문법·런타임 오류와 console 을 반환한다.',
    parameters: OBJ({
      code: S('STRING', '실행할 JS'),
      label: S('STRING', '오류 표시용 이름')
    }, ['code']) },
  { name: 'vserver_status', description: '현재 사용자 가상 서버 배포 상태·파일 목록·최근 요청을 본다.',
    parameters: OBJ({}, []) },
  { name: 'vserver_stop', description: '가상 서버 배포를 해제한다.',
    parameters: OBJ({}, []) }
];

module.exports = { DECL, IMPL, checkPage, runJsInVm };
