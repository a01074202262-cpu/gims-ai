'use strict';
// Luau / Roblox 보조 도구: 오류 메시지 해설, 구조 요약, 보안 점검, 검증된 예제 코드
//  luau_explain_error     : Roblox 출력창 오류 메시지 → 원인·고치는 법·예시
//  luau_outline           : 스크립트 구조 요약 (서비스, require, 함수, 이벤트 연결, 리모트, 루프)
//  luau_security_review   : RemoteEvent 인자 검증 누락, loadstring, 관리자 이름 비교, DataStore 키 등
//  luau_snippet           : pcall 재시도 DataStore, 쿨다운, 레이캐스트 등 분석기를 통과한 예제
const LU = require('./luau_analyzer');

const S = (type, description, extra = {}) => ({ type, description, ...extra });
const OBJ = (properties, required) => ({ type: 'OBJECT', properties, required });
const IMPL = {};

// ---------------------------------------------------------------------------
// 1) 오류 해설
// ---------------------------------------------------------------------------
const ERRORS = [
  { re: /attempt to index nil with '?"?([\w]+)"?'?/i, title: 'nil 값의 필드에 접근 (attempt to index nil)', cause: (m) => `점(.) 앞의 값이 nil 인데 '${m[1]}' 에 접근했습니다. 보통 FindFirstChild/WaitForChild 가 대상을 못 찾았거나, 아직 로드되기 전이거나, 이름·경로 오타입니다.`,
    fixes: ['nil 이 되는 앞쪽 변수를 print 로 찍어 어디서 nil 이 되는지 찾기', ':FindFirstChild("X") 대신 :WaitForChild("X", 5) 로 로드를 기다리기', 'if obj then ... end 로 nil 확인 후 사용', '이름의 대소문자·공백까지 Explorer 와 똑같은지 확인'],
    example: 'local hum = char:WaitForChild("Humanoid", 5)\nif hum then hum.Health = 0 end' },
  { re: /(\w+) is not a valid member of ([\w.]+)/i, title: '존재하지 않는 멤버 (is not a valid member)', cause: (m) => `${m[2]} 안에 '${m[1]}' 이(가) 없습니다. 이름 오타이거나, 아직 생성되지 않았거나(클라이언트 복제 지연), 서버/클라이언트 한쪽에만 있는 객체일 수 있습니다.`,
    fixes: [`Explorer 에서 실제 이름 확인 (대소문자 구분)`, `:WaitForChild("${'멤버'}") 로 로드될 때까지 기다리기`, 'ServerStorage/ServerScriptService 안의 것은 클라이언트에서 볼 수 없음 → ReplicatedStorage 로 옮기기', 'StreamingEnabled 면 멀리 있는 Part 는 아직 없을 수 있음'],
    example: 'local gui = player:WaitForChild("PlayerGui"):WaitForChild("ScreenGui")' },
  { re: /attempt to call a nil value(?: \((?:method|field|global|upvalue|local) '?([\w]+)'?\))?/i, title: 'nil 을 함수처럼 호출 (attempt to call a nil value)', cause: (m) => `${m[1] ? `'${m[1]}' 은(는)` : '호출한 대상이'} 정의되어 있지 않습니다. 함수 이름 오타, 정의보다 먼저 호출(local function 은 아래에서 선언하면 위에서 못 씀), 모듈에서 return 하지 않은 함수, 또는 : 와 . 혼동일 수 있습니다.`,
    fixes: ['함수 이름 철자 확인 (analyze_luau 가 오타 후보를 알려 줌)', 'local function 은 호출하는 코드보다 위에 선언하기', 'ModuleScript 가 return 하는 테이블에 그 함수가 들어 있는지 확인', '메서드는 obj:Method(), 모듈 함수는 Module.func()'],
    example: 'local function helper() end   -- 호출보다 위에\nhelper()' },
  { re: /Infinite yield possible on '([^']+)'/i, title: 'WaitForChild 무한 대기 경고', cause: (m) => `${m[1]} 을(를) 5초 넘게 기다리는 중입니다. 그 이름의 객체가 없거나 경로가 틀렸습니다 (오류는 아니지만 스크립트가 거기서 멈춤).`,
    fixes: ['경로·이름 철자 확인', '두 번째 인자로 타임아웃을 주고 nil 처리: :WaitForChild("X", 10)', '객체를 만드는 스크립트가 실행되는지, 서버 전용 위치가 아닌지 확인'],
    example: 'local part = workspace:WaitForChild("Door", 10)\nif not part then warn("Door 없음") return end' },
  { re: /attempt to perform arithmetic \((\w+)\) on (\w+) and (\w+)/i, title: '산술 연산 타입 오류', cause: (m) => `${m[2]} 와 ${m[3]} 를 '${m[1]}' 연산했습니다. 한쪽이 nil 이거나 문자열/테이블입니다 (예: 값이 아직 설정되지 않음, .Value 를 빼먹음).`,
    fixes: ['nil 인 변수 찾기 (print 로 타입 확인: typeof(x))', 'IntValue 는 값 자체가 아니라 .Value 를 써야 함', '문자열 숫자는 tonumber() 로 변환', '기본값 부여: local n = tonumber(x) or 0'],
    example: 'local coins = tonumber(stats.Coins.Value) or 0\nstats.Coins.Value = coins + 1' },
  { re: /attempt to compare (\w+) (<|<=|>|>=) (\w+)|attempt to compare (\w+) with (\w+)/i, title: '비교 연산 타입 오류', cause: () => '서로 다른 타입(예: nil 과 number)을 <, > 로 비교했습니다. 한쪽 값이 nil 입니다.',
    fixes: ['비교 전에 typeof(x) == "number" 확인', '기본값 사용: (x or 0) > 5'], example: 'if (health or 0) > 0 then ... end' },
  { re: /attempt to concatenate (\w+)/i, title: '문자열 이어붙이기 오류', cause: (m) => `.. 로 이어붙일 때 ${m[1]} 값이 섞였습니다 (nil 이거나 테이블/Instance).`,
    fixes: ['tostring(x) 로 변환', 'Instance 는 .Name 사용', '백틱 보간 사용: `${name}: {score}`'], example: 'print("점수: " .. tostring(score))' },
  { re: /exhausted allowed execution time|Script timeout/i, title: '스크립트 실행 시간 초과', cause: () => '대기(yield) 없이 너무 오래 도는 반복문 때문에 스크립트가 강제 종료됐습니다 (while true do 안에 task.wait 없음 등).',
    fixes: ['반복문 안에 task.wait() 넣기', '무거운 작업은 쪼개서 task.wait() 로 프레임 양보', '프레임마다 필요하면 RunService.Heartbeat:Connect 사용'], example: 'while true do\n\tupdate()\n\ttask.wait(0.1)\nend' },
  { re: /Expected '?(end|then|do|until)'?|Expected identifier|Malformed number|Unexpected/i, title: '문법 오류', cause: () => 'Luau 가 코드를 해석하지 못했습니다. end/then/do 누락이나 괄호 불일치, = 와 == 혼동이 흔합니다.',
    fixes: ['analyze_luau 로 줄·칸과 짝이 안 맞는 블록 확인', 'if/for/while/function 마다 end 한 개씩', '비교는 ==, 같지 않음은 ~='], example: 'if x == 1 then\n\tprint("one")\nend' },
  { re: /Players\.LocalPlayer|LocalPlayer.*nil/i, title: 'LocalPlayer 가 nil', cause: () => 'LocalPlayer 는 LocalScript(클라이언트)에서만 있습니다. 서버 Script 에서는 nil 입니다.',
    fixes: ['서버에서는 Players.PlayerAdded 의 player 인자 사용', '클라이언트 코드면 LocalScript 로 만들고 StarterPlayerScripts 등에 두기'], example: 'Players.PlayerAdded:Connect(function(player) ... end)' },
  { re: /HttpService is not allowed|Http requests are not enabled|HTTP 403|HttpError/i, title: 'HTTP 요청 실패', cause: () => 'HttpService 요청이 막혀 있거나 서버가 거부했습니다.',
    fixes: ['Game Settings → Security → Allow HTTP Requests 켜기', 'HTTP 호출은 pcall 로 감싸고 실패 시 재시도', 'roblox.com 도메인은 직접 호출 불가 (프록시 필요)'], example: 'local ok, res = pcall(HttpService.GetAsync, HttpService, url)' },
  { re: /DataStore|API Services|502|StudioAccessToApiServices|queue/i, title: 'DataStore 오류', cause: () => 'Studio 에서 API 접근이 꺼져 있거나, 요청이 너무 잦거나(제한), 네트워크 일시 오류입니다.',
    fixes: ['Game Settings → Security → Enable Studio Access to API Services 켜기', '모든 DataStore 호출을 pcall + 재시도(대기 늘리기)로 감싸기', '저장은 접속 종료/주기적으로만 (요청 수 줄이기)', '키는 player.UserId 사용'], example: 'luau_snippet kind=datastore 참고' },
  { re: /Unable to assign property (\w+)\.?\s*(.*)/i, title: '속성 타입 오류', cause: (m) => `속성 ${m[1]} 에 맞지 않는 타입을 대입했습니다. ${m[2] || ''}`,
    fixes: ['속성 타입 확인 (Color3 vs BrickColor, UDim2, Vector3 …)', 'Color3.fromRGB(r,g,b), UDim2.new(sx,ox,sy,oy), Vector3.new(x,y,z) 사용'], example: 'part.Color = Color3.fromRGB(255, 0, 0)\npart.Size = Vector3.new(4, 1, 2)' },
  { re: /Argument (\d+) missing or nil/i, title: '필수 인자 누락', cause: (m) => `함수의 ${m[1]}번째 인자가 비었거나 nil 입니다.`,
    fixes: ['호출할 때 인자 순서/개수 확인', 'nil 이 될 수 있는 변수는 사전에 확인', ':Method() 호출을 . 로 불러서 self 가 밀렸는지 확인'], example: 'part:Destroy()   -- part.Destroy() 가 아님' },
  { re: /stack overflow|Stack Begin/i, title: '재귀 스택 오버플로', cause: () => '종료 조건 없는 재귀 호출입니다.', fixes: ['재귀 함수에 종료 조건(base case) 추가', '반복문으로 바꾸기', 'Changed 이벤트에서 같은 속성을 다시 바꾸는지 확인'], example: 'if n <= 1 then return 1 end' },
  { re: /Remote event invocation queue exhausted|event queue/i, title: 'RemoteEvent 큐 초과', cause: () => '리모트를 너무 자주 보내서 대기열이 가득 찼습니다 (매 프레임 FireServer 등).', fixes: ['보내는 빈도 줄이기(쿨다운/배치 전송)', '값이 바뀔 때만 전송', '서버에서 속도 제한(rate limit) 걸기'], example: 'luau_snippet kind=rate_limit 참고' },
  { re: /Cannot load Asset|Failed to load sound|Asset is not trusted|is not approved/i, title: '에셋 로드 실패', cause: () => '에셋 ID 가 틀렸거나, 게임/그룹이 사용할 권한이 없거나, 삭제·검열된 에셋입니다.', fixes: ['rbxassetid://숫자 형식인지 확인', '에셋 소유자/권한(공개 여부) 확인', '다른 에셋으로 교체'], example: 'sound.SoundId = "rbxassetid://1234567890"' },
  { re: /require.*(invalid argument|error while loading|did not return exactly one value)|Attempted to call require/i, title: 'require 실패', cause: () => 'require 대상이 ModuleScript 가 아니거나, 모듈이 로드 중 오류를 냈거나, 값을 정확히 하나 return 하지 않았습니다.', fixes: ['require(script.Parent.Module) 경로 확인 (ModuleScript 여야 함)', '모듈 끝에 return 테이블 한 개', '순환 require(A↔B) 피하기'], example: 'local M = {}\nfunction M.hello() end\nreturn M' }
];

