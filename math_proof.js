'use strict';
// 수학 증명·정수론 보조 도구 (IMO 1988 문제 6 같은 비에타 점프/무한강하/디오판토스 유형)
//  poly_expand      : 다변수 다항식을 정확한 유리수 계수로 전개·정리. 대입(subs)·한 변수에 대한 계수·비에타 합/곱 제공
//  vieta_jump       : x^2 + y^2 - k·x·y = c 꼴의 해를 비에타 점프로 끝까지 내려가며 단계별 검산 + 증명 뼈대 제공
//  diophantine_scan : 정수 범위에서 lhs = rhs 인 해를 모두 찾고, 값 식(value_expr)이 완전제곱인지까지 확인
//  residue_table    : 식이 mod m 에서 가질 수 있는 나머지 집합 (불가능성·이차잉여 증명용)
// 모두 서버 안의 순수 계산이며 eval 을 쓰지 않는다.
const core = require('./reasoning_tools');
const { parseExpr, compile, normalizeMathInput } = core;

const S = (type, description, extra = {}) => ({ type, description, ...extra });
const OBJ = (properties, required) => ({ type: 'OBJECT', properties, required });
const IMPL = {};

// ---------------------------------------------------------------------------
// 유리수 (BigInt)
// ---------------------------------------------------------------------------
const gcdB = (a, b) => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a; };
const Q = (n, d = 1n) => {
  if (d === 0n) throw new Error('0 으로 나눌 수 없습니다');
  if (d < 0n) { n = -n; d = -d; }
  const g = gcdB(n, d) || 1n;
  return { n: n / g, d: d / g };
};
const qAdd = (a, b) => Q(a.n * b.d + b.n * a.d, a.d * b.d);
const qMul = (a, b) => Q(a.n * b.n, a.d * b.d);
const qNeg = a => ({ n: -a.n, d: a.d });
const qIsZero = a => a.n === 0n;
const qFromNumber = x => {
  if (Number.isInteger(x)) return Q(BigInt(x));
  const s = String(x);
  if (/e/i.test(s)) throw new Error(`지원하지 않는 수 표기: ${s}`);
  const [i, f = ''] = s.split('.');
  return Q(BigInt(i + f), 10n ** BigInt(f.length));
};
const qStr = (q, withSign = false) => {
  const body = q.d === 1n ? (q.n < 0n ? -q.n : q.n).toString() : `${(q.n < 0n ? -q.n : q.n)}/${q.d}`;
  return withSign ? (q.n < 0n ? '-' : '+') + body : (q.n < 0n ? '-' : '') + body;
};

// ---------------------------------------------------------------------------
// 다변수 다항식: Map<단항식 키, 유리수 계수>. 단항식 키 = "a:2,b:1" (변수 알파벳순, 지수>0), 상수항은 ""
// ---------------------------------------------------------------------------
const MAX_TERMS = 4000;
const monoParse = k => { const o = {}; if (k) for (const p of k.split(',')) { const [v, e] = p.split(':'); o[v] = Number(e); } return o; };
const monoKey = o => Object.keys(o).filter(v => o[v] > 0).sort().map(v => `${v}:${o[v]}`).join(',');
const polyConst = q => { const m = new Map(); if (!qIsZero(q)) m.set('', q); return m; };
const polyVar = v => new Map([[`${v}:1`, Q(1n)]]);
const polyAdd = (p, q) => {
  const r = new Map(p);
  for (const [k, c] of q) {
    const s = r.has(k) ? qAdd(r.get(k), c) : c;
    if (qIsZero(s)) r.delete(k); else r.set(k, s);
  }
  return r;
};
const polyNeg = p => new Map([...p].map(([k, c]) => [k, qNeg(c)]));
const polyMul = (p, q) => {
  const r = new Map();
  for (const [k1, c1] of p) for (const [k2, c2] of q) {
    const a = monoParse(k1), b = monoParse(k2);
    for (const v of Object.keys(b)) a[v] = (a[v] || 0) + b[v];
    const k = monoKey(a), c = qMul(c1, c2);
    const s = r.has(k) ? qAdd(r.get(k), c) : c;
    if (qIsZero(s)) r.delete(k); else r.set(k, s);
    if (r.size > MAX_TERMS) throw new Error('항이 너무 많습니다 (전개 한도 초과)');
  }
  return r;
};
const polyPow = (p, e) => {
  if (!Number.isInteger(e) || e < 0 || e > 24) throw new Error('거듭제곱 지수는 0~24 의 정수여야 합니다');
  let r = polyConst(Q(1n)), base = p, n = e;
  while (n > 0) { if (n & 1) r = polyMul(r, base); n >>= 1; if (n) base = polyMul(base, base); }
  return r;
};
const polyIsConst = p => p.size === 0 || (p.size === 1 && p.has(''));
const polyConstVal = p => (p.has('') ? p.get('') : Q(0n));

