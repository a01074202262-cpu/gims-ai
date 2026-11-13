/**
 * reasoning.js — 강화 추론 파이프라인 v2 (DeepSeek-R1 방식 사고 + 다중 전략 + 합의도 + 검증·반박 + 수정 루프)
 *
 *  문제 분류·분석 → 서로 다른 전략의 풀이 N개 병렬 → 합의도(투표) → [검증 ∥ 반박] → (문제 시) 오류 수정 → 재검토 → 최종 답
 *  각 단계가 시작/끝날 때 onStep({id,label,state,ms,detail}) 호출 → 화면에 "무엇을 생각하는지 + 걸린 시간" 표시.
 *  최종 답 스트리밍은 server.js 담당 — 여기서는 검증 자료를 붙인 contents 만 만들어 돌려준다.
 */
'use strict';

// 추론 정도. cost = 하루 질문 한도에서 차감되는 횟수, budget = Gemini 내장 사고 토큰 예산(모델이 거부하면 자동으로 빼고 재시도)
const LEVELS = {
  low:    { label: '낮음', samples: 1, plan: false, refute: false, revise: 0, budget: 0,     cost: 2,  timeout: 60_000,  desc: '풀이 1개 + 검증' },
  medium: { label: '보통', samples: 3, plan: true,  refute: false, revise: 0, budget: 4096,  cost: 4,  timeout: 120_000, desc: '분석 + 서로 다른 방식 풀이 3개 + 합의도 + 검증' },
  high:   { label: '높음', samples: 4, plan: true,  refute: true,  revise: 1, budget: 8192,  cost: 7,  timeout: 200_000, desc: '분석 + 풀이 4개 + 합의도 + 검증·반박 + 오류 수정 1회' },
  max:    { label: '최대', samples: 5, plan: true,  refute: true,  revise: 2, budget: 16384, cost: 10, timeout: 300_000, desc: '분석 + 풀이 5개 + 합의도 + 검증·반박 + 오류 수정 최대 2회' }
};
const info = () => Object.fromEntries(Object.entries(LEVELS).map(([k, v]) => [k, { label: v.label, cost: v.cost, desc: v.desc }]));

const DS_KEY = process.env.DEEPSEEK_API_KEY || '';
const DS_BASE = process.env.DEEPSEEK_BASE || 'https://api.deepseek.com';
const DS_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-reasoner';
const TEMPS = [0.3, 0.7, 1.0, 0.5, 0.9];

// 풀이마다 서로 다른 전략 → 같은 실수를 반복하지 않게 하고, 합의도의 신뢰를 높인다
const STRATEGIES = [
  { n: '직접 풀이',   p: '가장 표준적인 방법으로 조건을 빠짐없이 반영해 단계별로 푼다.' },
  { n: '역방향 검산', p: '결론을 가정하고 거꾸로 따져 보며 푼다. 답이 나오면 원래 조건에 다시 대입해 확인한다.' },
  { n: '반례 탐색',   p: '일반적인 답이 깨지는 경계·예외·반례를 먼저 찾아본 뒤, 그것까지 통과하는 답을 구한다.' },
  { n: '다른 관점',   p: '앞의 접근과 완전히 다른 방법(다른 공식·다른 알고리즘·다른 논증)으로 푼다.' },
  { n: '함정 회피',   p: '이 유형에서 흔한 오답과 함정을 먼저 3개 나열하고, 각각을 피하는지 확인하며 푼다.' }
];
const KIND_HINT = [
  ['수학', '계산·수학 문제: 중간 계산을 모두 적고, 최종값을 다른 방식(역산·근사·수치 대입)으로 검산해.'],
  ['코드', '코드 문제: 구현 전에 입력/출력/예외를 정하고, 코드를 완성한 뒤 테스트 입력 3개(정상·경계·오류)를 손으로 실행해 결과를 확인해.'],
  ['논리', '논리 문제: 모든 조건에 번호를 매겨 나열하고, 각 조건이 결론과 모순되지 않는지 하나씩 대조해.'],
  ['사실', '사실 질문: 확실히 아는 것과 불확실한 것을 구분하고, 모르거나 최신 정보가 필요한 부분은 추측하지 말고 그렇게 말해.'],
  ['글쓰기', '글쓰기: 독자·목적·분량 등 요구 조건을 먼저 정리하고, 마지막에 요구 조건을 빠짐없이 지켰는지 점검해.']
];

