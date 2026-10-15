'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { WebSocketServer, WebSocket } = require('ws');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT) || 10000;
const HOST = '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'accounts.json');
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(48).toString('hex');
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;
const MAX_PLAYERS = 80;
const ALLOWED_ORIGINS = new Set((process.env.ALLOWED_ORIGINS || '').split(',').map(s=>s.trim()).filter(Boolean));
fs.mkdirSync(DATA_DIR, {recursive:true});
let db={users:{},states:{}};
try { const parsed=JSON.parse(fs.readFileSync(DB_FILE,'utf8')); if(parsed&&parsed.users&&parsed.states)db=parsed; } catch(e) { if(e.code!=='ENOENT') console.error('Account store could not be read:',e.message); }
function persist(){const tmp=DB_FILE+'.tmp';fs.writeFileSync(tmp,JSON.stringify(db));fs.renameSync(tmp,DB_FILE);}
const appLimiter=rateLimit({windowMs:60000,limit:120,standardHeaders:'draft-7',legacyHeaders:false});
const authLimiter=rateLimit({windowMs:15*60*1000,limit:12,standardHeaders:'draft-7',legacyHeaders:false,message:{error:'로그인/가입 시도가 너무 많습니다. 잠시 후 다시 시도하세요.'}});

const SHOP_W = [null,{name:'철검',cost:80},{name:'강철검',cost:300},{name:'미스릴검',cost:900},{name:'용사검',cost:2500},{name:'마검',cost:7000},{name:'드래곤 슬레이어',cost:18000},{name:'신검',cost:45000}];
const SHOP_A = [null,{name:'가죽갑옷',cost:80},{name:'사슬갑옷',cost:250},{name:'철갑옷',cost:700},{name:'강철갑옷',cost:1800},{name:'미스릴 갑옷',cost:4500},{name:'용비늘 갑옷',cost:11000},{name:'성기사 갑옷',cost:28000},{name:'암흑왕 갑옷',cost:65000}];
const SHOP_P = [{name:'체력 물약',cost:15},{name:'고급 물약',cost:45},{name:'대형 물약',cost:120},{name:'엘릭서',cost:500}];
const QUESTS = {
  s1:{name:'슬라임 사냥',need:5,coin:80,xp:40}, m1:{name:'버섯 소탕',need:6,coin:150,xp:90},
  w1:{name:'늑대 퇴치',need:8,coin:300,xp:180}, b1:{name:'불곰 사냥',need:5,coin:550,xp:350},
  g1:{name:'고블린 소탕',need:10,coin:900,xp:700}, o1:{name:'오크 전사 토벌',need:6,coin:1500,xp:1100},
  k1:{name:'해골 군단',need:10,coin:2400,xp:1800}, h1:{name:'유령 퇴치',need:8,coin:3800,xp:3000},
  l1:{name:'골렘 파괴',need:3,coin:6500,xp:5500}, d1:{name:'용 사냥',need:1,coin:14000,xp:13000}
};

// ===== 서버 몬스터 정의 (공유 월드) =====
const MT = {
  slime:    {hp:30,  dmg:6,  xp:12,  g:3,  sp:3.6, r:[21,40],  n:12, sc:1,   reach:1.8, rt:8},
  wolf:     {hp:55,  dmg:10, xp:20,  g:6,  sp:8,   r:[46,60],  n:10, sc:1,   reach:2.2, rt:8},
  goblin:   {hp:90,  dmg:14, xp:32,  g:10, sp:5,   r:[66,78],  n:8,  sc:1.1, reach:2.3, rt:10},
  skeleton: {hp:140, dmg:20, xp:55,  g:18, sp:5.5, r:[83,90],  n:7,  sc:1.15,reach:2.4, rt:12},
  golem:    {hp:500, dmg:38, xp:220, g:90, sp:3,   r:[94,98],  n:3,  sc:2.4, reach:4.4, rt:30}
};
const monsters = new Map(); // id -> {id,type,x,z,hp,mhp,dead,rt,face}
let monsterSeq = 0;
function rnd(a,b){return a+Math.random()*(b-a);}
function spawnMonster(type){
  const d=MT[type]; if(!d) return null;
  const a=Math.random()*Math.PI*2, r=rnd(d.r[0],d.r[1]);
  const id='m'+(++monsterSeq);
  const m={id,type,x:Math.cos(a)*r,z:Math.sin(a)*r,hp:d.hp,mhp:d.hp,dead:false,rt:0,face:0};
  monsters.set(id,m);
  return m;
}
function initMonsters(){
  for(const [type,d] of Object.entries(MT)){
    for(let i=0;i<d.n;i++) spawnMonster(type);
  }
  console.log('Server monsters spawned:', monsters.size);
}
initMonsters();

