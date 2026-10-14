// 김'S AI 서버 — 의존성 없음 (Node 18+).  실행: node server.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { Readable } = require('stream');

const PORT = process.env.PORT || 3000;
const ADMIN_IPS = (process.env.ADMIN_IPS || '211.233.75.204').split(',').map(s => s.trim()).filter(Boolean); // 관리자(화이트리스트) IP
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT) || 20;      // 관리자 외 하루 질문 수 (한국시간 자정 초기화)
const TRUST_PROXY = process.env.TRUST_PROXY === '1';            // nginx / Render 등 프록시 뒤에서만 1
const BASE = process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com';
const DATA = path.join(__dirname, 'data'), ROOMS = path.join(DATA, 'rooms');
fs.mkdirSync(ROOMS, { recursive: true });

// ---------- 저장소 (메모리 + 파일) ----------
const rd = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const wr = (f, o) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o), { mode: 0o600 }); fs.renameSync(t, f); };
const F = { cfg: path.join(DATA, 'config.json'), users: path.join(DATA, 'users.json'), sess: path.join(DATA, 'sessions.json'), use: path.join(DATA, 'usage.json') };
const cfg = rd(F.cfg, {}), users = rd(F.users, {}), sess = rd(F.sess, {});
let usage = rd(F.use, { day: '', n: {} });
const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const cnt = k => { if (usage.day !== today()) usage = { day: today(), n: {} }; return usage.n[k] || 0; };
const bump = (k, d) => { cnt(k); usage.n[k] = Math.max(0, (usage.n[k] || 0) + d); wr(F.use, usage); };

