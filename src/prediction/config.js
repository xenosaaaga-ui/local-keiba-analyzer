'use strict';

/**
 * 予想ロジックの設定値。
 * 将来の「重み調整」「バックテストによる最適化」はこのオブジェクトを差し替えて行う。
 */
const DEFAULT_CONFIG = Object.freeze({
  // 予想指数の基本ウェイト（合計 1.0）
  weights: Object.freeze({
    recentForm: 0.35, // 近走成績
    distance: 0.2, // 距離適性
    course: 0.15, // 競馬場適性（当地成績 + 馬場適性）
    jockey: 0.1, // 騎手評価
    weight: 0.1, // 斤量
    classRest: 0.1, // クラス / 休養
  }),
  // 予想指数 → 予測勝率（softmax）
  probability: Object.freeze({
    temperature: 7, // 小さいほど上位に集中
    maxProb: 0.6, // 1頭の勝率がこれを超える場合は温度を上げて平準化
    uniformBlend: 0.02, // 一様分布とのブレンド率（極端な0%/100%を防ぐ）
  }),
  // 期待値の表示区分
  ev: Object.freeze({ high: 1.2, value: 1.0, fair: 0.8 }),
  // ☆（穴候補）の条件
  marks: Object.freeze({ anaMinEv: 1.0, anaMinPopularity: 4, anaMinProb: 0.03, maxDelta: 2 }),
  // 買い目候補
  candidates: Object.freeze({ winMinEv: 1.0, winMinProb: 0.05, maxWin: 3, maxQuinella: 3 }),
  // 危険な人気馬
  danger: Object.freeze({ maxPopularity: 3, maxEv: 0.8 }),
  // 見送り判定
  skip: Object.freeze({ minTopIndexGap: 4, lowCoverage: 0.7, maxLowCoverageRatio: 0.3, maxMissingOddsRatio: 0.25 }),
});

const FACTOR_LABELS = Object.freeze({
  recentForm: '近走成績',
  distance: '距離適性',
  course: '競馬場適性',
  jockey: '騎手評価',
  weight: '斤量',
  classRest: 'クラス/休養',
});

module.exports = { DEFAULT_CONFIG, FACTOR_LABELS };
