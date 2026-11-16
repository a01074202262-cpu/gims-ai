'use strict';
/**
 * luau_analyzer.js — Luau / Roblox Lua 정적 분석기 (코드를 실행하지 않음)
 *
 * 토크나이저 + 재귀 하강 파서(Luau 구문: 타입 표기, type 별칭, 복합 대입, continue, if 식, `...{expr}...` 문자열,
 * :: 캐스트, 제네릭) + 스코프 분석.
 *
 * 찾는 것
 *  - 문법 오류: 줄·칸, 어느 줄의 블록이 안 닫혔는지, `!=`/`&&`/`||`/`++`/`=`(비교) 같은 흔한 실수 힌트
 *  - 정의되지 않은 변수·함수 (오타 후보), 위에서 쓰기 전에 아래에서 local 로 선언된 이름(순서 문제)
 *  - 내장 라이브러리/Roblox 자료형의 없는 멤버 (math.flor, string.Format, Vector3.New, task.Wait …)
 *  - 없는 서비스 이름 (game:GetService("Player")), 암묵 전역(local 누락), 정의되지 않은 테이블 필드
 *  - 사용하지 않는 local, 도달할 수 없는 코드, 반복문 밖 break/continue, 가변 인자 오용
 *  - Roblox 함정: 무한 루프(yield 없음), wait/spawn/delay 폐기, Instance.new 의 parent 인자,
 *    `.Destroy()` 처럼 : 대신 . 로 부른 메서드, FindFirstChild 결과를 바로 인덱싱, :Connect(f()) 로 호출 결과 연결
 */
const A = require('./js_analyzer');

// ---------------------------------------------------------------------------
// 이름 표
// ---------------------------------------------------------------------------
const W = s => s.split(/\s+/).filter(Boolean);
const LUAU_GLOBALS = new Set(W(`
  _G _VERSION assert collectgarbage error getfenv getmetatable ipairs loadstring newproxy next pairs pcall print rawequal rawget rawlen rawset
  require select setfenv setmetatable tonumber tostring type typeof unpack xpcall warn gcinfo
  bit32 buffer coroutine debug math os string table task utf8 vector`));
const ROBLOX_GLOBALS = new Set(W(`
  game workspace Workspace Game script plugin shared settings UserSettings stats version time tick wait spawn delay elapsedTime printidentity
  Axes BrickColor CFrame CatalogSearchParams Color3 ColorSequence ColorSequenceKeypoint DateTime DockWidgetPluginGuiInfo Faces Font
  Instance NumberRange NumberSequence NumberSequenceKeypoint OverlapParams PathWaypoint PhysicalProperties Random Ray RaycastParams
  RaycastResult RBXScriptConnection RBXScriptSignal Rect Region3 Region3int16 SharedTable TweenInfo UDim UDim2 Vector2 Vector2int16
  Vector3 Vector3int16 Enum Content PluginManager DebuggerManager`));
const LIB_MEMBERS = {
  math: W('abs acos asin atan atan2 ceil clamp cos cosh deg exp floor fmod frexp ldexp log log10 map max min modf noise pi huge pow rad random randomseed round sign sin sinh sqrt tan tanh'),
  string: W('byte char find format gmatch gsub len lower match pack packsize rep reverse split sub unpack upper'),
  table: W('clear clone concat create find foreach foreachi freeze getn insert isfrozen maxn move pack remove sort unpack'),
  task: W('cancel defer delay desynchronize spawn synchronize wait'),
  os: W('clock date difftime time'),
  coroutine: W('close create isyieldable resume running status wrap yield'),
  utf8: W('char charpattern codepoint codes len nfcnormalize nfdnormalize offset graphemes'),
  bit32: W('arshift band bnot bor btest bxor countlz countrz extract lrotate lshift replace rrotate rshift'),
  debug: W('info traceback profilebegin profileend setmemorycategory resetmemorycategory dumpcodesize'),
  buffer: W('create fromstring tostring len readi8 readu8 readi16 readu16 readi32 readu32 readf32 readf64 writei8 writeu8 writei16 writeu16 writei32 writeu32 writef32 writef64 readstring writestring copy fill readbits writebits'),
  Vector3: W('new zero one xAxis yAxis zAxis FromNormalId FromAxis'),
  Vector2: W('new zero one xAxis yAxis'),
  CFrame: W('new Angles lookAt lookAlong fromEulerAnglesXYZ fromEulerAnglesYXZ fromOrientation fromAxisAngle fromMatrix identity'),
  Color3: W('new fromRGB fromHSV fromHex'),
  UDim2: W('new fromScale fromOffset'),
  UDim: W('new'),
  Instance: W('new fromExisting'),
  TweenInfo: W('new'),
  Random: W('new'),
  Rect: W('new'),
  Ray: W('new'),
  Region3: W('new'),
  NumberRange: W('new'),
  NumberSequence: W('new'),
  NumberSequenceKeypoint: W('new'),
  ColorSequence: W('new'),
  ColorSequenceKeypoint: W('new'),
  RaycastParams: W('new'),
  OverlapParams: W('new'),
  DateTime: W('now fromUnixTimestamp fromUnixTimestampMillis fromIsoDate fromLocalTime fromUniversalTime'),
  PhysicalProperties: W('new'),
  Axes: W('new'),
  Faces: W('new')
};
const SERVICES = new Set(W(`
  AnalyticsService AssetService AvatarEditorService BadgeService CollectionService ContentProvider ContextActionService CoreGui
  DataStoreService Debris Chat ChangeHistoryService GamePassService GroupService GuiService HapticService HttpService InsertService
  KeyboardService LocalizationService LogService MarketplaceService MemoryStoreService MessagingService NetworkClient
  PathfindingService PhysicsService Players PolicyService ProximityPromptService RunService ReplicatedFirst ReplicatedStorage
  ScriptContext ServerScriptService ServerStorage SocialService SoundService StarterGui StarterPack StarterPlayer Stats
  StudioService TeamsService TeleportService TextChatService TextService ThreadService TweenService UserInputService
  VRService VirtualInputManager VoiceChatService Workspace Lighting Teams MaterialService SelectionService Selection
  UserService PlayerDataRecordConfig ExperienceService ExperienceNotificationService OpenCloudService BadgeService
  CaptureService GeometryService LanguageService PermissionsService SafetyService TimerService AvatarChatService
  CommerceService CookiesService DataModelPatchService FriendService LiveScriptingService`));
const INSTANCE_METHODS = new Set(W(`
  Destroy Clone FindFirstChild FindFirstChildOfClass FindFirstChildWhichIsA FindFirstAncestor FindFirstAncestorOfClass
  FindFirstAncestorWhichIsA WaitForChild GetChildren GetDescendants IsA IsDescendantOf IsAncestorOf Connect Once Disconnect Wait
  Fire FireServer FireClient FireAllClients InvokeServer InvokeClient SetAttribute GetAttribute GetService LoadAnimation Play Stop
  TakeDamage MoveTo PivotTo GetPivot SetPrimaryPartCFrame ClearAllChildren GetFullName AddTag HasTag RemoveTag GetTags
  Raycast Create GetPlayerFromCharacter GetPlayers LoadCharacter Kick SetNetworkOwner GetNetworkOwner ApplyImpulse
  BreakJoints GetMass GetTouchingParts`));
const NIL_RETURNING = new Set(W('FindFirstChild FindFirstChildOfClass FindFirstChildWhichIsA FindFirstAncestor FindFirstAncestorOfClass FindFirstAncestorWhichIsA'));
const ASYNC_NEEDS_PCALL = new Set(W('GetAsync SetAsync UpdateAsync IncrementAsync RemoveAsync PostAsync RequestAsync GetProductInfo UserOwnsGamePassAsync GetRankInGroup GetRoleInGroup IsInGroup GetGroupsAsync GetFriendsAsync SendMessageAsync PublishAsync'));
const SERVER_ONLY_SERVICES = new Set(W('DataStoreService ServerStorage ServerScriptService MessagingService MemoryStoreService HttpService'));
const CLIENT_ONLY_SERVICES = new Set(W('UserInputService ContextActionService StarterGui GuiService'));
const YIELDERS_DOT = new Set(['task.wait', 'task.yield', 'coroutine.yield']);
const YIELDERS_NAME = new Set(['wait']);
const YIELDERS_METHOD = new Set(['Wait', 'WaitForChild', 'InvokeServer', 'InvokeClient', 'Yield']);