// ---------- 유틸 ----------
const ip = req => (TRUST_PROXY && req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : req.socket.remoteAddress || '').replace(/^::ffff:/, '');
const isAdmin = req => ADMIN_IPS.includes(ip(req));
const send = (res, code, obj, h = {}) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...h }); res.end(JSON.stringify(obj)); };
const fail = (res, code, message, h) => send(res, code, { error: { message } }, h);
const body = req => new Promise((ok, no) => {
  let b = ''; req.on('data', c => { b += c; if (b.length > 10e6) { no(new Error('요청이 너무 큽니다.')); req.destroy(); } });
  req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch { no(new Error('잘못된 JSON입니다.')); } });
});
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const cookie = req => Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim().split('=')).filter(p => p[0]));
const auth = req => {
  if (isAdmin(req)) return { user: 'admin', admin: true };
  const t = cookie(req).sid, s = t && sess[sha(t)];
  return s && s.exp > Date.now() ? { user: s.user, admin: false } : null;
};
const usedOf = (a, req) => a.admin ? 0 : Math.max(cnt('u:' + a.user), cnt('ip:' + ip(req)));
const fails = {};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), p = url.pathname, m = req.method;
  try {
    if (m === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return fs.createReadStream(path.join(__dirname, 'public', 'index.html')).pipe(res);
    }
    const a = auth(req);

    if (p === '/api/me' && m === 'GET') {
      if (!a) return send(res, 200, { user: null });
      return send(res, 200, { user: a.user, admin: a.admin, limit: DAILY_LIMIT, used: usedOf(a, req), hasKey: !!cfg.apiKey });
    }
    if ((p === '/api/register' || p === '/api/login') && m === 'POST') {
      const I = ip(req), f = fails[I] || (fails[I] = { n: 0, t: Date.now() });
      if (Date.now() - f.t > 600e3) { f.n = 0; f.t = Date.now(); }
      if (f.n >= 10) return fail(res, 429, '시도가 너무 많습니다. 10분 뒤에 다시 시도하세요.');
      const { username, password } = await body(req), name = String(username || '').trim().toLowerCase();
      if (!/^[a-z0-9_가-힣]{2,20}$/.test(name)) return fail(res, 400, '아이디는 2~20자의 한글·영문·숫자·_ 만 쓸 수 있습니다.');
      if (typeof password !== 'string' || password.length < 6 || password.length > 100) return fail(res, 400, '비밀번호는 6자 이상이어야 합니다.');
      if (p === '/api/register') {
        if (name === 'admin' || name === '관리자' || users[name]) return fail(res, 409, '이미 사용 중인 아이디입니다.');
        if (cnt('reg:' + I) >= 10) return fail(res, 429, '오늘 가입 가능 횟수를 초과했습니다.');
        const salt = crypto.randomBytes(16).toString('hex');
        users[name] = { salt, hash: hashPw(password, salt) }; wr(F.users, users); bump('reg:' + I, 1);
      } else {
        const u = users[name], ok = u && crypto.timingSafeEqual(Buffer.from(hashPw(password, u.salt), 'hex'), Buffer.from(u.hash, 'hex'));
        if (!ok) { f.n++; return fail(res, 401, '아이디 또는 비밀번호가 올바르지 않습니다.'); }
      }
      const tok = crypto.randomBytes(32).toString('hex');
      for (const k of Object.keys(sess)) if (sess[k].exp < Date.now()) delete sess[k];
      sess[sha(tok)] = { user: name, exp: Date.now() + 30 * 864e5 }; wr(F.sess, sess);
      const secure = req.socket.encrypted || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '';
      return send(res, 200, { ok: true }, { 'Set-Cookie': `sid=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${secure}` });
    }
    if (p === '/api/logout' && m === 'POST') {
      const t = cookie(req).sid; if (t) { delete sess[sha(t)]; wr(F.sess, sess); }
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; Path=/; Max-Age=0' });
    }
    if (!a) return fail(res, 401, '로그인이 필요합니다.');

    // ----- 관리자 전용 API 키 -----
    if (p === '/api/config') {
      if (m === 'GET') return send(res, 200, a.admin ? { hasKey: !!cfg.apiKey, key: cfg.apiKey || '' } : { hasKey: !!cfg.apiKey });
      if (!a.admin) return fail(res, 403, 'API 키는 관리자만 변경할 수 있습니다.');
      if (m === 'PUT') {
        const { apiKey } = await body(req);
        if (typeof apiKey !== 'string' || !/^\S{20,}$/.test(apiKey.trim())) return fail(res, 400, '올바른 API 키 형식이 아닙니다.');
        cfg.apiKey = apiKey.trim(); wr(F.cfg, cfg); return send(res, 200, { ok: true });
      }
      if (m === 'DELETE') { cfg.apiKey = ''; wr(F.cfg, cfg); return send(res, 200, { ok: true }); }
    }

    // ----- 계정별 채팅방 (기기 간 공유) -----
    if (p === '/api/rooms') {
      const file = path.join(ROOMS, a.user + '.json'), d = rd(file, { rev: 0, rooms: [], tomb: {} });
      if (m === 'GET') return url.searchParams.get('rev') === String(d.rev) ? send(res, 200, { rev: d.rev, same: true }) : send(res, 200, { rev: d.rev, rooms: d.rooms });
      if (m === 'PUT') {
        const { rooms = [], deleted = [] } = await body(req);
        if (!Array.isArray(rooms) || rooms.length > 300 || !Array.isArray(deleted)) return fail(res, 400, '잘못된 요청입니다.');
        const map = new Map(d.rooms.map(r => [r.id, r]));
        for (const id of deleted) { map.delete(id); d.tomb[id] = Date.now(); }
        for (const r of rooms) {
          if (!r || typeof r.id !== 'string' || !Array.isArray(r.messages) || d.tomb[r.id]) continue;
          const old = map.get(r.id); if (!old || (r.updatedAt || 0) >= (old.updatedAt || 0)) map.set(r.id, r);
        }
        d.rooms = [...map.values()].sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0)); d.rev++;
        wr(file, d); return send(res, 200, { rev: d.rev, rooms: d.rooms });
      }
    }

    // ----- 채팅 (모든 기기가 관리자가 등록한 키를 사용) -----
    if (p === '/api/chat' && m === 'POST') {
      if (!cfg.apiKey) return fail(res, 503, '관리자가 아직 API 키를 등록하지 않았습니다.');
      const used = usedOf(a, req), H = n => ({ 'X-Used': String(n) });
      if (!a.admin && used >= DAILY_LIMIT) return fail(res, 429, `오늘 질문 한도(${DAILY_LIMIT}회)를 모두 사용했습니다. 내일 다시 이용해 주세요.`, H(used));
      const { model, contents, temperature, noThink } = await body(req);
      if (!/^[\w.\-]+$/.test(model || '') || !Array.isArray(contents) || !contents.length || contents.length > 60) return fail(res, 400, '잘못된 요청입니다.');
      const gen = { temperature: Math.min(2, Math.max(0, Number(temperature) || 0.7)) };
      if (noThink) gen.thinkingConfig = { thinkingBudget: 0 };
      if (!a.admin) { bump('u:' + a.user, 1); bump('ip:' + ip(req), 1); }
      const refund = () => { if (!a.admin) { bump('u:' + a.user, -1); bump('ip:' + ip(req), -1); } };
      const ac = new AbortController(); res.on('close', () => ac.abort());
      let up;
      try {
        up = await fetch(`${BASE}/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
          method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey },
          body: JSON.stringify({ contents, generationConfig: gen })
        });
      } catch (e) { refund(); return fail(res, 502, 'Gemini에 연결하지 못했습니다.', H(usedOf(a, req))); }
      if (!up.ok) { refund(); res.writeHead(up.status, { 'Content-Type': 'application/json; charset=utf-8', ...H(usedOf(a, req)) }); return res.end(await up.text()); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no', ...H(usedOf(a, req)) });
      res.flushHeaders();
      return Readable.fromWeb(up.body).on('error', () => res.end()).pipe(res);
    }
    fail(res, 404, 'Not found');
  } catch (err) { if (!res.headersSent) fail(res, 500, err.message || '서버 오류'); else res.end(); }
}).listen(PORT, () => console.log(`김'S AI → http://localhost:${PORT}  (관리자 IP: ${ADMIN_IPS.join(', ')}, 일일 한도: ${DAILY_LIMIT})`));
