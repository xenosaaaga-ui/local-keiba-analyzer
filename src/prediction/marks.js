'use strict';

const { num } = require('./utils');
const { DEFAULT_CONFIG } = require('./config');
const { withinMarketGuard } = require('./expectedValue');

const MARKS = Object.freeze({
  honmei: { symbol: '◎', label: '本命' },
  taikou: { symbol: '○', label: '対抗' },
  tanana: { symbol: '▲', label: '単穴' },
  renka: { symbol: '△', label: '連下' },
  ana: { symbol: '☆', label: '穴候補' },
});

/** 予測勝率 → 予想指数 → 馬番 の順で並べる（同点でも順序が決まる） */
function rankOrder(horses) {
  return horses
    .map((h, i) => ({ h, i }))
    .sort(
      (a, b) =>
        (num(b.h.winProb) ?? 0) - (num(a.h.winProb) ?? 0) ||
        (num(b.h.index) ?? 0) - (num(a.h.index) ?? 0) ||
        (num(a.h.number) ?? a.i) - (num(b.h.number) ?? b.i),
    )
    .map((x) => x.i);
}

/**
 * 印を付ける。戻り値は入力と同じ並びの印キー配列（印なしは null）。
 *  ◎○▲ : 予測勝率の上位3頭
 *  ☆   : 残りの中から「人気薄・期待値が高い・勝率が極端に低くない」馬（期待値最大）
 *  △   : 残りの予測勝率上位から最大2頭
 */
function assignMarks(horses, config = DEFAULT_CONFIG) {
  const list = Array.isArray(horses) ? horses : [];
  const marks = new Array(list.length).fill(null);
  const order = rankOrder(list);
  const top = ['honmei', 'taikou', 'tanana'];
  order.slice(0, 3).forEach((idx, k) => {
    marks[idx] = top[k];
  });

  const rest = order.slice(3);
  const c = config.marks;
  const anaCandidates = rest.filter((idx) => {
    const h = list[idx];
    const ev = num(h.ev);
    const pop = num(h.popularity);
    return (
      ev !== null &&
      ev >= c.anaMinEv &&
      pop !== null &&
      pop >= c.anaMinPopularity &&
      (num(h.winProb) ?? 0) >= c.anaMinProb &&
      withinMarketGuard(h.winProb, h.marketProb, c.maxModelMarketRatio)
    );
  });
  if (anaCandidates.length) {
    const best = anaCandidates.reduce((a, b) => ((num(list[b].ev) ?? 0) > (num(list[a].ev) ?? 0) ? b : a));
    marks[best] = 'ana';
  }

  rest
    .filter((idx) => marks[idx] === null)
    .slice(0, c.maxDelta)
    .forEach((idx) => {
      marks[idx] = 'renka';
    });
  return marks;
}

module.exports = { assignMarks, rankOrder, MARKS };
