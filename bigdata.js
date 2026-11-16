'use strict';
// 빅데이터 도구: 적은 메모리로 큰 데이터를 근사·스트리밍 처리
//  - HyperLogLog (고유 개수), Space-Saving (상위 빈도), Count-Min Sketch (빈도 추정)
//  - Bloom 필터 (존재 여부), 저수지 샘플링, 분위수 스케치, Welford 온라인 통계
//  - 청크 그룹 집계, 텀블링 윈도우 집계, 히스토그램
// 도구 인자로 보낼 수 있는 데이터는 1MB 안팎이므로, 수 GB급은 URL 스트리밍 도구가 별도로 필요하다.
const crypto = require('crypto');
const { parseCSV, r6, num, clamp } = require('./data');

const MAX_ITEMS = 200_000;
const S = (type, description, extra = {}) => ({ type, description, ...extra });
const OBJ = (properties, required) => ({ type: 'OBJECT', properties, required });
const STR_LIST = description => ({ type: 'ARRAY', items: { type: 'STRING' }, description });
const NUM_LIST = description => ({ type: 'ARRAY', items: { type: 'NUMBER' }, description });

// md5 한 번으로 32비트 해시 4개를 얻는다 (더블 해싱용)
const h4 = s => {
  const d = crypto.createHash('md5').update(String(s)).digest();
  return [d.readUInt32BE(0), d.readUInt32BE(4), d.readUInt32BE(8), d.readUInt32BE(12)];
};
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const checkItems = (items, name = 'items') => {
  if (!Array.isArray(items) || !items.length || items.length > MAX_ITEMS) throw new Error(`${name} 는 1~${MAX_ITEMS}개여야 합니다`);
  return items;
};
const checkNums = (arr, name) => {
  if (!Array.isArray(arr) || !arr.length || arr.length > MAX_ITEMS) throw new Error(`${name} 개수가 올바르지 않습니다`);
  return arr.map((x, i) => num(x, `${name}[${i}]`));
};

const IMPL = {};

IMPL.approx_distinct = ({ items, p = 12 }) => {
  checkItems(items);
  const P = clamp(p, 4, 16, 12), m = 1 << P, reg = new Uint8Array(m);
  for (const it of items) {
    const h = h4(it)[0];
    const idx = h >>> (32 - P);
    const w = (h << P) >>> 0;
    const rank = w === 0 ? 33 - P : Math.clz32(w) + 1;
    if (rank > reg[idx]) reg[idx] = rank;
  }
  const alpha = m === 16 ? 0.673 : m === 32 ? 0.697 : m === 64 ? 0.709 : 0.7213 / (1 + 1.079 / m);
  let sum = 0, zeros = 0;
  for (const r of reg) { sum += 2 ** -r; if (!r) zeros++; }
  let E = (alpha * m * m) / sum;
  if (E <= 2.5 * m && zeros) E = m * Math.log(m / zeros);
  return { estimate: Math.round(E), relativeError: `약 ±${((1.04 / Math.sqrt(m)) * 100).toFixed(1)}%`, registers: m, total: items.length };
};

