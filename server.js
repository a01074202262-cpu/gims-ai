// Gims AI 서버 — 의존성 없음 (Node 18+).  실행: node server.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { Readable } = require('stream');
const block = require('./block');
const dbmod = require('./db');
const reasoning = require('./reasoning');
const jobsmod = require('./jobs');
const store = require('./store');
const TOOLS = require('./tool_registry');
const WS = require('./workspace');
const { AGENT_SYSTEM } = require('./agent');
const gemini = require('./gemini');

const PORT = process.env.PORT || 3000;
const ADMIN_IPS = (process.env.ADMIN_IPS || '').split(',').map(s => s.trim()).filter(Boolean); // 관리자(화이트리스트) IP
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT) || 20;      // 관리자 외 기본 하루 질문 수 (한국시간 자정 초기화)
const VERIFY_BONUS = 30;                                         // 이메일 인증 시 추가 한도
const TRUST_PROXY = process.env.TRUST_PROXY === '1';            // nginx / Render 등 프록시 뒤에서만 1
// Gemini API 키 우선순위: ① 관리자 화면에서 등록(DB) → ② 환경변수 GEMINI_API_KEY → ③ package.json 의 config.geminiApiKey
let pkgCfg = {}; try { pkgCfg = require('./package.json').config || {}; } catch {}
const envKey = () => String(process.env.GEMINI_API_KEY || process.env.npm_package_config_geminiApiKey || pkgCfg.geminiApiKey || '').trim();
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

// ---------- 저장소 (메모리 캐시 + MongoDB 또는 JSON 파일) ----------
// DB 또는 MONGODB_URI 환경변수가 있으면 MongoDB 에 API 키·사용자·세션·사용량·채팅방·추론 로그를 모두 저장
let db;
const cfg = {}, users = {}, sess = {};
let usage = { day: '', n: {} };
const saveCfg = () => db.save('cfg', cfg), saveUsers = () => db.save('users', users), saveSess = () => db.save('sessions', sess), saveUse = () => db.save('usage', usage);
const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const cnt = k => { if (usage.day !== today()) usage = { day: today(), n: {} }; return usage.n[k] || 0; };
const bump = (k, d) => { cnt(k); usage.n[k] = Math.max(0, (usage.n[k] || 0) + d); saveUse(); };

// ---------- 관리자 계정 ----------
// AD_PASS 또는 ADMIN_PASS 환경변수를 주면 매 시작 때 그 값으로 설정(비밀번호 교체용). 없고 계정도 없으면 임의 비밀번호를 만들어 콘솔에 1회 출력.
const ADMIN_USER = 'admin';
const getKey = () => cfg.apiKey || envKey();
function ensureAdmin() {
  const env = process.env.AD_PASS || process.env.ADMIN_PASS;
  if (users[ADMIN_USER] && !env) return;
  const pass = env || crypto.randomBytes(9).toString('base64url');
  const salt = crypto.randomBytes(16).toString('hex');
  users[ADMIN_USER] = { salt, hash: crypto.scryptSync(pass, salt, 64).toString('hex'), isAdmin: true, email: '', emailVerified: true };
  saveUsers();
  console.log(env ? '관리자(admin) 비밀번호를 AD_PASS/ADMIN_PASS 값으로 설정했습니다.' : `관리자 계정이 생성되었습니다: admin / ${pass}  (지금만 표시됩니다. 저장하세요)`);
}