// ---------------------------------------------------------------------------
// 토크나이저
// ---------------------------------------------------------------------------
const KEYWORDS = new Set(W('and break do else elseif end false for function if in local nil not or repeat return then true until while'));
class SyntaxErr extends Error {
  constructor(message, line, col, hint) { super(message); this.line = line; this.col = col; this.hint = hint || null; this.isSyntax = true; }
}
const isIdStart = c => /[A-Za-z_]/.test(c);
const isIdChar = c => /[A-Za-z0-9_]/.test(c);
const OPS3 = ['...', '..=', '//='];
const OPS2 = ['..', '::', '==', '~=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '^=', '//', '->', '!=', '&&', '||', '++', '--'];
const OPS1 = new Set('+-*/%^#&|<>=(){}[];:,.?~@!'.split(''));

function tokenize(src, base = { line: 1, col: 1, pos: 0 }) {
  const toks = [];
  let i = 0, line = base.line, col = base.col;
  const n = src.length;
  const adv = k => { for (let j = 0; j < k; j++) { if (src[i] === '\n') { line++; col = 1; } else col++; i++; } };
  const longBracket = at => { // [==[ 의 레벨을 돌려준다 (없으면 -1)
    if (src[at] !== '[') return -1;
    let j = at + 1, lvl = 0;
    while (src[j] === '=') { lvl++; j++; }
    return src[j] === '[' ? lvl : -1;
  };
  const readLong = (lvl, what, sl, sc) => {
    const open = lvl + 2, close = ']' + '='.repeat(lvl) + ']';
    const end = src.indexOf(close, i + open);
    if (end < 0) throw new SyntaxErr(`${what}이(가) 끝나지 않았습니다 (${close} 가 없음)`, sl, sc, `${what}을 ${close} 로 닫으세요`);
    const text = src.slice(i + open, end);
    adv(end + close.length - i);
    return text;
  };
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { adv(1); continue; }
    const sl = line, sc = col, sp = i;
    if (c === '-' && src[i + 1] === '-') {
      const lvl = longBracket(i + 2);
      if (lvl >= 0) { adv(2); readLong(lvl, '긴 주석', sl, sc); }
      else { while (i < n && src[i] !== '\n') adv(1); }
      continue;
    }
    if (isIdStart(c)) {
      let j = i; while (j < n && isIdChar(src[j])) j++;
      const w = src.slice(i, j); adv(j - i);
      toks.push({ t: KEYWORDS.has(w) ? 'kw' : 'name', v: w, line: sl, col: sc, pos: sp, end: i });
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      let m = /^0[xX][0-9a-fA-F_]+/.exec(src.slice(i, i + 80)) || /^0[bB][01_]+/.exec(src.slice(i, i + 80)) || /^(?:[0-9][0-9_]*)?\.?[0-9_]*(?:[eE][+-]?[0-9_]+)?/.exec(src.slice(i, i + 80));
      let text = m[0];
      if (/^\d+\.\.$/.test(text + src.slice(i + text.length, i + text.length + 1)) && src[i + text.length] === '.') { /* 1.. 은 1 .. */ }
      if (text.endsWith('.') && src[i + text.length] === '.') text = text.slice(0, -1);
      adv(text.length);
      if (i < n && isIdChar(src[i])) throw new SyntaxErr(`잘못된 숫자 표기입니다: '${text}${src[i]}…'`, sl, sc);
      toks.push({ t: 'num', v: text, line: sl, col: sc, pos: sp, end: i });
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1, ok = false;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '\n') break;
        if (src[j] === c) { ok = true; break; }
        j++;
      }
      if (!ok) throw new SyntaxErr('문자열이 줄 끝까지 닫히지 않았습니다', sl, sc, `닫는 따옴표(${c})가 빠졌거나, 여러 줄 문자열이면 [[ ]] 또는 \` \` 를 쓰세요`);
      const text = src.slice(i + 1, j); adv(j + 1 - i);
      toks.push({ t: 'str', v: text, line: sl, col: sc, pos: sp, end: i });
      continue;
    }
    if (c === '`') {
      let j = i + 1, ok = false; const exprs = [];
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '`') { ok = true; break; }
        if (src[j] === '{') {
          let d = 1, k = j + 1;
          while (k < n && d > 0) { if (src[k] === '{') d++; else if (src[k] === '}') d--; if (d > 0) k++; }
          if (d > 0) break;
          exprs.push({ text: src.slice(j + 1, k), offset: j + 1 });
          j = k + 1; continue;
        }
        j++;
      }
      if (!ok) throw new SyntaxErr('백틱 문자열이 닫히지 않았습니다', sl, sc, '닫는 ` 또는 {…} 의 } 가 빠졌는지 확인하세요');
      // 식 위치(줄·칸) 계산
      const before = src.slice(0, 0);
      const located = exprs.map(e => {
        const upto = src.slice(i, e.offset + i - i);
        let ln = sl, cl = sc;
        for (let q = i; q < e.offset; q++) { if (src[q] === '\n') { ln++; cl = 1; } else cl++; }
        return { text: e.text, line: ln, col: cl, pos: e.offset };
      });
      adv(j + 1 - i);
      toks.push({ t: 'istr', v: '`', exprs: located, line: sl, col: sc, pos: sp, end: i });
      continue;
    }
    if (c === '[') {
      const lvl = longBracket(i);
      if (lvl >= 0) {
        const text = readLong(lvl, '긴 문자열', sl, sc);
        toks.push({ t: 'str', v: text, line: sl, col: sc, pos: sp, end: i });
        continue;
      }
    }
    const o3 = src.substr(i, 3), o2 = src.substr(i, 2);
    let op = OPS3.includes(o3) ? o3 : OPS2.includes(o2) ? o2 : OPS1.has(c) ? c : null;
    if (!op) throw new SyntaxErr(`알 수 없는 문자 '${c}'`, sl, sc, c === '$' || c === '\\' ? "Lua 에서는 쓰지 않는 문자입니다" : null);
    adv(op.length);
    toks.push({ t: 'op', v: op, line: sl, col: sc, pos: sp, end: i });
  }
  toks.push({ t: 'eof', v: '<eof>', line, col, pos: i, end: i });
  return toks;
}

// ---------------------------------------------------------------------------
// 파서
// ---------------------------------------------------------------------------
const BIN = { 'or': [1, 1], 'and': [2, 2], '<': [3, 3], '>': [3, 3], '<=': [3, 3], '>=': [3, 3], '~=': [3, 3], '==': [3, 3], '..': [7, 6], '+': [8, 8], '-': [8, 8], '*': [9, 9], '/': [9, 9], '//': [9, 9], '%': [9, 9], '^': [14, 13] };
const UNARY_PRI = 12;
const COMPOUND = new Set(['+=', '-=', '*=', '/=', '//=', '%=', '^=', '..=']);
const BLOCK_END = new Set(['end', 'else', 'elseif', 'until']);

class Parser {
  constructor(toks) { this.toks = toks; this.p = 0; this.opened = []; }
  get tok() { return this.toks[this.p]; }
  peek(k = 1) { return this.toks[Math.min(this.p + k, this.toks.length - 1)]; }
  next() { return this.toks[this.p++]; }
  is(v) { const t = this.tok; return (t.t === 'op' || t.t === 'kw') && t.v === v; }
  isName(v) { const t = this.tok; return t.t === 'name' && (v === undefined || t.v === v); }
  accept(v) { if (this.is(v)) { this.p++; return true; } return false; }
  show(t) { return t.t === 'eof' ? '파일 끝' : t.t === 'str' ? '문자열' : t.t === 'num' ? `숫자 ${t.v}` : t.t === 'istr' ? '백틱 문자열' : `'${t.v}'`; }
  fail(msg, tok = this.tok, hint) { throw new SyntaxErr(msg, tok.line, tok.col, hint || this.hintFor(tok)); }
  hintFor(t) {
    if (t.t === 'op') {
      if (t.v === '!=') return "Lua 의 '같지 않음' 은 ~= 입니다";
      if (t.v === '&&') return "논리곱은 and 를 쓰세요";
      if (t.v === '||') return "논리합은 or 를 쓰세요";
      if (t.v === '++') return "증가는 x += 1 로 쓰세요 (++ 는 없음)";
      if (t.v === '!') return "논리 부정은 not 을 쓰세요";
    }
    if (t.t === 'name') {
      if (t.v === 'elif' || t.v === 'elsif') return "Lua 에서는 elseif 입니다";
      if (t.v === 'else' ) return null;
      if (t.v === 'function' ) return null;
    }
    return null;
  }
  expect(v, ctx) {
    if (this.is(v)) return this.next();
    const t = this.tok;
    let hint = this.hintFor(t);
    if (v === 'then' && t.t === 'op' && t.v === '=') hint = "조건 비교는 == 입니다 ('=' 는 대입)";
    if (v === 'then' || v === 'do') hint = hint || `${ctx || '조건'} 뒤에 '${v}' 가 필요합니다`;
    this.fail(`'${v}' 가 필요한 자리에 ${this.show(t)} 이(가) 있습니다${ctx ? ` (${ctx})` : ''}`, t, hint);
  }
  expectEnd(opener, kind) {
    if (this.is('end')) return this.next();
    const t = this.tok;
    const where = `${opener.line}줄의 '${kind}'`;
    if (t.t === 'eof') this.fail(`'end' 가 빠졌습니다: ${where} 블록이 파일 끝까지 닫히지 않았습니다`, t, `${where} 에 대응하는 end 를 추가하세요. (if/for/while/function/do 마다 end 가 하나씩 필요)`);
    this.fail(`${where} 을(를) 닫는 'end' 가 필요한 자리에 ${this.show(t)} 이(가) 있습니다`, t, this.hintFor(t) || `${where} 블록 안의 구문이 잘못됐거나 end 가 모자랄 수 있습니다`);
  }
  name(what = '이름') {
    const t = this.tok;
    if (t.t !== 'name') {
      const hint = t.t === 'kw' ? `'${t.v}' 는 예약어라 ${what} 으로 쓸 수 없습니다` : this.hintFor(t);
      this.fail(`${what} 이(가) 필요한 자리에 ${this.show(t)} 이(가) 있습니다`, t, hint);
    }
    this.p++; return t;
  }

