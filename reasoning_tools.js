/**
 * reasoning_tools.js — Gemini 함수 호출(function calling)용 추론 도구 모음
 *
 *   · 수학 도구 (MATH):   안전한 식 평가기, 수치 해법, 미적분 근사, 정수론, 선형대수, 항등식 검증
 *   · 코딩 도구 (CODING): 문법 검사(컴파일만, 실행 안 함), HTML 게임 점검, 흔한 버그 패턴, 반복문 중첩 추정
 *
 * 보안 원칙
 *   - 모델이 쓴 코드를 서버에서 실행하지 않는다. 코딩 도구는 컴파일·정적 분석만 한다.
 *   - 식 평가는 eval/new Function을 쓰지 않고 자체 파서로 처리한다.
 *   - 모든 인자는 스키마로 검증하고, 반복 횟수·입력 길이·출력 길이에 상한을 둔다.
 *
 * 사용: declarationsFor('math' | 'coding') 로 Gemini tools에 넣고,
 *       runToolLoop(...) 가 functionCall → 실행 → functionResponse 루프를 돈다.
 */
'use strict';
const vm = require('vm');

const MAX_EXPR = 500, MAX_CODE = 60_000, MAX_OUT = 4000;

// ======================================================================
// 공통 유틸
// ======================================================================
const num = (v, name) => {
  let n = typeof v === 'string' ? Number(v) : v;
  if (typeof v === 'string' && !Number.isFinite(n) && v.trim()) {   // 'pi/2', '-inf', '2^10' 같은 상수식 허용
    try { n = evalAst(parseExpr(v), {}); } catch { /* 아래에서 오류 */ }
  }
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`${name} 는 유한한 숫자여야 합니다`);
  return n;
};
const numInf = (v, name) => {
  if (typeof v === 'string' && /^\s*[+-]?\s*(inf|infinity|∞)\s*$/i.test(v)) return /^\s*-/.test(v) ? -Infinity : Infinity;
  if (v === Infinity || v === -Infinity) return v;
  return num(v, name);
};
const big = (v, name) => {
  try { return BigInt(String(v).trim()); } catch { throw new Error(`${name} 는 정수여야 합니다`); }
};
const str = (v, name, max) => {
  if (typeof v !== 'string') throw new Error(`${name} 는 문자열이어야 합니다`);
  if (max && v.length > max) throw new Error(`${name} 가 너무 깁니다 (최대 ${max}자)`);
  return v;
};

// ======================================================================
// 수학: 안전한 식 파서 (AST 생성 후 평가 — eval 미사용)
// ======================================================================
const FUNCS = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  log: Math.log, ln: Math.log, log10: Math.log10, log2: Math.log2, exp: Math.exp, sqrt: Math.sqrt,
  abs: Math.abs, floor: Math.floor, ceil: Math.ceil, round: Math.round,
  min: Math.min, max: Math.max,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, asinh: Math.asinh, acosh: Math.acosh, atanh: Math.atanh,
  cbrt: Math.cbrt, sign: Math.sign, trunc: Math.trunc, pow: Math.pow, atan2: Math.atan2, hypot: Math.hypot,
  sec: x => 1 / Math.cos(x), csc: x => 1 / Math.sin(x), cot: x => 1 / Math.tan(x),
  deg: x => (x * 180) / Math.PI, rad: x => (x * Math.PI) / 180, mod: (a, b) => ((a % b) + b) % b,
  fact: x => factN(x), factorial: x => factN(x), gamma: x => gammaFn(x),
  comb: (n, k) => combN(n, k), perm: (n, k) => { let r = 1; for (let i = 0; i < k; i++) r *= n - i; return r; },
  gcd: (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a; },
  lcm: (a, b) => { const g = FUNCS.gcd(a, b); return g ? Math.abs(a / g * b) : 0; },
  fib: n => { let a = 0, b = 1; for (let i = 0; i < n; i++) [a, b] = [b, a + b]; return a; }
};
function gammaFn(z) {
  if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gammaFn(1 - z));
  z -= 1;
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  let x = c[0]; for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
}
function factN(x) {
  if (!Number.isFinite(x) || x < 0) return NaN;
  if (Number.isInteger(x)) { if (x > 170) return Infinity; let r = 1; for (let i = 2; i <= x; i++) r *= i; return r; }
  return gammaFn(x + 1);
}
function combN(n, k) { if (k < 0 || k > n) return 0; k = Math.min(k, n - k); let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return Math.round(r); }
const CONSTS = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI, phi: (1 + Math.sqrt(5)) / 2, inf: Infinity };

