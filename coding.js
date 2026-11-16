'use strict';
// 코딩 도구 확장 (정적 분석 전용, 코드 실행 없음)
//  - 구조: 시그니처 추출, 괄호·따옴표 짝 검사, 재귀 기저 조건 검사, Python 기본 린트
//  - 보안: 취약 패턴 검사, 정규식 ReDoS 위험 검사
//  - 테스트 설계: 경계 입력 세트, JSON Schema 부분 검증
//  - 변경 분석: 줄 단위 diff 요약
const MAX_CODE = 60_000;

const S = (type, description, extra = {}) => ({ type, description, ...extra });
const OBJ = (properties, required) => ({ type: 'OBJECT', properties, required });
const codeOf = (v, name = 'code') => {
  if (typeof v !== 'string') throw new Error(`${name} 는 문자열이어야 합니다`);
  if (v.length > MAX_CODE) throw new Error(`${name} 가 너무 깁니다 (최대 ${MAX_CODE}자)`);
  return v;
};
const langOf = l => (l === 'python' ? 'python' : 'js');
const LANG_PROP = S('STRING', 'js 또는 python', { enum: ['js', 'python'] });

const SIG_RULES = {
  js: [
    [/^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/, 'function'],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/, 'arrow'],
    [/^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)()/, 'class']
  ],
  python: [
    [/^\s*(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/, 'def'],
    [/^\s*class\s+(\w+)()/, 'class']
  ]
};

function findSignatures(code, lang) {
  const items = [];
  code.split('\n').forEach((line, i) => {
    for (const [re, kind] of SIG_RULES[lang]) {
      const m = re.exec(line);
      if (m) { items.push({ line: i + 1, kind, name: m[1], params: (m[2] || '').trim() }); break; }
    }
  });
  return items;
}

// 함수 본문 추출: JS는 중괄호 깊이, Python은 들여쓰기로 판단
function functionBodies(code, lang) {
  const lines = code.split('\n');
  return findSignatures(code, lang).filter(s => s.kind !== 'class').map(sig => {
    const start = sig.line - 1;
    let body = [];
    if (lang === 'python') {
      const base = lines[start].match(/^\s*/)[0].length;
      for (let i = start + 1; i < lines.length; i++) {
        if (lines[i].trim() === '') { body.push(lines[i]); continue; }
        if (lines[i].match(/^\s*/)[0].length <= base) break;
        body.push(lines[i]);
      }
    } else {
      let depth = 0, opened = false;
      for (let i = start; i < lines.length; i++) {
        for (const ch of lines[i]) {
          if (ch === '{') { depth++; opened = true; }
          else if (ch === '}') depth--;
        }
        if (opened) body.push(lines[i]);
        if (opened && depth <= 0) break;
      }
    }
    return { ...sig, body: body.join('\n') };
  });
}

const IMPL = {};

IMPL.extract_signatures = ({ code, language }) => {
  const lang = langOf(language);
  const items = findSignatures(codeOf(code), lang);
  return { language: lang, count: items.length, items: items.slice(0, 200) };
};

