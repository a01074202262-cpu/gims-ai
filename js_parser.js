'use strict';
/**
 * js_parser.js — 의존성 없는 JavaScript(ES2022) 토크나이저 + 재귀 하강 파서
 *
 * 목적: 코드를 "실행하지 않고" 구조(AST)를 얻어 정의되지 않은 변수·함수, 스코프, 인자 개수 등을 분석한다.
 * 문법 오류의 정확한 위치·메시지는 V8(vm.Script 컴파일)이 담당하고, 이 파서는 "유효한 코드의 구조 분석"에 쓴다.
 * 지원: let/const/var, 구조분해, 화살표/async/generator, class(필드·private·static 블록), 템플릿,
 *       옵셔널 체이닝, ??, **, 스프레드, import/export, 라벨, for-in/of/await, 정규식 리터럴.
 */

class ParseError extends Error {
  constructor(msg, tok) { super(msg); this.name = 'ParseError'; this.line = tok ? tok.line : null; this.col = tok ? tok.col : null; }
}

const KEYWORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'export',
  'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'return', 'super', 'switch',
  'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'null', 'true', 'false'
]);

const PUNCT = [
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '**',
  '{', '}', '(', ')', '[', ']', ';', ',', '<', '>', '+', '-', '*', '/', '%', '&', '|', '^', '!', '~', '?', ':', '=', '.', '@'
];

const isIdStart = c => /[A-Za-z_$ -￿]/.test(c);
const isIdPart = c => /[A-Za-z0-9_$ -￿‌‍]/.test(c);

// ---------------------------------------------------------------------------
// 토크나이저
// ---------------------------------------------------------------------------
function tokenize(src) {
  let pos = 0, line = 1, lineStart = 0;
  const n = src.length;

  const mk = (t, v, start, extra = {}) => ({ t, v, pos: start.pos, end: pos, line: start.line, col: start.col, nl: false, ...extra });
  const here = () => ({ pos, line, col: pos - lineStart + 1 });

  function regexAllowed(prev) {
    if (!prev) return true;
    switch (prev.t) {
      case 'num': case 'str': case 'tpl': case 're': case 'name': case 'priv': return false;
      case 'kw': return !(prev.v === 'this' || prev.v === 'super' || prev.v === 'null' || prev.v === 'true' || prev.v === 'false');
      case 'p': return !(prev.v === ')' || prev.v === ']' || prev.v === '++' || prev.v === '--');
      default: return true;
    }
  }

  // stopAtBrace: 템플릿 ${ } 내부를 읽을 때 짝이 맞지 않는 '}' 에서 멈춘다
  function run(stopAtBrace) {
    const out = [];
    let depth = 0, sawNl = false;
    while (pos < n) {
      const c = src[pos];
      if (c === '\n') { pos++; line++; lineStart = pos; sawNl = true; continue; }
      if (c === ' ' || c === '\t' || c === '\r' || c === ' ' || c === '﻿' || c === ' ' || c === ' ') {
        if (c === ' ' || c === ' ') { line++; lineStart = pos + 1; sawNl = true; }
        pos++; continue;
      }
      if (c === '/' && src[pos + 1] === '/') { while (pos < n && src[pos] !== '\n') pos++; continue; }
      if (c === '/' && src[pos + 1] === '*') {
        const st = here();
        pos += 2;
        while (pos < n && !(src[pos] === '*' && src[pos + 1] === '/')) {
          if (src[pos] === '\n') { line++; lineStart = pos + 1; sawNl = true; }
          pos++;
        }
        if (pos >= n) throw new ParseError('닫히지 않은 블록 주석', { line: st.line, col: st.col });
        pos += 2; continue;
      }
      if (c === '#' && pos === 0 && src[1] === '!') { while (pos < n && src[pos] !== '\n') pos++; continue; }

      const st = here();
      let tok;
      if (isIdStart(c) || c === '\\') {
        let p = pos + 1;
        while (p < n && (isIdPart(src[p]) || src[p] === '\\')) p++;
        const word = src.slice(pos, p); pos = p;
        tok = mk(KEYWORDS.has(word) ? 'kw' : 'name', word, st);
      } else if (c === '#' && isIdStart(src[pos + 1] || '')) {
        let p = pos + 1;
        while (p < n && isIdPart(src[p])) p++;
        const word = src.slice(pos, p); pos = p;
        tok = mk('priv', word, st);
      } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[pos + 1] || ''))) {
        const m = /^(?:0[xX][0-9a-fA-F_]+n?|0[oO][0-7_]+n?|0[bB][01_]+n?|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?n?)/.exec(src.slice(pos, pos + 80));
        pos += m[0].length;
        tok = mk('num', m[0], st);
      } else if (c === '"' || c === "'") {
        let p = pos + 1, val = '';
        while (p < n && src[p] !== c) {
          if (src[p] === '\\') { if (src[p + 1] === '\n') { line++; lineStart = p + 2; } val += src[p + 1] || ''; p += 2; continue; }
          if (src[p] === '\n') throw new ParseError('닫히지 않은 문자열', st);
          val += src[p]; p++;
        }
        if (p >= n) throw new ParseError('닫히지 않은 문자열', st);
        pos = p + 1;
        tok = mk('str', val, st);
      } else if (c === '`') {
        pos++;
        const quasis = [], exprs = [];
        let cur = '';
        for (;;) {
          if (pos >= n) throw new ParseError('닫히지 않은 템플릿 문자열', st);
          const ch = src[pos];
          if (ch === '\\') { cur += src[pos + 1] || ''; if (src[pos + 1] === '\n') { line++; lineStart = pos + 2; } pos += 2; continue; }
          if (ch === '`') { pos++; break; }
          if (ch === '$' && src[pos + 1] === '{') {
            pos += 2; quasis.push(cur); cur = '';
            const sub = run(true);
            exprs.push(sub);
            continue;
          }
          if (ch === '\n') { line++; lineStart = pos + 1; }
          cur += ch; pos++;
        }
        quasis.push(cur);
        tok = mk('tpl', quasis.join('${}'), st, { quasis, exprs });
      } else if (c === '/' && regexAllowed(out[out.length - 1] || null)) {
        let p = pos + 1, inClass = false;
        for (;;) {
          if (p >= n || src[p] === '\n') throw new ParseError('닫히지 않은 정규식 리터럴', st);
          const ch = src[p];
          if (ch === '\\') { p += 2; continue; }
          if (ch === '[') inClass = true;
          else if (ch === ']') inClass = false;
          else if (ch === '/' && !inClass) break;
          p++;
        }
        const body = src.slice(pos + 1, p);
        p++;
        while (p < n && /[a-z]/.test(src[p])) p++;
        const flags = src.slice(pos + 1 + body.length + 1, p);
        pos = p;
        tok = mk('re', body, st, { flags });
      } else {
        let matched = null;
        for (const pu of PUNCT) {
          if (src.startsWith(pu, pos)) {
            if (pu === '?.' && /[0-9]/.test(src[pos + 2] || '')) continue;   // a?.5:1 은 삼항
            matched = pu; break;
          }
        }
        if (!matched) throw new ParseError(`알 수 없는 문자 '${c}'`, st);
        if (stopAtBrace) {
          if (matched === '{') depth++;
          else if (matched === '}') {
            if (depth === 0) { pos++; out.push({ t: 'eof', v: '', pos, end: pos, line, col: pos - lineStart + 1, nl: false }); return out; }
            depth--;
          }
        }
        pos += matched.length;
        tok = mk('p', matched, st);
      }
      tok.nl = sawNl; sawNl = false;
      out.push(tok);
    }
    if (stopAtBrace) throw new ParseError('템플릿 ${ } 가 닫히지 않았습니다', { line, col: 1 });
    out.push({ t: 'eof', v: '', pos: n, end: n, line, col: pos - lineStart + 1, nl: true });
    return out;
  }
  return run(false);
}