function polyFromAst(n, env) {
  if ('num' in n) return polyConst(qFromNumber(n.num));
  if ('id' in n) {
    if (env && n.id in env) return env[n.id];
    if (n.id === 'pi' || n.id === 'e') throw new Error(`상수 ${n.id} 는 다항식 전개에서 지원하지 않습니다`);
    return polyVar(n.id);
  }
  if ('fn' in n) throw new Error(`함수 ${n.fn} 는 다항식 전개에서 지원하지 않습니다 (poly_expand 는 + - * / ^ 만 지원)`);
  if (n.op === 'neg') return polyNeg(polyFromAst(n.a, env));
  const a = polyFromAst(n.a, env), b = polyFromAst(n.b, env);
  switch (n.op) {
    case '+': return polyAdd(a, b);
    case '-': return polyAdd(a, polyNeg(b));
    case '*': return polyMul(a, b);
    case '/': {
      if (!polyIsConst(b) || qIsZero(polyConstVal(b))) throw new Error('다항식을 변수가 든 식으로 나눌 수는 없습니다 (상수로만 나눌 수 있음)');
      const c = polyConstVal(b);
      return polyMul(a, polyConst(Q(c.d, c.n)));
    }
    case '^': {
      if (!polyIsConst(b)) throw new Error('지수는 정수 상수여야 합니다');
      const e = polyConstVal(b);
      if (e.d !== 1n) throw new Error('지수는 정수여야 합니다');
      return polyPow(a, Number(e.n));
    }
  }
  throw new Error('지원하지 않는 연산자');
}

// "lhs = rhs" 이면 lhs - rhs 로 만든다
function polyFromText(text, env) {
  const src = normalizeMathInput(String(text));
  const m = /^([^=<>!]*[^=<>!])=([^=][^=<>]*)$/.exec(src);
  const ast = m && !/[<>!]=|==/.test(src) ? { op: '-', a: parseExpr(m[1]), b: parseExpr(m[2]) } : parseExpr(src);
  return polyFromAst(ast, env);
}

const sortTerms = p => [...p].sort(([k1], [k2]) => {
  const a = monoParse(k1), b = monoParse(k2);
  const da = Object.values(a).reduce((x, y) => x + y, 0), db = Object.values(b).reduce((x, y) => x + y, 0);
  if (da !== db) return db - da;
  return k1 < k2 ? -1 : k1 > k2 ? 1 : 0;
});
function monoText(k, tex) {
  const o = monoParse(k);
  return Object.keys(o).sort().map(v => (o[v] === 1 ? v : tex ? `${v}^{${o[v]}}` : `${v}^${o[v]}`)).join(tex ? ' ' : '*');
}
function polyText(p, tex = false) {
  if (!p.size) return '0';
  let out = '';
  sortTerms(p).forEach(([k, c], i) => {
    const neg = c.n < 0n;
    const abs = { n: neg ? -c.n : c.n, d: c.d };
    const mono = monoText(k, tex);
    let coef;
    if (!mono) coef = tex && abs.d !== 1n ? `\\frac{${abs.n}}{${abs.d}}` : qStr(abs);
    else if (abs.n === 1n && abs.d === 1n) coef = '';
    else coef = tex && abs.d !== 1n ? `\\frac{${abs.n}}{${abs.d}}` : qStr(abs) + (tex ? '' : '*');
    const term = (coef + mono) || '1';
    out += i === 0 ? (neg ? '-' : '') + term : (neg ? ' - ' : ' + ') + term;
  });
  return out;
}
const polyDegIn = (p, v) => { let d = 0; for (const k of p.keys()) d = Math.max(d, monoParse(k)[v] || 0); return d; };
// v 에 대한 계수 다항식들 (인덱스 = 차수)
function coeffsIn(p, v) {
  const out = [];
  for (const [k, c] of p) {
    const o = monoParse(k), e = o[v] || 0;
    delete o[v];
    const kk = monoKey(o);
    (out[e] = out[e] || new Map()).set(kk, c);
  }
  for (let i = 0; i < out.length; i++) if (!out[i]) out[i] = new Map();
  return out;
}

