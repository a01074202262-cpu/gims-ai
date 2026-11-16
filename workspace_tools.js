'use strict';
// AI가 작업 공간에서 파일을 만들고, 고치고, 검사하는 도구 (group: workspace)
//  - 파일: 목록·읽기·쓰기·부분 수정(정확히 한 곳만)·삭제
//  - 의존성: package.json 에 패키지 선언 (설치는 Render 빌드에서 수행)
//  - 생성: 템플릿(node-express, static-game, python-cli), 라이브러리 복사
//  - 검사: 작업 공간 전체 정적 검사(lint), 완료 체크리스트, Python 파일 샌드박스 실행
const WS = require('./workspace');
const core = require('./reasoning_tools');
const coding = require('./coding');
const luau = require('./luau_analyzer');
const codingPlus = require('./coding_plus');
const sandbox = require('./sandbox');
const { LIBS, TEMPLATES } = require('./lib');

const S = (type, description, extra = {}) => ({ type, description, ...extra });
const OBJ = (properties, required) => ({ type: 'OBJECT', properties, required });
const PATH = S('STRING', '작업 공간 안의 상대 경로, 예: src/app.js');
const PKG_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]{0,213}$/;
const SEMVER = /^[\^~]?\d+\.\d+\.\d+$/;

// ---------- 파일 ----------
const IMPL = {};
IMPL.ws_list_files = (a, ctx) => ({ files: WS.listFiles(ctx.owner), stats: WS.stats(ctx.owner) });
IMPL.ws_read_file = ({ path }, ctx) => {
  const c = WS.readFile(ctx.owner, path);
  return { path, bytes: Buffer.byteLength(c), content: c.length > 60000 ? c.slice(0, 60000) + '\n…(잘림)' : c };
};
IMPL.ws_write_file = ({ path, content }, ctx) => ({ ok: true, ...WS.writeFile(ctx.owner, path, content) });
IMPL.ws_patch_file = ({ path, old_text, new_text }, ctx) => {
  const c = WS.readFile(ctx.owner, path);
  if (typeof old_text !== 'string' || !old_text) throw new Error('old_text 는 비어 있지 않은 문자열이어야 합니다');
  const count = c.split(old_text).length - 1;
  if (count !== 1) throw new Error(`old_text 는 파일 안에서 정확히 한 번 나와야 합니다 (현재 ${count}회). 더 긴 문맥을 포함하세요`);
  const next = c.replace(old_text, () => (typeof new_text === 'string' ? new_text : ''));
  return { ok: true, ...WS.writeFile(ctx.owner, path, next) };
};
IMPL.ws_delete_file = ({ path }, ctx) => ({ ok: WS.deleteFile(ctx.owner, path) });

// ---------- 의존성 ----------
IMPL.ws_add_dependency = ({ name, version, dev = false }, ctx) => {
  if (!PKG_NAME.test(name)) throw new Error('패키지 이름 형식이 올바르지 않습니다');
  if (!SEMVER.test(version || '')) throw new Error('version 은 ^1.2.3 같은 형식이어야 합니다');
  let pkg = { name: 'app', version: '1.0.0', private: true, scripts: {}, dependencies: {}, devDependencies: {} };
  if (WS.has(ctx.owner, 'package.json')) pkg = JSON.parse(WS.readFile(ctx.owner, 'package.json'));
  const field = dev ? 'devDependencies' : 'dependencies';
  pkg[field] = { ...(pkg[field] || {}), [name]: version };
  pkg[field] = Object.fromEntries(Object.entries(pkg[field]).sort(([x], [y]) => x.localeCompare(y)));
  WS.writeFile(ctx.owner, 'package.json', JSON.stringify(pkg, null, 2) + '\n');
  return { ok: true, field, name, version, note: '이 서버에서는 설치하지 않습니다. 배포 빌드(npm install)에서 설치됩니다. 실제 존재 여부는 배포 로그로 확인하세요.' };
};