// ---------------------------------------------------------------------------
// 파서
// ---------------------------------------------------------------------------
const BIN_PREC = {
  '??': 1, '||': 2, '&&': 3, '|': 4, '^': 5, '&': 6,
  '==': 7, '!=': 7, '===': 7, '!==': 7,
  '<': 8, '>': 8, '<=': 8, '>=': 8, 'instanceof': 8, 'in': 8,
  '<<': 9, '>>': 9, '>>>': 9, '+': 10, '-': 10, '*': 11, '/': 11, '%': 11, '**': 12
};
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??=']);

class Parser {
  constructor(tokens, flags = {}) {
    this.t = tokens; this.i = 0;
    this.noIn = false;
    this.inGen = !!flags.inGen; this.inAsync = !!flags.inAsync;
    this.src = flags.src || '';
  }
  get tok() { return this.t[this.i]; }
  peek(k = 1) { return this.t[Math.min(this.i + k, this.t.length - 1)]; }
  next() { const k = this.t[this.i]; if (this.i < this.t.length - 1) this.i++; return k; }
  isP(v) { const k = this.tok; return k.t === 'p' && k.v === v; }
  isKw(v) { const k = this.tok; return k.t === 'kw' && k.v === v; }
  isName(v) { const k = this.tok; return k.t === 'name' && k.v === v; }
  eatP(v) { return this.isP(v) ? this.next() : null; }
  fail(msg, tok) { throw new ParseError(msg, tok || this.tok); }
  expectP(v) { if (!this.isP(v)) this.fail(`'${v}' 가 필요합니다 (현재 '${this.tok.v || this.tok.t}')`); return this.next(); }
  expectKw(v) { if (!this.isKw(v)) this.fail(`'${v}' 가 필요합니다`); return this.next(); }
  semi() {
    if (this.eatP(';')) return;
    if (this.isP('}') || this.tok.t === 'eof' || this.tok.nl) return;
    this.fail(`';' 가 필요합니다 (현재 '${this.tok.v || this.tok.t}')`);
  }
  N(type, tok, props) { return { type, line: tok.line, col: tok.col, pos: tok.pos, ...props }; }
  fin(node) { node.end = this.t[Math.max(0, this.i - 1)].end; return node; }
  // 현재 위치에서 짝이 맞는 ')' 의 다음 토큰이 '=>' 인지 확인 (화살표 함수 판별)
  isArrowAhead(openIdx) {
    let d = 0;
    for (let j = openIdx; j < this.t.length; j++) {
      const k = this.t[j];
      if (k.t === 'p') {
        if (k.v === '(' || k.v === '[' || k.v === '{') d++;
        else if (k.v === ')' || k.v === ']' || k.v === '}') { d--; if (d === 0) { const nx = this.t[j + 1]; return !!nx && nx.t === 'p' && nx.v === '=>' && !nx.nl; } }
      } else if (k.t === 'eof') return false;
    }
    return false;
  }