IMPL.check_brackets = ({ code, language }) => {
  const src = codeOf(code), lang = langOf(language), pairs = { ')': '(', ']': '[', '}': '{' };
  const stack = [];
  let line = 1, quote = null;
  const err = (msg, ln) => ({ ok: false, line: ln, error: msg });
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (c === '\n') { line++; if (quote === '//' || quote === '#') quote = null; continue; }
    if (quote === '/*') { if (c === '*' && n === '/') { quote = null; i++; } continue; }
    if (quote === '//' || quote === '#') continue;
    if (quote) {
      if (c === '\\') { if (src[i + 1] === '\n') line++; i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (lang === 'js' && c === '/' && n === '/') { quote = '//'; i++; continue; }
    if (lang === 'js' && c === '/' && n === '*') { quote = '/*'; i++; continue; }
    if (lang === 'python' && c === '#') { quote = '#'; continue; }
    if (c === '"' || c === "'" || (lang === 'js' && c === '`')) { quote = c; continue; }
    if ('([{'.includes(c)) stack.push({ c, line });
    else if (')]}'.includes(c)) {
      const top = stack.pop();
      if (!top || top.c !== pairs[c]) return err(`'${c}' 에 짝이 맞지 않습니다`, line);
    }
  }
  if (quote && quote !== '//' && quote !== '#') return err(`닫히지 않은 ${quote === '/*' ? '주석' : '문자열'}`, line);
  if (stack.length) return err(`'${stack[stack.length - 1].c}' 가 닫히지 않았습니다`, stack[stack.length - 1].line);
  return { ok: true, lines: line };
};

IMPL.find_recursion_risk = ({ code, language }) => {
  const lang = langOf(language);
  const fns = functionBodies(codeOf(code), lang);
  const report = [];
  for (const f of fns) {
    const callRe = new RegExp(`\\b${f.name}\\s*\\(`, 'g');
    const calls = (f.body.match(callRe) || []).length;
    if (calls === 0) continue;
    const hasBranch = /\b(if|elif|else|match|switch|case|when)\b|\?/.test(f.body);
    const hasBase = /\breturn\b/.test(f.body);
    report.push({
      name: f.name, line: f.line, recursiveCalls: calls,
      severity: !hasBranch ? 'high' : !hasBase ? 'medium' : 'info',
      message: !hasBranch ? '재귀 호출은 있으나 분기(기저 조건)가 전혀 없습니다: 무한 재귀 위험'
        : !hasBase ? '분기는 있으나 return 이 없습니다: 기저 조건 확인 필요'
        : '재귀 함수입니다. 기저 조건과 인자 감소를 확인하세요'
    });
  }
  return { language: lang, recursive: report.length, items: report };
};

const REDOS_RE = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/;
IMPL.regex_risk = ({ pattern }) => {
  const p = codeOf(pattern, 'pattern');
  const risks = [];
  if (REDOS_RE.test(p)) risks.push('중첩 한정자(예: (a+)+)는 입력에 따라 지수 시간이 걸릴 수 있습니다 (ReDoS)');
  if (/\.\*.*\.\*/.test(p)) risks.push('여러 개의 .* 는 백트래킹 비용을 키울 수 있습니다');
  if (/\\[1-9]/.test(p)) risks.push('역참조(\\1)는 일반적으로 매우 느립니다');
  try { new RegExp(p); } catch (e) { return { valid: false, error: e.message, risks }; }
  return { valid: true, risks, safe: risks.length === 0, note: '정적 휴리스틱이며 실제 실행 시간은 측정하지 않습니다' };
};

const TEST_INPUTS = {
  int: [0, 1, -1, 2, 2 ** 31 - 1, -(2 ** 31), Number.MAX_SAFE_INTEGER],
  int_array: [[], [7], [1, 1, 1], [3, 1, 2], [1, 2, 3, 4, 5], [5, 4, 3, 2, 1], [-3, 0, -1, 9], [0, 0, 0, 1]],
  sorted_array: [[], [1], [1, 2, 3], [1, 1, 2, 2, 3], [-5, -1, 0, 4, 10]],
  string: ['', 'a', 'aa', ' a b ', 'Hello, 세계 😀', 'a'.repeat(300), 'racecar', 'ab\ncd\tef'],
  graph_edges: [[], [[0, 0]], [[0, 1], [1, 2], [2, 0]], [[0, 1], [2, 3]], [[0, 1], [0, 2], [1, 2]]],
  matrix: [[[]], [[1]], [[1, 2], [3, 4]], [[0, 0], [0, 0]], [[1, 2, 3], [4, 5, 6]]],
  json_object: [{}, { a: null }, { a: 1, b: 'x' }, { nested: { deep: [1, { z: true }] } }]
};
IMPL.generate_test_inputs = ({ kind, size = 8 }) => {
  if (!Object.hasOwn(TEST_INPUTS, kind)) throw new Error(`kind 는 ${Object.keys(TEST_INPUTS).join(', ')} 중 하나`);
  const n = clamp(size, 1, 20, 8);
  return { kind, count: Math.min(n, TEST_INPUTS[kind].length), cases: TEST_INPUTS[kind].slice(0, n), note: '빈 입력·경계값·중복·역순·큰 값 포함' };
};
function clamp(v, lo, hi, d) { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : d; }

IMPL.validate_json = ({ data_json, schema_json }) => {
  let data, schema;
  try { data = JSON.parse(codeOf(data_json, 'data_json')); } catch (e) { throw new Error('data_json 파싱 실패: ' + e.message); }
  try { schema = JSON.parse(codeOf(schema_json, 'schema_json')); } catch (e) { throw new Error('schema_json 파싱 실패: ' + e.message); }
  const errs = [];
  const actualType = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
  const walk = (v, s, path, d) => {
    if (errs.length >= 50 || d > 20 || !s || typeof s !== 'object') return;
    if (s.type) {
      const types = Array.isArray(s.type) ? s.type : [s.type];
      const at = actualType(v);
      const ok = types.some(t => t === at || (t === 'number' && typeof v === 'number'));
      if (!ok) { errs.push(`${path}: 타입은 ${types.join('|')} 이어야 합니다 (실제 ${at})`); return; }
    }
    if (s.enum && !s.enum.some(e => JSON.stringify(e) === JSON.stringify(v))) errs.push(`${path}: enum 값이 아닙니다`);
    if (typeof v === 'number') {
      if (s.minimum !== undefined && v < s.minimum) errs.push(`${path}: ${s.minimum} 이상이어야 합니다`);
      if (s.maximum !== undefined && v > s.maximum) errs.push(`${path}: ${s.maximum} 이하여야 합니다`);
    }
    if (typeof v === 'string') {
      if (s.minLength !== undefined && v.length < s.minLength) errs.push(`${path}: 최소 길이 ${s.minLength}`);
      if (s.maxLength !== undefined && v.length > s.maxLength) errs.push(`${path}: 최대 길이 ${s.maxLength}`);
    }
    if (Array.isArray(v)) {
      if (s.minItems !== undefined && v.length < s.minItems) errs.push(`${path}: 최소 ${s.minItems}개`);
      if (s.maxItems !== undefined && v.length > s.maxItems) errs.push(`${path}: 최대 ${s.maxItems}개`);
      if (s.items) v.forEach((x, i) => walk(x, s.items, `${path}[${i}]`, d + 1));
    } else if (v && typeof v === 'object') {
      for (const k of s.required || []) if (!(k in v)) errs.push(`${path}.${k}: 필수 항목 누락`);
      for (const [k, sub] of Object.entries(s.properties || {})) if (k in v) walk(v[k], sub, `${path}.${k}`, d + 1);
    }
  };
  walk(data, schema, '$', 0);
  return { valid: errs.length === 0, errors: errs };
};

IMPL.lint_python_basic = ({ code }) => {
  const findings = [];
  const add = (line, severity, message) => findings.push({ line, severity, message });
  codeOf(code).split('\n').forEach((raw, i) => {
    const ln = i + 1;
    const indent = raw.match(/^[ \t]*/)[0];
    if (/\t/.test(indent) && / /.test(indent)) add(ln, 'high', '들여쓰기에 탭과 공백이 섞였습니다');
    if (/[ \t]+$/.test(raw) && raw.trim()) add(ln, 'low', '줄 끝 공백');
    if (raw.length > 120) add(ln, 'low', '120자를 넘는 줄');
    if (/^\s*print\s+[^(\s]/.test(raw)) add(ln, 'high', 'print 문에 괄호가 없습니다 (Python 2 문법)');
    if (/except\s+\w+\s*,\s*\w+/.test(raw)) add(ln, 'high', 'except X, e 문법은 Python 3에서 오류입니다 (except X as e)');
    if (/^\s*except\s*:/.test(raw)) add(ln, 'medium', 'bare except: 시스템 종료 신호까지 잡습니다');
    if (/^\s*(def|class|if|elif|else|for|while|try|except|finally|with)\b/.test(raw)
        && !/:\s*(#.*)?$/.test(raw) && !/[\\([{,]\s*(#.*)?$/.test(raw) && raw.trim() && !raw.trim().startsWith('#')) {
      add(ln, 'medium', '블록 시작 줄 끝에 콜론(:)이 없을 수 있습니다 (여러 줄 조건이면 무시)');
    }
  });
  const order = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.line - b.line);
  return { count: findings.length, findings: findings.slice(0, 80), note: '기본 규칙 기반 점검입니다' };
};

const SECURITY_RULES = [
  [/\beval\s*\(/, 'high', 'eval 사용: 임의 코드 실행 위험'],
  [/\bnew\s+Function\s*\(/, 'high', 'new Function: 동적 코드 실행 위험'],
  [/\.innerHTML\s*=|dangerouslySetInnerHTML|insertAdjacentHTML/, 'medium', 'HTML 주입(XSS) 위험'],
  [/\b(SELECT|INSERT|UPDATE|DELETE)\b[^;\n]*['"`]\s*\+|\+\s*['"`][^;\n]*\b(WHERE|VALUES|SET)\b/i, 'high', 'SQL 문자열 연결: 인젝션 위험, 매개변수 바인딩 사용'],
  [/AKIA[0-9A-Z]{16}|api[_-]?key\s*[:=]\s*['"][^'"]{8,}['"]|secret\s*[:=]\s*['"][^'"]{8,}['"]|password\s*[:=]\s*['"][^'"]+['"]/i, 'high', '하드코딩된 비밀값 의심'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'high', '개인키가 코드에 포함되어 있습니다'],
  [/\.\.\/|\.\.\\/, 'medium', '경로 탐색 패턴(../) 확인 필요'],
  [/os\.system\(|subprocess\.\w+\([^)]*shell\s*=\s*True|child_process\.exec\(/, 'high', '셸 명령 실행: 인자 주입 위험'],
  [/pickle\.loads?\(|yaml\.load\((?![^)]*Loader)|marshal\.loads?\(/, 'high', '안전하지 않은 역직렬화'],
  [/verify\s*=\s*False|rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED/, 'medium', 'TLS 인증서 검증 비활성화'],
  [/\bdebug\s*=\s*True\b|app\.run\([^)]*debug\s*=\s*True/, 'medium', '디버그 모드 활성화 (운영 환경 노출 위험)'],
  [/Math\.random\(\)/, 'low', '보안 목적이라면 crypto 난수 사용 권장'],
  [/\bcors\(\s*\)|Access-Control-Allow-Origin['"]?\s*[:,]\s*['"]\*/, 'low', 'CORS 전체 허용']
];
IMPL.security_scan = ({ code, language }) => {
  const src = codeOf(code), findings = [];
  src.split('\n').forEach((line, i) => {
    for (const [re, severity, message] of SECURITY_RULES) {
      if (re.test(line)) findings.push({ line: i + 1, severity, message, text: line.trim().slice(0, 120) });
    }
  });
  const order = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.line - b.line);
  return { language: langOf(language), count: findings.length, findings: findings.slice(0, 60), note: '패턴 기반 점검이므로 오탐과 누락이 있을 수 있습니다' };
};

IMPL.diff_summary = ({ before, after }) => {
  const a = codeOf(before, 'before').split('\n'), b = codeOf(after, 'after').split('\n');
  if (a.length > 1500 || b.length > 1500) throw new Error('각 코드는 1500줄 이하여야 합니다');
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const L = dp[0][0];
  return {
    removedLines: n - L, addedLines: m - L, unchangedLines: L,
    similarity: Number((L / Math.max(n, m, 1)).toFixed(3)),
    note: '줄 단위 LCS 기준 변경량'
  };
};

const DECL = [
  { name: 'extract_signatures', description: '함수·클래스 선언(이름, 줄 번호, 매개변수)을 목록으로 뽑는다. 구조 파악과 테스트 설계의 출발점.',
    parameters: OBJ({ code: S('STRING', '코드'), language: LANG_PROP }, ['code']) },
  { name: 'check_brackets', description: '괄호·대괄호·중괄호의 짝과 닫히지 않은 문자열·주석을 검사한다(주석과 문자열 내부는 무시).',
    parameters: OBJ({ code: S('STRING', '코드'), language: LANG_PROP }, ['code']) },
  { name: 'find_recursion_risk', description: '재귀 함수를 찾아 기저 조건(분기·return) 유무로 무한 재귀 위험을 표시한다.',
    parameters: OBJ({ code: S('STRING', '코드'), language: LANG_PROP }, ['code']) },
  { name: 'regex_risk', description: '정규식 패턴의 ReDoS(지수 백트래킹) 위험과 문법 유효성을 검사한다.',
    parameters: OBJ({ pattern: S('STRING', '정규식 본문(슬래시 제외)') }, ['pattern']) },
  { name: 'lint_python_basic', description: 'Python 기본 린트: 탭/공백 혼용, Python 2 문법, bare except, 콜론 누락 의심, 긴 줄.',
    parameters: OBJ({ code: S('STRING', 'Python 코드') }, ['code']) },
  { name: 'generate_test_inputs', description: '자료형별 표준 경계 입력 세트를 만든다(빈 입력, 1개, 중복, 역순, 큰 값, 그래프 자기루프, 중첩 JSON 등).',
    parameters: OBJ({ kind: S('STRING', '입력 종류', { enum: Object.keys(TEST_INPUTS) }), size: S('INTEGER', '개수 (1~20)') }, ['kind']) },
  { name: 'validate_json', description: 'JSON 데이터를 JSON Schema 부분집합(type, required, properties, items, enum, min/max, 길이)으로 검증한다.',
    parameters: OBJ({ data_json: S('STRING', '검증할 JSON 문자열'), schema_json: S('STRING', 'JSON Schema 문자열') }, ['data_json', 'schema_json']) },
  { name: 'security_scan', description: '보안 취약 패턴을 줄 번호와 함께 찾는다: eval, SQL 문자열 연결, 하드코딩 비밀값, 셸 주입, 역직렬화, TLS 비활성화 등.',
    parameters: OBJ({ code: S('STRING', '코드'), language: LANG_PROP }, ['code']) },
  { name: 'diff_summary', description: '두 버전의 코드를 줄 단위로 비교해 추가·삭제 줄 수와 유사도를 계산한다.',
    parameters: OBJ({ before: S('STRING', '이전 코드'), after: S('STRING', '새 코드') }, ['before', 'after']) }
];

module.exports = { DECL, IMPL, functionBodies, findSignatures };