function monsterSnapshot(){
  return [...monsters.values()].map(m=>({id:m.id,type:m.type,x:+m.x.toFixed(2),z:+m.z.toFixed(2),hp:Math.ceil(m.hp),mhp:m.mhp,dead:!!m.dead,face:+(m.face||0).toFixed(3)}));
}

app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'","'unsafe-inline'",'https://cdnjs.cloudflare.com'],styleSrc:["'self'","'unsafe-inline'"],connectSrc:["'self'","ws:","wss:"],imgSrc:["'self'","data:"],fontSrc:["'self'","data:"],objectSrc:["'none'"],baseUri:["'self'"],frameAncestors:["'none'"],upgradeInsecureRequests:null}},crossOriginEmbedderPolicy:false,referrerPolicy:{policy:'no-referrer'}}));
app.use(appLimiter);
app.use(express.json({limit:'32kb',strict:true}));
app.use(express.text({type:'text/plain',limit:'32kb'}));
function safeEqual(a,b){const aa=Buffer.from(a),bb=Buffer.from(b);return aa.length===bb.length&&crypto.timingSafeEqual(aa,bb);}
function hashPassword(password,salt){return crypto.scryptSync(password,salt,64).toString('hex');}
function validUsername(s){return typeof s==='string'&&/^[A-Za-z0-9_가-힣.-]{3,24}$/.test(s);}
function usernameKey(s){return s.toLocaleLowerCase('en-US');}
function validPassword(s){return typeof s==='string'&&s.length>=8&&s.length<=128;}
function sign(payload){const body=Buffer.from(JSON.stringify(payload)).toString('base64url');const sig=crypto.createHmac('sha256',SESSION_SECRET).update(body).digest('base64url');return body+'.'+sig;}
function unsign(token){if(typeof token!=='string')return null;const [body,sig]=token.split('.');if(!body||!sig)return null;const expected=crypto.createHmac('sha256',SESSION_SECRET).update(body).digest('base64url');if(!safeEqual(sig,expected))return null;try{const p=JSON.parse(Buffer.from(body,'base64url').toString());if(!p.u||!p.exp||p.exp<Date.now())return null;return p;}catch{return null;}}
function cookie(res,token){res.setHeader('Set-Cookie',`rpg_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS/1000)}`);}
function clearCookie(res){res.setHeader('Set-Cookie','rpg_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');}
function userFromReq(req){const cookies=String(req.headers.cookie||'').split(';').map(x=>x.trim());const item=cookies.find(x=>x.startsWith('rpg_session='));if(!item)return null;const payload=unsign(decodeURIComponent(item.slice('rpg_session='.length)));return payload&&db.users[payload.u]?payload.u:null;}
function requireUser(req,res,next){const u=userFromReq(req);if(!u)return res.status(401).json({error:'로그인이 필요합니다.'});req.userKey=u;next();}
function publicName(key){return db.users[key].username;}

// ===== 관리자 계정 시드 (ADMIN) =====
(function seedAdmin(){
  const key = usernameKey('ADMIN');
  if(!db.users[key]){
    const salt = crypto.randomBytes(16).toString('hex');
    const password = 'a20140205';
    db.users[key] = {
      username: 'ADMIN',
      passwordHash: hashPassword(password, salt),
      salt,
      createdAt: Date.now(),
      isAdmin: true,
      banned: false
    };
    db.states[key] = null;
    try { persist(); console.log('Admin account seeded: ADMIN'); } catch(e) {}
  } else {
    db.users[key].isAdmin = true;
    db.users[key].banned = !!db.users[key].banned;
  }
  if(!db.bans) db.bans = {};
})();