  chunk() {
    const body = this.block();
    if (this.tok.t !== 'eof') {
      const t = this.tok;
      if (t.t === 'kw' && (t.v === 'end' || t.v === 'else' || t.v === 'elseif' || t.v === 'until')) this.fail(`짝이 없는 '${t.v}' 입니다`, t, "앞쪽에서 end 가 너무 많거나, if/for/function 의 시작이 빠졌습니다");
      this.fail(`예상하지 못한 ${this.show(t)}`, t);
    }
    return { k: 'Chunk', body };
  }
  block() {
    const body = [];
    for (;;) {
      const t = this.tok;
      if (t.t === 'eof' || (t.t === 'kw' && BLOCK_END.has(t.v))) break;
      if (this.accept(';')) continue;
      const s = this.statement();
      body.push(s);
      if (s.k === 'Return' || s.k === 'Break' || s.k === 'Continue') {
        this.accept(';');
        const n = this.tok;
        if (!(n.t === 'eof' || (n.t === 'kw' && BLOCK_END.has(n.v)))) {
          const kind = s.k === 'Return' ? 'return' : s.k === 'Break' ? 'break' : 'continue';
          this.fail(`'${kind}' 뒤에 문장이 더 있습니다 — ${kind} 는(은) 블록의 마지막 문장이어야 합니다`, n, `${kind} 아래 코드는 실행되지 않습니다. 지우거나 if 로 감싸세요`);
        }
      }
    }
    return body;
  }
  isContinue() {
    const t = this.tok;
    if (!(t.t === 'name' && t.v === 'continue')) return false;
    const n = this.peek();
    if (n.t === 'op' && ['=', '.', ':', '(', '[', ',', '{', ...COMPOUND].includes(n.v)) return false;
    if (n.t === 'str' || n.t === 'istr') return false;
    return true;
  }
  statement() {
    const t = this.tok;
    if (t.t === 'op' && t.v === '@') { this.next(); if (this.is('[')) { while (!this.is(']') && this.tok.t !== 'eof') this.next(); this.accept(']'); } else this.name('속성 이름'); return this.statement(); }
    if (t.t === 'kw') {
      switch (t.v) {
        case 'if': return this.ifStat();
        case 'while': { this.next(); const cond = this.expr(); this.expect('do', 'while 조건'); const body = this.block(); this.expectEnd(t, 'while'); return { k: 'While', cond, body, line: t.line, col: t.col }; }
        case 'do': { this.next(); const body = this.block(); this.expectEnd(t, 'do'); return { k: 'Do', body, line: t.line }; }
        case 'for': return this.forStat();
        case 'repeat': { this.next(); const body = this.block(); if (!this.is('until')) { const x = this.tok; this.fail(x.t === 'eof' ? `'until' 이 빠졌습니다: ${t.line}줄의 'repeat' 가 닫히지 않았습니다` : `repeat 블록을 닫는 'until' 이 필요한 자리에 ${this.show(x)} 이(가) 있습니다`, x); } this.next(); const cond = this.expr(); return { k: 'Repeat', body, cond, line: t.line, col: t.col }; }
        case 'function': return this.funcStat();
        case 'local': return this.localStat();
        case 'return': { this.next(); const exprs = []; const n = this.tok; if (!(n.t === 'eof' || (n.t === 'kw' && BLOCK_END.has(n.v)) || this.is(';'))) { exprs.push(this.expr()); while (this.accept(',')) exprs.push(this.expr()); } return { k: 'Return', exprs, line: t.line, col: t.col }; }
        case 'break': this.next(); return { k: 'Break', line: t.line, col: t.col };
        default: break;
      }
    }
    if (this.isContinue()) { this.next(); return { k: 'Continue', line: t.line, col: t.col }; }
    if (t.t === 'name' && t.v === 'export' && this.peek().t === 'name' && this.peek().v === 'type') { this.next(); return this.typeAlias(); }
    if (t.t === 'name' && t.v === 'type' && this.peek().t === 'name' && (this.peek(2).v === '=' || this.peek(2).v === '<') && this.peek(2).t === 'op') return this.typeAlias();
    return this.exprStat();
  }
  ifStat() {
    const t = this.next();
    const clauses = []; let orelse = null;
    let cond = this.expr(); this.expect('then', 'if 조건');
    clauses.push({ cond, body: this.block(), line: t.line });
    while (this.is('elseif')) { const e = this.next(); cond = this.expr(); this.expect('then', 'elseif 조건'); clauses.push({ cond, body: this.block(), line: e.line }); }
    if (this.accept('else')) {
      if (this.is('if')) this.fail("'else if' 는 중첩 if 가 되어 end 가 하나 더 필요합니다", this.tok, "연속 조건은 한 단어 elseif 로 쓰세요");
      orelse = this.block();
    }
    this.expectEnd(t, 'if');
    return { k: 'If', clauses, orelse, line: t.line };
  }
  forStat() {
    const t = this.next();
    const first = this.name('반복 변수');
    let ft = null;
    if (this.accept(':')) ft = this.type();
    if (this.is('=')) {
      this.next();
      const start = this.expr(); this.expect(',', 'for 범위(시작, 끝)'); const stop = this.expr();
      let step = null; if (this.accept(',')) step = this.expr();
      this.expect('do', 'for 헤더'); const body = this.block(); this.expectEnd(t, 'for');
      return { k: 'NumFor', v: first, start, stop, step, body, line: t.line };
    }
    const vars = [first];
    while (this.accept(',')) { const v = this.name('반복 변수'); if (this.accept(':')) this.type(); vars.push(v); }
    if (!this.is('in')) this.fail(`'in' 이 필요한 자리에 ${this.show(this.tok)} 이(가) 있습니다`, this.tok, "for k, v in pairs(t) do 형태입니다 (숫자 for 는 for i = 1, n do)");
    this.next();
    const exprs = [this.expr()]; while (this.accept(',')) exprs.push(this.expr());
    this.expect('do', 'for 헤더'); const body = this.block(); this.expectEnd(t, 'for');
    return { k: 'GenFor', vars, exprs, body, line: t.line };
  }
  funcStat() {
    const t = this.next();
    const base = this.name('함수 이름');
    const path = []; let method = null;
    while (this.is('.')) { this.next(); path.push(this.name('필드 이름')); }
    if (this.is(':')) { this.next(); method = this.name('메서드 이름'); }
    const fn = this.funcBody(t, !!method, (method || path[path.length - 1] || base).v);
    return { k: 'Function', base, path, method, func: fn, line: t.line };
  }
  localStat() {
    const t = this.next();
    if (this.is('function')) {
      const ft = this.next(); const nm = this.name('함수 이름');
      const fn = this.funcBody(ft, false, nm.v);
      return { k: 'LocalFunction', name: nm, func: fn, line: t.line };
    }
    const names = [];
    do {
      const nm = this.name('변수 이름');
      let ty = null; if (this.accept(':')) ty = this.type();
      if (this.is('<') && this.peek().t === 'name' && this.peek(2).v === '>') { this.next(); this.next(); this.next(); }
      names.push(nm);
    } while (this.accept(','));
    const exprs = [];
    if (this.accept('=')) { exprs.push(this.expr()); while (this.accept(',')) exprs.push(this.expr()); }
    return { k: 'Local', names, exprs, line: t.line };
  }
  typeAlias() {
    const t = this.next(); // 'type'
    const nm = this.name('타입 이름');
    if (this.is('<')) this.genericList();
    this.expect('=', '타입 별칭');
    this.type();
    return { k: 'TypeAlias', name: nm, line: t.line };
  }
  genericList() {
    this.expect('<');
    while (!this.is('>')) {
      this.name('제네릭 이름');
      if (this.accept('...')) { /* pack */ }
      if (this.accept('=')) this.type();
      if (!this.accept(',')) break;
    }
    this.expect('>', '제네릭 목록');
  }
  exprStat() {
    const t = this.tok;
    const e = this.suffixed();
    if (this.is('=') || this.is(',')) {
      const targets = [e];
      while (this.accept(',')) targets.push(this.suffixed());
      for (const x of targets) if (!['Name', 'Dot', 'Idx'].includes(x.k)) this.fail('대입할 수 없는 대상입니다 (이름, a.b, a[i] 만 가능)', t);
      this.expect('=', '대입');
      const exprs = [this.expr()]; while (this.accept(',')) exprs.push(this.expr());
      return { k: 'Assign', targets, exprs, op: '=', line: t.line };
    }
    if (this.tok.t === 'op' && COMPOUND.has(this.tok.v)) {
      const op = this.next().v;
      if (!['Name', 'Dot', 'Idx'].includes(e.k)) this.fail('복합 대입 대상이 올바르지 않습니다', t);
      return { k: 'Assign', targets: [e], exprs: [this.expr()], op, line: t.line };
    }
    if (e.k !== 'Call' && e.k !== 'MethodCall') {
      const n = this.tok;
      let hint = null;
      if (e.k === 'Name' && (e.name === 'elif' || e.name === 'elsif')) hint = "Lua 에서는 'elseif' 입니다 (else 와 if 를 붙여 씀)";
      else if (e.k === 'Name' && n.t === 'op' && n.v === '==') hint = "대입은 '=' 입니다 ('==' 는 비교)";
      else if (n.t === 'op' && n.v === '++') hint = 'x += 1 로 쓰세요';
      else if (e.k === 'Name' && (n.t === 'name' || n.t === 'num' || n.t === 'str')) hint = `'${e.name}' 앞뒤로 local/연산자/괄호가 빠졌을 수 있습니다 (예: local ${e.name} = ...)`;
      else if (e.k === 'Name') hint = `'${e.name}' 는 단독 문장이 될 수 없습니다. 함수 호출이면 괄호 () 가 필요합니다`;
      this.fail(`구문이 올바르지 않습니다: 식 뒤에 ${this.show(n)} 이(가) 있습니다`, e.k === 'Name' ? t : n, hint || "문장은 함수 호출이나 대입이어야 합니다");
    }
    return { k: 'CallStat', e, line: t.line };
  }

