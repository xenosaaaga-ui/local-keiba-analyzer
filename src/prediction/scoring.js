'use strict';

const { num, clamp, round, arr } = require('./utils');

/**
 * 各ファクターを 0〜1 のスコアに正規化する。データが無い場合は null を返し、
 * 予想指数の計算時にウェイトを再正規化する。
 */

const RECENCY_WEIGHTS = [0.35, 0.25, 0.18, 0.12, 0.1];

/** 着順として有効な整数（1以上）なら返す */
function finishPos(v) {
  const n = num(v);
  return n !== null && n >= 1 ? Math.round(n) : null;
}

/** 近走成績: 着順と着差（秒）を直近ほど重く評価 */
function scoreRecentForm(horse) {
  const finishes = arr(horse.recentFinishes);
  const margins = arr(horse.recentMargins);
  let total = 0;
  let wsum = 0;
  for (let i = 0; i < RECENCY_WEIGHTS.length; i++) {
    const pos = finishPos(finishes[i]);
    if (pos === null) continue;
    const posScore = Math.exp(-0.22 * (pos - 1));
    const m = num(margins[i]);
    let s = posScore;
    if (m !== null) {
      const marginScore = m <= 0 ? 1 : Math.exp(-m / 0.8);
      s = 0.65 * posScore + 0.35 * marginScore;
    }
    total += RECENCY_WEIGHTS[i] * s;
    wsum += RECENCY_WEIGHTS[i];
  }
  return wsum > 0 ? clamp(total / wsum, 0, 1) : null;
}

/**
 * 成績レコード {starts, wins, places(3着内)} をスコア化。
 * 出走数が少ない場合に極端な値にならないよう事前分布で平滑化する。
 */
function scoreRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const starts = num(record.starts);
  if (starts === null || starts <= 0) return null;
  const wins = clamp(num(record.wins) ?? 0, 0, starts);
  const places = clamp(num(record.places) ?? wins, wins, starts);
  const perf = wins + (places - wins) * 0.5;
  const prior = 0.25;
  const k = 2;
  return clamp((perf + prior * k) / (starts + k) / 0.6, 0, 1);
}

/** 3着内率（理由表示用） */
function placeRate(record) {
  if (!record || typeof record !== 'object') return null;
  const starts = num(record.starts);
  if (starts === null || starts <= 0) return null;
  return clamp((num(record.places) ?? 0) / starts, 0, 1);
}

function scoreDistance(horse) {
  return scoreRecord(horse.sameDistanceRecord);
}

/** 競馬場適性: 当地成績 70% + 馬場適性(1〜5) 30% */
function scoreCourse(horse) {
  const rec = scoreRecord(horse.trackRecord);
  const aptRaw = num(horse.surfaceAptitude);
  const apt = aptRaw === null ? null : clamp((aptRaw - 1) / 4, 0, 1);
  if (rec === null && apt === null) return null;
  if (rec === null) return apt;
  if (apt === null) return rec;
  return 0.7 * rec + 0.3 * apt;
}

function scoreJockey(horse) {
  const r = num(horse.jockeyRating);
  return r === null ? null : clamp(r / 100, 0, 1);
}

/** 斤量: 出走馬平均より軽いほどプラス、前走からの斤量増はマイナス */
function scoreWeight(horse, fieldAvgWeight) {
  const w = num(horse.weight);
  if (w === null || w <= 0) return null;
  const avg = num(fieldAvgWeight) ?? w;
  let s = 0.6 - (w - avg) * 0.07;
  const last = num(horse.lastWeight);
  if (last !== null && last > 0) s -= (w - last) * 0.06;
  return clamp(s, 0, 1);
}

function restScore(days) {
  const d = num(days);
  if (d === null || d < 0) return null;
  if (d <= 9) return 0.7;
  if (d <= 60) return 1;
  if (d <= 120) return 0.7;
  if (d <= 180) return 0.5;
  return 0.3;
}

/** クラス / 休養: クラス評価 60% + 休養 40% */
function scoreClassRest(horse) {
  const c = num(horse.classRating);
  const cls = c === null ? null : clamp(c / 100, 0, 1);
  const rest = restScore(horse.restDays);
  if (cls === null && rest === null) return null;
  if (cls === null) return rest;
  if (rest === null) return cls;
  return 0.6 * cls + 0.4 * rest;
}

function fieldAverageWeight(horses) {
  const ws = arr(horses).map((h) => num(h && h.weight)).filter((w) => w !== null && w > 0);
  return ws.length ? ws.reduce((a, b) => a + b, 0) / ws.length : null;
}

function scoreFactors(horse, fieldAvgWeight) {
  const h = horse && typeof horse === 'object' ? horse : {};
  return {
    recentForm: scoreRecentForm(h),
    distance: scoreDistance(h),
    course: scoreCourse(h),
    jockey: scoreJockey(h),
    weight: scoreWeight(h, fieldAvgWeight),
    classRest: scoreClassRest(h),
  };
}

/**
 * ファクタースコアから 0〜100 の予想指数を算出。
 * 欠損ファクターは除外してウェイトを再正規化し、カバー率が低いほど平均(50)へ寄せる。
 */
function computeIndex(factors, weights) {
  let wTotal = 0;
  let wAvail = 0;
  let sum = 0;
  for (const [key, w] of Object.entries(weights)) {
    const weight = num(w);
    if (weight === null || weight <= 0) continue;
    wTotal += weight;
    const s = factors ? num(factors[key]) : null;
    if (s === null) continue;
    wAvail += weight;
    sum += weight * clamp(s, 0, 1);
  }
  const coverage = wTotal > 0 ? wAvail / wTotal : 0;
  if (wAvail <= 0) return { index: 50, coverage: 0 };
  const raw = (sum / wAvail) * 100;
  const index = 50 + (raw - 50) * (0.6 + 0.4 * coverage);
  return { index: round(clamp(index, 0, 100), 1), coverage: round(coverage, 2) };
}

module.exports = {
  scoreRecentForm,
  scoreRecord,
  placeRate,
  scoreCourse,
  scoreWeight,
  scoreClassRest,
  scoreFactors,
  computeIndex,
  fieldAverageWeight,
  finishPos,
};