/** LaTeX / 유니코드 수식 → 식 파서가 읽을 수 있는 평문 */
function normalizeMathInput(src) {
  let s = String(src ?? '');
  s = s.replace(/\\\(|\\\)|\\\[|\\\]/g, '');
  s = s.replace(/\$\$/g, '').replace(/\$/g, '');
  for (let k = 0; k < 8; k++) {
    const n = s.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '(($1)/($2))');
    if (n === s) break;
    s = n;
  }
  s = s.replace(/\\dfrac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '(($1)/($2))');
  s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, 'sqrt($1)');
  s = s.replace(/\\sqrt\s*([A-Za-z0-9]+)/g, 'sqrt($1)');
  s = s.replace(/\\cdot|\\times|\\ast|×|·/g, '*');
  s = s.replace(/\\div|÷/g, '/');
  s = s.replace(/\\pm/g, '+');
  s = s.replace(/\\mp/g, '-');
  s = s.replace(/\\leq|\\le|≤/g, '<=');
  s = s.replace(/\\geq|\\ge|≥/g, '>=');
  s = s.replace(/\\neq|\\ne|≠/g, '!=');
  s = s.replace(/\\infty|∞/g, 'Infinity');
  s = s.replace(/\^{([^{}]+)}/g, '^($1)');
  s = s.replace(/_{([^{}]+)}/g, '_$1');
  s = s.replace(/\\left\s*/g, '').replace(/\\right\s*/g, '');
  s = s.replace(/\\,/g, '').replace(/\\;/g, '').replace(/\\!/g, '').replace(/\\quad/g, ' ').replace(/\\qquad/g, ' ');
  s = s.replace(/\\pi\b/g, 'pi');
  s = s.replace(/\\sin\b/g, 'sin').replace(/\\cos\b/g, 'cos').replace(/\\tan\b/g, 'tan');
  s = s.replace(/\\log\b/g, 'log').replace(/\\ln\b/g, 'ln').replace(/\\exp\b/g, 'exp');
  s = s.replace(/\\abs\s*\{([^{}]*)\}/g, 'abs($1)');
  s = s.replace(/\\[a-zA-Z]+/g, '');
  const sup = { '⁰':'0','¹':'1','²':'2','³':'3','⁴':'4','⁵':'5','⁶':'6','⁷':'7','⁸':'8','⁹':'9' };
  s = s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, ch => '^' + (sup[ch] || ''));
  // 과학 표기(1e-5)와 함수·상수 이름을 보호한 뒤 암묵 곱셈(2x, ab, 2sin x)을 삽입한다
  const sci = [];
  s = s.replace(/\d+(?:\.\d+)?[eE][+-]?\d+/g, m => { sci.push(m); return `\u0005${String.fromCharCode(65 + sci.length - 1)}\u0006`; });
  const fnNames = Object.keys(FUNCS).sort((x, y) => y.length - x.length);
  const constNames = Object.keys(CONSTS).sort((x, y) => y.length - x.length);
  const fph = new Map(), cph = new Map();
  fnNames.forEach((k, i) => { const t = `\u0001${String.fromCharCode(97 + i)}\u0002`; if (s.includes(k)) { fph.set(t, k); s = s.split(k).join(t); } });
  constNames.forEach((k, i) => { const t = `\u0003${String.fromCharCode(97 + i)}\u0004`; if (s.includes(k)) { cph.set(t, k); s = s.split(k).join(t); } });
  s = s.replace(/(\d)([A-Za-z(\u0001\u0003])/g, '$1*$2');
  s = s.replace(/([A-Za-z])(\d)/g, '$1*$2');
  s = s.replace(/([A-Za-z)\u0002\u0004\u0006])([\u0003\u0001])/g, '$1*$2');
  s = s.replace(/([\u0004\u0006])([A-Za-z0-9(])/g, '$1*$2');
  for (let i = 0; i < 8; i++) {
    const n = s.replace(/([A-Za-z])([A-Za-z])/g, '$1*$2');
    if (n === s) break;
    s = n;
  }
  s = s.replace(/\)\s*\(/g, ')*(');
  s = s.replace(/\)\s*([A-Za-z0-9])/g, ')*$1');
  s = s.replace(/([A-Za-z0-9\u0004])\s*\(/g, '$1*(');
  for (const [t, k] of fph) s = s.split(t).join(k);
  for (const [t, k] of cph) s = s.split(t).join(k);
  sci.forEach((m, i) => { s = s.split(`\u0005${String.fromCharCode(65 + i)}\u0006`).join(m); });
  s = s.replace(/\s+/g, '');
  return s;
}

function tokenize(src) {
  src = normalizeMathInput(src);
  const out = [];
  const re = /\s*(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[A-Za-z_]\w*|[-+*/^%(),!])/y;
  let pos = 0;
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) throw new Error(`식에서 알 수 없는 문자 위치 ${pos}: '${src.slice(pos, pos + 12)}'`);
    out.push(m[1]);
    pos = re.lastIndex;
    if (out.length > 300) throw new Error('식의 토큰이 너무 많습니다');
  }
  return out;
}

function parseExpr(src) {
  const t = tokenize(src);
  let i = 0;
  const peek = () => t[i];
  const eat = x => {
    if (x !== undefined && t[i] !== x) throw new Error(`'${x}' 가 필요합니다 (위치 ${i})`);
    return t[i++];
  };
  const expr = () => {
    let n = term();
    while (peek() === '+' || peek() === '-') { const op = eat(); n = { op, a: n, b: term() }; }
    return n;
  };
  const term = () => {
    let n = unary();
    while (peek() === '*' || peek() === '/' || peek() === '%') { const op = eat(); n = { op, a: n, b: unary() }; }
    return n;
  };
  const unary = () => {
    if (peek() === '-') { eat(); return { op: 'neg', a: unary() }; }
    if (peek() === '+') { eat(); return unary(); }
    return power();
  };
  const power = () => {
    let base = primary();
    while (peek() === '!') { eat(); base = { fn: 'fact', args: [base] }; }
    if (peek() === '^') { eat(); return { op: '^', a: base, b: unary() }; }   // 우결합
    return base;
  };
  const primary = () => {
    const k = eat();
    if (k === undefined) throw new Error('식이 중간에 끝났습니다');
    if (/^\d/.test(k)) return { num: Number(k) };
    if (k === '(') { const n = expr(); eat(')'); return n; }
    if (/^[A-Za-z_]/.test(k)) {
      if (peek() === '(') {
        eat('(');
        if (!(k in FUNCS)) throw new Error(`알 수 없는 함수: ${k}`);
        const args = [expr()];
        while (peek() === ',') { eat(','); args.push(expr()); }
        eat(')');
        return { fn: k, args };
      }
      return { id: k };
    }
    throw new Error(`예상하지 못한 토큰: ${k}`);
  };
  const ast = expr();
  if (i !== t.length) throw new Error(`식 끝에 불필요한 토큰: ${t[i]}`);
  return ast;
}

function evalAst(n, env) {
  if ('num' in n) return n.num;
  if ('id' in n) {
    if (n.id in env) return env[n.id];
    if (n.id in CONSTS) return CONSTS[n.id];
    throw new Error(`알 수 없는 변수: ${n.id}`);
  }
  if ('fn' in n) {
    const args = n.args.map(a => evalAst(a, env));
    return FUNCS[n.fn](...args);
  }
  if (n.op === 'neg') return -evalAst(n.a, env);
  const a = evalAst(n.a, env), b = evalAst(n.b, env);
  switch (n.op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': return a / b;
    case '%': return a % b;
    case '^': return a ** b;
  }
  throw new Error('알 수 없는 연산자');
}

// 식을 한 번 파싱해 여러 값에 대해 빠르게 평가하는 함수 반환
function zeroForm(src) {
  const m = /^([^=<>!]*[^=<>!])=([^=][^=<>]*)$/.exec(src);   // 'x^2 = 4' → '(x^2)-(4)'
  return m && !/[<>!]=|==/.test(src) ? `(${m[1]})-(${m[2]})` : src;
}
const compile = (src, variable = 'x') => {
  str(src, 'expr', MAX_EXPR);
  const ast = parseExpr(zeroForm(src));
  return (value, extra = {}) => evalAst(ast, { ...extra, [variable]: value });
};

// ======================================================================
// 수학 도구 구현
// ======================================================================
const MATH = {};

