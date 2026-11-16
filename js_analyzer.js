'use strict';
/**
 * js_analyzer.js — JavaScript 정적 분석기 (코드를 실행하지 않음)
 *
 *  · V8 컴파일(vm.Script)로 문법 오류의 정확한 줄·칸·원인을 얻는다 (ESM·최상위 await·최상위 return 스니펫도 처리)
 *  · js_parser 의 AST 로 스코프를 구성해 "정의되지 않은 변수·함수·메서드"를 찾고 오타 후보를 제안한다
 *  · TDZ(선언 전 사용), const 재대입, 인자 개수 불일치, 도달 불가 코드, await 누락, 대입 조건문 등을 검사한다
 *  · 함수별 순환 복잡도·반복문 중첩·재귀를 계산해 시간 복잡도를 추정한다
 */
const vm = require('vm');
const { parse, ParseError } = require('./js_parser');

// ---------------------------------------------------------------------------
// 전역 이름 / 내장 멤버 사전
// ---------------------------------------------------------------------------
const ES_GLOBALS = ('Object Function Array Number parseFloat parseInt Infinity NaN undefined Boolean String Symbol Date Promise RegExp Error EvalError RangeError ReferenceError SyntaxError TypeError URIError AggregateError globalThis JSON Math Intl ArrayBuffer SharedArrayBuffer Uint8Array Uint8ClampedArray Int8Array Uint16Array Int16Array Uint32Array Int32Array Float32Array Float64Array BigInt64Array BigUint64Array DataView Map Set WeakMap WeakSet WeakRef FinalizationRegistry Proxy Reflect BigInt Atomics decodeURI decodeURIComponent encodeURI encodeURIComponent escape unescape eval isFinite isNaN console setTimeout clearTimeout setInterval clearInterval queueMicrotask structuredClone atob btoa URL URLSearchParams TextEncoder TextDecoder AbortController AbortSignal Event EventTarget fetch Headers Request Response FormData Blob performance crypto WebAssembly Iterator BroadcastChannel MessageChannel MessagePort MessageEvent DOMException').split(' ');
const NODE_GLOBALS = 'process Buffer require module exports __dirname __filename global setImmediate clearImmediate'.split(' ');
const BROWSER_GLOBALS = ('window document navigator location history screen localStorage sessionStorage indexedDB alert confirm prompt print open close stop focus blur requestAnimationFrame cancelAnimationFrame requestIdleCallback cancelIdleCallback Image Audio Option HTMLElement HTMLCanvasElement HTMLInputElement HTMLImageElement HTMLVideoElement HTMLAudioElement HTMLFormElement HTMLButtonElement HTMLDivElement HTMLSelectElement HTMLTextAreaElement HTMLTemplateElement HTMLAnchorElement Element Node NodeList HTMLCollection Document DocumentFragment Text Comment Range Selection ShadowRoot CustomEvent KeyboardEvent MouseEvent TouchEvent PointerEvent WheelEvent InputEvent FocusEvent DragEvent ClipboardEvent ErrorEvent StorageEvent CanvasRenderingContext2D WebGLRenderingContext WebGL2RenderingContext Path2D ImageData ImageBitmap OffscreenCanvas createImageBitmap DOMParser XMLSerializer XMLHttpRequest WebSocket EventSource Worker SharedWorker ServiceWorker MutationObserver IntersectionObserver ResizeObserver PerformanceObserver getComputedStyle matchMedia customElements innerWidth innerHeight outerWidth outerHeight scrollX scrollY pageXOffset pageYOffset devicePixelRatio scrollTo scrollBy self top parent frames opener name status length addEventListener removeEventListener dispatchEvent postMessage FileReader File FileList DataTransfer Notification AudioContext webkitAudioContext OscillatorNode GainNode AnalyserNode MediaRecorder MediaStream speechSynthesis SpeechSynthesisUtterance Gamepad Touch DOMRect DOMMatrix DOMPoint CSS CSSStyleSheet getSelection requestFileSystem Storage Plotly Chart THREE').split(' ');
const KNOWN_LIBS = {
  '$': 'jQuery 를 불러오지 않았습니다 (CDN <script> 추가) — 또는 document.querySelector 사용', jQuery: 'jQuery 스크립트 로드 필요', _: 'lodash 로드 필요 (require("lodash") 또는 CDN)', axios: "axios 를 require/import 하거나 fetch 사용",
  React: "react import 필요", ReactDOM: "react-dom import 필요", Vue: 'Vue 로드 필요', moment: 'moment 로드 필요', express: "const express = require('express')", mongoose: "const mongoose = require('mongoose')",
  fs: "const fs = require('fs')", path: "const path = require('path')", http: "const http = require('http')", https: "const https = require('https')", os: "const os = require('os')",
  crypto2: '', util: "const util = require('util')", url: "const url = require('url')", child_process: "const child_process = require('child_process')", EventEmitter: "const EventEmitter = require('events')",
  readline: "const readline = require('readline')", zlib: "const zlib = require('zlib')"
};
const DOCUMENT_MEMBERS = new Set(('getElementById getElementsByClassName getElementsByTagName getElementsByName querySelector querySelectorAll createElement createElementNS createTextNode createDocumentFragment createEvent createRange createComment addEventListener removeEventListener dispatchEvent body head documentElement title cookie readyState URL domain referrer location defaultView activeElement forms images links scripts styleSheets all hidden visibilityState fullscreenElement exitFullscreen exitPointerLock pointerLockElement execCommand hasFocus write writeln open close implementation designMode doctype characterSet contentType compatMode elementFromPoint elementsFromPoint getSelection adoptNode importNode createTreeWalker createNodeIterator onreadystatechange onclick onkeydown onkeyup onmousemove onmousedown onmouseup onload oncontextmenu ontouchstart ontouchend ontouchmove onvisibilitychange fonts timeline append prepend children firstElementChild lastElementChild childElementCount replaceChildren startViewTransition currentScript scrollingElement lastModified dir').split(' '));
const CONSOLE_MEMBERS = new Set('log error warn info debug table dir dirxml time timeEnd timeLog trace assert count countReset group groupCollapsed groupEnd clear profile profileEnd timeStamp'.split(' '));

const KNOWN_MEMBERS = new Set();
(function buildKnown() {
  const objs = [Object, Function, Array, String, Number, Boolean, Symbol, Date, Promise, RegExp, Error, Map, Set, WeakMap, WeakSet, ArrayBuffer, DataView, Uint8Array, BigInt, Math, JSON, Reflect, Intl, URL, URLSearchParams, Proxy];
  for (const o of objs) {
    for (const t of [o, o && o.prototype]) {
      if (!t) continue;
      try { for (const k of Object.getOwnPropertyNames(t)) KNOWN_MEMBERS.add(k); } catch { /* ignore */ }
    }
  }
  try { for (const k of Object.getOwnPropertyNames(Object.getPrototypeOf(Uint8Array).prototype)) KNOWN_MEMBERS.add(k); } catch { /* ignore */ }
  for (const k of DOCUMENT_MEMBERS) KNOWN_MEMBERS.add(k);
  for (const k of CONSOLE_MEMBERS) KNOWN_MEMBERS.add(k);
  ('style classList className id innerHTML outerHTML innerText textContent value checked disabled href src alt type name placeholder parentNode parentElement childNodes firstChild lastChild nextSibling previousSibling nextElementSibling previousElementSibling appendChild removeChild replaceChild insertBefore insertAdjacentHTML insertAdjacentElement insertAdjacentText cloneNode contains remove before after replaceWith setAttribute getAttribute hasAttribute removeAttribute toggleAttribute attributes dataset offsetWidth offsetHeight offsetLeft offsetTop offsetParent clientWidth clientHeight clientLeft clientTop scrollWidth scrollHeight scrollTop scrollLeft getBoundingClientRect getClientRects scrollIntoView focus blur click closest matches width height getContext toDataURL toBlob fillRect strokeRect clearRect fillText strokeText fillStyle strokeStyle lineWidth lineCap lineJoin beginPath closePath moveTo lineTo arc arcTo ellipse rect bezierCurveTo quadraticCurveTo fill stroke clip save restore translate rotate scale transform setTransform drawImage createImageData getImageData putImageData measureText createLinearGradient createRadialGradient addColorStop font textAlign textBaseline globalAlpha globalCompositeOperation shadowBlur shadowColor shadowOffsetX shadowOffsetY setLineDash imageSmoothingEnabled preventDefault stopPropagation stopImmediatePropagation target currentTarget key code keyCode which clientX clientY pageX pageY offsetX offsetY screenX screenY button buttons touches changedTouches targetTouches ctrlKey shiftKey altKey metaKey repeat deltaX deltaY detail bubbles cancelable timeStamp play pause load currentTime duration volume muted loop paused ended playbackRate autoplay srcObject then catch finally status statusText ok headers body json text blob arrayBuffer formData clone redirected getItem setItem removeItem clear key length keys values entries forEach send open abort readyState responseText responseType response onreadystatechange onload onerror onmessage onclose onopen close postMessage terminate readAsText readAsDataURL readAsArrayBuffer result files selectedIndex options selected form elements submit reset reportValidity checkValidity setCustomValidity validity labels list rows cells insertRow insertCell deleteRow deleteCell tBodies tHead tFoot caption sheet cssRules insertRule deleteRule setProperty getPropertyValue removeProperty cssText getContext requestFullscreen requestPointerLock webkitRequestFullscreen animate getAnimations finished cancel finish reverse commitStyles observe unobserve disconnect takeRecords isIntersecting intersectionRatio boundingClientRect rootBounds contentRect addListener removeListener matches media onchange now mark measure getEntries timeOrigin hardwareConcurrency userAgent platform language languages onLine clipboard writeText readText geolocation getCurrentPosition watchPosition clearWatch mediaDevices getUserMedia enumerateDevices vibrate sendBeacon share serviceWorker permissions href origin protocol host hostname port pathname search hash searchParams assign replace reload back forward go pushState replaceState state scrollRestoration hasChildNodes normalize isConnected nodeType nodeName nodeValue ownerDocument getRootNode compareDocumentPosition isEqualNode isSameNode lookupNamespaceURI contentWindow contentDocument srcdoc sandbox allow loading decode complete naturalWidth naturalHeight currentSrc crossOrigin sizes srcset').split(' ').forEach(k => KNOWN_MEMBERS.add(k));
  for (const m of ['fs', 'path', 'os', 'util', 'crypto', 'http', 'https', 'events', 'url', 'child_process', 'stream', 'zlib', 'readline', 'net', 'assert', 'buffer', 'querystring', 'vm', 'perf_hooks', 'worker_threads', 'string_decoder', 'dns', 'tls', 'timers', 'v8', 'module', 'process']) {
    try { const mod = require(m); for (const k of Object.getOwnPropertyNames(mod)) KNOWN_MEMBERS.add(k); if (mod && mod.prototype) for (const k of Object.getOwnPropertyNames(mod.prototype)) KNOWN_MEMBERS.add(k); } catch { /* ignore */ }
  }
  'req res next send json status redirect render sendFile listen use get post put delete patch params query body headers cookies session end write writeHead setHeader getHeader on once off emit emitter addListener removeListener prependListener pipe destroy resume pause'.split(' ').forEach(k => KNOWN_MEMBERS.add(k));
  'collection find findOne findOneAndUpdate insertOne insertMany updateOne updateMany deleteOne deleteMany countDocuments aggregate toArray sort limit skip project connect db close createIndex replaceOne distinct drop'.split(' ').forEach(k => KNOWN_MEMBERS.add(k));
})();