IMPL.luau_explain_error = ({ error }) => {
  const text = String(error || '').slice(0, 4000);
  if (!text.trim()) throw new Error('error 에 Roblox 출력창의 오류 메시지를 넣어 주세요');
  const line = (/:(\d+)(?::|\b)/.exec(text) || [])[1];
  const script = (/([\w.]+(?:\.[\w]+)*):\d+/.exec(text) || [])[1];
  const found = [];
  for (const e of ERRORS) {
    const m = e.re.exec(text);
    if (m) found.push({ title: e.title, cause: e.cause(m), fixes: e.fixes, example: e.example });
    if (found.length >= 3) break;
  }
  return {
    ...(script ? { script } : {}), ...(line ? { line: Number(line) } : {}),
    matched: found.length,
    explanations: found.length ? found : [{ title: '알 수 없는 오류', cause: '알려진 패턴과 일치하지 않습니다.', fixes: ['메시지의 스크립트 경로와 줄 번호 위치를 확인', '코드를 analyze_luau 로 검사', '문제 줄 앞뒤에서 print/warn 으로 값과 typeof 확인'] }],
    next: '코드를 알려 주면 analyze_luau 로 같은 줄 주변의 원인을 직접 찾을 수 있습니다'
  };
};

// ---------------------------------------------------------------------------
// 공용: AST 순회
// ---------------------------------------------------------------------------
function walk(node, cb, parent = null) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(n => walk(n, cb, parent)); return; }
  if (node.k && cb(node, parent) === false) return;
  for (const key of Object.keys(node)) {
    if (key === 'k') continue;
    const v = node[key];
    if (v && typeof v === 'object') walk(v, cb, node.k ? node : parent);
  }
}
const textOf = e => {
  if (!e) return null;
  if (e.k === 'Name') return e.name;
  if (e.k === 'Dot') { const o = textOf(e.obj); return o ? o + '.' + e.name : null; }
  if (e.k === 'MethodCall') { const o = textOf(e.obj); return o ? o + ':' + e.name : null; }
  if (e.k === 'Call') return textOf(e.fn);
  if (e.k === 'Str') return JSON.stringify(e.v);
  return null;
};
function parseOrError(code) {
  const src = String(code || '');
  if (!src.trim()) throw new Error('code 가 비어 있습니다');
  const r = LU.analyzeLuau(src, {});
  if (r.stage !== 'analysis') return { error: r.syntax };
  return { ast: r.ast, src, result: r };
}

