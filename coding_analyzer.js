'use strict';
/**
 * coding_analyzer.js — 코딩 도구 3차 확장 (정적 분석 전용, 사용자 코드를 실행하지 않음)
 *   analyze_code          : 언어 자동 감지 → 문법 오류(줄·칸·코드 프레임) + 정의되지 않은 변수·함수·메서드 + 논리 버그
 *   find_undefined_symbols: 미정의 이름만 빠르게 (오타 후보 포함)
 *   analyze_html_page     : HTML+JS 교차 검사 (인라인 핸들러 함수, getElementById 대상, 태그 짝, 중복 id)
 *   review_code           : 품질 점수·함수별 복잡도·시간 복잡도 추정
 *   autofix_code          : 확실한 오타 수정을 적용한 코드 반환 (적용 후 문법 재검사)
 *   check_project_files   : 여러 파일 교차 검사 (require/import 경로, export 이름, script src)
 * Python 은 python3 의 ast 로 "파싱만" 한다(실행 안 함). python3 가 없으면 JS 휴리스틱으로 대체.
 */
const { spawn } = require('child_process');
const A = require('./js_analyzer');
const LU = require('./luau_analyzer');

const MAX_CODE = 60_000;
const S = (type, description, extra = {}) => ({ type, description, ...extra });
const OBJ = (properties, required) => ({ type: 'OBJECT', properties, required });
const codeOf = (v, name = 'code') => {
  if (typeof v !== 'string') throw new Error(`${name} 는 문자열이어야 합니다`);
  if (v.length > MAX_CODE) throw new Error(`${name} 가 너무 깁니다 (최대 ${MAX_CODE}자)`);
  return v;
};
const ORDER = { error: 0, warning: 1, info: 2 };

