'use strict';

const { DEFAULT_CONFIG, FACTOR_LABELS } = require('../config');
const { num } = require('../utils');
const { scoreFactors, fieldAverageWeight } = require('../scoring');
const { validOdds } = require('../expectedValue');
const { buildReasons } = require('../reasons');
const { assessConfidence } = require('../confidence');

/** 見送り判定（v0.1 のまま） */
function judgeSkip(analyzed, winCandidates, config) {
  const reasons = [];
  if (analyzed.length === 0) {
    reasons.push('出走馬データがありません');
  } else {
    if (winCandidates.length === 0) reasons.push('期待値1.0以上の馬がいない');
    const idx = analyzed.map((h) => h.prediction.index).sort((a, b) => b - a);
    if (idx.length >= 3 && idx[0] - idx[2] < config.skip.minTopIndexGap) {
      reasons.push('上位馬の評価差が小さすぎる（混戦）');
    }
    const lowCoverage = analyzed.filter((h) => h.prediction.coverage < config.skip.lowCoverage).length / analyzed.length;
    const missingOdds = analyzed.filter((h) => validOdds(h.odds) === null).length / analyzed.length;
    if (lowCoverage > config.skip.maxLowCoverageRatio || missingOdds > config.skip.maxMissingOddsRatio) {
      reasons.push('欠損データが多く信頼度が低い');
    }
  }
  const skip = reasons.length > 0;
  return {
    skip,
    reasons,
    message: skip ? 'このレースは見送り推奨' : '勝負可能：単勝候補あり',
  };
}

/**
 * v0.1 の予想プロファイル（モックデータ用）。近走成績・騎手評価などを使う。
 * 予想指数・見送り判定はすべて v0.1 と同じ。予想信頼度だけ追加で算出する。
 */
const defaultProfile = {
  id: 'default',
  label: '標準（近走成績ベース）',
  config: DEFAULT_CONFIG,
  factorLabels: FACTOR_LABELS,

  prepare(horses) {
    return { avgWeight: fieldAverageWeight(horses) };
  },

  scoreHorse(horse, ctx) {
    return {
      factors: scoreFactors(horse, ctx.avgWeight),
      samples: {
        primary: num(horse.trackRecord && horse.trackRecord.starts),
        distance: num(horse.sameDistanceRecord && horse.sameDistanceRecord.starts),
      },
    };
  },

  buildReasons(horse, ctx) {
    return buildReasons(horse, ctx);
  },

  judgeSkip,
  assessConfidence: (analyzed) => assessConfidence(analyzed),
};

module.exports = { defaultProfile, judgeSkip };