  parseProgram() {
    const body = [];
    while (this.tok.t !== 'eof') body.push(this.parseStatement());
    return { type: 'Program', body, line: 1, col: 1, pos: 0 };
  }

  // ----- 문장 -----
  parseBlock() {
    const st = this.expectP('{');
    const body = [];
    while (!this.isP('}')) { if (this.tok.t === 'eof') this.fail("'}' 가 닫히지 않았습니다"); body.push(this.parseStatement()); }
    this.next();
    return this.fin(this.N('Block', st, { body }));
  }

  parseStatement() {
    const k = this.tok;
    if (k.t === 'p') {
      if (k.v === '{') return this.parseBlock();
      if (k.v === ';') { this.next(); return this.N('Empty', k, {}); }
    }
    if (k.t === 'kw') {
      switch (k.v) {
        case 'var': case 'const': { const d = this.parseVarDecl(k.v, false); this.semi(); return this.fin(d); }
        case 'function': return this.parseFunction(true, false);
        case 'class': return this.parseClass(true);
        case 'if': {
          this.next(); this.expectP('(');
          const test = this.parseExpression(); this.expectP(')');
          const cons = this.parseStatement();
          let alt = null;
          if (this.isKw('else')) { this.next(); alt = this.parseStatement(); }
          return this.fin(this.N('If', k, { test, cons, alt }));
        }
        case 'for': return this.parseFor();
        case 'while': {
          this.next(); this.expectP('(');
          const test = this.parseExpression(); this.expectP(')');
          return this.fin(this.N('While', k, { test, body: this.parseStatement() }));
        }
        case 'do': {
          this.next();
          const body = this.parseStatement();
          this.expectKw('while'); this.expectP('(');
          const test = this.parseExpression(); this.expectP(')');
          this.eatP(';');
          return this.fin(this.N('DoWhile', k, { body, test }));
        }
        case 'return': {
          this.next();
          let arg = null;
          if (!this.isP(';') && !this.isP('}') && this.tok.t !== 'eof' && !this.tok.nl) arg = this.parseExpression();
          this.semi();
          return this.fin(this.N('Return', k, { arg }));
        }
        case 'break': case 'continue': {
          this.next();
          let label = null;
          if (this.tok.t === 'name' && !this.tok.nl) label = this.next().v;
          this.semi();
          return this.fin(this.N(k.v === 'break' ? 'Break' : 'Continue', k, { label }));
        }
        case 'throw': {
          this.next();
          const arg = this.parseExpression();
          this.semi();
          return this.fin(this.N('Throw', k, { arg }));
        }
        case 'try': {
          this.next();
          const block = this.parseBlock();
          let param = null, handler = null, finalizer = null;
          if (this.isKw('catch')) {
            this.next();
            if (this.eatP('(')) { param = this.parseBindingTarget(); this.expectP(')'); }
            handler = this.parseBlock();
          }
          if (this.isKw('finally')) { this.next(); finalizer = this.parseBlock(); }
          if (!handler && !finalizer) this.fail('catch 또는 finally 가 필요합니다');
          return this.fin(this.N('Try', k, { block, param, handler, finalizer }));
        }
        case 'switch': {
          this.next(); this.expectP('(');
          const disc = this.parseExpression(); this.expectP(')'); this.expectP('{');
          const cases = [];
          while (!this.isP('}')) {
            const ck = this.tok;
            let test = null;
            if (this.isKw('case')) { this.next(); test = this.parseExpression(); }
            else if (this.isKw('default')) this.next();
            else this.fail("'case' 또는 'default' 가 필요합니다");
            this.expectP(':');
            const cons = [];
            while (!this.isP('}') && !this.isKw('case') && !this.isKw('default')) {
              if (this.tok.t === 'eof') this.fail("switch 가 닫히지 않았습니다");
              cons.push(this.parseStatement());
            }
            cases.push(this.N('Case', ck, { test, cons }));
          }
          this.next();
          return this.fin(this.N('Switch', k, { disc, cases }));
        }
        case 'debugger': this.next(); this.semi(); return this.N('Empty', k, {});
        case 'with': {
          this.next(); this.expectP('(');
          const obj = this.parseExpression(); this.expectP(')');
          return this.fin(this.N('With', k, { obj, body: this.parseStatement() }));
        }
        case 'import': {
          const nx = this.peek();
          if (nx.t === 'p' && (nx.v === '(' || nx.v === '.')) break;   // 동적 import / import.meta 는 식
          return this.parseImport();
        }
        case 'export': return this.parseExport();
        default: break;
      }
    }
    if (k.t === 'name') {
      if (k.v === 'let') {
        const nx = this.peek();
        if (nx.t === 'name' || (nx.t === 'p' && (nx.v === '[' || nx.v === '{'))) { const d = this.parseVarDecl('let', false); this.semi(); return this.fin(d); }
      }
      if (k.v === 'async') {
        const nx = this.peek();
        if (nx.t === 'kw' && nx.v === 'function' && !nx.nl) return this.parseFunction(true, true);
      }
      const nx = this.peek();
      if (nx.t === 'p' && nx.v === ':' ) {
        this.next(); this.next();
        return this.fin(this.N('Labeled', k, { label: k.v, body: this.parseStatement() }));
      }
    }
    const expr = this.parseExpression();
    this.semi();
    return this.fin(this.N('ExprStmt', k, { expr }));
  }