// ---------------------------------------------------------------------------
// 2) 구조 요약
// ---------------------------------------------------------------------------
IMPL.luau_outline = ({ code }) => {
  const p = parseOrError(code);
  if (p.error) return { ok: false, syntax: p.error, note: '문법 오류가 있어 구조를 요약하지 못했습니다. 먼저 analyze_luau 로 고치세요' };
  const services = new Set(), requires = [], connections = [], remotes = [], loops = [], funcs = [], types = [];
  let returnsModule = false;
  walk(p.ast, n => {
    if (n.k === 'MethodCall' && n.name === 'GetService' && n.args[0] && n.args[0].k === 'Str') services.add(n.args[0].v);
    if (n.k === 'Call' && n.fn.k === 'Name' && n.fn.name === 'require' && n.args[0]) requires.push({ line: n.line, target: textOf(n.args[0]) || '(동적)' });
    if (n.k === 'MethodCall' && ['Connect', 'Once', 'ConnectParallel'].includes(n.name)) connections.push({ line: n.line, event: textOf(n.obj) || '(식)', method: n.name });
    if (n.k === 'MethodCall' && ['FireServer', 'FireClient', 'FireAllClients', 'InvokeServer', 'InvokeClient'].includes(n.name)) remotes.push({ line: n.line, kind: n.name, remote: textOf(n.obj) || '(식)' });
    if (n.k === 'Assign' && n.targets[0] && n.targets[0].k === 'Dot' && n.targets[0].name === 'OnServerInvoke') remotes.push({ line: n.line, kind: 'OnServerInvoke', remote: textOf(n.targets[0].obj) });
    if (n.k === 'While') loops.push({ line: n.line, type: 'while', infinite: n.cond.k === 'Bool' && n.cond.v === true });
    if (n.k === 'Repeat') loops.push({ line: n.line, type: 'repeat' });
    if (n.k === 'Function') funcs.push({ line: n.line, name: [n.base.v, ...n.path.map(x => x.v)].join('.') + (n.method ? ':' + n.method.v : ''), params: n.func.params.map(x => x.v) });
    if (n.k === 'LocalFunction') funcs.push({ line: n.line, name: n.name.v, params: n.func.params.map(x => x.v), local: true });
    if (n.k === 'TypeAlias') types.push({ line: n.line, name: n.name.v });
  });
  const body = p.ast.body, last = body[body.length - 1];
  if (last && last.k === 'Return' && last.exprs.length) returnsModule = true;
  const kind = returnsModule ? 'ModuleScript (값을 return)' : services.has('Players') && /LocalPlayer/.test(p.src) ? 'LocalScript 로 보임' : connections.length || funcs.length ? 'Script/LocalScript' : '단순 스크립트';
  const clip = (a, n = 40) => ({ total: a.length, items: a.slice(0, n) });
  return {
    ok: true, lines: p.src.split('\n').length, kind, services: [...services].sort(), requires: clip(requires), functions: clip(funcs), eventConnections: clip(connections), remotes: clip(remotes), loops: clip(loops), types: clip(types, 20),
    issues: p.result.issues.filter(i => i.sev !== 'info').length
  };
};