// ---------- 템플릿·라이브러리 ----------
IMPL.ws_scaffold = ({ template, overwrite = false }, ctx) => {
  const t = TEMPLATES[template];
  if (!t) throw new Error(`알 수 없는 템플릿: ${template} (${Object.keys(TEMPLATES).join(', ')})`);
  const created = [], skipped = [];
  for (const path of Object.keys(t.files)) WS.checkPath(path);   // 먼저 전부 검사
  for (const [path, content] of Object.entries(t.files)) {
    if (WS.has(ctx.owner, path) && !overwrite) { skipped.push(path); continue; }
    WS.writeFile(ctx.owner, path, content);
    created.push(path);
  }
  return { template, created, skipped, next: t.next };
};
IMPL.ws_add_library = ({ name, dir, overwrite = false }, ctx) => {
  const lib = LIBS[name];
  if (!lib) throw new Error(`알 수 없는 라이브러리: ${name} (${Object.keys(LIBS).join(', ')})`);
  const base = dir ? String(dir).replace(/\/+$/, '') : `lib/${name}`;
  const created = [], skipped = [];
  for (const file of Object.keys(lib.files)) WS.checkPath(`${base}/${file}`);   // 먼저 전부 검사
  for (const [file, content] of Object.entries(lib.files)) {
    const path = `${base}/${file}`;
    if (WS.has(ctx.owner, path) && !overwrite) { skipped.push(path); continue; }
    WS.writeFile(ctx.owner, path, content);
    created.push(path);
  }
  return { library: name, description: lib.description, created, skipped };
};

// ---------- 검사 ----------
const SEV = { high: 'error', medium: 'warning', low: 'info' };
function lintAll(owner) {
  const files = WS.allFiles(owner);
  const pkgFile = files.find(f => f.path === 'package.json');
  let pkg = null, pkgErr = null;
  if (pkgFile) { try { pkg = JSON.parse(pkgFile.content); } catch (e) { pkgErr = e.message; } }
  const problems = [];
  const add = (path, line, severity, message) => problems.push({ path, line: line || null, severity, message });
  if (pkgErr) add('package.json', null, 'error', 'JSON 파싱 실패: ' + pkgErr);
  for (const f of files) {
    const ext = f.path.split('.').pop().toLowerCase();
    try {
      if (['js', 'mjs', 'cjs'].includes(ext)) {
        const syn = core.CODING.check_js_syntax({ code: f.content });
        if (!syn.ok) add(f.path, syn.line, 'error', '문법 오류: ' + syn.error);
        const br = coding.IMPL.check_brackets({ code: f.content, language: 'js' });
        if (!br.ok) add(f.path, br.line, 'error', br.error);
        for (const x of codingPlus.IMPL.find_async_pitfalls({ code: f.content }).findings) add(f.path, x.line, 'warning', x.message);
        if (pkg) {
          const im = codingPlus.IMPL.check_imports({ code: f.content, package_json: pkgFile.content });
          for (const m of im.missingInPackageJson || []) add(f.path, null, 'error', `package.json 에 없는 패키지: ${m} (ws_add_dependency 로 추가)`);
        }
      } else if (ext === 'lua' || ext === 'luau') {
        const r = luau.analyzeLuau(f.content, { filename: f.path });
        for (const i of r.issues) add(f.path, i.line, i.sev === 'error' ? 'error' : i.sev === 'warning' ? 'warning' : 'info', `[${i.rule}] ${i.message}${i.suggestion ? ' → ' + i.suggestion : ''}`);
      } else if (ext === 'py') {
        const br = coding.IMPL.check_brackets({ code: f.content, language: 'python' });
        if (!br.ok) add(f.path, br.line, 'error', br.error);
        for (const x of coding.IMPL.lint_python_basic({ code: f.content }).findings) add(f.path, x.line, SEV[x.severity] || 'info', x.message);
      } else if (ext === 'html') {
        for (const m of f.content.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
          const syn = core.CODING.check_js_syntax({ code: m[1] });
          if (!syn.ok) add(f.path, null, 'error', '인라인 스크립트 문법 오류: ' + syn.error);
        }
        if (/<canvas\b|requestAnimationFrame/i.test(f.content)) {
          const hg = core.CODING.check_html_game({ html: f.content });
          for (const i of hg.issues) add(f.path, null, 'error', i);
          for (const w of hg.warnings) add(f.path, null, 'info', w);
        }
      } else if (ext === 'json') {
        try { JSON.parse(f.content); } catch (e) { add(f.path, null, 'error', 'JSON 파싱 실패: ' + e.message); }
      }
      if (['js', 'mjs', 'cjs', 'py'].includes(ext)) {
        for (const x of coding.IMPL.security_scan({ code: f.content, language: ext === 'py' ? 'python' : 'js' }).findings) {
          add(f.path, x.line, SEV[x.severity] || 'info', x.message);
        }
      }
    } catch (e) {
      add(f.path, null, 'error', '검사 중 오류: ' + e.message);
    }
  }
  const errors = problems.filter(p => p.severity === 'error').length;
  return { files: files.length, errors, warnings: problems.filter(p => p.severity === 'warning').length, ok: errors === 0, problems: problems.slice(0, 100) };
}
IMPL.ws_lint = (a, ctx) => lintAll(ctx.owner);
IMPL.ws_checklist = (a, ctx) => {
  const files = WS.listFiles(ctx.owner).map(f => f.path);
  const lint = lintAll(ctx.owner);
  const missing = [], suggestions = [];
  if (!files.length) missing.push('작업 공간에 파일이 없습니다 (ws_scaffold 로 시작하세요)');
  if (files.includes('package.json')) {
    const pkg = JSON.parse(WS.readFile(ctx.owner, 'package.json'));
    if (!pkg.scripts || !pkg.scripts.start) missing.push('package.json 에 start 스크립트가 없습니다 (Render 실행 명령)');
    if (!files.includes('render.yaml')) suggestions.push('Render 배포용 render.yaml 을 추가하면 배포 설정이 명확해집니다');
    if (!files.includes('.gitignore')) suggestions.push('.gitignore 에 node_modules 와 .env 를 넣으세요');
  }
  if (files.some(f => f.endsWith('.js')) && !files.some(f => f.includes('test'))) suggestions.push('테스트 파일(예: tests/cases.js)을 추가하면 회귀를 잡기 쉽습니다');
  return { ready: lint.ok && missing.length === 0, lint: { errors: lint.errors, warnings: lint.warnings, top: lint.problems.slice(0, 15) }, missing, suggestions };
};
IMPL.ws_sandbox_run = ({ path, stdin = '' }, ctx) => {
  if (!/\.py$/i.test(path)) throw new Error('샌드박스 실행은 .py 파일만 지원합니다');
  const code = WS.readFile(ctx.owner, path);
  return sandbox.IMPL.run_python_sandbox({ code, stdin }, ctx);
};