  parseVarDecl(kind, noIn) {
    const st = this.next();   // var/let/const
    const decls = [];
    const savedNoIn = this.noIn; this.noIn = noIn;
    do {
      const id = this.parseBindingTarget();
      let init = null;
      if (this.eatP('=')) init = this.parseAssign();
      decls.push({ type: 'Declarator', id, init, line: id.line, col: id.col, pos: id.pos, end: this.t[this.i - 1].end });
    } while (this.eatP(','));
    this.noIn = savedNoIn;
    return this.fin(this.N('VarDecl', st, { kind, decls }));
  }

  parseFor() {
    const st = this.next();
    let isAwait = false;
    if (this.isName('await')) { this.next(); isAwait = true; }
    this.expectP('(');
    let init = null;
    if (this.isP(';')) { /* 초기식 없음 */ }
    else {
      const k = this.tok;
      const isDecl = (k.t === 'kw' && (k.v === 'var' || k.v === 'const')) ||
        (k.t === 'name' && k.v === 'let' && (this.peek().t === 'name' || (this.peek().t === 'p' && (this.peek().v === '[' || this.peek().v === '{'))));
      if (isDecl) init = this.parseVarDecl(k.v, true);
      else { const sv = this.noIn; this.noIn = true; init = this.parseExpression(); this.noIn = sv; }
    }
    if (this.isName('of') || this.isKw('in')) {
      const isOf = this.tok.v === 'of';
      this.next();
      const right = isOf ? this.parseAssign() : this.parseExpression();
      this.expectP(')');
      const body = this.parseStatement();
      return this.fin(this.N(isOf ? 'ForOf' : 'ForIn', st, { left: init, right, body, isAwait }));
    }
    this.expectP(';');
    const test = this.isP(';') ? null : this.parseExpression();
    this.expectP(';');
    const update = this.isP(')') ? null : this.parseExpression();
    this.expectP(')');
    const body = this.parseStatement();
    return this.fin(this.N('For', st, { init, test, update, body }));
  }

  parseImport() {
    const st = this.next();
    const specs = [];
    if (this.tok.t === 'str') { const s = this.next(); return this.fin(this.N('Import', st, { specs, source: s.v })); }
    if (this.tok.t === 'name') {
      const t = this.next(); specs.push({ local: t.v, imported: 'default', line: t.line, col: t.col, pos: t.pos });
      this.eatP(',');
    }
    if (this.eatP('*')) {
      if (!this.isName('as')) this.fail("'as' 가 필요합니다");
      this.next();
      const t = this.next(); specs.push({ local: t.v, imported: '*', line: t.line, col: t.col, pos: t.pos });
    } else if (this.eatP('{')) {
      while (!this.isP('}')) {
        const a = this.next();
        let local = a.v;
        if (this.isName('as')) { this.next(); local = this.next().v; }
        specs.push({ local, imported: a.v, line: a.line, col: a.col, pos: a.pos });
        if (!this.eatP(',')) break;
      }
      this.expectP('}');
    }
    if (!this.isName('from')) this.fail("'from' 이 필요합니다");
    this.next();
    if (this.tok.t !== 'str') this.fail('모듈 경로 문자열이 필요합니다');
    const source = this.next().v;
    if (this.isKw('with') || this.isName('assert')) { this.next(); this.parseAssign(); }
    this.semi();
    return this.fin(this.N('Import', st, { specs, source }));
  }

  parseExport() {
    const st = this.next();
    if (this.isKw('default')) {
      this.next();
      let decl;
      if (this.isKw('function')) decl = this.parseFunction(true, false);
      else if (this.isName('async') && this.peek().t === 'kw' && this.peek().v === 'function') decl = this.parseFunction(true, true);
      else if (this.isKw('class')) decl = this.parseClass(true);
      else { decl = this.parseAssign(); this.semi(); }
      return this.fin(this.N('Export', st, { decl, isDefault: true }));
    }
    if (this.eatP('*')) {
      let alias = null;
      if (this.isName('as')) { this.next(); alias = this.next().v; }
      if (!this.isName('from')) this.fail("'from' 이 필요합니다");
      this.next();
      const source = this.next().v; this.semi();
      return this.fin(this.N('Export', st, { all: true, alias, source }));
    }
    if (this.isP('{')) {
      this.next();
      const specs = [];
      while (!this.isP('}')) {
        const a = this.next();
        let exported = a.v;
        if (this.isName('as')) { this.next(); exported = this.next().v; }
        specs.push({ local: a.v, exported, line: a.line, col: a.col, pos: a.pos });
        if (!this.eatP(',')) break;
      }
      this.expectP('}');
      let source = null;
      if (this.isName('from')) { this.next(); source = this.next().v; }
      this.semi();
      return this.fin(this.N('Export', st, { specs, source }));
    }
    const decl = this.parseStatement();
    return this.fin(this.N('Export', st, { decl }));
  }

