'use strict';

const { num } = require('./utils');

const LEVELS = Object.freeze({
  high: { key: 'high', label: '高' },
  medium: { key: 'medium', label: '中' },
  low: { key: 'low', label: '低' },
});

const DEFAULT_THRESHOLDS = Object.freeze({
  coverage: [0.6, 0.8], // 平均データカバー率: 1点 / 2点
  primaryStarts: 5, // 「主成績のサンプルが十分」とみなす出走数
  primaryShare: [0.4, 0.7], // 主成績が十分な馬の割合: 1点 / 2点（2点は距離成績の条件も必要）
  distanceShare: 0.5, // 距離成績がある馬の割合（2点の条件）
  gap: [3, 6], // 予想指数 1位と3位の差: 1点 / 2点
  levels: [3, 5], // 合計点: 中 / 高（満点6）
});

const share = (list, pred) => (list.length ? list.filter(pred).length / list.length : 0);
const pct = (v) => `${Math.round(v * 100)}%`;

/**
 * 予想信頼度（高 / 中 / 低）。見送り判定とは独立に、予想そのものをどの程度信用できるかを示す。
 *  - 利用できたデータ項目（平均カバー率）
 *  - 成績のサンプル数（主成績が十分な馬・距離成績がある馬の割合）
 *  - 上位馬の指数差
 * をそれぞれ 0〜2 点で評価し、合計で判定する。
 *
 * @param {Array} analyzed 分析済みの馬（prediction.coverage / prediction.index / prediction.samples）
 */
function assessConfidence(analyzed, thresholds = DEFAULT_THRESHOLDS) {
  const t = thresholds;
  const n = analyzed.length;
  if (n === 0) return { ...LEVELS.low, score: 0, details: ['出走馬データがありません'] };

  const coverage = analyzed.reduce((s, h) => s + (num(h.prediction.coverage) ?? 0), 0) / n;
  const samples = analyzed.map((h) => h.prediction.samples || {});
  const primaryOk = share(samples, (s) => (num(s.primary) ?? 0) >= t.primaryStarts);
  const distanceOk = share(samples, (s) => (num(s.distance) ?? 0) >= 1);
  const idx = analyzed.map((h) => num(h.prediction.index) ?? 50).sort((a, b) => b - a);
  const gap = idx.length >= 3 ? idx[0] - idx[2] : idx.length === 2 ? idx[0] - idx[1] : 0;

  const dataPts = coverage >= t.coverage[1] ? 2 : coverage >= t.coverage[0] ? 1 : 0;
  const samplePts = primaryOk >= t.primaryShare[1] && distanceOk >= t.distanceShare ? 2 : primaryOk >= t.primaryShare[0] ? 1 : 0;
  const gapPts = gap >= t.gap[1] ? 2 : gap >= t.gap[0] ? 1 : 0;
  const score = dataPts + samplePts + gapPts;
  const level = score >= t.levels[1] ? LEVELS.high : score >= t.levels[0] ? LEVELS.medium : LEVELS.low;

  return {
    ...level,
    score,
    details: [
      `利用データ: 平均${pct(coverage)}`,
      `成績サンプル: ${t.primaryLabel || '十分な馬'}${pct(primaryOk)}・距離実績あり${pct(distanceOk)}`,
      `上位の指数差: ${gap.toFixed(1)}`,
    ],
    metrics: { coverage: Math.round(coverage * 100) / 100, primaryOk: Math.round(primaryOk * 100) / 100, distanceOk: Math.round(distanceOk * 100) / 100, gap: Math.round(gap * 10) / 10 },
  };
}

module.exports = { assessConfidence, LEVELS, DEFAULT_THRESHOLDS };
