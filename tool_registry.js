const gemini = require('./gemini');
'use strict';
// 추론 도구 등록소: 그룹별 선언, 데이터셋 ID 해석, 인자 검증, 비동기 실행, Gemini 함수 호출 루프
const core = require('./reasoning_tools');
const data = require('./data');
const bigdata = require('./bigdata');
const coding = require('./coding');
const codingPlus = require('./coding_plus');
const codingAnalyzer = require('./coding_analyzer');
const luauTools = require('./luau_tools');
const mathPlus = require('./math_plus');
const mathProof = require('./math_proof');
const external = require('./external');
const sandbox = require('./sandbox');
const predict = require('./predict');
const workspaceTools = require('./workspace_tools');
const store = require('./store');
const vserver = require('./vserver');

const GROUPS = {
  math:     { decl: [...core.DECL.math, ...mathPlus.DECL, ...mathProof.DECL],         impl: { ...core.MATH, ...mathPlus.IMPL, ...mathProof.IMPL } },
  coding:   { decl: [...core.DECL.coding, ...coding.DECL, ...codingPlus.DECL, ...codingAnalyzer.DECL, ...luauTools.DECL], impl: { ...core.CODING, ...coding.IMPL, ...codingPlus.IMPL, ...codingAnalyzer.IMPL, ...luauTools.IMPL } },
  data:     { decl: data.DECL,     impl: data.IMPL },
  bigdata:  { decl: bigdata.DECL,  impl: bigdata.IMPL },
  external: { decl: external.DECL, impl: external.IMPL },
  sandbox:  { decl: sandbox.DECL,  impl: sandbox.IMPL },
  predict:  { decl: predict.DECL,  impl: predict.IMPL },
  workspace: { decl: workspaceTools.DECL, impl: workspaceTools.IMPL },
  vserver:  { decl: vserver.DECL,  impl: vserver.IMPL }
};

// csv 입력 인자는 업로드된 데이터셋 ID로도 받을 수 있게 한다 (10MB 데이터는 채팅 본문으로 보내지 않는다)
const DS_PARAM = { csv: 'dataset_id', left_csv: 'left_dataset_id', right_csv: 'right_dataset_id' };
const DS_DESC = {
  dataset_id: '업로드된 데이터셋 ID (csv 대신 사용, 최대 10MB)',
  left_dataset_id: '왼쪽 데이터셋 ID (left_csv 대신 사용)',
  right_dataset_id: '오른쪽 데이터셋 ID (right_csv 대신 사용)'
};

const ALL = {};
for (const [group, g] of Object.entries(GROUPS)) {
  for (const d of g.decl) {
    if (typeof g.impl[d.name] !== 'function') throw new Error(`구현 누락: ${d.name}`);
    if (ALL[d.name]) throw new Error(`도구 이름 중복: ${d.name}`);
    const originalRequired = [...(d.parameters.required || [])];
    const props = { ...d.parameters.properties };
    for (const [csvKey, idKey] of Object.entries(DS_PARAM)) {
      if (props[csvKey]) props[idKey] = { type: 'STRING', description: DS_DESC[idKey] };
    }
    const decl = { ...d, parameters: { ...d.parameters, properties: props, required: originalRequired.filter(k => !DS_PARAM[k]) } };
    ALL[d.name] = { decl, impl: g.impl[d.name], group, originalRequired };
  }
}

const namesOf = groups => {
  const list = Array.isArray(groups) ? groups : [groups];
  if (list.includes('all')) return Object.keys(ALL);
  return Object.keys(ALL).filter(n => list.includes(ALL[n].group));
};

const TYPE_OK = (v, t) => {
  switch (t) {
    case 'NUMBER': return typeof v === 'number' || (typeof v === 'string' && v.trim() !== '');
    case 'INTEGER': return typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)));
    case 'STRING': return typeof v === 'string' || typeof v === 'number';
    case 'BOOLEAN': return typeof v === 'boolean';
    case 'ARRAY': return Array.isArray(v);
    case 'OBJECT': return typeof v === 'object' && v !== null && !Array.isArray(v);
    default: return true;
  }
};

const withTimeout = (p, ms) => {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('도구 실행 시간 초과')), ms); })]).finally(() => clearTimeout(t));
};

