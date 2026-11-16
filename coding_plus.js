'use strict';
// 코딩 도구 2차 확장 (정적 분석 전용, 코드 실행 없음)
//  미사용 식별자, 중복 코드 블록, API 라우트 추출(인증 누락 표시), import 대 package.json 대조,
//  async 실수 패턴, 함수 안의 전역 상태 변경
const { functionBodies } = require('./coding');

const MAX_CODE = 60_000;
const S = (type, description, extra = {}) => ({ type, description, ...extra });
const OBJ = (properties, required) => ({ type: 'OBJECT', properties, required });
const codeOf = (v, name = 'code') => {
  if (typeof v !== 'string') throw new Error(`${name} 는 문자열이어야 합니다`);
  if (v.length > MAX_CODE) throw new Error(`${name} 가 너무 깁니다 (최대 ${MAX_CODE}자)`);
  return v;
};
const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : d; };
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LANG = S('STRING', 'js 또는 python', { enum: ['js', 'python'] });
const IMPL = {};

IMPL.find_unused_identifiers = ({ code, language }) => {
  const src = codeOf(code), py = language === 'python';
  const declRe = py
    ? /^\s*(?:(export)\s+)?(?:def|class)\s+([A-Za-z_]\w*)|^\s*([A-Za-z_]\w*)\s*=/gm
    : /\b(export\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g;
  const names = new Map();
  for (const m of src.matchAll(declRe)) {
    const name = py ? (m[2] || m[3]) : m[2];
    const exported = !!(py ? m[1] : m[1]);
    if (!name || name.startsWith('_') || exported) continue;
    if (!names.has(name)) names.set(name, m.index);
  }
  const unused = [];
  for (const [name, idx] of names) {
    const count = (src.match(new RegExp(`(?<![\\w$])${esc(name)}(?![\\w$])`, 'g')) || []).length;
    if (count <= 1) unused.push({ name, line: src.slice(0, idx).split('\n').length });
  }
  return { language: py ? 'python' : 'js', count: unused.length, unused: unused.slice(0, 100), note: '선언 후 한 번만 등장하는 이름. 외부 노출·동적 사용은 놓칠 수 있음' };
};

IMPL.find_duplicate_blocks = ({ code, min_lines }) => {
  const W = clamp(min_lines, 3, 30, 4);
  const lines = codeOf(code).split('\n').map((t, i) => ({ t: t.trim(), n: i + 1 }))
    .filter(x => x.t && !/^(\/\/|#)/.test(x.t));
  const seen = new Map(), dups = [];
  for (let i = 0; i + W <= lines.length; i++) {
    const key = lines.slice(i, i + W).map(x => x.t).join('\n');
    if (key.length < 25) continue;
    if (seen.has(key)) {
      const first = seen.get(key);
      if (i - first.i >= W) dups.push({ lines: [first.n, lines[i].n], length: W, sample: lines[i].t.slice(0, 100) });
    } else seen.set(key, { i, n: lines[i].n });
    if (dups.length >= 30) break;
  }
  return { count: dups.length, duplicates: dups, note: '같은 내용이 반복되는 구간. 공통 함수로 빼는 것을 검토하세요' };
};

const ROUTE_RULES = [
  [/\b(?:app|router)\.(get|post|put|patch|delete|all)\s*\(\s*['"`]([^'"`]+)['"`]/, 'express', (m) => m[1].toUpperCase(), (m) => m[2]],
  [/@\w+\.route\(\s*['"]([^'"]+)['"](?:[^)]*methods\s*=\s*\[([^\]]*)\])?/, 'flask', (m) => (m[2] || 'GET').replace(/['"\s]/g, '').split(',').join('|'), (m) => m[1]],
  [/@\w+\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/, 'fastapi', (m) => m[1].toUpperCase(), (m) => m[2]]
];
IMPL.extract_routes = ({ code }) => {
  const routes = [];
  codeOf(code).split('\n').forEach((line, i) => {
    for (const [re, framework, method, path] of ROUTE_RULES) {
      const m = re.exec(line);
      if (m) {
        routes.push({ line: i + 1, framework, method: method(m), path: path(m), auth: /auth|authenticate|requireAuth|login_required|Depends\(|isAdmin/i.test(line) });
        break;
      }
    }
  });
  return { count: routes.length, withoutAuthHint: routes.filter(r => !r.auth).length, routes: routes.slice(0, 200), note: 'auth 는 같은 줄의 인증 흔적만 본 추정값' };
};

const BUILTIN = new Set(['fs', 'path', 'http', 'https', 'crypto', 'os', 'url', 'stream', 'zlib', 'vm', 'child_process', 'readline', 'net', 'tls', 'dns', 'util', 'events', 'buffer', 'timers', 'worker_threads', 'assert', 'querystring', 'string_decoder', 'cluster', 'module', 'process']);
IMPL.check_imports = ({ code, package_json }) => {
  const src = codeOf(code);
  const specs = new Set();
  for (const m of src.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.add(m[1]);
  for (const m of src.matchAll(/\bimport\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g)) specs.add(m[1]);
  const used = new Set();
  for (const s of specs) {
    if (s.startsWith('.') || s.startsWith('/') || s.startsWith('node:') || BUILTIN.has(s)) continue;
    const base = s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0];
    used.add(base);
  }
  let deps = null;
  if (package_json) {
    try {
      const p = JSON.parse(codeOf(package_json, 'package_json'));
      deps = new Set([...Object.keys(p.dependencies || {}), ...Object.keys(p.devDependencies || {})]);
    } catch (e) { throw new Error('package_json 파싱 실패: ' + e.message); }
  }
  const missing = deps ? [...used].filter(u => !deps.has(u)) : null;
  const unusedDeps = deps ? [...deps].filter(d => !used.has(d)) : null;
  return { importedPackages: [...used].sort(), missingInPackageJson: missing, unusedInPackageJson: unusedDeps, note: deps ? '' : 'package_json 을 주면 누락·미사용 패키지를 대조합니다' };
};

IMPL.find_async_pitfalls = ({ code }) => {
  const rules = [
    [/\.forEach\(\s*async/, 'forEach 는 async 콜백을 기다리지 않습니다 (for...of 또는 Promise.all 사용)'],
    [/new\s+Promise\(\s*async/, 'new Promise 안의 async 는 예외를 잃어버립니다'],
    [/setTimeout\(\s*async/, 'setTimeout 에 async 콜백을 넘기면 실패를 잡을 수 없습니다'],
    [/\.then\([^)]*\)\s*;?\s*$/, 'then 체인에 catch 가 없을 수 있습니다 (거절이 무시됨)']
  ];
  const ASYNC_CALL = /\b(fetch|readFile|writeFile|findOne|findById|findAll|save|query|axios\.\w+)\s*\(/;
  const findings = [];
  codeOf(code).split('\n').forEach((line, i) => {
    for (const [re, msg] of rules) if (re.test(line)) findings.push({ line: i + 1, message: msg });
    if (ASYNC_CALL.test(line) && !/\bawait\b|\.then\(|\breturn\b|=>\s*\(?[^{]*$|\bPromise\.(all|race)\b/.test(line)) {
      findings.push({ line: i + 1, message: 'await 누락 의심: 비동기 호출 결과를 기다리지 않고 쓰고 있을 수 있습니다' });
    }
  });
  return { count: findings.length, findings: findings.slice(0, 80) };
};

IMPL.find_global_mutation = ({ code, language }) => {
  const src = codeOf(code), py = language === 'python';
  const globals = new Set();
  for (const line of src.split('\n')) {
    if (py) { const m = /^([A-Za-z_]\w*)\s*=/.exec(line); if (m) globals.add(m[1]); }
    else { const m = /^(?:let|var)\s+([A-Za-z_$][\w$]*)/.exec(line); if (m) globals.add(m[1]); }
  }
  const findings = [];
  for (const f of functionBodies(src, py ? 'python' : 'js')) {
    for (const g of globals) {
      const re = new RegExp(`(?<![\\w$.])${esc(g)}\\s*(=(?!=)|\\+=|-=|\\*=|\\+\\+|--|\\.push\\(|\\.set\\(|\\.delete\\()`);
      if (re.test(f.body)) findings.push({ function: f.name, line: f.line, variable: g, message: '함수 안에서 모듈 전역 상태를 변경합니다 (테스트·동시성 문제 가능)' });
    }
  }
  return { count: findings.length, findings: findings.slice(0, 60) };
};

const DECL = [
  { name: 'find_unused_identifiers', description: '선언 후 한 번만 등장하는 변수·함수·클래스(미사용 의심)를 찾는다.',
    parameters: OBJ({ code: S('STRING', '코드'), language: LANG }, ['code']) },
  { name: 'find_duplicate_blocks', description: '반복되는 코드 블록을 찾아 두 위치를 알려준다(공통화 후보).',
    parameters: OBJ({ code: S('STRING', '코드'), min_lines: S('INTEGER', '블록 최소 줄 수 (3~30, 기본 4)') }, ['code']) },
  { name: 'extract_routes', description: 'Express·Flask·FastAPI 라우트를 추출하고 같은 줄에 인증 흔적이 없는 라우트를 표시한다.',
    parameters: OBJ({ code: S('STRING', '서버 코드') }, ['code']) },
  { name: 'check_imports', description: 'JS 코드의 외부 패키지 import 를 package.json 과 대조해 누락·미사용 패키지를 찾는다.',
    parameters: OBJ({ code: S('STRING', 'JS 코드'), package_json: S('STRING', 'package.json 내용 (선택)') }, ['code']) },
  { name: 'find_async_pitfalls', description: 'async 실수 패턴을 찾는다: forEach+async, new Promise+async, await 누락 의심, catch 없는 then.',
    parameters: OBJ({ code: S('STRING', 'JS 코드') }, ['code']) },
  { name: 'find_global_mutation', description: '함수 안에서 모듈 전역 변수를 바꾸는 부분을 찾는다(상태 관리 문제 점검).',
    parameters: OBJ({ code: S('STRING', '코드'), language: LANG }, ['code']) }
];

module.exports = { DECL, IMPL };
