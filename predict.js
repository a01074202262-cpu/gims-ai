'use strict';
// 사용자 요청 예측 도구 (통계·규칙 기반, 외부 호출 없음)
//  - classify: 요청의 의도 분류 (키워드 가중치 점수)
//  - predict_next_request: 지난 요청들의 의도 순서로 1차 마르코프 전이 확률 계산 (라플라스 평활 + 전체 빈도 혼합)
//  - predict_followups: 현재 요청에서 이어질 가능성이 높은 후속 요청 후보 순위화
//  - 의도별로 미리 준비해 둘 추론 도구 그룹(prefetch) 제안
const S = (type, description, extra = {}) => ({ type, description, ...extra });
const OBJ = (properties, required) => ({ type: 'OBJECT', properties, required });
const STR_LIST = description => ({ type: 'ARRAY', items: { type: 'STRING' }, description });

const INTENTS = {
  math:     { '계산': 2, '방정식': 3, '적분': 3, '미분': 3, '확률': 3, '행렬': 3, '수학': 3, '소수': 2, '최대공약수': 3, '공식': 2, 'integral': 3, 'derivative': 3, 'equation': 3, 'solve': 2, 'math': 2, 'prime': 2, 'factorial': 2, '증명': 3, '정수': 2, '나누어': 3, '제곱': 2, '나머지': 2, '모듈러': 2, '합동': 2, 'gcd': 3, 'lcm': 2, '인수': 2, '소수판정': 3, '이항': 2, '부등식': 2, '항등식': 3, '나누면': 2, '약수': 2, '배수': 2, 'divides': 3, 'modulo': 2, 'prove': 3, '증명하시오': 3, '보이시오': 3, '보여라': 2, '양의 정수': 3, '자연수': 2, '정수해': 3, '완전제곱': 3, '부정방정식': 3, '디오판토스': 3, '비에타': 3, '근과 계수': 3, '무한강하': 3, '강하법': 3, '귀납법': 2, '모듈러': 2, '합동식': 3, '정수론': 3, '올림피아드': 3, 'imo': 3, 'vieta': 3, 'descent': 2, 'diophantine': 3, 'congruence': 2, '이차방정식': 2, '약수': 2, '부등식': 2 },
  coding:   { 'luau': 4, 'lua': 3, '루아': 3, '루아우': 4, 'roblox': 4, '로블록스': 4, '로블': 3, 'rojo': 3, 'getservice': 3, 'remoteevent': 3, '모듈스크립트': 3, 'modulescript': 3, '서버스크립트': 3, '로컬스크립트': 3, 'localscript': 3, '파일': 1, '다운로드': 1, '코드': 3, '함수': 2, '버그': 3, '에러': 2, '오류': 2, '컴파일': 3, '구현': 2, '알고리즘': 2, '리팩터': 3, '테스트': 2, '시간복잡도': 3, 'python': 3, 'javascript': 3, 'typescript': 3, 'java': 2, 'code': 3, 'function': 2, 'bug': 3, 'class': 2, 'compile': 3, 'refactor': 3, 'algorithm': 2, 'debug': 3, 'node': 2, 'express': 2, 'html': 3, 'css': 2, 'index.html': 3, '웹': 2, '페이지': 2, '프론트': 2, '서버': 2, 'api': 2, '엔드포인트': 2, '스크립트': 2, '프로그램': 2, '앱': 2, '만들어': 2, '작성': 1, '게임': 1, '캔버스': 2, 'preview': 2, '실행': 1, '문법': 2, 'syntax': 2, 'runtime': 2, 'react': 2, 'vue': 2, 'dom': 2, 'fetch': 2, 'json': 1 },
  data:     { '데이터': 3, 'csv': 3, '엑셀': 2, '집계': 3, '그룹': 2, '평균': 2, '통계': 3, '피벗': 3, '데이터셋': 3, '상관': 3, '이상치': 3, '시계열': 3, '결측': 3, 'dataset': 3, 'pivot': 3, 'aggregate': 2, 'json': 2, 'excel': 2, 'outlier': 3, 'missing': 2 },
  bigdata:  { '빅데이터': 3, '대용량': 3, '스트림': 3, '고유 개수': 3, '샘플링': 3, '분위수': 3, '근사': 2, 'big data': 3, 'hyperloglog': 3, 'bloom': 3, 'billion': 2, 'stream': 2, 'sketch': 3 },
  github:   { 'github': 3, '깃허브': 3, '레포': 3, '이슈': 2, '커밋': 3, 'pull request': 3, 'repo': 3, 'issue': 2, 'commit': 2, '풀리퀘스트': 3 },
  game:     { '게임': 3, '퍼즐': 2, '보드': 2, '캔버스': 2, '플레이어': 2, '레벨': 2, 'game': 3, 'canvas': 2, 'player': 2, 'level': 2, '점수': 2, 'sprite': 2, '키조작': 2 },
  writing:  { '글': 2, '작성': 3, '요약': 3, '번역': 3, '이메일': 3, '보고서': 3, '문장': 2, '에세이': 3, 'write': 3, 'summar': 3, 'translate': 3, 'essay': 2, 'email': 3 },
  security: { '보안': 3, '취약': 3, '해킹': 2, '인젝션': 3, '비밀번호': 2, 'xss': 3, 'security': 3, 'vulnerab': 3, 'injection': 3, 'secret': 2 },
  factual:  { '누구': 2, '언제': 2, '어디': 2, '무엇': 2, '최신': 3, '현재': 2, '뉴스': 3, '가격': 2, '날씨': 3, 'who': 2, 'when': 2, 'where': 2, 'latest': 3, 'news': 3, 'price': 2 }
};
const INTENT_LIST = [...Object.keys(INTENTS), 'other'];

