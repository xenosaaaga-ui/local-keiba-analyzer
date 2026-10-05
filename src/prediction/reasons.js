'use strict';

const { num, arr } = require('./utils');
const { FACTOR_LABELS } = require('./config');
const { finishPos, placeRate } = require('./scoring');

/**
 * 人間が読める評価理由を 2〜5 個生成する（プラス最大3・マイナス最大2）。
 * 各候補に strength を持たせ、強いものから採用する。
 */
function buildReasons(horse, ctx) {
  const h = horse && typeof horse === 'object' ? horse : {};
  const plus = [];
  const minus = [];
  const add = (list, text, strength) => list.push({ text, strength });

  // 近走
  const recent = arr(h.recentFinishes).slice(0, 3).map(finishPos).filter((p) => p !== null);
  if (recent.length >= 2) {
    const top3 = recent.filter((p) => p <= 3).length;
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    if (top3 >= 2) add(plus, `近${recent.length}走中${top3}回3着内と安定`, 0.8 + top3 * 0.05);
    else if (avg >= 7) add(minus, '近走は着順が振るわない', 0.75);
  }
  const last = finishPos(arr(h.recentFinishes)[0]);
  if (last === 1) add(plus, '前走1着で勢いあり', 0.85);
  if (recent.length === 0) add(minus, '近走データが不足', 0.6);

  // 距離
  const distRate = placeRate(h.sameDistanceRecord);
  const distStarts = num(h.sameDistanceRecord && h.sameDistanceRecord.starts);
  if (distRate !== null && distStarts >= 2 && distRate >= 0.4) add(plus, '同距離で好走実績あり', 0.6 + distRate * 0.3);
  else if (distRate !== null && distStarts >= 3 && distRate < 0.15) add(minus, '同距離で結果が出ていない', 0.55);
  else if (distStarts === 0) add(minus, '今回距離は未経験', 0.5);

  // 当地
  const trackRate = placeRate(h.trackRecord);
  const trackStarts = num(h.trackRecord && h.trackRecord.starts);
  if (trackRate !== null && trackStarts >= 2 && trackRate >= 0.4) add(plus, '当地成績が優秀', 0.55 + trackRate * 0.3);
  else if (trackStarts === 0) add(minus, '当地は初出走', 0.45);

  const apt = num(h.surfaceAptitude);
  if (apt !== null && apt >= 4) add(plus, '馬場適性が高い', 0.5 + (apt - 4) * 0.1);
  else if (apt !== null && apt <= 2) add(minus, '馬場適性に不安', 0.45);

  // 騎手
  const jr = num(h.jockeyRating);
  if (jr !== null && jr >= 75) add(plus, '騎手評価が高い', 0.5 + (jr - 75) / 100);
  else if (jr !== null && jr < 40) add(minus, '騎手評価は低め', 0.4);

  // 斤量
  const w = num(h.weight);
  const lw = num(h.lastWeight);
  if (w !== null && lw !== null) {
    if (w - lw >= 1) add(minus, `斤量増(+${w - lw}kg)がマイナス`, 0.5 + (w - lw) * 0.05);
    else if (lw - w >= 1) add(plus, `斤量減(${w - lw}kg)がプラス`, 0.45);
  }

  // クラス / 休養
  const cr = num(h.classRating);
  if (cr !== null && cr >= 72) add(plus, 'クラス上位の実力', 0.5);
  const rest = num(h.restDays);
  if (rest !== null && rest > 90) add(minus, `休養明け(${rest}日)が不安`, 0.6 + Math.min(rest, 240) / 1000);
  else if (rest !== null && rest >= 0 && rest <= 9) add(minus, '間隔が詰まっており疲労が心配', 0.45);

  // オッズ妙味
  const ev = num(ctx.ev);
  const pop = num(ctx.popularity);
  const prob = num(ctx.winProb) ?? 0;
  if (ev === null) add(minus, 'オッズ未取得のため期待値は算出不可', 0.7);
  else if (ev >= 1.2 && prob < 0.05) add(minus, '期待値は高いが勝率自体が低く大穴扱い', 0.65);
  else if (ev >= 1.2 && pop !== null && pop >= 4) add(plus, 'AI評価に対してオッズが高く妙味あり', 0.95);
  else if (ev >= 1.2) add(plus, '評価に対してオッズに妙味あり', 0.7);
  else if (ev < 0.8 && pop !== null && pop <= 3) add(minus, '近走内容に対して人気しすぎ', 0.9);

  if (num(ctx.coverage) !== null && ctx.coverage < 0.6) add(minus, 'データ不足で評価の信頼度が低め', 0.85);

  // どちらかが空なら、最も良い / 悪いファクターで補完する
  const factors = Object.entries(ctx.factors || {}).filter(([, v]) => num(v) !== null);
  if (factors.length) {
    const sorted = factors.slice().sort((a, b) => b[1] - a[1]);
    if (!plus.length) add(plus, `${FACTOR_LABELS[sorted[0][0]]}は他項目より良好`, 0.1);
    if (!minus.length) add(minus, `${FACTOR_LABELS[sorted[sorted.length - 1][0]]}はやや見劣る`, 0.1);
  }
  if (!plus.length) add(plus, '強調できる材料は少ない', 0);
  if (!minus.length) add(minus, '判断材料が少ない', 0);

  const pick = (list, n) =>
    list
      .sort((a, b) => b.strength - a.strength)
      .slice(0, n)
      .map(({ text }) => text);
  return [
    ...pick(plus, 3).map((text) => ({ type: 'plus', text })),
    ...pick(minus, 2).map((text) => ({ type: 'minus', text })),
  ];
}

module.exports = { buildReasons };