  // ----- 바인딩 패턴 -----
  parseBindingTarget() {
    const k = this.tok;
    if (k.t === 'name') { this.next(); return this.N('Id', k, { name: k.v, end: k.end, decl: true }); }
    if (k.t === 'p' && k.v === '[') {
      this.next();
      const elements = [];
      while (!this.isP(']')) {
        if (this.isP(',')) { this.next(); elements.push(null); continue; }
        if (this.isP('...')) { const r = this.next(); elements.push(this.N('Rest', r, { arg: this.parseBindingTarget() })); }
        else elements.push(this.parseBindingElement());
        if (!this.isP(']')) this.expectP(',');
      }
      this.next();
      return this.fin(this.N('ArrayPattern', k, { elements }));
    }
    if (k.t === 'p' && k.v === '{') {
      this.next();
      const props = [];
      while (!this.isP('}')) {
        if (this.isP('...')) { const r = this.next(); props.push(this.N('Rest', r, { arg: this.parseBindingTarget() })); }
        else {
          const kt = this.tok;
          let key, computed = false;
          if (this.isP('[')) { this.next(); key = this.parseAssign(); this.expectP(']'); computed = true; }
          else if (kt.t === 'name' || kt.t === 'kw' || kt.t === 'str' || kt.t === 'num') { this.next(); key = { type: 'Key', name: String(kt.v), line: kt.line, col: kt.col }; }
          else this.fail('프로퍼티 이름이 필요합니다');
          let value;
          if (this.eatP(':')) value = this.parseBindingElement();
          else {
            if (kt.t !== 'name') this.fail('구조분해 단축 표기에는 식별자가 필요합니다', kt);
            value = this.N('Id', kt, { name: kt.v, end: kt.end, decl: true });
            if (this.eatP('=')) value = this.N('AssignPattern', kt, { left: value, right: this.parseAssign() });
          }
          props.push(this.N('PatProp', kt, { key, computed, value }));
        }
        if (!this.isP('}')) this.expectP(',');
      }
      this.next();
      return this.fin(this.N('ObjectPattern', k, { props }));
    }
    this.fail(`바인딩 이름이 필요합니다 (현재 '${k.v || k.t}')`);
  }
  parseBindingElement() {
    const target = this.parseBindingTarget();
    if (this.isP('=')) { this.next(); return this.fin(this.N('AssignPattern', target, { left: target, right: this.parseAssign() })); }
    return target;
  }
  parseParams() {
    this.expectP('(');
    const params = [];
    while (!this.isP(')')) {
      if (this.isP('...')) { const r = this.next(); params.push(this.N('Rest', r, { arg: this.parseBindingTarget() })); }
      else params.push(this.parseBindingElement());
      if (!this.isP(')')) this.expectP(',');
    }
    this.next();
    return params;
  }

  // ----- 함수 / 클래스 -----
  parseFunctionRest(st, id, isAsync, isGen, type) {
    const sg = this.inGen, sa = this.inAsync;
    this.inGen = isGen; this.inAsync = isAsync;
    const params = this.parseParams();
    const body = this.parseBlock();
    this.inGen = sg; this.inAsync = sa;
    return this.fin(this.N(type, st, { id, params, body, async: isAsync, gen: isGen, arrow: false }));
  }
  parseFunction(isDecl, isAsync) {
    const st = this.tok;
    if (isAsync) this.next();
    this.expectKw('function');
    const isGen = !!this.eatP('*');
    let id = null;
    if (this.tok.t === 'name') { const t = this.next(); id = this.N('Id', t, { name: t.v, end: t.end, decl: true }); }
    else if (isDecl && !(this.isP('('))) this.fail('함수 이름이 필요합니다');
    return this.parseFunctionRest(st, id, isAsync, isGen, isDecl ? 'FuncDecl' : 'FuncExpr');
  }

  parseClass(isDecl) {
    const st = this.next();
    let id = null;
    if (this.tok.t === 'name' && !(this.tok.v === 'extends')) { const t = this.next(); id = this.N('Id', t, { name: t.v, end: t.end, decl: true }); }
    let superClass = null;
    if (this.isKw('extends')) { this.next(); superClass = this.parseLHS(); }
    this.expectP('{');
    const members = [];
    while (!this.isP('}')) {
      if (this.eatP(';')) continue;
      if (this.tok.t === 'eof') this.fail('class 가 닫히지 않았습니다');
      members.push(this.parseClassMember());
    }
    this.next();
    return this.fin(this.N(isDecl ? 'ClassDecl' : 'ClassExpr', st, { id, superClass, members }));
  }
  // 멤버 키 다음에 '(' / '=' / ';' / '}' 가 오면 앞의 contextual 단어(static/get/set/async)는 키 이름이다
  isMemberEnd(tok) { return tok.t === 'p' && (tok.v === '(' || tok.v === '=' || tok.v === ';' || tok.v === '}' || tok.v === ',' || tok.v === ':'); }
  parseClassMember() {
    const st = this.tok;
    let isStatic = false, kind = 'method', isAsync = false, isGen = false;
    if (this.isName('static') && !this.isMemberEnd(this.peek())) {
      this.next(); isStatic = true;
      if (this.isP('{')) {
        const body = this.parseBlock();
        return this.N('Member', st, { kind: 'static-block', static: true, body, key: null });
      }
    }
    if (this.isName('async') && !this.isMemberEnd(this.peek()) && !this.peek().nl) { this.next(); isAsync = true; }
    if (this.isP('*')) { this.next(); isGen = true; }
    if ((this.isName('get') || this.isName('set')) && !this.isMemberEnd(this.peek())) { kind = this.next().v; }
    const kt = this.tok;
    let key, computed = false;
    if (this.isP('[')) { this.next(); key = this.parseAssign(); this.expectP(']'); computed = true; }
    else if (kt.t === 'name' || kt.t === 'kw' || kt.t === 'str' || kt.t === 'num' || kt.t === 'priv') { this.next(); key = { type: 'Key', name: String(kt.v), line: kt.line, col: kt.col }; }
    else this.fail(`클래스 멤버 이름이 필요합니다 (현재 '${kt.v || kt.t}')`);
    if (this.isP('(')) {
      const fn = this.parseFunctionRest(kt, null, isAsync, isGen, 'FuncExpr');
      if (!computed && key.name === 'constructor' && !isStatic) kind = 'constructor';
      return this.fin(this.N('Member', st, { kind, static: isStatic, key, computed, value: fn }));
    }
    let init = null;
    if (this.eatP('=')) {
      const sa = this.inAsync, sg = this.inGen; this.inAsync = false; this.inGen = false;
      init = this.parseAssign();
      this.inAsync = sa; this.inGen = sg;
    }
    this.semi();
    return this.fin(this.N('Member', st, { kind: 'field', static: isStatic, key, computed, init }));
  }