MATH.eval_expr = ({ expr, vars }) => {
  const env = {};
  if (vars && typeof vars === 'object') for (const [k, v] of Object.entries(vars)) env[k] = num(v, `vars.${k}`);
  const f = compile(str(expr, 'expr', MAX_EXPR));
  const value = f(0, env);   // 변수 없이 상수식이면 바로 값
  return { value, finite: Number.isFinite(value) };
};

MATH.solve_numeric = ({ expr, var: v = 'x', lo, hi, samples = 4000 }) => {
  const a = num(lo, 'lo'), b = num(hi, 'hi');
  if (a >= b) throw new Error('lo 는 hi 보다 작아야 합니다');
  const N = Math.min(Math.max(100, Number(samples) || 4000), 20000);
  const f = compile(str(expr, 'expr', MAX_EXPR), v);
  const g = x => { try { return f(x); } catch { return NaN; } };
  const roots = [];
  let px = a, py = g(a);
  for (let i = 1; i <= N; i++) {
    const x = a + ((b - a) * i) / N, y = g(x);
    if (py === 0) roots.push(px);
    else if (Number.isFinite(py) && Number.isFinite(y) && py * y < 0) {
      let l = px, r = x, fl = py;
      for (let k = 0; k < 100; k++) {          // 이분법
        const m = (l + r) / 2, fm = g(m);
        if (!Number.isFinite(fm)) break;
        if (fl * fm <= 0) r = m; else { l = m; fl = fm; }
      }
      roots.push((l + r) / 2);
    }
    px = x; py = y;
  }
  const uniq = [...new Set(roots.map(r => Math.abs(r) < 1e-12 ? 0 : Number(r.toPrecision(10))))];
  return { roots: uniq.slice(0, 50), scanned: N, note: uniq.length ? undefined : '구간 안에서 부호 변화를 찾지 못했습니다(중근이거나 구간이 부적절할 수 있음)' };
};

MATH.derivative_at = ({ expr, var: v = 'x', x, order }) => {
  const f = compile(str(expr, 'expr', MAX_EXPR), v);
  const x0 = num(x, 'x');
  const ord = Math.min(4, Math.max(1, Math.floor(Number(order) || 1)));
  const h0 = Math.pow(1e-3, 1) * Math.max(1, Math.abs(x0));
  // Richardson 외삽: h, h/2, h/4 의 중심차분을 조합해 정확도를 높인다
  const cd = h => {
    if (ord === 1) return (f(x0 + h) - f(x0 - h)) / (2 * h);
    if (ord === 2) return (f(x0 + h) - 2 * f(x0) + f(x0 - h)) / (h * h);
    if (ord === 3) return (f(x0 + 2 * h) - 2 * f(x0 + h) + 2 * f(x0 - h) - f(x0 - 2 * h)) / (2 * h ** 3);
    return (f(x0 + 2 * h) - 4 * f(x0 + h) + 6 * f(x0) - 4 * f(x0 - h) + f(x0 - 2 * h)) / h ** 4;
  };
  const sc = ord <= 1 ? 1 : ord === 2 ? 20 : ord === 3 ? 60 : 200;
  const T = [];
  for (let i = 0; i < 4; i++) { T[i] = [cd(h0 / sc / 2 ** i)]; for (let j = 1; j <= i; j++) T[i][j] = T[i][j - 1] + (T[i][j - 1] - T[i - 1][j - 1]) / (4 ** j - 1); }
  const d = T[3][3];
  return { derivative: Number(d.toPrecision(12)), order: ord, method: 'Richardson 외삽 중심차분', errorEstimate: Math.abs(T[3][3] - T[2][2]) };
};

MATH.integrate = ({ expr, var: v = 'x', a, b, n = 1000 }) => {
  const f = compile(str(expr, 'expr', MAX_EXPR), v);
  const A = numInf(a, 'a'), B = numInf(b, 'b');
  let N = Math.min(Math.max(2, Math.floor(Number(n) || 1000)), 100000);
  if (N % 2) N++;
  const simpson = M => { const h = (B - A) / M; let s = f(A) + f(B); for (let i = 1; i < M; i++) s += f(A + i * h) * (i % 2 ? 4 : 2); return (s * h) / 3; };
  if (!Number.isFinite(A) || !Number.isFinite(B)) {   // 무한 구간: x = t/(1-t²) 치환
    const g = t => { const x = t / (1 - t * t), dx = (1 + t * t) / ((1 - t * t) ** 2); return f(x) * dx; };
    const lo = Number.isFinite(A) ? null : -1 + 1e-9, hi = Number.isFinite(B) ? null : 1 - 1e-9;
    const mapA = Number.isFinite(A) ? ((-1 + Math.sqrt(1 + 4 * A * A)) / (2 * A || 1)) : lo, mapB = Number.isFinite(B) ? ((-1 + Math.sqrt(1 + 4 * B * B)) / (2 * B || 1)) : hi;
    const a2 = A === 0 ? 0 : mapA, b2 = B === 0 ? 0 : mapB;
    const hh = (b2 - a2) / N; let ss = g(a2) + g(b2);
    for (let i = 1; i < N; i++) ss += g(a2 + i * hh) * (i % 2 ? 4 : 2);
    return { value: (ss * hh) / 3, method: 'Simpson (무한 구간 치환)', intervals: N };
  }
  const v1 = simpson(N), v2 = simpson(2 * N);
  return { value: v2, method: 'Simpson', intervals: 2 * N, errorEstimate: Math.abs(v2 - v1) / 15, reliable: Math.abs(v2 - v1) / 15 < 1e-7 * Math.max(1, Math.abs(v2)) };
};

MATH.check_identity = ({ lhs, rhs, var: v = 'x', lo = -10, hi = 10, samples = 200 }) => {
  const L = compile(str(lhs, 'lhs', MAX_EXPR), v), R = compile(str(rhs, 'rhs', MAX_EXPR), v);
  const a = num(lo, 'lo'), b = num(hi, 'hi');
  const N = Math.min(Math.max(10, Number(samples) || 200), 2000);
  let worst = 0, worstAt = null, bad = 0;
  for (let i = 0; i < N; i++) {
    const x = a + ((b - a) * (i + 0.5)) / N;
    const l = L(x), r = R(x);
    if (!Number.isFinite(l) || !Number.isFinite(r)) continue;
    const diff = Math.abs(l - r) / Math.max(1, Math.abs(l), Math.abs(r));
    if (diff > 1e-9) bad++;
    if (diff > worst) { worst = diff; worstAt = x; }
  }
  return { identical: bad === 0, maxRelativeDiff: worst, worstAt, mismatches: bad, samples: N };
};

