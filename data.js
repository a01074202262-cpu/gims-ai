'use strict';
// 데이터 처리 도구: CSV 파싱·프로파일·질의·피벗·시간 버킷·이상치·결측 보간·롤링 통계·상관·조인·중복 제거·정규화·JSON 평탄화
const MAX_TEXT = 10 * 1024 * 1024;   // 10MB
const MAX_ROWS = 400_000;            // 10MB CSV(짧은 행 기준 약 40만 행) 지원. 메모리 약 200MB 내외 사용
const MAX_VALUES = 200_000;
const MAX_JOIN = 200_000;
const MAX_ROLL_WORK = 50_000_000;

const S = (type, description, extra = {}) => ({ type, description, ...extra });
const OBJ = (properties, required) => ({ type: 'OBJECT', properties, required });
const STR_LIST = description => ({ type: 'ARRAY', items: { type: 'STRING' }, description });
const NUM_LIST = description => ({ type: 'ARRAY', items: { type: 'NUMBER' }, description });

const NUM_RE = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;
const store = require('./store');
const r6 = x => (typeof x === 'number' && Number.isFinite(x) ? Number(x.toPrecision(10)) : x);
const num = (x, name) => {
  const y = typeof x === 'string' ? Number(x) : x;
  if (typeof y !== 'number' || !Number.isFinite(y)) throw new Error(`${name} 는 숫자여야 합니다`);
  return y;
};
const clamp = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Number.isFinite(Number(v)) ? Math.floor(Number(v)) : d));
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
function quantile(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
function coerce(v) {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  if (t === '') return null;
  if (NUM_RE.test(t)) return Number(t);
  if (/^(true|false)$/i.test(t)) return t.toLowerCase() === 'true';
  return String(v);
}
function parseCSV(text, delim = ',') {
  if (typeof text !== 'string') throw new Error('csv 는 문자열이어야 합니다');
  if (text.length > MAX_TEXT) throw new Error('CSV가 너무 큽니다 (10MB 이하)');
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const body = rows.filter(r => !(r.length === 1 && r[0] === ''));
  if (!body.length) throw new Error('데이터가 없습니다');
  if (body.length > MAX_ROWS + 1) throw new Error(`행이 너무 많습니다 (최대 ${MAX_ROWS}행)`);
  const header = body[0].map(h => h.trim());
  if (new Set(header).size !== header.length) throw new Error('헤더 열 이름이 중복됩니다');
  const records = body.slice(1).map(r => {
    const o = {};
    header.forEach((h, j) => { o[h] = coerce(r[j]); });
    return o;
  });
  return { header, records };
}
function toCSV(header, records) {
  const esc = v => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [header.map(esc).join(','), ...records.map(r => header.map(h => esc(r[h])).join(','))].join('\n');
}
const need = (header, cols) => { for (const c of cols) if (c && !header.includes(c)) throw new Error(`없는 열: ${c}`); };

const OPS = {
  '==': (a, b) => a == b, '!=': (a, b) => a != b,
  '>=': (a, b) => a >= b, '<=': (a, b) => a <= b,
  '>': (a, b) => a > b, '<': (a, b) => a < b,
  contains: (a, b) => String(a ?? '').includes(String(b))
};
function parseWhere(list) {
  return (list || []).map(s => {
    const m = /^\s*(.+?)\s*(==|!=|>=|<=|>|<|contains)\s*(.+?)\s*$/.exec(String(s));
    if (!m) throw new Error(`where 형식 오류: "${s}" (예: "age >= 20")`);
    let v = m[3].replace(/^["']|["']$/g, '');
    if (NUM_RE.test(v)) v = Number(v);
    return { col: m[1], op: m[2], val: v };
  });
}
const AGGS = ['count', 'sum', 'avg', 'min', 'max', 'median', 'std'];
function parseMetrics(list) {
  return (list && list.length ? list : ['count']).map(s => {
    const [agg, col] = String(s).split(':').map(x => x.trim());
    if (!AGGS.includes(agg)) throw new Error(`알 수 없는 집계: ${agg} (${AGGS.join(', ')})`);
    if (agg !== 'count' && !col) throw new Error(`${agg} 에는 열 이름이 필요합니다 (예: sum:amount)`);
    return { agg, col, name: col ? `${agg}(${col})` : 'count' };
  });
}
function aggregate(rows, m) {
  if (m.agg === 'count') return m.col ? rows.filter(r => r[m.col] !== null).length : rows.length;
  const v = rows.map(r => r[m.col]).filter(x => typeof x === 'number');
  if (!v.length) return null;
  if (m.agg === 'sum') return r6(v.reduce((a, b) => a + b, 0));
  if (m.agg === 'avg') return r6(mean(v));
  if (m.agg === 'min') return v.reduce((a, b) => (b < a ? b : a));
  if (m.agg === 'max') return v.reduce((a, b) => (b > a ? b : a));
  if (m.agg === 'std') { const mu = mean(v); return r6(v.length > 1 ? Math.sqrt(v.reduce((s, x) => s + (x - mu) ** 2, 0) / (v.length - 1)) : 0); }
  return r6(quantile([...v].sort((a, b) => a - b), 0.5));
}
const groupBy = (records, cols) => {
  const g = new Map();
  for (const r of records) {
    const k = JSON.stringify(cols.map(c => r[c]));
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(r);
  }
  return g;
};
const pearson = (xs, ys) => {
  const n = xs.length;
  if (n < 3) return null;
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
};

const IMPL = {};

IMPL.csv_profile = ({ csv }) => {
  const { header, records } = parseCSV(csv);
  const columns = header.map(col => {
    const vals = records.map(r => r[col]);
    const present = vals.filter(v => v !== null);
    const numeric = present.filter(v => typeof v === 'number');
    const type = present.length && numeric.length / present.length >= 0.8 ? 'number' : 'string';
    const base = { name: col, count: vals.length, missing: vals.length - present.length, unique: new Set(present.map(String)).size, type };
    if (type === 'number' && numeric.length) {
      const s = [...numeric].sort((a, b) => a - b);
      return { ...base, min: s[0], max: s[s.length - 1], mean: r6(mean(s)), median: r6(quantile(s, 0.5)), p90: r6(quantile(s, 0.9)), p99: r6(quantile(s, 0.99)) };
    }
    return base;
  });
  return { rows: records.length, columns };
};

IMPL.csv_query = ({ csv, where, group_by, metrics, order_by, desc = true, limit = 50 }) => {
  const { header, records } = parseCSV(csv);
  const conds = parseWhere(where);
  const gcols = group_by || [];
  const ms = parseMetrics(metrics);
  need(header, [...conds.map(c => c.col), ...gcols, ...ms.map(m => m.col)]);
  const rows = records.filter(r => conds.every(c => OPS[c.op](r[c.col], c.val)));
  let out;
  if (!gcols.length) {
    const o = {};
    for (const m of ms) o[m.name] = aggregate(rows, m);
    out = [o];
  } else {
    out = [...groupBy(rows, gcols).entries()].map(([k, rs]) => {
      const o = {};
      JSON.parse(k).forEach((v, i) => { o[gcols[i]] = v; });
      for (const m of ms) o[m.name] = aggregate(rs, m);
      return o;
    });
  }
  if (order_by) {
    const dir = desc ? -1 : 1;
    out.sort((a, b) => {
      const x = a[order_by] ?? -Infinity, y = b[order_by] ?? -Infinity;
      return x === y ? 0 : (x > y ? 1 : -1) * dir;
    });
  }
  return { matched: rows.length, groups: out.length, rows: out.slice(0, clamp(limit, 1, 500, 50)) };
};

IMPL.value_counts = ({ csv, column, limit = 20 }) => {
  const { header, records } = parseCSV(csv);
  need(header, [column]);
  const c = new Map();
  let total = 0;
  for (const r of records) {
    if (r[column] === null) continue;
    total++;
    const k = String(r[column]);
    c.set(k, (c.get(k) || 0) + 1);
  }
  const top = [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, clamp(limit, 1, 200, 20))
    .map(([value, count]) => ({ value, count, share: r6(count / total) }));
  return { total, unique: c.size, top };
};

IMPL.pivot_table = ({ csv, index, columns, value, agg = 'sum' }) => {
  const { header, records } = parseCSV(csv);
  need(header, [index, columns, value]);
  if (!AGGS.includes(agg)) throw new Error(`알 수 없는 집계: ${agg}`);
  const rowKeys = [...new Set(records.map(r => String(r[index])))];
  const colKeys = [...new Set(records.map(r => String(r[columns])))];
  if (rowKeys.length > 500 || colKeys.length > 50) throw new Error('피벗 범위가 너무 큽니다 (행 500, 열 50 이하)');
  const cells = new Map();
  for (const r of records) {
    const k = String(r[index]) + '\u0001' + String(r[columns]);
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(r);
  }
  const table = rowKeys.map(rk => colKeys.map(ck => {
    const rs = cells.get(rk + '\u0001' + ck);
    return rs ? aggregate(rs, { agg, col: value }) : null;
  }));
  return { index, columns, value, agg, rowKeys, colKeys, table };
};

IMPL.time_bucket = ({ csv, date_column, value_column, period = 'month', agg = 'sum' }) => {
  const { header, records } = parseCSV(csv);
  need(header, [date_column, value_column]);
  if (!['day', 'month', 'year'].includes(period)) throw new Error('period 는 day, month, year 중 하나');
  let invalid = 0;
  const recs = [];
  for (const r of records) {
    const t = Date.parse(String(r[date_column]));
    if (Number.isNaN(t)) { invalid++; continue; }
    const iso = new Date(t).toISOString();
    recs.push({ __k: period === 'year' ? iso.slice(0, 4) : period === 'day' ? iso.slice(0, 10) : iso.slice(0, 7), [value_column]: r[value_column] });
  }
  const g = groupBy(recs, ['__k']);
  const rows = [...g.entries()].map(([k, rs]) => ({ period: JSON.parse(k)[0], count: rs.length, value: aggregate(rs, { agg, col: value_column }) }))
    .sort((a, b) => (a.period < b.period ? -1 : 1));
  return { invalidDates: invalid, periods: rows.length, rows: rows.slice(0, 500) };
};

IMPL.detect_outliers = ({ values, method = 'iqr', k }) => {
  if (!Array.isArray(values) || values.length < 4 || values.length > MAX_VALUES) throw new Error('values 는 4~200000개여야 합니다');
  const v = values.map((x, i) => num(x, `values[${i}]`));
  if (method === 'zscore') {
    const m = mean(v), sd = Math.sqrt(mean(v.map(x => (x - m) ** 2))) || 1, t = k ?? 3;
    const out = v.map((x, i) => ({ i, x, z: r6((x - m) / sd) })).filter(o => Math.abs(o.z) > t);
    return { method: 'zscore', threshold: t, count: out.length, outliers: out.slice(0, 200), mean: r6(m), std: r6(sd) };
  }
  const s = [...v].sort((a, b) => a - b);
  const q1 = quantile(s, 0.25), q3 = quantile(s, 0.75), f = k ?? 1.5;
  const lo = q1 - f * (q3 - q1), hi = q3 + f * (q3 - q1);
  const out = v.map((x, i) => ({ i, x })).filter(o => o.x < lo || o.x > hi);
  return { method: 'iqr', fences: [r6(lo), r6(hi)], q1: r6(q1), q3: r6(q3), count: out.length, outliers: out.slice(0, 200) };
};

IMPL.impute_missing = ({ csv, column, method = 'mean', value }, ctx = {}) => {
  const { header, records } = parseCSV(csv);
  need(header, [column]);
  const present = records.map(r => r[column]).filter(v => v !== null);
  const nums = present.filter(v => typeof v === 'number');
  let fill = null;
  if (method === 'mean') fill = nums.length ? mean(nums) : null;
  else if (method === 'median') fill = nums.length ? quantile([...nums].sort((a, b) => a - b), 0.5) : null;
  else if (method === 'zero') fill = 0;
  else if (method === 'constant') fill = coerce(value);
  else if (method !== 'ffill') throw new Error('method 는 mean, median, zero, constant, ffill 중 하나');
  let filled = 0;
  if (method === 'ffill') {
    let last = null;
    for (const r of records) {
      if (r[column] === null) { if (last !== null) { r[column] = last; filled++; } }
      else last = r[column];
    }
  } else {
    for (const r of records) if (r[column] === null && fill !== null) { r[column] = fill; filled++; }
  }
  const out = toCSV(header, records);
  if (ctx.owner) {
    const saved = store.put(ctx.owner, `${column}_imputed.csv`, out);
    return { filled, fillValue: r6(fill), dataset_id: saved.id, bytes: saved.bytes, preview: out.split('\n').slice(0, 20).join('\n') };
  }
  return { filled, fillValue: r6(fill), csv: out.length > 200000 ? out.slice(0, 200000) + '…(잘림, dataset_id 사용 권장)' : out };
};

IMPL.rolling_stats = ({ values, window = 5, stat = 'mean' }) => {
  if (!Array.isArray(values) || !values.length || values.length > MAX_VALUES) throw new Error('values 개수가 올바르지 않습니다');
  const v = values.map((x, i) => num(x, `values[${i}]`));
  const W = clamp(window, 1, 500, 5);
  if (v.length * W > MAX_ROLL_WORK) throw new Error('데이터×윈도우가 너무 큽니다');
  if (!['mean', 'sum', 'min', 'max', 'std'].includes(stat)) throw new Error('stat 은 mean, sum, min, max, std');
  const out = [];
  for (let i = 0; i < v.length; i++) {
    if (i < W - 1) { out.push(null); continue; }
    const s = v.slice(i - W + 1, i + 1);
    out.push(r6(stat === 'mean' ? mean(s) : stat === 'sum' ? s.reduce((a, b) => a + b, 0)
      : stat === 'min' ? Math.min(...s) : stat === 'max' ? Math.max(...s)
      : (s.length > 1 ? Math.sqrt(s.reduce((a, x) => a + (x - mean(s)) ** 2, 0) / (s.length - 1)) : 0)));
  }
  return { window: W, stat, values: out.slice(-1000), length: out.length };
};

IMPL.correlation_matrix = ({ csv, columns }) => {
  const { header, records } = parseCSV(csv);
  const numericCols = header.filter(h => records.filter(r => typeof r[h] === 'number').length >= records.length * 0.8);
  const cols = columns && columns.length ? columns : numericCols.slice(0, 20);
  need(header, cols);
  const matrix = cols.map(a => cols.map(b => {
    const pairs = records.filter(r => typeof r[a] === 'number' && typeof r[b] === 'number');
    return r6(pearson(pairs.map(r => r[a]), pairs.map(r => r[b])));
  }));
  const pairs = [];
  for (let i = 0; i < cols.length; i++) for (let j = i + 1; j < cols.length; j++) {
    if (typeof matrix[i][j] === 'number') pairs.push({ a: cols[i], b: cols[j], r: Number(matrix[i][j].toFixed(4)) });
  }
  pairs.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));
  return { columns: cols, matrix, strongestPairs: pairs.slice(0, 10), note: 'Pearson 상관계수. 상관이 인과를 뜻하지 않습니다' };
};

IMPL.join_tables = ({ left_csv, right_csv, on, how = 'inner' }) => {
  const L = parseCSV(left_csv), R = parseCSV(right_csv);
  if (!L.header.includes(on) || !R.header.includes(on)) throw new Error(`두 표 모두 열 "${on}" 이 있어야 합니다`);
  const idx = new Map();
  for (const r of R.records) {
    const k = String(r[on]);
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push(r);
  }
  const out = [];
  for (const l of L.records) {
    const ms = idx.get(String(l[on])) || [];
    if (!ms.length) { if (how === 'left') out.push({ ...l }); continue; }
    for (const r of ms) {
      out.push({ ...l, ...r, [on]: l[on] });
      if (out.length > MAX_JOIN) throw new Error('조인 결과가 너무 큽니다');
    }
  }
  const columns = [...new Set(out.flatMap(o => Object.keys(o)))];
  return { rows: out.length, columns, sample: out.slice(0, 50) };
};

IMPL.dedupe_csv = ({ csv, keys }, ctx = {}) => {
  const { header, records } = parseCSV(csv);
  const ks = keys && keys.length ? keys : header;
  need(header, ks);
  const seen = new Set(), kept = [];
  for (const r of records) {
    const key = JSON.stringify(ks.map(k => r[k]));
    if (!seen.has(key)) { seen.add(key); kept.push(r); }
  }
  const out = toCSV(header, kept);
  if (ctx.owner) { const saved = store.put(ctx.owner, 'deduped.csv', out); return { before: records.length, after: kept.length, removed: records.length - kept.length, dataset_id: saved.id, bytes: saved.bytes }; }
  return { before: records.length, after: kept.length, removed: records.length - kept.length, csv: out.length > 200000 ? out.slice(0, 200000) + '…(잘림)' : out };
};

IMPL.normalize_values = ({ values, method = 'minmax' }) => {
  if (!Array.isArray(values) || !values.length || values.length > MAX_VALUES) throw new Error('values 개수가 올바르지 않습니다');
  const v = values.map((x, i) => num(x, `values[${i}]`));
  if (method === 'zscore') {
    const m = mean(v), sd = Math.sqrt(mean(v.map(x => (x - m) ** 2))) || 1;
    return { method, mean: r6(m), std: r6(sd), values: v.map(x => r6((x - m) / sd)) };
  }
  const mn = v.reduce((a, b) => (b < a ? b : a)), mx = v.reduce((a, b) => (b > a ? b : a)), span = mx - mn || 1;
  return { method: 'minmax', min: mn, max: mx, values: v.map(x => r6((x - mn) / span)) };
};

IMPL.flatten_json = ({ json }) => {
  if (typeof json !== 'string' || json.length > MAX_TEXT) throw new Error('json 은 1MB 이하 문자열이어야 합니다');
  let obj;
  try { obj = JSON.parse(json); } catch (e) { throw new Error('JSON 파싱 실패: ' + e.message); }
  const fields = {};
  const walk = (v, p) => {
    if (Object.keys(fields).length >= 500) return;
    if (v && typeof v === 'object') {
      const ks = Array.isArray(v) ? v.map((_, i) => i) : Object.keys(v);
      if (!ks.length) { fields[p || '$'] = Array.isArray(v) ? '[]' : '{}'; return; }
      for (const k of ks) walk(v[k], p ? `${p}.${k}` : String(k));
    } else fields[p || '$'] = v;
  };
  walk(obj, '');
  return { fieldCount: Object.keys(fields).length, fields };
};

const DECL = [
  { name: 'csv_profile', description: 'CSV의 열별 타입, 결측, 고유값, 수치 요약(최소·최대·평균·중앙값·p90·p99)을 보여준다. 데이터 분석의 첫 단계.',
    parameters: OBJ({ csv: S('STRING', 'CSV 전체 텍스트 (첫 줄은 헤더)') }, ['csv']) },
  { name: 'csv_query', description: 'CSV를 필터링·그룹화·집계·정렬한다. where 예: "age >= 20". metrics 예: "sum:amount", "avg:price", "std:x", "count".',
    parameters: OBJ({
      csv: S('STRING', 'CSV 텍스트'),
      where: STR_LIST('필터 조건. 연산자: == != >= <= > < contains'),
      group_by: STR_LIST('그룹화할 열 이름'),
      metrics: STR_LIST('집계: count, sum:열, avg:열, min:열, max:열, median:열, std:열'),
      order_by: S('STRING', '정렬 기준 (집계 열 이름, 예: sum(amount))'),
      desc: S('BOOLEAN', '내림차순 여부 (기본 true)'),
      limit: S('INTEGER', '출력 행 수 (최대 500)')
    }, ['csv']) },
  { name: 'value_counts', description: '한 열의 값별 빈도와 비율을 센다.',
    parameters: OBJ({ csv: S('STRING', 'CSV'), column: S('STRING', '열 이름'), limit: S('INTEGER', '상위 개수 (최대 200)') }, ['csv', 'column']) },
  { name: 'pivot_table', description: '피벗 표를 만든다: 행 열 × 열 값 × 집계.',
    parameters: OBJ({
      csv: S('STRING', 'CSV'), index: S('STRING', '행 기준 열'), columns: S('STRING', '열 기준 열'),
      value: S('STRING', '집계할 열'), agg: S('STRING', '집계 방식', { enum: AGGS })
    }, ['csv', 'index', 'columns', 'value']) },
  { name: 'time_bucket', description: '날짜 열을 일·월·연 단위로 묶어 값을 집계한다(시계열 요약).',
    parameters: OBJ({
      csv: S('STRING', 'CSV'), date_column: S('STRING', '날짜 열 (ISO 형식 권장)'), value_column: S('STRING', '값 열'),
      period: S('STRING', 'day, month, year', { enum: ['day', 'month', 'year'] }),
      agg: S('STRING', '집계', { enum: AGGS })
    }, ['csv', 'date_column', 'value_column']) },
  { name: 'detect_outliers', description: '이상치 탐지. iqr(사분위 범위) 또는 zscore(표준점수).',
    parameters: OBJ({ values: NUM_LIST('숫자 배열'), method: S('STRING', 'iqr 또는 zscore', { enum: ['iqr', 'zscore'] }), k: S('NUMBER', '기준 배수') }, ['values']) },
  { name: 'impute_missing', description: '결측값을 평균·중앙값·0·상수·앞값 채우기(ffill)로 보간하고 결과 CSV를 돌려준다.',
    parameters: OBJ({
      csv: S('STRING', 'CSV'), column: S('STRING', '대상 열'),
      method: S('STRING', '방식', { enum: ['mean', 'median', 'zero', 'constant', 'ffill'] }),
      value: S('STRING', 'constant 방식일 때 값')
    }, ['csv', 'column']) },
  { name: 'rolling_stats', description: '이동 윈도우 통계(이동 평균, 합, 최소, 최대, 표준편차)를 계산한다.',
    parameters: OBJ({
      values: NUM_LIST('시계열 값'), window: S('INTEGER', '윈도우 크기 (1~500)'),
      stat: S('STRING', '통계', { enum: ['mean', 'sum', 'min', 'max', 'std'] })
    }, ['values']) },
  { name: 'correlation_matrix', description: '숫자 열들의 Pearson 상관행렬과 가장 강한 상관쌍을 구한다.',
    parameters: OBJ({ csv: S('STRING', 'CSV'), columns: STR_LIST('대상 열 (생략 시 숫자 열 자동 선택)') }, ['csv']) },
  { name: 'join_tables', description: '두 CSV를 한 열 기준으로 조인한다(inner 또는 left).',
    parameters: OBJ({
      left_csv: S('STRING', '왼쪽 CSV'), right_csv: S('STRING', '오른쪽 CSV'),
      on: S('STRING', '조인 키 열'), how: S('STRING', 'inner 또는 left', { enum: ['inner', 'left'] })
    }, ['left_csv', 'right_csv', 'on']) },
  { name: 'dedupe_csv', description: '중복 행을 제거하고 전후 행 수와 결과 CSV(최대 2000행)를 돌려준다.',
    parameters: OBJ({ csv: S('STRING', 'CSV'), keys: STR_LIST('중복 판단 열 (생략 시 전체)') }, ['csv']) },
  { name: 'normalize_values', description: '값을 정규화한다. minmax(0~1) 또는 zscore.',
    parameters: OBJ({ values: NUM_LIST('숫자 배열'), method: S('STRING', 'minmax 또는 zscore', { enum: ['minmax', 'zscore'] }) }, ['values']) },
  { name: 'flatten_json', description: '중첩 JSON을 점(.) 경로 필드 목록으로 평탄화한다(API 응답 해석용).',
    parameters: OBJ({ json: S('STRING', 'JSON 문자열') }, ['json']) }
];

module.exports = { DECL, IMPL, parseCSV, toCSV, r6, num, clamp, quantile, mean, coerce, NUM_RE };
