'use strict';
// 데이터셋 저장소 (메모리): 사용자별 격리, 건당 10MB, 전체 용량·유효기간 상한
// Render 재시작 시 사라진다(무료 플랜은 디스크가 지속되지 않음). 영구 보관이 필요하면 DB/디스크 저장으로 교체.
const crypto = require('crypto');

const MAX_DATASET = 10 * 1024 * 1024;
const MAX_TOTAL = Number(process.env.DATA_STORE_MAX_MB || 200) * 1024 * 1024;
const TTL = Number(process.env.DATA_STORE_TTL_MIN || 120) * 60_000;

const items = new Map();   // id -> { owner, name, text, bytes, t, createdAt }
let total = 0;

function remove(id) {
  const v = items.get(id);
  if (!v) return false;
  total -= v.bytes;
  items.delete(id);
  return true;
}
function sweep() {
  const now = Date.now();
  for (const [id, v] of items) if (now - v.t > TTL) remove(id);
}
function put(owner, name, text) {
  if (!owner) throw new Error('로그인한 사용자만 데이터셋을 저장할 수 있습니다');
  if (typeof text !== 'string' || !text.length) throw new Error('빈 데이터입니다');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_DATASET) throw new Error(`데이터셋은 10MB 이하여야 합니다 (현재 ${(bytes / 1048576).toFixed(1)}MB)`);
  sweep();
  while (total + bytes > MAX_TOTAL && items.size) remove(items.keys().next().value);   // 가장 오래된 것부터 제거
  const id = 'ds_' + crypto.randomBytes(8).toString('hex');
  const now = Date.now();
  items.set(id, { owner, name: String(name || 'dataset').slice(0, 80), text, bytes, t: now, createdAt: now });
  total += bytes;
  return { id, name: items.get(id).name, bytes, createdAt: now };
}
function get(owner, id) {
  sweep();
  const v = items.get(String(id));
  if (!v || v.owner !== owner) return null;
  v.t = Date.now();
  return v.text;
}
function list(owner) {
  sweep();
  return [...items.entries()].filter(([, v]) => v.owner === owner)
    .map(([id, v]) => ({ id, name: v.name, bytes: v.bytes, createdAt: v.createdAt }))
    .sort((a, b) => b.createdAt - a.createdAt);
}
function removeOwned(owner, id) {
  const v = items.get(String(id));
  if (!v || v.owner !== owner) return false;
  return remove(String(id));
}
const stats = () => ({ datasets: items.size, totalBytes: total, maxTotalBytes: MAX_TOTAL, maxDatasetBytes: MAX_DATASET });

module.exports = { put, get, list, remove: removeOwned, stats, MAX_DATASET };
