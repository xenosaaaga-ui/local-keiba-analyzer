'use strict';

const zlib = require('zlib');
const { parseCsv, findFile, toInt, toNum } = require('./parse');

/**
 * NAR 月次ファイル（レース情報）から、近走の照合に必要な項目だけを取り出す。
 * 月次の出馬表には競走成績（着順・タイム・着差・上がり3F）も入っている。
 *
 * 保存用のコンパクト形式（JSON → gzip）:
 *   races: [date, track, raceNo, distance, surface, going, raceName][]
 *   runs:  [horseKey, raceIndex, finish, marginText, timeSec, last3F, behindSec, runners][]
 */

// 出走していない（取消・除外・取止め）走は近走に含めない
const DID_NOT_START = /取消|除外|取止/;

/** 馬名 + 生年月日（公式に馬を一意に特定するIDは無いため） */
const horseKey = (name, birthDate) => `${name}|${birthDate}`;

/** 走破タイム "1270" → 87.0秒（m ss d）。"589" → 58.9秒 */
function parsePackedTime(value) {
  const s = String(value || '').trim();
  if (!/^\d{3,5}$/.test(s)) return null;
  const n = Number(s);
  const sec = Math.floor(n / 1000) * 60 + (n % 1000) / 10;
  return sec > 0 ? Math.round(sec * 10) / 10 : null;
}

/** 月次レース情報 ZIP の展開結果 → コンパクト形式 */
function compactMonthly(files) {
  const racelist = findFile(files, '_racelist.csv');
  const horselist = findFile(files, '_horselist.csv');
  if (!racelist || !horselist) throw new Error('月次 race.zip に racelist / horselist がありません');

  const races = [];
  const raceIndex = new Map();
  for (const r of parseCsv(racelist)) {
    const raceNo = toInt(r['レース番号']);
    if (!r['競馬場'] || !r['競走年月日'] || raceNo === null) continue;
    raceIndex.set(`${r['競馬場']}#${r['競走年月日']}#${raceNo}`, races.length);
    races.push([r['競走年月日'], r['競馬場'], raceNo, toInt(r['距離']), r['芝ダート区分'] || null, r['馬場'] || null, r['レース名'] || null]);
  }

  // レースごとにまとめて、勝ち馬とのタイム差・出走頭数を計算する
  const byRace = new Map();
  for (const h of parseCsv(horselist)) {
    const idx = raceIndex.get(`${h['競馬場']}#${h['競走年月日']}#${toInt(h['レース番号'])}`);
    if (idx === undefined || !h['馬名'] || !h['生年月日']) continue;
    const margin = h['着差'] || '';
    if (DID_NOT_START.test(margin)) continue;
    const finish = toInt(h['着順']); // 競走中止・失格などは null
    (byRace.get(idx) || byRace.set(idx, []).get(idx)).push({
      key: horseKey(h['馬名'], h['生年月日']),
      finish: finish !== null && finish >= 1 ? finish : null,
      margin: margin || null,
      time: parsePackedTime(h['タイム']),
      last3F: toNum(h['上がり3F']),
    });
  }

  const runs = [];
  for (const [idx, entries] of byRace) {
    const timed = entries.filter((e) => e.finish !== null && e.time !== null).sort((a, b) => a.finish - b.finish || a.time - b.time);
    const winner = timed[0] && timed[0].finish === 1 ? timed[0].time : null;
    const second = timed.find((e) => e.finish >= 2);
    for (const e of entries) {
      let behind = null;
      if (winner !== null && e.time !== null && e.finish !== null) {
        // 勝ち馬は2着とのタイム差をマイナスで持つ（モックの recentMargins と同じ規約）
        behind = e.finish === 1 ? (second ? -(second.time - winner) : 0) : e.time - winner;
        behind = Math.round(behind * 10) / 10;
      }
      runs.push([e.key, idx, e.finish, e.margin, e.time, e.last3F, behind, entries.length]);
    }
  }
  return { races, runs };
}

const encode = (compact) => zlib.gzipSync(Buffer.from(JSON.stringify(compact)));
const decode = (buf) => JSON.parse(zlib.gunzipSync(buf).toString('utf8'));

module.exports = { compactMonthly, parsePackedTime, horseKey, encode, decode };