const PLAN_SYSTEM = `질문을 분석해서 정확히 아래 5줄만 써. 다른 말은 쓰지 마.
유형: (수학, 코드, 논리, 사실, 글쓰기, 기타 중 하나)
난이도: (쉬움, 보통, 어려움 중 하나)
핵심: (무엇을 묻는지 한 줄)
접근: (어떤 방법·순서로 풀지 한 줄)
주의: (틀리기 쉬운 함정이나 모호한 점 한 줄)`;

const R1_SYSTEM = `너는 DeepSeek-R1 방식으로 깊게 추론하는 해결사야. 반드시 아래 형식을 지켜.
<think>
1) 문제를 자기 말로 다시 정리하고, 조건·제약·모호한 점을 적는다. (첫 줄에 지금 무엇을 생각하는지 한 문장으로 요약)
2) 풀이 계획을 세운 뒤 단계별로 푼다. 계산·논리·코드는 생략하지 않는다.
3) 중간마다 "잠깐, 이게 맞나?" 하고 스스로 점검하고, 틀렸으면 되돌아가 고친다.
4) 결론을 다른 방법(역산, 반례, 극단값 대입, 단위·경계 확인)으로 한 번 더 검증한다.
</think>
<answer>
사용자에게 보여줄 최종 답. 질문과 같은 언어로, 핵심 결론을 먼저 쓰고 필요한 근거만 담는다.
</answer>
<final>
위 답의 핵심 결론만 한 줄(숫자, 선택지, 예/아니오, 함수·메서드 이름 등 서로 비교할 수 있는 형태, 40자 이내)
</final>`;

const CRITIC_SYSTEM = `너는 엄격한 검증자야. 질문과 여러 풀이(와 합의도, 참고 풀이)가 주어진다.
- 풀이를 그대로 믿지 말고, 계산·사실·논리·코드를 처음부터 직접 다시 확인해서 오류를 찾아낸다.
- 결론이 서로 다르면 스스로 풀어서 어느 쪽이 맞는지 판정한다. 다수결이라고 맞다고 보지 마.
- 출력 형식(이 순서 그대로):
  VERDICT: OK 또는 FIX   (OK = 문제 없음, FIX = 오류·불일치 있음)
  CONFIDENCE: 0~100   (최종 결론이 맞을 확신도)
  그 다음 줄부터 (a) 확정된 올바른 결론 (b) 발견한 오류 (c) 최종 답에서 꼭 포함/주의할 점을 간결한 목록으로.`;

const REFUTE_SYSTEM = `너는 반박 전문가야. 가장 유력한 결론이 주어지면, 그것을 무너뜨리는 반례·계산 오류·빠뜨린 조건·잘못된 가정을 적극적으로 찾아라.
- 실제로 확인되는 문제만 인정하고, 억지로 트집 잡지 마.
- 출력 형식: 첫 줄은 "BREAK: YES"(결론이 틀렸거나 중대한 결함 발견) 또는 "BREAK: NO"(찾지 못함).
  그 다음 줄부터 직접 계산·대입·실행해서 확인한 근거를 간결하게.`;

const FIX_SYSTEM = R1_SYSTEM + `\n\n주어진 검증·반박 결과가 지적한 오류를 모두 바로잡아 처음부터 다시 풀고, 올바른 최종 답을 <answer>에 써.`;

const FINAL_SYSTEM = `질문 끝에 [내부 검증 자료]가 붙어 있으면 그것을 참고해서 가장 정확한 최종 답을 써.
- 자료의 존재, 초안, 검증 과정은 절대 언급하지 마. 핵심 결론부터 말해.
- 풀이가 갈렸다면 검증 결과를 따르고, 확신도가 60 미만이거나 반박이 인정된 부분은 불확실하다고 솔직히 밝혀.
- 코드는 검증에서 지적된 문제를 모두 반영한 완성본으로 준다.`;