  // ----- 식 -----
  parseExpression() {
    const st = this.tok;
    const first = this.parseAssign();
    if (this.isP(',')) {
      const exprs = [first];
      while (this.eatP(',')) exprs.push(this.parseAssign());
      return this.fin(this.N('Seq', st, { exprs }));
    }
    return first;
  }

  parseArrowBody(st, params, isAsync) {
    const sa = this.inAsync, sg = this.inGen;
    this.inAsync = isAsync; this.inGen = false;
    let body, expr = false;
    if (this.isP('{')) body = this.parseBlock();
    else { body = this.parseAssign(); expr = true; }
    this.inAsync = sa; this.inGen = sg;
    return this.fin(this.N('Arrow', st, { params, body, expr, async: isAsync, arrow: true }));
  }

  parseAssign() {
    const k = this.tok;
    // yield
    if (this.inGen && k.t === 'name' && k.v === 'yield') {
      this.next();
      let delegate = false, arg = null;
      if (this.isP('*')) { this.next(); delegate = true; }
      if (!this.tok.nl && !(this.tok.t === 'p' && [')', ']', '}', ',', ';', ':'].includes(this.tok.v)) && this.tok.t !== 'eof') arg = this.parseAssign();
      return this.fin(this.N('Yield', k, { arg, delegate }));
    }
    // 화살표 함수 판별
    if (k.t === 'name') {
      const nx = this.peek();
      if (nx.t === 'p' && nx.v === '=>' && !nx.nl) {
        this.next(); this.next();
        const p = this.N('Id', k, { name: k.v, end: k.end, decl: true });
        return this.parseArrowBody(k, [p], false);
      }
      if (k.v === 'async' && !nx.nl) {
        if (nx.t === 'name') {
          const n2 = this.peek(2);
          if (n2.t === 'p' && n2.v === '=>') {
            this.next(); const pt = this.next(); this.next();
            return this.parseArrowBody(k, [this.N('Id', pt, { name: pt.v, end: pt.end, decl: true })], true);
          }
        } else if (nx.t === 'p' && nx.v === '(' && this.isArrowAhead(this.i + 1)) {
          this.next();
          const params = this.parseParams();
          this.expectP('=>');
          return this.parseArrowBody(k, params, true);
        }
      }
    }
    if (k.t === 'p' && k.v === '(' && this.isArrowAhead(this.i)) {
      const params = this.parseParams();
      this.expectP('=>');
      return this.parseArrowBody(k, params, false);
    }
    const left = this.parseConditional();
    if (this.tok.t === 'p' && ASSIGN_OPS.has(this.tok.v)) {
      const op = this.next().v;
      const right = this.parseAssign();
      return this.fin(this.N('Assign', k, { op, left, right }));
    }
    return left;
  }

  parseConditional() {
    const st = this.tok;
    const test = this.parseBinary(1);
    if (this.isP('?')) {
      this.next();
      const sv = this.noIn; this.noIn = false;
      const cons = this.parseAssign();
      this.noIn = sv;
      this.expectP(':');
      const alt = this.parseAssign();
      return this.fin(this.N('Cond', st, { test, cons, alt }));
    }
    return test;
  }

  binOp() {
    const k = this.tok;
    if (k.t === 'p' && BIN_PREC[k.v] !== undefined) return k.v;
    if (k.t === 'kw' && k.v === 'instanceof') return 'instanceof';
    if (k.t === 'kw' && k.v === 'in' && !this.noIn) return 'in';
    return null;
  }
  parseBinary(minPrec) {
    const st = this.tok;
    let left = this.parseUnary();
    for (;;) {
      const op = this.binOp();
      if (!op) break;
      const prec = BIN_PREC[op];
      if (prec < minPrec) break;
      const opTok = this.next();
      const right = op === '**' ? this.parseBinary(prec) : this.parseBinary(prec + 1);
      left = this.fin(this.N(op === '&&' || op === '||' || op === '??' ? 'Logical' : 'Binary', st, { op, left, right, opPos: opTok.pos, opEnd: opTok.end }));
    }
    return left;
  }