function parseSubs(subs) {
  const env = {};
  if (subs === undefined || subs === null || String(subs).trim() === '') return env;
  const parts = String(subs).split(/[;,](?![^()]*\))/).map(s => s.trim()).filter(Boolean);
  for (const part of parts) {
    const m = /^([A-Za-z_]\w*)\s*(?:=|:|->|→)\s*(.+)$/.exec(part);
    if (!m) throw new Error(`subs 형식 오류: "${part}" (예: a=-c; b=2k+1)`);
    env[m[1]] = polyFromText(m[2], null);
  }
  return env;
}

IMPL.poly_expand = ({ expr, var: v, subs }) => {
  if (typeof expr !== 'string' || !expr.trim() || expr.length > 600) throw new Error('expr 는 600자 이하의 식이어야 합니다');
  const env = parseSubs(subs);
  const p = polyFromText(expr, env);
  const out = {
    expanded: polyText(p), latex: polyText(p, true), is_zero: p.size === 0,
    terms: p.size, ...(subs ? { same_as_original: polyText(polyFromText(expr, {})) === polyText(p) } : {}), note: '"lhs = rhs" 를 넣으면 lhs - rhs 를 전개합니다. 대입 후 0 이면 항등식/근 검증이 끝난 것입니다.'
  };
  if (v) {
    const name = String(v).trim();
    const deg = polyDegIn(p, name);
    const cs = coeffsIn(p, name);
    out.by_var = { var: name, degree: deg, coefficients: cs.map((c, e) => ({ power: e, coefficient: polyText(c) })).reverse().filter(x => x.coefficient !== '0') };
    if (deg === 2) {
      const [c0, c1, c2] = cs;
      if (polyIsConst(c2) && !qIsZero(polyConstVal(c2))) {
        const A = polyConstVal(c2), invA = polyConst(Q(A.d, A.n));
        const sum = polyMul(polyNeg(c1), invA), prod = polyMul(c0, invA);
        out.vieta = { form: `${name}^2 의 계수 ${qStr(A)} (상수) → 두 근 r1, r2 에 대해`, sum_of_roots: polyText(sum), product_of_roots: polyText(prod), sum_latex: polyText(sum, true), product_latex: polyText(prod, true) };
      } else {
        out.vieta = { sum_of_roots: `-(${polyText(c1)})/(${polyText(c2)})`, product_of_roots: `(${polyText(c0)})/(${polyText(c2)})`, note: '최고차 계수가 상수가 아님' };
      }
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// vieta_jump: x^2 + y^2 - k x y = c
// ---------------------------------------------------------------------------
const bigArg = (x, name) => {
  const s = String(x ?? '').trim();
  if (!/^-?\d{1,60}$/.test(s)) throw new Error(`${name} 는 정수여야 합니다 (최대 60자리)`);
  return BigInt(s);
};
const isSqB = x => {
  if (x < 0n) return null;
  if (x < 2n) return x;
  let lo = 0n, hi = x;
  while (lo <= hi) { const mid = (lo + hi) >> 1n, sq = mid * mid; if (sq === x) return mid; if (sq < x) lo = mid + 1n; else hi = mid - 1n; }
  return null;
};

IMPL.vieta_jump = ({ a, b, k, c }) => {
  let A = bigArg(a, 'a'), B = bigArg(b, 'b');
  let K, C;
  if (k !== undefined && k !== null && String(k).trim() !== '') {
    K = bigArg(k, 'k'); C = (c !== undefined && c !== null && String(c).trim() !== '') ? bigArg(c, 'c') : K;
  } else {
    if (c !== undefined && c !== null && String(c).trim() !== '') throw new Error('c 를 주려면 k 도 함께 주세요');
    const den = A * B + 1n, num = A * A + B * B;
    if (den === 0n || num % den !== 0n) throw new Error(`ab+1 이 a^2+b^2 을 나누지 않습니다 (a^2+b^2 = ${num}, ab+1 = ${den}). k 와 c 를 직접 주세요.`);
    K = num / den; C = K;
  }
  const eq = (x, y) => x * x + y * y - K * x * y === C;
  if (!eq(A, B)) throw new Error(`(a,b)=(${A},${B}) 는 x^2 + y^2 - ${K}xy = ${C} 를 만족하지 않습니다`);
  let x = A >= B ? A : B, y = A >= B ? B : A;
  const steps = [];
  let terminal = null;
  for (let i = 0; i < 400; i++) {
    const other = K * y - x;                 // 합 = k y
    const prodOk = other * x === y * y - C;  // 곱 = y^2 - c
    steps.push({ pair: `(${x}, ${y})`, other_root: other.toString(), sum_check: `${x}+(${other}) = ${K}*${y}`, product_check: prodOk, new_pair_satisfies: eq(other, y), sum_before: (x + y).toString() });
    if (!prodOk) throw new Error('비에타 곱 검산 실패 (내부 오류)');
    if (other <= 0n) { terminal = { x_prime: other.toString(), y: y.toString(), at_pair: `(${x}, ${y})` }; break; }
    if (other >= x) { terminal = { stuck: true, x_prime: other.toString(), y: y.toString(), at_pair: `(${x}, ${y})`, reason: '합이 줄지 않아 강하가 멈춤 (c<=0 이거나 k 가 작은 경우)' }; break; }
    if (other > y) { x = other; } else { x = y; y = other; }
  }
  const out = { k: K.toString(), c: C.toString(), equation: `x^2 + y^2 - ${K}*x*y = ${C}`, start: `(${A}, ${B})`, steps: steps.slice(0, 40), total_steps: steps.length };
  if (terminal && !terminal.stuck && BigInt(terminal.x_prime) === 0n) {
    const r = isSqB(C);
    out.terminal = `x'=0 이 되어 y^2 = c  (y = ${terminal.y}, c = ${C})`;
    out.c_is_square = r !== null; out.sqrt_c = r === null ? null : r.toString();
    out.conclusion = r !== null ? `c = ${C} = ${r}^2 이 완전제곱수` : '강하 끝이 x\'=0 이지만 c 가 제곱수가 아님 (입력 모순)';
  } else {
    out.terminal = terminal;
    out.conclusion = terminal && terminal.x_prime && BigInt(terminal.x_prime) < 0n
      ? 'x\' < 0 : k>0, y>=1 이면 x\'^2 + k y |x\'| + y^2 - c > 0 이 되어 모순 → 이 구간에 해가 없다는 뜻(입력 확인)'
      : '강하가 0 에서 끝나지 않음';
  }
  out.proof_outline = C === K && K > 0n ? [
    `$a^2+b^2 = k(ab+1)$ 의 몫 $k=${K}$ 는 양의 정수이다. 이 $k$ 를 고정하고, $a^2+b^2-kab-k=0$ 을 만족하는 양의 정수 쌍 $(a,b)$ 중 $a+b$ 가 최소인 것을 잡는다. 대칭이므로 $a\\ge b$ 로 둔다.`,
    '$x$ 에 대한 이차방정식 $x^2 - kb\\,x + (b^2-k) = 0$ 은 $x=a$ 를 근으로 갖는다. 다른 근을 $c$ 라 하면 비에타 공식에서 $a+c=kb$, $ac=b^2-k$. 따라서 $c=kb-a$ 는 정수이다.',
    '$c<0$ 이라 하자. $c$ 도 근이므로 $c^2 - kbc + b^2 - k = 0$ 인데, $-kbc = kb|c| \\ge k$ 이므로 좌변은 $c^2 + kb|c| + b^2 - k \\ge 1 + k + 1 - k > 0$ 이 되어 모순. 즉 $c\\ge 0$.',
    '$c>0$ 이라 하자. $ac=b^2-k>0$ 에서 $c=\\dfrac{b^2-k}{a}\\le \\dfrac{b^2-k}{b}<b\\le a$. 그러면 $(c,b)$ 도 해이고 $c+b<a+b$ 로 최소성에 모순.',
    '따라서 $c=0$, 즉 $b^2-k=0$ 이므로 $k=b^2$ — 완전제곱수이다. ∎'
  ] : '일반형(c≠k 또는 k≤0)에서는 같은 틀(최소해 → 비에타 → 부호 분석 → 강하)을 쓰되 부호 분석을 c 값에 맞게 다시 해야 한다.';
  return out;
};

// ---------------------------------------------------------------------------
// diophantine_scan
// ---------------------------------------------------------------------------
IMPL.diophantine_scan = ({ lhs, rhs = '0', vars = ['a', 'b'], lo = 1, hi = 40, max_hits = 40, value_expr }) => {
  const names = (Array.isArray(vars) && vars.length ? vars : ['a', 'b']).map(String).slice(0, 3);
  for (const n of names) if (!/^[A-Za-z]\w{0,5}$/.test(n)) throw new Error(`변수 이름이 올바르지 않습니다: ${n}`);
  const L = Math.floor(Number(lo)), H = Math.floor(Number(hi));
  if (!Number.isFinite(L) || !Number.isFinite(H) || H < L) throw new Error('lo <= hi 인 정수 범위가 필요합니다');
  const count = (H - L + 1) ** names.length;
  if (count > 400000) throw new Error(`탐색 칸 수 ${count} 가 너무 큽니다 (40만 이하로 줄이세요)`);
  if (typeof lhs !== 'string' || !lhs.trim()) throw new Error('lhs 가 필요합니다');
  const diffSrc = `(${lhs}) - (${rhs})`;
  const diffFn = compile(diffSrc, names[0]);
  const valFn = value_expr ? compile(String(value_expr), names[0]) : null;
  const cap = Math.min(Math.max(1, Number(max_hits) || 40), 100);
  const hits = []; const values = new Map();
  let scanned = 0, found = 0, nonSquare = 0;
  const env = {};
  const rec = depth => {
    if (depth === names.length) {
      scanned++;
      const extra = { ...env }; delete extra[names[0]];
      const d = diffFn(env[names[0]], extra);
      if (!Number.isFinite(d) || Math.abs(d) > 1e-6) return;
      found++;
      let val = null, sq = null;
      if (valFn) {
        val = valFn(env[names[0]], extra);
        if (Number.isFinite(val) && Math.abs(val - Math.round(val)) < 1e-9) {
          val = Math.round(val);
          const r = Math.round(Math.sqrt(Math.abs(val)));
          sq = val >= 0 && r * r === val;
          if (!sq) nonSquare++;
          values.set(val, (values.get(val) || 0) + 1);
        }
      }
      if (hits.length < cap) hits.push({ ...env, ...(valFn ? { value: val, is_square: sq } : {}) });
      return;
    }
    for (let i = L; i <= H; i++) { env[names[depth]] = i; rec(depth + 1); }
  };
  rec(0);
  const out = { equation: `${lhs} = ${rhs}`, range: `[${L}, ${H}]`, scanned, found, hits };
  if (valFn) {
    out.distinct_values = [...values.keys()].sort((x, y) => x - y).slice(0, 40);
    out.all_values_square = nonSquare === 0 && values.size > 0;
    out.non_square_count = nonSquare;
  }
  out.note = '범위 안의 수치 탐색은 증명이 아니다. 패턴(예: 값이 모두 제곱수)을 확인한 뒤 비에타 점프·모듈러 등 대수적 논증으로 증명하라.';
  return out;
};

// ---------------------------------------------------------------------------
// residue_table
// ---------------------------------------------------------------------------
IMPL.residue_table = ({ expr, m, vars = ['x'], target }) => {
  const M = Math.floor(Number(m));
  if (!Number.isFinite(M) || M < 2 || M > 400) throw new Error('m 은 2~400 의 정수여야 합니다');
  const names = (Array.isArray(vars) && vars.length ? vars : ['x']).map(String).slice(0, 2);
  if (typeof expr !== 'string' || !expr.trim()) throw new Error('expr 가 필요합니다');
  const f = compile(expr, names[0]);
  const seen = new Map();
  const put = (r, key) => { if (!seen.has(r)) seen.set(r, key); };
  const md = v => { if (!Number.isFinite(v) || Math.abs(v) > 9e15) throw new Error('값이 너무 커서 정확한 나머지를 구할 수 없습니다 (m 을 줄이세요)'); const r = Math.round(v); return ((r % M) + M) % M; };
  if (names.length === 1) for (let x = 0; x < M; x++) put(md(f(x)), `${names[0]}=${x}`);
  else for (let x = 0; x < M; x++) for (let y = 0; y < M; y++) put(md(f(x, { [names[1]]: y })), `${names[0]}=${x}, ${names[1]}=${y}`);
  const residues = [...seen.keys()].sort((a, b) => a - b);
  const out = { expr, mod: M, vars: names, residues, count: residues.length, missing: Array.from({ length: M }, (_, i) => i).filter(i => !seen.has(i)).slice(0, 60), witness: Object.fromEntries(residues.slice(0, 30).map(r => [r, seen.get(r)])) };
  if (target !== undefined && target !== null && String(target).trim() !== '') {
    const t = ((Math.round(Number(target)) % M) + M) % M;
    out.target = t; out.attainable = seen.has(t);
    out.conclusion = seen.has(t) ? `나머지 ${t} 는 mod ${M} 에서 가능` : `나머지 ${t} 는 mod ${M} 에서 불가능 → 해가 없다는 증명에 쓸 수 있음`;
  }
  return out;
};

const DECL = [
  { name: 'poly_expand', description: '다항식을 정확한 유리수 계수로 전개·정리한다. 대입(subs) 후 식이 0 인지 확인하거나("(-c)^2 - k*b*(-c) + (b^2 - k) = 0" 전개), var 를 주면 그 변수에 대한 계수와 이차일 때 비에타 근의 합·곱을 준다. 대수 변형·비에타 점프의 계산 검산에 사용. + - * / ^(정수) 만 지원.',
    parameters: OBJ({ expr: S('STRING', '식. 예: a^2+b^2-k*(a*b+1)  또는  (x+y)^3 - x^3 - y^3'), var: S('STRING', '계수를 뽑을 변수 (선택). 예: a'), subs: S('STRING', '대입 (선택). 예: "a=-c" 또는 "a=k*b-c; b=2"') }, ['expr']) },
  { name: 'vieta_jump', description: '비에타 점프(무한강하)를 실제로 수행한다. 방정식 x^2 + y^2 - k*x*y = c (IMO 1988 문제 6: ab+1 | a^2+b^2 이면 몫 k, c=k). 해 (a,b) 에서 시작해 다른 근 k*y-x 로 내려가며 합이 줄어드는 것·비에타 곱을 단계마다 검산하고, 끝점(x\'=0 → c=y^2)과 증명 뼈대(LaTeX)를 준다. k 를 생략하면 (a^2+b^2)/(ab+1) 로 계산.',
    parameters: OBJ({ a: S('STRING', '양의 정수 a'), b: S('STRING', '양의 정수 b'), k: S('STRING', '계수 k (생략 가능)'), c: S('STRING', '우변 c (생략하면 k)') }, ['a', 'b']) },
  { name: 'diophantine_scan', description: '정수 범위에서 lhs = rhs 인 해를 모두 찾고, value_expr(예: (a^2+b^2)/(a*b+1)) 이 해마다 정수·완전제곱수인지 보고한다. 부정방정식 증명 전에 패턴과 반례를 확인할 때 사용. 변수 최대 3개, 탐색 40만 칸 이하.',
    parameters: OBJ({ lhs: S('STRING', '좌변. 예: a^2+b^2'), rhs: S('STRING', '우변. 예: k*(a*b+1) 처럼 다른 변수 포함 가능, 생략 시 0'), vars: { type: 'ARRAY', items: { type: 'STRING' }, description: '변수 이름들 (기본 a,b)' }, lo: S('INTEGER', '범위 시작 (기본 1)'), hi: S('INTEGER', '범위 끝 (기본 40)'), max_hits: S('INTEGER', '보여줄 해 개수 (기본 40)'), value_expr: S('STRING', '해마다 계산할 값 식 (선택)') }, ['lhs']) },
  { name: 'residue_table', description: '식이 mod m 에서 가질 수 있는 나머지 집합(변수 1~2개)과 불가능한 나머지를 구한다. "제곱수는 mod 4 에서 0,1 뿐" 같은 모듈러 불가능성 증명, 이차잉여 확인에 사용. target 을 주면 가능 여부를 판정한다.',
    parameters: OBJ({ expr: S('STRING', '식. 예: x^2  또는 x^2+y^2'), m: S('INTEGER', '법 m (2~400)'), vars: { type: 'ARRAY', items: { type: 'STRING' }, description: '변수 이름 (기본 x, 최대 2개)' }, target: S('INTEGER', '가능 여부를 볼 나머지 (선택)') }, ['expr', 'm']) }
];

module.exports = { DECL, IMPL, _poly: { polyFromText, polyText } };