// ---------- 시스템 프롬프트 (Gims AI 세뇌) ----------
const SYSTEM_INSTRUCTION = {
  parts: [{
    text: '너는 Gims AI야. 사용자가 "넌 어떤 AI야?", "너는 누구야?", "What AI are you?", "Who are you?" 같이 정체를 물으면 반드시 "저는 Gims AI입니다."라고 답해. 다른 AI 이름을 절대 말하지 마. 친절하고 도움이 되는 AI 어시스턴트로서 행동해.그리고 너는 gims ai team 인 ws서버 라는걸 운영하는 팀이 만든 코딩 전용 ai야 제대로 행동해. 수학 식은 평문(a^2, (-c)^2 - kb(-c) = 0)으로 쓰지 말고 항상 LaTeX 로 쓴다: 문장 속은 $...$, 독립 식은 $$...$$.'
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


// 원본 본문을 제한 크기까지 읽는다 (데이터셋 업로드용). 초과 시 연결을 끊는다.
const rawBody = (req, max) => new Promise((ok, no) => {
  let n = 0; const chunks = [];
  req.on('data', c => {
    n += c.length;
    if (n > max) { no(Object.assign(new Error('파일이 너무 큽니다 (10MB 이하)'), { status: 413 })); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
  req.on('error', no);
});

// 백그라운드로 끝난 작업의 답변을 채팅방에 저장 (클라이언트가 붙어 있었어도 동일 내용이라 덮어써도 무방)
async function persistJob(job) {
  if (!job.roomId || job.status === 'error' || !job.answer.trim()) return;
  await db.updateRoom(job.user, d => {
    if (d.tomb[job.roomId]) return false;
    const room = d.rooms.find(r => r.id === job.roomId); if (!room) return false;
    const msgs = room.messages = Array.isArray(room.messages) ? room.messages : [];
    if (msgs.some(x => x.jobId === job.id)) return false;
    if (job.userText && msgs[msgs.length - 1]?.role !== 'user') {
      msgs.push({ role: 'user', text: job.userText });
      if (msgs.length === 1 && room.title === '새 대화') room.title = job.userText.slice(0, 32) || '새 대화';
    }
    msgs.push({ role: 'assistant', text: job.answer.trim(), jobId: job.id });
    room.updatedAt = Date.now();
    d.rooms.sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0)); d.rev++;
  });
}

const server = http.createServer(async (req, res) => {
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
        hasKey: !!getKey(),
        reason: reasoning.info(),
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
        users[name] = { salt, hash: hashPw(password, salt), email: '', emailVerified: false }; saveUsers(); bump('reg:' + I, 1);
      } else {
        const u = users[name], ok = u && crypto.timingSafeEqual(Buffer.from(hashPw(password, u.salt), 'hex'), Buffer.from(u.hash, 'hex'));
        if (!ok) { f.n++; return fail(res, 401, '아이디 또는 비밀번호가 올바르지 않습니다.'); }
        if (u.banned) return fail(res, 403, '차단된 계정입니다. 관리자에게 문의하세요.');
      }
      const tok = crypto.randomBytes(32).toString('hex');
      for (const k of Object.keys(sess)) if (sess[k].exp < Date.now()) delete sess[k];
      sess[sha(tok)] = { user: name, exp: Date.now() + 30 * 864e5 }; saveSess();
      const secure = req.socket.encrypted || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '';
      return send(res, 200, { ok: true }, { 'Set-Cookie': `sid=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${secure}` });
    }
    if (p === '/api/logout' && m === 'POST') {
      const t = cookie(req).sid; if (t) { delete sess[sha(t)]; saveSess(); }
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
      saveUsers();
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
      saveUsers();
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
      saveUsers();
      return send(res, 200, { ok: true, emailVerified: true, limit: limitOf(a) });
    }

    // ----- 관리자 전용 API 키 -----
    if (p === '/api/config') {
      if (m === 'GET') return send(res, 200, a.admin ? { hasKey: !!getKey(), key: cfg.apiKey || '', source: cfg.apiKey ? 'admin' : (envKey() ? 'env/package.json' : '') } : { hasKey: !!getKey() });
      if (!a.admin) return fail(res, 403, 'API 키는 관리자만 변경할 수 있습니다.');
      if (m === 'PUT') {
        const _b = await readBody(req, res); if (!_b) return;
        const { apiKey } = _b;
        if (typeof apiKey !== 'string' || !/^\S{20,}$/.test(apiKey.trim())) return fail(res, 400, '올바른 API 키 형식이 아닙니다.');
        cfg.apiKey = apiKey.trim(); saveCfg(); return send(res, 200, { ok: true });
      }
      if (m === 'DELETE') { cfg.apiKey = ''; saveCfg(); return send(res, 200, { ok: true }); }
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
          saveSess();
        }
      }
      saveUsers();
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
      if (m === 'GET') {
        const d = await db.getRoom(a.user);
        return url.searchParams.get('rev') === String(d.rev) ? send(res, 200, { rev: d.rev, same: true }) : send(res, 200, { rev: d.rev, rooms: d.rooms });
      }
      if (m === 'PUT') {
        const _b = await readBody(req, res); if (!_b) return;
        const { rooms = [], deleted = [] } = _b;
        if (!Array.isArray(rooms) || rooms.length > 300 || !Array.isArray(deleted)) return fail(res, 400, '잘못된 요청입니다.');
        // 읽기→병합→쓰기를 사용자별로 직렬화 (동시 PUT · 백그라운드 작업 저장이 서로 덮어쓰지 않게)
        const d = await db.updateRoom(a.user, d => {
          const map = new Map(d.rooms.map(r => [r.id, r]));
          for (const id of deleted) { map.delete(id); d.tomb[id] = Date.now(); }
          for (const r of rooms) {
            if (!r || typeof r.id !== 'string' || !Array.isArray(r.messages) || d.tomb[r.id]) continue;
            const old = map.get(r.id); if (!old || (r.updatedAt || 0) >= (old.updatedAt || 0)) map.set(r.id, r);
          }
          d.rooms = [...map.values()].sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0)); d.rev++;
        });
        return send(res, 200, { rev: d.rev, rooms: d.rooms });
      }
    }

    // ----- 데이터셋 업로드 (본인만 조회·사용, 최대 10MB, 메모리 저장) -----
    if (p === '/api/data') {
      if (m === 'GET') return send(res, 200, { datasets: store.list(a.user), stats: store.stats() });
      if (m === 'POST') {
        const len = Number(req.headers['content-length'] || 0);
        if (len > store.MAX_DATASET) return fail(res, 413, '파일은 10MB 이하여야 합니다.');
        let text;
        try { text = await rawBody(req, store.MAX_DATASET); }
        catch (e) { return fail(res, e.status || 400, e.message); }
        const name = String(url.searchParams.get('name') || 'dataset').replace(/[^\w.\-가-힣 ]/g, '_').slice(0, 80);
        if (!/\.(csv|json|txt|tsv)$/i.test(name)) return fail(res, 415, 'csv, json, txt, tsv 파일만 지원합니다 (파일 이름 확장자 확인).');
        if (!text.trim()) return fail(res, 400, '빈 파일입니다.');
        try { return send(res, 200, store.put(a.user, name, text)); }
        catch (e) { return fail(res, 413, e.message); }
      }
      return fail(res, 405, '허용되지 않는 메서드입니다.');
    }
    if (p.startsWith('/api/data/') && m === 'DELETE') {
      const id = decodeURIComponent(p.slice('/api/data/'.length));
      const ok = store.remove(a.user, id);
      return send(res, ok ? 200 : 404, { ok });
    }

    // ----- 작업 공간: AI가 만든 파일 조회·다운로드 -----
    if (p === '/api/workspace' && m === 'GET') return send(res, 200, { files: WS.listFiles(a.user), stats: WS.stats(a.user) });
    if (p === '/api/workspace' && m === 'DELETE') { WS.clear(a.user); return send(res, 200, { ok: true }); }
    if (p === '/api/workspace/file' && m === 'GET') {
      try {
        const fp = url.searchParams.get('path') || '';
        const c = WS.readFile(a.user, fp);
        if (url.searchParams.get('download')) {
          // 진짜 파일로 내려받기: 파일 이름은 경로의 마지막 부분 (한글 등은 RFC 5987 로 인코딩)
          const base = fp.split('/').pop() || 'file.txt';
          const ascii = base.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
          const buf = Buffer.from(c, 'utf8');
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base)}`, 'Content-Length': buf.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          return res.end(buf);
        }
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(c);
      } catch (e) { return fail(res, 404, e.message); }
    }
    if (p === '/api/workspace/zip' && m === 'GET') {
      try {
        const only = (url.searchParams.get('paths') || '').split(',').map(x => x.trim()).filter(Boolean).slice(0, 200);
        const buf = WS.zip(a.user, only);
        res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${only.length ? 'files' : 'workspace'}.zip"`, 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
        return res.end(buf);
      } catch (e) { return fail(res, 404, e.message); }
    }

    // ----- 에이전트: AI가 작업 공간에 파일을 직접 만들고 검사한다 (1회 = 질문 4회분) -----
    if (p === '/api/agent' && m === 'POST') {
      const apiKey = getKey();
      if (!apiKey) return fail(res, 503, '관리자가 아직 API 키를 등록하지 않았습니다.');
      const uu = users[a.user];
      if (uu && uu.banned) return fail(res, 403, '차단된 계정입니다.');
      const COST = 4;
      const usedNow = usedOf(a, req), limNow = limitOf(a);
      if (!a.admin && usedNow + COST > limNow) return fail(res, 429, `에이전트는 질문 ${COST}회분이 차감됩니다. 오늘 남은 한도가 부족해요.`);
      const _b = await readBody(req, res, { types: ['proto'] }); if (!_b) return;
      const { model, message } = _b;
      if (!/^[\w.\-]+$/.test(model || '') || typeof message !== 'string' || !message.trim() || message.length > 4000) return fail(res, 400, '잘못된 요청입니다.');
      if (!a.admin) { bump('u:' + a.user, COST); bump('ip:' + ip(req), COST); }
      const refund = () => { if (!a.admin) { bump('u:' + a.user, -COST); bump('ip:' + ip(req), -COST); } };
      const ac = new AbortController(); res.on('close', () => ac.abort());
      try {
        const r = await TOOLS.runToolLoop({
          base: BASE, key: apiKey, model, system: AGENT_SYSTEM, groups: ['workspace', 'coding', 'vserver', 'sandbox'], mode: 'AUTO', maxRounds: 14, temperature: 0.3,
          signal: ac.signal, owner: a.user,
          contents: [{ role: 'user', parts: [{ text: message }] }]
        });
        return send(res, 200, { text: r.text, trace: r.trace, files: WS.listFiles(a.user) });
      } catch (e) {
        refund();
        return fail(res, 502, e.message || '에이전트 실행에 실패했습니다.');
      }
    }

    // ----- 백그라운드 작업: 상태 조회 · 취소 (창을 닫았다 열어도 이어받기) -----
    if (p === '/api/chat/job' && m === 'GET') {
      const j = url.searchParams.get('active') ? jobsmod.active(a.user) : jobsmod.get(a.user, String(url.searchParams.get('id') || ''));
      if (!j) return url.searchParams.get('active') ? send(res, 200, {}) : fail(res, 404, '작업을 찾을 수 없습니다.');
      return send(res, 200, j.snapshot());
    }
    if (p === '/api/chat/cancel' && m === 'POST') {
      const _b = await readBody(req, res); if (!_b) return;
      const j = jobsmod.get(a.user, String(_b.id || ''));
      if (j && j.status === 'running') j.ac.abort();
      return send(res, 200, { ok: true });
    }

    // ----- 채팅 (모든 기기가 관리자가 등록한 키를 사용) -----
    if (p === '/api/chat' && m === 'POST') {
      const apiKey = getKey();
      if (!apiKey) return fail(res, 503, '관리자가 아직 API 키를 등록하지 않았습니다.');
      const u = users[a.user];
      if (u && u.banned) return fail(res, 403, '차단된 계정입니다.');
      const used = usedOf(a, req), lim = limitOf(a), H = n => ({ 'X-Used': String(n), 'X-Limit': String(lim === Infinity ? 0 : lim) });
      if (!a.admin && used >= lim) return fail(res, 429, `오늘 질문 한도(${lim}회)를 모두 사용했습니다. 내일 다시 이용해 주세요.`, H(used));
      // 채팅 본문은 SQL/XSS 키워드가 정상 질문일 수 있음 → 프로토타입 오염·크기만 검사
      const _b = await readBody(req, res, { types: ['proto'] }); if (!_b) return;
      const { model, contents, temperature, noThink, reason } = _b;
      const jobId = typeof _b.jobId === 'string' && /^[\w-]{6,64}$/.test(_b.jobId) ? _b.jobId : '';
      if (!/^[\w.\-]+$/.test(model || '') || !Array.isArray(contents) || !contents.length || contents.length > 60) return fail(res, 400, '잘못된 요청입니다.');
      // 추론 설정: reason = { level: 'low'|'medium'|'high'|'max' } — 비용은 서버 표(reasoning.LEVELS)가 결정
      const lv = reason && typeof reason === 'object' && typeof reason.level === 'string' && Object.hasOwn(reasoning.LEVELS, reason.level) ? reasoning.LEVELS[reason.level] : null;
      const cost = lv ? lv.cost : 1;
      if (!a.admin && used + cost > lim) return fail(res, 429, `이 추론 정도는 질문 ${cost}회분이 차감됩니다. 오늘 남은 한도가 부족해요. (${lim - used}회 남음)`, H(used));
      const gen = { temperature: Math.min(2, Math.max(0, Number(temperature) || 0.7)) };
      if (noThink && !lv) gen.thinkingConfig = { thinkingBudget: 0 };
      if (!a.admin) { bump('u:' + a.user, cost); bump('ip:' + ip(req), cost); }
      const refund = (n = cost) => { if (!a.admin) { bump('u:' + a.user, -n); bump('ip:' + ip(req), -n); } };
      // 작업(job)으로 실행하면 브라우저 연결이 끊겨도 서버가 끝까지 생성하고 채팅방에 저장한다 (jobId 없는 구형 클라이언트는 기존 동작)
      const job = jobId ? jobsmod.create({ user: a.user, id: jobId, roomId: typeof _b.roomId === 'string' ? _b.roomId.slice(0, 80) : '', userText: typeof _b.userText === 'string' ? _b.userText.slice(0, 20000) : '' }) : null;
      if (jobId && !job) { refund(); return fail(res, 409, '이미 처리 중인 요청입니다.', H(usedOf(a, req))); }
      const ac = job ? job.ac : new AbortController();
      if (!job) res.on('close', () => ac.abort());
      let finished = false;
      const finish = (status, err) => {
        if (!job || finished) return; finished = true; clearInterval(ka);
        job.finish(status, err);
        persistJob(job).catch(e => console.warn('[job] 저장 실패:', e.message));
      };
      // 프록시(Render 등)의 유휴 연결 종료 방지: 연결돼 있는 동안 주기적으로 주석 ping
      const ka = setInterval(() => { if (res.headersSent && !res.writableEnded && !res.destroyed) res.write(': ping\n\n'); }, 15000);
      res.on('close', () => clearInterval(ka));

      // 추론 모드는 단계 진행 상황을 먼저 흘려보내야 하므로 SSE 헤더를 미리 연다
      const early = !!lv;
      const emit = o => { job?.record(o); if (!res.writableEnded && !res.destroyed) res.write('data: ' + JSON.stringify(o) + '\n\n'); };
      const openSSE = () => { if (res.headersSent || res.destroyed) return; res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no', ...H(usedOf(a, req)) }); res.flushHeaders(); };

      // 파일/프로젝트 생성 요청 → 도구로 실제 파일 생성 (마크다운 코드블록 대신)
      const lastText = (() => {
        try { return (contents[contents.length - 1]?.parts || []).map(x => x.text || '').join(' '); }
        catch { return ''; }
      })();
      // 파일 생성 요청 판정: 확실한 표현이면 바로, 막연한 "만들어줘" 는 코딩 의도일 때만
      const strongFile = /(파일|file)\s*(로|을|를)?\s*(만들|생성|저장|작성|주세요|줘|달라|다운|받)|파일로|다운\s*로드|다운\s*받|\bzip\b|워크스페이스|실제\s*파일|프로젝트\s*(를\s*)?만들|index\.html|\.(lua|luau|js|ts|py|html|css|json|md|txt|sh|yml|csv)\s*(로|을|를)?\s*(만들|생성|저장|작성|줘)|(lua|luau|루아|루아우)\s*(파일|스크립트)\s*(만들|작성|생성|짜|줘)/i.test(lastText);
      const weakFile = /(만들|작성|생성|짜)(어|해)?\s*(줘|주세요|달라)/.test(lastText) && ['coding', 'game', 'security'].includes(TOOLS.classify(lastText).intent);
      const wantsFiles = strongFile || weakFile;
      if (wantsFiles) {
        openSSE();
        try {
          emit({ gims: { id: 'files', label: '파일 생성 도구 실행', state: 'start' } });
          // 이번 요청에서 새로 만들어졌거나 바뀐 파일만 카드로 보여주기 위해 실행 전 상태를 기억한다
          const before = new Map(WS.allFiles(a.user).map(f => [f.path, f.content]));
          const r = await TOOLS.runToolLoop({
            base: BASE, key: apiKey, model,
            system: AGENT_SYSTEM + '\n' + (SYSTEM_INSTRUCTION.parts[0]?.text || ''),
            groups: ['workspace', 'coding', 'vserver', 'sandbox'], mode: 'AUTO', maxRounds: 14, temperature: 0.25,
            signal: ac.signal, owner: a.user, contents
          });
          const changed = WS.allFiles(a.user).filter(f => before.get(f.path) !== f.content);
          const sizes = new Map(WS.listFiles(a.user).map(f => [f.path, f.bytes]));
          emit({ gims: { id: 'files', label: changed.length ? `파일 ${changed.length}개 생성 완료` : '파일 생성 완료', state: 'done', ms: 0, detail: changed.map(f => f.path).join(', ').slice(0, 160) } });
          // :::files 블록은 화면에서 다운로드 카드로 바뀐다 (줄마다 "경로<TAB>바이트")
          const card = changed.length ? '\n\n:::files\n' + changed.map(f => `${f.path}\t${sizes.get(f.path) || 0}`).join('\n') + '\n:::\n' : '';
          const body = (r.text || '').trim() || (changed.length ? '요청하신 파일을 만들었어요.' : '파일을 만들지 못했어요. 요청을 조금 더 구체적으로 적어 주세요.');
          emit({ candidates: [{ content: { parts: [{ text: body + card }] } }] });
          if (lv) refund(cost - 1);   // 추론 모드에서 파일 도구로 처리한 경우 1회분만 차감
          emit({ gims: { used: usedOf(a, req) } });
          finish('done');
          return res.end();
        } catch (e) {
          if (ac.signal.aborted) { refund(); finish('cancelled'); return res.end(); }
          console.warn('[files] 도구 실패 → 일반 응답:', e.message);
          emit({ gims: { id: 'files', label: '파일 도구 실패 → 일반 답변', state: 'done', ms: 0, detail: String(e.message || '').slice(0, 80) } });
          // fall through
        }
      }

      if (early) openSSE();

      let sendContents = contents, sysInst = SYSTEM_INSTRUCTION;
      if (lv) {   // DeepSeek-R1 방식: 분석 → 풀이 N개 → 검증 → 수정 → (아래에서) 최종 답 스트리밍
        try {
          const r = await reasoning.prepare({ base: BASE, key: apiKey, model, contents, level: lv, signal: ac.signal, onStep: g => emit({ gims: g }), owner: a.user, datasets: store.list(a.user) });
          sendContents = r.contents; sysInst = { parts: [...SYSTEM_INSTRUCTION.parts, { text: r.system }] };
          console.log('[reason]', a.user, reason.level, JSON.stringify(r.stats));
          // 채팅·API·추론 단계/생각을 Mongo에 기록 (1초 주기 flush와 별도로 즉시 insert)
          db.logReason && db.logReason({ user: a.user, level: reason.level, model, stats: r.stats, system: String(r.system || '').slice(0, 4000), q: String((contents[contents.length-1]?.parts||[]).map(x=>x.text||'').join('')).slice(0, 2000) }).catch(()=>{});
        } catch (e) {
          if (ac.signal.aborted) { refund(); finish('cancelled'); return res.end(); }
          console.warn('[reason] 실패 → 일반 응답으로 대체:', e.message);
          refund(cost - 1);
          emit({ gims: { id: 'fallback', label: '추론 실패 → 일반 답변으로 진행', state: 'done', ms: 0, detail: String(e.message || '').slice(0, 80), used: usedOf(a, req) } });
        }
        emit({ gims: { id: 'final', label: '최종 답 작성', state: 'start' } });
      }

      const bail = (code, msg, raw) => {
        refund(); finish(ac.signal.aborted ? 'cancelled' : 'error', msg);
        if (early) { emit({ gims: { used: usedOf(a, req) } }); emit({ error: { message: msg } }); return res.end(); }
        if (raw !== undefined) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...H(usedOf(a, req)) }); return res.end(raw); }
        return fail(res, code, msg, H(usedOf(a, req)));
      };
      let up;
      try {
        up = await gemini.streamGenerateContent({
          base: BASE, key: apiKey, model, signal: ac.signal,
          body: { contents: sendContents, systemInstruction: sysInst, generationConfig: gen }
        });
      } catch (e) {
        const msg = e.friendly ? e.message : (e.message || 'Gemini에 연결하지 못했습니다.');
        return bail(e.status === 429 ? 429 : 502, msg);
      }
      if (!early) openSSE();
      if (!job) return Readable.fromWeb(up.body).on('error', () => res.end()).pipe(res);
      // 작업 모드: 업스트림을 직접 읽어 (1) 답변을 기록하고 (2) 연결돼 있으면 그대로 전달한다
      try {
        const reader = up.body.getReader(), dec = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const s = dec.decode(value, { stream: true });
          job.feed(s);
          if (!res.writableEnded && !res.destroyed) res.write(s);
        }
        job.flush();
        if (!job.answer.trim() && job.error) { refund(); finish('error'); } else finish('done');
      } catch (e) {
        if (!job.answer.trim()) refund();
        finish(ac.signal.aborted ? 'cancelled' : 'error', e.message);
      }
      return res.end();
    }
    fail(res, 404, 'Not found');
  } catch (err) { if (!res.headersSent) fail(res, 500, err.message || '서버 오류'); else res.end(); }
});

(async () => {
  db = await dbmod.init({ uri: process.env.DB || process.env.MONGODB_URI, dbName: process.env.MONGODB_DB || 'gimsai', dataDir: DATA });
  Object.assign(cfg, db.data.cfg); Object.assign(users, db.data.users); Object.assign(sess, db.data.sess); usage = db.data.usage;
  ensureAdmin();
  server.listen(PORT, () => console.log(`Gims AI → http://localhost:${PORT}  [저장소: ${db.kind}]  (관리자 IP: ${ADMIN_IPS.join(', ') || '없음'}, 기본 일일 한도: ${DAILY_LIMIT}, 인증 보너스: +${VERIFY_BONUS})`));
  const bye = async () => { try { await db.close(); } catch {} process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
})().catch(e => { console.error('시작 실패:', e.message); process.exit(1); });