// ---------------------------------------------------------------------------
// 언어 감지
// ---------------------------------------------------------------------------
function normLang(l) {
  const x = String(l || '').toLowerCase();
  if (['js', 'javascript', 'node', 'mjs', 'cjs', 'jsx'].includes(x)) return 'js';
  if (['py', 'python', 'python3'].includes(x)) return 'python';
  if (['html', 'htm'].includes(x)) return 'html';
  if (x === 'json') return 'json';
  if (x === 'css') return 'css';
  if (['ts', 'typescript', 'tsx'].includes(x)) return 'ts';
  if (['lua', 'luau', 'roblox', 'robloxlua', 'rbx'].includes(x)) return 'luau';
  return x || 'auto';
}
const LUAU_HINT = /\blocal\s+function\b|\bgame:GetService\s*\(|\bgame\.(Players|Workspace|ReplicatedStorage)\b|\bscript\.Parent\b|\blocal\s+\w+(\s*:\s*[\w.?{}<>\[\]| ]+)?\s*=[^=]|\bthen\s*$|^\s*--!(strict|nonstrict|nocheck)/m;
function looksLuau(src) {
  if (!LUAU_HINT.test(src) || !/\bend\b/.test(src)) return false;
  if (/\b(const|let|var)\s+\w+\s*=|=>|\bfunction\s*\w*\s*\([^)]*\)\s*\{|;\s*$/m.test(src)) return false;   // JS 신호가 있으면 아님
  if (/^\s*def\s+\w+\(.*\):\s*$/m.test(src)) return false;
  return true;
}
function detectLanguage(src) {
  const t = src.trimStart();
  if (looksLuau(src)) return 'luau';
  if (/^<!doctype html|^<html[\s>]|^<(head|body|div|script|style)[\s>]/i.test(t)) return 'html';
  if (/^[\[{]/.test(t)) { try { JSON.parse(src); return 'json'; } catch { if (/^\s*[\[{]\s*"[^"\n]*"\s*:/.test(src) && !/;|\bfunction\b|=>/.test(src)) return 'json'; } }
  const py = (/^\s*def\s+\w+\s*\(.*\)\s*(->\s*[\w\[\], .]+)?:\s*$/m.test(src) || /^\s*(import \w+|from [\w.]+ import )/m.test(src) && !/;\s*$/m.test(src)) || /^\s*(elif .*:|except\b.*:|print\s*\(.*\)\s*$)/m.test(src) && !/[{};]\s*$/m.test(src);
  const js = /\b(const|let|var|function|=>|console\.log|require\(|document\.)\b|=>|;\s*$/m.test(src);
  if (py && !/\b(const|let)\s+\w+\s*=|=>|function\s*\w*\(/.test(src)) return 'python';
  if (js) return 'js';
  if (/^[^{}]*\{[^{}]*:[^{}]*;[^{}]*\}/m.test(src) && /[.#]?[\w-]+\s*\{/.test(src)) return 'css';
  return py ? 'python' : 'js';
}

// ---------------------------------------------------------------------------
// 결과 정리 (registry 는 6000자 초과 JSON 을 잘라내므로 우선순위대로 담는다)
// ---------------------------------------------------------------------------
function pack(base, issues, { budget = 5200, minSev = 'info' } = {}) {
  const sorted = issues.filter(i => ORDER[i.sev] <= ORDER[minSev]).sort((a, b) => ORDER[a.sev] - ORDER[b.sev] || (a.line || 0) - (b.line || 0));
  const counts = { error: 0, warning: 0, info: 0 };
  for (const i of issues) counts[i.sev]++;
  const out = [];
  let used = JSON.stringify(base).length + 200;
  let infoKept = 0;
  for (const i of sorted) {
    if (i.sev === 'info' && (infoKept >= 6 || counts.error + counts.warning > 12)) continue;
    const item = { sev: i.sev, rule: i.rule, at: i.col ? `${i.line}:${i.col}` : String(i.line || ''), msg: i.message };
    if (i.suggestion) item.fix = i.suggestion;
    if (i.file) item.file = i.file;
    const len = JSON.stringify(item).length + 1;
    if (used + len > budget) break;
    used += len; out.push(item);
    if (i.sev === 'info') infoKept++;
  }
  return { ...base, ok: counts.error === 0, counts, issues: out, omitted: sorted.length - out.length > 0 ? sorted.length - out.length : undefined };
}
const stripInternal = i => { const { fix, replaceProp, replaceId, symbol, ...rest } = i; return rest; };

// ---------------------------------------------------------------------------
// JS
// ---------------------------------------------------------------------------
function analyzeJsFull(src, o = {}) {
  const syn = A.checkSyntax(src);
  if (!syn.ok) {
    const issues = [{ sev: 'error', rule: 'syntax', line: syn.line, col: syn.col, message: `문법 오류: ${syn.message}`, suggestion: syn.hint || undefined }];
    // 괄호 짝 검사로 진짜 원인 위치 보강
    try {
      const br = require('./coding').IMPL.check_brackets({ code: src, language: 'js' });
      if (!br.ok) issues.push({ sev: 'error', rule: 'brackets', line: br.line, col: 0, message: `괄호/문자열 짝 오류: ${br.error}`, suggestion: '이 줄 근처에서 닫는 기호가 빠졌는지 확인하세요' });
    } catch { /* ignore */ }
    return { syntax: syn, issues, functions: [], stage: 'syntax' };
  }
  try {
    const r = A.analyzeJs(src, o);
    return { syntax: syn, issues: r.issues, functions: r.functions, r, stage: 'analysis' };
  } catch (e) {
    if (e.name === 'ParseError') return { syntax: syn, issues: [{ sev: 'info', rule: 'parser-limit', line: e.line, col: e.col, message: `구조 분석을 건너뜀 (지원하지 않는 구문: ${e.message}). V8 문법 검사는 통과했습니다` }], functions: [], stage: 'syntax-only' };
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Python (ast 파싱만)
// ---------------------------------------------------------------------------
const PY_SCRIPT = String.raw`
import sys, ast, json, builtins, difflib, importlib
SRC = sys.stdin.read()
out = {"issues": [], "functions": []}
def add(sev, rule, node, msg, sug=None):
    out["issues"].append({"sev": sev, "rule": rule, "line": getattr(node, "lineno", node if isinstance(node, int) else 0), "col": (getattr(node, "col_offset", 0) or 0) + 1, "message": msg, **({"suggestion": sug} if sug else {})})
try:
    tree = ast.parse(SRC)
except SyntaxError as e:
    print(json.dumps({"syntax": {"line": e.lineno, "col": e.offset, "message": e.msg, "text": (e.text or "").rstrip("\n")}})); sys.exit(0)
except Exception as e:
    print(json.dumps({"syntax": {"line": None, "col": None, "message": str(e)[:200], "text": ""}})); sys.exit(0)
BUILTINS = set(dir(builtins)) | {"__name__","__file__","__doc__","__builtins__","__spec__","__package__","__loader__","__path__","__class__","__qualname__","__module__"}
class Scope:
    def __init__(s, kind, parent, node=None):
        s.kind=kind; s.parent=parent; s.node=node; s.bind={}; s.glob=set(); s.loads=[]; s.used=set(); s.imports={}
def bind(sc, name, line, kind="var"):
    sc.bind.setdefault(name, []).append((line, kind))
scopes=[]; star=[False]
def collect(node, sc, in_loop=False):
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
        if not isinstance(node, ast.Lambda):
            bind(sc, node.name, node.lineno, "def")
            for d in node.decorator_list: collect(d, sc, in_loop)
        a = node.args
        for d in list(a.defaults)+[x for x in a.kw_defaults if x]: collect(d, sc, in_loop)
        fs = Scope("func", sc, node); scopes.append(fs)
        for arg in a.posonlyargs + a.args + a.kwonlyargs: bind(fs, arg.arg, node.lineno, "param")
        if a.vararg: bind(fs, a.vararg.arg, node.lineno, "param")
        if a.kwarg: bind(fs, a.kwarg.arg, node.lineno, "param")
        body = node.body if isinstance(node.body, list) else [node.body]
        for b in body: collect(b, fs, False)
        return
    if isinstance(node, ast.ClassDef):
        bind(sc, node.name, node.lineno, "class")
        for b in node.bases + [k.value for k in node.keywords] + node.decorator_list: collect(b, sc, in_loop)
        cs = Scope("class", sc, node); scopes.append(cs)
        for b in node.body: collect(b, cs, False)
        return
    if isinstance(node, (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
        cs = Scope("comp", sc, node); scopes.append(cs)
        for g in node.generators:
            collect(g.target, cs, True); collect(g.iter, cs, True)
            for i in g.ifs: collect(i, cs, True)
        if isinstance(node, ast.DictComp): collect(node.key, cs, True); collect(node.value, cs, True)
        else: collect(node.elt, cs, True)
        return
    if isinstance(node, ast.Name):
        if isinstance(node.ctx, ast.Store): bind(sc, node.id, node.lineno)
        elif isinstance(node.ctx, ast.Del): bind(sc, node.id, node.lineno)
        else: sc.loads.append((node.id, node, in_loop))
        return
    if isinstance(node, ast.NamedExpr):
        t = sc
        while t.kind == "comp" and t.parent: t = t.parent
        bind(t, node.target.id, node.lineno); collect(node.value, sc, in_loop); return
    if isinstance(node, ast.Import):
        for a in node.names:
            n = a.asname or a.name.split(".")[0]; bind(sc, n, node.lineno, "import"); sc.imports[n] = (a.name, node.lineno)
        return
    if isinstance(node, ast.ImportFrom):
        for a in node.names:
            if a.name == "*": star[0] = True
            else:
                n = a.asname or a.name; bind(sc, n, node.lineno, "import"); sc.imports[n] = ((node.module or "") + "." + a.name, node.lineno)
        return
    if isinstance(node, ast.ExceptHandler):
        if node.name: bind(sc, node.name, node.lineno)
    if isinstance(node, (ast.Global, ast.Nonlocal)):
        for n in node.names: sc.glob.add(n)
        return
    for f in ("name", "rest"):
        if isinstance(node, (ast.MatchAs, ast.MatchStar, ast.MatchMapping)) and getattr(node, f, None) and isinstance(getattr(node, f), str):
            bind(sc, getattr(node, f), node.lineno)
    loop = in_loop or isinstance(node, (ast.For, ast.AsyncFor, ast.While))
    for child in ast.iter_child_nodes(node):
        if isinstance(child, (ast.arg,)): continue
        collect(child, sc, loop)
mod = Scope("module", None, tree); scopes.append(mod)
for b in tree.body: collect(b, mod)
def module_scope(s):
    while s.parent: s = s.parent
    return s
def resolve(sc, name):
    s = sc; origin = sc
    while s is not None:
        if name in s.glob: return module_scope(s) if name in module_scope(s).bind else None
        if name in s.bind and (s.kind != "class" or s is origin): return s
        s = s.parent
    return None
allnames = set(BUILTINS)
for s in scopes: allnames |= set(s.bind)
for sc in scopes:
    for name, node, in_loop in sc.loads:
        r = resolve(sc, name)
        if r is not None:
            r.used.add(name)
            if r is sc and not in_loop and sc.kind in ("module", "func") and name not in BUILTINS:
                lines = [l for l, k in sc.bind[name] if k != "param"]
                if lines and not any(k == "param" for l, k in sc.bind[name]) and min(lines) > node.lineno:
                    add("error", "use-before-define", node, "'%s' 이(가) %d줄에서 정의되기 전에 사용됩니다 (%s)" % (name, min(lines), "NameError" if sc.kind == "module" else "UnboundLocalError"), "정의를 사용 위치보다 위로 옮기세요")
            continue
        if name in BUILTINS or star[0]: continue
        m = difflib.get_close_matches(name, list(allnames), n=1, cutoff=0.75)
        call = False
        add("error", "undefined-name", node, "정의되지 않은 이름: %s" % name, ("'%s' 의 오타?" % m[0]) if m else "변수/함수를 정의하거나 import 하세요")
for node in ast.walk(tree):
    if isinstance(node, ast.ExceptHandler):
        if node.type is None: add("warning", "bare-except", node, "bare except: 모든 예외(KeyboardInterrupt 포함)를 삼킵니다", "except Exception: 사용")
        if len(node.body) == 1 and isinstance(node.body[0], ast.Pass): add("warning", "swallowed-exception", node, "예외를 잡고 아무것도 하지 않습니다 (pass)")
    if isinstance(node, ast.Compare):
        for op, c in zip(node.ops, node.comparators):
            if isinstance(op, (ast.Eq, ast.NotEq)) and isinstance(c, ast.Constant) and c.value is None: add("info", "none-compare", node, "None 비교에는 is / is not 를 쓰세요")
            if isinstance(op, (ast.Is, ast.IsNot)) and isinstance(c, ast.Constant) and isinstance(c.value, (str, int, float)) and not isinstance(c.value, bool): add("warning", "is-literal", node, "리터럴과 is 로 비교하고 있습니다 (== 사용)")
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        for d in node.args.defaults + [x for x in node.args.kw_defaults if x]:
            if isinstance(d, (ast.List, ast.Dict, ast.Set)): add("warning", "mutable-default", d, "가변 기본 인자: 호출 사이에 값이 공유됩니다", "None 을 기본값으로 쓰고 함수 안에서 생성하세요")
    for field in ("body", "orelse", "finalbody"):
        seq = getattr(node, field, None)
        if isinstance(seq, list):
            dead = False
            for st in seq:
                if dead and isinstance(st, ast.stmt):
                    add("warning", "unreachable", st, "return/raise/break/continue 뒤라 실행되지 않는 코드입니다"); break
                if isinstance(st, (ast.Return, ast.Raise, ast.Break, ast.Continue)): dead = True
    if isinstance(node, ast.While) and isinstance(node.test, ast.Constant) and node.test.value:
        if not any(isinstance(n, (ast.Break, ast.Return, ast.Raise)) for n in ast.walk(node)): add("warning", "infinite-loop", node, "탈출 조건(break/return/raise)이 없는 무한 루프로 보입니다")
# 인자 개수 / 키워드 / self
funcs = {}; counts = {}
for st in tree.body:
    if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef)): funcs[st.name] = st; counts[st.name] = counts.get(st.name, 0) + 1
    if isinstance(st, ast.ClassDef):
        counts[st.name] = counts.get(st.name, 0) + 1
        init = [b for b in st.body if isinstance(b, ast.FunctionDef) and b.name == "__init__"]
        if init and not st.bases and not st.decorator_list: funcs[st.name] = init[0]
        for b in st.body:
            if isinstance(b, ast.FunctionDef) and not b.decorator_list and not b.args.args and not b.args.vararg and not b.args.posonlyargs:
                add("error", "missing-self", b, "메서드 '%s' 에 self 매개변수가 없습니다 (호출 시 TypeError)" % b.name, "def %s(self, ...)" % b.name)
for node in ast.walk(tree):
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in funcs and counts.get(node.func.id) == 1:
        f = funcs[node.func.id]; a = f.args
        if any(isinstance(x, ast.Starred) for x in node.args) or any(k.arg is None for k in node.keywords): continue
        params = [x.arg for x in a.posonlyargs + a.args]
        if f.name == node.func.id and isinstance(f, ast.FunctionDef) and params and params[0] == "self" and any(isinstance(s, ast.ClassDef) and f in s.body for s in tree.body): params = params[1:]
        elif params and params[0] == "self": params = params[1:]
        req = len(params) - len(a.defaults)
        n = len(node.args)
        if n > len(params) and not a.vararg: add("error", "arg-count", node, "'%s' 는 인자 %d개를 받는데 %d개를 전달했습니다" % (node.func.id, len(params), n), "시그니처: (%s)" % ", ".join(params))
        names = set(params) | {x.arg for x in a.kwonlyargs}
        for k in node.keywords:
            if k.arg not in names and not a.kwarg: add("error", "bad-keyword", node, "'%s' 에 없는 키워드 인자 '%s'" % (node.func.id, k.arg), "매개변수: %s" % ", ".join(sorted(names)))
        given = set(params[:n]) | {k.arg for k in node.keywords}
        miss = [p for p in params[:req] if p not in given]
        if miss and not a.vararg: add("error", "arg-count", node, "'%s' 호출에 필수 인자가 빠졌습니다: %s" % (node.func.id, ", ".join(miss)))
# self.method() 존재 여부 (상속 없는 클래스)
for cls in [c for c in ast.walk(tree) if isinstance(c, ast.ClassDef)]:
    if cls.bases or cls.keywords or cls.decorator_list: continue
    members = set()
    for b in cls.body:
        if isinstance(b, (ast.FunctionDef, ast.AsyncFunctionDef)): members.add(b.name)
        elif isinstance(b, ast.Assign):
            for t in b.targets:
                if isinstance(t, ast.Name): members.add(t.id)
        elif isinstance(b, ast.AnnAssign) and isinstance(b.target, ast.Name): members.add(b.target.id)
    dyn = False
    for n in ast.walk(cls):
        if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) and n.value.id == "self" and isinstance(n.ctx, ast.Store): members.add(n.attr)
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in ("setattr", "vars"): dyn = True
    if dyn or "__getattr__" in members or "__slots__" in members: continue
    for n in ast.walk(cls):
        if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) and n.value.id == "self" and isinstance(n.ctx, ast.Load) and n.attr not in members and not n.attr.startswith("__"):
            m = difflib.get_close_matches(n.attr, list(members), n=1, cutoff=0.7)
            add("error", "undefined-attribute", n, "self.%s 은(는) 클래스 %s 에 정의되지 않았습니다" % (n.attr, cls.name), ("'%s' 의 오타?" % m[0]) if m else None)
# 안전한 표준 모듈의 속성 오타
SAFE = {"math","random","json","re","string","itertools","functools","collections","datetime","time","statistics","heapq","bisect","copy","operator","decimal","fractions","os","sys","textwrap","csv","hashlib","base64","uuid","enum","dataclasses"}
for n in ast.walk(tree):
    if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) and n.value.id in mod.imports and mod.imports[n.value.id][0] in SAFE:
        try:
            m = importlib.import_module(mod.imports[n.value.id][0])
            if not hasattr(m, n.attr):
                c = difflib.get_close_matches(n.attr, dir(m), n=1, cutoff=0.7)
                add("error", "undefined-module-member", n, "%s.%s 은(는) 존재하지 않습니다" % (n.value.id, n.attr), ("'%s.%s' 의 오타?" % (n.value.id, c[0])) if c else None)
        except Exception: pass
    if isinstance(n, ast.ImportFrom) and n.module in SAFE:
        try:
            m = importlib.import_module(n.module)
            for a in n.names:
                if a.name != "*" and not hasattr(m, a.name): add("error", "bad-import", n, "'%s' 에서 '%s' 를 가져올 수 없습니다" % (n.module, a.name))
        except Exception: pass
# 미사용 import / 지역 변수
for s in scopes:
    if s.kind == "module":
        for name, (full, line) in s.imports.items():
            if name not in s.used and not any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(tree) if isinstance(x, ast.Name) and isinstance(x.ctx, ast.Load)):
                add("warning", "unused-import", line, "import 한 '%s' 을(를) 사용하지 않습니다" % name)
    elif s.kind == "func":
        for name, lst in s.bind.items():
            if name not in s.used and not name.startswith("_") and all(k == "var" for l, k in lst) and name not in s.glob:
                add("info", "unused-variable", lst[0][0], "지역 변수 '%s' 에 값을 대입만 하고 사용하지 않습니다" % name)
# 함수 지표
def depth(n, d=0):
    m = d
    for c in ast.iter_child_nodes(n):
        if isinstance(c, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)): continue
        m = max(m, depth(c, d + (1 if isinstance(c, (ast.For, ast.AsyncFor, ast.While, ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)) else 0)))
    return m
for f in [x for x in ast.walk(tree) if isinstance(x, (ast.FunctionDef, ast.AsyncFunctionDef))]:
    cc = 1; selfc = 0
    for n in ast.walk(f):
        if isinstance(n, (ast.If, ast.For, ast.AsyncFor, ast.While, ast.ExceptHandler, ast.IfExp, ast.comprehension)): cc += 1
        if isinstance(n, ast.BoolOp): cc += len(n.values) - 1
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == f.name: selfc += 1
    out["functions"].append({"name": f.name, "line": f.lineno, "lines": (getattr(f, "end_lineno", f.lineno) - f.lineno + 1), "params": len(f.args.args), "cyclomatic": cc, "loopDepth": depth(f), "recursive": selfc > 0, "selfCalls": selfc})
print(json.dumps(out))
`;

let pyAvailable = null;
function runPython(code) {
  return new Promise((resolve, reject) => {
    if (pyAvailable === false) return reject(new Error('python3 없음'));
    let child;
    try { child = spawn('python3', ['-I', '-S', '-c', PY_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { pyAvailable = false; return reject(e); }
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('python 분석 시간 초과')); }, 8000);
    child.stdout.on('data', d => { out += d; if (out.length > 2_000_000) child.kill('SIGKILL'); });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); pyAvailable = false; reject(e); });
    child.on('close', () => {
      clearTimeout(timer); pyAvailable = true;
      try { resolve(JSON.parse(out)); } catch { reject(new Error('python 분석 결과 파싱 실패: ' + err.slice(0, 200))); }
    });
    child.stdin.on('error', () => { /* ignore EPIPE */ });
    child.stdin.end(code);
  });
}

const PY_BUILTINS = new Set(('abs aiter all anext any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile complex delattr dict dir divmod enumerate eval exec exit filter float format frozenset getattr globals hasattr hash help hex id input int isinstance issubclass iter len list locals map max memoryview min next object oct open ord pow print property quit range repr reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip __import__ __name__ __file__ __doc__ self cls True False None Exception BaseException ValueError TypeError KeyError IndexError AttributeError RuntimeError StopIteration NameError ImportError OSError IOError ZeroDivisionError NotImplementedError KeyboardInterrupt AssertionError FileNotFoundError SystemExit Warning NotImplemented Ellipsis OverflowError ArithmeticError LookupError UnicodeDecodeError UnicodeEncodeError TimeoutError PermissionError').split(' '));
const PY_KW = new Set('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case'.split(' '));

// python3 가 없을 때의 대체 분석 (들여쓰기·콜론·괄호·이름 정의)
function pyHeuristic(src) {
  const issues = [];
  const masked = src.split('\n').map(l => l.replace(/(["'])(?:\\.|(?!\1).)*\1/g, m => '"' + ' '.repeat(Math.max(0, m.length - 2)) + '"').replace(/#.*$/, ''));
  const defined = new Set();
  masked.forEach((l, i) => {
    let m;
    if ((m = /^\s*(?:async\s+)?def\s+(\w+)\s*\(([^)]*)/.exec(l))) { defined.add(m[1]); m[2].split(',').forEach(p => { const n = /^\s*\*{0,2}(\w+)/.exec(p); if (n) defined.add(n[1]); }); }
    if ((m = /^\s*class\s+(\w+)/.exec(l))) defined.add(m[1]);
    if ((m = /^\s*import\s+(.+)/.exec(l))) m[1].split(',').forEach(x => defined.add((x.split(/\s+as\s+/)[1] || x.trim().split('.')[0]).trim()));
    if ((m = /^\s*from\s+\S+\s+import\s+(.+)/.exec(l))) { if (m[1].trim() === '*') defined.add('*'); else m[1].replace(/[()]/g, '').split(',').forEach(x => defined.add((x.split(/\s+as\s+/)[1] || x).trim())); }
    for (const x of l.matchAll(/\bfor\s+([\w\s,()]+?)\s+in\b/g)) x[1].split(/[\s,()]+/).forEach(n => n && defined.add(n));
    for (const x of l.matchAll(/\bas\s+(\w+)/g)) defined.add(x[1]);
    for (const x of l.matchAll(/\blambda\s*([^:]*):/g)) x[1].split(',').forEach(p => { const n = /(\w+)/.exec(p); if (n) defined.add(n[1]); });
    if ((m = /^\s*([\w\s,.\[\]()*]+?)\s*(?:[-+*/%&|^]|\/\/|\*\*|>>|<<)?=(?!=)/.exec(l))) m[1].split(/[\s,()\[\]*]+/).forEach(n => { if (/^[A-Za-z_]\w*$/.test(n)) defined.add(n); });
    for (const x of l.matchAll(/\((\w+)\s*:=/g)) defined.add(x[1]);
    if ((m = /^\s*global\s+(.+)/.exec(l))) m[1].split(',').forEach(n => defined.add(n.trim()));
  });
  let depth = 0;
  masked.forEach((l, i) => {
    const ln = i + 1;
    if (/^\s*(def|class|if|elif|else|for|while|try|except|finally|with)\b[^#]*[^:\s,\\([{]\s*$/.test(l) && depth === 0 && !/:\s*\S/.test(l)) issues.push({ sev: 'error', rule: 'syntax', line: ln, col: l.length, message: '블록 시작 줄 끝에 콜론(:)이 없습니다', suggestion: '줄 끝에 : 를 추가하세요' });
    if (/^\s*print\s+[^(\s=]/.test(l)) issues.push({ sev: 'error', rule: 'syntax', line: ln, col: 1, message: 'print 문에 괄호가 없습니다 (Python 2 문법)', suggestion: 'print(...)' });
    for (const ch of l) { if ('([{'.includes(ch)) depth++; else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1); }
  });
  if (depth > 0) issues.push({ sev: 'error', rule: 'brackets', line: masked.length, col: 0, message: '닫히지 않은 괄호가 있습니다' });
  if (!defined.has('*')) {
    const seen = new Set();
    masked.forEach((l, i) => {
      for (const m of l.matchAll(/(?<![\w.])([A-Za-z_]\w*)(?!\w)/g)) {
        const n = m[1];
        if (PY_KW.has(n) || PY_BUILTINS.has(n) || defined.has(n) || seen.has(n)) continue;
        if (/^\s*\w+\s*=(?!=)/.test(l.slice(m.index)) && /[(,]\s*$/.test(l.slice(0, m.index))) continue;   // 키워드 인자
        if (new RegExp(`\\b${n}\\s*=(?!=)`).test(l) && /\(/.test(l.slice(0, m.index))) continue;
        seen.add(n);
        const sug = A.closest(n, [...defined, ...PY_BUILTINS]);
        issues.push({ sev: 'error', rule: 'undefined-name', line: i + 1, col: m.index + 1, message: `정의되지 않은 이름: ${n}`, suggestion: sug ? `'${sug}' 의 오타?` : '변수/함수를 정의하거나 import 하세요' });
      }
    });
  }
  return issues;
}

async function analyzePython(src) {
  let r;
  try { r = await runPython(src); } catch { r = null; }
  if (!r) return { engine: 'heuristic', issues: pyHeuristic(src), functions: [], note: 'python3 를 쓸 수 없어 근사 분석(들여쓰기·콜론·이름 정의)만 수행했습니다' };
  if (r.syntax) {
    const s = r.syntax;
    return { engine: 'python-ast', syntax: s, issues: [{ sev: 'error', rule: 'syntax', line: s.line, col: s.col, message: `문법 오류: ${s.message}${s.text ? ` → ${s.text.trim().slice(0, 80)}` : ''}`, suggestion: pyHint(s.message) }], functions: [], stage: 'syntax' };
  }
  return { engine: 'python-ast', issues: r.issues, functions: r.functions };
}
function pyHint(m) {
  if (/expected ':'/.test(m)) return '블록 시작 줄 끝에 : 가 필요합니다';
  if (/was never closed/.test(m)) return '열린 괄호/따옴표를 닫으세요';
  if (/indent/i.test(m)) return '들여쓰기(공백 4칸)를 맞추세요. 탭과 공백을 섞지 마세요';
  if (/invalid syntax/.test(m)) return '바로 앞 줄의 괄호·콜론·쉼표 누락을 확인하세요';
  if (/Missing parentheses in call to 'print'/.test(m)) return 'print(...) 로 쓰세요';
  return undefined;
}

// ---------------------------------------------------------------------------
// JSON / CSS / HTML
// ---------------------------------------------------------------------------
function analyzeJson(src) {
  try { JSON.parse(src); return { issues: [] }; } catch (e) {
    let line = 1, col = 1;
    const m = /position (\d+)/.exec(e.message), lc = /line (\d+) column (\d+)/.exec(e.message);
    if (lc) { line = +lc[1]; col = +lc[2]; }
    else if (m) { const before = src.slice(0, +m[1]); line = before.split('\n').length; col = before.length - before.lastIndexOf('\n'); }
    let hint;
    if (/,\s*[}\]]/.test(src)) hint = '마지막 항목 뒤의 쉼표(trailing comma)는 JSON 에서 허용되지 않습니다';
    else if (/'/.test(src)) hint = 'JSON 은 큰따옴표(")만 허용합니다';
    else if (/\/\/|\/\*/.test(src)) hint = 'JSON 에는 주석을 쓸 수 없습니다';
    else if (/\b(None|True|False|undefined|NaN)\b/.test(src)) hint = 'null/true/false 소문자만 허용됩니다';
    else if (/\{\s*[A-Za-z_]\w*\s*:/.test(src)) hint = '키는 큰따옴표로 감싸야 합니다';
    return { issues: [{ sev: 'error', rule: 'syntax', line, col, message: `JSON 오류: ${e.message.slice(0, 140)}`, suggestion: hint }] };
  }
}
function analyzeCss(src) {
  const issues = [];
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
  let line = 1; const st = [];
  for (const ch of clean) {
    if (ch === '\n') line++;
    else if (ch === '{') st.push(line);
    else if (ch === '}') { if (!st.pop()) issues.push({ sev: 'error', rule: 'syntax', line, col: 0, message: "짝이 없는 '}'" }); }
  }
  for (const l of st) issues.push({ sev: 'error', rule: 'syntax', line: l, col: 0, message: "닫히지 않은 '{'" });
  const props = 'color background background-color background-image border border-radius margin padding width height display position top left right bottom flex flex-direction justify-content align-items font-size font-family font-weight text-align line-height overflow opacity transition transform animation cursor z-index box-shadow gap grid grid-template-columns content max-width min-width max-height min-height text-decoration letter-spacing white-space visibility float clear outline'.split(' ');
  clean.split('\n').forEach((l, i) => {
    const m = /^\s*([a-z-]+)\s*:\s*[^;{}]+;?\s*$/.exec(l);
    if (m && !m[1].startsWith('-') && !props.includes(m[1])) { const s = A.closest(m[1], props); if (s) issues.push({ sev: 'warning', rule: 'css-property-typo', line: i + 1, col: 1, message: `알 수 없는 CSS 속성 '${m[1]}'`, suggestion: `'${s}' 의 오타?` }); }
  });
  return { issues };
}

const VOID = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
const OPTIONAL_CLOSE = new Set('p li td th tr dt dd option thead tbody tfoot colgroup head body html'.split(' '));
function scanHtml(src) {
  const tags = [], scripts = [], handlers = [], ids = new Map(), styles = [], srcs = [];
  const lineAt = pos => { let n = 1; for (let i = 0; i < pos; i++) if (src.charCodeAt(i) === 10) n++; return n; };
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt + 4); i = e < 0 ? src.length : e + 3; continue; }
    if (src[lt + 1] === '!' || src[lt + 1] === '?') { const e = src.indexOf('>', lt); i = e < 0 ? src.length : e + 1; continue; }
    const m = /^<(\/?)([A-Za-z][\w:-]*)/.exec(src.slice(lt, lt + 60));
    if (!m) { i = lt + 1; continue; }
    // 속성 끝 찾기 (따옴표 고려)
    let j = lt + m[0].length, q = null;
    for (; j < src.length; j++) { const c = src[j]; if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === '>') break; }
    const attrText = src.slice(lt + m[0].length, j);
    const name = m[2].toLowerCase(), closing = !!m[1], line = lineAt(lt);
    const attrs = {};
    for (const a of attrText.matchAll(/([^\s=\/"'>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? '';
    i = j + 1;
    if (!closing) {
      if (attrs.id !== undefined) { if (ids.has(attrs.id)) tags.push({ dupId: attrs.id, line }); else ids.set(attrs.id, line); }
      for (const [k, v] of Object.entries(attrs)) if (/^on[a-z]+$/.test(k) && v) handlers.push({ code: v, line, attr: k });
      if (attrs.src && (name === 'script' || name === 'img')) srcs.push({ name, src: attrs.src, line });
      if (name === 'link' && attrs.href) srcs.push({ name, src: attrs.href, line });
    }
    if (name === 'script' && !closing) {
      const end = src.toLowerCase().indexOf('</script', i);
      const bodyEnd = end < 0 ? src.length : end;
      scripts.push({ attrs, body: src.slice(i, bodyEnd), line: lineAt(i) });
      tags.push({ name, closing: false, line }); tags.push({ name, closing: true, line: lineAt(bodyEnd) });
      const ce = src.indexOf('>', bodyEnd); i = ce < 0 ? src.length : ce + 1; continue;
    }
    if (name === 'style' && !closing) {
      const end = src.toLowerCase().indexOf('</style', i);
      const bodyEnd = end < 0 ? src.length : end;
      styles.push({ body: src.slice(i, bodyEnd), line: lineAt(i) });
      const ce = src.indexOf('>', bodyEnd); i = ce < 0 ? src.length : ce + 1; continue;
    }
    tags.push({ name, closing, line, selfClose: /\/\s*$/.test(attrText) });
  }
  return { tags, scripts, handlers, ids, styles, srcs };
}

function analyzeHtml(src, extra = {}) {
  const issues = [];
  const h = scanHtml(src);
  if (!/<!doctype html/i.test(src)) issues.push({ sev: 'info', rule: 'doctype', line: 1, col: 1, message: '<!DOCTYPE html> 이 없습니다 (쿼크스 모드)' });
  const stack = [];
  for (const t of h.tags) {
    if (t.dupId) { issues.push({ sev: 'warning', rule: 'duplicate-id', line: t.line, col: 1, message: `중복된 id="${t.dupId}" (${h.ids.get(t.dupId)}줄에 이미 있음)` }); continue; }
    if (VOID.has(t.name) || t.selfClose) continue;
    if (!t.closing) { stack.push(t); continue; }
    let k = stack.length - 1;
    while (k >= 0 && stack[k].name !== t.name) k--;
    if (k < 0) { issues.push({ sev: 'error', rule: 'tag-mismatch', line: t.line, col: 1, message: `여는 태그가 없는 </${t.name}>` }); continue; }
    for (let x = stack.length - 1; x > k; x--) { const u = stack[x]; if (!OPTIONAL_CLOSE.has(u.name)) issues.push({ sev: 'error', rule: 'tag-mismatch', line: u.line, col: 1, message: `<${u.name}> (${u.line}줄)이 닫히지 않은 채 </${t.name}> (${t.line}줄)이 나왔습니다`, suggestion: `</${u.name}> 추가` }); }
    stack.length = k;
  }
  for (const u of stack) if (!OPTIONAL_CLOSE.has(u.name)) issues.push({ sev: 'error', rule: 'tag-unclosed', line: u.line, col: 1, message: `<${u.name}> 태그가 닫히지 않았습니다`, suggestion: `</${u.name}> 추가` });

  // 스크립트: 각 블록 문법 검사 후, 줄 번호를 유지해 하나로 합쳐 스코프 분석
  const external = h.scripts.some(s => s.attrs.src && !/^https?:\/\//.test(s.attrs.src)) || (extra.hasExternalScripts === true);
  let combined = '', curLine = 1;
  const jsScripts = h.scripts.filter(s => !s.attrs.src && s.body.trim() && (!s.attrs.type || /javascript|module/i.test(s.attrs.type)));
  const goodChunks = [];
  for (const s of jsScripts) {
    const syn = A.checkSyntax(s.body);
    if (!syn.ok) { issues.push({ sev: 'error', rule: 'syntax', line: (syn.line || 1) + s.line - 1, col: syn.col, message: `스크립트 문법 오류: ${syn.message}`, suggestion: syn.hint || undefined }); continue; }
    goodChunks.push(s);
  }
  for (const s of goodChunks) {
    while (curLine < s.line) { combined += '\n'; curLine++; }
    combined += s.body; curLine += (s.body.match(/\n/g) || []).length;
  }
  const handlerNames = new Set();
  for (const hd of h.handlers) for (const m of hd.code.matchAll(/(?<![\w.$])([A-Za-z_$][\w$]*)\s*\(/g)) handlerNames.add(m[1]);
  let topNames = [];
  if (combined.trim()) {
    try {
      const r = A.analyzeJs(combined, { env: 'browser', extraGlobals: extra.globals || [], externalNames: [...handlerNames].filter(n => !['alert', 'confirm', 'prompt'].includes(n) && false) });
      topNames = r.topLevelNames;
      for (const i of r.issues) {
        if (external && (i.rule === 'undefined-variable' || i.rule === 'undefined-function')) issues.push({ ...i, sev: 'warning', message: i.message + ' — 외부 <script src> 에서 정의될 수 있음' });
        else if (i.rule === 'unused' && handlerNames.has((/'([^']+)'/.exec(i.message) || [])[1])) continue;
        else issues.push(i);
      }
    } catch (e) { if (e.name !== 'ParseError') throw e; }
  }
  // 인라인 이벤트 핸들러가 호출하는 함수가 정의되어 있는지
  const defined = new Set([...topNames, ...(extra.globals || [])]);
  const globalsOk = new Set(A.buildGlobals('browser'));
  for (const hd of h.handlers) {
    for (const m of hd.code.matchAll(/(?<![\w.$])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const n = m[1];
      if (['if', 'for', 'while', 'function', 'return', 'switch', 'event', 'this'].includes(n) || defined.has(n) || globalsOk.has(n)) continue;
      const sug = A.closest(n, [...defined]);
      issues.push({ sev: external ? 'warning' : 'error', rule: 'undefined-handler', line: hd.line, col: 1, message: `${hd.attr}="${hd.code.slice(0, 40)}" 가 호출하는 함수 '${n}' 이(가) 정의되어 있지 않습니다`, suggestion: sug ? `'${sug}' 의 오타?` : `<script> 에 function ${n}() 를 정의하세요` });
    }
  }
  // getElementById / querySelector('#id') 대상
  const allJs = jsScripts.map(s => s.body).join('\n');
  const dynIds = new Set();
  for (const m of allJs.matchAll(/\bid\s*=\s*\\?["']([\w-]+)|setAttribute\(\s*['"]id['"]\s*,\s*['"]([\w-]+)|\.id\s*=\s*['"`]([\w-]+)/g)) dynIds.add(m[1] || m[2] || m[3]);
  const lineInJs = (s, idx) => s.line + (s.body.slice(0, idx).match(/\n/g) || []).length;
  for (const s of jsScripts) {
    for (const m of s.body.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)|querySelector(?:All)?\(\s*['"]#([\w-]+)[^'"]*['"]\s*\)/g)) {
      const id = m[1] || m[2];
      if (!h.ids.has(id) && !dynIds.has(id)) {
        const sug = A.closest(id, [...h.ids.keys()]);
        issues.push({ sev: external ? 'warning' : 'error', rule: 'missing-element', line: lineInJs(s, m.index), col: 1, message: `id="${id}" 요소가 HTML 에 없습니다 (null 이 되어 이후 속성 접근에서 TypeError)`, suggestion: sug ? `'${sug}' 의 오타?` : '해당 id 를 가진 요소를 추가하세요' });
      }
    }
    for (const m of s.body.matchAll(/querySelector(?:All)?\(\s*['"](canvas|video|audio|form|table)['"]\s*\)/g)) {
      if (!new RegExp(`<${m[1]}[\\s>]`, 'i').test(src.replace(/<script[\s\S]*?<\/script>/gi, ''))) issues.push({ sev: 'warning', rule: 'missing-element', line: lineInJs(s, m.index), col: 1, message: `<${m[1]}> 요소가 HTML 에 없습니다` });
    }
  }
  if (/getContext\(/.test(allJs) && !/<canvas[\s>]/i.test(src) && !/createElement\(\s*['"]canvas/.test(allJs)) issues.push({ sev: 'error', rule: 'missing-element', line: 1, col: 1, message: 'getContext 를 쓰지만 <canvas> 가 없습니다' });
  for (const st of h.styles) for (const i of analyzeCss(st.body).issues) issues.push({ ...i, line: i.line + st.line - 1, message: 'CSS: ' + i.message });
  for (const s of h.srcs) if (/^(?!https?:|\/\/|data:|#)/.test(s.src)) issues.push({ sev: 'info', rule: 'local-resource', line: s.line, col: 1, message: `로컬 리소스 '${s.src}' 가 실제로 존재하는지 확인하세요 (${s.name})` });
  return { issues, ids: [...h.ids.keys()].slice(0, 30), scripts: h.scripts.length, topNames, hasExternalScripts: external };
}

// ---------------------------------------------------------------------------
// 통합 진입점
// ---------------------------------------------------------------------------
async function analyze({ code, language, env, globals, context, filename }) {
  const src = codeOf(code);
  if (!src.trim()) throw new Error('code 가 비어 있습니다');
  let lang = normLang(language);
  if (lang === 'auto') lang = detectLanguage(src);
  const o = { env: env || 'auto', extraGlobals: Array.isArray(globals) ? globals.map(String) : [] };
  switch (lang) {
    case 'js': { const r = analyzeJsFull(src, o); return { language: 'js', stage: r.stage, issues: r.issues, functions: r.functions, syntax: r.syntax, env: r.r && r.r.env, raw: r }; }
    case 'python': { const r = await analyzePython(src); return { language: 'python', engine: r.engine, stage: r.stage, issues: r.issues, functions: r.functions, note: r.note, syntax: r.syntax }; }
    case 'luau': { const r = LU.analyzeLuau(src, { env: env === 'luau' ? 'luau' : 'roblox', extraGlobals: o.extraGlobals, context, filename }); return { language: 'luau', stage: r.stage, issues: r.issues, functions: r.functions, syntax: r.syntax, env: env === 'luau' ? 'luau' : 'roblox' }; }
    case 'html': { const r = analyzeHtml(src, { globals: o.extraGlobals }); return { language: 'html', issues: r.issues, functions: [], extra: { scripts: r.scripts, ids: r.ids } }; }
    case 'json': return { language: 'json', ...analyzeJson(src), functions: [] };
    case 'css': return { language: 'css', ...analyzeCss(src), functions: [] };
    default: {
      const br = require('./coding').IMPL.check_brackets({ code: src, language: 'js' });
      const issues = br.ok ? [] : [{ sev: 'error', rule: 'brackets', line: br.line, col: 0, message: br.error }];
      return { language: lang, issues, functions: [], note: `${lang} 는 괄호·문자열 짝만 검사합니다 (정밀 분석은 js/python/html/json/css 지원)` };
    }
  }
}

const IMPL = {};

IMPL.analyze_code = async ({ code, language, env, globals }) => {
  const r = await analyze({ code, language, env, globals });
  const frame = r.syntax && !r.syntax.ok && r.syntax.frame ? r.syntax.frame : (r.syntax && r.syntax.line && r.engine ? A.codeFrame(code, r.syntax.line, r.syntax.col) : null);
  const base = { language: r.language, stage: r.stage, env: r.env, engine: r.engine, note: r.note };
  const packed = pack(base, r.issues.map(stripInternal), { budget: frame ? 4300 : 5200 });
  if (frame) packed.frame = frame;
  if (r.stage === 'syntax') packed.next = '문법 오류를 먼저 고친 뒤 다시 analyze_code 를 호출해야 미정의 변수·함수 검사가 수행됩니다';
  else if (!packed.counts.error && !packed.counts.warning) packed.next = '오류 없음. 이후 실제 동작은 vserver_run_js 또는 run_python_sandbox 로 확인하세요';
  return packed;
};

IMPL.find_undefined_symbols = async ({ code, language, env, globals }) => {
  const r = await analyze({ code, language, env, globals });
  const rules = new Set(['undefined-variable', 'undefined-function', 'undefined-name', 'undefined-method', 'undefined-member', 'undefined-property', 'undefined-attribute', 'undefined-module-member', 'undefined-handler', 'undefined-field', 'bad-service', 'implicit-global', 'use-before-define', 'syntax', 'brackets', 'bad-import', 'missing-element']);
  const issues = r.issues.filter(i => rules.has(i.rule));
  return pack({ language: r.language, stage: r.stage, undefinedCount: issues.filter(i => i.rule !== 'syntax').length }, issues.map(stripInternal));
};

IMPL.analyze_luau = async ({ code, env, globals, context, filename }) => analyze({ code, language: 'luau', env, globals, context, filename }).then(r => {
  const frame = r.syntax && !r.syntax.ok && r.syntax.frame ? r.syntax.frame : null;
  const packed = pack({ language: 'luau', stage: r.stage, env: r.env }, r.issues.map(stripInternal), { budget: frame ? 4300 : 5200 });
  if (frame) packed.frame = frame;
  if (r.stage === 'syntax') packed.next = '문법 오류를 먼저 고친 뒤 다시 analyze_luau 를 호출해야 미정의 이름 검사가 수행됩니다';
  else if (!packed.counts.error && !packed.counts.warning) packed.next = '오류 없음. Roblox Studio 에서 실제 동작을 확인하세요 (이 서버는 Luau 를 실행하지 않습니다)';
  else packed.next = 'error 를 먼저 고치고, 확실한 철자·폐기 API 는 autofix_code 로 자동 수정할 수 있습니다';
  return packed;
});

IMPL.analyze_html_page = ({ html }) => {
  const r = analyzeHtml(codeOf(html, 'html'));
  return pack({ scripts: r.scripts, ids: r.ids, externalScripts: r.hasExternalScripts }, r.issues.map(stripInternal));
};

IMPL.review_code = async ({ code, language }) => {
  const r = await analyze({ code, language });
  const issues = r.issues;
  const c = { error: 0, warning: 0, info: 0 };
  issues.forEach(i => { c[i.sev]++; });
  const fns = (r.functions || []).slice().sort((a, b) => b.cyclomatic - a.cyclomatic);
  let penalty = c.error * 15 + c.warning * 4 + Math.min(c.info, 10);
  const hot = fns.filter(f => f.cyclomatic > 10 || (f.maxNesting || 0) > 4 || f.lines > 60);
  penalty += hot.length * 5;
  const score = Math.max(0, 100 - penalty);
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';
  const funcs = fns.slice(0, 8).map(f => ({ name: f.name, line: f.line, lines: f.lines, cyclomatic: f.cyclomatic, nesting: f.maxNesting, loopDepth: f.loopDepth, time: r.language === 'js' ? A.complexityLabel(f) : (f.loopDepth ? `O(n^${f.loopDepth})` : 'O(1)') + (f.recursive ? ' · 재귀' : '') }));
  const advice = [];
  if (c.error) advice.push(`오류 ${c.error}건을 먼저 수정`);
  hot.slice(0, 3).forEach(f => advice.push(`'${f.name}' 가 복잡함(순환복잡도 ${f.cyclomatic}, ${f.lines}줄): 함수 분리 권장`));
  if (fns.some(f => f.loopDepth >= 3)) advice.push('3중 이상 반복문: 자료구조(Map/Set) 로 탐색 비용 줄이기');
  return pack({ language: r.language, score, grade, functions: funcs, advice }, issues.map(stripInternal), { budget: 3800, minSev: 'warning' });
};

IMPL.autofix_code = async ({ code, language }) => {
  const src = codeOf(code);
  const lang = normLang(language) === 'auto' ? detectLanguage(src) : normLang(language);
  if (lang === 'luau') { const r = LU.autofixLuau(src, {}); return r.changed && r.fixed_code.length > 4500 ? { ...r, fixed_code: undefined, note: '코드가 길어 changes 목록대로 직접 수정하세요' } : { ...r, note: r.changed ? '철자·폐기 API·: 호출 같은 확실한 항목만 고쳤습니다. 의도와 맞는지 확인하세요' : undefined }; }
  if (lang !== 'js') throw new Error('autofix_code 는 JavaScript·Luau 만 지원합니다 (다른 언어는 analyze_code 의 fix 힌트를 참고)');
  const r = analyzeJsFull(src, {});
  if (r.stage !== 'analysis') return { changed: false, reason: '문법 오류가 있어 자동 수정을 건너뜁니다. analyze_code 로 먼저 문법 오류를 고치세요' };
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1);
  const edits = [];
  const changes = [];
  for (const i of r.issues) {
    if (i.replaceId && i.suggestion && /의 오타/.test(i.suggestion) && i.replaceId.end - i.replaceId.pos === (src.slice(i.replaceId.pos, i.replaceId.end)).length) {
      edits.push({ pos: i.replaceId.pos, end: i.replaceId.end, text: i.replaceId.to }); changes.push(`${i.line}줄: ${src.slice(i.replaceId.pos, i.replaceId.end)} → ${i.replaceId.to}`);
    } else if (i.replaceProp && i.replaceProp.line) {
      const pos = lineStarts[i.replaceProp.line - 1] + i.replaceProp.col - 1;
      if (src.startsWith(i.replaceProp.from, pos)) { edits.push({ pos, end: pos + i.replaceProp.from.length, text: i.replaceProp.to }); changes.push(`${i.replaceProp.line}줄: .${i.replaceProp.from} → .${i.replaceProp.to}`); }
    } else if (i.rule === 'parseint-radix' || i.rule === 'loose-equality') {
      if (i.fix) { edits.push(i.fix); changes.push(`${i.line}줄: ${i.rule === 'parseint-radix' ? 'parseInt radix 추가' : '== → ==='}`); }
    } else if (i.rule === 'length-call') {
      const l0 = lineStarts[i.line - 1], seg = src.slice(l0, (lineStarts[i.line] || src.length));
      const m = /\.length\s*\(\s*\)/.exec(seg);
      if (m) { edits.push({ pos: l0 + m.index, end: l0 + m.index + m[0].length, text: '.length' }); changes.push(`${i.line}줄: .length() → .length`); }
    }
  }
  const uniq = [...new Map(edits.map(e => [e.pos, e])).values()].sort((a, b) => b.pos - a.pos);
  let out = src;
  for (const e of uniq) out = out.slice(0, e.pos) + e.text + out.slice(e.end);
  if (!uniq.length) return { changed: false, reason: '자동으로 안전하게 고칠 항목이 없습니다 (analyze_code 결과를 보고 직접 수정)' };
  const syn = A.checkSyntax(out);
  if (!syn.ok) return { changed: false, reason: '자동 수정 후 문법 오류가 생겨 취소했습니다', error: syn.message };
  return { changed: true, count: uniq.length, changes: changes.slice(0, 30), fixed_code: out.length > 4500 ? undefined : out, note: out.length > 4500 ? '코드가 길어 changes 목록대로 직접 수정하세요' : '오타 수정은 후보가 하나뿐일 때만 적용됩니다. 의도와 맞는지 확인하세요' };
};

IMPL.check_project_files = async ({ files }) => {
  if (!Array.isArray(files) || !files.length || files.length > 40) throw new Error('files 는 1~40개의 {path, content} 배열이어야 합니다');
  let total = 0;
  const map = new Map();
  for (const f of files) {
    if (!f || typeof f.path !== 'string' || typeof f.content !== 'string') throw new Error('각 파일은 {path, content} 문자열이어야 합니다');
    total += f.content.length; if (total > 400_000) throw new Error('전체 크기가 너무 큽니다 (400KB)');
    map.set(f.path.replace(/^\.\//, ''), f.content);
  }
  const issues = [];
  const exportsOf = new Map(), namesOf = new Map();
  const htmlPages = [...map].filter(([p]) => /\.html?$/i.test(p));
  const pageGlobals = new Map();   // js 파일 → 같은 페이지의 다른 스크립트 전역
  const dirOf = p => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const norm = p => { const out = []; for (const s of p.split('/')) { if (s === '..') out.pop(); else if (s && s !== '.') out.push(s); } return out.join('/'); };
  const jsInfo = new Map();
  for (const [p, c] of map) if (/\.(c?js|mjs)$/.test(p)) { try { const r = A.analyzeJs(c, { env: 'both' }); namesOf.set(p, r.topLevelNames); } catch { /* 문법 오류는 아래서 */ } }
  for (const [p, c] of htmlPages) {
    const srcs = [...c.matchAll(/<script[^>]*\ssrc\s*=\s*["']([^"']+)["']/gi)].map(m => norm((dirOf(p) ? dirOf(p) + '/' : '') + m[1])).filter(x => !/^https?:/.test(x));
    for (const s of srcs) { const others = srcs.filter(x => x !== s).flatMap(x => namesOf.get(x) || []); pageGlobals.set(s, [...(pageGlobals.get(s) || []), ...others]); }
  }
  for (const [p, c] of map) {
    const tag = x => ({ ...x, file: p });
    if (/\.(c?js|mjs)$/.test(p)) {
      const r = analyzeJsFull(c, { env: pageGlobals.has(p) ? 'browser' : 'auto', extraGlobals: pageGlobals.get(p) || [] });
      r.issues.filter(i => i.sev !== 'info').forEach(i => issues.push(tag(stripInternal(i))));
      if (r.r) jsInfo.set(p, r.r);
    } else if (/\.html?$/i.test(p)) {
      const hasExt = /<script[^>]*\ssrc\s*=\s*["'](?!https?:)/i.test(c);
      const glob = [...c.matchAll(/<script[^>]*\ssrc\s*=\s*["']([^"']+)["']/gi)].flatMap(m => namesOf.get(norm((dirOf(p) ? dirOf(p) + '/' : '') + m[1])) || []);
      const r = analyzeHtml(c, { globals: glob, hasExternalScripts: hasExt && !glob.length });
      r.issues.filter(i => i.sev !== 'info').forEach(i => issues.push(tag(stripInternal(i))));
      for (const m of c.matchAll(/<(?:script[^>]*\ssrc|link[^>]*\shref|img[^>]*\ssrc)\s*=\s*["']([^"']+)["']/gi)) {
        if (/^(https?:|\/\/|data:|#)/.test(m[1])) continue;
        const target = norm((dirOf(p) ? dirOf(p) + '/' : '') + m[1].split(/[?#]/)[0]);
        if (!map.has(target)) issues.push({ sev: 'error', rule: 'missing-file', file: p, line: c.slice(0, m.index).split('\n').length, message: `참조한 파일 '${m[1]}' 이(가) 프로젝트에 없습니다` });
      }
    } else if (/\.luau?$/i.test(p)) {
      const r = LU.analyzeLuau(c, { filename: p });
      r.issues.filter(i => i.sev !== 'info').forEach(i => issues.push(tag(stripInternal(i))));
      if (r.ast) for (const rq of LU.requiresOf(r.ast)) {
        if (rq.str || !rq.name) continue;
        const names = [...map.keys()].map(k => k.split('/').pop().replace(/\.(luau?)$/i, '').replace(/^init$/, '')).concat([...map.keys()].map(k => k.split('/').slice(-2, -1)[0] || ''));
        const roots = new Set(['script', 'game', 'ReplicatedStorage', 'ServerScriptService', 'ServerStorage', 'ReplicatedFirst', 'StarterPlayer', 'workspace']);
        if (roots.has(rq.root) && !names.includes(rq.name) && /^[A-Z]/.test(rq.name) && rq.chain.length <= 4) issues.push({ sev: 'warning', rule: 'missing-module', file: p, line: rq.line, message: `require 하는 '${rq.name}' 모듈 파일이 프로젝트에 없습니다`, suggestion: `후보: ${[...map.keys()].filter(k => /\.luau?$/i.test(k)).slice(0, 6).join(', ')}` });
      }
    } else if (/\.json$/.test(p)) analyzeJson(c).issues.forEach(i => issues.push(tag(i)));
    else if (/\.py$/.test(p)) (await analyzePython(c)).issues.filter(i => i.sev === 'error').forEach(i => issues.push(tag(i)));
    else if (/\.css$/.test(p)) analyzeCss(c).issues.forEach(i => issues.push(tag(i)));
  }
  // require/import 경로와 export 이름 교차 검사
  for (const [p, r] of jsInfo) {
    for (const rq of r.requires) {
      if (!rq.source.startsWith('.')) continue;
      const base = norm((dirOf(p) ? dirOf(p) + '/' : '') + rq.source);
      const target = [base, base + '.js', base + '.cjs', base + '.mjs', base + '.json', base + '/index.js'].find(x => map.has(x));
      if (!target) { issues.push({ sev: 'error', rule: 'missing-module', file: p, line: rq.line, message: `'${rq.source}' 모듈 파일이 없습니다`, suggestion: `후보: ${[...map.keys()].filter(k => /\.(c?js|mjs)$/.test(k)).slice(0, 6).join(', ')}` }); continue; }
      const ex = jsInfo.get(target);
      if (!ex || ex.exports.unknown) continue;
      const names = ex.exports.names;
      for (const n of rq.named) if (!names.has(n.name)) { const s = A.closest(n.name, [...names]); issues.push({ sev: 'error', rule: 'missing-export', file: p, line: n.line || rq.line, message: `'${rq.source}' 가 '${n.name}' 을(를) export 하지 않습니다`, suggestion: s ? `'${s}' 의 오타?` : `export 된 이름: ${[...names].join(', ') || '(없음)'}` }); }
      for (const m of rq.members || []) if (!names.has(m.name) && !(ex.exports.callable)) { const s = A.closest(m.name, [...names]); issues.push({ sev: 'error', rule: 'missing-export', file: p, line: m.line, message: `'${rq.source}' 가 '${m.name}' 을(를) export 하지 않습니다 (${rq.ns}.${m.name})`, suggestion: s ? `'${s}' 의 오타?` : undefined }); }
    }
  }
  const pj = map.get('package.json');
  if (pj) {
    try {
      const j = JSON.parse(pj);
      const deps = new Set([...Object.keys(j.dependencies || {}), ...Object.keys(j.devDependencies || {})]);
      const bi = new Set(require('module').builtinModules);
      for (const [p, r] of jsInfo) for (const rq of r.requires) { if (rq.source.startsWith('.') || rq.source.startsWith('node:')) continue; const b = rq.source.startsWith('@') ? rq.source.split('/').slice(0, 2).join('/') : rq.source.split('/')[0]; if (!bi.has(b) && !deps.has(b)) issues.push({ sev: 'warning', rule: 'missing-dependency', file: p, line: rq.line, message: `'${b}' 이(가) package.json dependencies 에 없습니다`, suggestion: `npm install ${b}` }); }
      if (j.main && !map.has(norm(j.main))) issues.push({ sev: 'error', rule: 'missing-file', file: 'package.json', line: 1, message: `main '${j.main}' 파일이 없습니다` });
      const st = j.scripts && j.scripts.start; const m = st && /node\s+(\S+)/.exec(st); if (m && !map.has(norm(m[1]))) issues.push({ sev: 'error', rule: 'missing-file', file: 'package.json', line: 1, message: `start 스크립트의 '${m[1]}' 파일이 없습니다` });
    } catch { /* json 오류는 위에서 보고 */ }
  }
  return pack({ files: map.size }, issues, { budget: 5400 });
};

const LANG_PROP = S('STRING', '언어 (auto/js/python/html/json/css/luau). 기본 auto. Roblox Lua 는 luau');
const GLOBALS_PROP = { type: 'ARRAY', items: { type: 'STRING' }, description: '이미 정의돼 있다고 가정할 전역 이름 (다른 파일/CDN 에서 오는 이름)' };
const DECL = [
  { name: 'analyze_code', description: '코드를 실행하지 않고 종합 점검한다: 문법 오류(줄·칸·코드 프레임·원인 힌트), 정의되지 않은 변수·함수·메서드(오타 후보), 선언 전 사용(TDZ), const 재대입, 인자 개수 불일치, 도달 불가 코드, await 누락, 대입 조건문, 오타 난 내장 함수(Math.flor, console.lgo, getElementByID). JS·Python·HTML·JSON·CSS 지원. 코드를 작성하거나 고친 뒤 답하기 전에 반드시 호출하고, error 가 0이 될 때까지 고쳐 다시 호출하라.',
    parameters: OBJ({ code: S('STRING', '검사할 코드 전체'), language: LANG_PROP, env: S('STRING', 'JS 실행 환경', { enum: ['auto', 'node', 'browser', 'both'] }), globals: GLOBALS_PROP }, ['code']) },
  { name: 'analyze_luau', description: 'Luau / Roblox Lua 코드를 실행하지 않고 점검한다: 문법 오류(줄·칸·어느 줄의 end 가 빠졌는지), 정의되지 않은 변수·함수(오타 후보), 위에서 쓰고 아래에서 local 선언한 순서 문제, 없는 라이브러리 멤버(math.flor, task.Wait, Vector3.New), 없는 서비스 이름, 암묵 전역, 정의되지 않은 모듈 필드, 미사용 local, Roblox 함정(yield 없는 while true, wait/spawn 폐기, .Destroy() 처럼 : 대신 . 호출, FindFirstChild 결과 바로 인덱싱, :Connect(f()) 등). 파일을 만든 뒤 반드시 실행하라.',
    parameters: OBJ({ code: S('STRING', 'Luau 코드 전체'), env: S('STRING', 'roblox(기본: game·workspace 등 Roblox 전역 허용) 또는 luau(표준 Luau 만)', { enum: ['roblox', 'luau'] }), context: S('STRING', '스크립트 종류: server(Script) / client(LocalScript) / module. 서버·클라 전용 API 를 잘못 쓰면 잡는다', { enum: ['server', 'client', 'module'] }), filename: S('STRING', '파일 이름 (예: Main.server.luau — 이름으로 server/client 자동 판정)'), globals: GLOBALS_PROP }, ['code']) },
  { name: 'find_undefined_symbols', description: '정의되지 않은 변수·함수·메서드·import 와 문법 오류만 빠르게 찾는다(오타 후보 포함). "X is not defined" 류 오류의 원인을 추적할 때 사용.',
    parameters: OBJ({ code: S('STRING', '코드'), language: LANG_PROP, env: S('STRING', 'JS 환경', { enum: ['auto', 'node', 'browser', 'both'] }), globals: GLOBALS_PROP }, ['code']) },
  { name: 'analyze_html_page', description: 'HTML 한 파일(내장 JS/CSS 포함)을 교차 검사한다: 태그 짝, 중복 id, 스크립트 문법·미정의 이름, onclick 등 인라인 핸들러가 부르는 함수 존재 여부, getElementById 대상 요소 존재 여부, canvas 누락.',
    parameters: OBJ({ html: S('STRING', '전체 HTML') }, ['html']) },
  { name: 'review_code', description: '코드 품질 리뷰: 오류·경고 요약, 점수/등급, 함수별 순환 복잡도·중첩·반복 깊이, 시간 복잡도 추정, 개선 조언.',
    parameters: OBJ({ code: S('STRING', '코드'), language: LANG_PROP }, ['code']) },
  { name: 'autofix_code', description: 'JavaScript 의 확실한 오타(미정의 이름의 단일 후보, Math.flor, .length(), parseInt radix, ==)를 자동 수정한 코드를 돌려준다. 수정 후 문법을 재검사하며 실패하면 취소한다.',
    parameters: OBJ({ code: S('STRING', 'JS 코드'), language: LANG_PROP }, ['code']) },
  { name: 'check_project_files', description: '여러 파일 프로젝트를 교차 검사한다: 각 파일의 문법·미정의 이름, require/import 경로 존재, 가져온 이름이 실제 export 되는지, HTML 의 script/link 파일 존재, package.json 의존성·main·start 대조.',
    parameters: OBJ({ files: { type: 'ARRAY', description: '파일 목록', items: { type: 'OBJECT', properties: { path: S('STRING', '상대 경로'), content: S('STRING', '파일 내용') }, required: ['path', 'content'] } } }, ['files']) }
];

module.exports = { DECL, IMPL, analyze, analyzeHtml, analyzeJsFull, detectLanguage, pyHeuristic };
