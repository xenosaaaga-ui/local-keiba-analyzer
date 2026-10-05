'use strict';

const { num, round } = require('./utils');
const { DEFAULT_CONFIG } = require('./config');

/** 単勝オッズとして有効（1.0倍以上の有限数）なら数値、そうでなければ null */
function validOdds(odds) {
  const o = num(odds);
  return o !== null && o >= 1 ? o : null;
}

/** 単勝期待値 = 予測勝率 × 単勝オッズ。オッズ未取得なら null */
function expectedValue(winProb, odds) {
  const p = num(winProb);
  const o = validOdds(odds);
  if (p === null || o === null || p < 0) return null;
  return round(p * o, 2);
}

function evRating(ev, thresholds = DEFAULT_CONFIG.ev) {
  const v = num(ev);
  if (v === null) return { key: 'none', label: 'オッズ未取得' };
  if (v >= thresholds.high) return { key: 'high', label: '高期待値' };
  if (v >= thresholds.value) return { key: 'value', label: '妙味あり' };
  if (v >= thresholds.fair) return { key: 'fair', label: 'やや割高' };
  return { key: 'low', label: '妙味低い' };
}

/** オッズ順の人気（1始まり）。オッズ未取得は null */
function popularityRanks(oddsList) {
  const items = oddsList
    .map((o, i) => ({ o: validOdds(o), i }))
    .filter((x) => x.o !== null)
    .sort((a, b) => a.o - b.o || a.i - b.i);
  const ranks = new Array(oddsList.length).fill(null);
  items.forEach((x, rank) => {
    ranks[x.i] = rank + 1;
  });
  return ranks;
}

/** オッズから逆算した市場の勝率（控除率分を正規化） */
function marketProbabilities(oddsList) {
  const inv = oddsList.map((o) => {
    const v = validOdds(o);
    return v === null ? null : 1 / v;
  });
  const sum = inv.reduce((a, b) => a + (b ?? 0), 0);
  return inv.map((v) => (v === null || sum <= 0 ? null : v / sum));
}

module.exports = { validOdds, expectedValue, evRating, popularityRanks, marketProbabilities };
