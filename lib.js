'use strict';
// 검증된 재사용 라이브러리와 프로젝트 템플릿. AI는 ws_add_library / ws_scaffold 로 작업 공간에 복사한다.
// 주의: 여기 코드에는 백틱(`)과 템플릿 치환 기호를 쓰지 않는다(문자열 안에 그대로 저장되기 때문).

const LIBS = {
  'seeded-random': {
    description: '재현 가능한 난수 생성기 (mulberry32). 같은 시드면 같은 수열.',
    files: {
      'index.js': [
        "'use strict';",
        '// 재현 가능한 난수: seededRandom(42)() 은 항상 같은 수열을 낸다',
        'function seededRandom(seed) {',
        '  let a = (seed >>> 0) || 1;',
        '  return function next() {',
        '    a = (a + 0x6d2b79f5) | 0;',
        '    let t = Math.imul(a ^ (a >>> 15), 1 | a);',
        '    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;',
        '    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;',
        '  };',
        '}',
        'module.exports = { seededRandom };',
        ''
      ].join('\n')
    }
  },
  'csv-parse': {
    description: 'RFC 4180 CSV 파서 (따옴표·줄바꿈 처리). 의존성 없음.',
    files: {
      'index.js': [
        "'use strict';",
        'function parseCsv(text) {',
        '  const rows = [];',
        "  let row = [], field = '', quoted = false;",
        '  for (let i = 0; i < text.length; i++) {',
        '    const c = text[i];',
        '    if (quoted) {',
        '      if (c === \'"\') { if (text[i + 1] === \'"\') { field += \'"\'; i++; } else quoted = false; }',
        '      else field += c;',
        '    } else if (c === \'"\') quoted = true;',
        "    else if (c === ',') { row.push(field); field = ''; }",
        "    else if (c === '\\n' || c === '\\r') {",
        "      if (c === '\\r' && text[i + 1] === '\\n') i++;",
        '      row.push(field); rows.push(row); row = []; field = \'\';',
        '    } else field += c;',
        '  }',
        '  if (field.length || row.length) { row.push(field); rows.push(row); }',
        '  return rows.filter(r => !(r.length === 1 && r[0] === \'\'));',
        '}',
        'module.exports = { parseCsv };',
        ''
      ].join('\n')
    }
  },
  'express-security': {
    description: 'Express 보안 헤더 + 간단한 IP별 요청 제한 미들웨어 (메모리 기반).',
    files: {
      'index.js': [
        "'use strict';",
        'function securityHeaders(req, res, next) {',
        "  res.setHeader('X-Content-Type-Options', 'nosniff');",
        "  res.setHeader('X-Frame-Options', 'DENY');",
        "  res.setHeader('Referrer-Policy', 'no-referrer');",
        "  res.setHeader('Content-Security-Policy', \"default-src 'self'; img-src 'self' data:\");",
        '  next();',
        '}',
        'function rateLimit({ windowMs = 60000, max = 120 } = {}) {',
        '  const hits = new Map();',
        '  return function (req, res, next) {',
        '    const now = Date.now(), key = req.ip || "unknown";',
        '    const rec = (hits.get(key) || []).filter(t => now - t < windowMs);',
        '    rec.push(now); hits.set(key, rec);',
        '    if (hits.size > 10000) hits.clear();',
        '    if (rec.length > max) return res.status(429).json({ error: "too many requests" });',
        '    next();',
        '  };',
        '}',
        'module.exports = { securityHeaders, rateLimit };',
        ''
      ].join('\n')
    }
  },
  'js-tests': {
    description: '의존성 없는 최소 테스트 러너 (node tests/run.js).',
    files: {
      'tests/run.js': [
        "'use strict';",
        "const assert = require('assert');",
        'const tests = [];',
        'function test(name, fn) { tests.push({ name, fn }); }',
        'async function run() {',
        '  let failed = 0;',
        '  for (const t of tests) {',
        '    try { await t.fn(); console.log("PASS", t.name); }',
        '    catch (e) { failed++; console.log("FAIL", t.name, "-", e.message); }',
        '  }',
        '  console.log(tests.length - failed + "/" + tests.length + " passed");',
        '  if (failed) process.exitCode = 1;',
        '}',
        'module.exports = { test, run, assert };',
        "if (require.main === module) { require('./cases'); run(); }",
        ''
      ].join('\n'),
      'tests/cases.js': [
        "'use strict';",
        "const { test, assert } = require('./run');",
        "test('sanity', () => { assert.strictEqual(1 + 1, 2); });",
        ''
      ].join('\n')
    }
  }
};