// ---------------------------------------------------------------------------
// 3) 보안 점검 (방어용: 내 게임의 취약점 찾기)
// ---------------------------------------------------------------------------
const HANDLER_METHODS = new Set(['OnServerEvent']);
const CHECK_FNS = new Set(['typeof', 'type', 'assert', 'tonumber', 'tostring', 'string', 'math']);
IMPL.luau_security_review = ({ code }) => {
  const p = parseOrError(code);
  if (p.error) return { ok: false, syntax: p.error, note: '문법 오류를 먼저 고치세요' };
  const findings = [];
  const add = (sev, rule, node, message, fix) => findings.push({ sev, rule, line: node.line || 0, message, fix });

  const usesParam = (node, name) => { let u = false; walk(node, n => { if (n.k === 'Name' && n.name === name) u = true; }); return u; };
  const validated = (body, name) => {
    let ok = false;
    walk(body, n => {
      if (ok) return false;
      if (n.k === 'If' && n.clauses.some(c => usesParam(c.cond, name))) ok = true;
      if (n.k === 'Call' && n.fn.k === 'Name' && ['typeof', 'type', 'assert', 'tonumber'].includes(n.fn.name) && n.args.some(a => usesParam(a, name))) ok = true;
      if (n.k === 'Call' && n.fn.k === 'Dot' && n.fn.obj.k === 'Name' && n.fn.obj.name === 'math' && ['clamp', 'min', 'max'].includes(n.fn.name) && n.args.some(a => usesParam(a, name))) ok = true;
      if (n.k === 'Binop' && ['==', '~=', '<', '>', '<=', '>='].includes(n.op) && (usesParam(n.l, name) || usesParam(n.r, name))) ok = true;
      return undefined;
    });
    return ok;
  };

  walk(p.ast, n => {
    // RemoteEvent.OnServerEvent:Connect(function(player, a, b) ...)
    if (n.k === 'MethodCall' && n.name === 'Connect' && n.obj.k === 'Dot' && HANDLER_METHODS.has(n.obj.name) && n.args[0] && n.args[0].k === 'Func') {
      const fn = n.args[0], params = fn.params.map(x => x.v);
      const player = params[0];
      params.slice(1).forEach(prm => {
        if (!usesParam(fn.body, prm)) return;
        if (!validated(fn.body, prm)) add('error', 'unvalidated-remote-arg', n, `리모트 인자 '${prm}' 을(를) 검증 없이 사용합니다 — 클라이언트(익스플로잇)가 임의의 값·타입을 보낼 수 있습니다`, `typeof(${prm}) == "number" 같은 타입 확인과 범위 확인(math.clamp), 허용 목록 비교를 하세요. 서버가 결과(보상·피해)를 직접 계산하세요`);
      });
      if (player && !usesParam(fn.body, player)) add('info', 'remote-no-player', n, '리모트 핸들러가 player 를 쓰지 않습니다 — 누가 보냈는지 확인(권한·쿨다운)이 필요한지 점검하세요');
      let hasRate = false;
      walk(fn.body, x => { if (x.k === 'Call' && x.fn.k === 'Dot' && x.fn.name === 'clock') hasRate = true; if (x.k === 'Name' && /cooldown|debounce|lastFire|lastUse|rate/i.test(x.name)) hasRate = true; });
      if (!hasRate) add('warning', 'remote-no-ratelimit', n, '리모트 핸들러에 쿨다운/속도 제한이 보이지 않습니다 (연타·스팸으로 서버 부하·악용 가능)', 'player 별 마지막 호출 시각을 저장해 일정 시간 안의 호출은 무시하세요 (luau_snippet kind=rate_limit)');
    }
    if (n.k === 'Assign' && n.targets[0] && n.targets[0].k === 'Dot' && n.targets[0].name === 'OnServerInvoke' && n.exprs[0] && n.exprs[0].k === 'Func') {
      const fn = n.exprs[0];
      fn.params.slice(1).forEach(prm => { if (usesParam(fn.body, prm.v) && !validated(fn.body, prm.v)) add('error', 'unvalidated-remote-arg', n, `OnServerInvoke 인자 '${prm.v}' 검증이 없습니다`, '타입·범위 확인을 추가하세요'); });
    }
    if (n.k === 'Call' && n.fn.k === 'Name' && n.fn.name === 'loadstring') add('error', 'loadstring', n, 'loadstring 은 임의 코드 실행 통로입니다 (기본 비활성이며, 켜면 원격 코드 실행 위험)', '데이터는 JSON(HttpService:JSONDecode)이나 테이블로 처리하세요');
    if (n.k === 'Call' && n.fn.k === 'Name' && n.fn.name === 'require' && n.args[0] && n.args[0].k === 'Num') add('warning', 'require-asset-id', n, `숫자 ID(${n.args[0].v}) 모듈 require — 외부 코드가 업데이트되면 게임에 백도어가 들어올 수 있습니다`, '직접 검토한 ModuleScript 만 사용하세요');
    if (n.k === 'Call' && n.fn.k === 'Name' && (n.fn.name === 'getfenv' || n.fn.name === 'setfenv')) add('warning', 'fenv', n, `${n.fn.name} 는 환경 조작 함수로, 백도어 코드에서 자주 쓰입니다`, '정말 필요한지 확인하세요');
    if (n.k === 'Assign' && n.targets[0] && n.targets[0].k === 'Dot' && n.targets[0].name === 'Source') add('error', 'script-source', n, 'Script.Source 에 문자열을 대입해 코드를 주입하고 있습니다', '플러그인 외에는 사용하지 마세요');
    if (n.k === 'MethodCall' && ['GetAsync', 'SetAsync', 'UpdateAsync', 'IncrementAsync', 'RemoveAsync'].includes(n.name) && n.args[0]) {
      let usesName = false;
      walk(n.args[0], x => { if (x.k === 'Dot' && x.name === 'Name') usesName = true; });
      if (usesName) add('warning', 'datastore-name-key', n, 'DataStore 키에 player.Name 을 씁니다 — 이름은 바뀔 수 있어 데이터가 사라질 수 있습니다', '키는 player.UserId 를 사용하세요');
    }
    if (n.k === 'MethodCall' && ['GetAsync', 'PostAsync', 'RequestAsync'].includes(n.name) && n.obj.k === 'Name' && /http/i.test(n.obj.name) && n.args[0] && n.args[0].k !== 'Str') add('warning', 'dynamic-url', n, 'HTTP 요청 URL 이 동적으로 만들어집니다 — 사용자 입력이 섞이면 SSRF/데이터 유출 위험', 'URL 은 허용 목록의 고정 값으로 제한하세요');
    if (n.k === 'Binop' && (n.op === '==') && ((n.l.k === 'Dot' && n.l.name === 'Name' && n.r.k === 'Str') || (n.r.k === 'Dot' && n.r.name === 'Name' && n.l.k === 'Str'))) {
      const s = n.l.k === 'Str' ? n.l.v : n.r.v;
      if (/^[A-Za-z0-9_]{3,20}$/.test(s)) add('info', 'name-compare', n, `사용자 이름("${s}") 비교로 권한을 주고 있다면 취약합니다 (이름 변경·양도 가능)`, '관리자 판별은 UserId 숫자 또는 그룹 랭크(GetRankInGroup)로 하세요');
    }
  });
  const order = { error: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.sev] - order[b.sev] || a.line - b.line);
  const counts = { error: 0, warning: 0, info: 0 };
  findings.forEach(f => counts[f.sev]++);
  return { ok: counts.error === 0, counts, findings: findings.slice(0, 30), note: '정적 휴리스틱입니다. 서버 권한 검사(서버가 진실의 원천)와 Remote 인자 검증이 핵심 원칙입니다.' };
};