function ensurePlayer(key){
  if(!db.states[key] || !db.states[key].player){
    db.states[key]={version:1,player:{x:0,z:8,y:0,hp:100,mhp:100,lv:1,xp:0,nx:30,coin:0,at:0,face:0,inv:0,w:0,a:0,pot:[2,0,0,0],rg:0,ow:[0],oa:[0],qa:{},qd:[],questProgress:{}},camera:{},savedAt:Date.now()};
  }
  const p=db.states[key].player;
  if(!Array.isArray(p.pot)) p.pot=[2,0,0,0];
  while(p.pot.length<4) p.pot.push(0);
  if(!Array.isArray(p.ow)) p.ow=[0];
  if(!Array.isArray(p.oa)) p.oa=[0];
  if(!p.qa || typeof p.qa!=='object') p.qa={};
  if(!Array.isArray(p.qd)) p.qd=[];
  if(!p.questProgress || typeof p.questProgress!=='object') p.questProgress={};
  return p;
}
function cleanState(input){
 if(!input||typeof input!=='object'||Array.isArray(input))return null;
 const p=input.player,c=input.camera;if(!p||typeof p!=='object'||Array.isArray(p))return null;
 const fields=['x','z','y','hp','mhp','lv','xp','nx','coin','at','face','inv','w','a','rg'],player={};
 for(const k of fields){const v=p[k];if(typeof v==='number'&&Number.isFinite(v))player[k]=Math.max(-1000000,Math.min(1000000,v));}
 player.x=Math.max(-220,Math.min(220,Number(player.x)||0));player.z=Math.max(-220,Math.min(220,Number(player.z)||0));
 player.lv=Math.max(1,Math.min(999,Math.floor(Number(player.lv)||1)));player.mhp=Math.max(1,Math.min(100000,Number(player.mhp)||100));player.hp=Math.max(0,Math.min(player.mhp,Number(player.hp)||0));
 player.coin=Math.max(0,Math.min(1e9,Math.floor(Number(player.coin)||0)));player.xp=Math.max(0,Math.min(1e9,Math.floor(Number(player.xp)||0)));
 player.pot=Array.isArray(p.pot)?p.pot.slice(0,8).map(v=>Math.max(0,Math.min(999,Math.floor(Number(v)||0)))):[2,0,0,0];
 if(Array.isArray(p.ow)) player.ow=p.ow.filter(v=>Number.isInteger(v)&&v>=0&&v<20).slice(0,20);
 if(Array.isArray(p.oa)) player.oa=p.oa.filter(v=>Number.isInteger(v)&&v>=0&&v<20).slice(0,20);
 if(p.qa && typeof p.qa==='object') player.qa=p.qa;
 if(Array.isArray(p.qd)) player.qd=p.qd.filter(v=>typeof v==='string').slice(0,100);
 if(p.questProgress && typeof p.questProgress==='object') player.questProgress=p.questProgress;
 const camera={};if(c&&typeof c==='object'){for(const k of ['yaw','pit','dist'])if(Number.isFinite(c[k]))camera[k]=Math.max(-1000,Math.min(1000,c[k]));}
 return {version:1,player,camera,savedAt:Date.now()};
}
app.post('/api/register',authLimiter,(req,res)=>{
 const {username,password}=req.body||{};
 if(!validUsername(username))return res.status(400).json({error:'아이디는 한글/영문/숫자/._- 조합으로 3~24자 입력하세요.'});
 if(!validPassword(password))return res.status(400).json({error:'비밀번호는 8~128자로 입력하세요.'});
 const key=usernameKey(username);
 if(db.users[key])return res.status(409).json({error:'이미 사용 중인 아이디입니다.'});
 const salt=crypto.randomBytes(16).toString('hex');
 db.users[key]={username,passwordHash:hashPassword(password,salt),salt,createdAt:Date.now()};
 db.states[key]=null;persist();
 const token=sign({u:key,exp:Date.now()+SESSION_TTL_MS});cookie(res,token);
 res.status(201).json({user:username,state:null});
});
app.post('/api/login',authLimiter,(req,res)=>{
 const {username,password}=req.body||{};if(typeof username!=='string'||typeof password!=='string')return res.status(400).json({error:'아이디와 비밀번호를 입력하세요.'});
 const key=usernameKey(username),u=db.users[key];
 const salt=u?u.salt:'00000000000000000000000000000000';
 const actual=hashPassword(password,salt),expected=u?u.passwordHash:'0'.repeat(128);
 if(!u||!safeEqual(actual,expected))return res.status(401).json({error:'아이디 또는 비밀번호가 올바르지 않습니다.'});
 if(u.banned||(db.bans&&db.bans[key]))return res.status(403).json({error:'차단된 계정입니다.'});
 cookie(res,sign({u:key,exp:Date.now()+SESSION_TTL_MS}));
 res.json({user:u.username,state:db.states[key]||null,isAdmin:!!u.isAdmin});
});
app.get('/api/me',(req,res)=>{const key=userFromReq(req);if(!key)return res.status(401).json({error:'로그인이 필요합니다.'});const u=db.users[key];if(u.banned||(db.bans&&db.bans[key]))return res.status(403).json({error:'차단된 계정입니다.'});res.json({user:publicName(key),state:db.states[key]||null,isAdmin:!!u.isAdmin});});
app.post('/api/save',requireUser,(req,res)=>{const state=cleanState(req.body&&req.body.state);if(!state)return res.status(400).json({error:'저장 데이터 형식이 올바르지 않습니다.'});db.states[req.userKey]=state;try{persist();res.json({ok:true,savedAt:state.savedAt});}catch(e){console.error('Persist failed',e);res.status(500).json({error:'서버 저장에 실패했습니다.'});}});
app.post('/api/save-beacon',(req,res)=>{const key=userFromReq(req);if(!key)return res.status(401).end();let body=req.body;if(typeof body==='string'){try{body=JSON.parse(body);}catch{return res.status(400).end();}}const state=cleanState(body&&body.state);if(!state)return res.status(400).end();db.states[key]=state;try{persist();res.status(204).end();}catch(e){res.status(500).end();}});
app.post('/api/logout',(req,res)=>{clearCookie(res);res.json({ok:true});});