const TEMPLATES = {
  'node-express': {
    description: 'Express 웹 서버 + Render 배포 설정 (healthz 포함)',
    next: 'ws_lint 로 검사한 뒤 ws_add_dependency 로 필요한 패키지를 추가하세요.',
    files: {
      'package.json': JSON.stringify({ name: 'app', version: '1.0.0', private: true, main: 'server.js', scripts: { start: 'node server.js' }, engines: { node: '>=18' }, dependencies: { express: '^4.19.2' } }, null, 2) + '\n',
      'server.js': [
        "'use strict';",
        "const express = require('express');",
        "const path = require('path');",
        'const app = express();',
        "app.disable('x-powered-by');",
        "app.use(express.json({ limit: '1mb' }));",
        "app.use(express.static(path.join(__dirname, 'public')));",
        "app.get('/healthz', (req, res) => res.json({ ok: true }));",
        "app.use((req, res) => res.status(404).json({ error: 'not found' }));",
        'const port = process.env.PORT || 3000;',
        "app.listen(port, () => console.log('listening on ' + port));",
        ''
      ].join('\n'),
      'public/index.html': [
        '<!doctype html>',
        '<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
        '<title>App</title></head>',
        '<body><h1>App</h1><p>서버가 동작 중입니다.</p></body></html>',
        ''
      ].join('\n'),
      'render.yaml': [
        'services:',
        '  - type: web',
        '    name: app',
        '    runtime: node',
        '    buildCommand: npm install',
        '    startCommand: npm start',
        '    healthCheckPath: /healthz',
        '    envVars:',
        '      - key: NODE_VERSION',
        '        value: "20"',
        ''
      ].join('\n'),
      '.gitignore': 'node_modules\n.env\n'
    }
  },
  'static-game': {
    description: '캔버스 기반 단일 HTML 게임 (외부 요청 없음, 키보드 조작)',
    next: 'ws_lint 로 검사하고, 규칙·난이도를 수정하세요.',
    files: {
      'index.html': [
        '<!doctype html>',
        '<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
        '<title>Game</title>',
        '<style>body{margin:0;background:#111;color:#eee;font-family:sans-serif;display:flex;flex-direction:column;align-items:center}canvas{background:#000;max-width:100%}</style>',
        '</head><body>',
        '<div id="hud">점수: <span id="score">0</span></div>',
        '<canvas id="game" width="480" height="320"></canvas>',
        '<script>',
        "const canvas = document.getElementById('game'), ctx = canvas.getContext('2d');",
        'const scoreEl = document.getElementById(\'score\');',
        'const keys = {}; let score = 0;',
        "addEventListener('keydown', e => { keys[e.key] = true; });",
        "addEventListener('keyup', e => { keys[e.key] = false; });",
        'const player = { x: 240, y: 280, w: 24, h: 24, speed: 4 };',
        'const coin = { x: 100, y: 100, r: 8 };',
        'function step() {',
        "  if (keys['ArrowLeft']) player.x -= player.speed;",
        "  if (keys['ArrowRight']) player.x += player.speed;",
        '  player.x = Math.max(0, Math.min(canvas.width - player.w, player.x));',
        '  const dx = (player.x + player.w / 2) - coin.x, dy = (player.y + player.h / 2) - coin.y;',
        '  if (Math.hypot(dx, dy) < coin.r + 12) {',
        '    score++; scoreEl.textContent = String(score);',
        '    coin.x = 20 + Math.random() * (canvas.width - 40); coin.y = 20 + Math.random() * 200;',
        '  }',
        '}',
        'function draw() {',
        "  ctx.clearRect(0, 0, canvas.width, canvas.height);",
        "  ctx.fillStyle = '#4af'; ctx.fillRect(player.x, player.y, player.w, player.h);",
        "  ctx.fillStyle = '#fd0'; ctx.beginPath(); ctx.arc(coin.x, coin.y, coin.r, 0, Math.PI * 2); ctx.fill();",
        '}',
        'function loop() { step(); draw(); requestAnimationFrame(loop); }',
        'loop();',
        '</script></body></html>',
        ''
      ].join('\n')
    }
  },
  'roblox-rojo': {
    description: 'Roblox(Luau) 프로젝트: Rojo 구성 + 서버/클라이언트/공유 모듈',
    next: 'analyze_luau 로 각 .luau 파일을 검사하세요. Roblox Studio + Rojo 로 동기화해서 확인합니다.',
    files: {
      'default.project.json': JSON.stringify({
        name: 'game',
        tree: {
          $className: 'DataModel',
          ReplicatedStorage: { Shared: { $path: 'src/shared' } },
          ServerScriptService: { Server: { $path: 'src/server' } },
          StarterPlayer: { StarterPlayerScripts: { Client: { $path: 'src/client' } } }
        }
      }, null, 2) + '\n',
      'src/shared/Util.luau': [
        '--!strict',
        'local Util = {}',
        '',
        'function Util.clamp01(x: number): number',
        '\treturn math.clamp(x, 0, 1)',
        'end',
        '',
        'return Util',
        ''
      ].join('\n'),
      'src/server/Main.server.luau': [
        '--!strict',
        'local Players = game:GetService("Players")',
        'local ReplicatedStorage = game:GetService("ReplicatedStorage")',
        '',
        'local Util = require(ReplicatedStorage:WaitForChild("Shared"):WaitForChild("Util"))',
        '',
        'Players.PlayerAdded:Connect(function(player: Player)',
        '\tprint(player.Name, Util.clamp01(2))',
        'end)',
        ''
      ].join('\n'),
      'src/client/Main.client.luau': [
        '--!strict',
        'local Players = game:GetService("Players")',
        '',
        'local player = Players.LocalPlayer',
        'print("client ready:", player.Name)',
        ''
      ].join('\n'),
      'README.md': '# Roblox 프로젝트\n\n`rojo serve` 로 Roblox Studio 와 동기화합니다.\n'
    }
  },
  'python-cli': {
    description: 'Python 명령줄 도구 + unittest 테스트',
    next: 'ws_sandbox_run 으로 실제 실행 결과를 확인하세요.',
    files: {
      'main.py': [
        'import sys',
        '',
        'def solve(values):',
        '    """합계를 돌려준다. 빈 입력은 0."""',
        '    return sum(values)',
        '',
        'def main(argv):',
        '    nums = [float(x) for x in argv]',
        '    print(solve(nums))',
        '',
        "if __name__ == '__main__':",
        '    main(sys.argv[1:])',
        ''
      ].join('\n'),
      'test_main.py': [
        'import unittest',
        'from main import solve',
        '',
        'class SolveTest(unittest.TestCase):',
        '    def test_empty(self):',
        '        self.assertEqual(solve([]), 0)',
        '    def test_basic(self):',
        '        self.assertEqual(solve([1, 2, 3]), 6)',
        '',
        "if __name__ == '__main__':",
        '    unittest.main()',
        ''
      ].join('\n'),
      'requirements.txt': '# 필요한 패키지를 한 줄씩 적으세요\n'
    }
  }
};

module.exports = { LIBS, TEMPLATES };