MATH.verify_root = ({ expr, var: v = 'x', value, tol = 1e-9 }) => {
  const f = compile(str(expr, 'expr', MAX_EXPR), v);
  const x = num(value, 'value');
  const residual = f(x);
  return { residual, ok: Math.abs(residual) <= num(tol, 'tol') };
};

MATH.number_theory = ({ op, a, b, m, n }) => {
  const gcd2 = (x, y) => { x = x < 0n ? -x : x; y = y < 0n ? -y : y; while (y) [x, y] = [y, x % y]; return x; };
  const isSq = (x) => {
    if (x < 0n) return false;
    if (x <= 1n) return true;
    let lo = 1n, hi = x;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1n, sq = mid * mid;
      if (sq === x) return true;
      if (sq < x) lo = mid + 1n; else hi = mid - 1n;
    }
    return false;
  };
  const isqrt = (x) => {
    if (x < 0n) throw new Error('음수의 제곱근');
    if (x <= 1n) return x;
    let lo = 1n, hi = x, ans = 1n;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1n, sq = mid * mid;
      if (sq === x) return mid;
      if (sq < x) { ans = mid; lo = mid + 1n; } else hi = mid - 1n;
    }
    return ans;
  };
  switch (op) {
    case 'gcd': return { value: gcd2(big(a, 'a'), big(b, 'b')).toString() };
    case 'lcm': {
      const x = big(a, 'a'), y = big(b, 'b');
      if (x === 0n || y === 0n) return { value: '0' };
      const g = gcd2(x, y);
      let v = (x / g) * y; if (v < 0n) v = -v;
      return { value: v.toString() };
    }
    case 'modpow': {
      let base = big(a, 'a'), e = big(b, 'b'), mod = big(m, 'm');
      if (mod <= 0n || e < 0n) throw new Error('modpow: m>0, b>=0 이어야 합니다');
      let r = 1n; base %= mod;
      while (e > 0n) { if (e & 1n) r = (r * base) % mod; base = (base * base) % mod; e >>= 1n; }
      return { value: r.toString() };
    }
    case 'is_prime': return { value: isPrime(big(a, 'a')), n: String(a) };
    case 'factorize': {
      let x = big(a, 'a'); if (x < 0n) x = -x;
      if (x < 2n) return { factors: [], n: x.toString() };
      if (x > 10n ** 30n) throw new Error('인수분해는 1e30 이하만 지원합니다');
      const fm = factorMap(x);
      return { factors: [...fm].map(([p, e]) => `${p}^${e}`).join(' * '), n: String(a) };
    }
    case 'binom': {
      const N = big(a, 'a'), K = big(b, 'b');
      if (K < 0n || K > N) return { value: '0' };
      if (N > 5000n) throw new Error('n 은 5000 이하여야 합니다');
      let r = 1n; const k = K < N - K ? K : N - K;
      for (let i = 1n; i <= k; i++) r = (r * (N - k + i)) / i;
      return { value: r.toString() };
    }
    case 'factorial': {
      const N = big(a, 'a'); if (N < 0n || N > 2000n) throw new Error('0~2000 만 지원합니다');
      let r = 1n; for (let i = 2n; i <= N; i++) r *= i;
      return { value: r.toString(), digits: r.toString().length };
    }
    case 'divides': {
      const d = big(a, 'a'), n0 = big(b, 'b');
      if (d === 0n) throw new Error('0 으로 나눌 수 없습니다');
      const q = n0 / d, r = n0 % d;
      return { divides: r === 0n, divisor: d.toString(), dividend: n0.toString(), quotient: q.toString(), remainder: r.toString() };
    }
    case 'divmod': {
      const d = big(a, 'a'), n0 = big(b, 'b');
      if (d === 0n) throw new Error('0 으로 나눌 수 없습니다');
      return { quotient: (n0 / d).toString(), remainder: (n0 % d).toString() };
    }
    case 'is_square': {
      const x = big(a, 'a');
      const ok = isSq(x);
      return { value: ok, n: x.toString(), sqrt: ok ? isqrt(x).toString() : null };
    }
    case 'isqrt': return { value: isqrt(big(a, 'a')).toString(), n: String(a) };
    case 'egcd': {
      let A = big(a, 'a'), B = big(b, 'b');
      let x0 = 1n, y0 = 0n, x1 = 0n, y1 = 1n;
      while (B !== 0n) {
        const q = A / B;
        [A, B] = [B, A - q * B];
        [x0, x1] = [x1, x0 - q * x1];
        [y0, y1] = [y1, y0 - q * y1];
      }
      let g = A; let xx = x0, yy = y0;
      if (g < 0n) { g = -g; xx = -xx; yy = -yy; }
      return { gcd: g.toString(), x: xx.toString(), y: yy.toString(), identity: `${a}*${xx} + ${b}*${yy} = ${g}` };
    }
    case 'invmod': {
      const aa = big(a, 'a'), mm = big(b != null ? b : m, 'm');
      if (mm <= 0n) throw new Error('mod > 0');
      let A = ((aa % mm) + mm) % mm, B = mm;
      let x0 = 1n, x1 = 0n;
      while (B !== 0n) {
        const q = A / B;
        [A, B] = [B, A - q * B];
        [x0, x1] = [x1, x0 - q * x1];
      }
      if (A !== 1n && A !== -1n) throw new Error('역원이 없습니다 (서로소 아님)');
      if (A === -1n) x0 = -x0;
      const inv = ((x0 % mm) + mm) % mm;
      return { value: inv.toString(), a: aa.toString(), m: mm.toString() };
    }
    case 'totient': {
      const fs = factorMap(big(a, 'a'));
      let r = big(a, 'a'); for (const p of fs.keys()) r = (r / p) * (p - 1n);
      return { value: r.toString() };
    }
    case 'divisors': {
      const n0 = big(a, 'a'); if (n0 < 1n) throw new Error('양의 정수여야 합니다');
      let ds = [1n];
      for (const [p, e] of factorMap(n0)) { const nx = []; let pw = 1n; for (let i = 0; i <= e; i++) { for (const d of ds) nx.push(d * pw); pw *= p; } ds = nx; }
      ds.sort((x, y) => (x < y ? -1 : 1));
      return { count: ds.length, sum: ds.reduce((x, y) => x + y, 0n).toString(), divisors: ds.slice(0, 200).map(String) };
    }
    case 'nextprime': { let x = big(a, 'a') + 1n; for (let i = 0; i < 5000 && !isPrime(x); i++) x++; return { value: x.toString() }; }
    case 'prevprime': { let x = big(a, 'a') - 1n; for (let i = 0; i < 5000 && x > 1n && !isPrime(x); i++) x--; return { value: x > 1n ? x.toString() : null }; }
    case 'fib': { const N = Number(big(a, 'a')); if (N < 0 || N > 5000) throw new Error('0~5000'); let x = 0n, y = 1n; for (let i = 0; i < N; i++) [x, y] = [y, x + y]; return { value: x.toString() }; }
    case 'digit_sum': return { value: String(big(a, 'a')).replace('-', '').split('').reduce((x, y) => x + Number(y), 0) };
    case 'to_base': { const bs = Number(b); if (!(bs >= 2 && bs <= 36)) throw new Error('진법은 2~36'); return { value: big(a, 'a').toString(bs) }; }
    case 'crt': {   // a = "r1,r2,..." , b = "m1,m2,..."
      const rs = String(a).split(',').map(x => BigInt(x.trim())), ms = String(b).split(',').map(x => BigInt(x.trim()));
      if (rs.length !== ms.length) throw new Error('나머지와 법의 개수가 다릅니다');
      const inv = (x, m) => { let [g, y, x1] = [m, 0n, 1n], aa = ((x % m) + m) % m; let r0 = m, r1 = aa, t0 = 0n, t1 = 1n; while (r1) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [t0, t1] = [t1, t0 - q * t1]; } void g; void y; void x1; if (r0 !== 1n) throw new Error('법이 서로소가 아닙니다'); return ((t0 % m) + m) % m; };
      let X = 0n, M = 1n;
      for (let i = 0; i < rs.length; i++) { const k = (((rs[i] - X) % ms[i]) + ms[i]) % ms[i] * inv(M, ms[i]) % ms[i]; X += M * k; M *= ms[i]; }
      return { value: X.toString(), modulus: M.toString() };
    }
    default: throw new Error(`알 수 없는 op: ${op}`);
  }
};