  // ----- 표현식 -----
  expr(limit = 0) {
    let left;
    const t = this.tok;
    if ((t.t === 'kw' && t.v === 'not') || (t.t === 'op' && (t.v === '-' || t.v === '#'))) {
      this.next();
      left = { k: 'Unop', op: t.v, e: this.expr(UNARY_PRI), line: t.line, col: t.col };
    } else if (t.t === 'op' && t.v === '!') {
      this.fail("'!' 는 Lua 에 없습니다", t, "논리 부정은 not, 같지 않음은 ~= 입니다");
    } else left = this.simple();
    for (;;) {
      const o = this.tok;
      const key = (o.t === 'op' || o.t === 'kw') ? o.v : null;
      if (o.t === 'op' && (o.v === '&&' || o.v === '||' || o.v === '!=')) this.fail(`'${o.v}' 는 Lua 연산자가 아닙니다`, o, this.hintFor(o));
      const pr = key && BIN[key];
      if (!pr || pr[0] <= limit) break;
      this.next();
      const right = this.expr(pr[1]);
      left = { k: 'Binop', op: key, l: left, r: right, line: o.line, col: o.col };
    }
    return left;
  }
  simple() {
    const t = this.tok;
    let e;
    switch (t.t) {
      case 'num': this.next(); e = { k: 'Num', v: t.v, line: t.line, col: t.col }; break;
      case 'str': this.next(); e = { k: 'Str', v: t.v, line: t.line, col: t.col }; break;
      case 'istr': this.next(); e = { k: 'Interp', parts: t.exprs.map(x => this.subExpr(x)), line: t.line, col: t.col }; break;
      case 'kw':
        if (t.v === 'nil') { this.next(); e = { k: 'Nil', line: t.line, col: t.col }; break; }
        if (t.v === 'true' || t.v === 'false') { this.next(); e = { k: 'Bool', v: t.v === 'true', line: t.line, col: t.col }; break; }
        if (t.v === 'function') { this.next(); e = this.funcBody(t, false, null); break; }
        if (t.v === 'if') { e = this.ifExpr(); break; }
        e = this.suffixed(); break;
      case 'op':
        if (t.v === '...') { this.next(); e = { k: 'Vararg', line: t.line, col: t.col }; break; }
        if (t.v === '{') { e = this.tableCons(); break; }
        e = this.suffixed(); break;
      default: e = this.suffixed();
    }
    while (this.is('::')) { this.next(); this.type(); e = { k: 'Cast', e, line: e.line, col: e.col }; }
    return e;
  }
  subExpr(x) {
    const toks = tokenize(x.text, { line: x.line, col: x.col, pos: x.pos });
    const p = new Parser(toks);
    const e = p.expr();
    if (p.tok.t !== 'eof') p.fail('문자열 보간 {…} 안의 식이 올바르지 않습니다');
    return e;
  }
  ifExpr() {
    const t = this.next();
    const cond = this.expr(); this.expect('then', 'if 식');
    const a = this.expr();
    const parts = [{ cond, then: a }];
    let other = null;
    while (this.is('elseif')) { this.next(); const c = this.expr(); this.expect('then', 'elseif 식'); parts.push({ cond: c, then: this.expr() }); }
    if (!this.is('else')) this.fail("if 식에는 반드시 else 가 있어야 합니다", this.tok, "x = if a then b else c  형태입니다");
    this.next(); other = this.expr();
    return { k: 'IfExp', parts, other, line: t.line, col: t.col };
  }
  primary() {
    const t = this.tok;
    if (t.t === 'name') { this.next(); return { k: 'Name', name: t.v, line: t.line, col: t.col }; }
    if (t.t === 'op' && t.v === '(') {
      this.next(); const e = this.expr();
      if (!this.is(')')) this.fail(`')' 가 필요한 자리에 ${this.show(this.tok)} 이(가) 있습니다 (${t.line}줄의 '(' 를 닫으세요)`, this.tok);
      this.next(); return { k: 'Paren', e, line: t.line, col: t.col };
    }
    this.fail(`식이 필요한 자리에 ${this.show(t)} 이(가) 있습니다`, t, t.t === 'kw' ? `'${t.v}' 는 예약어라 여기서는 쓸 수 없습니다. 앞 줄의 괄호·end 가 빠졌는지 확인하세요` : this.hintFor(t));
  }
  suffixed() {
    let e = this.primary();
    for (;;) {
      const t = this.tok;
      if (t.t === 'op') {
        if (t.v === '.') { this.next(); const n = this.name('필드 이름'); e = { k: 'Dot', obj: e, name: n.v, line: n.line, col: n.col }; continue; }
        if (t.v === '[') { this.next(); const key = this.expr(); this.expect(']', '인덱스'); e = { k: 'Idx', obj: e, key, line: t.line, col: t.col }; continue; }
        if (t.v === ':') {
          this.next(); const n = this.name('메서드 이름');
          const args = this.callArgs();
          e = { k: 'MethodCall', obj: e, name: n.v, args, line: n.line, col: n.col, line0: t.line }; continue;
        }
        if (t.v === '(' || t.v === '{') { const args = this.callArgs(); e = { k: 'Call', fn: e, args, line: e.line, col: e.col }; continue; }
      }
      if (t.t === 'str' || t.t === 'istr') { const a = this.simple(); e = { k: 'Call', fn: e, args: [a], line: e.line, col: e.col }; continue; }
      break;
    }
    return e;
  }
  callArgs() {
    const t = this.tok;
    if (t.t === 'str') { this.next(); return [{ k: 'Str', v: t.v, line: t.line, col: t.col }]; }
    if (t.t === 'istr') return [this.simple()];
    if (t.t === 'op' && t.v === '{') return [this.tableCons()];
    if (!(t.t === 'op' && t.v === '(')) this.fail(`함수 호출의 '(' 가 필요한 자리에 ${this.show(t)} 이(가) 있습니다`, t, '메서드 호출은 obj:Method(인자) 형태입니다');
    this.next();
    const args = [];
    if (!this.is(')')) { args.push(this.expr()); while (this.accept(',')) args.push(this.expr()); }
    if (!this.is(')')) this.fail(`')' 가 필요한 자리에 ${this.show(this.tok)} 이(가) 있습니다 (${t.line}줄의 '(' 를 닫거나 인자 사이 ',' 를 확인하세요)`, this.tok);
    this.next();
    return args;
  }
  tableCons() {
    const t = this.next();
    const fields = [];
    while (!this.is('}')) {
      if (this.is('[')) { this.next(); const key = this.expr(); this.expect(']', '테이블 키'); this.expect('=', '테이블 필드'); fields.push({ kind: 'expr', key, value: this.expr() }); }
      else if (this.tok.t === 'name' && this.peek().t === 'op' && this.peek().v === '=') { const n = this.next(); this.next(); fields.push({ kind: 'name', key: n, value: this.expr() }); }
      else fields.push({ kind: 'pos', value: this.expr() });
      if (!(this.accept(',') || this.accept(';'))) break;
    }
    if (!this.is('}')) this.fail(`테이블 '}' 가 필요한 자리에 ${this.show(this.tok)} 이(가) 있습니다 (${t.line}줄의 '{' 를 닫거나 항목 사이 ',' 를 확인하세요)`, this.tok, '테이블 항목은 쉼표(,)로 구분합니다');
    this.next();
    return { k: 'Table', fields, line: t.line, col: t.col };
  }
  funcBody(startTok, isMethod, name) {
    if (this.is('<')) this.genericList();
    const open = this.tok;
    this.expect('(', '함수 매개변수');
    const params = []; let vararg = false;
    while (!this.is(')')) {
      if (this.is('...')) { this.next(); vararg = true; if (this.accept(':')) this.type(); break; }
      const nm = this.name('매개변수 이름');
      if (this.accept(':')) this.type();
      params.push(nm);
      if (!this.accept(',')) break;
    }
    if (!this.is(')')) this.fail(`')' 가 필요한 자리에 ${this.show(this.tok)} 이(가) 있습니다 (${open.line}줄 함수 매개변수)`, this.tok);
    this.next();
    if (this.accept(':')) this.returnType();
    const body = this.block();
    const endTok = this.tok;
    this.expectEnd(startTok, 'function');
    return { k: 'Func', name, params, vararg, isMethod, body, line: startTok.line, col: startTok.col, endLine: endTok.line };
  }

