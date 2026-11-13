// Gims AI 서버 — 의존성 없음 (Node 18+).  실행: node server.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { Readable } = require('stream');
const block = require('./block');

const PORT = process.env.PORT || 3000;
const ADMIN_IPS = (process.env.ADMIN_IPS || '211.233.75.204').split(',').map(s => s.trim()).filter(Boolean); // 관리자(화이트리스트) IP
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT) || 20;      // 관리자 외 기본 하루 질문 수 (한국시간 자정 초기화)
const VERIFY_BONUS = 30;                                         // 이메일 인증 시 추가 한도
const TRUST_PROXY = process.env.TRUST_PROXY === '1';            // nginx / Render 등 프록시 뒤에서만 1
const BASE = process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com';
// 데이터 경로: DATA_DIR 환경변수 (영구 디스크 마운트 경로) 또는 server.js 옆 data/
// Free 플랜: /var/data 는 권한 없음 → DATA_DIR 비우거나 앱 디렉터리 하위 사용
function resolveDataDir() {
  const candidates = [];
  if (process.env.DATA_DIR) candidates.push(path.resolve(process.env.DATA_DIR));
  candidates.push(path.join(__dirname, 'data'));
  candidates.push(path.join(process.cwd(), 'data'));
  for (const dir of candidates) {
    try {
      fs.mkdirSync(path.join(dir, 'rooms'), { recursive: true });
      return dir;
    } catch (e) {
      console.warn('[data] 사용 불가:', dir, e.code || e.message);
    }
  }
  // 최후: /tmp (재시작 시 사라짐)
  const tmp = path.join(require('os').tmpdir(), 'gims-ai-data');
  fs.mkdirSync(path.join(tmp, 'rooms'), { recursive: true });
  return tmp;
}
const DATA = resolveDataDir();
const ROOMS = path.join(DATA, 'rooms');
console.log('[data] 저장 경로:', DATA);

// ---------- 저장소 (메모리 + 파일) ----------
const rd = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const wr = (f, o) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o), { mode: 0o600 }); fs.renameSync(t, f); };
const F = { cfg: path.join(DATA, 'config.json'), users: path.join(DATA, 'users.json'), sess: path.join(DATA, 'sessions.json'), use: path.join(DATA, 'usage.json') };
const cfg = rd(F.cfg, {}), users = rd(F.users, {}), sess = rd(F.sess, {});
let usage = rd(F.use, { day: '', n: {} });
const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const cnt = k => { if (usage.day !== today()) usage = { day: today(), n: {} }; return usage.n[k] || 0; };
const bump = (k, d) => { cnt(k); usage.n[k] = Math.max(0, (usage.n[k] || 0) + d); wr(F.use, usage); };

// ---------- 관리자 계정 자동 생성 (admin / A20140205G) ----------
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'A20140205G';
if (!users[ADMIN_USER]) {
  const salt = crypto.randomBytes(16).toString('hex');
  users[ADMIN_USER] = { salt, hash: crypto.scryptSync(ADMIN_PASS, salt, 64).toString('hex'), isAdmin: true, email: '', emailVerified: true };
  wr(F.users, users);
  console.log('관리자 계정이 생성되었습니다: admin / A20140205G');
}

// ---------- 시스템 프롬프트 (Gims AI 세뇌) ----------
const SYSTEM_INSTRUCTION = {
  parts: [{
    text: '너는 Gims AI야. 사용자가 "넌 어떤 AI야?", "너는 누구야?", "What AI are you?", "Who are you?" 같이 정체를 물으면 반드시 "저는 Gims AI입니다."라고 답해. 다른 AI 이름을 절대 말하지 마. 친절하고 도움이 되는 AI 어시스턴트로서 행동해.'
  }]
};