// ---------------------------------------------------------------------------
// 4) 예제 코드 (모두 analyze_luau 통과를 테스트로 확인)
// ---------------------------------------------------------------------------
const SNIPPETS = {
  datastore: { filename: 'DataStoreSave.server.luau', context: 'server', title: 'pcall + 재시도 DataStore 저장/불러오기', code: `--!strict
local Players = game:GetService("Players")
local DataStoreService = game:GetService("DataStoreService")

local store = DataStoreService:GetDataStore("PlayerData_v1")
local DEFAULT = { Coins = 0 }

local function withRetry(fn: () -> any, tries: number): (boolean, any)
	local lastErr: any = nil
	for attempt = 1, tries do
		local ok, result = pcall(fn)
		if ok then
			return true, result
		end
		lastErr = result
		task.wait(2 ^ attempt)   -- 점점 길게 대기
	end
	return false, lastErr
end

local function load(player: Player)
	local key = tostring(player.UserId)   -- 이름이 아니라 UserId
	local ok, data = withRetry(function()
		return store:GetAsync(key)
	end, 3)
	if not ok then
		warn("불러오기 실패:", data)
		player:Kick("데이터를 불러오지 못했습니다. 다시 접속해 주세요.")   -- 빈 데이터로 덮어쓰기 방지
		return
	end
	local coins = if type(data) == "table" and type(data.Coins) == "number" then data.Coins else DEFAULT.Coins
	local leaderstats = Instance.new("Folder")
	leaderstats.Name = "leaderstats"
	local value = Instance.new("IntValue")
	value.Name = "Coins"
	value.Value = coins
	value.Parent = leaderstats
	leaderstats.Parent = player
end

local function save(player: Player)
	local stats = player:FindFirstChild("leaderstats")
	local coins = stats and stats:FindFirstChild("Coins")
	if not coins or not coins:IsA("IntValue") then
		return
	end
	local ok, err = withRetry(function()
		return store:SetAsync(tostring(player.UserId), { Coins = coins.Value })
	end, 3)
	if not ok then
		warn("저장 실패:", err)
	end
end

Players.PlayerAdded:Connect(load)
Players.PlayerRemoving:Connect(save)
game:BindToClose(function()
	for _, player in Players:GetPlayers() do
		task.spawn(save, player)
	end
	task.wait(3)
end)
` },
  leaderstats: { filename: 'Leaderstats.server.luau', context: 'server', title: 'leaderstats(점수판) 만들기', code: `local Players = game:GetService("Players")

local function setup(player: Player)
	local folder = Instance.new("Folder")
	folder.Name = "leaderstats"

	local coins = Instance.new("IntValue")
	coins.Name = "Coins"
	coins.Value = 0
	coins.Parent = folder

	folder.Parent = player
end

Players.PlayerAdded:Connect(setup)
for _, player in Players:GetPlayers() do
	setup(player)
end
` },
  tween: { filename: 'TweenPart.server.luau', context: 'server', title: 'TweenService 로 Part 이동', code: `local TweenService = game:GetService("TweenService")

local part = workspace:WaitForChild("Door", 10)
if part and part:IsA("BasePart") then
	local info = TweenInfo.new(1, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)
	local goal = { Position = part.Position + Vector3.new(0, 10, 0) }
	local tween = TweenService:Create(part, info, goal)
	tween:Play()
	tween.Completed:Wait()
	print("완료")
end
` },
  raycast: { filename: 'Raycast.server.luau', context: 'server', title: '레이캐스트(앞쪽 물체 감지)', code: `local function castForward(origin: Vector3, direction: Vector3, ignore: { Instance })
	local params = RaycastParams.new()
	params.FilterType = Enum.RaycastFilterType.Exclude
	params.FilterDescendantsInstances = ignore
	return workspace:Raycast(origin, direction.Unit * 50, params)
end

local char = script.Parent
local root = char:FindFirstChild("HumanoidRootPart")
if root and root:IsA("BasePart") then
	local result = castForward(root.Position, root.CFrame.LookVector, { char })
	if result then
		print("맞음:", result.Instance.Name, result.Position)
	end
end
` },
  cooldown: { filename: 'Cooldown.server.luau', context: 'server', title: '쿨다운(디바운스) 패턴', code: `local COOLDOWN = 1.5
local lastUse: { [Player]: number } = {}

local function canUse(player: Player): boolean
	local now = os.clock()
	local last = lastUse[player]
	if last and now - last < COOLDOWN then
		return false
	end
	lastUse[player] = now
	return true
end

game:GetService("Players").PlayerRemoving:Connect(function(player)
	lastUse[player] = nil
end)

return canUse
` },
  remote_handler: { filename: 'RemoteHandler.server.luau', context: 'server', title: '검증이 있는 RemoteEvent 핸들러', code: `local ReplicatedStorage = game:GetService("ReplicatedStorage")

local remote = ReplicatedStorage:WaitForChild("BuyItem") :: RemoteEvent
local PRICES: { [string]: number } = { Sword = 100, Shield = 80 }
local lastFire: { [Player]: number } = {}

remote.OnServerEvent:Connect(function(player: Player, itemName: unknown)
	-- 속도 제한
	local now = os.clock()
	if lastFire[player] and now - lastFire[player] < 0.5 then
		return
	end
	lastFire[player] = now

	-- 타입·허용 목록 검증 (클라이언트 값은 믿지 않는다)
	if typeof(itemName) ~= "string" then
		return
	end
	local price = PRICES[itemName]
	if not price then
		return
	end

	-- 가격·잔액은 서버가 직접 확인
	local stats = player:FindFirstChild("leaderstats")
	local coins = stats and stats:FindFirstChild("Coins")
	if coins and coins:IsA("IntValue") and coins.Value >= price then
		coins.Value -= price
		print(player.Name, "구매:", itemName)
	end
end)
` },
  class_module: { filename: 'Counter.luau', context: 'module', title: '클래스(메타테이블) 모듈 패턴', code: `--!strict
local Counter = {}
Counter.__index = Counter

export type Counter = typeof(setmetatable({} :: { count: number }, Counter))

function Counter.new(start: number?): Counter
	return setmetatable({ count = start or 0 }, Counter)
end

function Counter.Increment(self: Counter, by: number?)
	self.count += by or 1
end

function Counter.Get(self: Counter): number
	return self.count
end

return Counter
` },
  heartbeat: { filename: 'HeartbeatLoop.server.luau', context: 'server', title: 'Heartbeat 로 프레임마다 실행 (while true 대신)', code: `local RunService = game:GetService("RunService")

local elapsed = 0
local connection: RBXScriptConnection
connection = RunService.Heartbeat:Connect(function(dt: number)
	elapsed += dt
	if elapsed >= 1 then
		elapsed = 0
		print("1초마다")
	end
end)

-- 필요 없어지면: connection:Disconnect()
` },
  touched: { filename: 'KillBrick.server.luau', context: 'server', title: 'Touched 디바운스 (킬 브릭)', code: `local part = script.Parent
local debounce: { [Model]: boolean } = {}

part.Touched:Connect(function(hit: BasePart)
	local character = hit.Parent
	if not character or not character:IsA("Model") or debounce[character] then
		return
	end
	local humanoid = character:FindFirstChildOfClass("Humanoid")
	if humanoid then
		debounce[character] = true
		humanoid.Health = 0
		task.wait(1)
		debounce[character] = nil
	end
end)
` },
  ui_button: { filename: 'Button.client.luau', context: 'client', title: 'GUI 버튼 클릭 → 서버에 요청', code: `local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local player = Players.LocalPlayer
local gui = player:WaitForChild("PlayerGui"):WaitForChild("ScreenGui")
local button = gui:WaitForChild("BuyButton") :: TextButton
local remote = ReplicatedStorage:WaitForChild("BuyItem") :: RemoteEvent

button.Activated:Connect(function()
	remote:FireServer("Sword")
end)
` },
  collection: { filename: 'Tags.server.luau', context: 'server', title: 'CollectionService 태그로 여러 객체에 같은 동작', code: `local CollectionService = game:GetService("CollectionService")

local function setup(instance: Instance)
	if instance:IsA("BasePart") then
		instance.Touched:Connect(function(hit)
			print(instance.Name, "에 닿음:", hit.Name)
		end)
	end
end

for _, inst in CollectionService:GetTagged("Hazard") do
	setup(inst)
end
CollectionService:GetInstanceAddedSignal("Hazard"):Connect(setup)
` },
  rate_limit: { filename: 'RateLimit.luau', context: 'module', title: '플레이어별 속도 제한 모듈', code: `local RateLimit = {}

local last: { [Player]: number } = {}

function RateLimit.allow(player: Player, interval: number): boolean
	local now = os.clock()
	local prev = last[player]
	if prev and now - prev < interval then
		return false
	end
	last[player] = now
	return true
end

game:GetService("Players").PlayerRemoving:Connect(function(player)
	last[player] = nil
end)

return RateLimit
` }
};
IMPL.luau_snippet = ({ kind }) => {
  const k = String(kind || '').trim().toLowerCase();
  if (!k || !SNIPPETS[k]) return { kinds: Object.entries(SNIPPETS).map(([name, v]) => ({ kind: name, title: v.title, filename: v.filename })), note: 'kind 에 위 이름 중 하나를 넣으면 코드를 돌려줍니다' };
  const s = SNIPPETS[k];
  return { kind: k, title: s.title, filename: s.filename, context: s.context, code: s.code, note: '이 예제는 analyze_luau 를 통과합니다. 이름·경로(WaitForChild 대상)는 게임에 맞게 바꾸세요.' };
};