const textOf = c => (c.parts || []).map(p => p.text || '').join('');
const clip = (s, n) => (s.length > n ? s.slice(0, n) + ' …(생략)' : s);
const brief = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };

// Gemini 호출 — 사고 예산을 넣었다가 모델이 400 으로 거부하면 예산 없이 재시도(그 모델은 기억)
const noBudget = new Set();
async function gen({ base, key, model, contents, system, temperature, signal, budget }) {
  const call = b => fetch(`${base}/v1beta/models/${model}:generateContent`, {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents, systemInstruction: { parts: [{ text: system }] }, generationConfig: { temperature, ...(b ? { thinkingConfig: { thinkingBudget: b } } : {}) } })
  });
  let b = budget && !noBudget.has(model) ? budget : 0;
  let r = await call(b);
  if (!r.ok && r.status === 400 && b) { noBudget.add(model); r = await call(0); }
  if (!r.ok) throw new Error('Gemini ' + r.status);
  const j = await r.json();
  return (j.candidates || []).flatMap(c => c.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('').trim();
}

async function deepseek(contents, signal) {
  const messages = contents.slice(-10).map(c => ({ role: c.role === 'model' ? 'assistant' : 'user', content: textOf(c) })).filter(m => m.content);
  if (!messages.length || messages[messages.length - 1].role !== 'user') return null;
  const r = await fetch(`${DS_BASE}/chat/completions`, {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DS_KEY}` },
    body: JSON.stringify({ model: DS_MODEL, messages })
  });
  if (!r.ok) throw new Error('DeepSeek ' + r.status);
  const m = (await r.json()).choices?.[0]?.message;
  return m ? { reasoning: m.reasoning_content || '', answer: m.content || '' } : null;
}

const splitDraft = t => {
  const a = t.match(/<answer>([\s\S]*?)(?:<\/answer>|<final>|$)/i);
  const th = t.match(/<think>([\s\S]*?)(?:<\/think>|$)/i);
  const f = t.match(/<final>([\s\S]*?)(?:<\/final>|$)/i);
  return {
    think: th ? th[1].trim() : '',
    answer: (a ? a[1] : t.replace(/<think>[\s\S]*?<\/think>/i, '').replace(/<final>[\s\S]*$/i, '')).trim(),
    final: f ? f[1].trim() : ''
  };
};
const gist = d => brief(d.think.split('\n').find(l => l.trim().length > 8) || d.think, 140);

// 합의도: 풀이들의 한 줄 결론이 얼마나 일치하는지 (정규화한 문자열 비교 — 참고용 신호이며 최종 판정은 검증자가 한다)
const norm = s => s.toLowerCase().replace(/[\s.,!?'"`~*_()\[\]{}:;·。，、]/g, '');
function vote(ds) {
  const groups = new Map();
  for (const d of ds) { const k = norm(d.final || ''); if (k) groups.set(k, [...(groups.get(k) || []), d]); }
  if (!groups.size) return null;
  const sorted = [...groups.values()].sort((x, y) => y.length - x.length);
  const counted = [...groups.values()].reduce((n, g) => n + g.length, 0);
  return { top: sorted[0], topFinal: sorted[0][0].final, size: sorted[0].length, total: counted, others: sorted.slice(1).map(g => g[0].final) };
}

function stepper(onStep) {
  const t0 = {};
  const emit = o => { try { onStep && onStep(o); } catch {} };
  return {
    start(id, label, detail) { t0[id] = Date.now(); emit({ id, label, state: 'start', detail }); },
    done(id, detail, label) { emit({ id, label, state: 'done', ms: Date.now() - (t0[id] || Date.now()), detail }); }
  };
}