const PROTO_MEMBERS = new Set();
for (const o of [Object, Function, Array, String, Number, Promise, RegExp, Map, Set, Date, Math, JSON]) for (const t of [o, o.prototype]) { if (t) for (const k of Object.getOwnPropertyNames(t)) PROTO_MEMBERS.add(k); }
for (const k of DOCUMENT_MEMBERS) PROTO_MEMBERS.add(k);
for (const k of CONSOLE_MEMBERS) PROTO_MEMBERS.add(k);
const NAMESPACE_OBJS = { Math, JSON, Object, Array, Number, String, Promise, Reflect, Symbol, Date, BigInt, Boolean, Intl };
const VALID_TYPEOF = new Set(['undefined', 'object', 'boolean', 'number', 'bigint', 'string', 'symbol', 'function']);
const HOF_CALLBACK = new Set(['map', 'filter', 'find', 'findIndex', 'findLast', 'findLastIndex', 'some', 'every', 'flatMap', 'reduce', 'reduceRight', 'sort', 'toSorted']);
const LOOPY_METHODS = new Set(['forEach', 'map', 'filter', 'find', 'findIndex', 'findLast', 'some', 'every', 'flatMap', 'reduce', 'reduceRight', 'sort', 'toSorted']);
const LINEAR_METHODS = new Set(['indexOf', 'lastIndexOf', 'includes', 'slice', 'concat', 'join', 'splice', 'reverse', 'keys', 'values', 'entries']);
const OBJECT_PROTO = new Set(Object.getOwnPropertyNames(Object.prototype));