function factorMap(n) {
  const out = new Map();
  const gcdB = (x, y) => { while (y) [x, y] = [y, x % y]; return x < 0n ? -x : x; };
  const rho = m => {
    if (m % 2n === 0n) return 2n;
    for (let c = 1n; c < 50n; c++) {
      let x = 2n, y = 2n, d = 1n;
      const f = v => (v * v + c) % m;
      let it = 0;
      while (d === 1n && it++ < 200000) { x = f(x); y = f(f(y)); d = gcdB(x - y, m); }
      if (d !== 1n && d !== m) return d;
    }
    return m;
  };
  const rec = m => {
    if (m === 1n) return;
    if (isPrime(m)) { out.set(m, (out.get(m) || 0) + 1); return; }
    let p = 2n;
    for (const q of [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n]) if (m % q === 0n) { p = q; break; }
    if (m % p === 0n && p < 40n) { out.set(p, (out.get(p) || 0) + 1); return rec(m / p); }
    const d = rho(m);
    if (d === m) { out.set(m, (out.get(m) || 0) + 1); return; }
    rec(d); rec(m / d);
  };
  rec(n < 0n ? -n : n);
  return new Map([...out].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}
function isPrime(n) {
  if (n < 2n) return false;
  for (const p of [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n]) { if (n === p) return true; if (n % p === 0n) return false; }
  let d = n - 1n, s = 0; while (d % 2n === 0n) { d /= 2n; s++; }
  const pw = (b, e, mod) => { let r = 1n; b %= mod; while (e) { if (e & 1n) r = (r * b) % mod; b = (b * b) % mod; e >>= 1n; } return r; };
  for (const a of [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n]) {   // 결정적 Miller–Rabin
    let x = pw(a, d, n);
    if (x === 1n || x === n - 1n) continue;
    let ok = false;
    for (let r = 1; r < s; r++) { x = (x * x) % n; if (x === n - 1n) { ok = true; break; } }
    if (!ok) return false;
  }
  return true;
}

MATH.eval_integer = ({ expr, vars }) => {
  const e = str(expr, 'expr', MAX_EXPR * 2);
  const env = {};
  if (vars && typeof vars === 'object') {
    for (const [k, v] of Object.entries(vars)) env[k] = Number(v);
  }
  const plain = normalizeMathInput(e);
  const val = evalAst(parseExpr(plain), env);
  const nearest = Math.round(val);
  const isInt = Number.isFinite(val) && Math.abs(val - nearest) < 1e-9;
  return { value: val, integer: isInt, as_int: isInt ? nearest : null, normalized: plain };
};

MATH.divisibility_search = ({ num_expr, den_expr, vars = ['a', 'b'], max = 40, require_square = false, positive = true }) => {
  const ne = str(num_expr, 'num_expr', MAX_EXPR * 2);
  const de = str(den_expr, 'den_expr', MAX_EXPR * 2);
  const names = Array.isArray(vars) && vars.length ? vars.map(String).slice(0, 3) : ['a', 'b'];
  const M = Math.min(Math.max(3, Number(max) || 40), 80);
  const nAst = parseExpr(ne);
  const dAst = parseExpr(de);
  const hits = [];
  const start = positive ? 1 : -M;
  const ranges = names.map(() => {
    const arr = [];
    for (let i = start; i <= M; i++) if (i !== 0 || !positive) arr.push(i);
    return arr;
  });
  let scanned = 0;
  const limit = 25000;
  function rec(depth, env) {
    if (hits.length >= 40 || scanned >= limit) return;
    if (depth === names.length) {
      scanned++;
      try {
        const nv = evalAst(nAst, env), dv = evalAst(dAst, env);
        if (!Number.isFinite(nv) || !Number.isFinite(dv) || dv === 0) return;
        const Ni = Math.round(nv), Di = Math.round(dv);
        if (Math.abs(nv - Ni) > 1e-8 || Math.abs(dv - Di) > 1e-8) return;
        if (Ni % Di !== 0) return;
        const q = Ni / Di;
        const qAbs = Math.abs(q);
        const root = Math.round(Math.sqrt(qAbs));
        const sq = root * root === qAbs;
        if (require_square && !sq) return;
        hits.push({ vars: { ...env }, numerator: Ni, denominator: Di, quotient: q, is_square: sq, sqrt: sq ? root * Math.sign(q || 1) : null });
      } catch { /* skip */ }
      return;
    }
    for (const v of ranges[depth]) {
      env[names[depth]] = v;
      rec(depth + 1, env);
      if (hits.length >= 40 || scanned >= limit) return;
    }
  }
  rec(0, {});
  return {
    hits: hits.slice(0, 30),
    scanned,
    num_normalized: normalizeMathInput(ne),
    den_normalized: normalizeMathInput(de),
    note: hits.length
      ? `조건 만족 ${hits.length}개 예시. 몫이 제곱인 비율은 증명 힌트가 될 수 있음.`
      : '범위 안에서 예시 없음. 식·변수·범위를 조정하거나 대수적 증명을 진행하라.'
  };
};

MATH.poly_div_hint = ({ a, b }) => {
  const A = big(a, 'a'), B = big(b, 'b');
  const num = A * A + B * B;
  const den = A * B + 1n;
  if (den === 0n) throw new Error('ab+1 = 0');
  const q = num / den, r = num % den;
  const isSq = (x) => {
    if (x < 0n) return false;
    let lo = 0n, hi = x;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1n, sq = mid * mid;
      if (sq === x) return true;
      if (sq < x) lo = mid + 1n; else hi = mid - 1n;
    }
    return false;
  };
  const candidates = [];
  for (let k = 0n; k <= 30n; k++) {
    const rem = num - k * den;
    if (rem === 0n || isSq(rem)) candidates.push({ k: k.toString(), remainder: rem.toString(), remainder_is_square: isSq(rem) });
  }
  return {
    a: A.toString(), b: B.toString(),
    numerator: num.toString(), denominator: den.toString(),
    quotient: q.toString(), remainder: r.toString(), divides: r === 0n,
    identity_check: `${A}^2+${B}^2 = ${q}*(${A}*${B}+1) + ${r}`,
    small_k_scan: candidates.slice(0, 12),
    quotient_is_square: r === 0n && isSq(q < 0n ? -q : q),
    hint: r === 0n
      ? '나누어떨어짐. 몫이 제곱인지는 number_theory is_square 로 확인.'
      : '이 값에서는 나누어떨어지지 않음. 증명 시 대칭·강하(descent) 아이디어를 사용.'
  };
};