async function prepare({ base, key, model, contents, signal, level, onStep }) {
  const L = level;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), L.timeout);
  const onAbort = () => ctl.abort();
  if (signal) signal.addEventListener('abort', onAbort);
  const st = stepper(onStep);
  try {
    const common = { base, key, model, contents, signal: ctl.signal, budget: L.budget };
    const q = clip(contents.slice(-6).map(c => `[${c.role}] ${textOf(c)}`).join('\n'), 6000);
    const askOne = (text, system, temperature) => gen({ ...common, contents: [{ role: 'user', parts: [{ text }] }], system, temperature });

    // 1) 문제 분류·분석
    let plan = '', kindHint = '';
    if (L.plan) {
      st.start('plan', '문제 분류·분석');
      try {
        plan = await gen({ ...common, budget: 0, system: PLAN_SYSTEM, temperature: 0.2 });
        const kind = (plan.match(/유형:\s*(\S+)/) || [])[1] || '';
        kindHint = (KIND_HINT.find(([k]) => kind.includes(k)) || [])[1] || '';
        st.done('plan', clip(plan.split('\n').filter(l => l.trim()).join('\n'), 420));
      } catch (e) { if (ctl.signal.aborted) throw e; st.done('plan', '건너뜀'); }
    }

    // 2) 서로 다른 전략의 풀이 N개 병렬 (+ DeepSeek-R1 참고 풀이)
    const N = L.samples;
    const jobs = Array.from({ length: N }, (_, i) => {
      const S = STRATEGIES[i % STRATEGIES.length], id = 'draft' + i;
      const sys = [R1_SYSTEM, `[이번 풀이의 전략: ${S.n}] ${S.p}`, kindHint, plan && `[사전 분석]\n${plan}`].filter(Boolean).join('\n\n');
      st.start(id, N > 1 ? `풀이 ${i + 1}/${N} · ${S.n}` : '풀이');
      return gen({ ...common, system: sys, temperature: TEMPS[i] }).then(t => {
        const d = splitDraft(t); d.strategy = S.n; st.done(id, `${gist(d)}\n→ 결론: ${brief(d.final || d.answer, 90)}`); return d;
      }, e => { st.done(id, '실패'); throw e; });
    });
    let dsJob = Promise.resolve(null);
    if (DS_KEY) {
      st.start('ds', 'DeepSeek-R1 풀이');
      dsJob = deepseek(contents, ctl.signal).then(r => { st.done('ds', r ? brief(r.answer, 120) : '건너뜀'); return r; }, () => { st.done('ds', '실패'); return null; });
    }
    const [settled, ref] = await Promise.all([Promise.allSettled(jobs), dsJob]);
    const drafts = settled.filter(s => s.status === 'fulfilled' && s.value && s.value.answer).map(s => s.value);
    if (!drafts.length) throw new Error('풀이 생성 실패');

    // 3) 합의도
    let v = null;
    if (drafts.length > 1) {
      v = vote(drafts);
      if (v) {
        st.start('vote', '합의도');
        st.done('vote', v.size === v.total ? `✓ ${v.total}개 풀이 모두 일치: ${brief(v.topFinal, 80)}`
          : `⚠ ${v.size}/${v.total} 일치 — 다수: ${brief(v.topFinal, 60)}\n소수: ${brief(v.others.join(' / '), 80)}`);
      }
    }
    const voteLine = () => (v ? `합의도: ${v.size}/${v.total} 일치 · 다수 결론: ${v.topFinal}${v.others.length ? ' · 소수 결론: ' + v.others.join(' / ') : ''}` : '');

    // 4) 검증 ∥ 반박 → (문제 시) 오류 수정 → 재검토
    const view = () => drafts.map((d, i) => `### ${d.fixed ? '수정본' : '풀이'} ${i + 1}${d.strategy ? ' (' + d.strategy + ')' : ''}\n[사고]\n${clip(d.think, 3500)}\n[답]\n${clip(d.answer, 2500)}\n[결론] ${d.final}`).join('\n\n')
      + (ref ? `\n\n### 참고 풀이 (DeepSeek-R1)\n[사고]\n${clip(ref.reasoning, 3500)}\n[답]\n${clip(ref.answer, 2500)}` : '');
    const verdictOf = c => (c.match(/VERDICT:\s*(\w+)/i) || [])[1]?.toUpperCase() || null;
    const confOf = c => { const n = Number((c.match(/CONFIDENCE:\s*(\d{1,3})/i) || [])[1]); return Number.isFinite(n) ? Math.min(100, n) : null; };
    const breakOf = c => (c.match(/BREAK:\s*(\w+)/i) || [])[1]?.toUpperCase() || null;
    const bodyLine = c => brief(c.split('\n').slice(1).find(l => l.trim().length > 3 && !/^CONFIDENCE/i.test(l.trim())) || '', 130);

    async function review(sfx) {
      const lead = v ? v.top[v.top.length - 1] : drafts[drafts.length - 1];
      const vid = 'verify' + sfx, rid = 'refute' + sfx;
      st.start(vid, sfx ? '재검증' : '검증');
      const verifyP = askOne(`## 질문\n${q}\n\n${voteLine()}\n\n## 풀이들\n${view()}`, CRITIC_SYSTEM, 0.2)
        .then(c => { st.done(vid, `${verdictOf(c) === 'FIX' ? '⚠ 오류/불일치 발견' : '✓ 문제 없음'}${confOf(c) != null ? ` · 확신도 ${confOf(c)}%` : ''}\n${bodyLine(c)}`); return c; },
              e => { if (ctl.signal.aborted) throw e; st.done(vid, '건너뜀'); return ''; });
      let refuteP = Promise.resolve('');
      if (L.refute) {
        st.start(rid, sfx ? '재반박' : '반박 시도');
        refuteP = askOne(`## 질문\n${q}\n\n## 가장 유력한 결론\n${lead.final}\n\n## 그 풀이\n${clip(lead.answer, 3000)}`, REFUTE_SYSTEM, 0.4)
          .then(c => { st.done(rid, `${breakOf(c) === 'YES' ? '⚠ 반박 성공' : '✓ 반박 실패(결론 유지)'}\n${bodyLine(c)}`); return c; },
                e => { if (ctl.signal.aborted) throw e; st.done(rid, '건너뜀'); return ''; });
      }
      const [c, r] = await Promise.all([verifyP, refuteP]);
      const fix = verdictOf(c) === 'FIX' || breakOf(r) === 'YES';
      return { text: [c, r && `[반박 검토]\n${r}`].filter(Boolean).join('\n\n'), fix, conf: confOf(c) };
    }

    let rv = await review('');
    for (let r = 1; r <= L.revise && rv.fix; r++) {
      const fid = 'fix' + r; st.start(fid, `오류 수정 ${r}/${L.revise}`);
      try {
        const t = await askOne(`## 질문\n${q}\n\n## 기존 풀이들\n${view()}\n\n## 검증·반박 결과\n${rv.text}`, FIX_SYSTEM, 0.3);
        const d = splitDraft(t); d.fixed = true; d.strategy = '수정'; if (d.answer) drafts.push(d);
        st.done(fid, `${gist(d)}\n→ 결론: ${brief(d.final || d.answer, 90)}`);
      } catch (e) { if (ctl.signal.aborted) throw e; st.done(fid, '실패'); break; }
      v = vote(drafts) || v;   // 수정본 포함해 다시 집계
      rv = await review(String(r));
    }

    // 5) 최종 답 작성용 contents
    const answers = drafts.map((d, i) => `- ${d.fixed ? '수정본' : '풀이'} ${i + 1}: ${clip(d.answer, 2200)}`).join('\n') + (ref ? `\n- DeepSeek: ${clip(ref.answer, 2200)}` : '');
    const note = `\n\n[내부 검증 자료 — 언급 금지]\n${plan ? `분석:\n${plan}\n\n` : ''}${answers}\n\n${voteLine()}\n확신도: ${rv.conf ?? '알 수 없음'}${rv.fix ? ' · 마지막 검토에서도 문제가 남아 있음' : ''}\n\n검증 결과:\n${clip(rv.text || '(없음)', 3500)}\n[자료 끝]`;
    const out = contents.map(c => ({ ...c, parts: c.parts.map(p => ({ ...p })) }));
    const last = out[out.length - 1];
    if (last && last.role === 'user') {
      const tp = last.parts.find(p => typeof p.text === 'string');
      if (tp) tp.text += note; else last.parts.push({ text: note });
    }
    return { contents: out, system: FINAL_SYSTEM, stats: { drafts: drafts.length, agree: v ? `${v.size}/${v.total}` : null, confidence: rv.conf, unresolved: rv.fix, deepseek: !!ref } };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

module.exports = { prepare, LEVELS, info };
