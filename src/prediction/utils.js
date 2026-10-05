'use strict';

/** 有限の数値なら number、それ以外（null/undefined/NaN/Infinity/文字列化できない値）は null */
function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function round(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** 配列でなければ空配列 */
function arr(value) {
  return Array.isArray(value) ? value : [];
}

/** NaN / Infinity を null に置き換えたコピーを返す（出力に異常値を出さないため） */
function sanitize(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v)]));
  }
  return value;
}

module.exports = { num, clamp, round, arr, sanitize };