IMPL.top_k_frequent = ({ items, k = 10 }) => {
  checkItems(items);
  const K = clamp(k, 1, 100, 10), cap = Math.min(Math.max(K * 4, 20), 500);
  const counts = new Map();
  for (const it of items) {
    const key = String(it);
    if (counts.has(key)) counts.set(key, counts.get(key) + 1);
    else if (counts.size < cap) counts.set(key, 1);
    else {
      let minKey = null, minV = Infinity;
      for (const [kk, vv] of counts) if (vv < minV) { minV = vv; minKey = kk; }
      counts.delete(minKey); counts.set(key, minV + 1);
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, K).map(([item, count]) => ({ item, count }));
  return { top, approximate: items.length > cap, note: '빈도는 상한 근사값이며 과대 추정될 수 있습니다' };
};

IMPL.count_min_sketch = ({ items, queries = [], width = 2048, depth = 4 }) => {
  checkItems(items);
  const W = clamp(width, 64, 8192, 2048), D = clamp(depth, 1, 8, 4);
  const table = Array.from({ length: D }, () => new Uint32Array(W));
  const cols = s => { const h = h4(s); return Array.from({ length: D }, (_, r) => ((h[0] + Math.imul(r, h[1] | 1)) >>> 0) % W); };
  for (const it of items) { const c = cols(it); for (let r = 0; r < D; r++) table[r][c[r]]++; }
  const estimates = queries.slice(0, 200).map(q => {
    const c = cols(q);
    return { item: q, estimate: Math.min(...c.map((ci, r) => table[r][ci])) };
  });
  return { total: items.length, width: W, depth: D, estimates, note: 'Count-Min 은 실제보다 크거나 같은 값만 낸다' };
};

IMPL.bloom_check = ({ items, probes = [], bits = 8192, hashes = 4 }) => {
  checkItems(items);
  const M = clamp(bits, 64, 1048576, 8192), K = clamp(hashes, 1, 10, 4);
  const bf = new Uint8Array(M);
  const idx = s => { const h = h4(s); return Array.from({ length: K }, (_, i) => ((h[0] + Math.imul(i, h[1] | 1)) >>> 0) % M); };
  for (const it of items) for (const i of idx(it)) bf[i] = 1;
  const results = probes.slice(0, 500).map(p => ({ item: p, maybe_present: idx(p).every(i => bf[i] === 1) }));
  const n = items.length, fpr = Math.pow(1 - Math.exp((-K * n) / M), K);
  return { results, estimatedFalsePositiveRate: Number(fpr.toExponential(2)), note: 'maybe_present=false 는 확실히 없음, true 는 있을 수 있음' };
};

IMPL.reservoir_sample = ({ items, n = 10, seed = 1 }) => {
  checkItems(items);
  const N = clamp(n, 1, 1000, 10), sd = clamp(seed, 0, 2 ** 31 - 1, 1), rnd = mulberry32(sd), res = [];
  items.forEach((x, i) => {
    if (res.length < N) res.push(x);
    else { const j = Math.floor(rnd() * (i + 1)); if (j < N) res[j] = x; }
  });
  return { sample: res, population: items.length, size: res.length, seed: sd };
};

IMPL.quantiles_sketch = ({ values, qs = [0.5, 0.9, 0.99], sample = 10000 }) => {
  const v = checkNums(values, 'values');
  const S_ = clamp(sample, 100, 50000, 10000), sd = 1, rnd = mulberry32(sd);
  let pool = v;
  const exact = v.length <= S_;
  if (!exact) {
    pool = [];
    v.forEach((x, i) => {
      if (pool.length < S_) pool.push(x);
      else { const j = Math.floor(rnd() * (i + 1)); if (j < S_) pool[j] = x; }
    });
  }
  const sorted = [...pool].sort((a, b) => a - b);
  const out = {};
  for (const q of qs.slice(0, 20)) {
    const p = Math.min(1, Math.max(0, num(q, 'q')));
    const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
    out[String(p)] = r6(sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo));
  }
  return { quantiles: out, exact, sampleSize: pool.length, population: v.length, approxRankError: exact ? 0 : r6(1 / Math.sqrt(pool.length)) };
};

IMPL.streaming_stats = ({ values, chunk = 10000 }) => {
  if (!Array.isArray(values) || values.length > MAX_ITEMS) throw new Error('values 개수가 올바르지 않습니다');
  const C = clamp(chunk, 1000, 100000, 10000);
  let n = 0, mu = 0, M2 = 0, mn = Infinity, mx = -Infinity, skipped = 0;
  for (let i = 0; i < values.length; i++) {
    const v = typeof values[i] === 'string' ? Number(values[i]) : values[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) { skipped++; continue; }
    n++;
    const d = v - mu; mu += d / n; M2 += d * (v - mu);
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  return {
    count: n, mean: r6(mu), std: r6(n > 1 ? Math.sqrt(M2 / (n - 1)) : 0),
    min: n ? mn : null, max: n ? mx : null, skipped,
    chunks: Math.ceil(values.length / C), chunkSize: C
  };
};

IMPL.histogram = ({ values, bins = 10 }) => {
  const v = checkNums(values, 'values');
  const B = clamp(bins, 2, 100, 10);
  const mn = v.reduce((a, b) => (b < a ? b : a)), mx = v.reduce((a, b) => (b > a ? b : a));
  const w = (mx - mn) / B || 1;
  const counts = new Array(B).fill(0);
  for (const x of v) counts[Math.min(B - 1, Math.floor((x - mn) / w))]++;
  return { edges: Array.from({ length: B + 1 }, (_, i) => r6(mn + i * w)), counts };
};

IMPL.chunked_group_sum = ({ csv, key, value, chunk_rows = 5000 }) => {
  const { header, records } = parseCSV(csv);
  if (!header.includes(key) || !header.includes(value)) throw new Error(`열 "${key}" 과 "${value}" 가 필요합니다`);
  const C = clamp(chunk_rows, 500, 50000, 5000);
  const acc = new Map();
  let chunks = 0, skipped = 0;
  for (let s = 0; s < records.length; s += C) {
    chunks++;
    const end = Math.min(s + C, records.length);
    for (let i = s; i < end; i++) {
      const r = records[i], v = r[value];
      if (typeof v !== 'number') { skipped++; continue; }
      const k = String(r[key]);
      const a = acc.get(k) || { sum: 0, count: 0 };
      a.sum += v; a.count++;
      acc.set(k, a);
    }
  }
  const rows = [...acc.entries()]
    .map(([k, a]) => ({ key: k, sum: r6(a.sum), count: a.count, avg: r6(a.sum / a.count) }))
    .sort((x, y) => y.sum - x.sum);
  return { chunks, groups: rows.length, skipped, top: rows.slice(0, 50) };
};

IMPL.tumbling_window = ({ timestamps, values, width }) => {
  const t = checkNums(timestamps, 'timestamps');
  const v = checkNums(values, 'values');
  if (t.length !== v.length) throw new Error('timestamps 와 values 길이가 같아야 합니다');
  const W = num(width, 'width');
  if (W <= 0) throw new Error('width 는 0보다 커야 합니다');
  const buckets = new Map();
  for (let i = 0; i < t.length; i++) {
    const start = Math.floor(t[i] / W) * W;
    const b = buckets.get(start) || { count: 0, sum: 0, min: Infinity, max: -Infinity };
    b.count++; b.sum += v[i];
    if (v[i] < b.min) b.min = v[i];
    if (v[i] > b.max) b.max = v[i];
    buckets.set(start, b);
  }
  const rows = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([start, b]) => ({
    start: r6(start), end: r6(start + W), count: b.count, sum: r6(b.sum), avg: r6(b.sum / b.count), min: b.min, max: b.max
  }));
  return { windows: rows.length, rows: rows.slice(0, 500) };
};