// 데이터셋 ID → 실제 텍스트 (소유자가 아니면 찾을 수 없음으로 처리)
function resolveDatasets(a, t, owner) {
  const out = { ...a };
  for (const [csvKey, idKey] of Object.entries(DS_PARAM)) {
    if (!t.decl.parameters.properties[csvKey] || out[csvKey] !== undefined || out[idKey] === undefined) continue;
    const text = store.get(owner || '', String(out[idKey]));
    if (text === null) throw new Error(`데이터셋을 찾을 수 없습니다: ${out[idKey]}`);
    out[csvKey] = text;
    delete out[idKey];
  }
  return out;
}

function declarationsFor(groups) {
  return [{ functionDeclarations: namesOf(groups).map(n => ALL[n].decl) }];
}

async function execute(name, args, { allowed, ctx = {} } = {}) {
  const t = ALL[name];
  if (!t) return { error: `알 수 없는 도구: ${name}` };
  if (allowed && !allowed.includes(name)) return { error: `이 요청에서 허용되지 않은 도구: ${name}` };
  const raw = args && typeof args === 'object' ? args : {};
  const p = t.decl.parameters;
  try {
    const a = resolveDatasets(raw, t, ctx.owner);
    for (const k of t.originalRequired) {
      if (a[k] === undefined || a[k] === null) {
        const idKey = DS_PARAM[k];
        if (idKey && p.properties[idKey]) return { error: `${k} 또는 ${idKey} 가 필요합니다` };
        return { error: `필수 인자 누락: ${k}` };
      }
    }
    for (const [k, spec] of Object.entries(p.properties)) {
      if (a[k] === undefined) continue;
      if (!TYPE_OK(a[k], spec.type)) return { error: `${k} 타입 오류 (${spec.type} 이어야 함)` };
      if (spec.enum && !spec.enum.includes(a[k])) return { error: `${k} 는 ${spec.enum.join(', ')} 중 하나여야 합니다` };
    }
    const out = await withTimeout(Promise.resolve().then(() => t.impl(a, ctx)), 30_000);
    const json = JSON.stringify(out ?? {});
    if (json.length > 9000) return { truncated: true, preview: json.slice(0, 8000) };
    return JSON.parse(json);
  } catch (e) {
    return { error: e.message };
  }
}

// 흐름: 모델 호출 → functionCall 이면 실행 → functionResponse 를 붙여 재호출 → 텍스트만 오면 종료
// 모델 응답 파트(thoughtSignature 포함)를 그대로 되돌려 사고 연속성을 유지한다.
// mode: 'AUTO'(기본) | 'ANY'(첫 턴만 강제) | 'NONE'
async function runToolLoop({ base, key, model, contents, system, groups = ['math'], mode = 'AUTO', allowed, maxRounds = 6, temperature = 0.2, signal, owner, userConfirmedWrite = false }) {
  const convo = contents.map(c => ({ ...c, parts: [...c.parts] }));
  const trace = [];
  const names = namesOf(groups).filter(n => !allowed || allowed.includes(n));
  const ctx = { base, key, model, owner, userConfirmedWrite };
  for (let round = 0; round < maxRounds; round++) {
    const useMode = round === 0 ? mode : (mode === 'ANY' ? 'AUTO' : mode);
    const body = await gemini.generateContent({
      base, key, model, signal,
      body: {
        contents: convo,
        systemInstruction: { parts: [{ text: system }] },
        tools: declarationsFor(groups),
        toolConfig: { functionCallingConfig: { mode: useMode, ...(useMode === 'ANY' ? { allowedFunctionNames: names } : {}) } },
        generationConfig: { temperature }
      }
    });
    const parts = body.candidates?.[0]?.content?.parts || [];
    if (!parts.length && body.promptFeedback) {
      throw new Error('모델이 응답을 거부했습니다: ' + JSON.stringify(body.promptFeedback).slice(0, 200));
    }
    const calls = parts.filter(p => p.functionCall);
    if (!calls.length) {
      const text = parts.filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join('').trim();
      return { text, trace };
    }
    convo.push({ role: 'model', parts });
    const responses = [];
    for (const p of calls) {
      const { name, args } = p.functionCall;
      const result = await execute(name, args, { allowed: names, ctx });
      trace.push({ name, ok: !result.error });
      responses.push({ functionResponse: { name, response: result } });
    }
    convo.push({ role: 'user', parts: responses });
  }
  return { text: '', trace, note: '도구 호출 횟수 한도에 도달했습니다' };
}

module.exports = {
  declarationsFor, execute, runToolLoop,
  classify: predict.classify, groupsFor: predict.groupsFor,
  groups: Object.keys(GROUPS), toolNames: Object.keys(ALL), store
};