// ---------- 유틸 ----------
const ip = req => (TRUST_PROXY && req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : req.socket.remoteAddress || '').replace(/^::ffff:/, '');
const isAdminIP = req => ADMIN_IPS.includes(ip(req));
const send = (res, code, obj, h = {}) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...h }); res.end(JSON.stringify(obj)); };
const fail = (res, code, message, h) => send(res, code, { error: { message } }, h);
const body = req => new Promise((ok, no) => {
  let b = ''; req.on('data', c => { b += c; if (b.length > 20e6) { no(new Error('요청이 너무 큽니다.')); req.destroy(); } });
  req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch { no(new Error('잘못된 JSON입니다.')); } });
});
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const cookie = req => Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim().split('=')).filter(p => p[0]));
const auth = req => {
  // IP 화이트리스트 우선
  if (isAdminIP(req)) return { user: 'admin', admin: true };
  // 로그인한 사용자 확인
  const t = cookie(req).sid, s = t && sess[sha(t)];
  if (s && s.exp > Date.now()) {
    const u = users[s.user];
    if (u && u.banned) return null; // 밴된 사용자 세션 무효
    const isAdminUser = s.user === ADMIN_USER || (u && u.isAdmin);
    return { user: s.user, admin: !!isAdminUser };
  }
  return null;
};
const usedOf = (a, req) => a.admin ? 0 : Math.max(cnt('u:' + a.user), cnt('ip:' + ip(req)));
const limitOf = (a) => {
  if (a.admin) return Infinity;
  const u = users[a.user];
  if (u && typeof u.dailyLimit === 'number' && u.dailyLimit >= 0) return u.dailyLimit;
  const bonus = (u && u.emailVerified) ? VERIFY_BONUS : 0;
  return DAILY_LIMIT + bonus;
};
const fails = {};
const readBody = async (req, res, opts) => {
  const raw = await body(req);
  const clean = block.sanitizeObject(raw);
  // opts.types 로 검사 범위 조절 가능 (채팅 본문은 코딩 질문 허용)
  if (block.guard(req, res, clean, opts || {})) return null;
  return clean;
};