// 의도 → 미리 준비할 추론 도구 그룹
const INTENT_GROUPS = {
  math: ['math'],
  coding: ['coding', 'workspace', 'vserver', 'sandbox'],
  data: ['data'],
  bigdata: ['bigdata', 'data'],
  github: ['external'],
  game: ['coding', 'workspace', 'vserver'],
  writing: [],
  security: ['coding', 'sandbox'],
  factual: [],
  other: []
};

const FOLLOW = {
  coding: ['이 코드의 시간 복잡도는?', '테스트 케이스를 추가해줘', '보안 취약점이 있는지 점검해줘', '엣지 케이스를 정리해줘', '더 간단하게 리팩터링해줘', '에러 원인을 단계별로 설명해줘', '가상 서버에서 실행해서 오류 확인해줘', 'index.html 로 만들어 zip으로 줘', 'CSS/레이아웃도 다듬어줘', '모바일에서도 되게 해줘'],
  math: ['풀이를 단계별로 검산해줘', '다른 방법으로도 확인해줘', '숫자를 바꿔서 같은 유형 문제를 만들어줘', '그래프로 보여줘'],
  data: ['이상치가 있는지 확인해줘', '결측값을 채워줘', '그룹별로 다시 집계해줘', '상관관계를 계산해줘', '시간에 따른 추세를 보여줘'],
  bigdata: ['고유 개수를 근사해줘', '상위 빈도 항목을 뽑아줘', '샘플링해서 요약해줘', '분위수를 계산해줘'],
  github: ['최근 이슈를 요약해줘', '해당 파일 내용을 보여줘', '최근 커밋 흐름을 정리해줘'],
  game: ['게임 규칙을 점검해줘', 'AI 상대를 더 강하게 만들어줘', '난이도 곡선을 조정해줘', '모바일에서도 되게 해줘'],
  writing: ['더 짧게 줄여줘', '존댓말로 바꿔줘', '핵심만 세 줄로 요약해줘'],
  security: ['수정 코드를 보여줘', '다른 취약점도 있는지 확인해줘'],
  factual: ['출처를 알려줘', '최신 정보로 다시 확인해줘', '더 자세히 설명해줘'],
  other: ['더 자세히 설명해줘', '예시를 들어줘']
};

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ASCII_KW = /^[a-z0-9 .+\-#]+$/;
function countHits(text, kw) {
  const t = text.toLowerCase();
  if (ASCII_KW.test(kw)) {
    return (t.match(new RegExp(`(?:^|[^a-z0-9])${esc(kw)}(?=$|[^a-z0-9])`, 'g')) || []).length;
  }
  return t.split(kw.toLowerCase()).length - 1;
}

function classify(text) {
  const s = String(text || '').slice(0, 4000);
  const scores = {};
  for (const [intent, kws] of Object.entries(INTENTS)) {
    let sc = 0;
    for (const [kw, w] of Object.entries(kws)) sc += w * countHits(s, kw);
    scores[intent] = sc;
  }
  // 구조적 힌트 가중치 (키워드만으로 놓치는 코딩 요청 보완)
  if (/\blocal\s+function\b|game:GetService|script\.Parent|\bend\)?\s*$/m.test(s) && /\blocal\b|game:|script\./.test(s)) scores.coding = (scores.coding || 0) + 5;
  if (/```/.test(s)) scores.coding = (scores.coding || 0) + 4;
  if (/<!doctype|<html[\s>]|<script[\s>]/i.test(s)) scores.coding = (scores.coding || 0) + 5;
  if (/function\s*\(|=>\s*\{|def\s+\w+\s*\(|console\.log/.test(s)) scores.coding = (scores.coding || 0) + 3;
  if (languageOf(s) && /만들|작성|구현|짜\s*줘|고쳐|수정/.test(s)) scores.coding = (scores.coding || 0) + 4;
  if (/만들어\s*줘|작성해\s*줘|구현해|고쳐|수정해/.test(s) && /(코드|html|css|js|페이지|게임|앱|사이트|파일|프로그램|계산기|파이썬|python|스크립트)/i.test(s)) {
    scores.coding = (scores.coding || 0) + 4;
  }
  if (/canvas|requestAnimationFrame|점수|플레이어/i.test(s)) scores.game = (scores.game || 0) + 3;
  // 수식 구조 힌트: 숫자 연산, 방정식, LaTeX, 거듭제곱
  if (/\d\s*[-+*/^]\s*\d|\\frac|\\sqrt|\\mid|\\equiv|\\pmod|[a-z]\s*\^\s*[\d{(]|\bx\s*\^\s*\d|[a-z]\s*=\s*[-\d(]|\bf\(x\)|\d+\s*!|∑|∫|√|\w\s*\|\s*\w/i.test(s) && !/```|<\w+>/.test(s)) scores.math = (scores.math || 0) + 4;
  if (/Traceback|TypeError|ReferenceError|SyntaxError|is not defined|undefined is not|Cannot read prop|NameError|IndentationError|Uncaught/i.test(s)) scores.coding = (scores.coding || 0) + 6;
  if (/https?:\/\/github\.com\//i.test(s)) scores.github = (scores.github || 0) + 4;
  // 한 가지 의도만 압도적일 때가 아니라면 짧은 질문은 other 로 기운다
  const total = Object.values(scores).reduce((a, b) => a + b, 0);
  if (!total) return { intent: 'other', confidence: 0, scores, secondary: [], subIntent: subIntentOf(s), margin: 0 };
  const ranked = Object.entries(scores).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  const margin = ranked[1] ? Number(((top[1] - ranked[1][1]) / top[1]).toFixed(3)) : 1;
  return {
    intent: top[0], confidence: Number((top[1] / total).toFixed(3)), scores,
    secondary: ranked.slice(1, 3).filter(([, v]) => v >= top[1] * 0.4).map(([k]) => k),
    subIntent: subIntentOf(s), margin
  };
}

// 요청의 "행동" 분류: 만들기/고치기/설명/최적화/테스트/검토/변환
const SUB = {
  fix:      /오류|에러|버그|안\s*(돼|됨|되|나와)|고쳐|수정|해결|왜\s*안|fix|error|bug|not defined|undefined|traceback|exception|crash|fail/i,
  create:   /만들어|작성해|구현해|생성|짜\s*줘|개발해|create|build|implement|generate|write a/i,
  explain:  /설명|뭐야|무슨\s*뜻|이해|어떻게\s*동작|why|explain|what is|how does/i,
  optimize: /최적화|빠르게|성능|시간\s*복잡도|줄여|optimi[sz]e|faster|performance|speed up/i,
  test:     /테스트|검증|확인해|맞는지|test|verify|check/i,
  review:   /리뷰|점검|검토|보안|취약|review|audit|lint|improve/i,
  convert:  /변환|바꿔|번역|옮겨|포팅|convert|translate|port to|migrate/i,
  solve:    /풀어|구해|계산|증명|solve|compute|prove|evaluate|find the/i
};
function subIntentOf(s) {
  for (const [k, re] of Object.entries(SUB)) if (re.test(s)) return k;
  return 'other';
}
// 언어 힌트
function languageOf(s) {
  if (/\bpython\b|파이썬|\bdef\s+\w+\(|^\s*import\s+\w+\s*$|\.py\b/im.test(s)) return 'python';
  if (/typescript|\.tsx?\b|:\s*(string|number)\b/i.test(s)) return 'ts';
  if (/<!doctype|<html|\bcss\b|index\.html|웹\s*페이지|html/i.test(s)) return 'html';
  if (/\bluau?\b|루아|로블록스|roblox|game:GetService|\blocal\s+function\b/i.test(s)) return 'luau';
  if (/javascript|\bjs\b|node|express|react|const\s+\w+\s*=|=>|function\s*\(/i.test(s)) return 'js';
  if (/\bjava\b|\bc\+\+|\bgolang\b|\brust\b|\bkotlin\b|\bc#/i.test(s)) return 'other-lang';
  return null;
}

function groupsFor(intent, level) {
  const g = [...(INTENT_GROUPS[intent] || [])];
  if (intent === 'coding' || intent === 'game') {
    if (!g.includes('vserver')) g.push('vserver');
    if (!g.includes('workspace')) g.push('workspace');
    if (level && (level.refute || level.samples >= 2) && !g.includes('sandbox')) g.push('sandbox');
  }
  return g;
}

const IMPL = {};

IMPL.intent_classify = ({ text }) => {
  if (typeof text !== 'string' || !text.trim()) throw new Error('text 는 비어 있지 않은 문자열이어야 합니다');
  const r = classify(text);
  return { intent: r.intent, confidence: r.confidence, secondary: r.secondary, action: r.subIntent, language: languageOf(text), prefetchGroups: INTENT_GROUPS[r.intent] || [] };
};

IMPL.predict_next_request = ({ history = [], top = 3 }) => {
  if (!Array.isArray(history)) throw new Error('history 는 문자열 배열이어야 합니다');
  const recent = history.slice(-500).map(h => String(h));
  const labels = recent.map(h => classify(h).intent);
  const K = INTENT_LIST.length, alpha = 0.4, n = labels.length;
  // 최근 요청일수록 큰 가중치 (반감기 12개)
  const wOf = i => Math.pow(0.5, (n - 1 - i) / 12);
  const freq = Object.fromEntries(INTENT_LIST.map(s => [s, 0]));
  labels.forEach((l, i) => { freq[l] += wOf(i); });
  const fTot = Object.values(freq).reduce((a, b) => a + b, 0);
  const globalP = s => (freq[s] + alpha) / (fTot + alpha * K);
  const count = (ctxLen) => {   // ctxLen 개의 직전 의도 → 다음 의도
    const T = new Map();
    for (let i = ctxLen; i < n; i++) {
      const key = labels.slice(i - ctxLen, i).join('>');
      if (!T.has(key)) T.set(key, Object.fromEntries(INTENT_LIST.map(s => [s, 0])));
      T.get(key)[labels[i]] += (wOf(i) + 0.5) / 1.5;
    }
    return T;
  };
  const T1 = count(1), T2 = count(2);
  const last = n ? labels[n - 1] : null, last2 = n > 1 ? labels.slice(-2).join('>') : null;
  const row1 = last ? T1.get(last) : null, row2 = last2 ? T2.get(last2) : null;
  const tot = r => (r ? Object.values(r).reduce((a, b) => a + b, 0) : 0);
  const t1 = tot(row1), t2 = tot(row2);
  const l2 = t2 / (t2 + 3), l1 = t1 / (t1 + 4) * (1 - l2);
  // 같은 의도가 연속될 확률(관성)도 별도로 반영
  let streak = 0; for (let i = n - 1; i >= 0 && labels[i] === last; i--) streak++;
  const probs = INTENT_LIST.map(s => {
    const p2 = row2 ? (row2[s] + alpha) / (t2 + alpha * K) : 0;
    const p1 = row1 ? (row1[s] + alpha) / (t1 + alpha * K) : 0;
    let p = l2 * p2 + l1 * p1 + (1 - l2 - l1) * globalP(s);
    if (s === last && streak >= 2) p *= 1 + Math.min(0.3, streak * 0.05);
    return { intent: s, probability: p };
  });
  const sum = probs.reduce((a, b) => a + b.probability, 0);
  probs.forEach(p => { p.probability = Number((p.probability / sum).toFixed(4)); });
  probs.sort((a, b) => b.probability - a.probability);
  const N = Math.min(Math.max(1, Number(top) || 3), INTENT_LIST.length);
  const lastSub = recent.length ? subIntentOf(recent[recent.length - 1]) : null;
  const predictions = probs.slice(0, N).map(p => ({ ...p, prefetchGroups: INTENT_GROUPS[p.intent] || [] }));
  const ent = -probs.reduce((a, p) => a + (p.probability > 0 ? p.probability * Math.log2(p.probability) : 0), 0);
  return {
    observed: n, lastIntent: last, lastAction: lastSub, streak,
    basis: n === 0 ? '기록 없음: 균등 분포' : t2 ? `직전 2개 의도(${last2}) 뒤의 전이 ${Math.round(t2)}회 기반 + 1차 전이·전체 빈도 혼합` : t1 ? `마지막 의도(${last}) 뒤의 전이 ${Math.round(t1)}회 기반` : '전체 빈도(최근 가중) 기반',
    predictions,
    certainty: ent < 1.2 ? 'high' : ent < 2.0 ? 'medium' : 'low',
    note: '통계적 추정이며 실제 요청과 다를 수 있습니다. 최근 요청에 더 큰 가중치를 둡니다. prefetchGroups 는 미리 준비해 둘 도구 그룹입니다'
  };
};

// 요청 내용에서 읽어낸 신호에 따른 맞춤 후속 질문
function contextual(text, c) {
  const out = [];
  const lang = languageOf(text);
  if (c.intent === 'coding' || c.intent === 'game') {
    if (/Traceback|Error|is not defined|오류|에러/i.test(text)) out.push(['같은 오류가 다시 나지 않게 원인과 예방법을 알려줘', 0.5], ['오류가 난 부분만 최소한으로 고친 diff 를 보여줘', 0.45]);
    if (c.subIntent === 'create') out.push(['실행 방법과 폴더 구조를 알려줘', 0.4], ['기능을 하나 더 추가해줘', 0.35], ['예외 처리와 입력 검증을 넣어줘', 0.3]);
    if (c.subIntent === 'fix') out.push(['정의되지 않은 함수·변수가 더 있는지 전체 점검해줘', 0.45], ['수정한 코드에 테스트를 추가해줘', 0.4]);
    if (lang === 'python') out.push(['타입 힌트와 docstring 을 추가해줘', 0.3], ['파이썬 가상환경과 requirements.txt 를 만들어줘', 0.25]);
    if (lang === 'html' || c.intent === 'game') out.push(['모바일 터치 조작도 지원해줘', 0.3], ['효과음과 점수 저장(localStorage)을 추가해줘', 0.25]);
    if (lang === 'js') out.push(['async/await 오류 처리를 점검해줘', 0.25]);
    if (/api|서버|express|엔드포인트/i.test(text)) out.push(['인증과 입력 검증을 추가해줘', 0.35], ['API 사용 예시(curl)를 보여줘', 0.3]);
  }
  if (c.intent === 'math') {
    if (c.subIntent === 'solve') out.push(['답을 다른 방법으로 검산해줘', 0.5], ['풀이 과정을 단계별로 설명해줘', 0.45]);
    if (/증명|prove|나누어|정수/.test(text)) out.push(['반례가 없는지 작은 수로 확인해줘', 0.4], ['증명의 핵심 아이디어를 한 줄로 요약해줘', 0.3]);
    if (/미분|적분|극한|derivative|integral/i.test(text)) out.push(['그래프 개형과 극값을 알려줘', 0.35], ['수치적분/미분으로 결과를 확인해줘', 0.35]);
    if (/확률|통계|평균|분산/.test(text)) out.push(['신뢰구간이나 분포 그래프도 보여줘', 0.3]);
  }
  if (c.intent === 'data') out.push(['결과를 차트로 시각화해줘', 0.35], ['이상치를 제외하고 다시 계산해줘', 0.3]);
  if (c.subIntent === 'explain') out.push(['더 쉬운 비유로 다시 설명해줘', 0.35], ['예제 코드나 예시 문제를 보여줘', 0.35]);
  return out;
}

IMPL.predict_followups = ({ text, top = 5 }) => {
  if (typeof text !== 'string' || !text.trim()) throw new Error('text 는 비어 있지 않은 문자열이어야 합니다');
  const c = classify(text);
  const tokens = new Set(text.toLowerCase().split(/[^a-z0-9가-힣]+/).filter(t => t.length >= 2));
  const cands = new Map();
  const put = (question, intent, score) => { const prev = cands.get(question); if (!prev || prev.score < score) cands.set(question, { question, intent, score: Number(score.toFixed(3)) }); };
  for (const [q, sc] of contextual(text, c)) put(q, c.intent, 0.4 + sc);
  const intents = [c.intent, ...c.secondary];
  for (const [intent, list] of Object.entries(FOLLOW)) {
    const base = intent === c.intent ? Math.max(0.3, c.confidence) : intents.includes(intent) ? 0.2 : 0.05;
    for (const q of list) {
      const qt = q.toLowerCase().split(/[^a-z0-9가-힣]+/).filter(t => t.length >= 2);
      const overlap = qt.filter(t => tokens.has(t)).length;
      // 이미 요청에 들어 있는 내용을 다시 묻는 후속은 점수를 낮춘다
      const dup = overlap >= 3 ? 0.15 : 0;
      put(q, intent, base + 0.04 * Math.min(overlap, 2) - dup);
    }
  }
  const N = Math.min(Math.max(1, Number(top) || 5), 10);
  const ranked = [...cands.values()].sort((a, b) => b.score - a.score).slice(0, N);
  const z = ranked.reduce((a, r) => a + Math.exp(r.score * 4), 0);
  ranked.forEach(r => { r.probability = Number((Math.exp(r.score * 4) / z).toFixed(3)); });
  return { currentIntent: c.intent, action: c.subIntent, language: languageOf(text), followups: ranked, note: '요청 내용(오류·언어·행동)을 반영한 후보입니다. probability 는 후보 간 상대 확률입니다' };
};

// 사용자가 말하지 않았지만 필요할 가능성이 큰 것, 비어 있는 정보, 권장 도구 순서
IMPL.predict_user_need = ({ text, history = [] }) => {
  if (typeof text !== 'string' || !text.trim()) throw new Error('text 는 비어 있지 않은 문자열이어야 합니다');
  const c = classify(text);
  const lang = languageOf(text);
  const hasCode = /```|<script|function\s*\(|def\s+\w+\(|=>|class\s+\w+/.test(text);
  const needs = [], missing = [], plan = [];
  const wants = [];
  if (c.intent === 'coding' || c.intent === 'game' || c.intent === 'security') {
    if (c.subIntent === 'fix') {
      if (!hasCode) missing.push('오류가 나는 코드 전체');
      if (!/Error|Traceback|오류|에러|not defined/i.test(text)) missing.push('정확한 오류 메시지/줄 번호');
      plan.push('analyze_code (문법·미정의 이름 탐색)', 'autofix_code (확실한 오타 자동 수정)', '수정 후 analyze_code 재실행');
      wants.push('원인 설명', '수정된 전체 코드');
    } else if (c.subIntent === 'create') {
      if (!lang) missing.push('사용할 언어/환경');
      plan.push('ws_write_file 로 파일 생성', 'analyze_code / analyze_html_page 로 검사', 'vserver_deploy → vserver_check_page', 'check_project_files (여러 파일일 때)');
      wants.push('실행 방법', '파일 구조');
    } else if (c.subIntent === 'optimize') {
      plan.push('review_code (복잡도 확인)', 'estimate_loop_depth', '개선 전후 비교');
      wants.push('시간·공간 복잡도 비교');
    } else if (c.subIntent === 'review' || c.intent === 'security') {
      plan.push('analyze_code', 'security_scan', 'find_async_pitfalls');
      wants.push('우선순위별 문제 목록', '수정 예시');
    } else plan.push('analyze_code');
    if (!hasCode && c.subIntent !== 'create') needs.push('코드 본문이 없으면 가정을 명시하고 답하거나 한 가지만 되물을 것');
  } else if (c.intent === 'math') {
    plan.push('exact_eval 또는 eval_expr 로 계산 검산', 'check_identity / verify_root 로 결과 검증');
    if (/증명|prove/.test(text)) plan.push('divisibility_search 로 반례 탐색');
    wants.push('최종 답과 검산 결과');
  } else if (c.intent === 'data') {
    plan.push('데이터셋 도구로 요약 통계 → 이상치/결측 확인'); if (!/csv|dataset|데이터셋|첨부/i.test(text)) missing.push('데이터(파일 또는 붙여넣기)');
  }
  const prior = Array.isArray(history) ? history.slice(-8).map(h => classify(String(h)).intent) : [];
  const drift = prior.length >= 3 && prior.every(i => i === c.intent);
  if (drift) needs.push(`최근 ${prior.length}번 연속 ${c.intent} 작업: 이전 맥락(파일·변수 이름)을 이어서 답할 것`);
  return {
    intent: c.intent, secondary: c.secondary, action: c.subIntent, language: lang, confidence: c.confidence, ambiguity: c.margin < 0.25 ? 'high' : c.margin < 0.5 ? 'medium' : 'low',
    likelyWants: wants, missingInfo: missing, recommendedToolPlan: plan, notes: needs,
    clarify: missing.length && c.margin < 0.5 ? `한 가지만 되묻기: ${missing[0]}` : null
  };
};

const DECL = [
  { name: 'intent_classify', description: '사용자 요청의 의도(수학, 코딩, 데이터, 빅데이터, GitHub, 게임, 글쓰기, 보안, 사실 질문, 기타)를 분류하고 미리 준비할 도구 그룹을 알려준다.',
    parameters: OBJ({ text: S('STRING', '분류할 사용자 요청') }, ['text']) },
  { name: 'predict_next_request', description: '지난 요청들의 의도 순서로 다음 요청의 의도 확률을 추정한다. 미리 준비할 도구 그룹을 제안.',
    parameters: OBJ({ history: STR_LIST('지난 사용자 요청들 (오래된 순)'), top: S('INTEGER', '상위 개수 (1~10)') }, ['history']) },
  { name: 'predict_user_need', description: '사용자 요청에서 의도·행동(수정/생성/설명/최적화…)·언어를 읽고, 말하지 않았지만 필요할 가능성이 큰 것, 빠진 정보, 권장 도구 실행 순서를 예측한다.',
    parameters: OBJ({ text: S('STRING', '현재 사용자 요청'), history: STR_LIST('지난 요청들 (선택)') }, ['text']) },
  { name: 'predict_followups', description: '현재 요청 다음에 나올 가능성이 높은 후속 요청 후보를 확률과 함께 보여준다 (오류·언어·행동 맥락 반영).',
    parameters: OBJ({ text: S('STRING', '현재 사용자 요청'), top: S('INTEGER', '후보 개수 (1~10)') }, ['text']) }
];

module.exports = { DECL, IMPL, classify, groupsFor, INTENT_GROUPS, subIntentOf, languageOf };