const DECL = [
  { name: 'luau_explain_error', description: 'Roblox Studio 출력창의 오류/경고 메시지(예: "attempt to index nil with \'Humanoid\'", "X is not a valid member of Workspace", "Infinite yield possible on …")를 원인·고치는 법·예시로 해설한다. 스크립트 경로와 줄 번호도 뽑아 준다.',
    parameters: OBJ({ error: S('STRING', '출력창에 나온 오류 메시지 전체 (줄 번호 포함)') }, ['error']) },
  { name: 'luau_outline', description: 'Luau 스크립트의 구조를 요약한다: 사용 서비스, require 대상, 함수 목록, 이벤트 연결(:Connect), RemoteEvent 송수신, 반복문(무한 루프 표시), 타입 별칭. 긴 코드를 빠르게 파악하거나 리팩터링 전에 사용.',
    parameters: OBJ({ code: S('STRING', 'Luau 코드') }, ['code']) },
  { name: 'luau_security_review', description: '내 Roblox 게임 스크립트의 보안 취약점을 점검한다(방어용): RemoteEvent 인자 검증 누락·속도 제한 없음, loadstring, 숫자 ID require(백도어 위험), Script.Source 주입, DataStore 키에 이름 사용, 동적 HTTP URL, 이름으로 관리자 판별.',
    parameters: OBJ({ code: S('STRING', 'Luau 코드') }, ['code']) },
  { name: 'luau_snippet', description: '검증된 Luau/Roblox 예제 코드를 돌려준다 (분석기를 통과한 코드): datastore(pcall+재시도), leaderstats, tween, raycast, cooldown, remote_handler(검증 포함), class_module, heartbeat, touched, ui_button, collection, rate_limit. kind 를 비우면 목록.',
    parameters: OBJ({ kind: S('STRING', '예제 이름 (비우면 목록)') }, []) }
];

module.exports = { DECL, IMPL, SNIPPETS };