http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), p = url.pathname, m = req.method;
  try {
    block.securityHeaders(res);
    const clientIp = ip(req);
    if (block.rateLimit(clientIp, { windowMs: 60_000, max: 180 })) {
      return fail(res, 429, '요청이 너무 많습니다. 잠시 후 다시 시도하세요.');
    }
    if (m === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return fs.createReadStream(path.join(__dirname, 'public', 'index.html')).pipe(res);
    }
    // URL/헤더 1차 검사
    if (block.guard(req, res)) return;
    const a = auth(req);

    if (p === '/api/me' && m === 'GET') {
      if (!a) return send(res, 200, { user: null });
      const u = users[a.user] || {};
      if (u.banned) return send(res, 200, { user: null });
      const lim = limitOf(a);
      return send(res, 200, {
        user: a.user,
        admin: a.admin,
        limit: lim === Infinity ? 0 : lim,
        used: usedOf(a, req),
        hasKey: !!cfg.apiKey,
        email: u.email || '',
        emailVerified: !!u.emailVerified
      });
    }
    if ((p === '/api/register' || p === '/api/login') && m === 'POST') {
      const I = ip(req), f = fails[I] || (fails[I] = { n: 0, t: Date.now() });
      if (Date.now() - f.t > 600e3) { f.n = 0; f.t = Date.now(); }
      if (f.n >= 10) return fail(res, 429, '시도가 너무 많습니다. 10분 뒤에 다시 시도하세요.');
      const _b = await readBody(req, res); if (!_b) return;
      const { username, password } = _b, name = String(username || '').trim().toLowerCase();
      if (!block.isSafeId(name) || name.length < 2 || name.length > 20) return fail(res, 400, '아이디는 2~20자의 한글·영문·숫자·_ 만 쓸 수 있습니다.');
      if (typeof password !== 'string' || password.length < 6 || password.length > 100) return fail(res, 400, '비밀번호는 6자 이상이어야 합니다.');
      if (p === '/api/register') {
        if (name === 'admin' || name === '관리자' || users[name]) return fail(res, 409, '이미 사용 중인 아이디입니다.');
        if (cnt('reg:' + I) >= 10) return fail(res, 429, '오늘 가입 가능 횟수를 초과했습니다.');
        const salt = crypto.randomBytes(16).toString('hex');
        users[name] = { salt, hash: hashPw(password, salt), email: '', emailVerified: false }; wr(F.users, users); bump('reg:' + I, 1);
      } else {
        const u = users[name], ok = u && crypto.timingSafeEqual(Buffer.from(hashPw(password, u.salt), 'hex'), Buffer.from(u.hash, 'hex'));
        if (!ok) { f.n++; return fail(res, 401, '아이디 또는 비밀번호가 올바르지 않습니다.'); }
        if (u.banned) return fail(res, 403, '차단된 계정입니다. 관리자에게 문의하세요.');
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

    // ----- 계정 설정 (이메일) -----
    if (p === '/api/account' && m === 'PUT') {
      if (a.admin && a.user === 'admin' && isAdminIP(req)) {
        // IP 관리자는 이메일 불필요
      }
      const _b = await readBody(req, res); if (!_b) return;
      const { email } = _b;
      const em = String(email || '').trim().toLowerCase();
      if (em && !block.isSafeEmail(em)) return fail(res, 400, '올바른 이메일 형식이 아닙니다.');
      if (!users[a.user]) return fail(res, 404, '사용자를 찾을 수 없습니다.');
      users[a.user].email = em;
      if (!em) users[a.user].emailVerified = false;
      // 이메일이 바뀌면 인증 초기화
      if (em !== (users[a.user].email || '')) {
        users[a.user].emailVerified = false;
        delete users[a.user].verifyCode;
        delete users[a.user].verifyExp;
      }
      wr(F.users, users);
      return send(res, 200, { ok: true, email: em, emailVerified: !!users[a.user].emailVerified });
    }
    if (p === '/api/verify/request' && m === 'POST') {
      const u = users[a.user];
      if (!u) return fail(res, 404, '사용자를 찾을 수 없습니다.');
      if (!u.email) return fail(res, 400, '먼저 이메일을 등록해 주세요.');
      if (u.emailVerified) return fail(res, 400, '이미 인증된 이메일입니다.');
      const code = String(Math.floor(100000 + Math.random() * 900000));
      u.verifyCode = sha(code);
      u.verifyExp = Date.now() + 15 * 60 * 1000; // 15분
      wr(F.users, users);
      // 실제 이메일 발송 기능 없음 (의존성 없음). 서버 콘솔에 출력 + 응답에 포함(데모용)
      console.log(`[이메일 인증] 사용자=${a.user} 이메일=${u.email} 코드=${code}`);
      return send(res, 200, {
        ok: true,
        message: '인증 코드가 생성되었습니다. (데모: 실제 메일 발송 없음 — 아래 코드를 입력하세요)',
        demoCode: code   // 실제 서비스에서는 이 필드를 제거하세요
      });
    }
    if (p === '/api/verify/confirm' && m === 'POST') {
      const _b = await readBody(req, res); if (!_b) return;
      const { code } = _b;
      const u = users[a.user];
      if (!u) return fail(res, 404, '사용자를 찾을 수 없습니다.');
      if (u.emailVerified) return send(res, 200, { ok: true, emailVerified: true });
      if (!u.verifyCode || !u.verifyExp || u.verifyExp < Date.now()) return fail(res, 400, '인증 코드가 만료되었거나 없습니다. 다시 요청해 주세요.');
      if (sha(String(code || '').trim()) !== u.verifyCode) return fail(res, 400, '인증 코드가 올바르지 않습니다.');
      u.emailVerified = true;
      delete u.verifyCode;
      delete u.verifyExp;
      wr(F.users, users);
      return send(res, 200, { ok: true, emailVerified: true, limit: limitOf(a) });
    }

    // ----- 관리자 전용 API 키 -----
    if (p === '/api/config') {
      if (m === 'GET') return send(res, 200, a.admin ? { hasKey: !!cfg.apiKey, key: cfg.apiKey || '' } : { hasKey: !!cfg.apiKey });
      if (!a.admin) return fail(res, 403, 'API 키는 관리자만 변경할 수 있습니다.');
      if (m === 'PUT') {
        const _b = await readBody(req, res); if (!_b) return;
        const { apiKey } = _b;
        if (typeof apiKey !== 'string' || !/^\S{20,}$/.test(apiKey.trim())) return fail(res, 400, '올바른 API 키 형식이 아닙니다.');
        cfg.apiKey = apiKey.trim(); wr(F.cfg, cfg); return send(res, 200, { ok: true });
      }
      if (m === 'DELETE') { cfg.apiKey = ''; wr(F.cfg, cfg); return send(res, 200, { ok: true }); }
    }

    // ----- 관리자: 사용자 목록 / 한도·밴 제어 -----
    if (p === '/api/admin/users' && m === 'GET') {
      if (!a.admin) return fail(res, 403, '관리자만 접근할 수 있습니다.');
      const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '100', 10) || 100));
      const seed = url.searchParams.get('seed') || '';
      let list = Object.keys(users)
        .filter(name => name !== ADMIN_USER && !users[name].isAdmin)
        .map(name => {
          const u = users[name];
          const custom = typeof u.dailyLimit === 'number' && u.dailyLimit >= 0;
          const base = custom ? u.dailyLimit : (DAILY_LIMIT + (u.emailVerified ? VERIFY_BONUS : 0));
          return {
            username: name,
            email: u.email || '',
            emailVerified: !!u.emailVerified,
            banned: !!u.banned,
            dailyLimit: custom ? u.dailyLimit : null,
            effectiveLimit: base,
            used: cnt('u:' + name)
          };
        });
      if (q) {
        list = list.filter(u => u.username.includes(q) || (u.email && u.email.includes(q)));
      }
      // 아이디 순 정렬 — 전체 사용자 목록 (100명씩 페이지)
      list.sort((a, b) => a.username.localeCompare(b.username, 'ko'));
      const total = list.length;
      const page = list.slice(offset, offset + limit);
      return send(res, 200, { total, offset, limit, users: page });
    }
    if (p === '/api/admin/users' && m === 'PUT') {
      if (!a.admin) return fail(res, 403, '관리자만 접근할 수 있습니다.');
      const _b = await readBody(req, res); if (!_b) return;
      const { username, dailyLimit, banned } = _b;
      const name = String(username || '').trim().toLowerCase();
      if (!name || !block.isSafeId(name) || !users[name]) return fail(res, 404, '사용자를 찾을 수 없습니다.');
      if (name === ADMIN_USER || users[name].isAdmin) return fail(res, 403, '관리자 계정은 변경할 수 없습니다.');
      if (dailyLimit !== undefined) {
        if (dailyLimit === null || dailyLimit === '') {
          delete users[name].dailyLimit;
        } else {
          const n = Number(dailyLimit);
          if (!Number.isFinite(n) || n < 0 || n > 100000) return fail(res, 400, '한도는 0~100000 사이여야 합니다.');
          users[name].dailyLimit = Math.floor(n);
        }
      }
      if (banned !== undefined) {
        users[name].banned = !!banned;
        if (banned) {
          for (const k of Object.keys(sess)) {
            if (sess[k].user === name) delete sess[k];
          }
          wr(F.sess, sess);
        }
      }
      wr(F.users, users);
      const u = users[name];
      const custom = typeof u.dailyLimit === 'number' && u.dailyLimit >= 0;
      return send(res, 200, {
        ok: true,
        username: name,
        email: u.email || '',
        banned: !!u.banned,
        dailyLimit: custom ? u.dailyLimit : null,
        effectiveLimit: custom ? u.dailyLimit : (DAILY_LIMIT + (u.emailVerified ? VERIFY_BONUS : 0)),
        used: cnt('u:' + name)
      });
    }

    // ----- 계정별 채팅방 (기기 간 공유) -----
    if (p === '/api/rooms') {
      const file = path.join(ROOMS, a.user + '.json'), d = rd(file, { rev: 0, rooms: [], tomb: {} });
      if (m === 'GET') return url.searchParams.get('rev') === String(d.rev) ? send(res, 200, { rev: d.rev, same: true }) : send(res, 200, { rev: d.rev, rooms: d.rooms });
      if (m === 'PUT') {
        const _b = await readBody(req, res); if (!_b) return;
        const { rooms = [], deleted = [] } = _b;
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
      const u = users[a.user];
      if (u && u.banned) return fail(res, 403, '차단된 계정입니다.');
      const used = usedOf(a, req), lim = limitOf(a), H = n => ({ 'X-Used': String(n), 'X-Limit': String(lim === Infinity ? 0 : lim) });
      if (!a.admin && used >= lim) return fail(res, 429, `오늘 질문 한도(${lim}회)를 모두 사용했습니다. 내일 다시 이용해 주세요.`, H(used));
      // 채팅 본문은 SQL/XSS 키워드가 정상 질문일 수 있음 → 프로토타입 오염·크기만 검사
      const _b = await readBody(req, res, { types: ['proto'] }); if (!_b) return;
      const { model, contents, temperature, noThink } = _b;
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
          body: JSON.stringify({ contents, systemInstruction: SYSTEM_INSTRUCTION, generationConfig: gen })
        });
      } catch (e) { refund(); return fail(res, 502, 'Gemini에 연결하지 못했습니다.', H(usedOf(a, req))); }
      if (!up.ok) { refund(); res.writeHead(up.status, { 'Content-Type': 'application/json; charset=utf-8', ...H(usedOf(a, req)) }); return res.end(await up.text()); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no', ...H(usedOf(a, req)) });
      res.flushHeaders();
      return Readable.fromWeb(up.body).on('error', () => res.end()).pipe(res);
    }
    fail(res, 404, 'Not found');
  } catch (err) { if (!res.headersSent) fail(res, 500, err.message || '서버 오류'); else res.end(); }
}).listen(PORT, () => console.log(`Gims AI → http://localhost:${PORT}  (관리자 IP: ${ADMIN_IPS.join(', ')}, 기본 일일 한도: ${DAILY_LIMIT}, 인증 보너스: +${VERIFY_BONUS})`));
