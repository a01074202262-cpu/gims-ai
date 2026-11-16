'use strict';
/**
 * gemini.js — Gemini API 호출 공통 계층
 *  - 요청 간격 제한 (무료 티어 분당 한도 보호)
 *  - 429 시 Retry-After / 메시지 파싱 후 재시도
 *  - 사용자에게 긴 영문 쿼터 메시지 대신 짧은 한국어 안내
 */
const MIN_GAP_MS = Math.max(0, Number(process.env.GEMINI_MIN_GAP_MS) || 4500); // 기본 ~13회/분
const MAX_RETRY = Math.max(1, Number(process.env.GEMINI_MAX_RETRY) || 5);

let lastAt = 0;
let chain = Promise.resolve();

const sleep = (ms, signal) => new Promise((ok, no) => {
  if (signal?.aborted) return no(Object.assign(new Error('aborted'), { aborted: true }));
  const t = setTimeout(ok, ms);
  const onAbort = () => { clearTimeout(t); no(Object.assign(new Error('aborted'), { aborted: true })); };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
});

async function waitGap(signal) {
  const wait = Math.max(0, lastAt + MIN_GAP_MS - Date.now());
  if (wait > 0) await sleep(wait, signal);
  lastAt = Date.now();
}

function parseRetryMs(text, headers) {
  const ra = headers?.get?.('retry-after');
  if (ra) {
    const n = Number(ra);
    if (Number.isFinite(n)) return Math.ceil(n * 1000);
    const d = Date.parse(ra);
    if (Number.isFinite(d)) return Math.max(0, d - Date.now());
  }
  const m = /retry in\s*([\d.]+)\s*s/i.exec(text || '');
  if (m) return Math.ceil(Number(m[1]) * 1000) + 200;
  const m2 = /Please retry in\s*([\d.]+)\s*s/i.exec(text || '');
  if (m2) return Math.ceil(Number(m2[1]) * 1000) + 200;
  return null;
}

function friendlyQuota(text, retryMs) {
  const sec = retryMs ? Math.max(1, Math.ceil(retryMs / 1000)) : null;
  if (sec) return `요청이 너무 많아요. 약 ${sec} 초뒤에 다시 시도해주세요`;
  return '요청이 너무 많아요. 잠시 뒤에 다시 시도해주세요';
}

function friendlyHttp(status, text) {
  const t = String(text || '');
  if (status === 429 || /quota|rate.?limit|exceeded your current quota/i.test(t)) {
    return friendlyQuota(t, parseRetryMs(t, null));
  }
  if (status === 400 && /API key|invalid/i.test(t)) return 'API 키가 올바르지 않거나 권한이 없습니다.';
  if (status === 403) return 'API 접근이 거부되었습니다. 키·결제·모델 권한을 확인해 주세요.';
  if (status === 404) return '요청한 모델을 찾을 수 없습니다. 다른 모델을 선택해 보세요.';
  if (status >= 500) return 'Gemini 서버 오류입니다. 잠시 후 다시 시도해 주세요.';
  // 긴 영문 본문 잘라 짧은 안내
  const short = t.replace(/\s+/g, ' ').trim().slice(0, 120);
  return short || `Gemini 오류 (${status})`;
}

function enqueue(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {});
  return run;
}

/**
 * generateContent 1회 (재시도·간격 포함). 성공 시 Response 가 아니라 JSON.
 */
async function generateContent({ base, key, model, body, signal }) {
  return enqueue(async () => {
    let lastText = '', lastStatus = 0, lastHeaders = null;
    for (let i = 0; i < MAX_RETRY; i++) {
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { aborted: true });
      await waitGap(signal);
      let r;
      try {
        r = await fetch(`${base}/v1beta/models/${model}:generateContent`, {
          method: 'POST',
          signal,
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify(body)
        });
      } catch (e) {
        if (e.name === 'AbortError' || signal?.aborted) throw Object.assign(new Error('aborted'), { aborted: true });
        if (i < MAX_RETRY - 1) { await sleep(500 * (i + 1), signal); continue; }
        throw Object.assign(new Error('Gemini에 연결하지 못했습니다.'), { status: 0 });
      }
      if (r.ok) return r.json();
      lastStatus = r.status;
      lastHeaders = r.headers;
      lastText = await r.text().catch(() => '');
      if (r.status === 429 || r.status >= 500) {
        const wait = parseRetryMs(lastText, r.headers) || (1000 * Math.pow(2, i) + Math.random() * 400);
        if (i < MAX_RETRY - 1) {
          await sleep(Math.min(wait, 30000), signal);
          continue;
        }
      }
      break;
    }
    const msg = friendlyHttp(lastStatus, lastText);
    const err = new Error(msg);
    err.status = lastStatus;
    err.body = lastText;
    err.friendly = true;
    throw err;
  });
}

/**
 * streamGenerateContent — 스트림 Response 반환 (본문은 호출측에서 pipe)
 */
async function streamGenerateContent({ base, key, model, body, signal }) {
  return enqueue(async () => {
    let lastText = '', lastStatus = 0;
    for (let i = 0; i < MAX_RETRY; i++) {
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { aborted: true });
      await waitGap(signal);
      let r;
      try {
        r = await fetch(`${base}/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
          method: 'POST',
          signal,
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify(body)
        });
      } catch (e) {
        if (e.name === 'AbortError' || signal?.aborted) throw Object.assign(new Error('aborted'), { aborted: true });
        if (i < MAX_RETRY - 1) { await sleep(500 * (i + 1), signal); continue; }
        throw Object.assign(new Error('Gemini에 연결하지 못했습니다.'), { status: 0 });
      }
      if (r.ok) return r;
      lastStatus = r.status;
      lastText = await r.text().catch(() => '');
      if (r.status === 429 || r.status >= 500) {
        const wait = parseRetryMs(lastText, r.headers) || (1000 * Math.pow(2, i));
        if (i < MAX_RETRY - 1) {
          await sleep(Math.min(wait, 30000), signal);
          continue;
        }
      }
      break;
    }
    const msg = friendlyHttp(lastStatus, lastText);
    const err = new Error(msg);
    err.status = lastStatus;
    err.body = lastText;
    err.friendly = true;
    throw err;
  });
}

module.exports = {
  generateContent,
  streamGenerateContent,
  friendlyHttp,
  MIN_GAP_MS,
  MAX_RETRY
};