  parseUnary() {
    const k = this.tok;
    if (k.t === 'p' && (k.v === '!' || k.v === '~' || k.v === '+' || k.v === '-')) {
      this.next();
      return this.fin(this.N('Unary', k, { op: k.v, arg: this.parseUnary() }));
    }
    if (k.t === 'kw' && (k.v === 'typeof' || k.v === 'void' || k.v === 'delete')) {
      this.next();
      return this.fin(this.N('Unary', k, { op: k.v, arg: this.parseUnary() }));
    }
    if (k.t === 'p' && (k.v === '++' || k.v === '--')) {
      this.next();
      return this.fin(this.N('Update', k, { op: k.v, prefix: true, arg: this.parseUnary() }));
    }
    if (k.t === 'name' && k.v === 'await') {
      const nx = this.peek();
      const startsExpr = nx.t === 'name' || nx.t === 'num' || nx.t === 'str' || nx.t === 'tpl' || nx.t === 're' || nx.t === 'kw' ||
        (nx.t === 'p' && ['(', '[', '{', '!', '-', '+', '~', '++', '--'].includes(nx.v));
      if (startsExpr && !(nx.t === 'kw' && ['in', 'instanceof'].includes(nx.v)) && (this.inAsync || !nx.nl)) {
        this.next();
        return this.fin(this.N('Await', k, { arg: this.parseUnary() }));
      }
    }
    const e = this.parseLHS();
    if (this.tok.t === 'p' && (this.tok.v === '++' || this.tok.v === '--') && !this.tok.nl) {
      const op = this.next().v;
      return this.fin(this.N('Update', k, { op, prefix: false, arg: e }));
    }
    return e;
  }

  parseArgs() {
    this.expectP('(');
    const args = [];
    const sv = this.noIn; this.noIn = false;
    while (!this.isP(')')) {
      if (this.isP('...')) { const r = this.next(); args.push(this.N('Spread', r, { arg: this.parseAssign() })); }
      else args.push(this.parseAssign());
      if (!this.isP(')')) this.expectP(',');
    }
    this.noIn = sv;
    this.next();
    return args;
  }

  parseLHS() {
    const st = this.tok;
    let e;
    if (this.isKw('new')) e = this.parseNew();
    else e = this.parsePrimary();
    for (;;) {
      const k = this.tok;
      if (k.t === 'p' && k.v === '.') {
        this.next();
        const pt = this.tok;
        if (pt.t === 'name' || pt.t === 'kw' || pt.t === 'priv') { this.next(); e = this.fin(this.N('Member', st, { obj: e, prop: pt.v, propLine: pt.line, propCol: pt.col, computed: false, optional: false, isMember: true })); }
        else this.fail(`'.' 뒤에 프로퍼티 이름이 필요합니다 (현재 '${pt.v || pt.t}')`);
      } else if (k.t === 'p' && k.v === '?.') {
        this.next();
        if (this.isP('(')) { const args = this.parseArgs(); e = this.fin(this.N('Call', st, { callee: e, args, optional: true })); }
        else if (this.isP('[')) { this.next(); const sv = this.noIn; this.noIn = false; const prop = this.parseExpression(); this.noIn = sv; this.expectP(']'); e = this.fin(this.N('Member', st, { obj: e, prop, computed: true, optional: true, isMember: true })); }
        else { const pt = this.next(); e = this.fin(this.N('Member', st, { obj: e, prop: pt.v, propLine: pt.line, propCol: pt.col, computed: false, optional: true, isMember: true })); }
      } else if (k.t === 'p' && k.v === '[') {
        this.next();
        const sv = this.noIn; this.noIn = false;
        const prop = this.parseExpression();
        this.noIn = sv;
        this.expectP(']');
        e = this.fin(this.N('Member', st, { obj: e, prop, computed: true, optional: false, isMember: true }));
      } else if (k.t === 'p' && k.v === '(') {
        const args = this.parseArgs();
        e = this.fin(this.N('Call', st, { callee: e, args, optional: false }));
      } else if (k.t === 'tpl') {
        const quasi = this.parseTemplate();
        e = this.fin(this.N('Tagged', st, { tag: e, quasi }));
      } else break;
    }
    return e;
  }

  parseNew() {
    const st = this.next();   // new
    if (this.isP('.')) { this.next(); this.next(); return this.fin(this.N('Meta', st, { name: 'new.target' })); }
    let callee;
    if (this.isKw('new')) callee = this.parseNew();
    else callee = this.parsePrimary();
    for (;;) {
      const k = this.tok;
      if (k.t === 'p' && k.v === '.') {
        this.next(); const pt = this.next();
        callee = this.fin(this.N('Member', st, { obj: callee, prop: pt.v, propLine: pt.line, propCol: pt.col, computed: false, optional: false, isMember: true }));
      } else if (k.t === 'p' && k.v === '[') {
        this.next(); const prop = this.parseExpression(); this.expectP(']');
        callee = this.fin(this.N('Member', st, { obj: callee, prop, computed: true, optional: false, isMember: true }));
      } else break;
    }
    const args = this.isP('(') ? this.parseArgs() : [];
    return this.fin(this.N('New', st, { callee, args }));
  }

  parseTemplate() {
    const k = this.next();
    const exprs = k.exprs.map(toks => {
      const sub = new Parser(toks, { inGen: this.inGen, inAsync: this.inAsync });
      const e = sub.parseExpression();
      if (sub.tok.t !== 'eof') sub.fail(`템플릿 식 끝에 불필요한 토큰 '${sub.tok.v || sub.tok.t}'`);
      return e;
    });
    return this.fin(this.N('Template', k, { quasis: k.quasis, exprs }));
  }