const DECL = [
  { name: 'ws_list_files', description: '작업 공간의 파일 목록과 용량을 본다. 작업 시작 전에 현재 상태를 확인하라.', parameters: OBJ({}, []) },
  { name: 'ws_read_file', description: '작업 공간 파일의 내용을 읽는다.', parameters: OBJ({ path: PATH }, ['path']) },
  { name: 'ws_write_file', description: '파일을 만들거나 전체를 덮어쓴다. 완성된 전체 내용을 넣어라.', parameters: OBJ({ path: PATH, content: S('STRING', '파일 전체 내용') }, ['path', 'content']) },
  { name: 'ws_patch_file', description: '파일의 한 부분만 고친다. old_text 는 파일 안에서 정확히 한 번 나와야 한다.',
    parameters: OBJ({ path: PATH, old_text: S('STRING', '바꿀 원문(정확히 한 곳)'), new_text: S('STRING', '바뀐 내용') }, ['path', 'old_text', 'new_text']) },
  { name: 'ws_delete_file', description: '파일을 삭제한다.', parameters: OBJ({ path: PATH }, ['path']) },
  { name: 'ws_add_dependency', description: 'package.json 에 npm 패키지를 선언한다(설치는 배포 빌드에서 수행).',
    parameters: OBJ({
      name: S('STRING', '패키지 이름, 예: express'),
      version: S('STRING', '버전 범위, 예: ^4.19.2'),
      dev: S('BOOLEAN', '개발용이면 true')
    }, ['name', 'version']) },
  { name: 'ws_scaffold', description: '프로젝트 템플릿을 작업 공간에 만든다.',
    parameters: OBJ({
      template: S('STRING', '템플릿 이름', { enum: Object.keys(TEMPLATES) }),
      overwrite: S('BOOLEAN', '기존 파일을 덮어쓸지 (기본 false)')
    }, ['template']) },
  { name: 'ws_add_library', description: '검증된 재사용 라이브러리를 작업 공간에 복사한다. dir 로 위치를 바꿀 수 있다.',
    parameters: OBJ({
      name: S('STRING', '라이브러리 이름', { enum: Object.keys(LIBS) }),
      dir: S('STRING', '복사할 폴더 (기본 lib/이름)'),
      overwrite: S('BOOLEAN', '기존 파일 덮어쓰기')
    }, ['name']) },
  { name: 'ws_lint', description: '작업 공간 전체를 정적 검사한다: 문법, 괄호, 보안 패턴, async 실수, package.json 대조, HTML 게임 점검, Python 린트. 파일을 만든 뒤 반드시 실행하라.',
    parameters: OBJ({}, []) },
  { name: 'ws_checklist', description: '완료 여부를 판단한다: 검사 결과, 누락된 필수 항목, 개선 제안. 끝내기 전에 실행하라.',
    parameters: OBJ({}, []) },
  { name: 'ws_sandbox_run', description: '작업 공간의 Python 파일을 샌드박스에서 실행해 실제 출력을 확인한다.',
    parameters: OBJ({ path: PATH, stdin: S('STRING', '표준 입력 (선택)') }, ['path']) }
];

module.exports = { DECL, IMPL, lintAll };
