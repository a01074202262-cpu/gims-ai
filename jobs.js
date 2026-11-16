'use strict';
/**
 * jobs.js — 백그라운드 채팅 작업 레지스트리
 *
 * 채팅 요청은 브라우저 연결과 분리된 "작업(job)"으로 실행된다.
 *  - 창을 닫거나 탭이 절전돼도 서버는 답변 생성을 끝까지 수행한다 (명시적 취소만 중단)
 *  - 진행 단계(steps)와 지금까지의 답변(answer)을 메모리에 기록 → 다시 접속하면 GET /api/chat/job 으로 이어받는다
 *  - 완료 시 server.js 가 채팅방에 답변을 저장한다 (persistJob)
 */
const TTL_MS = 30 * 60 * 1000;      // 끝난 작업은 30분 뒤 삭제
const MAX_PER_USER = 20;

const jobs = new Map();             // id -> Job

class Job {
  constructor({ id, user, roomId, userText }) {
    this.id = id; this.user = user; this.roomId = roomId || ''; this.userText = userText || '';
    this.status = 'running';        // running | done | error | cancelled
    this.answer = ''; this.error = ''; this.used = undefined;
    this.steps = new Map();
    this.ac = new AbortController();
    this.startedAt = Date.now(); this.updatedAt = this.startedAt;
    this._buf = '';
  }
  // 클라이언트로 보내는 SSE payload(JSON 객체)와 같은 형식을 기록한다
  record(o) {
    this.updatedAt = Date.now();
    if (o?.gims) {
      if (o.gims.used !== undefined) this.used = o.gims.used;
      if (o.gims.id) this.steps.set(o.gims.id, { ...(this.steps.get(o.gims.id) || {}), ...o.gims });
    } else if (o?.error) {
      this.error = String(o.error.message || '응답 오류');
    } else if (o?.candidates) {
      this.answer += o.candidates.flatMap(c => c.content?.parts || []).map(p => (typeof p.text === 'string' ? p.text : '')).join('');
    }
  }
  // Gemini SSE 원문 조각을 받아 줄 단위로 파싱해 record 한다
  feed(chunk) {
    this._buf += chunk;
    const lines = this._buf.split(/\r?\n/);
    this._buf = lines.pop() || '';
    for (const line of lines) this._line(line);
  }
  flush() { if (this._buf) { this._line(this._buf); this._buf = ''; } }
  _line(line) {
    if (!line.startsWith('data:')) return;
    const p = line.slice(5).trim();
    if (!p || p === '[DONE]') return;
    try { this.record(JSON.parse(p)); } catch {}
  }
  finish(status, err) {
    if (this.status !== 'running') return;
    this.flush();
    this.status = status; this.updatedAt = Date.now();
    if (err) this.error = String(err);
  }
  snapshot() {
    return {
      id: this.id, roomId: this.roomId, status: this.status, answer: this.answer, error: this.error,
      used: this.used, startedAt: this.startedAt, steps: [...this.steps.values()]
    };
  }
}

function create(opts) {
  // 같은 id 가 있으면(재전송) 새로 만들지 않고 거부한다 → 호출측이 중복 실행을 막는다
  if (jobs.has(opts.id)) return null;
  const mine = [...jobs.values()].filter(j => j.user === opts.user).sort((a, b) => a.startedAt - b.startedAt);
  while (mine.length >= MAX_PER_USER) { const old = mine.shift(); if (old.status === 'running') old.ac.abort(); jobs.delete(old.id); }
  const j = new Job(opts); jobs.set(j.id, j); return j;
}
const get = (user, id) => { const j = jobs.get(id); return j && j.user === user ? j : null; };
// 사용자의 가장 최근 진행 중 작업
const active = user => [...jobs.values()].filter(j => j.user === user && j.status === 'running').sort((a, b) => b.startedAt - a.startedAt)[0] || null;

setInterval(() => {
  const now = Date.now();
  for (const [id, j] of jobs) if (j.status !== 'running' && now - j.updatedAt > TTL_MS) jobs.delete(id);
}, 60_000).unref();

module.exports = { create, get, active };