// ---------------------------------------------------------------------------
// 문자열 유틸: Damerau-Levenshtein, 오타 후보
// ---------------------------------------------------------------------------
function editDistance(a, b, max = 4) {
  if (a === b) return 0;
  const al = a.length, bl = b.length;
  if (Math.abs(al - bl) > max) return max + 1;
  const d = [];
  for (let i = 0; i <= al; i++) { d[i] = new Array(bl + 1); d[i][0] = i; }
  for (let j = 0; j <= bl; j++) d[0][j] = j;
  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[al][bl];
}
function closest(name, candidates, { maxRel = 0.34 } = {}) {
  if (!name || name.length < 3) return null;
  const lower = name.toLowerCase();
  let best = null, bestD = Infinity;
  for (const c of candidates) {
    if (!c || c === name || c.length < 2) continue;
    const dist = c.toLowerCase() === lower ? 0.5 : editDistance(name, c, 3);
    const limit = name.length <= 4 ? 1 : name.length <= 7 ? 2 : 3;
    if (dist <= limit && dist / Math.max(name.length, c.length) <= maxRel + 0.01 && dist < bestD) { best = c; bestD = dist; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// V8 문법 검사 (ESM·최상위 await/return 허용)
// ---------------------------------------------------------------------------
function compileCheck(text, filename = 'candidate.js') {
  try { new vm.Script(text, { filename }); return null; } catch (e) { return e; }
}
function describeV8(err, colShiftLine1 = 0, wrappedLines = 0) {
  const stack = String(err.stack || '');
  const m = /^[^\n]*?:(\d+)\n([^\n]*)\n( *)(\^+)/m.exec(stack);
  let line = null, col = null, text = null;
  if (m) {
    line = Number(m[1]); text = m[2];
    col = m[3].length + 1;
    if (line === 1 && colShiftLine1) { col = Math.max(1, col - colShiftLine1); text = text.slice(colShiftLine1); }
  }
  return { message: err.message, line, col, text };
}
const MODULEISH = /Cannot use import statement|Unexpected token 'export'|import\.meta|await is only valid|Illegal return|Unexpected reserved word|Cannot use 'import|Unexpected identifier 'as'|Unexpected token '\{'/;
const WRAP_PREFIX = '(async function(){';

function blankModuleSyntax(src) {
  const sp = m => m.replace(/[^\n]/g, ' ');
  let out = src;
  out = out.replace(/(^|[\n;{}])([ \t]*)(import\s*(?:[\w$*{][^;'"`]*?\sfrom\s*)?['"][^'"\n]+['"][ \t]*;?)/g, (m, a, b, c) => a + b + sp(c));
  out = out.replace(/(^|[\n;{}])([ \t]*)(export\s*\*\s*(?:as\s+[\w$]+\s*)?from\s*['"][^'"\n]+['"][ \t]*;?)/g, (m, a, b, c) => a + b + sp(c));
  out = out.replace(/(^|[\n;{}])([ \t]*)(export\s*\{[^}]*\}\s*(?:from\s*['"][^'"\n]+['"])?[ \t]*;?)/g, (m, a, b, c) => a + b + sp(c));
  out = out.replace(/(^|[\n;{}])([ \t]*)export\s+default\s+/g, (m, a, b) => a + b + '            ');
  out = out.replace(/(^|[\n;{}])([ \t]*)export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\b)/g, (m, a, b) => a + b + '       ');
  out = out.replace(/\bimport\.meta\b/g, '({}        )');
  return out;
}

const HINTS = [
  [/Unexpected end of input/, '코드가 중간에 끝났습니다 — 닫는 괄호 ) ] } 또는 따옴표/템플릿 문자열 누락을 확인하세요'],
  [/missing \) after argument list/, '함수 호출 인자 목록에서 ")" 가 빠졌거나 인자 사이 쉼표(,)가 없습니다'],
  [/Unexpected identifier/, '앞 문장 끝의 쉼표/세미콜론/연산자 누락, 오타, 또는 따옴표 없는 문자열일 수 있습니다'],
  [/Unexpected string/, '문자열 앞에 쉼표(,)나 연산자가 빠졌을 수 있습니다'],
  [/Unexpected number/, '숫자 앞에 쉼표(,)나 연산자가 빠졌을 수 있습니다'],
  [/Invalid or unexpected token/, '닫히지 않은 따옴표, 잘못된 문자(스마트 따옴표 ’ “ ”, 전각 문자) 또는 잘못된 이스케이프를 확인하세요'],
  [/Unexpected token '\}'/, '앞 문장이 끝나지 않았거나 불필요한 "}" 가 있습니다 (괄호 짝 확인)'],
  [/Unexpected token '\)'/, '불필요한 ")" 이거나 앞 식이 비어 있습니다 (예: f(a,) 대신 f(a))'],
  [/Unexpected token/, '해당 위치의 토큰이 문법상 올 수 없습니다. 바로 앞 줄의 누락(쉼표·괄호·세미콜론)도 확인하세요'],
  [/has already been declared/, '같은 스코프에서 let/const/class 이름이 중복 선언되었습니다 — 이름을 바꾸거나 선언을 하나로 합치세요'],
  [/Missing initializer in const/, 'const 는 선언과 동시에 값을 대입해야 합니다 (또는 let 사용)'],
  [/Assignment to constant variable/, 'const 변수에는 재대입할 수 없습니다'],
  [/Invalid left-hand side in assignment/, '대입 왼쪽에 변수/프로퍼티가 와야 합니다 (== 로 쓰려던 것은 아닌지 확인)'],
  [/await is only valid/, 'await 는 async 함수 안(또는 모듈 최상위)에서만 쓸 수 있습니다 — 함수에 async 를 붙이세요'],
  [/Unexpected reserved word/, '예약어(await/yield/let 등)를 잘못된 위치에서 사용했습니다'],
  [/Illegal return/, '함수 밖에서 return 을 사용했습니다'],
  [/Illegal break|Illegal continue/, 'break/continue 가 반복문·switch 밖에 있습니다'],
  [/Unexpected token 'else'/, 'if 없이 else 가 왔습니다 — 앞의 중괄호 짝을 확인하세요'],
  [/Unexpected eval or arguments in strict mode/, 'strict 모드에서 eval/arguments 는 변수 이름으로 쓸 수 없습니다'],
  [/Duplicate parameter name/, '함수 매개변수 이름이 중복되었습니다'],
  [/Rest parameter must be last/, '나머지 매개변수(...rest)는 마지막에만 올 수 있습니다'],
  [/Invalid regular expression/, '정규식 문법이 잘못되었습니다 (괄호·이스케이프·플래그 확인)'],
  [/Unterminated template/, '템플릿 문자열(`)이 닫히지 않았습니다'],
  [/Unexpected template string/, '템플릿 문자열 앞에 연산자/쉼표가 빠졌습니다'],
  [/Private field/, 'private 필드(#x)는 클래스 본문 안에서 먼저 선언해야 합니다'],
  [/Class constructor .* cannot be invoked without 'new'/, 'class 는 new 로 호출해야 합니다']
];
const hintFor = msg => { for (const [re, h] of HINTS) if (re.test(msg)) return h; return null; };

function codeFrame(src, line, col, ctxLines = 2) {
  if (!line) return null;
  const lines = src.split('\n');
  const from = Math.max(1, line - ctxLines), to = Math.min(lines.length, line + ctxLines);
  const w = String(to).length;
  const out = [];
  for (let i = from; i <= to; i++) {
    out.push(`${i === line ? '>' : ' '} ${String(i).padStart(w)} | ${lines[i - 1].slice(0, 160)}`);
    if (i === line && col) out.push(`  ${' '.repeat(w)} | ${' '.repeat(Math.max(0, Math.min(col, 160) - 1))}^`);
  }
  return out.join('\n');
}

/** JS 문법 검사. 성공: {ok:true, module?}, 실패: {ok:false, message, line, col, hint, frame} */
function checkSyntax(src) {
  const e1 = compileCheck(src);
  if (!e1) return { ok: true };
  if (MODULEISH.test(e1.message) || /import|export/.test(e1.message)) {
    const wrapped = WRAP_PREFIX + blankModuleSyntax(src) + '\n})';
    const e2 = compileCheck(wrapped);
    if (!e2) return { ok: true, module: true };
    const d = describeV8(e2, WRAP_PREFIX.length);
    return { ok: false, ...d, hint: hintFor(d.message), frame: codeFrame(src, d.line, d.col) };
  }
  const d = describeV8(e1);
  return { ok: false, ...d, hint: hintFor(d.message), frame: codeFrame(src, d.line, d.col) };
}

// ---------------------------------------------------------------------------
// AST 유틸
// ---------------------------------------------------------------------------
function walk(node, fn) {
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
  if (fn(node) === false) return;
  for (const k of Object.keys(node)) {
    if (k === 'type') continue;
    const v = node[k];
    if (!v || typeof v !== 'object') continue;
    if (Array.isArray(v)) { for (const x of v) if (x && typeof x === 'object') walk(x, fn); }
    else walk(v, fn);
  }
}
const isFn = n => n.type === 'FuncDecl' || n.type === 'FuncExpr' || n.type === 'Arrow';
const isLoop = n => n.type === 'For' || n.type === 'ForIn' || n.type === 'ForOf' || n.type === 'While' || n.type === 'DoWhile';

function hasValueReturn(fn) {
  let found = false;
  walk(fn.body, n => {
    if (found) return false;
    if (isFn(n)) return false;
    if (n.type === 'Return' && n.arg) found = true;
    return true;
  });
  return found;
}
function containsExit(body) {
  let found = false;
  walk(body, n => {
    if (found) return false;
    if (isFn(n)) return false;
    if (n.type === 'Break' || n.type === 'Return' || n.type === 'Throw') found = true;
    if (n.type === 'Call' && n.callee.type === 'Member' && n.callee.obj.type === 'Id' && n.callee.obj.name === 'process' && n.callee.prop === 'exit') found = true;
    if (n.type === 'Await' || n.type === 'Yield') found = true;   // 비동기 양보가 있으면 무한 루프로 단정하지 않는다
    return true;
  });
  return found;
}

// 함수 지표: 순환 복잡도, 중첩, 반복 깊이, 재귀
function fnMetrics(fn, name, lineOf) {
  let cyclomatic = 1, loopDepth = 0, maxNest = 0, selfCalls = 0, hasAwait = false, hiddenLinear = 0, sortCalls = 0, statements = 0;
  const visit = (n, nest, loops) => {
    if (!n || typeof n !== 'object' || typeof n.type !== 'string') return;
    if (isFn(n) && n !== fn) {
      // 중첩 함수(콜백)는 호출 횟수를 알 수 없으므로 반복 깊이는 호출 지점에서 이미 반영했다
      inner(n, nest, loops); return;
    }
    switch (n.type) {
      case 'If': case 'Cond': cyclomatic++; break;
      case 'For': case 'ForIn': case 'ForOf': case 'While': case 'DoWhile': cyclomatic++; break;
      case 'Case': if (n.test) cyclomatic++; break;
      case 'Try': if (n.handler) cyclomatic++; break;
      case 'Logical': cyclomatic++; break;
      case 'Await': hasAwait = true; break;
      default: break;
    }
    if (/Stmt$|^(If|For|ForIn|ForOf|While|DoWhile|Return|Throw|Try|Switch|VarDecl)$/.test(n.type)) statements++;
    let nextNest = nest, nextLoops = loops;
    const controlling = ['If', 'For', 'ForIn', 'ForOf', 'While', 'DoWhile', 'Switch', 'Try'].includes(n.type);
    if (controlling) { nextNest = nest + 1; maxNest = Math.max(maxNest, nextNest); }
    if (isLoop(n)) { nextLoops = loops + 1; loopDepth = Math.max(loopDepth, nextLoops); }
    if (n.type === 'Call') {
      const c = n.callee;
      if (name && c.type === 'Id' && c.name === name) selfCalls++;
      if (c.type === 'Member' && !c.computed) {
        if (LOOPY_METHODS.has(c.prop) && n.args.some(a => isFn(a))) {
          // 콜백 안은 한 단계 더 깊은 반복으로 센다
          if (c.prop === 'sort' || c.prop === 'toSorted') sortCalls++;
          for (const a of n.args) {
            if (isFn(a)) { const d = loops + 1; loopDepth = Math.max(loopDepth, d); inner(a, nest, loops + 1); } else visit(a, nest, loops);
          }
          visit(c.obj, nest, loops);
          return;
        }
        if (LINEAR_METHODS.has(c.prop) && loops > 0) hiddenLinear++;
      }
    }
    for (const k of Object.keys(n)) {
      if (k === 'type') continue;
      const v = n[k];
      if (!v || typeof v !== 'object') continue;
      if (Array.isArray(v)) { for (const x of v) if (x && typeof x === 'object') visit(x, nextNest, nextLoops); }
      else visit(v, nextNest, nextLoops);
    }
  };
  const inner = (f, nest, loops) => {
    for (const p of f.params) visit(p, nest, loops);
    visit(f.body, nest, loops);
  };
  inner(fn, 0, 0);
  const endLine = lineOf(fn.end || fn.pos);
  return { name: name || '(anonymous)', line: fn.line, lines: endLine - fn.line + 1, params: fn.params.length, cyclomatic, maxNesting: maxNest, loopDepth, recursive: selfCalls > 0, selfCalls, hiddenLinear, sortCalls, async: !!fn.async, hasAwait, statements };
}

function complexityLabel(m) {
  const k = m.loopDepth;
  let base = k === 0 ? 'O(1)' : k === 1 ? 'O(n)' : `O(n^${k})`;
  if (m.sortCalls && k <= 1) base = 'O(n log n)';
  if (m.hiddenLinear) base += ` (루프 안 선형 탐색 ${m.hiddenLinear}곳 → 한 차수 증가 가능)`;
  if (m.recursive) base += m.selfCalls >= 2 ? ' · 재귀 호출 2회 이상: 메모이제이션 없으면 지수 시간 위험' : ' · 재귀(깊이에 비례)';
  return base;
}

// ---------------------------------------------------------------------------
// 스코프
// ---------------------------------------------------------------------------
class Scope {
  constructor(kind, parent) {
    this.kind = kind; this.parent = parent; this.vars = new Map();
    this.fn = (kind === 'func' || kind === 'module') ? this : parent.fn;
  }
}

function buildGlobals(env, extra) {
  const g = new Set(ES_GLOBALS);
  if (env === 'node' || env === 'both') NODE_GLOBALS.forEach(x => g.add(x));
  if (env === 'browser' || env === 'both') BROWSER_GLOBALS.forEach(x => g.add(x));
  for (const x of extra || []) g.add(x);
  return g;
}
function inferEnv(src) {
  const node = /\brequire\s*\(|\bmodule\.exports\b|\bprocess\.(argv|env|exit|stdout|cwd)\b|\b__dirname\b|from\s+['"]node:|\bexports\./.test(src);
  const browser = /\bdocument\.|\bwindow\.|\bcanvas\b|\bgetContext\b|\blocalStorage\b|\bnavigator\.|\baddEventListener\b|\brequestAnimationFrame\b/.test(src);
  if (node && !browser) return 'node';
  if (browser && !node) return 'browser';
  return 'both';
}

// ---------------------------------------------------------------------------
// 핵심 분석
// ---------------------------------------------------------------------------
/**
 * @param {string} src
 * @param {{env?:string, extraGlobals?:string[], externalNames?:string[], ignoreUnusedTopLevel?:boolean, lineOffset?:number}} opts
 */
function analyzeJs(src, opts = {}) {
  const ast = parse(src);
  const env = opts.env && opts.env !== 'auto' ? opts.env : inferEnv(src);
  const GLOBALS = buildGlobals(env, opts.extraGlobals);
  const issues = [];
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1);
  const lineOf = pos => { let lo = 0, hi = lineStarts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1; } return lo + 1; };
  const add = (sev, rule, node, message, extra = {}) => issues.push({ sev, rule, line: node.line, col: node.col, message, ...extra });

  const isModule = ast.body.some(s => s.type === 'Import' || s.type === 'Export');
  const useStrict = ast.body.some(s => s.type === 'ExprStmt' && s.expr.type === 'Literal' && s.expr.value === 'use strict');
  const strict = isModule || useStrict;

  const ctx = { thisClass: null, hasEval: false, hasWith: false, curFn: null };
  const typeofNames = new Set();
  const unresolved = [];       // {name, node, call, scopeNames}
  const implicitWrites = new Map();
  const callRecords = [];      // 인자 개수 점검
  const memberChecks = [];     // 인스턴스/객체 리터럴 멤버 점검
  const memberWrites = new Map();   // binding → Set(prop) / '*' dynamic
  const allScopes = [];
  const classInfos = [];
  const memberUseCount = new Map();
  const definedProps = new Set();
  const requires = [];         // {source, kind, line, named:[], ns, binding}
  const exportInfo = { names: new Set(), unknown: false, callable: false, esm: false };
  const topLevelFns = new Set();
  const fnMetricsList = [];
  const externalNames = new Set(opts.externalNames || []);

  // ---- 사전 수집: 프로퍼티 이름 사용 횟수, 정의된 키 ----
  walk(ast, n => {
    if (n.type === 'Member' && n.isMember && !n.computed && typeof n.prop === 'string') memberUseCount.set(n.prop, (memberUseCount.get(n.prop) || 0) + 1);
    if (n.type === 'Prop' && n.key && !n.computed) definedProps.add(n.key.name);
    if (n.type === 'PatProp' && n.key && !n.computed) definedProps.add(n.key.name);
    if (n.type === 'Id') definedProps.add(n.name);
    if (n.type === 'Literal' && n.kind === 'str') definedProps.add(n.value);
    if (n.type === 'Template') n.quasis.forEach(q => { for (const w of q.split(/[^\w$]+/)) if (w) definedProps.add(w); });
    if (n.type === 'Call' && n.callee.type === 'Id' && n.callee.name === 'eval') ctx.hasEval = true;
    if (n.type === 'With') ctx.hasWith = true;
    if (n.type === 'Unary' && n.op === 'typeof' && n.arg.type === 'Id') typeofNames.add(n.arg.name);
    return true;
  });

  const moduleScope = new Scope('module', null);
  allScopes.push(moduleScope);

  // ---- 선언 ----
  function declare(scope, name, kind, node, extra = {}) {
    let b = scope.vars.get(name);
    if (b) {
      if (kind === 'function' && b.kind !== 'function') { b.kind = 'function'; }
      if (extra.fn && !b.fn) b.fn = extra.fn;
      if (extra.cls && !b.cls) b.cls = extra.cls;
      return b;
    }
    b = { name, kind, line: node.line, col: node.col, scope, reads: 0, writes: 0, updates: 0, declEnd: extra.declEnd || 0, fn: extra.fn || null, cls: extra.cls || null, exported: !!extra.exported, unusedExempt: !!extra.unusedExempt, isParam: kind === 'param', node };
    scope.vars.set(name, b);
    return b;
  }
  function declarePattern(scope, p, kind, extra = {}) {
    if (!p) return;
    switch (p.type) {
      case 'Id': declare(scope, p.name, kind, p, extra); break;
      case 'ArrayPattern': p.elements.forEach(e => declarePattern(scope, e, kind, extra)); break;
      case 'ObjectPattern': p.props.forEach(x => (x.type === 'Rest' ? declarePattern(scope, x.arg, kind, extra) : declarePattern(scope, x.value, kind, extra))); break;
      case 'AssignPattern': declarePattern(scope, p.left, kind, extra); break;
      case 'Rest': declarePattern(scope, p.arg, kind, extra); break;
      default: break;
    }
  }
  function hoistVars(stmt, fscope, exported) {
    if (!stmt) return;
    switch (stmt.type) {
      case 'VarDecl': if (stmt.kind === 'var') stmt.decls.forEach(d => declarePattern(fscope, d.id, 'var', { exported })); break;
      case 'If': hoistVars(stmt.cons, fscope); hoistVars(stmt.alt, fscope); break;
      case 'For': hoistVars(stmt.init, fscope); hoistVars(stmt.body, fscope); break;
      case 'ForIn': case 'ForOf': hoistVars(stmt.left, fscope); hoistVars(stmt.body, fscope); break;
      case 'While': case 'DoWhile': case 'Labeled': case 'With': hoistVars(stmt.body, fscope); break;
      case 'Block': stmt.body.forEach(s => hoistVars(s, fscope)); break;
      case 'Try': hoistVars(stmt.block, fscope); hoistVars(stmt.handler, fscope); hoistVars(stmt.finalizer, fscope); break;
      case 'Switch': stmt.cases.forEach(c => c.cons.forEach(s => hoistVars(s, fscope))); break;
      case 'Export': hoistVars(stmt.decl, fscope, true); break;
      default: break;
    }
  }
  function hoist(stmts, scope, fscope) {
    for (let s of stmts) {
      let exported = false;
      if (s.type === 'Export') {
        exported = true;
        if (s.specs) { continue; }
        if (!s.decl || !s.decl.type) continue;
        if (s.isDefault && !['FuncDecl', 'ClassDecl'].includes(s.decl.type)) continue;
        s = s.decl;
      }
      switch (s.type) {
        case 'VarDecl':
          if (s.kind !== 'var') s.decls.forEach(d => declarePattern(scope, d.id, s.kind, { declEnd: d.end, exported }));
          break;
        case 'ClassDecl': if (s.id) declare(scope, s.id.name, 'class', s.id, { declEnd: s.end, exported, cls: s }); break;
        case 'FuncDecl':
          if (s.id) {
            declare(scope, s.id.name, 'function', s.id, { fn: s, exported });
            if (scope !== fscope && !fscope.vars.has(s.id.name)) declare(fscope, s.id.name, 'function', s.id, { fn: s, unusedExempt: true });
            if (scope === moduleScope) topLevelFns.add(s.id.name);
          }
          break;
        case 'Import':
          s.specs.forEach(sp => declare(scope, sp.local, 'import', sp, { exported: false }));
          break;
        default: break;
      }
      hoistVars(s, fscope, exported);
    }
  }

  // ---- 참조 해석 ----
  function lookup(scope, name) {
    for (let s = scope; s; s = s.parent) { const b = s.vars.get(name); if (b) return b; }
    return null;
  }
  function visibleNames(scope) {
    const out = new Set();
    for (let s = scope; s; s = s.parent) for (const k of s.vars.keys()) out.add(k);
    return out;
  }
  function insideNonArrowFn(scope) {
    for (let s = scope; s; s = s.parent) if (s.kind === 'func' && !s.node.arrow) return true;
    return false;
  }
  function resolveRef(id, scope, { read = true, write = false, typeofSafe = false, call = false, update = false } = {}) {
    const name = id.name;
    const b = lookup(scope, name);
    if (b) {
      if (read) b.reads++;
      if (write) { b.writes++; if (update) b.updates++; }
      if (write && !id.decl) {
        if (b.kind === 'const') add('error', 'const-assign', id, `const 변수 '${name}' 에 재대입할 수 없습니다 (런타임 TypeError)`, { suggestion: `'${name}' 를 let 으로 선언하거나 재대입을 제거하세요` });
        else if (b.kind === 'import') add('error', 'import-assign', id, `import 한 '${name}' 에는 재대입할 수 없습니다`);
        else if (b.kind === 'class' && false) { /* 허용 */ }
      }
      if ((b.kind === 'let' || b.kind === 'const' || b.kind === 'class') && b.declEnd && id.pos < b.declEnd && scope.fn === b.scope.fn && !typeofSafe) {
        add('error', 'use-before-define', id, `'${name}' 을(를) 선언(${b.line}줄)보다 먼저 사용했습니다 (TDZ: Cannot access '${name}' before initialization)`, { suggestion: `선언을 ${id.line}줄 위로 옮기거나 사용 위치를 선언 뒤로 옮기세요` });
      }
      return b;
    }
    if (name === 'arguments' && insideNonArrowFn(scope)) return null;
    if (GLOBALS.has(name)) return null;
    if (externalNames.has(name)) return null;
    if (typeofSafe) return null;
    unresolved.push({ name, node: id, call, write, read, names: visibleNames(scope) });
    return null;
  }

  // ---- 방문자 ----
  function visitStatements(stmts, scope) {
    let dead = false, reported = false;
    for (const s of stmts) {
      if (dead && !reported && s.type !== 'Empty' && s.type !== 'FuncDecl' && !(s.type === 'VarDecl' && s.kind === 'var' && s.decls.every(d => !d.init))) {
        add('warning', 'unreachable', s, 'return/throw/break/continue 뒤에 있어 실행되지 않는 코드입니다', { suggestion: '해당 코드를 앞으로 옮기거나 삭제하세요' });
        reported = true;
      }
      visitStmt(s, scope);
      if (isTerminal(s)) dead = true;
    }
  }
  function isTerminal(s) {
    switch (s.type) {
      case 'Return': case 'Throw': case 'Break': case 'Continue': return true;
      case 'Block': return s.body.length > 0 && isTerminal(s.body[s.body.length - 1]);
      case 'If': return !!s.alt && isTerminal(s.cons) && isTerminal(s.alt);
      default: return false;
    }
  }
  function checkCondition(test) {
    if (test && test.type === 'Assign' && test.op === '=' && !test.paren) {
      add('warning', 'assign-in-condition', test, '조건식 안에서 대입(=)을 사용했습니다. 비교(===)를 의도했다면 오타입니다', { suggestion: '비교는 === 를 쓰고, 의도한 대입이면 괄호로 한 번 더 감싸세요' });
    }
  }
  function newBlock(scope) { const s = new Scope('block', scope); allScopes.push(s); return s; }

  function visitStmt(s, scope) {
    switch (s.type) {
      case 'Block': { const bs = newBlock(scope); hoist(s.body, bs, scope.fn); visitStatements(s.body, bs); break; }
      case 'VarDecl': visitVarDecl(s, scope); break;
      case 'FuncDecl': visitFunction(s, scope); break;
      case 'ClassDecl': visitClass(s, scope); break;
      case 'If': visitExpr(s.test, scope); checkCondition(s.test); visitStmt(s.cons, scope); if (s.alt) visitStmt(s.alt, scope); break;
      case 'For': {
        const fs = newBlock(scope);
        if (s.init && s.init.type === 'VarDecl' && s.init.kind !== 'var') s.init.decls.forEach(d => declarePattern(fs, d.id, s.init.kind, { declEnd: d.end }));
        if (s.init) { if (s.init.type === 'VarDecl') visitVarDecl(s.init, fs); else visitExpr(s.init, fs); }
        if (s.test) { visitExpr(s.test, fs); checkCondition(s.test); checkOffByOne(s.test); }
        if (s.update) visitExpr(s.update, fs);
        checkInfiniteLoop(s, !s.test);
        visitStmt(s.body, fs);
        break;
      }
      case 'ForIn': case 'ForOf': {
        const fs = newBlock(scope);
        if (s.left.type === 'VarDecl') {
          if (s.left.kind !== 'var') s.left.decls.forEach(d => declarePattern(fs, d.id, s.left.kind, { declEnd: d.end }));
          s.left.decls.forEach(d => { markInit(d.id, fs); visitPatternDefaults(d.id, fs); });
        } else visitTarget(s.left, fs, 'assign');
        visitExpr(s.right, scope);
        visitStmt(s.body, fs);
        break;
      }
      case 'While': visitExpr(s.test, scope); checkCondition(s.test); checkInfiniteLoop(s, s.test.type === 'Literal' && (s.test.value === 'true' || s.test.value === '1')); visitStmt(s.body, scope); break;
      case 'DoWhile': visitStmt(s.body, scope); visitExpr(s.test, scope); checkCondition(s.test); break;
      case 'Return': case 'Throw': if (s.arg) visitExpr(s.arg, scope); break;
      case 'Try': {
        visitStmt(s.block, scope);
        if (s.handler) {
          const cs = newBlock(scope);
          if (s.param) { declarePattern(cs, s.param, 'catch'); visitPatternDefaults(s.param, cs); }
          hoist(s.handler.body, cs, scope.fn);
          visitStatements(s.handler.body, cs);
          if (!s.handler.body.length) add('info', 'empty-catch', s.handler, '빈 catch 블록: 오류가 조용히 사라집니다', { suggestion: '최소한 console.error 로 기록하거나 의도를 주석으로 남기세요' });
        }
        if (s.finalizer) visitStmt(s.finalizer, scope);
        break;
      }
      case 'Switch': {
        visitExpr(s.disc, scope);
        const ss = newBlock(scope);
        hoist(s.cases.flatMap(c => c.cons), ss, scope.fn);
        const seen = new Set();
        for (const c of s.cases) {
          if (c.test) {
            visitExpr(c.test, ss);
            if (c.test.type === 'Literal') { const key = c.test.kind + ':' + c.test.value; if (seen.has(key)) add('warning', 'duplicate-case', c, `중복된 case 값 ${c.test.value}`); seen.add(key); }
          }
          visitStatements(c.cons, ss);
        }
        break;
      }
      case 'Labeled': visitStmt(s.body, scope); break;
      case 'With': visitExpr(s.obj, scope); visitStmt(s.body, scope); break;
      case 'ExprStmt': visitExpr(s.expr, scope, { stmt: true }); checkNoEffect(s); break;
      case 'Import': if (s.source) requires.push({ source: s.source, kind: 'import', line: s.line, named: s.specs.filter(x => x.imported !== '*' && x.imported !== 'default').map(x => ({ name: x.imported, line: x.line })), hasDefault: s.specs.some(x => x.imported === 'default'), ns: (s.specs.find(x => x.imported === '*') || {}).local || null }); break;
      case 'Export': visitExport(s, scope); break;
      default: break;
    }
  }
  function markInit(pattern, scope) {
    // for-in/of 의 선언 변수는 반복마다 값이 채워진다
    const names = [];
    (function collect(p) {
      if (!p) return;
      if (p.type === 'Id') names.push(p.name);
      else if (p.type === 'ArrayPattern') p.elements.forEach(collect);
      else if (p.type === 'ObjectPattern') p.props.forEach(x => collect(x.type === 'Rest' ? x.arg : x.value));
      else if (p.type === 'AssignPattern') collect(p.left);
      else if (p.type === 'Rest') collect(p.arg);
    })(pattern);
    for (const n of names) { const b = scope.vars.get(n); if (b) b.loopVar = true; }
  }
  function visitExport(s, scope) {
    exportInfo.esm = true;
    if (s.source) { if (s.all) exportInfo.unknown = true; else s.specs.forEach(sp => exportInfo.names.add(sp.exported)); return; }
    if (s.specs) {
      for (const sp of s.specs) {
        exportInfo.names.add(sp.exported);
        const b = lookup(scope, sp.local);
        if (b) { b.reads++; b.exported = true; } else unresolved.push({ name: sp.local, node: sp, call: false, write: false, read: true, names: visibleNames(scope) });
      }
      return;
    }
    if (s.isDefault) {
      exportInfo.names.add('default');
      if (s.decl.type === 'FuncDecl' || s.decl.type === 'ClassDecl') visitStmt(s.decl, scope); else visitExpr(s.decl, scope);
      return;
    }
    const d = s.decl;
    if (d.type === 'VarDecl') d.decls.forEach(x => collectNames(x.id).forEach(n => exportInfo.names.add(n)));
    else if (d.id) exportInfo.names.add(d.id.name);
    visitStmt(d, scope);
  }
  function collectNames(p, out = []) {
    if (!p) return out;
    if (p.type === 'Id') out.push(p.name);
    else if (p.type === 'ArrayPattern') p.elements.forEach(e => collectNames(e, out));
    else if (p.type === 'ObjectPattern') p.props.forEach(x => collectNames(x.type === 'Rest' ? x.arg : x.value, out));
    else if (p.type === 'AssignPattern') collectNames(p.left, out);
    else if (p.type === 'Rest') collectNames(p.arg, out);
    return out;
  }

  function visitVarDecl(s, scope) {
    for (const d of s.decls) {
      if (d.init) visitExpr(d.init, scope);
      visitPatternDefaults(d.id, scope);
      if (d.id.type === 'Id') {
        const b = lookup(scope, d.id.name);
        if (b && d.init) {
          const init = d.init;
          if ((init.type === 'FuncExpr' || init.type === 'Arrow') && !b.fn) b.fn = init;
          if (init.type === 'ClassExpr' && !b.cls) b.cls = init;
          if (s.kind === 'const' && init.type === 'Object' && init.props.every(p => p.kind !== 'spread' && !p.computed)) b.objLit = init;
          if (init.type === 'New' && init.callee.type === 'Id') { const cb = lookup(scope, init.callee.name); if (cb && cb.cls) b.instanceOf = cb; }
          if (init.type === 'Call' && init.callee.type === 'Id' && init.callee.name === 'fetch') b.promiseLike = true;
          if (init.type === 'Call' && init.callee.type === 'Id') { const fb = lookup(scope, init.callee.name); if (fb && fb.fn && fb.fn.async) b.promiseLike = true; }
          if (init.type === 'Call' && init.callee.type === 'Id' && init.callee.name === 'require' && init.args[0] && init.args[0].type === 'Literal' && init.args[0].kind === 'str') {
            const rec = { source: init.args[0].value, kind: 'require', line: init.line, named: [], hasDefault: true, ns: d.id.name, nsBinding: b };
            b.requireRec = rec; requires.push(rec);
          }
        }
      } else if (d.id.type === 'ObjectPattern' && d.init && d.init.type === 'Call' && d.init.callee.type === 'Id' && d.init.callee.name === 'require' && d.init.args[0] && d.init.args[0].type === 'Literal') {
        requires.push({ source: d.init.args[0].value, kind: 'require', line: d.init.line, named: d.id.props.filter(p => p.type === 'PatProp' && !p.computed).map(p => ({ name: p.key.name, line: p.line })), hasDefault: false, ns: null });
      }
    }
  }
  function visitPatternDefaults(p, scope) {
    if (!p) return;
    switch (p.type) {
      case 'ArrayPattern': p.elements.forEach(e => visitPatternDefaults(e, scope)); break;
      case 'ObjectPattern': p.props.forEach(x => { if (x.type === 'Rest') visitPatternDefaults(x.arg, scope); else { if (x.computed) visitExpr(x.key, scope); visitPatternDefaults(x.value, scope); } }); break;
      case 'AssignPattern': visitExpr(p.right, scope); visitPatternDefaults(p.left, scope); break;
      case 'Rest': visitPatternDefaults(p.arg, scope); break;
      default: break;
    }
  }

  function fnInfoOf(fn) {
    if (fn.info) return fn.info;
    let min = 0, sawOpt = false, rest = false;
    fn.params.forEach(p => { if (p.type === 'Rest') rest = true; else if (p.type === 'AssignPattern') sawOpt = true; else if (!sawOpt) min++; });
    fn.info = { min, max: rest ? Infinity : fn.params.length, names: fn.params.map(p => (p.type === 'Id' ? p.name : p.type === 'AssignPattern' && p.left.type === 'Id' ? p.left.name : null)), paramBindings: [], usesArguments: false };
    return fn.info;
  }

  function visitFunction(fn, scope, o = {}) {
    const fscope = new Scope('func', scope);
    fscope.node = fn;
    allScopes.push(fscope);
    if (fn.type === 'FuncExpr' && fn.id) declare(fscope, fn.id.name, 'funcname', fn.id, { unusedExempt: true });
    for (const p of fn.params) declarePattern(fscope, p, 'param');
    const info = fnInfoOf(fn);
    info.paramBindings = fn.params.map(p => (p.type === 'Id' ? fscope.vars.get(p.name) : p.type === 'AssignPattern' && p.left.type === 'Id' ? fscope.vars.get(p.left.name) : null));
    const bodyStmts = fn.expr ? [] : fn.body.body;
    hoist(bodyStmts, fscope, fscope);
    for (const p of fn.params) visitPatternDefaults(p, fscope);
    const saved = ctx.thisClass, savedFn = ctx.curFn;
    ctx.curFn = fn;
    if (!fn.arrow) ctx.thisClass = o.thisClass || null;
    if (fn.expr) visitExpr(fn.body, fscope); else visitStatements(bodyStmts, fscope);
    ctx.thisClass = saved; ctx.curFn = savedFn;
    if (!fn.arrow) {
      const argB = null; // arguments 사용 여부
      let usesArgs = false;
      walk(fn.body, n => { if (isFn(n) && !n.arrow) return false; if (n.type === 'Id' && n.name === 'arguments') usesArgs = true; return true; });
      if (usesArgs) info.max = Infinity;
      void argB;
    }
    const nm = fn.id ? fn.id.name : (o.name || null);
    const m = fnMetrics(fn, nm, lineOf);
    if (o.name && !fn.id) m.name = o.name;
    fnMetricsList.push(m);
  }

  function visitClass(c, scope) {
    const cs = new Scope('class', scope);
    allScopes.push(cs);
    if (c.id) declare(cs, c.id.name, 'classinner', c.id, { unusedExempt: true });
    if (c.superClass) visitExpr(c.superClass, scope);
    const info = { node: c, name: c.id ? c.id.name : '(anonymous)', members: new Set(), statics: new Set(), hasSuper: !!c.superClass, dynamic: false, ctorInfo: null, extra: new Set() };
    classInfos.push(info);
    c.cinfo = info;
    for (const m of c.members) {
      if (m.kind === 'static-block' || !m.key || m.computed) { if (m.computed) info.dynamic = true; continue; }
      (m.static ? info.statics : info.members).add(m.key.name);
      if (m.kind === 'constructor') info.ctorInfo = m.value;
    }
    walk(c, n => {
      if (n.type === 'Assign' && n.left.type === 'Member' && n.left.obj.type === 'This' && !n.left.computed) info.members.add(n.left.prop);
      if (n.type === 'Assign' && n.left.type === 'Member' && n.left.obj.type === 'This' && n.left.computed) info.dynamic = true;
      if (n.type === 'Call' && n.callee.type === 'Member' && n.callee.prop === 'assign' && n.args[0] && n.args[0].type === 'This') info.dynamic = true;
      return true;
    });
    if (c.superClass && info.ctorInfo) {
      let callsSuper = false;
      walk(info.ctorInfo.body, n => { if (isFn(n) && !n.arrow) return false; if (n.type === 'Call' && n.callee.type === 'Super') callsSuper = true; return true; });
      if (!callsSuper) add('error', 'missing-super', info.ctorInfo, `자식 클래스 '${info.name}' 의 constructor 에서 super() 를 호출하지 않았습니다 (ReferenceError: Must call super constructor)`, { suggestion: 'constructor 첫 줄(this 사용 전)에 super(...) 를 추가하세요' });
    }
    for (const m of c.members) {
      if (m.kind === 'static-block') { const bs = newBlock(cs); hoist(m.body.body, bs, bs.fn); visitStatements(m.body.body, bs); continue; }
      if (m.computed && m.key) visitExpr(m.key, cs);
      if (m.value) visitFunction(m.value, cs, { thisClass: m.static ? null : info, name: m.key ? `${info.name}.${m.key.name}` : null });
      else if (m.init) {
        const fs = new Scope('func', cs); fs.node = { arrow: false, params: [] }; allScopes.push(fs);
        const saved = ctx.thisClass; ctx.thisClass = m.static ? null : info;
        visitExpr(m.init, fs);
        ctx.thisClass = saved;
      }
    }
  }

  function visitTarget(t, scope, mode) {
    switch (t.type) {
      case 'Id': resolveRef(t, scope, { read: mode !== 'assign', write: true, update: mode === 'update' }); break;
      case 'Member': {
        visitExpr(t.obj, scope);
        if (t.computed) visitExpr(t.prop, scope);
        recordMemberWrite(t);
        break;
      }
      case 'Object':
        for (const p of t.props) {
          if (p.kind === 'spread') visitTarget(p.value, scope, 'assign');
          else { if (p.computed) visitExpr(p.key, scope); visitTarget(p.value, scope, 'assign'); }
        }
        break;
      case 'Array': t.elements.forEach(e => e && visitTarget(e.type === 'Spread' ? e.arg : e, scope, 'assign')); break;
      case 'Assign': visitTarget(t.left, scope, 'assign'); visitExpr(t.right, scope); break;
      case 'AssignPattern': visitTarget(t.left, scope, 'assign'); visitExpr(t.right, scope); break;
      default: visitExpr(t, scope);
    }
  }
  function recordMemberWrite(m) {
    if (m.obj.type === 'Id') {
      const b = lookup(allScopes[0], m.obj.name) || null;
      const key = m.obj.name;
      if (!memberWrites.has(key)) memberWrites.set(key, new Set());
      memberWrites.get(key).add(m.computed ? '*' : m.prop);
      void b;
    }
    // Foo.prototype.x = ...
    if (m.obj.type === 'Member' && !m.obj.computed && m.obj.prop === 'prototype' && m.obj.obj.type === 'Id' && !m.computed) {
      const key = m.obj.obj.name + '.prototype';
      if (!memberWrites.has(key)) memberWrites.set(key, new Set());
      memberWrites.get(key).add(m.prop);
    }
    // module.exports / exports
    if (m.obj.type === 'Id' && m.obj.name === 'exports' && !m.computed) { exportInfo.names.add(m.prop); }
    if (m.obj.type === 'Member' && m.obj.obj.type === 'Id' && m.obj.obj.name === 'module' && m.obj.prop === 'exports' && !m.computed) exportInfo.names.add(m.prop);
  }

  function checkOffByOne(test) {
    if (test && test.type === 'Binary' && test.op === '<=' && test.right.type === 'Member' && !test.right.computed && test.right.prop === 'length') {
      add('warning', 'off-by-one', test, `'<= ${src.slice(test.right.pos, test.right.end)}' : 마지막 반복에서 인덱스가 범위를 벗어납니다 (undefined 접근)`, { suggestion: "'<' 로 바꾸세요" });
    }
  }
  function checkInfiniteLoop(loop, constantTrue) {
    if (constantTrue && !containsExit(loop.body)) add('warning', 'infinite-loop', loop, '탈출 조건(break/return/throw)이 없는 무한 루프로 보입니다', { suggestion: '종료 조건을 추가하세요' });
  }
  function checkNoEffect(s) {
    const e = s.expr;
    const noEffect = e.type === 'Binary' || e.type === 'Id' || (e.type === 'Member' && e.isMember && !e.optional) ||
      (e.type === 'Literal' && !(e.kind === 'str')) || (e.type === 'Array' ) || (e.type === 'Object' && !e.paren);
    if (noEffect && e.type !== 'Object') {
      add('warning', 'no-effect', s, '결과를 사용하지 않는 식입니다 (대입·호출을 의도했는데 비교/조회만 하고 있지 않은지 확인)', { suggestion: e.type === 'Binary' && (e.op === '==' || e.op === '===') ? "비교(==)가 아니라 대입(=)이 필요했을 수 있습니다" : undefined });
    }
  }

  function visitArgs(args, scope) { for (const a of args) visitExpr(a.type === 'Spread' ? a.arg : a, scope); }

  function visitExpr(e, scope, o = {}) {
    if (!e) return;
    switch (e.type) {
      case 'Id': resolveRef(e, scope, { read: true }); break;
      case 'Literal': case 'This': case 'Super': case 'Meta': case 'PrivName': break;
      case 'Template': e.exprs.forEach(x => visitExpr(x, scope)); break;
      case 'Array': e.elements.forEach(x => x && visitExpr(x.type === 'Spread' ? x.arg : x, scope)); break;
      case 'Object': {
        const keys = new Set();
        for (const p of e.props) {
          if (p.kind === 'spread') { visitExpr(p.value, scope); continue; }
          if (p.computed) visitExpr(p.key, scope);
          else if (p.kind !== 'get' && p.kind !== 'set') {
            if (keys.has(p.key.name)) add('warning', 'duplicate-key', p, `객체 리터럴에 중복된 키 '${p.key.name}' (뒤의 값이 앞의 값을 덮어씁니다)`);
            keys.add(p.key.name);
          }
          if (p.kind === 'method' || p.kind === 'get' || p.kind === 'set') visitFunction(p.value, scope, { thisClass: null, name: p.key && p.key.name });
          else if (p.kind === 'shorthand') { if (p.value.type === 'AssignPattern') { visitExpr(p.value.left, scope); visitExpr(p.value.right, scope); } else visitExpr(p.value, scope); }
          else visitExpr(p.value, scope);
        }
        break;
      }
      case 'FuncExpr': case 'Arrow': visitFunction(e, scope, { name: o.name }); break;
      case 'FuncDecl': visitFunction(e, scope); break;
      case 'ClassExpr': visitClass(e, scope); break;
      case 'Unary':
        if (e.op === 'typeof' && e.arg.type === 'Id') resolveRef(e.arg, scope, { read: true, typeofSafe: true });
        else visitExpr(e.arg, scope);
        break;
      case 'Update': visitTarget(e.arg, scope, 'update'); break;
      case 'Binary': case 'Logical': visitExpr(e.left, scope); visitExpr(e.right, scope); checkBinary(e, scope); break;
      case 'Assign': {
        if (e.op === '=' ) {
          visitTarget(e.left, scope, 'assign');
          visitAssignRhs(e, scope);
        } else { visitTarget(e.left, scope, 'compound'); visitExpr(e.right, scope); }
        break;
      }
      case 'Cond': visitExpr(e.test, scope); checkCondition(e.test); visitExpr(e.cons, scope); visitExpr(e.alt, scope); break;
      case 'Seq': e.exprs.forEach(x => visitExpr(x, scope)); break;
      case 'Call': visitCall(e, scope, o); break;
      case 'New': visitNew(e, scope); break;
      case 'Member': visitMember(e, scope); break;
      case 'Tagged': visitExpr(e.tag, scope); visitExpr(e.quasi, scope); break;
      case 'Await': visitExpr(e.arg, scope); break;
      case 'Yield': if (e.arg) visitExpr(e.arg, scope); break;
      case 'Spread': visitExpr(e.arg, scope); break;
      case 'ImportCall': visitArgs(e.args, scope); break;
      case 'AssignPattern': visitExpr(e.left, scope); visitExpr(e.right, scope); break;
      default: break;
    }
  }
  function visitAssignRhs(e, scope) {
    // module.exports = ...
    const l = e.left;
    if (l.type === 'Member' && !l.computed && l.obj.type === 'Id' && l.obj.name === 'module' && l.prop === 'exports') {
      const r = e.right;
      if (r.type === 'Object') {
        for (const p of r.props) { if (p.kind === 'spread') exportInfo.unknown = true; else if (p.computed) exportInfo.unknown = true; else exportInfo.names.add(p.key.name); }
      } else { exportInfo.unknown = true; exportInfo.callable = true; }
    }
    visitExpr(e.right, scope, { name: l.type === 'Id' ? l.name : (l.type === 'Member' && !l.computed ? l.prop : undefined) });
  }

  function checkBinary(e, scope) {
    const eq = e.op === '==' || e.op === '===' || e.op === '!=' || e.op === '!==';
    const isNaNNode = n => (n.type === 'Id' && n.name === 'NaN') || (n.type === 'Member' && !n.computed && n.prop === 'NaN' && n.obj.type === 'Id' && n.obj.name === 'Number');
    if (eq && (isNaNNode(e.left) || isNaNNode(e.right))) {
      add('error', 'nan-compare', e, 'NaN 은 자기 자신과도 같지 않으므로 ===/== 로 비교하면 항상 false(!== 는 항상 true)입니다', { suggestion: 'Number.isNaN(값) 을 사용하세요' });
    }
    if (eq) {
      const t = e.left.type === 'Unary' && e.left.op === 'typeof' ? e.right : (e.right.type === 'Unary' && e.right.op === 'typeof' ? e.left : null);
      if (t && t.type === 'Literal' && t.kind === 'str' && !VALID_TYPEOF.has(t.value)) {
        const sug = closest(t.value, [...VALID_TYPEOF]);
        add('error', 'invalid-typeof', t, `typeof 비교 문자열 '${t.value}' 은(는) 유효하지 않습니다 (항상 false)`, { suggestion: sug ? `'${sug}' 의 오타?` : `유효한 값: ${[...VALID_TYPEOF].join(', ')}` });
      }
      if (e.left.type === 'Id' && e.right.type === 'Id' && e.left.name === e.right.name && (e.op === '===' || e.op === '==')) {
        add('warning', 'self-compare', e, `같은 변수 '${e.left.name}' 끼리 비교합니다 (항상 true)`);
      }
      if ((e.op === '==' || e.op === '!=') && !(e.left.type === 'Literal' && e.left.kind === 'null') && !(e.right.type === 'Literal' && e.right.kind === 'null')) {
        add('info', 'loose-equality', e, `느슨한 비교(${e.op}) 사용: 타입 변환으로 예상 밖 결과가 나올 수 있습니다`, { suggestion: `${e.op}= 사용 권장`, fix: { pos: e.opPos, end: e.opEnd, text: e.op + '=' } });
      }
    }
    void scope;
  }

  function visitMember(e, scope) {
    visitExpr(e.obj, scope);
    if (e.computed) {
      visitExpr(e.prop, scope);
      // arr[arr.length]
      if (e.obj.type === 'Id' && e.prop.type === 'Member' && !e.prop.computed && e.prop.prop === 'length' && e.prop.obj.type === 'Id' && e.prop.obj.name === e.obj.name) {
        add('warning', 'index-out-of-range', e, `${e.obj.name}[${e.obj.name}.length] 는 항상 undefined 입니다 (마지막 요소는 length - 1)`, { suggestion: `${e.obj.name}[${e.obj.name}.length - 1]` });
      }
      return;
    }
    const prop = e.prop;
    if (typeof prop !== 'string') return;
    // Promise 에 await 없이 바로 접근
    if (e.obj.type === 'Id') {
      const b = lookup(scope, e.obj.name);
      if (b && b.promiseLike && !['then', 'catch', 'finally'].includes(prop)) {
        add('warning', 'missing-await', e, `'${e.obj.name}' 은(는) await 없이 받은 Promise 인데 '.${prop}' 에 바로 접근합니다`, { suggestion: `대입문에 await 를 붙이세요 (const ${e.obj.name} = await ...)` });
      }
      if (b && b.requireRec) b.requireRec.members = (b.requireRec.members || []).concat({ name: prop, line: e.propLine || e.line });
      if (b && (b.instanceOf || b.objLit)) memberChecks.push({ binding: b, prop, node: e, call: false });
      // 내장 네임스페이스
      if (!b && NAMESPACE_OBJS[e.obj.name] && GLOBALS.has(e.obj.name)) {
        const ns = NAMESPACE_OBJS[e.obj.name];
        if (!(prop in ns) && !(typeof ns === 'function' && ns.prototype && prop in ns.prototype && false)) {
          const sug = closest(prop, Object.getOwnPropertyNames(ns));
          add('error', 'undefined-member', { line: e.propLine || e.line, col: e.propCol || e.col }, `'${e.obj.name}.${prop}' 은(는) 존재하지 않습니다`, { suggestion: sug ? `'${e.obj.name}.${sug}' 의 오타?` : undefined, fix: sug && e.propPos != null ? undefined : undefined, replaceProp: sug ? { line: e.propLine, col: e.propCol, from: prop, to: sug } : undefined });
        }
      } else if (!b && e.obj.name === 'console' && GLOBALS.has('console') && !CONSOLE_MEMBERS.has(prop)) {
        const sug = closest(prop, [...CONSOLE_MEMBERS]);
        add('error', 'undefined-member', { line: e.propLine || e.line, col: e.propCol || e.col }, `'console.${prop}' 은(는) 존재하지 않습니다`, { suggestion: sug ? `'console.${sug}' 의 오타?` : undefined, replaceProp: sug ? { line: e.propLine, col: e.propCol, from: prop, to: sug } : undefined });
      } else if (!b && e.obj.name === 'document' && GLOBALS.has('document') && !KNOWN_MEMBERS.has(prop) && !DOCUMENT_MEMBERS.has(prop) && !definedProps.has(prop)) {
        const sug = closest(prop, [...DOCUMENT_MEMBERS]);
        if (sug) add('error', 'undefined-member', { line: e.propLine || e.line, col: e.propCol || e.col }, `'document.${prop}' 은(는) 존재하지 않습니다`, { suggestion: `'document.${sug}' 의 오타?`, replaceProp: { line: e.propLine, col: e.propCol, from: prop, to: sug } });
      }
    }
    // this.x 점검은 호출 쪽에서 처리, 여기서는 프로퍼티 오타(일반)
    if (e.obj.type === 'This' && ctx.thisClass && !ctx.thisClass.hasSuper && !ctx.thisClass.dynamic) {
      if (!ctx.thisClass.members.has(prop) && !OBJECT_PROTO.has(prop) && !e._isCallee) {
        const extra = memberWrites.get(ctx.thisClass.name + '.prototype');
        if (!(extra && extra.has(prop))) memberChecks.push({ cls: ctx.thisClass, prop, node: e, call: false, thisAccess: true });
      }
    }
    genericTypo(e, prop, false);
  }
  const COMMON_PROPS = ['length', 'innerHTML', 'outerHTML', 'innerText', 'textContent', 'className', 'classList', 'children', 'parentNode', 'parentElement', 'nextSibling', 'firstChild', 'lastChild', 'offsetWidth', 'offsetHeight', 'clientWidth', 'clientHeight', 'scrollTop', 'scrollHeight', 'style', 'dataset', 'prototype', 'constructor'];
  function genericTypo(e, prop, isCall) {
    if (KNOWN_MEMBERS.has(prop) || definedProps.has(prop) || prop.startsWith('#')) return;
    if ((memberUseCount.get(prop) || 0) > 1) return;
    if (prop.length < 5) return;
    const pool = isCall ? PROTO_MEMBERS : COMMON_PROPS;
    let sug = null, bd = 99;
    const pl = prop.toLowerCase();
    for (const c of pool) {
      if (c.length < 5 || c[0].toLowerCase() !== pl[0]) continue;
      if (pl === c.toLowerCase()) { sug = c; bd = 0; break; }
      const d = editDistance(prop, c, 2);
      const lim = prop.length >= 9 ? 2 : (prop.length >= 6 ? 1 : 0);
      const trans = prop.length === 5 && d === 1 && [...prop].sort().join('') === [...c].sort().join('');
      if ((d <= lim || trans) && d < bd) { sug = c; bd = d; }
    }
    if (sug) add('warning', 'member-typo', { line: e.propLine || e.line, col: e.propCol || e.col }, `'.${prop}${isCall ? '()' : ''}' 은(는) 정의되지 않은 ${isCall ? '메서드' : '프로퍼티'}입니다`, { suggestion: `'${sug}' 의 오타?`, replaceProp: { line: e.propLine, col: e.propCol, from: prop, to: sug } });
  }

  function visitCall(e, scope, o) {
    const c = e.callee;
    // 호출 대상 방문 (Id 는 call 표시)
    if (c.type === 'Id') {
      if (c.name === 'require' && !lookup(scope, 'require')) { /* CJS require */ }
      const b = resolveRef(c, scope, { read: true, call: true });
      if (b) {
        if (b.kind === 'class' && b.cls) add('error', 'class-call-without-new', e, `class '${c.name}' 은(는) new 없이 호출할 수 없습니다 (TypeError)`, { suggestion: `new ${c.name}(...)` });
        if (b.fn || b.cls) callRecords.push({ binding: b, node: e, nargs: e.args.length, spread: e.args.some(a => a.type === 'Spread'), isNew: false });
        if (b.fn && b.fn.async && o.stmt && !(e.optional) && ctx.curFn && ctx.curFn.async) add('warning', 'missing-await', e, `async 함수 '${c.name}()' 의 결과(Promise)를 기다리지 않고 버립니다 — 오류가 조용히 사라지고 순서가 보장되지 않습니다`, { suggestion: `await ${c.name}(...) 또는 .catch() 처리` });
        if (b.kind === 'const' && b.objLit) add('error', 'not-a-function', e, `'${c.name}' 은(는) 객체인데 함수처럼 호출하고 있습니다`);
      }
      if (c.name === 'parseInt' && e.args.length === 1 && !b) {
        const a0 = e.args[0];
        add('info', 'parseint-radix', e, 'parseInt 에 진법(radix)을 지정하지 않았습니다', { suggestion: 'parseInt(값, 10)', fix: { pos: a0.end, end: a0.end, text: ', 10' } });
      }
      if ((c.name === 'setTimeout' || c.name === 'setInterval') && !b && e.args[0] && e.args[0].type === 'Literal' && e.args[0].kind === 'str') add('warning', 'string-timer', e, `${c.name} 에 문자열을 넘기면 eval 처럼 동작합니다`, { suggestion: '함수를 넘기세요' });
      if ((c.name === 'setTimeout' || c.name === 'setInterval') && !b && e.args[0] && e.args[0].type === 'Call' && e.args[0].callee.type !== 'Member' ) add('warning', 'timer-immediate-call', e, `${c.name}(${e.args[0].callee.name || 'fn'}(...), ...) : 함수를 넘기지 않고 즉시 호출한 결과를 넘기고 있습니다`, { suggestion: `() => ${src.slice(e.args[0].pos, e.args[0].end)}` });
    } else if (c.type === 'Member') {
      c._isCallee = true;
      visitCallee(c, e, scope);
    } else visitExpr(c, scope);
    visitArgs(e.args, scope);

    // 콜백이 값을 반환하지 않는 HOF
    if (c.type === 'Member' && !c.computed && HOF_CALLBACK.has(c.prop) && e.args[0] && (e.args[0].type === 'Arrow' || e.args[0].type === 'FuncExpr')) {
      const f = e.args[0];
      if (!f.expr && !hasValueReturn(f) && !f.gen) {
        add('warning', 'callback-no-return', f, `.${c.prop}() 콜백이 값을 반환하지 않습니다 (결과가 전부 undefined/falsy)`, { suggestion: '화살표 함수에 중괄호가 있으면 return 이 필요합니다 (또는 중괄호 제거)' });
      }
    }
    if (c.type === 'Member' && !c.computed && c.prop === 'forEach' && e.args[0] && isFn(e.args[0]) && e.args[0].async) {
      add('warning', 'async-foreach', e, 'forEach 는 async 콜백을 기다리지 않습니다', { suggestion: 'for...of + await 또는 Promise.all(arr.map(async ...)) 사용' });
    }
    if (c.type === 'Member' && !c.computed && c.prop === 'length') add('error', 'length-call', e, "'.length' 는 속성이지 함수가 아닙니다 — length() 호출은 TypeError 입니다", { suggestion: '괄호를 제거하세요: .length' });
    // fetch(...).json()
    if (c.type === 'Member' && !c.computed && ['json', 'text', 'blob', 'arrayBuffer'].includes(c.prop) && c.obj.type === 'Call' && c.obj.callee.type === 'Id' && c.obj.callee.name === 'fetch') {
      add('error', 'missing-await', e, `fetch(...).${c.prop}() : fetch 는 Promise 를 반환하므로 먼저 await 해야 합니다`, { suggestion: `(await fetch(...)).${c.prop}()` });
    }
  }
  function visitCallee(c, call, scope) {
    // this.method() 점검
    visitExpr(c.obj, scope);
    if (c.computed) { visitExpr(c.prop, scope); return; }
    const prop = c.prop;
    if (c.obj.type === 'This' && ctx.thisClass && !ctx.thisClass.hasSuper && !ctx.thisClass.dynamic && typeof prop === 'string') {
      if (!ctx.thisClass.members.has(prop) && !OBJECT_PROTO.has(prop)) memberChecks.push({ cls: ctx.thisClass, prop, node: c, call: true, thisAccess: true });
    }
    if (c.obj.type === 'Id' && typeof prop === 'string') {
      const b = lookup(scope, c.obj.name);
      if (b && b.requireRec) b.requireRec.members = (b.requireRec.members || []).concat({ name: prop, line: c.propLine || c.line, call: true });
      if (b && (b.instanceOf || b.objLit)) memberChecks.push({ binding: b, prop, node: c, call: true });
    }
    memberLikeChecks(c, scope);
  }
  function memberLikeChecks(e, scope) {
    const prop = e.prop;
    if (typeof prop !== 'string') return;
    if (e.obj.type === 'Id') {
      const b = lookup(scope, e.obj.name);
      if (b && b.promiseLike && !['then', 'catch', 'finally'].includes(prop)) {
        add('warning', 'missing-await', e, `'${e.obj.name}' 은(는) await 없이 받은 Promise 인데 '.${prop}()' 를 바로 호출합니다`, { suggestion: `대입문에 await 를 붙이세요 (const ${e.obj.name} = await ...)` });
      }
      if (!b && NAMESPACE_OBJS[e.obj.name] && GLOBALS.has(e.obj.name)) {
        const ns = NAMESPACE_OBJS[e.obj.name];
        if (!(prop in ns)) {
          const sug = closest(prop, Object.getOwnPropertyNames(ns));
          add('error', 'undefined-member', { line: e.propLine || e.line, col: e.propCol || e.col }, `'${e.obj.name}.${prop}()' 은(는) 존재하지 않는 함수입니다`, { suggestion: sug ? `'${e.obj.name}.${sug}' 의 오타?` : undefined, replaceProp: sug ? { line: e.propLine, col: e.propCol, from: prop, to: sug } : undefined });
          return;
        }
      } else if (!b && e.obj.name === 'console' && GLOBALS.has('console') && !CONSOLE_MEMBERS.has(prop)) {
        const sug = closest(prop, [...CONSOLE_MEMBERS]);
        add('error', 'undefined-member', { line: e.propLine || e.line, col: e.propCol || e.col }, `'console.${prop}()' 은(는) 존재하지 않는 함수입니다`, { suggestion: sug ? `'console.${sug}' 의 오타?` : undefined, replaceProp: sug ? { line: e.propLine, col: e.propCol, from: prop, to: sug } : undefined });
        return;
      } else if (!b && e.obj.name === 'document' && GLOBALS.has('document') && !DOCUMENT_MEMBERS.has(prop) && !definedProps.has(prop)) {
        const sug = closest(prop, [...DOCUMENT_MEMBERS]);
        if (sug) { add('error', 'undefined-member', { line: e.propLine || e.line, col: e.propCol || e.col }, `'document.${prop}()' 은(는) 존재하지 않는 함수입니다`, { suggestion: `'document.${sug}' 의 오타?`, replaceProp: { line: e.propLine, col: e.propCol, from: prop, to: sug } }); return; }
      }
    }
    genericTypo(e, prop, true);
  }

  function visitNew(e, scope) {
    const c = e.callee;
    if (c.type === 'Id') {
      const b = resolveRef(c, scope, { read: true, call: true });
      if (b && (b.cls || b.fn)) callRecords.push({ binding: b, node: e, nargs: e.args.length, spread: e.args.some(a => a.type === 'Spread'), isNew: true });
      if (b && b.fn && b.fn.arrow) add('error', 'new-arrow', e, `화살표 함수 '${c.name}' 은(는) 생성자가 아니므로 new 로 호출할 수 없습니다 (TypeError)`);
    } else visitExpr(c, scope);
    visitArgs(e.args, scope);
  }

  // ---- 실행 ----
  hoist(ast.body, moduleScope, moduleScope);
  visitStatements(ast.body, moduleScope);

  // ---- 사후 점검: 미정의 이름 ----
  const assignedUnresolved = new Set(unresolved.filter(u => u.write).map(u => u.name));
  const reportedUndef = new Map();
  if (!ctx.hasEval && !ctx.hasWith) {
    for (const u of unresolved) {
      if (u.write && !u.read) {
        if (!implicitWrites.has(u.name)) {
          implicitWrites.set(u.name, u.node);
          add(strict ? 'error' : 'warning', 'implicit-global', u.node, `선언하지 않은 변수 '${u.name}' 에 대입합니다 ${strict ? '(strict/모듈에서는 ReferenceError)' : '(암묵적 전역 변수 생성)'}`, { suggestion: `let/const 로 선언하세요: let ${u.name}` });
        }
        continue;
      }
      if (assignedUnresolved.has(u.name) || typeofNames.has(u.name)) continue;   // 어딘가에서 대입되는 전역: 읽기는 허용
      const prev = reportedUndef.get(u.name);
      if (prev) { prev.count++; prev.call = prev.call || u.call; prev.lines.push(u.node.line); continue; }
      reportedUndef.set(u.name, { name: u.name, node: u.node, call: u.call, count: 1, lines: [u.node.line], names: u.names });
    }
    for (const r of reportedUndef.values()) {
      const cand = new Set([...r.names, ...GLOBALS]);
      const sug = closest(r.name, cand);
      let sugText = sug ? `'${sug}' 의 오타?` : null;
      if (!sugText && KNOWN_LIBS[r.name]) sugText = KNOWN_LIBS[r.name];
      if (!sugText && env === 'node' && BROWSER_GLOBALS.includes(r.name)) sugText = `'${r.name}' 는 브라우저 전역입니다 (Node 에는 없음)`;
      if (!sugText && env === 'browser' && NODE_GLOBALS.includes(r.name)) sugText = `'${r.name}' 는 Node 전용입니다 (브라우저에는 없음)`;
      if (!sugText) sugText = r.call ? `함수 '${r.name}' 를 정의하거나 import/require 하세요` : `변수 '${r.name}' 를 선언하거나 import/require 하세요`;
      add('error', r.call ? 'undefined-function' : 'undefined-variable', r.node, `${r.call ? '정의되지 않은 함수 호출' : '정의되지 않은 변수'}: ${r.name}${r.call ? '()' : ''}${r.count > 1 ? ` (총 ${r.count}곳: ${[...new Set(r.lines)].slice(0, 6).join(', ')}줄)` : ''}`,
        { suggestion: sugText, replaceId: sug ? { line: r.node.line, col: r.node.col, pos: r.node.pos, end: r.node.end || (r.node.pos + r.name.length), to: sug } : undefined, symbol: r.name });
    }
  }

  // ---- 사후 점검: 인자 개수 ----
  for (const rec of callRecords) {
    const b = rec.binding;
    if (b.writes > 0 || rec.spread) continue;
    let fnNode = b.fn, label = b.name;
    if (rec.isNew || (b.cls && !b.fn)) {
      const cinfo = b.cls && b.cls.cinfo;
      if (!cinfo) continue;
      fnNode = cinfo.ctorInfo;
      if (!fnNode) { if (!b.cls.superClass && rec.nargs > 0) add('info', 'arg-count', rec.node, `class '${label}' 에 constructor 가 없는데 인자 ${rec.nargs}개를 전달합니다 (무시됨)`); continue; }
    }
    if (!fnNode) continue;
    const info = fnInfoOf(fnNode);
    if (rec.nargs > info.max) add('warning', 'arg-count', rec.node, `'${label}' 는 인자를 최대 ${info.max}개 받는데 ${rec.nargs}개를 전달했습니다 (초과분은 무시됨)`, { suggestion: `정의(${fnNode.line}줄)의 매개변수: (${info.names.map(n => n || '…').join(', ')})` });
    else if (rec.nargs < info.min) {
      const missing = info.names.slice(rec.nargs, info.min);
      const used = missing.filter((n, i) => { const pb = info.paramBindings[rec.nargs + i]; return pb && pb.reads > 0; });
      if (used.length) add('info', 'arg-count', rec.node, `'${label}' 호출에 인자가 부족합니다: ${used.join(', ')} 이(가) undefined 로 전달되어 함수 안에서 사용됩니다`, { suggestion: `정의(${fnNode.line}줄)의 매개변수: (${info.names.map(n => n || '…').join(', ')})` });
    }
  }

  // ---- 사후 점검: 인스턴스·객체 리터럴·this 멤버 ----
  const seenMemberIssue = new Set();
  for (const mc of memberChecks) {
    const key = `${mc.node.line}:${mc.prop}`;
    if (seenMemberIssue.has(key)) continue;
    let known = null, label = '', kind = '';
    if (mc.thisAccess) { known = mc.cls.members; label = 'this'; kind = `class ${mc.cls.name}`; const ex = memberWrites.get(mc.cls.name + '.prototype'); if (ex && ex.has(mc.prop)) continue; }
    else {
      const b = mc.binding;
      if (b.writes > 0) continue;
      const w = memberWrites.get(b.name);
      if (w && (w.has(mc.prop) || w.has('*'))) continue;
      if (b.instanceOf) {
        const ci = b.instanceOf.cls.cinfo;
        if (!ci || ci.hasSuper || ci.dynamic) continue;
        const ex = memberWrites.get(ci.name + '.prototype');
        if (ex && ex.has(mc.prop)) continue;
        known = ci.members; label = b.name; kind = `class ${ci.name}`;
      } else if (b.objLit) {
        known = new Set(b.objLit.props.map(p => p.key.name)); label = b.name; kind = '객체 리터럴';
        if (b.objLit.props.some(p => p.kind === 'method' || p.kind === 'get' || p.kind === 'set')) { /* this.x 로 확장될 수 있음 */ }
      }
    }
    if (!known || known.has(mc.prop) || OBJECT_PROTO.has(mc.prop)) continue;
    if (mc.binding && mc.binding.objLit && KNOWN_MEMBERS.has(mc.prop) && !mc.call) continue;
    seenMemberIssue.add(key);
    const sug = closest(mc.prop, known);
    const msg = mc.call
      ? `정의되지 않은 메서드 호출: ${label}.${mc.prop}() — ${kind} 에 '${mc.prop}' 이(가) 없습니다${mc.thisAccess ? ' (추상 메서드/서브클래스 구현이면 무시)' : ''}`
      : `${label}.${mc.prop} : ${kind} 에 정의되지 않은 프로퍼티입니다 (undefined 가 됩니다)`;
    add(mc.call && !mc.thisAccess ? 'error' : 'warning', mc.call ? 'undefined-method' : 'undefined-property', { line: mc.node.propLine || mc.node.line, col: mc.node.propCol || mc.node.col }, msg,
      { suggestion: sug ? `'${sug}' 의 오타?` : `${kind} 에 '${mc.prop}' 를 추가하거나 호출을 제거하세요`, replaceProp: sug ? { line: mc.node.propLine, col: mc.node.propCol, from: mc.prop, to: sug } : undefined });
  }

  // ---- 사후 점검: 미사용 ----
  if (!ctx.hasEval && !ctx.hasWith) {
    for (const sc of allScopes) {
      for (const b of sc.vars.values()) {
        if (b.reads > 0 || b.exported || b.unusedExempt || b.name.startsWith('_')) continue;
        if (!['var', 'let', 'const', 'function', 'class', 'import'].includes(b.kind)) continue;
        if (b.loopVar || externalNames.has(b.name)) continue;
        const top = sc === moduleScope;
        if (top && b.kind === 'function' && opts.ignoreUnusedTopLevel !== false) {
          add('info', 'unused', b, `함수 '${b.name}' 이(가) 호출되지 않습니다 (진입점/이벤트 핸들러라면 무시)`);
          continue;
        }
        if (top && b.kind === 'class') { add('info', 'unused', b, `class '${b.name}' 이(가) 사용되지 않습니다`); continue; }
        const written = b.writes > 0;
        add(b.kind === 'import' ? 'warning' : (top ? 'info' : 'warning'), 'unused', b, written ? `변수 '${b.name}' 에 값을 대입만 하고 읽지 않습니다` : `${b.kind === 'import' ? '가져온' : (b.kind === 'function' ? '함수' : '변수')} '${b.name}' 을(를) 선언만 하고 사용하지 않습니다`);
      }
    }
  }

  // 정렬 / 중복 제거
  const order = { error: 0, warning: 1, info: 2 };
  issues.sort((a, b) => order[a.sev] - order[b.sev] || a.line - b.line || a.col - b.col);
  const uniq = [];
  const seen = new Set();
  for (const i of issues) { const k = `${i.rule}|${i.line}|${i.col}|${i.message}`; if (seen.has(k)) continue; seen.add(k); uniq.push(i); }

  return {
    issues: uniq, functions: fnMetricsList, requires, exports: exportInfo, env, strict, isModule,
    topLevelNames: [...moduleScope.vars.entries()].filter(([, b]) => b.kind !== 'import').map(([k]) => k),
    ast
  };
}

module.exports = {
  analyzeJs, checkSyntax, blankModuleSyntax, codeFrame, hintFor, closest, editDistance, complexityLabel, inferEnv, buildGlobals,
  ES_GLOBALS, NODE_GLOBALS, BROWSER_GLOBALS, ParseError, walk, fnMetrics, KNOWN_MEMBERS, isFn
};
