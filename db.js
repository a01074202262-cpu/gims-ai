/**
 * db.js — 저장소 계층. DB 또는 MONGODB_URI 가 있으면 MongoDB, 없으면 data/ JSON.
 * 저장 대상: API 키(config), 사용자(users), 세션(sessions), 사용량(usage), 채팅방(rooms), 추론 로그
 *
 * Mongo 저장 원칙:
 *  - save() 시점의 스냅샷을 깊은 복사로 pending 에 넣고 dirty 표시
 *  - 짧은 디바운스(기본 200ms) + 최대 1초 주기로 flush
 *  - flush 중 다시 dirty 되면 연속 flush
 *  - 채팅방(rooms)은 요청 즉시 Mongo 에 기록
 */
'use strict';
const fs = require('fs'), path = require('path');

const rdJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const wrJson = (f, o) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const t = f + '.tmp';
  fs.writeFileSync(t, JSON.stringify(o), { mode: 0o600 });
  fs.renameSync(t, f);
};
const EMPTY_ROOM = () => ({ rev: 0, rooms: [], tomb: {} });

// 모든 Mongo 작업에 시간 제한을 둔다. 죽은 연결(클라우드의 유휴 연결 종료 등)에서 무기한 대기하면
// 컬렉션별 저장 큐 전체가 멈춰서 "몇 분 전 데이터까지만 저장"되는 증상이 된다.
const OP_TIMEOUT = Math.max(2000, Number(process.env.MONGO_OP_TIMEOUT_MS) || 15000);
const withTimeout = (p, label, ms = OP_TIMEOUT) => {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} ${ms}ms 시간 초과`)), ms); })]).finally(() => clearTimeout(t));
};
// 키별 직렬 실행 (같은 사용자의 채팅방 읽기→수정→쓰기가 겹쳐 서로 덮어쓰지 않게)
const locks = new Map();
function withLock(key, fn) {
  const run = (locks.get(key) || Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}
const SINGLE = new Set(['cfg', 'usage']);
const clone = o => {
  try { return JSON.parse(JSON.stringify(o)); } catch (e) {
    console.error('[db] clone 실패', e.message);
    return o;
  }
};

// ---------- 파일 백엔드 ----------
function fileBackend(dataDir) {
  const F = { cfg: 'config.json', users: 'users.json', sessions: 'sessions.json', usage: 'usage.json' };
  const P = k => path.join(dataDir, F[k]);
  const roomsDir = path.join(dataDir, 'rooms');
  try { fs.mkdirSync(roomsDir, { recursive: true }); } catch {}
  return {
    kind: 'file',
    async load() {
      return {
        cfg: rdJson(P('cfg'), {}),
        users: rdJson(P('users'), {}),
        sess: rdJson(P('sessions'), {}),
        usage: rdJson(P('usage'), { day: '', n: {} })
      };
    },
    save(col, obj) {
      try { wrJson(P(col), obj); }
      catch (e) { console.error('[file] 저장 실패', col, e.message); }
    },
    async getRoom(u) { return rdJson(path.join(roomsDir, u + '.json'), EMPTY_ROOM()); },
    async setRoom(u, d) {
      try { wrJson(path.join(roomsDir, u + '.json'), d); }
      catch (e) { console.error('[file] room 저장 실패', u, e.message); throw e; }
    },
    async allRooms() {
      try {
        return fs.readdirSync(roomsDir)
          .filter(f => f.endsWith('.json'))
          .map(f => [f.slice(0, -5), rdJson(path.join(roomsDir, f), null)])
          .filter(x => x[1]);
      } catch { return []; }
    },
    async flushAll() {},
    async close() {},
    async logReason() {}
  };
}

// ---------- MongoDB 백엔드 ----------
async function mongoBackend(uri, dbName) {
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 15000,
    connectTimeoutMS: 10000,
    socketTimeoutMS: 30000,      // 응답 없는 죽은 소켓을 끊어 새 연결로 재시도하게 함 (기본값 0 = 무기한 대기)
    maxIdleTimeMS: 60000,        // 유휴 연결을 먼저 닫아 클라우드 NAT/LB 의 조용한 연결 종료를 피함
    heartbeatFrequencyMS: 10000,
    maxPoolSize: 10,
    retryWrites: true,
    retryReads: true
  });
  await client.connect();
  const d = client.db(dbName);
  const C = {
    cfg: d.collection('config'),
    users: d.collection('users'),
    sessions: d.collection('sessions'),
    usage: d.collection('usage'),
    rooms: d.collection('rooms'),
    reasons: d.collection('reasons')
  };
  await C.sessions.createIndex({ expAt: 1 }, { expireAfterSeconds: 0 });
  await C.reasons.createIndex({ at: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

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
  const pending = { cfg: null, users: null, sessions: null, usage: null };
  const dirty = { cfg: false, users: false, sessions: false, usage: false };
  const chain = {};
  const timers = {};
  const INTERVAL = Math.max(200, Number(process.env.SAVE_INTERVAL_MS) || 1000);
  const DEBOUNCE = Math.min(200, INTERVAL);

  async function flush(col) {
    if (!dirty[col] || !pending[col]) return;
    // 이번 라운드에서 처리할 스냅샷을 잡고 dirty 를 내린다.
    // flush 도중 save 가 다시 오면 dirty 가 다시 true → 끝에서 재실행.
    dirty[col] = false;
    const map = pending[col];
    const cur = new Map();
    const ops = [];
    for (const [k, v] of Object.entries(map)) {
      let j;
      try { j = JSON.stringify(v); } catch (e) {
        console.error('[mongo] stringify 실패', col, k, e.message);
        dirty[col] = true;
        continue;
      }
      cur.set(k, j);
      if (snaps[col].get(k) !== j) {
        const doc = encode(col, v);
        // _id 는 filter 로만 지정 (문서 본문에 중복 넣지 않음)
        ops.push({ replaceOne: { filter: { _id: k }, replacement: doc, upsert: true } });
      }
    }
    for (const k of snaps[col].keys()) {
      if (!cur.has(k)) ops.push({ deleteOne: { filter: { _id: k } } });
    }
    try {
      if (ops.length) {
        const t0 = Date.now();
        await withTimeout(C[col].bulkWrite(ops, { ordered: false }), 'bulkWrite ' + col);
        const ms = Date.now() - t0;
        if (ms > 3000) console.warn('[mongo] 저장 지연', col, ms + 'ms');
        if (process.env.DB_DEBUG === '1') console.log('[mongo] flush', col, 'ops', ops.length, ms + 'ms');
      }
      snaps[col] = cur;
    } catch (e) {
      console.error('[mongo] 저장 실패', col, e.message);
      dirty[col] = true; // 다음 주기에 재시도
      throw e;
    }
    if (dirty[col]) await flush(col);
  }

  const run = col => {
    chain[col] = (chain[col] || Promise.resolve())
      .then(() => flush(col))
      .catch(() => {});
    return chain[col];
  };

  const schedule = col => {
    dirty[col] = true;
    clearTimeout(timers[col]);
    // 빠른 반영: 200ms 디바운스. 주기 타이머가 최대 1초 보장.
    timers[col] = setTimeout(() => run(col), DEBOUNCE);
  };

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
      // 로드 직후 pending 도 맞춰 두어 불필요한 전체 rewrite 방지
      pending.cfg = { main: clone(out.cfg) };
      pending.usage = { main: clone(out.usage) };
      pending.users = clone(out.users);
      pending.sessions = clone(out.sess);
      return out;
    },
    // 호출 순간의 값을 깊은 복사해 두므로, 이후 메모리 수정과 경합하지 않음
    save(col, obj) {
      if (SINGLE.has(col)) pending[col] = { main: clone(obj) };
      else pending[col] = clone(obj);
      schedule(col);
    },
    // 읽기 실패를 "빈 방 목록"으로 돌려주면 그 위에 쓰기가 일어나 기존 데이터가 지워진다 → 반드시 예외로 올린다
    async getRoom(u) {
      for (let i = 0; ; i++) {
        try {
          const doc = await withTimeout(C.rooms.findOne({ _id: u }), 'getRoom');
          return doc ? strip(doc) : EMPTY_ROOM();
        } catch (e) {
          console.error('[mongo] getRoom 실패', u, e.message);
          if (i >= 1) throw e;
        }
      }
    },
    async setRoom(u, dd) {
      // 채팅은 즉시 저장 (1초 대기 없음). 한 번 실패하면 새 연결로 재시도
      const body = clone(dd);
      delete body._id;
      for (let i = 0; ; i++) {
        try {
          await withTimeout(C.rooms.replaceOne({ _id: u }, body, { upsert: true }), 'setRoom');
          return;
        } catch (e) {
          console.error('[mongo] setRoom 실패', u, e.message);
          if (i >= 1) throw e;
        }
      }
    },
    async logReason(entry) {
      try { await withTimeout(C.reasons.insertOne({ ...entry, at: new Date() }), 'logReason'); }
      catch (e) { console.warn('[mongo] reason log 실패', e.message); }
    },
    async flushAll() {
      for (const col of Object.keys(snaps)) {
        dirty[col] = true;
        clearTimeout(timers[col]);
        await run(col);
      }
    },
    async close() {
      clearInterval(iv);
      for (const t of Object.values(timers)) clearTimeout(t);
      try { await withTimeout(api.flushAll(), 'flushAll', 8000); } catch (e) { console.error('[mongo] 종료 전 저장 실패:', e.message); }
      clearInterval(ping);
      try { await client.close(); } catch {}
    }
  };

  // 최대 1초마다 dirty 컬렉션 강제 flush (디바운스가 밀려도 보장)
  const iv = setInterval(() => {
    for (const col of Object.keys(snaps)) {
      if (dirty[col]) run(col);
    }
  }, INTERVAL);
  // 연결 유지 + 끊김 조기 감지 (유휴 연결이 조용히 죽는 환경 대비)
  const ping = setInterval(() => {
    withTimeout(d.command({ ping: 1 }), 'ping', 8000).catch(e => console.warn('[mongo] ping 실패 → 다음 작업에서 재연결:', e.message));
  }, 20000);
  if (typeof ping.unref === 'function') ping.unref();

  console.log('[db] Mongo flush: debounce %dms, max interval %dms', DEBOUNCE, INTERVAL);
  return api;
}

// ---------- 초기화 ----------
// 같은 사용자의 채팅방 읽기→수정→쓰기를 직렬화한다. mutate(d)가 false 를 돌려주면 쓰지 않는다.
const withUpdateRoom = b => {
  b.updateRoom = (u, mutate) => withLock('room:' + u, async () => {
    const d = await b.getRoom(u);
    if (!d.tomb) d.tomb = {};
    if (!Array.isArray(d.rooms)) d.rooms = [];
    if ((await mutate(d)) === false) return d;
    await b.setRoom(u, d);
    return d;
  });
  return b;
};

async function init({ uri, dbName, dataDir }) {
  const file = withUpdateRoom(fileBackend(dataDir));
  if (!uri) {
    console.log('[db] DB/MONGODB_URI 없음 → 로컬 JSON 파일 사용:', dataDir);
    file.data = await file.load();
    return file;
  }
  const mongo = withUpdateRoom(await mongoBackend(uri, dbName));
  mongo.data = await mongo.load();
  const empty = !Object.keys(mongo.data.users).length && !mongo.data.cfg.apiKey;
  if (empty) {
    const old = await file.load();
    if (Object.keys(old.users).length || old.cfg.apiKey) {
      mongo.data = old;
      for (const [col, obj] of [['cfg', old.cfg], ['users', old.users], ['sessions', old.sess], ['usage', old.usage]]) {
        mongo.save(col, obj);
      }
      for (const [u, d] of await file.allRooms()) await mongo.setRoom(u, d);
      await mongo.flushAll();
      console.log('[db] 기존 data/ 파일 → MongoDB 이전 완료 (사용자 %d명)', Object.keys(old.users).length);
    }
  }
  console.log('[db] MongoDB 연결됨 (db: %s)', dbName);
  return mongo;
}

module.exports = { init };