app.post('/api/buy', requireUser, (req, res) => {
  const body = req.body || {};
  const type = body.type;
  let index = body.index;
  let amount = body.amount == null ? 1 : body.amount;
  if (type !== 'w' && type !== 'a' && type !== 'p') return res.status(400).json({ error: '상품 종류가 올바르지 않습니다.' });
  if (!Number.isInteger(index) || index < 0) return res.status(400).json({ error: '상품 번호가 올바르지 않습니다.' });
  if (!Number.isInteger(amount) || amount < 1 || amount > 99) return res.status(400).json({ error: '수량이 올바르지 않습니다.' });
  const player = ensurePlayer(req.userKey);
  let cost = 0, name = '';
  if (type === 'p') {
    if (!SHOP_P[index]) return res.status(400).json({ error: '존재하지 않는 물약입니다.' });
    cost = SHOP_P[index].cost * amount; name = SHOP_P[index].name;
  } else if (type === 'w') {
    if (!SHOP_W[index]) return res.status(400).json({ error: '존재하지 않는 무기입니다.' });
    if (player.ow.includes(index)) return res.status(400).json({ error: '이미 보유한 무기입니다.' });
    cost = SHOP_W[index].cost; name = SHOP_W[index].name; amount = 1;
  } else {
    if (!SHOP_A[index]) return res.status(400).json({ error: '존재하지 않는 방어구입니다.' });
    if (player.oa.includes(index)) return res.status(400).json({ error: '이미 보유한 방어구입니다.' });
    cost = SHOP_A[index].cost; name = SHOP_A[index].name; amount = 1;
  }
  if ((player.coin || 0) < cost) return res.status(400).json({ error: '코인이 부족합니다.', need: cost, have: player.coin || 0 });
  player.coin -= cost;
  if (type === 'p') player.pot[index] = (player.pot[index] || 0) + amount;
  else if (type === 'w') { if (!player.ow.includes(index)) player.ow.push(index); player.w = index; }
  else { if (!player.oa.includes(index)) player.oa.push(index); player.a = index; }
  db.states[req.userKey].savedAt = Date.now();
  try { persist(); res.json({ ok:true, type, index, amount, name, coin:player.coin, pot:player.pot, w:player.w, a:player.a, ow:player.ow, oa:player.oa }); }
  catch(e){ res.status(500).json({ error:'저장 실패' }); }
});