  // ----- 타입 (구문만 검사) -----
  returnType() {
    if (this.is('(')) { this.typeList(); return; }
    if (this.is('...')) { this.next(); this.type(); return; }
    this.type();
  }
  typeList() {
    this.expect('(');
    while (!this.is(')')) {
      if (this.tok.t === 'name' && this.peek().t === 'op' && this.peek().v === ':') { this.next(); this.next(); }
      if (this.accept('...')) { /* variadic */ }
      this.type();
      if (this.accept('...')) { /* generic pack */ }
      if (!this.accept(',')) break;
    }
    this.expect(')', '타입 목록');
  }
  type() {
    this.simpleType();
    for (;;) {
      if (this.is('?')) { this.next(); continue; }
      if (this.is('|') || this.is('&')) { this.next(); this.simpleType(); continue; }
      break;
    }
  }
  simpleType() {
    const t = this.tok;
    if (t.t === 'kw' && (t.v === 'nil' || t.v === 'true' || t.v === 'false')) { this.next(); return; }
    if (t.t === 'str') { this.next(); return; }
    if (t.t === 'name') {
      this.next();
      if (t.v === 'typeof' && this.is('(')) { this.next(); this.expr(); this.expect(')', 'typeof'); return; }
      if (this.is('.')) { this.next(); this.name('타입 이름'); }
      if (this.is('<')) { this.next(); while (!this.is('>')) { if (this.accept('...')) { /* */ } this.type(); if (this.accept('...')) { /* */ } if (!this.accept(',')) break; } this.expect('>', '타입 인자'); }
      return;
    }
    if (t.t === 'op' && t.v === '{') {
      this.next();
      while (!this.is('}')) {
        if (this.is('[')) { this.next(); this.type(); this.expect(']'); this.expect(':', '테이블 타입'); this.type(); }
        else if (this.tok.t === 'name' && this.peek().t === 'op' && this.peek().v === ':') { this.next(); this.next(); this.type(); }
        else if (this.tok.t === 'name' && (this.tok.v === 'read' || this.tok.v === 'write') && this.peek().t === 'name') { this.next(); continue; }
        else this.type();
        if (!(this.accept(',') || this.accept(';'))) break;
      }
      this.expect('}', '테이블 타입');
      return;
    }
    if (t.t === 'op' && (t.v === '(' || t.v === '<')) {
      if (this.is('<')) this.genericList();
      this.typeList();
      if (this.accept('->')) this.returnType();
      return;
    }
    this.fail(`타입이 필요한 자리에 ${this.show(t)} 이(가) 있습니다`, t, '타입 표기는 number, string, {T}, (a: T) -> R 같은 형태입니다');
  }
}

function parse(src) {
  const toks = tokenize(src);
  return new Parser(toks).chunk();
}