  parsePrimary() {
    const k = this.tok;
    switch (k.t) {
      case 'num': this.next(); return this.fin(this.N('Literal', k, { kind: 'num', value: k.v }));
      case 'str': this.next(); return this.fin(this.N('Literal', k, { kind: 'str', value: k.v }));
      case 're': this.next(); return this.fin(this.N('Literal', k, { kind: 're', value: k.v, flags: k.flags }));
      case 'tpl': return this.parseTemplate();
      case 'priv': this.next(); return this.fin(this.N('PrivName', k, { name: k.v }));
      case 'name': {
        if (k.v === 'async') {
          const nx = this.peek();
          if (nx.t === 'kw' && nx.v === 'function' && !nx.nl) return this.parseFunction(false, true);
        }
        this.next();
        return this.fin(this.N('Id', k, { name: k.v, end: k.end }));
      }
      case 'kw':
        switch (k.v) {
          case 'this': this.next(); return this.fin(this.N('This', k, {}));
          case 'null': this.next(); return this.fin(this.N('Literal', k, { kind: 'null', value: 'null' }));
          case 'true': case 'false': this.next(); return this.fin(this.N('Literal', k, { kind: 'bool', value: k.v }));
          case 'function': return this.parseFunction(false, false);
          case 'class': return this.parseClass(false);
          case 'super': this.next(); return this.fin(this.N('Super', k, {}));
          case 'import': {
            this.next();
            if (this.isP('.')) { this.next(); this.next(); return this.fin(this.N('Meta', k, { name: 'import.meta' })); }
            const args = this.parseArgs();
            return this.fin(this.N('ImportCall', k, { args }));
          }
          case 'new': return this.parseNew();
          default: this.fail(`예상하지 못한 키워드 '${k.v}'`);
        }
        break;
      case 'p':
        if (k.v === '(') {
          this.next();
          const sv = this.noIn; this.noIn = false;
          const e = this.parseExpression();
          this.noIn = sv;
          this.expectP(')');
          e.paren = true;
          return e;
        }
        if (k.v === '[') return this.parseArrayLiteral();
        if (k.v === '{') return this.parseObjectLiteral();
        this.fail(`예상하지 못한 토큰 '${k.v}'`);
        break;
      case 'eof': this.fail('식이 중간에 끝났습니다'); break;
      default: break;
    }
    this.fail(`예상하지 못한 토큰 '${k.v || k.t}'`);
  }

  parseArrayLiteral() {
    const st = this.next();
    const elements = [];
    const sv = this.noIn; this.noIn = false;
    while (!this.isP(']')) {
      if (this.isP(',')) { this.next(); elements.push(null); continue; }
      if (this.isP('...')) { const r = this.next(); elements.push(this.N('Spread', r, { arg: this.parseAssign() })); }
      else elements.push(this.parseAssign());
      if (!this.isP(']')) this.expectP(',');
    }
    this.noIn = sv;
    this.next();
    return this.fin(this.N('Array', st, { elements }));
  }

  parseObjectLiteral() {
    const st = this.next();
    const props = [];
    const sv = this.noIn; this.noIn = false;
    while (!this.isP('}')) {
      const pt = this.tok;
      if (this.isP('...')) { this.next(); props.push(this.N('Prop', pt, { kind: 'spread', value: this.parseAssign() })); }
      else {
        let kind = 'init', isAsync = false, isGen = false;
        if (this.isName('async') && !this.isMemberEnd(this.peek()) && !this.peek().nl) { this.next(); isAsync = true; }
        if (this.isP('*')) { this.next(); isGen = true; }
        if ((this.isName('get') || this.isName('set')) && !this.isMemberEnd(this.peek())) kind = this.next().v;
        const kt = this.tok;
        let key, computed = false;
        if (this.isP('[')) { this.next(); key = this.parseAssign(); this.expectP(']'); computed = true; }
        else if (kt.t === 'name' || kt.t === 'kw' || kt.t === 'str' || kt.t === 'num') { this.next(); key = { type: 'Key', name: String(kt.v), line: kt.line, col: kt.col }; }
        else this.fail(`객체 프로퍼티 이름이 필요합니다 (현재 '${kt.v || kt.t}')`);
        if (this.isP('(')) {
          const fn = this.parseFunctionRest(kt, null, isAsync, isGen, 'FuncExpr');
          props.push(this.fin(this.N('Prop', pt, { kind: kind === 'init' ? 'method' : kind, key, computed, value: fn })));
        } else if (this.eatP(':')) {
          props.push(this.fin(this.N('Prop', pt, { kind: 'init', key, computed, value: this.parseAssign() })));
        } else {
          if (kt.t !== 'name') this.fail('단축 프로퍼티에는 식별자가 필요합니다', kt);
          let value = this.N('Id', kt, { name: kt.v, end: kt.end });
          if (this.isP('=')) { this.next(); value = this.N('AssignPattern', kt, { left: value, right: this.parseAssign() }); }
          props.push(this.fin(this.N('Prop', pt, { kind: 'shorthand', key, computed: false, value })));
        }
      }
      if (!this.isP('}')) this.expectP(',');
    }
    this.noIn = sv;
    this.next();
    return this.fin(this.N('Object', st, { props }));
  }
}

function parse(src) {
  const tokens = tokenize(src);
  const p = new Parser(tokens, { src });
  const ast = p.parseProgram();
  ast.tokenCount = tokens.length;
  return ast;
}

module.exports = { parse, tokenize, ParseError, Parser, KEYWORDS };