app.post('/api/quest/accept', requireUser, (req, res) => {
  const { questId } = req.body || {};
  if (typeof questId !== 'string' || !/^[A-Za-z0-9_-]{1,24}$/.test(questId)) return res.status(400).json({ error: '존재하지 않는 퀘스트입니다.' });
  const player = ensurePlayer(req.userKey);
  if (player.qd.includes(questId)) return res.status(400).json({ error: '이미 완료한 퀘스트입니다.' });
  if (player.qa[questId] !== undefined) return res.status(400).json({ error: '이미 수락한 퀘스트입니다.' });
  if (Object.keys(player.qa).length >= 5) return res.status(400).json({ error: '퀘스트는 동시에 5개까지 받을 수 있습니다.' });
  player.qa[questId] = 0; player.questProgress[questId] = 0;
  db.states[req.userKey].savedAt = Date.now();
  try { persist(); res.json({ ok:true, questId, qa:player.qa }); } catch(e){ res.status(500).json({ error:'저장 실패' }); }
});
app.post('/api/quest/progress', requireUser, (req, res) => {
  const { questId, progress } = req.body || {};
  if (typeof questId !== 'string' || !/^[A-Za-z0-9_-]{1,24}$/.test(questId)) return res.status(400).json({ error: '존재하지 않는 퀘스트입니다.' });
  if (!Number.isInteger(progress) || progress < 0 || progress > 100000) return res.status(400).json({ error: '진행도가 올바르지 않습니다.' });
  const player = ensurePlayer(req.userKey);
  if (player.qa[questId] === undefined) return res.status(400).json({ error: '수락하지 않은 퀘스트입니다.' });
  const need = (QUESTS[questId] && QUESTS[questId].need) || 100000;
  const cur = player.questProgress[questId] || 0;
  const next = Math.max(cur, Math.min(progress, need));
  player.questProgress[questId] = next; player.qa[questId] = next;
  db.states[req.userKey].savedAt = Date.now();
  try { persist(); res.json({ ok:true, questId, progress:next }); } catch(e){ res.status(500).json({ error:'저장 실패' }); }
});
app.post('/api/quest/complete', requireUser, (req, res) => {
  const { questId, rewardCoin, rewardXp, need } = req.body || {};
  if (typeof questId !== 'string' || !/^[A-Za-z0-9_-]{1,24}$/.test(questId)) return res.status(400).json({ error: '존재하지 않는 퀘스트입니다.' });
  const player = ensurePlayer(req.userKey);
  if (player.qa[questId] === undefined) return res.status(400).json({ error: '수락하지 않은 퀘스트입니다.' });
  if (player.qd.includes(questId)) return res.status(400).json({ error: '이미 완료한 퀘스트입니다.' });
  const def = QUESTS[questId];
  const needN = def ? def.need : (Number.isInteger(need) ? Math.min(100000, Math.max(1, need)) : 1);
  const coinR = def ? def.coin : Math.max(0, Math.min(1e7, Math.floor(Number(rewardCoin) || 0)));
  const xpR = def ? def.xp : Math.max(0, Math.min(1e7, Math.floor(Number(rewardXp) || 0)));
  const prog = player.questProgress[questId] || player.qa[questId] || 0;
  if (prog < needN) return res.status(400).json({ error: '아직 퀘스트 조건을 충족하지 않았습니다.', progress: prog, need: needN });
  player.coin = (player.coin || 0) + coinR;
  player.xp = (player.xp || 0) + xpR;
  delete player.qa[questId];
  if (!player.qd.includes(questId)) player.qd.push(questId);
  db.states[req.userKey].savedAt = Date.now();
  try { persist(); res.json({ ok:true, questId, reward:{coin:coinR,xp:xpR}, coin:player.coin, xp:player.xp, qa:player.qa, qd:player.qd }); }
  catch(e){ res.status(500).json({ error:'저장 실패' }); }
});

