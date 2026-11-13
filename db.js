/**
 * db.js — 저장소 계층. MONGODB_URI 가 있으면 MongoDB, 없으면 기존처럼 data/ JSON 파일.
 * 저장 대상: API 키(config), 사용자(users), 세션(sessions), 사용량(usage), 채팅방(rooms)
 */
'use strict';
const fs = require('fs'), path = require('path');

const rdJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const wrJson = (f, o) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o), { mode: 0o600 }); fs.renameSync(t, f); };
const EMPTY_ROOM = () => ({ rev: 0, rooms: [], tomb: {} });
const SINGLE = new Set(['cfg', 'usage']);           // 문서 1개짜리(_id:'main')
const NAME = { cfg: 'config', users: 'users', sessions: 'sessions', usage: 'usage' };

// ---------- 파일 백엔드 (기존 방식) ----------
function fileBackend(dataDir) {
  const F = { cfg: 'config.json', users: 'users.json', sessions: 'sessions.json', usage: 'usage.json' };
  const P = k => path.join(dataDir, F[k]);
  const roomsDir = path.join(dataDir, 'rooms');
  return {
    kind: 'file',
    async load() {
      return { cfg: rdJson(P('cfg'), {}), users: rdJson(P('users'), {}), sess: rdJson(P('sessions'), {}), usage: rdJson(P('usage'), { day: '', n: {} }) };
    },
    save(col, obj) { wrJson(P(col), obj); },
    async getRoom(u) { return rdJson(path.join(roomsDir, u + '.json'), EMPTY_ROOM()); },
    async setRoom(u, d) { wrJson(path.join(roomsDir, u + '.json'), d); },
    async allRooms() {
      try { return fs.readdirSync(roomsDir).filter(f => f.endsWith('.json')).map(f => [f.slice(0, -5), rdJson(path.join(roomsDir, f), null)]).filter(x => x[1]); } catch { return []; }
    },
    async flushAll() {}, async close() {}
  };
}

// ---------- MongoDB 백엔드 ----------
async function mongoBackend(uri, dbName) {
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  const d = client.db(dbName);
  const C = { cfg: d.collection('config'), users: d.collection('users'), sessions: d.collection('sessions'), usage: d.collection('usage'), rooms: d.collection('rooms') };
  await C.sessions.createIndex({ expAt: 1 }, { expireAfterSeconds: 0 });   // 만료 세션 자동 삭제

  // Mongo 필드명에 '.' 가 들어가면 곤란하므로 usage.n 은 [키,값] 배열로 저장
  const enc = {
    usage: v => ({ day: v.day, entries: Object.entries(v.n || {}) }),
    sessions: v => ({ ...v, expAt: new Date(v.exp) })
  };
  const dec = {
    usage: doc => ({ day: doc.day || '', n: Object.fromEntries(doc.entries || []) }),
    sessions: doc => { const { expAt, ...r } = doc; return r; }
  };
  const strip = doc => { const { _id, ...r } = doc; return r; };
  const encode = (col, v) => (enc[col] ? enc[col](v) : v);
  const decode = (col, doc) => (dec[col] ? dec[col](strip(doc)) : strip(doc));

  const snaps = { cfg: new Map(), users: new Map(), sessions: new Map(), usage: new Map() };
  const pending = {}, chain = {};
  const INTERVAL = Math.max(200, Number(process.env.SAVE_INTERVAL_MS) || 1000);   // 저장 주기(기본 1초)

  async function flush(col) {
    const map = pending[col]; if (!map) return;
    const cur = new Map(), ops = [];
    for (const [k, v] of Object.entries(map)) {
      const j = JSON.stringify(v); cur.set(k, j);
      if (snaps[col].get(k) !== j) ops.push({ replaceOne: { filter: { _id: k }, replacement: encode(col, v), upsert: true } });
    }
    for (const k of snaps[col].keys()) if (!cur.has(k)) ops.push({ deleteOne: { filter: { _id: k } } });
    if (ops.length) await C[col].bulkWrite(ops, { ordered: false });
    snaps[col] = cur;                                   // 성공했을 때만 갱신 → 실패하면 다음 flush 에서 재시도
  }
  const run = col => (chain[col] = (chain[col] || Promise.resolve()).then(() => flush(col)).catch(e => console.error('[mongo] 저장 실패', col, e.message)));

  const api = {
    kind: 'mongo',
    async load() {
      const out = { cfg: {}, users: {}, sess: {}, usage: { day: '', n: {} } };
      const c = await C.cfg.findOne({ _id: 'main' }); if (c) out.cfg = decode('cfg', c);
      const u = await C.usage.findOne({ _id: 'main' }); if (u) out.usage = decode('usage', u);
      for await (const doc of C.users.find({})) out.users[doc._id] = decode('users', doc);
      for await (const doc of C.sessions.find({ expAt: { $gt: new Date() } })) out.sess[doc._id] = decode('sessions', doc);
      snaps.cfg = new Map(c ? [['main', JSON.stringify(out.cfg)]] : []);
      snaps.usage = new Map(u ? [['main', JSON.stringify(out.usage)]] : []);
      snaps.users = new Map(Object.entries(out.users).map(([k, v]) => [k, JSON.stringify(v)]));
      snaps.sessions = new Map(Object.entries(out.sess).map(([k, v]) => [k, JSON.stringify(v)]));
      return out;
    },
    save(col, obj) { pending[col] = SINGLE.has(col) ? { main: obj } : obj; },   // 실제 저장은 아래 1초 타이머가 변경분만 upsert
    async getRoom(u) { const doc = await C.rooms.findOne({ _id: u }); return doc ? strip(doc) : EMPTY_ROOM(); },
    async setRoom(u, dd) { await C.rooms.replaceOne({ _id: u }, dd, { upsert: true }); },   // 문서 1개 = 한 사용자의 채팅방 전체 (16MB 한도)
    async flushAll() { for (const col of Object.keys(snaps)) await run(col); },
    async close() { clearInterval(iv); await api.flushAll(); await client.close(); }
  };
  const iv = setInterval(() => { for (const col of Object.keys(snaps)) if (pending[col]) run(col); }, INTERVAL);   // 1초마다 변경분 저장
  return api;
}

// ---------- 초기화 (+ 기존 data/ 파일이 있고 Mongo 가 비어 있으면 1회 이전) ----------
async function init({ uri, dbName, dataDir }) {
  const file = fileBackend(dataDir);
  if (!uri) { console.log('[db] MONGODB_URI 없음 → 로컬 JSON 파일 사용:', dataDir); file.data = await file.load(); return file; }
  const mongo = await mongoBackend(uri, dbName);
  mongo.data = await mongo.load();
  const empty = !Object.keys(mongo.data.users).length && !mongo.data.cfg.apiKey;
  if (empty) {
    const old = await file.load();
    if (Object.keys(old.users).length || old.cfg.apiKey) {
      mongo.data = old;
      for (const [col, obj] of [['cfg', old.cfg], ['users', old.users], ['sessions', old.sess], ['usage', old.usage]]) mongo.save(col, obj);
      for (const [u, d] of await file.allRooms()) await mongo.setRoom(u, d);
      await mongo.flushAll();
      console.log('[db] 기존 data/ 파일 → MongoDB 이전 완료 (사용자 %d명)', Object.keys(old.users).length);
    }
  }
  console.log('[db] MongoDB 연결됨 (db: %s)', dbName);
  return mongo;
}

module.exports = { init };