MATH.normalize_math = ({ text }) => {
  const raw = str(text, 'text', 4000);
  return { normalized: normalizeMathInput(raw), original: raw };
};

MATH.solve_linear = ({ matrix, rhs }) => {
  if (!Array.isArray(matrix) || !matrix.length || matrix.length > 12) throw new Error('행렬은 1~12 크기여야 합니다');
  const n = matrix.length;
  const A = matrix.map((row, i) => {
    if (!Array.isArray(row) || row.length !== n) throw new Error('정사각행렬이어야 합니다');
    return row.map((x, j) => num(x, `matrix[${i}][${j}]`));
  });
  const b = rhs === undefined ? null : rhs.map((x, i) => num(x, `rhs[${i}]`));
  const M = A.map((r, i) => [...r, b ? b[i] : 0]);
  let det = 1;
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return { determinant: 0, solvable: false, note: '특이 행렬(행렬식 0)' };
    if (p !== c) { [M[p], M[c]] = [M[c], M[p]]; det = -det; }
    det *= M[c][c];
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  if (!b) return { determinant: det };
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return { solution: x.map(v => Number(v.toPrecision(12))), determinant: det, solvable: true };
};

MATH.quadratic = ({ a, b, c }) => {
  const A = num(a, 'a'), B = num(b, 'b'), C = num(c, 'c');
  if (A === 0) throw new Error('a 는 0이 아니어야 합니다 (일차방정식)');
  const D = B * B - 4 * A * C;
  if (D >= 0) {
    const s = Math.sqrt(D), q = -(B + Math.sign(B || 1) * s) / 2;
    const r1 = q / A, r2 = q !== 0 ? C / q : -B / (2 * A) - 0;
    return { discriminant: D, roots: [r1, r2].sort((x, y) => x - y).map(v => Number(v.toPrecision(12))), kind: D === 0 ? 'double' : 'real' };
  }
  const re = -B / (2 * A), im = Math.sqrt(-D) / (2 * Math.abs(A));
  return { discriminant: D, roots: [`${re.toPrecision(12)} + ${im.toPrecision(12)}i`, `${re.toPrecision(12)} - ${im.toPrecision(12)}i`], kind: 'complex' };
};

// ======================================================================
// 코딩 도구 구현 (컴파일·정적 분석만, 실행 없음)
// ======================================================================
const CODING = {};

CODING.check_js_syntax = ({ code }) => {
  const src = str(code, 'code', MAX_CODE);
  try {
    const r = require('./js_analyzer').checkSyntax(src);   // ESM·최상위 await/return 도 허용, 줄·칸·원인 힌트 제공
    if (r.ok) return { ok: true, module: !!r.module };
    return { ok: false, error: r.message, line: r.line, col: r.col, hint: r.hint, frame: r.frame };
  } catch {
    try { new vm.Script(src, { filename: 'candidate.js' }); return { ok: true }; }
    catch (e) { const m = /candidate\.js:(\d+)/.exec(e.stack || ''); return { ok: false, error: e.message, line: m ? Number(m[1]) : null }; }
  }
};

