'use strict';
// 사용자별 작업 공간 (메모리). AI가 만든 파일을 보관하고, zip 으로 내려받게 한다.
// 제한: 파일 200개, 파일당 512KB, 공간당 5MB, 허용 확장자만, .env·node_modules·.git 금지, 유휴 3시간 후 삭제.
const TTL = Number(process.env.WORKSPACE_TTL_MIN || 720) * 60_000;   // 기본 12시간
const MAX_FILES = 200, MAX_FILE = 512 * 1024, MAX_TOTAL = 5 * 1024 * 1024;
const PATH_RE = /^[A-Za-z0-9_.][A-Za-z0-9_.\-\/]{0,199}$/;
const EXT_OK = /\.(js|mjs|cjs|ts|json|html|css|md|txt|py|yml|yaml|csv|svg|gitignore|example|toml|sh|lua|luau|rbxmx|rbxlx|xml|ini|cfg|bat|ps1|ts|tsx|jsx|vue|sql|log|conf)$/i;
const BLOCKED = /(^|\/)\.env($|\.)|(^|\/)node_modules\/|(^|\/)\.git\//i;
const spaces = new Map();   // owner -> { files: Map<path, {content, bytes}>, bytes, t }

function checkPath(p) {
  if (typeof p !== 'string' || !PATH_RE.test(p)) throw new Error('경로 형식이 올바르지 않습니다 (영문·숫자·_·-·/ 만 허용)');
  if (p.includes('..') || p.includes('//') || p.endsWith('/')) throw new Error('잘못된 경로입니다');
  if (p.split('/').length > 6) throw new Error('경로 깊이는 6단계 이하여야 합니다');
  if (BLOCKED.test(p)) throw new Error('이 경로는 쓸 수 없습니다 (비밀 파일 또는 의존성 폴더)');
  if (!EXT_OK.test(p) && !/(^|\/)(Dockerfile|Procfile|LICENSE)$/.test(p)) throw new Error('허용되지 않은 파일 형식입니다');
  return p;
}
function sweep() {
  const now = Date.now();
  for (const [o, s] of spaces) if (now - s.t > TTL) spaces.delete(o);
}
function space(owner, create = false) {
  if (!owner) throw new Error('로그인한 사용자만 작업 공간을 쓸 수 있습니다');
  sweep();
  let s = spaces.get(owner);
  if (!s && create) { s = { files: new Map(), bytes: 0, t: Date.now() }; spaces.set(owner, s); }
  if (s) s.t = Date.now();
  return s || null;
}
function writeFile(owner, path, content) {
  const p = checkPath(path);
  if (typeof content !== 'string') throw new Error('content 는 문자열이어야 합니다');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_FILE) throw new Error('파일은 512KB 이하여야 합니다');
  const s = space(owner, true);
  const old = s.files.get(p);
  const total = s.bytes - (old ? old.bytes : 0) + bytes;
  if (total > MAX_TOTAL) throw new Error('작업 공간 용량(5MB)을 초과합니다');
  if (!old && s.files.size >= MAX_FILES) throw new Error('파일 개수 상한(200)을 초과합니다');
  s.files.set(p, { content, bytes });
  s.bytes = total;
  return { path: p, bytes };
}
function readFile(owner, path) {
  const s = space(owner);
  const f = s && s.files.get(checkPath(path));
  if (!f) throw new Error(`파일이 없습니다: ${path}`);
  return f.content;
}
const has = (owner, path) => { const s = space(owner); return !!(s && s.files.has(path)); };
function deleteFile(owner, path) {
  const s = space(owner);
  const f = s && s.files.get(checkPath(path));
  if (!f) return false;
  s.files.delete(path); s.bytes -= f.bytes;
  return true;
}
function listFiles(owner) {
  const s = space(owner);
  return s ? [...s.files.entries()].map(([path, f]) => ({ path, bytes: f.bytes })).sort((a, b) => a.path.localeCompare(b.path)) : [];
}
function allFiles(owner) {
  const s = space(owner);
  return s ? [...s.files.entries()].map(([path, f]) => ({ path, content: f.content })) : [];
}
function clear(owner) { return spaces.delete(owner); }
function stats(owner) {
  const s = space(owner);
  return { files: s ? s.files.size : 0, bytes: s ? s.bytes : 0, maxFiles: MAX_FILES, maxBytes: MAX_TOTAL };
}

// ---------- zip (무압축 store 방식, 외부 라이브러리 없음) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = buf => {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
};
function zipStore(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.from(e.data, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}
function zip(owner, only) {
  let files = allFiles(owner);
  if (Array.isArray(only) && only.length) { const want = new Set(only); files = files.filter(f => want.has(f.path)); }
  if (!files.length) throw new Error('작업 공간에 파일이 없습니다');
  return zipStore(files.map(f => ({ name: f.path, data: f.content })));
}

module.exports = { checkPath, writeFile, readFile, has, deleteFile, listFiles, allFiles, clear, stats, zip, zipStore, crc32 };