// ---------------------------------------------------------------------------
// 분석
// ---------------------------------------------------------------------------
function analyzeAst(ast, src, o = {}) {
  const env = o.env === 'luau' ? 'luau' : 'roblox';
  const ctx = ['server', 'client', 'module'].includes(o.context) ? o.context : null;
  let inPcall = 0;
  const extra = new Set((o.extraGlobals || []).map(String));
  const issues = [];
  const add = (sev, rule, node, message, suggestion, edit) => issues.push({ sev, rule, line: node.line || 0, col: node.col || 0, message, ...(suggestion ? { suggestion } : {}), ...(edit ? { edit } : {}) });
  const isKnownGlobal = n => LUAU_GLOBALS.has(n) || (env === 'roblox' && ROBLOX_GLOBALS.has(n)) || extra.has(n);
  const allGlobalNames = () => [...LUAU_GLOBALS, ...(env === 'roblox' ? ROBLOX_GLOBALS : []), ...extra];

  let scope = null;
  const allDecls = new Map();         // name → 첫 선언 {line}
  const undefinedReads = [];
  const assignedGlobals = new Map();  // name → node
  const fieldReads = [];              // {v, name, node}
  const functions = [];
  const fnStack = [];
  const loopStack = [];               // 현재 함수 안 반복문 깊이(함수마다 새로 시작)
  const varsAll = [];

  const push = (kind) => { scope = { vars: new Map(), parent: scope, kind }; };
  const pop = () => {
    for (const v of scope.vars.values()) {
      if (v.reads === 0 && !v.name.startsWith('_') && v.kind !== 'param' && v.name !== 'self') {
        if (v.kind === 'for') continue;
        const what = v.kind === 'function' ? '함수' : '변수';
        const written = v.writes > 0 ? ' (값을 대입만 하고 읽지 않음)' : '';
        add('warning', 'unused-local', v, `${what} '${v.name}' 을(를) 선언했지만 사용하지 않습니다${written}`, `필요 없으면 지우고, 일부러 안 쓰는 값이면 이름 앞에 _ 를 붙이세요`);
      }
    }
    scope = scope.parent;
  };
  const lookup = name => { for (let s = scope; s; s = s.parent) { const v = s.vars.get(name); if (v) return v; } return null; };
  const declare = (tok, kind, extraProps = {}) => {
    const name = tok.v !== undefined ? tok.v : tok.name;
    const prev = scope.vars.get(name);
    if (prev && !name.startsWith('_') && kind !== 'param') add('info', 'redefined-local', tok, `'${name}' 을(를) 같은 블록에서 다시 선언했습니다 (이전: ${prev.line}줄)`, '의도한 게 아니면 이름을 바꾸거나 두 번째에서 local 을 빼세요');
    const v = { name, line: tok.line, col: tok.col, kind, reads: 0, writes: 0, ...extraProps };
    scope.vars.set(name, v);
    if (!allDecls.has(name)) allDecls.set(name, { line: tok.line });
    varsAll.push(v);
    return v;
  };
  const curFn = () => fnStack[fnStack.length - 1];

  function readName(node, asCall) {
    const v = lookup(node.name);
    if (v) { v.reads++; return v; }
    if (isKnownGlobal(node.name) || assignedGlobals.has(node.name)) return null;
    undefinedReads.push({ node, asCall });
    return null;
  }

  function visitExprs(list) { for (const e of list || []) visit(e); }

  function visit(n) {
    if (!n) return;
    switch (n.k) {
      case 'Num': case 'Str': case 'Bool': case 'Nil': return;
      case 'Interp': visitExprs(n.parts); return;
      case 'Vararg': if (!curFn().vararg) add('error', 'vararg-outside', n, "'...' 는 가변 인자(...) 를 선언한 함수 안에서만 쓸 수 있습니다", '함수 매개변수에 ... 를 추가하세요: function(a, ...)'); return;
      case 'Name': readName(n, false); return;
      case 'Paren': visit(n.e); return;
      case 'Cast': visit(n.e); return;
      case 'Unop': visit(n.e); return;
      case 'Binop': visit(n.l); visit(n.r); if (n.op === 'and' || n.op === 'or') curFn().complexity++; return;
      case 'IfExp': for (const p of n.parts) { visit(p.cond); visit(p.then); } visit(n.other); return;
      case 'Table': {
        for (const f of n.fields) { if (f.kind === 'expr') visit(f.key); markEscape(f.value); visit(f.value); }
        return;
      }
      case 'Func': visitFunc(n); return;
      case 'Dot': {
        visit(n.obj);
        checkLibMember(n);
        if (env === 'roblox' && ctx === 'server') {
          if (n.name === 'LocalPlayer') add('error', 'server-only-api', n, "서버 스크립트에서 Players.LocalPlayer 는 항상 nil 입니다", "서버에서는 PlayerAdded / 이벤트의 player 인자를 쓰세요 (LocalPlayer 는 LocalScript 전용)");
          if (n.name === 'CurrentCamera' && n.obj.k === 'Name' && /^[Ww]orkspace$/.test(n.obj.name)) add('warning', 'server-only-api', n, "서버에는 CurrentCamera 가 의미 없습니다 (카메라는 클라이언트 전용)", "카메라 코드는 LocalScript 로 옮기세요");
          if (n.name === 'OnClientEvent') add('error', 'server-only-api', n, "OnClientEvent 는 클라이언트에서만 받을 수 있습니다 (서버는 OnServerEvent)", "서버→클라 전송은 :FireClient(player, ...)");
        }
        if (env === 'roblox' && ctx === 'client') {
          if (n.name === 'OnServerEvent') add('error', 'client-only-api', n, "OnServerEvent 는 서버에서만 받을 수 있습니다 (클라이언트는 OnClientEvent)", "클라→서버 전송은 :FireServer(...)");
        }
        if (n.obj.k === 'MethodCall' && NIL_RETURNING.has(n.obj.name)) add('warning', 'nil-index', n, `${n.obj.name} 의 결과는 nil 일 수 있는데 바로 .${n.name} 에 접근합니다 (nil 이면 'attempt to index nil' 오류)`, `local x = ...:${n.obj.name}(...) 로 받아 if x then 으로 확인하거나 WaitForChild 를 쓰세요`);
        if (n.obj.k === 'Name') { const v = lookup(n.obj.name); if (v && v.table) fieldReads.push({ v, name: n.name, node: n }); }
        return;
      }
      case 'Idx': {
        visit(n.obj); visit(n.key);
        if (n.obj.k === 'MethodCall' && NIL_RETURNING.has(n.obj.name)) add('warning', 'nil-index', n, `${n.obj.name} 의 결과는 nil 일 수 있는데 바로 [..] 로 접근합니다`, 'nil 확인 후 사용하세요');
        if (n.obj.k === 'Name') { const v = lookup(n.obj.name); if (v && v.table) v.table.dynamic = true; }
        return;
      }
      case 'Call': return visitCall(n);
      case 'MethodCall': return visitMethodCall(n);
      default: return;
    }
  }
  // 다른 곳으로 넘어간 로컬 테이블은 필드가 외부에서 바뀔 수 있다고 본다
  function markEscape(node) {
    if (node && node.k === 'Name') { const v = lookup(node.name); if (v && v.table) v.table.escaped = true; }
  }

  function checkLibMember(n) {
    if (n.obj.k !== 'Name') return;
    const lib = n.obj.name;
    if (!Object.hasOwn(LIB_MEMBERS, lib)) return;
    if (lookup(lib) || !isKnownGlobal(lib)) return;   // 지역 변수로 가려졌으면 무시
    if (['Vector3', 'Vector2', 'CFrame', 'Color3', 'UDim2', 'UDim', 'Instance', 'TweenInfo', 'Random', 'Rect', 'Ray', 'Region3', 'NumberRange', 'NumberSequence', 'NumberSequenceKeypoint', 'ColorSequence', 'ColorSequenceKeypoint', 'RaycastParams', 'OverlapParams', 'DateTime', 'PhysicalProperties', 'Axes', 'Faces'].includes(lib) && env !== 'roblox') return;
    if (LIB_MEMBERS[lib].includes(n.name)) return;
    const s = A.closest(n.name, LIB_MEMBERS[lib]);
    add('error', 'undefined-member', n, `'${lib}.${n.name}' 은(는) 없습니다`, s ? `'${lib}.${s}' 의 오타?` : `${lib} 에 있는 것: ${LIB_MEMBERS[lib].slice(0, 14).join(', ')} …`, s ? { line: n.line, col: n.col, from: n.name, to: s } : null);
  }

  function calleeText(f) {
    if (f.k === 'Name') return f.name;
    if (f.k === 'Dot' && f.obj.k === 'Name') return f.obj.name + '.' + f.name;
    return null;
  }
  function visitCall(n) {
    const f = n.fn;
    if (f.k === 'Name') {
      const v = readName(f, true);
      if (!v && env === 'roblox') {
        if (f.name === 'wait') add('warning', 'deprecated', f, "wait() 는 폐기되었습니다 (느리고 부정확)", 'task.wait() 를 쓰세요', { line: f.line, col: f.col, from: 'wait', to: 'task.wait' });
        else if (f.name === 'spawn') add('warning', 'deprecated', f, "spawn() 은 폐기되었습니다", 'task.spawn() 또는 task.defer() 를 쓰세요', { line: f.line, col: f.col, from: 'spawn', to: 'task.spawn' });
        else if (f.name === 'delay') add('warning', 'deprecated', f, "delay() 는 폐기되었습니다", 'task.delay() 를 쓰세요', { line: f.line, col: f.col, from: 'delay', to: 'task.delay' });
        else if (f.name === 'tick') add('info', 'deprecated', f, "tick() 은 폐기 예정입니다", '시간 간격은 os.clock(), 현재 시각은 os.time() / DateTime.now() 를 쓰세요');
      }
      if (f.name === 'setmetatable' && !v && n.args[0] && n.args[0].k === 'Name') { const t = lookup(n.args[0].name); if (t && t.table) t.table.meta = true; }
    } else {
      visit(f);
      const txt = calleeText(f);
      if (f.k === 'Dot' && env === 'roblox') {
        if (txt === 'Instance.new' && n.args.length >= 2) add('warning', 'instance-parent-arg', n, 'Instance.new(클래스, parent) 의 parent 인자는 성능이 나빠 권장되지 않습니다', '속성을 모두 설정한 뒤 마지막에 inst.Parent = parent');
        if (INSTANCE_METHODS.has(f.name) && !(f.obj.k === 'Name' && (Object.hasOwn(LIB_MEMBERS, f.obj.name) || isModuleLike(f.obj.name))) && !isSelfPass(f, n)) {
          add('warning', 'dot-call', f, `'.${f.name}(...)' 로 불렀습니다 — Roblox 메서드는 ':' 로 호출해야 합니다`, `obj:${f.name}(...)  (점(.) 로 부르면 첫 인자가 self 로 전달되지 않아 오류)`, { line: f.line, col: f.col - 1, from: '.', to: ':' });
        }
      }
    }
    const isP = f.k === 'Name' && (f.name === 'pcall' || f.name === 'xpcall') && !lookup(f.name);
    if (isP) inPcall++;
    for (const a of n.args) { markEscape(a); visit(a); }
    if (isP) inPcall--;
    curFn().calls.add(calleeText(f) || '');
    if (calleeText(f) && YIELDERS_DOT.has(calleeText(f)) || (f.k === 'Name' && YIELDERS_NAME.has(f.name))) curFn().yields = true;
  }
  function isSelfPass(f, call) {
    const a0 = call.args[0];
    if (!a0) return false;
    const root = r => (r.k === 'Name' ? r.name : r.k === 'Dot' ? r.name : null);
    return a0.k === 'Name' && (a0.name === root(f.obj) || a0.name === 'self');
  }
  function isModuleLike(name) {
    const v = lookup(name);
    return !!(v && v.table);   // 직접 만든 테이블의 Module.Connect(self, ...) 같은 형태는 허용
  }
  function visitMethodCall(n) {
    visit(n.obj);
    const o = n.obj;
    if (o.k === 'Name') { const v = lookup(o.name); if (v && v.table) fieldReads.push({ v, name: n.name, node: n, method: true }); }
    if (env === 'roblox') {
      if ((n.name === 'GetService' || n.name === 'FindService') && o.k === 'Name' && (o.name === 'game' || o.name === 'Game') && !lookup(o.name) && n.args[0] && n.args[0].k === 'Str') {
        const sv = n.args[0].v;
        if (!SERVICES.has(sv)) {
          const s = A.closest(sv, [...SERVICES]);
          if (s) add('error', 'bad-service', n.args[0], `서비스 '${sv}' 은(는) 없습니다`, `'${s}' 의 오타? (game:GetService("${s}"))`, { line: n.args[0].line, col: n.args[0].col + 1, from: sv, to: s });
          else add('info', 'bad-service', n.args[0], `'${sv}' 은(는) 알려진 서비스 목록에 없습니다 — 철자를 확인하세요`);
        }
      }
      if ((n.name === 'remove' || n.name === 'Remove') && n.args.length === 0) add('warning', 'deprecated', n, `:${n.name}() 은 폐기되었습니다`, ':Destroy() 를 쓰세요', { line: n.line, col: n.col, from: n.name, to: 'Destroy' });
      if (n.name === 'service' && o.k === 'Name' && o.name === 'game') add('warning', 'deprecated', n, 'game:service() 는 폐기되었습니다', 'game:GetService("이름")');
      if ((n.name === 'Connect' || n.name === 'Once' || n.name === 'ConnectParallel') && n.args[0] && n.args[0].k === 'Call' && (n.args[0].fn.k === 'Name' || n.args[0].fn.k === 'Dot')) {
        add('warning', 'connect-call', n.args[0], `:${n.name}() 에 함수를 넘겨야 하는데 호출 결과(${calleeText(n.args[0].fn) || '함수()'}())를 넘겼습니다`, `괄호를 빼고 함수 자체를 넘기세요: :${n.name}(${calleeText(n.args[0].fn) || '핸들러'})`);
      }
    }
    if (env === 'roblox') {
      if (ASYNC_NEEDS_PCALL.has(n.name) && !inPcall) add('warning', 'unprotected-async', n, `:${n.name}() 은 네트워크/DataStore 호출이라 실패(오류)할 수 있는데 pcall 로 감싸지 않았습니다 — 실패하면 스크립트 스레드가 죽고 데이터가 유실될 수 있습니다`, `local ok, result = pcall(function() return store:${n.name}(...) end)  후 if not ok then (재시도/로그) end`);
      if (ctx === 'server' && (n.name === 'FireServer' || n.name === 'InvokeServer')) add('error', 'server-only-api', n, `서버 스크립트에서 :${n.name}() 은 호출할 수 없습니다 (클라이언트→서버 방향)`, n.name === 'FireServer' ? ':FireClient(player, ...) / :FireAllClients(...)' : ':InvokeClient(player, ...)');
      if (ctx === 'client' && (n.name === 'FireClient' || n.name === 'FireAllClients' || n.name === 'InvokeClient')) add('error', 'client-only-api', n, `클라이언트에서 :${n.name}() 은 호출할 수 없습니다 (서버→클라이언트 방향)`, ':FireServer(...) / :InvokeServer(...)');
      if ((n.name === 'GetService') && o.k === 'Name' && o.name === 'game' && n.args[0] && n.args[0].k === 'Str') {
        const sv = n.args[0].v;
        if (ctx === 'client' && SERVER_ONLY_SERVICES.has(sv) && sv !== 'HttpService') add('error', 'client-only-api', n.args[0], `'${sv}' 은(는) 서버 전용입니다 — 클라이언트(LocalScript)에서는 사용할 수 없습니다`, 'RemoteEvent 로 서버에 요청하세요');
        if (ctx === 'server' && CLIENT_ONLY_SERVICES.has(sv)) add('warning', 'server-only-api', n.args[0], `'${sv}' 은(는) 클라이언트 전용이라 서버에서는 동작하지 않습니다`, 'LocalScript 로 옮기세요');
      }
    }
    for (const a of n.args) { markEscape(a); visit(a); }
    if (YIELDERS_METHOD.has(n.name)) curFn().yields = true;
    curFn().calls.add(':' + n.name);
  }

  function visitFunc(f, selfParam) {
    const meta = { name: f.name || '(익명)', line: f.line, endLine: f.endLine, params: f.params.length, vararg: f.vararg, complexity: 1, yields: false, calls: new Set(), loopDepth: 0, maxLoop: 0, nesting: 0, maxNesting: 0 };
    fnStack.push({ ...meta, vararg: f.vararg, ref: meta });
    const saveLoops = loopStack.splice(0);
    push('function');
    if (selfParam) declare({ v: 'self', line: f.line, col: f.col }, 'param');
    for (const p of f.params) declare(p, 'param');
    visitBlock(f.body, false);
    pop();
    loopStack.splice(0, loopStack.length, ...saveLoops);
    const top = fnStack.pop();
    meta.complexity = top.complexity; meta.maxLoop = top.maxLoop; meta.maxNesting = top.maxNesting; meta.recursive = f.name ? top.calls.has(f.name) || top.calls.has(':' + f.name) : false;
    functions.push({ name: meta.name, line: f.line, lines: f.endLine - f.line + 1, cyclomatic: top.complexity, maxNesting: top.maxNesting, loopDepth: top.maxLoop, recursive: meta.recursive });
  }

  let nest = 0;
  function enterBlockCtx(kind) { nest++; const t = curFn(); if (nest > t.maxNesting) t.maxNesting = nest; if (kind === 'loop') { t.loopDepth++; if (t.loopDepth > t.maxLoop) t.maxLoop = t.loopDepth; } }
  function leaveBlockCtx(kind) { nest--; if (kind === 'loop') curFn().loopDepth--; }

  function visitBlock(body, newScope = true) {
    if (newScope) push('block');
    let dead = null;
    for (const s of body) {
      if (dead) { add('warning', 'unreachable', s, `'${dead.k === 'Return' ? 'return' : dead.k === 'Break' ? 'break' : 'continue'}'(${dead.line}줄) 뒤라서 실행되지 않는 코드입니다`); dead = null; }
      visitStmt(s);
      if (s.k === 'Return' || s.k === 'Break' || s.k === 'Continue') dead = s;
    }
    if (newScope) pop();
  }

  function containsYield(body, stopAtFunc = true) {
    let found = false, exits = false;
    const walk = x => {
      if (!x || typeof x !== 'object' || found) return;
      if (Array.isArray(x)) { x.forEach(walk); return; }
      if (x.k === 'Func' && stopAtFunc) return;
      if (x.k === 'Break' || x.k === 'Return') exits = true;
      if (x.k === 'Call') { const t = calleeText(x.fn); if ((t && YIELDERS_DOT.has(t)) || (x.fn.k === 'Name' && YIELDERS_NAME.has(x.fn.name))) found = true; }
      if (x.k === 'MethodCall' && YIELDERS_METHOD.has(x.name)) found = true;
      for (const key of Object.keys(x)) { if (key === 'k' || key === 'line' || key === 'col') continue; const v = x[key]; if (v && typeof v === 'object') walk(v); }
    };
    walk(body);
    return found || exits;
  }
  const isTrueLit = e => e && (e.k === 'Bool' && e.v === true || (e.k === 'Num' && Number(e.v) !== 0));

  function visitStmt(s) {
    switch (s.k) {
      case 'Local': {
        visitExprs(s.exprs);
        s.names.forEach((nm, i) => {
          const init = s.exprs[i];
          const v = declare(nm, 'local');
          if (init && init.k === 'Name') markEscape(init);
          if (init && init.k === 'Table' && s.names.length === 1) {
            const fields = new Set(init.fields.filter(f => f.kind === 'name').map(f => f.key.v));
            v.table = { fields, dynamic: init.fields.some(f => f.kind === 'expr' || f.kind === 'pos'), escaped: false, meta: false };
          }
        });
        return;
      }
      case 'LocalFunction': { const v = declare(s.name, 'function'); visitFunc(s.func); return; }
      case 'Function': {
        let target;
        const baseTok = { name: s.base.v, line: s.base.line, col: s.base.col };
        if (!s.path.length && !s.method) {
          const v = lookup(s.base.v);
          if (v) v.writes++; else if (!isKnownGlobal(s.base.v)) assignedGlobals.set(s.base.v, s.base);
          visitFunc(s.func);
          return;
        }
        const v = readName({ name: s.base.v, line: s.base.line, col: s.base.col }, false);
        const last = s.method ? s.method.v : s.path[s.path.length - 1].v;
        if (v && v.table && s.path.length + (s.method ? 1 : 0) === 1) v.table.fields.add(last);
        else if (v && v.table) v.table.dynamic = true;
        visitFunc(s.func, !!s.method);
        return;
      }
      case 'Assign': {
        for (const e of s.exprs) { markEscape(e); visit(e); }
        for (const t of s.targets) {
          if (t.k === 'Name') {
            const v = lookup(t.name);
            if (v) { v.writes++; if (s.op !== '=') v.reads++; }
            else if (!isKnownGlobal(t.name)) { if (!assignedGlobals.has(t.name)) { assignedGlobals.set(t.name, t); add('warning', 'implicit-global', t, `'${t.name}' 을(를) local 없이 대입했습니다 — 전역 변수가 됩니다`, `local ${t.name} = ... 로 선언하세요 (전역은 오타·충돌의 원인)`); } }
            else if (env === 'roblox' && ['game', 'workspace', 'script', 'Instance', 'Vector3', 'CFrame'].includes(t.name)) add('warning', 'assign-builtin', t, `내장 전역 '${t.name}' 을(를) 덮어쓰려 합니다`);
          } else if (t.k === 'Dot') {
            visit(t.obj);
            if (t.obj.k === 'Name') { const v = lookup(t.obj.name); if (v && v.table) { if (s.op === '=') v.table.fields.add(t.name); else fieldReads.push({ v, name: t.name, node: t }); } }
            if (t.obj.k === 'MethodCall' && NIL_RETURNING.has(t.obj.name)) add('warning', 'nil-index', t, `${t.obj.name} 의 결과는 nil 일 수 있는데 바로 .${t.name} 에 대입합니다`, 'nil 확인 후 사용하세요');
          } else { visit(t.obj); visit(t.key); if (t.obj.k === 'Name') { const v = lookup(t.obj.name); if (v && v.table) v.table.dynamic = true; } }
        }
        return;
      }
      case 'CallStat': visit(s.e); return;
      case 'If': {
        enterBlockCtx('if');
        for (const c of s.clauses) { visit(c.cond); curFn().complexity++; visitBlock(c.body); }
        if (s.orelse) visitBlock(s.orelse);
        leaveBlockCtx('if');
        return;
      }
      case 'While': {
        visit(s.cond); curFn().complexity++;
        if (isTrueLit(s.cond) && env === 'roblox' && !containsYield(s.body)) add('warning', 'infinite-loop', s, "'while true do' 안에 wait/task.wait 같은 대기가 없어 스크립트가 멈춥니다 (Script exhausted allowed execution time)", '루프 안에 task.wait() 를 넣거나 이벤트(RunService.Heartbeat:Connect)로 바꾸세요');
        enterBlockCtx('loop'); loopStack.push('while'); visitBlock(s.body); loopStack.pop(); leaveBlockCtx('loop');
        return;
      }
      case 'Repeat': {
        enterBlockCtx('loop'); loopStack.push('repeat'); curFn().complexity++;
        push('block');
        visitBlock(s.body, false);
        visit(s.cond);
        pop();
        loopStack.pop(); leaveBlockCtx('loop');
        if (s.cond.k === 'Bool' && s.cond.v === false && env === 'roblox' && !containsYield(s.body)) add('warning', 'infinite-loop', s, "'repeat … until false' 안에 대기(task.wait)가 없어 스크립트가 멈춥니다", 'task.wait() 를 넣으세요');
        return;
      }
      case 'NumFor': {
        visit(s.start); visit(s.stop); if (s.step) visit(s.step); curFn().complexity++;
        enterBlockCtx('loop'); loopStack.push('for');
        push('block'); declare(s.v, 'for'); visitBlock(s.body, false); pop();
        loopStack.pop(); leaveBlockCtx('loop');
        return;
      }
      case 'GenFor': {
        visitExprs(s.exprs); curFn().complexity++;
        enterBlockCtx('loop'); loopStack.push('for');
        push('block'); s.vars.forEach(v => declare(v, 'for')); visitBlock(s.body, false); pop();
        loopStack.pop(); leaveBlockCtx('loop');
        // for _, v in obj:GetChildren() 대신 obj.GetChildren() 같은 실수는 Call 방문에서 처리
        return;
      }
      case 'Do': visitBlock(s.body); return;
      case 'Return': visitExprs(s.exprs); for (const e of s.exprs) if (e && e.k === 'Name') { /* 반환은 외부 사용 */ } return;
      case 'Break': if (!loopStack.length) add('error', 'break-outside-loop', s, "'break' 는 반복문(for/while/repeat) 안에서만 쓸 수 있습니다", '조건문 안에서 함수를 빠져나오려면 return 을 쓰세요'); return;
      case 'Continue': if (!loopStack.length) add('error', 'break-outside-loop', s, "'continue' 는 반복문 안에서만 쓸 수 있습니다"); return;
      case 'TypeAlias': return;
      default: return;
    }
  }

  // ----- 실행 -----
  const top = { name: '(메인)', vararg: true, complexity: 1, yields: false, calls: new Set(), loopDepth: 0, maxLoop: 0, maxNesting: 0 };
  fnStack.push(top);
  push('chunk');
  visitBlock(ast.body, false);
  pop();

  // 정의되지 않은 이름 보고 (전역 대입이 파일 어딘가에 있으면 정의된 것으로 본다)
  const seen = new Set();
  for (const { node, asCall } of undefinedReads) {
    if (assignedGlobals.has(node.name)) continue;
    const key = node.name + ':' + node.line;
    if (seen.has(key)) continue; seen.add(key);
    const later = allDecls.get(node.name);
    if (later) {
      add('error', 'use-before-define', node, `'${node.name}' 을(를) ${node.line}줄에서 쓰는데, 그 시점에는 아직 정의되지 않았습니다 (local 선언은 ${later.line}줄)`, `'${node.name}' 선언을 사용하는 코드보다 위로 옮기거나, 맨 위에서 local ${node.name} 로 먼저 선언한 뒤 나중에 ${node.name} = function ... 으로 채우세요`);
      continue;
    }
    const names = [];
    for (const v of varsAll) names.push(v.name);
    const sug = A.closest(node.name, [...new Set([...names, ...allGlobalNames()])]);
    add('error', asCall ? 'undefined-function' : 'undefined-variable', node, `${asCall ? '함수' : '변수'} '${node.name}' 이(가) 정의되어 있지 않습니다`, sug ? `'${sug}' 의 오타?` : `local ${node.name} = ... 로 선언했는지, 다른 스크립트(require)에서 가져와야 하는지 확인하세요`, sug ? { line: node.line, col: node.col, from: node.name, to: sug } : null);
  }

  // 로컬 테이블(모듈)의 없는 필드
  const fieldSeen = new Set();
  for (const r of fieldReads) {
    const t = r.v.table;
    if (!t || t.meta || t.escaped || t.dynamic) continue;
    if (t.fields.has(r.name) || r.name === '__index' || r.name === '__newindex') continue;
    const key = r.v.name + '.' + r.name + ':' + r.node.line;
    if (fieldSeen.has(key)) continue; fieldSeen.add(key);
    const s = A.closest(r.name, [...t.fields]);
    add('warning', 'undefined-field', r.node, `'${r.v.name}.${r.name}' 은(는) 이 파일에서 정의되지 않았습니다 (${r.v.name} 에 ${[...t.fields].slice(0, 8).join(', ') || '필드 없음'} 만 정의됨)`, s ? `'${r.v.name}.${s}' 의 오타?` : `${r.method ? 'function ' + r.v.name + ':' + r.name + '() ... end' : r.v.name + '.' + r.name + ' = ...'} 로 정의하세요`);
  }

  return { issues, functions };
}