const FORBIDDEN = [
  [/\bfetch\s*\(|XMLHttpRequest|WebSocket|navigator\.sendBeacon/, '외부 네트워크 호출'],
  [/\bimportScripts\b|\bimport\s*\(/, '동적 로드'],
  [/document\.cookie|localStorage|sessionStorage|indexedDB/, '브라우저 저장소 접근'],
  [/\bwindow\.(parent|top|opener)\b|\b(parent|top)\.(location|document)/, '상위 창 접근'],
  [/\beval\s*\(|new\s+Function\s*\(/, '동적 코드 실행']
];

CODING.check_html_game = ({ html }) => {
  const src = str(html, 'html', MAX_CODE);
  const issues = [], warnings = [];
  const scripts = [...src.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  for (const [, attrs, body] of scripts) {
    if (/\bsrc\s*=/.test(attrs) && !/https:\/\/cdnjs\.cloudflare\.com\//.test(attrs)) warnings.push('허용되지 않은 외부 스크립트 src');
    if (body.trim()) {
      try { new vm.Script(body, { filename: 'game.js' }); }
      catch (e) { issues.push(`스크립트 문법 오류: ${e.message}`); }
      for (const [re, label] of FORBIDDEN) if (re.test(body)) issues.push(`금지된 패턴: ${label}`);
    }
  }
  if (!scripts.length) issues.push('<script> 블록이 없습니다');
  if (!/<canvas\b|id\s*=\s*["'][^"']+["']/i.test(src)) warnings.push('게임 화면 요소(canvas 또는 id 지정 요소)가 없습니다');
  if (!/requestAnimationFrame|setInterval|setTimeout|addEventListener/.test(src)) warnings.push('게임 루프 또는 입력 처리가 보이지 않습니다');
  return { ok: issues.length === 0, issues, warnings, scriptBlocks: scripts.length };
};

const BUG_RULES = {
  js: [
    [/[^=!<>]==[^=]/, '== 사용. 타입 변환을 피하려면 === 권장'],
    [/\bif\s*\([^=)]*[^=!<>]=[^=]/, 'if 조건에 대입(=) 의심'],
    [/catch\s*\([^)]*\)\s*\{\s*\}/, '빈 catch 블록: 오류를 삼킴'],
    [/\bparseInt\s*\([^,)]+\)/, 'parseInt 진법(radix) 생략'],
    [/\.innerHTML\s*=/, 'innerHTML 대입: 사용자 입력이면 XSS 위험'],
    [/\bsetTimeout\s*\(\s*['"]/, '문자열을 setTimeout에 넘김(동적 실행)'],
    [/\bvar\s+\w+/, 'var 사용: 블록 스코프 문제 가능, let/const 권장']
  ],
  python: [
    [/def\s+\w+\s*\([^)]*=\s*(\[\]|\{\}|set\(\))/, '가변 기본 인자(mutable default)'],
    [/except\s*:/, 'bare except: 모든 예외를 삼킴'],
    [/[=!]=\s*None\b/, 'None 비교에 == 사용: is None 권장'],
    [/\bis\s+(['"\d])/, 'is 로 리터럴 비교: 값 비교는 == 사용'],
    [/\bmutable\b|\bTODO\b|\bFIXME\b/, '미완료 표시']
  ]
};
CODING.find_bug_patterns = ({ code, language = 'js' }) => {
  const src = str(code, 'code', MAX_CODE);
  const lang = language === 'python' ? 'python' : 'js';
  const findings = [];
  const maskLine = l => (lang === 'js'
    ? l.replace(/\/\/.*$/, '').replace(/(["'`])(?:\\.|(?!\1).)*\1/g, m => m[0] + ' '.repeat(m.length - 2) + m[0])
    : l.replace(/#.*$/, '').replace(/(["'])(?:\\.|(?!\1).)*\1/g, m => m[0] + ' '.repeat(m.length - 2) + m[0]));
  src.split('\n').forEach((line, i) => {
    const mk = maskLine(line);
    for (const [re, msg] of BUG_RULES[lang]) if (re.test(mk)) findings.push({ line: i + 1, message: msg, text: line.trim().slice(0, 120) });
  });
  return { language: lang, count: findings.length, findings: findings.slice(0, 60), note: '정적 패턴 기반 점검이므로 오탐이 있을 수 있습니다' };
};

CODING.estimate_loop_depth = ({ code, language = 'js' }) => {
  const src = str(code, 'code', MAX_CODE);
  if (language !== 'python') {
    try {
      const A = require('./js_analyzer');
      const r = A.analyzeJs(src, {});
      if (r.functions.length) {
        const worst = r.functions.slice().sort((x, y) => y.loopDepth - x.loopDepth || y.cyclomatic - x.cyclomatic);
        const w = worst[0];
        return { maxLoopNesting: w.loopDepth, estimate: A.complexityLabel(w), worst: w.name, functions: worst.slice(0, 6).map(f => ({ name: f.name, line: f.line, loopDepth: f.loopDepth, time: A.complexityLabel(f) })), note: '반복문+콜백(map/filter/…) 중첩, 루프 안 선형 탐색, 재귀를 반영한 AST 기반 추정' };
      }
    } catch { /* 아래 근사 방식으로 */ }
  }
  const py = language === 'python';
  let maxDepth = 0, cur = 0;
  if (py) {
    const stack = [];   // 루프 시작 들여쓰기
    for (const line of src.split('\n')) {
      if (!line.trim()) continue;
      const indent = line.match(/^\s*/)[0].length;
      while (stack.length && indent <= stack[stack.length - 1]) stack.pop();
      if (/^\s*(for|while)\b.*:\s*$/.test(line)) { stack.push(indent); maxDepth = Math.max(maxDepth, stack.length); }
    }
  } else {
    let braces = 0; const loopBraces = [];
    for (const line of src.split('\n')) {
      while (loopBraces.length && braces < loopBraces[loopBraces.length - 1]) loopBraces.pop();
      if (/\b(for|while)\s*\(/.test(line)) { loopBraces.push(braces + (line.includes('{') ? 0 : 0)); maxDepth = Math.max(maxDepth, loopBraces.length); }
      for (const ch of line) { if (ch === '{') braces++; else if (ch === '}') braces--; }
    }
  }
  cur = maxDepth;
  const estimate = cur === 0 ? 'O(1) 또는 O(n) 이하 (반복문 없음)' : cur === 1 ? 'O(n) 추정 (단일 반복문)' : `O(n^${cur}) 추정 (반복문 중첩 ${cur}단계)`;
  return { maxLoopNesting: cur, estimate, note: '반복문 중첩 수 기반 추정이며, 재귀·정렬 호출·자료구조 비용은 반영하지 않습니다' };
};

// ======================================================================
// 선언 (Gemini functionDeclarations) + 디스패치
// ======================================================================
const S = (type, description, extra = {}) => ({ type, description, ...extra });
const OBJ = (properties, required) => ({ type: 'OBJECT', properties, required });

const DECL = {
  math: [
    { name: 'eval_expr', description: '수식을 정확히 계산한다. 사칙연산·^·!·sin/cos/log/sqrt/gamma/comb/gcd 등 지원, 2x·3pi 같은 암묵 곱셈과 LaTeX 허용. 계산 결과를 추측하지 말고 이 도구로 확인하라.',
      parameters: OBJ({ expr: S('STRING', '예: 2^10 + sqrt(2)*3'), vars: S('OBJECT', '변수 값 맵 (선택)') }, ['expr']) },
    { name: 'solve_numeric', description: '한 변수 방정식 f(x)=0 의 실근을 구간에서 찾는다. 부호 변화 기반 탐색 + 이분법.',
      parameters: OBJ({ expr: S('STRING', 'f(x) 식 또는 방정식 (예: x^3 - 2*x - 5, x^2 = 4)'), var: S('STRING', '변수 이름, 기본 x'), lo: S('NUMBER', '구간 시작'), hi: S('NUMBER', '구간 끝'), samples: S('INTEGER', '탐색 점 개수 (100~20000)') }, ['expr', 'lo', 'hi']) },
    { name: 'derivative_at', description: '한 점에서의 미분값(중심차분 근사).',
      parameters: OBJ({ expr: S('STRING', 'f(x)'), var: S('STRING', '변수'), x: S('NUMBER', '미분할 점 (pi/3 같은 상수식도 가능)'), order: S('INTEGER', '미분 차수 1~4, 기본 1') }, ['expr', 'x']) },
    { name: 'integrate', description: '정적분 근사(Simpson 법칙).',
      parameters: OBJ({ expr: S('STRING', 'f(x)'), var: S('STRING', '변수'), a: S('NUMBER', '하한 (pi/2, -inf 가능)'), b: S('NUMBER', '상한 (inf 가능)'), n: S('INTEGER', '구간 수(짝수, 최대 100000)') }, ['expr', 'a', 'b']) },
    { name: 'check_identity', description: '두 식이 같은 함수인지 여러 점에서 비교한다. 대수적 변형이 맞는지 검증할 때 사용.',
      parameters: OBJ({ lhs: S('STRING', '좌변 식'), rhs: S('STRING', '우변 식'), var: S('STRING', '변수'), lo: S('NUMBER', '검사 구간 시작'), hi: S('NUMBER', '검사 구간 끝'), samples: S('INTEGER', '검사 점 개수') }, ['lhs', 'rhs']) },
    { name: 'verify_root', description: '제시한 해 value 가 f(x)=0 을 만족하는지 대입해 확인한다.',
      parameters: OBJ({ expr: S('STRING', 'f(x)'), var: S('STRING', '변수'), value: S('NUMBER', '후보 해'), tol: S('NUMBER', '허용 오차') }, ['expr', 'value']) },
    { name: 'number_theory', description: '정수론(BigInt 정확 계산). op: gcd,lcm,modpow,is_prime,factorize(1e30까지, Pollard rho),binom,factorial,divides(a|b),divmod,is_square,isqrt,egcd,invmod,totient,divisors,nextprime,prevprime,fib,digit_sum,to_base(b=진법),crt(a="r1,r2", b="m1,m2").',
      parameters: OBJ({ op: S('STRING', '연산', { enum: ['gcd', 'lcm', 'modpow', 'is_prime', 'factorize', 'binom', 'factorial', 'divides', 'divmod', 'is_square', 'isqrt', 'egcd', 'invmod', 'totient', 'divisors', 'nextprime', 'prevprime', 'fib', 'digit_sum', 'to_base', 'crt'] }), a: S('STRING', '첫 정수'), b: S('STRING', '둘째 정수/mod'), m: S('STRING', 'modpow 법') }, ['op', 'a']) },
    { name: 'normalize_math', description: 'LaTeX/유니코드 수식(\\( a \\) , \\frac{a^2+b^2}{ab+1}, 1/2)을 평문 식으로 변환.',
      parameters: OBJ({ text: S('STRING', '원문 수식') }, ['text']) },
    { name: 'eval_integer', description: '정수 변수로 식 평가. LaTeX 허용. 예: (a^2+b^2)/(a*b+1)',
      parameters: OBJ({ expr: S('STRING', '식'), vars: { type: 'OBJECT', description: '변수→숫자' } }, ['expr']) },
    { name: 'divisibility_search', description: 'num이 den으로 나누어떨어지는 정수 조합 탐색 + 몫이 완전제곱인지. 예: a^2+b^2 , a*b+1',
      parameters: OBJ({ num_expr: S('STRING', '분자'), den_expr: S('STRING', '분모'), vars: { type: 'ARRAY', items: { type: 'STRING' } }, max: S('INTEGER', '탐색 상한'), require_square: S('BOOLEAN', '제곱만'), positive: S('BOOLEAN', '양의 정수만') }, ['num_expr', 'den_expr']) },
    { name: 'poly_div_hint', description: '(a^2+b^2)/(ab+1) 나눗셈·제곱 여부 스캔. 정수 나눗셈 증명 보조.',
      parameters: OBJ({ a: S('STRING', 'a'), b: S('STRING', 'b') }, ['a', 'b']) },
    { name: 'solve_linear', description: '선형 연립방정식 Ax=b 풀이 및 행렬식. rhs 를 생략하면 행렬식만 계산.',
      parameters: OBJ({ matrix: { type: 'ARRAY', items: { type: 'ARRAY', items: { type: 'NUMBER' } }, description: '정사각행렬' }, rhs: { type: 'ARRAY', items: { type: 'NUMBER' }, description: '우변 벡터 (선택)' } }, ['matrix']) },
    { name: 'quadratic', description: '이차방정식 ax²+bx+c=0 의 근 (판별식, 복소근 포함).',
      parameters: OBJ({ a: S('NUMBER', 'x² 계수'), b: S('NUMBER', 'x 계수'), c: S('NUMBER', '상수항') }, ['a', 'b', 'c']) }
  ],
  coding: [
    { name: 'check_js_syntax', description: 'JavaScript 코드의 문법 오류를 찾는다(컴파일만 하고 실행하지 않음).',
      parameters: OBJ({ code: S('STRING', '검사할 JS 코드') }, ['code']) },
    { name: 'check_html_game', description: 'HTML 게임 파일을 점검한다: 스크립트 문법, 금지 패턴(외부 요청, 저장소 접근, 동적 실행), 게임 루프·화면 요소 존재 여부.',
      parameters: OBJ({ html: S('STRING', '전체 HTML 문자열') }, ['html']) },
    { name: 'find_bug_patterns', description: '흔한 버그 패턴을 줄 번호와 함께 찾는다(정적 규칙 기반).',
      parameters: OBJ({ code: S('STRING', '코드'), language: S('STRING', 'js 또는 python', { enum: ['js', 'python'] }) }, ['code']) },
    { name: 'estimate_loop_depth', description: '반복문 중첩 깊이로 시간 복잡도를 추정한다.',
      parameters: OBJ({ code: S('STRING', '코드'), language: S('STRING', 'js 또는 python', { enum: ['js', 'python'] }) }, ['code']) }
  ]
};

module.exports = { MATH, CODING, DECL, parseExpr, compile, normalizeMathInput };