const DECL = [
  { name: 'approx_distinct', description: 'HyperLogLog로 고유 항목 수를 근사한다(메모리 일정, 오차 약 ±2%). 대량 ID의 고유 개수에 사용.',
    parameters: OBJ({ items: STR_LIST('항목 문자열 목록'), p: S('INTEGER', '정밀도 4~16 (기본 12)') }, ['items']) },
  { name: 'top_k_frequent', description: 'Space-Saving으로 가장 많이 나온 항목 상위 k개를 근사한다. 스트림에 적합.',
    parameters: OBJ({ items: STR_LIST('항목 목록'), k: S('INTEGER', '상위 개수 (최대 100)') }, ['items']) },
  { name: 'count_min_sketch', description: 'Count-Min Sketch로 특정 항목들의 빈도를 추정한다(과대 추정만 발생).',
    parameters: OBJ({
      items: STR_LIST('전체 항목 스트림'), queries: STR_LIST('빈도를 알고 싶은 항목'),
      width: S('INTEGER', '폭 (64~8192)'), depth: S('INTEGER', '깊이 (1~8)')
    }, ['items']) },
  { name: 'bloom_check', description: 'Bloom 필터로 항목이 집합에 있는지 확인한다. 없음은 확실, 있음은 가능성(오탐 가능).',
    parameters: OBJ({
      items: STR_LIST('집합 원소'), probes: STR_LIST('존재 여부를 확인할 항목'),
      bits: S('INTEGER', '비트 수 (64~1048576)'), hashes: S('INTEGER', '해시 함수 개수 (1~10)')
    }, ['items']) },
  { name: 'reservoir_sample', description: '저수지 샘플링으로 균등 무작위 표본을 뽑는다. seed 로 재현 가능.',
    parameters: OBJ({ items: STR_LIST('항목 목록'), n: S('INTEGER', '표본 크기 (최대 1000)'), seed: S('INTEGER', '난수 시드') }, ['items']) },
  { name: 'quantiles_sketch', description: '분위수를 근사한다. 표본 기반이므로 대용량에서도 메모리가 일정하다.',
    parameters: OBJ({
      values: NUM_LIST('값 목록'), qs: NUM_LIST('분위수 목록 (0~1), 예: 0.5, 0.9, 0.99'),
      sample: S('INTEGER', '표본 크기 (100~50000)')
    }, ['values']) },
  { name: 'streaming_stats', description: 'Welford 온라인 알고리즘으로 평균·표준편차·최소·최대를 한 번의 순회로 계산한다.',
    parameters: OBJ({ values: NUM_LIST('값 목록'), chunk: S('INTEGER', '청크 크기 (1000~100000)') }, ['values']) },
  { name: 'histogram', description: '등간격 히스토그램(구간 경계와 개수).',
    parameters: OBJ({ values: NUM_LIST('값 목록'), bins: S('INTEGER', '구간 수 (2~100)') }, ['values']) },
  { name: 'chunked_group_sum', description: '큰 CSV를 청크 단위로 처리해 키별 합계·개수·평균을 구한다.',
    parameters: OBJ({
      csv: S('STRING', 'CSV 텍스트'), key: S('STRING', '그룹 키 열'), value: S('STRING', '숫자 값 열'),
      chunk_rows: S('INTEGER', '청크당 행 수 (500~50000)')
    }, ['csv', 'key', 'value']) },
  { name: 'tumbling_window', description: '시간 스탬프 기반 고정 폭 윈도우(텀블링)로 개수·합·평균·최소·최대를 집계한다.',
    parameters: OBJ({
      timestamps: NUM_LIST('시간 값(예: 초 단위 유닉스 시간)'), values: NUM_LIST('이벤트 값'),
      width: S('NUMBER', '윈도우 폭 (같은 단위)')
    }, ['timestamps', 'values', 'width']) }
];

module.exports = { DECL, IMPL };
