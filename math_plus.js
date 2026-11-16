'use strict';
// 수학 도구 2차 확장 (모두 서버 안의 순수 계산, eval 미사용)
//  exact_eval     : BigInt 분수로 정확 계산 (부동소수 오차 없음)
//  symbolic_diff  : 기호 미분 + 간단화 (결과를 수치로 교차 검증)
//  stats          : 기술통계·상관·회귀·정규/이항/푸아송
//  matrix_ops     : 행렬식·역행렬·계수·곱·고유값(복소수 포함)·RREF
//  limit_numeric  : 극한(양쪽 접근, 무한대) 수치 추정
//  sequence_next  : 수열 규칙 추정(등차·등비·다항·피보나치형)과 다음 항
//  extrema        : 구간 최대·최소와 극점
const core = require('./reasoning_tools');
const { parseExpr, compile, normalizeMathInput } = core;

const S = (type, description, extra = {}) => ({ type, description, ...extra });
const OBJ = (properties, required) => ({ type: 'OBJECT', properties, required });
const NUM_ARR = d => ({ type: 'ARRAY', items: { type: 'NUMBER' }, description: d });
const clean = v => (typeof v === 'number' ? (Number.isFinite(v) ? Number(v.toPrecision(12)) : String(v)) : v);
const nums = (a, name, max = 5000) => {
  if (!Array.isArray(a) || !a.length || a.length > max) throw new Error(`${name} 는 1~${max}개의 숫자 배열이어야 합니다`);
  return a.map((x, i) => { const n = Number(x); if (!Number.isFinite(n)) throw new Error(`${name}[${i}] 는 숫자여야 합니다`); return n; });
};
const IMPL = {};