const ORDER = { error: 0, warning: 1, info: 2 };
function contextOf(filename) {
  const f = String(filename || '').toLowerCase();
  return /\.server\.luau?$/.test(f) ? 'server' : /\.client\.luau?$/.test(f) ? 'client' : null;
}
function analyzeLuau(src, o = {}) {
  if (!o.context && o.filename) o = { ...o, context: contextOf(o.filename) };
  let ast;
  try { ast = parse(src); }
  catch (e) {
    if (!e.isSyntax) throw e;
    const issues = [{ sev: 'error', rule: 'syntax', line: e.line, col: e.col, message: `문법 오류: ${e.message}`, suggestion: e.hint || undefined }];
    return { syntax: { ok: false, line: e.line, col: e.col, message: e.message, hint: e.hint, frame: A.codeFrame(src, e.line, e.col) }, issues, functions: [], stage: 'syntax' };
  }
  const r = analyzeAst(ast, src, o);
  r.issues.sort((a, b) => ORDER[a.sev] - ORDER[b.sev] || a.line - b.line || a.col - b.col);
  return { syntax: { ok: true }, issues: r.issues, functions: r.functions, stage: 'analysis', ast };
}

// 여러 파일 교차 검사용: 파일이 require 하는 모듈 이름(script.Parent.Name / script.Name / game.X.Y.Name)
function requiresOf(ast) {
  const out = [];
  const walk = x => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (x.k === 'Call' && x.fn.k === 'Name' && x.fn.name === 'require' && x.args[0]) {
      const a = x.args[0];
      if (a.k === 'Dot') { const chain = []; let c = a; while (c && c.k === 'Dot') { chain.unshift(c.name); c = c.obj; } out.push({ line: x.line, col: x.col, name: a.name, root: c && c.k === 'Name' ? c.name : null, chain }); }
      else if (a.k === 'Str') out.push({ line: x.line, col: x.col, name: a.v, root: null, chain: [], str: true });
    }
    for (const key of Object.keys(x)) { if (key === 'k') continue; const v = x[key]; if (v && typeof v === 'object') walk(v); }
  };
  walk(ast);
  return out;
}