function requireAdmin(req,res,next){
  const key=userFromReq(req);
  if(!key) return res.status(401).json({error:'로그인이 필요합니다.'});
  if(!db.users[key]||!db.users[key].isAdmin) return res.status(403).json({error:'관리자 권한이 없습니다.'});
  req.userKey=key; next();
}
app.get('/api/admin/users', requireAdmin, (req,res)=>{
  const list=[];
  for(const [key,u] of Object.entries(db.users)){
    const st=db.states[key]&&db.states[key].player;
    list.push({
      key, username:u.username, isAdmin:!!u.isAdmin,
      banned:!!(u.banned||(db.bans&&db.bans[key])),
      createdAt:u.createdAt||0,
      lv: st?st.lv:1, coin: st?st.coin:0, xp: st?st.xp:0
    });
  }
  list.sort((a,b)=> (b.createdAt||0)-(a.createdAt||0));
  res.json({users:list});
});
app.post('/api/admin/ban', requireAdmin, (req,res)=>{
  const {username, banned=true} = req.body||{};
  if(typeof username!=='string') return res.status(400).json({error:'아이디가 필요합니다.'});
  const key=usernameKey(username);
  const u=db.users[key];
  if(!u) return res.status(404).json({error:'사용자를 찾을 수 없습니다.'});
  if(u.isAdmin) return res.status(400).json({error:'관리자는 차단할 수 없습니다.'});
  u.banned=!!banned;
  if(!db.bans) db.bans={};
  if(banned) db.bans[key]=Date.now(); else delete db.bans[key];
  try{persist(); res.json({ok:true, username:u.username, banned:!!u.banned});}
  catch(e){res.status(500).json({error:'저장 실패'});}
});
app.post('/api/admin/set-level', requireAdmin, (req,res)=>{
  const {username, level} = req.body||{};
  if(typeof username!=='string') return res.status(400).json({error:'아이디가 필요합니다.'});
  const lv=Math.floor(Number(level));
  if(!Number.isFinite(lv)||lv<1||lv>999) return res.status(400).json({error:'레벨은 1~999입니다.'});
  const key=usernameKey(username);
  if(!db.users[key]) return res.status(404).json({error:'사용자를 찾을 수 없습니다.'});
  const p=ensurePlayer(key);
  p.lv=lv;
  // rough xp curve reset
  p.nx = Math.max(30, lv*30);
  db.states[key].savedAt=Date.now();
  try{persist(); res.json({ok:true, username:db.users[key].username, lv:p.lv});}
  catch(e){res.status(500).json({error:'저장 실패'});}
});
app.post('/api/admin/give-coin', requireAdmin, (req,res)=>{
  const {username, amount} = req.body||{};
  if(typeof username!=='string') return res.status(400).json({error:'아이디가 필요합니다.'});
  const amt=Math.floor(Number(amount));
  if(!Number.isFinite(amt)||amt===0||Math.abs(amt)>1e9) return res.status(400).json({error:'코인 수량이 올바르지 않습니다.'});
  const key=usernameKey(username);
  if(!db.users[key]) return res.status(404).json({error:'사용자를 찾을 수 없습니다.'});
  const p=ensurePlayer(key);
  p.coin=Math.max(0, Math.min(1e9, (p.coin||0)+amt));
  db.states[key].savedAt=Date.now();
  try{persist(); res.json({ok:true, username:db.users[key].username, coin:p.coin});}
  catch(e){res.status(500).json({error:'저장 실패'});}
});

app.get('/healthz',(_req,res)=>res.json({ok:true, monsters:monsters.size}));
app.use(express.static(path.join(__dirname,'public'),{index:'index.html',dotfiles:'deny',maxAge:'1h',setHeaders(res,p){if(p.endsWith('.html'))res.setHeader('Cache-Control','no-cache');res.setHeader('X-Content-Type-Options','nosniff');}}));
app.use((err,_req,res,_next)=>{if(res.headersSent)return;res.status(400).json({error:'요청을 처리할 수 없습니다.'});});

const server=app.listen(PORT,HOST,()=>console.log(`RPG server listening on ${HOST}:${PORT}; data=${DB_FILE}`));
const wss=new WebSocketServer({noServer:true,maxPayload:2048,perMessageDeflate:false});
const players=new Map(), socketsByIp=new Map();

function allowedOrigin(origin,req){if(!origin)return false;if(ALLOWED_ORIGINS.has(origin))return true;try{const u=new URL(origin),secure=String(req.headers['x-forwarded-proto']||'').split(',')[0].trim()==='https';return u.host===req.headers.host&&u.protocol===(secure?'https:':'http:');}catch{return false;}}
function broadcast(data,except){const raw=JSON.stringify(data);for(const c of wss.clients)if(c!==except&&c.readyState===WebSocket.OPEN)try{c.send(raw);}catch{}}
function broadcastAll(data){const raw=JSON.stringify(data);for(const c of wss.clients)if(c.readyState===WebSocket.OPEN)try{c.send(raw);}catch{}}