// ---------------------------------------------------------------------------
// exact_eval: BigInt 유리수
// ---------------------------------------------------------------------------
const gcdB = (a, b) => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a; };
const Q = (n, d = 1n) => { if (d === 0n) throw new Error('0 으로 나눌 수 없습니다'); if (d < 0n) { n = -n; d = -d; } const g = gcdB(n, d) || 1n; return { n: n / g, d: d / g }; };
const qAdd = (a, b) => Q(a.n * b.d + b.n * a.d, a.d * b.d);
const qMul = (a, b) => Q(a.n * b.n, a.d * b.d);
const qDiv = (a, b) => Q(a.n * b.d, a.d * b.n);
const qPow = (a, e) => {
  if (e.d !== 1n) throw new Error('분수 지수는 정확 계산을 지원하지 않습니다 (eval_expr 사용)');
  let k = e.n; if (k > 5000n || k < -5000n) throw new Error('지수가 너무 큽니다');
  let base = a; if (k < 0n) { base = Q(a.d, a.n); k = -k; }
  let r = Q(1n); for (let i = 0n; i < k; i++) r = qMul(r, base); return r;
};
const isqrtB = x => { if (x < 2n) return x; let lo = 1n, hi = x; while (lo < hi) { const m = (lo + hi + 1n) >> 1n; if (m * m <= x) lo = m; else hi = m - 1n; } return lo; };
function exactParse(src) {
  const s = normalizeMathInput(src).replace(/\s+/g, '');
  let i = 0;
  const peek = () => s[i];
  const expr = () => { let v = term(); while (peek() === '+' || peek() === '-') { const op = s[i++]; const r = term(); v = op === '+' ? qAdd(v, r) : qAdd(v, Q(-r.n, r.d)); } return v; };
  const term = () => { let v = unary(); while (peek() === '*' || peek() === '/' || peek() === '%') { const op = s[i++]; const r = unary(); if (op === '*') v = qMul(v, r); else if (op === '/') v = qDiv(v, r); else { if (v.d !== 1n || r.d !== 1n) throw new Error('% 는 정수만'); v = Q(((v.n % r.n) + r.n) % r.n); } } return v; };
  const unary = () => { if (peek() === '-') { i++; const v = unary(); return Q(-v.n, v.d); } if (peek() === '+') { i++; return unary(); } return power(); };
  const power = () => { let b = postfix(); if (peek() === '^') { i++; const e = unary(); b = qPow(b, e); } return b; };
  const postfix = () => { let v = primary(); while (peek() === '!') { i++; if (v.d !== 1n || v.n < 0n || v.n > 3000n) throw new Error('팩토리얼은 0~3000 정수'); let r = 1n; for (let k = 2n; k <= v.n; k++) r *= k; v = Q(r); } return v; };
  const primary = () => {
    if (peek() === '(') { i++; const v = expr(); if (s[i++] !== ')') throw new Error("')' 가 필요합니다"); return v; }
    const m = /^(\d+)(?:\.(\d+))?/.exec(s.slice(i));
    if (m) { i += m[0].length; return m[2] ? Q(BigInt(m[1] + m[2]), 10n ** BigInt(m[2].length)) : Q(BigInt(m[1])); }
    const f = /^([A-Za-z_]+)\(/.exec(s.slice(i));
    if (f) {
      i += f[0].length; const args = [expr()]; while (peek() === ',') { i++; args.push(expr()); } if (s[i++] !== ')') throw new Error("')' 가 필요합니다");
      const ints = args.map(a => { if (a.d !== 1n) throw new Error(`${f[1]} 는 정수 인자만`); return a.n; });
      switch (f[1]) {
        case 'abs': return Q(args[0].n < 0n ? -args[0].n : args[0].n, args[0].d);
        case 'gcd': return Q(gcdB(ints[0], ints[1]));
        case 'lcm': return Q(ints[0] / gcdB(ints[0], ints[1]) * ints[1]);
        case 'comb': { let r = 1n; const n = ints[0], k = ints[1]; if (k < 0n || k > n) return Q(0n); const kk = k < n - k ? k : n - k; for (let t = 1n; t <= kk; t++) r = r * (n - kk + t) / t; return Q(r); }
        case 'perm': { let r = 1n; for (let t = 0n; t < ints[1]; t++) r *= ints[0] - t; return Q(r); }
        case 'sqrt': { const a = args[0]; const rn = isqrtB(a.n), rd = isqrtB(a.d); if (a.n < 0n || rn * rn !== a.n || rd * rd !== a.d) throw new Error('완전제곱이 아니어서 정확한 sqrt 를 표현할 수 없습니다'); return Q(rn, rd); }
        case 'floor': return Q(args[0].n / args[0].d - (args[0].n % args[0].d !== 0n && args[0].n < 0n ? 1n : 0n));
        case 'min': return args.reduce((x, y) => (x.n * y.d <= y.n * x.d ? x : y));
        case 'max': return args.reduce((x, y) => (x.n * y.d >= y.n * x.d ? x : y));
        case 'mod': return Q(((ints[0] % ints[1]) + ints[1]) % ints[1]);
        default: throw new Error(`exact_eval 이 지원하지 않는 함수: ${f[1]}`);
      }
    }
    throw new Error(`해석할 수 없는 위치: '${s.slice(i, i + 10)}' (변수가 있으면 eval_expr 에 vars 로 값을 주세요)`);
  };
  const v = expr();
  if (i !== s.length) throw new Error(`식 끝에 불필요한 문자: '${s.slice(i, i + 10)}'`);
  return v;
}
IMPL.exact_eval = ({ expr }) => {
  if (typeof expr !== 'string' || expr.length > 800) throw new Error('expr 는 800자 이하 문자열');
  const q = exactParse(expr);
  const dec = (() => { const neg = q.n < 0n; let n = neg ? -q.n : q.n; const ip = n / q.d; let r = n % q.d, frac = ''; for (let k = 0; k < 30 && r; k++) { r *= 10n; frac += (r / q.d).toString(); r %= q.d; } return `${neg ? '-' : ''}${ip}${frac ? '.' + frac : ''}${r ? '…' : ''}`; })();
  const str = q.n.toString();
  return { exact: q.d === 1n ? str : `${str}/${q.d}`, integer: q.d === 1n, numerator: str.length > 200 ? str.slice(0, 200) + '…' : str, denominator: q.d.toString().slice(0, 200), decimal: dec, digits: q.d === 1n ? str.replace('-', '').length : undefined };
};

// ---------------------------------------------------------------------------
// symbolic_diff
// ---------------------------------------------------------------------------
const N = v => ({ num: v });
const isNum = (n, v) => 'num' in n && (v === undefined || n.num === v);
const mk = (op, a, b) => ({ op, a, b });
function simp(n) {
  if ('num' in n || 'id' in n) return n;
  if ('fn' in n) {
    const args = n.args.map(simp);
    if (args.every(a => 'num' in a)) { try { const v = ({ sin: Math.sin, cos: Math.cos, tan: Math.tan, exp: Math.exp, ln: Math.log, log: Math.log, sqrt: Math.sqrt, abs: Math.abs, atan: Math.atan, asin: Math.asin, acos: Math.acos })[n.fn]; if (v) { const r = v(args[0].num); if (Number.isFinite(r) && (Number.isInteger(r) || n.fn === 'abs')) return N(r); } } catch { /* keep */ } }
    return { fn: n.fn, args };
  }
  if (n.op === 'neg') { const a = simp(n.a); if ('num' in a) return N(-a.num); if (a.op === 'neg') return a.a; return { op: 'neg', a }; }
  const a = simp(n.a), b = simp(n.b);
  switch (n.op) {
    case '+': if (isNum(a, 0)) return b; if (isNum(b, 0)) return a; if ('num' in a && 'num' in b) return N(a.num + b.num); return mk('+', a, b);
    case '-': if (isNum(b, 0)) return a; if (isNum(a, 0)) return simp({ op: 'neg', a: b }); if ('num' in a && 'num' in b) return N(a.num - b.num); if (JSON.stringify(a) === JSON.stringify(b)) return N(0); return mk('-', a, b);
    case '*':
      if (isNum(a, 0) || isNum(b, 0)) return N(0); if (isNum(a, 1)) return b; if (isNum(b, 1)) return a;
      if ('num' in a && 'num' in b) return N(a.num * b.num);
      if (isNum(a, -1)) return simp({ op: 'neg', a: b }); if (isNum(b, -1)) return simp({ op: 'neg', a });
      if ('num' in b && !('num' in a)) return mk('*', b, a);
      return mk('*', a, b);
    case '/': if (JSON.stringify(a) === JSON.stringify(b) && !('num' in a && a.num === 0)) return N(1); if (isNum(a, 0)) return N(0); if (isNum(b, 1)) return a; if ('num' in a && 'num' in b && b.num !== 0 && Number.isInteger(a.num / b.num)) return N(a.num / b.num); return mk('/', a, b);
    case '^': if (isNum(b, 0)) return N(1); if (isNum(b, 1)) return a; if (isNum(a, 1)) return N(1); if ('num' in a && 'num' in b && Number.isInteger(a.num ** b.num) && Math.abs(a.num ** b.num) < 1e15) return N(a.num ** b.num); return mk('^', a, b);
    default: return mk(n.op, a, b);
  }
}
const hasVar = (n, v) => ('id' in n ? n.id === v : 'num' in n ? false : 'fn' in n ? n.args.some(a => hasVar(a, v)) : hasVar(n.a, v) || (n.b ? hasVar(n.b, v) : false));
function diff(n, v) {
  if ('num' in n) return N(0);
  if ('id' in n) return N(n.id === v ? 1 : 0);
  if ('fn' in n) {
    const u = n.args[0], du = diff(u, v);
    const chain = d => mk('*', d, du);
    switch (n.fn) {
      case 'sin': return chain({ fn: 'cos', args: [u] });
      case 'cos': return chain({ op: 'neg', a: { fn: 'sin', args: [u] } });
      case 'tan': return chain(mk('/', N(1), mk('^', { fn: 'cos', args: [u] }, N(2))));
      case 'exp': return chain(n);
      case 'ln': case 'log': return mk('/', du, u);
      case 'sqrt': return mk('/', du, mk('*', N(2), n));
      case 'abs': return chain({ fn: 'sign', args: [u] });
      case 'atan': return mk('/', du, mk('+', N(1), mk('^', u, N(2))));
      case 'asin': return mk('/', du, { fn: 'sqrt', args: [mk('-', N(1), mk('^', u, N(2)))] });
      case 'acos': return { op: 'neg', a: mk('/', du, { fn: 'sqrt', args: [mk('-', N(1), mk('^', u, N(2)))] }) };
      case 'sinh': return chain({ fn: 'cosh', args: [u] });
      case 'cosh': return chain({ fn: 'sinh', args: [u] });
      case 'log10': return mk('/', du, mk('*', u, N(Math.LN10)));
      case 'log2': return mk('/', du, mk('*', u, N(Math.LN2)));
      default: throw new Error(`기호 미분이 지원하지 않는 함수: ${n.fn}`);
    }
  }
  switch (n.op) {
    case 'neg': return { op: 'neg', a: diff(n.a, v) };
    case '+': return mk('+', diff(n.a, v), diff(n.b, v));
    case '-': return mk('-', diff(n.a, v), diff(n.b, v));
    case '*': return mk('+', mk('*', diff(n.a, v), n.b), mk('*', n.a, diff(n.b, v)));
    case '/': return mk('/', mk('-', mk('*', diff(n.a, v), n.b), mk('*', n.a, diff(n.b, v))), mk('^', n.b, N(2)));
    case '^':
      if (!hasVar(n.b, v)) return mk('*', mk('*', n.b, mk('^', n.a, mk('-', n.b, N(1)))), diff(n.a, v));
      if (!hasVar(n.a, v)) return mk('*', mk('*', n, { fn: 'ln', args: [n.a] }), diff(n.b, v));
      return mk('*', n, mk('+', mk('*', diff(n.b, v), { fn: 'ln', args: [n.a] }), mk('/', mk('*', n.b, diff(n.a, v)), n.a)));
    default: throw new Error('지원하지 않는 연산자 ' + n.op);
  }
}
const PREC = { '+': 1, '-': 1, '*': 2, '/': 2, '^': 3, neg: 2.5 };
function show(n, parent = 0, right = false) {
  if ('num' in n) { const t = Number.isInteger(n.num) ? String(n.num) : String(Number(n.num.toPrecision(10))); return n.num < 0 && parent > 0 ? `(${t})` : t; }
  if ('id' in n) return n.id;
  if ('fn' in n) return `${n.fn}(${n.args.map(a => show(a)).join(', ')})`;
  if (n.op === 'neg') { const t = '-' + show(n.a, PREC.neg); return parent > PREC.neg ? `(${t})` : t; }
  const p = PREC[n.op];
  const t = `${show(n.a, p)}${n.op === '^' || n.op === '*' || n.op === '/' ? n.op : ` ${n.op} `}${show(n.b, p, true)}`.replace(/\*/g, '*');
  return p < parent || (right && p === parent && n.op !== '^' && (n.op === '-' || n.op === '/')) ? `(${t})` : t;
}
IMPL.symbolic_diff = ({ expr, var: v = 'x', order = 1, at }) => {
  const ord = Math.min(4, Math.max(1, Math.floor(Number(order) || 1)));
  let ast = parseExpr(expr);
  const orig = ast;
  for (let i = 0; i < ord; i++) { ast = simp(simp(diff(ast, v))); }
  ast = simp(ast);
  const text = show(ast);
  const out = { derivative: text, order: ord, variable: v };
  const pt = at !== undefined ? Number(at) : 1.3;
  if (Number.isFinite(pt)) {
    try {
      const sym = compile(text, v)(pt);
      const f = compile(show(orig), v);
      const h = 1e-4 * Math.max(1, Math.abs(pt));
      const numeric = ord === 1 ? (f(pt + h) - f(pt - h)) / (2 * h) : null;
      out.checkAt = pt; out.symbolicValue = clean(sym);
      if (numeric !== null) { out.numericValue = clean(numeric); out.verified = Math.abs(sym - numeric) <= 1e-5 * Math.max(1, Math.abs(sym)); }
    } catch { /* 검증 불가 */ }
  }
  return out;
};

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------
const erf = x => { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; };
const normCdf = z => {   // 고정밀: Abramowitz-Stegun 7.1.26 보다 정확한 연분수 대신 W. J. Cody 근사 대용으로 급수
  if (z < -8) return 0; if (z > 8) return 1;
  let sum = z, term = z; for (let i = 1; i < 200; i++) { term *= z * z / (2 * i + 1); sum += term; if (Math.abs(term) < 1e-17) break; }
  return 0.5 + sum * Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
};
const logFact = n => { let s = 0; for (let i = 2; i <= n; i++) s += Math.log(i); return s; };
IMPL.stats = ({ op, data, data2, p, n, k, mu, sigma, x, lambda, ddof = 1 }) => {
  const need = () => nums(data, 'data');
  switch (op) {
    case 'describe': {
      const d = need().slice().sort((a, b) => a - b), m = d.reduce((a, b) => a + b, 0) / d.length;
      const dd = Math.min(1, Math.max(0, Number(ddof)));
      const v = d.length - dd > 0 ? d.reduce((a, b) => a + (b - m) ** 2, 0) / (d.length - dd) : NaN;
      const q = f => { const pos = (d.length - 1) * f, lo = Math.floor(pos); return d[lo] + (d[Math.min(lo + 1, d.length - 1)] - d[lo]) * (pos - lo); };
      return { count: d.length, mean: clean(m), median: clean(q(0.5)), variance: clean(v), std: clean(Math.sqrt(v)), min: d[0], q1: clean(q(0.25)), q3: clean(q(0.75)), max: d[d.length - 1], sum: clean(d.reduce((a, b) => a + b, 0)), ddof: dd };
    }
    case 'mode': { const c = new Map(); for (const v of need()) c.set(v, (c.get(v) || 0) + 1); const mx = Math.max(...c.values()); return { modes: [...c].filter(([, t]) => t === mx).map(([v]) => v), count: mx }; }
    case 'correlation': case 'linreg': {
      const a = need(), b = nums(data2, 'data2'); if (a.length !== b.length) throw new Error('data 와 data2 길이가 다릅니다');
      const ma = a.reduce((s, v) => s + v, 0) / a.length, mb = b.reduce((s, v) => s + v, 0) / b.length;
      let sab = 0, saa = 0, sbb = 0; a.forEach((v, i) => { sab += (v - ma) * (b[i] - mb); saa += (v - ma) ** 2; sbb += (b[i] - mb) ** 2; });
      const r = sab / Math.sqrt(saa * sbb);
      if (op === 'correlation') return { r: clean(r), r_squared: clean(r * r) };
      const slope = sab / saa; return { slope: clean(slope), intercept: clean(mb - slope * ma), r: clean(r), r_squared: clean(r * r), equation: `y = ${clean(slope)}*x + ${clean(mb - slope * ma)}` };
    }
    case 'normal_cdf': { const s = Number(sigma ?? 1), m = Number(mu ?? 0); if (!(s > 0)) throw new Error('sigma > 0'); return { cdf: clean(normCdf((Number(x) - m) / s)), z: clean((Number(x) - m) / s) }; }
    case 'binom_pmf': { const nn = Number(n), kk = Number(k), pp = Number(p); if (!(nn >= 0 && nn <= 100000 && kk >= 0 && kk <= nn && pp >= 0 && pp <= 1)) throw new Error('n,k,p 범위 오류'); const lp = logFact(nn) - logFact(kk) - logFact(nn - kk) + (kk ? kk * Math.log(pp) : 0) + (nn - kk ? (nn - kk) * Math.log(1 - pp) : 0); return { pmf: clean(Math.exp(lp)) }; }
    case 'binom_cdf': { const nn = Number(n), kk = Number(k), pp = Number(p); let s = 0; for (let i = 0; i <= kk; i++) s += Math.exp(logFact(nn) - logFact(i) - logFact(nn - i) + (i ? i * Math.log(pp) : 0) + (nn - i ? (nn - i) * Math.log(1 - pp) : 0)); return { cdf: clean(Math.min(1, s)) }; }
    case 'poisson_pmf': { const l = Number(lambda), kk = Number(k); return { pmf: clean(Math.exp(-l + kk * Math.log(l) - logFact(kk))) }; }
    default: throw new Error('op: describe, mode, correlation, linreg, normal_cdf, binom_pmf, binom_cdf, poisson_pmf');
  }
};

// ---------------------------------------------------------------------------
// matrix_ops
// ---------------------------------------------------------------------------
function matOf(m, name) {
  if (!Array.isArray(m) || !m.length || m.length > 10) throw new Error(`${name} 는 1~10행 행렬`);
  const w = Array.isArray(m[0]) ? m[0].length : 0; if (!w || w > 10) throw new Error(`${name} 열 수 오류`);
  return m.map((r, i) => { if (!Array.isArray(r) || r.length !== w) throw new Error(`${name} 의 ${i + 1}행 길이가 다릅니다`); return r.map((x, j) => { const v = Number(x); if (!Number.isFinite(v)) throw new Error(`${name}[${i}][${j}] 숫자 아님`); return v; }); });
}
function rref(M) {
  const A = M.map(r => r.slice()); let rank = 0, det = 1; const R = A.length, C = A[0].length;
  for (let c = 0; c < C && rank < R; c++) {
    let p = rank; for (let r = rank + 1; r < R; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-10) continue;
    if (p !== rank) { [A[p], A[rank]] = [A[rank], A[p]]; det = -det; }
    const pv = A[rank][c]; det *= pv; A[rank] = A[rank].map(v => v / pv);
    for (let r = 0; r < R; r++) if (r !== rank) { const f = A[r][c]; if (f) A[r] = A[r].map((v, j) => v - f * A[rank][j]); }
    rank++;
  }
  return { A, rank, det: rank === Math.min(R, C) && R === C ? det : 0 };
}
function polyRoots(c) {   // c: 최고차→상수 계수, Durand–Kerner
  while (c.length && Math.abs(c[0]) < 1e-14) c = c.slice(1);
  const n = c.length - 1; if (n < 1) return [];
  const a = c.map(v => v / c[0]);
  let z = Array.from({ length: n }, (_, k) => ({ re: Math.cos(2 * Math.PI * k / n + 0.4) * (1 + Math.max(...a.slice(1).map(Math.abs))) * 0.5, im: Math.sin(2 * Math.PI * k / n + 0.4) * (1 + Math.max(...a.slice(1).map(Math.abs))) * 0.5 }));
  const mul = (x, y) => ({ re: x.re * y.re - x.im * y.im, im: x.re * y.im + x.im * y.re });
  const sub = (x, y) => ({ re: x.re - y.re, im: x.im - y.im });
  const div = (x, y) => { const d = y.re * y.re + y.im * y.im; return { re: (x.re * y.re + x.im * y.im) / d, im: (x.im * y.re - x.re * y.im) / d }; };
  for (let it = 0; it < 500; it++) {
    let delta = 0;
    z = z.map((zi, i) => {
      let pv = { re: 1, im: 0 }; for (let k = 1; k <= n; k++) pv = { re: pv.re * zi.re - pv.im * zi.im + a[k], im: pv.re * zi.im + pv.im * zi.re };
      let den = { re: 1, im: 0 }; z.forEach((zj, j) => { if (j !== i) den = mul(den, sub(zi, zj)); });
      const step = div(pv, den); delta = Math.max(delta, Math.hypot(step.re, step.im)); return sub(zi, step);
    });
    if (delta < 1e-13) break;
  }
  return z;
}
const fmtC = z => (Math.abs(z.im) < 1e-8 ? clean(z.re) : `${clean(z.re)} ${z.im < 0 ? '-' : '+'} ${clean(Math.abs(z.im))}i`);
IMPL.matrix_ops = ({ op, matrix, matrix2 }) => {
  const A = matOf(matrix, 'matrix'), R = A.length, C = A[0].length;
  switch (op) {
    case 'det': if (R !== C) throw new Error('정사각행렬 필요'); return { determinant: clean(rref(A).det) };
    case 'rank': return { rank: rref(A).rank };
    case 'rref': return { rref: rref(A).A.map(r => r.map(clean)) };
    case 'transpose': return { result: A[0].map((_, j) => A.map(r => clean(r[j]))) };
    case 'trace': if (R !== C) throw new Error('정사각행렬 필요'); return { trace: clean(A.reduce((s, r, i) => s + r[i], 0)) };
    case 'multiply': { const B = matOf(matrix2, 'matrix2'); if (C !== B.length) throw new Error('열 수와 행 수가 맞지 않습니다'); return { result: A.map(r => B[0].map((_, j) => clean(r.reduce((s, v, k) => s + v * B[k][j], 0)))) }; }
    case 'inverse': {
      if (R !== C) throw new Error('정사각행렬 필요');
      const aug = A.map((r, i) => [...r, ...A.map((_, j) => (i === j ? 1 : 0))]); const { A: red, rank } = rref(aug);
      if (rank < R || red.slice(0, R).some((r, i) => Math.abs(r[i] - 1) > 1e-8)) return { invertible: false, note: '특이 행렬(행렬식 0)' };
      return { invertible: true, inverse: red.map(r => r.slice(R).map(clean)) };
    }
    case 'eigen': {
      if (R !== C || R > 8) throw new Error('8x8 이하 정사각행렬 필요');
      // Faddeev–LeVerrier 로 특성다항식 계수를 구한 뒤 근을 찾는다
      const n = R; let M = A.map(r => r.map(() => 0)); const coef = [1]; let I = A.map((r, i) => r.map((_, j) => (i === j ? 1 : 0)));
      let Mk = I.map(r => r.slice());
      for (let k = 1; k <= n; k++) {
        const AM = A.map(r => Mk[0].map((_, j) => r.reduce((s, v, t) => s + v * Mk[t][j], 0)));
        const ck = -AM.reduce((s, r, i) => s + r[i], 0) / k; coef.push(ck);
        Mk = AM.map((r, i) => r.map((v, j) => v + (i === j ? ck : 0)));
      }
      void M;
      const ev = polyRoots(coef).sort((a, b) => b.re - a.re || b.im - a.im);
      return { characteristic: coef.map(clean), eigenvalues: ev.map(fmtC) };
    }
    default: throw new Error('op: det, rank, rref, transpose, trace, multiply, inverse, eigen');
  }
};

// ---------------------------------------------------------------------------
// limit_numeric / extrema / sequence_next
// ---------------------------------------------------------------------------
const numOrInf = v => { if (typeof v === 'string' && /^[+-]?\s*(inf|infinity|∞)$/i.test(v.trim())) return /^-/.test(v.trim()) ? -Infinity : Infinity; return core.compile(String(v))(0); };
IMPL.limit_numeric = ({ expr, var: v = 'x', at, side = 'both' }) => {
  const f = compile(expr, v); const g = x => { try { return f(x); } catch { return NaN; } };
  const a = typeof at === 'number' ? at : numOrInf(at);
  const seq = dir => { const vals = []; for (let k = 2; k <= 12; k++) { const h = 10 ** -k; vals.push(g(Number.isFinite(a) ? a + dir * h : dir * 10 ** k)); } return vals; };
  const judge = vals => { const tail = vals.slice(-4); const fin = tail.filter(Number.isFinite); if (fin.length < 3) return { value: NaN }; const last = fin[fin.length - 1]; if (Math.abs(last) > 1e7 && fin.every(x => Math.sign(x) === Math.sign(last))) return { value: last > 0 ? Infinity : -Infinity }; const spread = Math.max(...fin) - Math.min(...fin); return { value: last, converged: spread < 1e-5 * Math.max(1, Math.abs(last)) }; };
  const res = {};
  if (!Number.isFinite(a)) { const j = judge(seq(a > 0 ? 1 : -1)); return { limit: clean(j.value), converged: j.converged ?? true, at: String(a) }; }
  if (side !== 'right') res.left = judge(seq(-1));
  if (side !== 'left') res.right = judge(seq(1));
  const L = res.left, Rr = res.right;
  let limit = (L || Rr).value, exists = true;
  if (L && Rr) { const same = (L.value === Rr.value) || (Number.isFinite(L.value) && Number.isFinite(Rr.value) && Math.abs(L.value - Rr.value) < 1e-5 * Math.max(1, Math.abs(L.value))); exists = same; limit = same ? Rr.value : NaN; }
  return { limit: exists ? clean(Number.isFinite(limit) ? Number(limit.toPrecision(8)) : limit) : '양쪽 극한이 다름', left: L ? clean(L.value) : undefined, right: Rr ? clean(Rr.value) : undefined, exists, note: '수치 추정입니다. 정확한 값은 대수적으로 확인하세요 (예: 로피탈, 인수분해)' };
};
IMPL.extrema = ({ expr, var: v = 'x', lo, hi }) => {
  const f = compile(expr, v); const a = core.compile(String(lo))(0), b = core.compile(String(hi))(0);
  if (!(a < b)) throw new Error('lo < hi'); const g = x => { try { const y = f(x); return Number.isFinite(y) ? y : NaN; } catch { return NaN; } };
  const M = 4000; const pts = []; for (let i = 0; i <= M; i++) { const x = a + (b - a) * i / M; pts.push([x, g(x)]); }
  const refine = (i, sign) => { let l = pts[Math.max(0, i - 1)][0], r = pts[Math.min(M, i + 1)][0]; const gr = (Math.sqrt(5) - 1) / 2; for (let k = 0; k < 80; k++) { const x1 = r - gr * (r - l), x2 = l + gr * (r - l); if (sign * g(x1) < sign * g(x2)) r = x2; else l = x1; } const x = (l + r) / 2; return { x: clean(x), y: clean(g(x)) }; };
  const valid = pts.map((p, i) => [p[1], i]).filter(([y]) => Number.isFinite(y)); if (!valid.length) throw new Error('구간에서 유효한 값이 없습니다');
  const mn = valid.reduce((p, c) => (c[0] < p[0] ? c : p)), mx = valid.reduce((p, c) => (c[0] > p[0] ? c : p));
  const local = [];
  for (let i = 1; i < M; i++) { const y0 = pts[i - 1][1], y1 = pts[i][1], y2 = pts[i + 1][1]; if ([y0, y1, y2].every(Number.isFinite)) { if (y1 < y0 && y1 <= y2) local.push({ kind: 'min', ...refine(i, -1) }); else if (y1 > y0 && y1 >= y2) local.push({ kind: 'max', ...refine(i, 1) }); } }
  return { minimum: mn[1] === 0 || mn[1] === M ? { x: clean(pts[mn[1]][0]), y: clean(mn[0]), atBoundary: true } : refine(mn[1], -1), maximum: mx[1] === 0 || mx[1] === M ? { x: clean(pts[mx[1]][0]), y: clean(mx[0]), atBoundary: true } : refine(mx[1], 1), localExtrema: local.slice(0, 12) };
};
IMPL.sequence_next = ({ terms, count = 3 }) => {
  const t = nums(terms, 'terms', 40); if (t.length < 3) throw new Error('항이 3개 이상 필요합니다'); const K = Math.min(10, Math.max(1, Math.floor(Number(count) || 3)));
  const eq = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  const d1 = t.slice(1).map((x, i) => x - t[i]);
  if (d1.every(x => eq(x, d1[0]))) return { rule: '등차수열', formula: `a(n) = ${clean(t[0])} + ${clean(d1[0])}*(n-1)`, next: Array.from({ length: K }, (_, i) => clean(t[t.length - 1] + d1[0] * (i + 1))) };
  if (t.every(x => x !== 0)) { const r = t.slice(1).map((x, i) => x / t[i]); if (r.every(x => eq(x, r[0]))) return { rule: '등비수열', formula: `a(n) = ${clean(t[0])} * ${clean(r[0])}^(n-1)`, next: Array.from({ length: K }, (_, i) => clean(t[t.length - 1] * r[0] ** (i + 1))) }; }
  let diffs = t.slice(), levels = [];
  for (let d = 1; d <= 5 && diffs.length > 2; d++) { diffs = diffs.slice(1).map((x, i) => x - diffs[i]); levels.push(diffs); if (diffs.every(x => eq(x, diffs[0])) && diffs.length >= 2) { const tail = levels.map(l => l[l.length - 1]); tail.unshift(t[t.length - 1]); const next = []; const st = [...levels.map(l => l[l.length - 1])]; let cur = t[t.length - 1]; const cons = st.slice(); for (let i = 0; i < K; i++) { for (let k = cons.length - 2; k >= 0; k--) cons[k] += cons[k + 1]; cur += cons[0]; next.push(clean(cur)); } return { rule: `${d}차 다항식 수열 (${d}차 차분이 일정)`, next }; } }
  if (t.length >= 5) { // a(n) = p*a(n-1) + q*a(n-2)
    const [a, b, c, d] = [t[1], t[0], t[2], t[1]]; const det = a * d - b * c;
    if (Math.abs(det) > 1e-12) { const p = (t[2] * d - b * t[3]) / det, q = (a * t[3] - t[2] * c) / det; if (t.slice(2).every((x, i) => eq(x, p * t[i + 1] + q * t[i]))) { const out = t.slice(); for (let i = 0; i < K; i++) out.push(p * out[out.length - 1] + q * out[out.length - 2]); return { rule: '2항 선형 점화식', formula: `a(n) = ${clean(p)}*a(n-1) + ${clean(q)}*a(n-2)`, next: out.slice(t.length).map(clean) }; } }
  }
  return { rule: null, note: '단순 규칙(등차·등비·다항·2항 점화식)으로 설명되지 않습니다. 항을 더 주거나 규칙을 직접 가정해 check_identity 로 검증하세요.' };
};

const DECL = [
  { name: 'exact_eval', description: '부동소수 오차 없이 BigInt 분수로 정확히 계산한다. 정수·분수·소수·+-*/^(정수 지수)·!·comb·perm·gcd·lcm·sqrt(완전제곱)·mod 지원. 증명·정수 문제에서 큰 수/분수 검산용.',
    parameters: OBJ({ expr: S('STRING', '예: (2^100+1)/3, 1/3+1/6, comb(50,25)') }, ['expr']) },
  { name: 'symbolic_diff', description: '기호 미분 (합성함수·곱·몫·거듭제곱·지수·삼각·로그, 최대 4차). 간단화된 도함수 식을 문자열로 주고 수치로 검증한다.',
    parameters: OBJ({ expr: S('STRING', 'f(x)'), var: S('STRING', '변수, 기본 x'), order: S('INTEGER', '차수 1~4'), at: S('NUMBER', '검증할 점 (선택)') }, ['expr']) },
  { name: 'stats', description: '통계: describe(평균·중앙값·분산·사분위), mode, correlation, linreg(data,data2), normal_cdf(x,mu,sigma), binom_pmf/cdf(n,k,p), poisson_pmf(lambda,k).',
    parameters: OBJ({ op: S('STRING', '연산', { enum: ['describe', 'mode', 'correlation', 'linreg', 'normal_cdf', 'binom_pmf', 'binom_cdf', 'poisson_pmf'] }), data: NUM_ARR('데이터'), data2: NUM_ARR('두 번째 데이터'), ddof: S('INTEGER', '0=모분산, 1=표본분산(기본)'), x: S('NUMBER', 'x'), mu: S('NUMBER', '평균'), sigma: S('NUMBER', '표준편차'), n: S('INTEGER', '시행 수'), k: S('INTEGER', '성공 횟수'), p: S('NUMBER', '확률'), lambda: S('NUMBER', '푸아송 평균') }, ['op']) },
  { name: 'matrix_ops', description: '행렬 연산(10x10 이하): det, rank, rref, transpose, trace, multiply(matrix2), inverse, eigen(복소 고유값 포함).',
    parameters: OBJ({ op: S('STRING', '연산', { enum: ['det', 'rank', 'rref', 'transpose', 'trace', 'multiply', 'inverse', 'eigen'] }), matrix: { type: 'ARRAY', items: { type: 'ARRAY', items: { type: 'NUMBER' } }, description: '행렬' }, matrix2: { type: 'ARRAY', items: { type: 'ARRAY', items: { type: 'NUMBER' } }, description: '두 번째 행렬 (multiply)' } }, ['op', 'matrix']) },
  { name: 'limit_numeric', description: '극한을 좌·우에서 수치로 추정한다 (무한대 inf 가능). 좌우 극한이 다르면 exists=false.',
    parameters: OBJ({ expr: S('STRING', 'f(x)'), var: S('STRING', '변수'), at: S('STRING', '접근 값: 숫자 또는 inf/-inf'), side: S('STRING', 'both|left|right', { enum: ['both', 'left', 'right'] }) }, ['expr', 'at']) },
  { name: 'extrema', description: '구간 [lo,hi] 에서 함수의 최대·최소와 극점을 찾는다 (경계 포함).',
    parameters: OBJ({ expr: S('STRING', 'f(x)'), var: S('STRING', '변수'), lo: S('STRING', '구간 시작 (상수식 가능)'), hi: S('STRING', '구간 끝') }, ['expr', 'lo', 'hi']) },
  { name: 'sequence_next', description: '수열의 규칙(등차·등비·다항·2항 점화식)을 추정하고 다음 항을 계산한다.',
    parameters: OBJ({ terms: NUM_ARR('주어진 항들 (3개 이상)'), count: S('INTEGER', '다음 항 개수') }, ['terms']) }
];

module.exports = { DECL, IMPL, exactParse };