// 확실한 수정(edit)만 적용하고, 적용 후 문법을 다시 검사한다
function autofixLuau(src, o = {}) {
  const r = analyzeLuau(src, o);
  if (r.stage !== 'analysis') return { changed: false, reason: '문법 오류가 있어 자동 수정을 건너뜁니다. 먼저 문법 오류를 고치세요' };
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  const edits = [], changes = [], seen = new Set();
  for (const i of r.issues) {
    const e = i.edit; if (!e || starts[e.line - 1] === undefined) continue;
    const pos = starts[e.line - 1] + e.col - 1;
    if (src.substr(pos, e.from.length) !== e.from || seen.has(pos)) continue;
    seen.add(pos); edits.push({ pos, end: pos + e.from.length, text: e.to }); changes.push(`${e.line}줄: ${e.from} → ${e.to}`);
  }
  if (!edits.length) return { changed: false, reason: '자동으로 안전하게 고칠 항목이 없습니다 (analyze_code 결과를 보고 직접 수정)' };
  let out = src;
  for (const e of edits.sort((a, b) => b.pos - a.pos)) out = out.slice(0, e.pos) + e.text + out.slice(e.end);
  try { parse(out); } catch (err) { return { changed: false, reason: '자동 수정 후 문법 오류가 생겨 취소했습니다', error: err.message }; }
  return { changed: true, count: edits.length, changes: changes.slice(0, 40), fixed_code: out };
}

module.exports = { analyzeLuau, autofixLuau, contextOf, parse, tokenize, requiresOf, LIB_MEMBERS, SERVICES, ROBLOX_GLOBALS, LUAU_GLOBALS };