function userFromWsReq(req){
  const cookies=String(req.headers.cookie||'').split(';').map(x=>x.trim());
  const item=cookies.find(x=>x.startsWith('rpg_session='));
  if(!item) return null;
  const payload=unsign(decodeURIComponent(item.slice('rpg_session='.length)));
  if(!payload||!db.users[payload.u]) return null;
  return { key: payload.u, username: db.users[payload.u].username };
}

server.on('upgrade',(req,socket,head)=>{
  let pathname; try{pathname=new URL(req.url,'http://localhost').pathname;}catch{socket.destroy();return;}
  if(pathname!=='/ws'||!allowedOrigin(req.headers.origin,req)){socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');socket.destroy();return;}
  const ip=String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim();
  if((socketsByIp.get(ip)||0)>=4||players.size>=MAX_PLAYERS){socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');socket.destroy();return;}
  wss.handleUpgrade(req,socket,head,ws=>{
    ws._ip=ip;
    socketsByIp.set(ip,(socketsByIp.get(ip)||0)+1);
    // 로그인 닉네임을 멀티플레이 이름으로 사용
    const auth=userFromWsReq(req);
    if(auth && db.users[auth.key] && (db.users[auth.key].banned || (db.bans&&db.bans[auth.key]))){
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    ws._userKey=auth?auth.key:null;
    ws._username=auth?auth.username:null;
    wss.emit('connection',ws,req);
  });
});

wss.on('connection',ws=>{
  ws.isAlive=true; ws.last=0;
  const id=crypto.randomUUID();
  // 회원가입/로그인 닉네임이 있으면 그 이름, 없으면 익명
  const displayName = ws._username || ('플레이어-'+id.slice(0,4));
  const p={id, name:displayName, x:0, z:8, y:0, face:0, pvp:false, hp:100, mhp:100};
  players.set(id,p); ws.player=p;

  // 접속 시: 다른 플레이어 + 서버 몬스터 전체 상태 전송
  ws.send(JSON.stringify({
    type:'welcome',
    id,
    name: displayName,
    players:[...players.values()].filter(x=>x.id!==id),
    monsters: monsterSnapshot()
  }));
  broadcast({type:'join', player:p}, ws);

  ws.on('pong',()=>ws.isAlive=true);
  ws.on('message',(data,binary)=>{
    const now=Date.now();
    if(binary||data.length>2048||now-ws.last<50){ws.strikes=(ws.strikes||0)+1;if(ws.strikes>5)ws.close(1008,'rate limit');return;}
    ws.last=now;
    let m; try{m=JSON.parse(data.toString());}catch{ws.close(1007,'json');return;}
    if(!m||typeof m.type!=='string') return;

    if(m.type==='move'){
      if(!Number.isFinite(m.x)||!Number.isFinite(m.z)||!Number.isFinite(m.y)||!Number.isFinite(m.face)||Math.abs(m.x)>230||Math.abs(m.z)>230||m.y<0||m.y>40){
        ws.strikes=(ws.strikes||0)+1; if(ws.strikes>=5)ws.close(1008,'state'); return;
      }
      Object.assign(p,{x:m.x,z:m.z,y:m.y,face:m.face});
      if(typeof m.pvp==='boolean') p.pvp=m.pvp;
      if(Number.isFinite(m.hp)) p.hp=Math.max(0,Math.min(1e6,m.hp));
      if(Number.isFinite(m.mhp)) p.mhp=Math.max(1,Math.min(1e6,m.mhp));
      broadcast({type:'state',player:p},ws);
      return;
    }
    // PvP 공격: 양쪽 모두 pvp ON 일 때만
    if(m.type==='pvp_hit'){
      if(typeof m.targetId!=='string'||!Number.isFinite(m.dmg)) return;
      if(!p.pvp) return;
      const targetPlayer=[...players.values()].find(x=>x.id===m.targetId);
      if(!targetPlayer||!targetPlayer.pvp) return;
      const dist=Math.hypot(targetPlayer.x-p.x, targetPlayer.z-p.z);
      if(dist>8) return;
      const dmg=Math.max(1,Math.min(500,Math.floor(m.dmg)));
      targetPlayer.hp=Math.max(0,(targetPlayer.hp||100)-dmg);
      broadcastAll({type:'pvp_damage', from:p.id, to:targetPlayer.id, dmg, hp:targetPlayer.hp, name:p.name});
      return;
    }

    // 서버 권한 공격: 클라이언트가 몬스터 id + 데미지 요청
    if(m.type==='hit'){
      if(typeof m.id!=='string'||!Number.isFinite(m.dmg)) return;
      const mon=monsters.get(m.id);
      if(!mon||mon.dead) return;
      const dmg=Math.max(1, Math.min(5000, Math.floor(m.dmg)));
      // 거리 대략 검증 (치트 완화)
      const dist=Math.hypot(mon.x-p.x, mon.z-p.z);
      const def=MT[mon.type];
      if(dist > (def?def.reach:2)+6) return;
      mon.hp -= dmg;
      if(mon.hp<=0){
        mon.hp=0; mon.dead=true; mon.rt=def?def.rt:10;
        const reward={coin:def?def.g:0, xp:def?def.xp:0, type:mon.type};
        // 공격자에게만 보상 알림
        try{ ws.send(JSON.stringify({type:'kill', id:mon.id, reward})); }catch{}
        broadcastAll({type:'monster', monster:{id:mon.id,type:mon.type,x:mon.x,z:mon.z,hp:0,mhp:mon.mhp,dead:true,face:mon.face}});
      } else {
        broadcastAll({type:'monster', monster:{id:mon.id,type:mon.type,x:+mon.x.toFixed(2),z:+mon.z.toFixed(2),hp:Math.ceil(mon.hp),mhp:mon.mhp,dead:false,face:+(mon.face||0).toFixed(3)}});
      }
      return;
    }
  });

  ws.on('close',()=>{
    players.delete(p.id);
    broadcast({type:'leave',id:p.id});
    const n=(socketsByIp.get(ws._ip)||1)-1;
    if(n>0)socketsByIp.set(ws._ip,n); else socketsByIp.delete(ws._ip);
  });
  ws.on('error',()=>{});
  ws._heartbeat=setInterval(()=>{
    if(!ws.isAlive){ws.terminate();clearInterval(ws._heartbeat);return;}
    ws.isAlive=false; ws.ping();
  },30000);
});

// ===== 서버 몬스터 AI / 리스폰 루프 (100ms) =====
setInterval(()=>{
  const dt=0.1;
  // 가장 가까운 플레이어에게 접근
  const plist=[...players.values()];
  for(const mon of monsters.values()){
    const def=MT[mon.type]; if(!def) continue;
    if(mon.dead){
      mon.rt -= dt;
      if(mon.rt<=0){
        const a=Math.random()*Math.PI*2, r=rnd(def.r[0],def.r[1]);
        mon.x=Math.cos(a)*r; mon.z=Math.sin(a)*r;
        mon.hp=def.hp; mon.mhp=def.hp; mon.dead=false; mon.rt=0;
        broadcastAll({type:'monster', monster:{id:mon.id,type:mon.type,x:+mon.x.toFixed(2),z:+mon.z.toFixed(2),hp:mon.hp,mhp:mon.mhp,dead:false,face:0}});
      }
      continue;
    }
    let nearest=null, nd=1e9;
    for(const pl of plist){
      const d=Math.hypot(pl.x-mon.x, pl.z-mon.z);
      if(d<nd){nd=d; nearest=pl;}
    }
    if(nearest && nd<18 && nd>def.reach*0.6){
      const ang=Math.atan2(nearest.x-mon.x, nearest.z-mon.z);
      mon.face=ang;
      mon.x += Math.sin(ang)*def.sp*dt;
      mon.z += Math.cos(ang)*def.sp*dt;
    }
  }
  // 주기적으로 전체 스냅샷 (2초마다) — 동기화 보정
}, 100);

let snapTick=0;
setInterval(()=>{
  snapTick++;
  if(snapTick%20===0){ // 2초
    broadcastAll({type:'monsters', monsters:monsterSnapshot()});
  } else {
    // 살아있는 몬스터 위치만 가벼운 업데이트
    const live=[...monsters.values()].filter(m=>!m.dead).map(m=>({id:m.id,type:m.type,x:+m.x.toFixed(2),z:+m.z.toFixed(2),hp:Math.ceil(m.hp),mhp:m.mhp,dead:false,face:+(m.face||0).toFixed(3)}));
    if(live.length) broadcastAll({type:'monsters', monsters:live, partial:true});
  }
}, 100);

server.on('close',()=>{for(const ws of wss.clients)ws.terminate();});
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
process.on('SIGINT',()=>server.close(()=>process.exit(0)));
