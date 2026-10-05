'use strict';

const { DEFAULT_CONFIG, FACTOR_LABELS } = require('./config');
const { num, round, arr, sanitize } = require('./utils');
const { scoreFactors, computeIndex, fieldAverageWeight } = require('./scoring');
const { winProbabilities } = require('./probability');
const { validOdds, expectedValue, evRating, popularityRanks, marketProbabilities } = require('./expectedValue');
const { assignMarks, rankOrder, MARKS } = require('./marks');
const { buildReasons } = require('./reasons');

function brief(h) {
  if (!h) return null;
  return {
    number: h.number,
    name: h.name,
    mark: h.prediction.mark,
    winProb: h.prediction.winProb,
    odds: h.odds,
    ev: h.prediction.ev,
    index: h.prediction.index,
    popularity: h.prediction.popularity,
  };
}

/** 見送り判定 */
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

/** 馬連の組み合わせ候補（オッズ無しの v0.1 では組み合わせのみ） */
function quinellaCandidates(byMark, config) {
  const h = byMark;
  const pairs = [];
  const push = (a, b, note) => {
    if (!a || !b || a.number === b.number) return;
    if (pairs.some((p) => p.numbers.includes(a.number) && p.numbers.includes(b.number))) return;
    pairs.push({
      numbers: [a.number, b.number].sort((x, y) => x - y),
      label: `${a.prediction.markSymbol}${a.number}-${b.prediction.markSymbol}${b.number}`,
      names: [a.name, b.name],
      note,
    });
  };
  push(h.honmei, h.taikou, '本線');
  push(h.honmei, h.tanana, '本線');
  push(h.honmei, h.ana, '穴');
  push(h.taikou, h.tanana, '押さえ');
  push(h.honmei, h.renka, '押さえ');
  return pairs.slice(0, config.candidates.maxQuinella);
}

/**
 * レースを分析する。入力の欠損・異常値に対して例外を投げず、NaN/Infinity を出さない。
 * @param {object} race データアダプターが返すレース
 * @param {object} [config]
 */
function analyzeRace(race, config = DEFAULT_CONFIG) {
  const r = race && typeof race === 'object' ? race : {};
  const horses = arr(r.horses)
    .filter((h) => h && typeof h === 'object')
    .map(sanitize);

  const avgWeight = fieldAverageWeight(horses);
  const scored = horses.map((h) => {
    const factors = scoreFactors(h, avgWeight);
    return { factors, ...computeIndex(factors, config.weights) };
  });

  const probs = winProbabilities(scored.map((s) => s.index), config.probability);
  const oddsList = horses.map((h) => h.odds);
  const pops = popularityRanks(oddsList);
  const market = marketProbabilities(oddsList);

  const analyzed = horses.map((h, i) => {
    const winProb = probs[i];
    const ev = expectedValue(winProb, h.odds);
    return {
      ...h,
      odds: validOdds(h.odds),
      prediction: {
        index: scored[i].index,
        coverage: scored[i].coverage,
        factors: Object.fromEntries(
          Object.entries(scored[i].factors).map(([k, v]) => [k, v === null ? null : round(v * 100, 0)]),
        ),
        winProb: round(winProb, 4),
        ev,
        evRating: evRating(ev, config.ev),
        popularity: pops[i],
        marketProb: market[i] === null ? null : round(market[i], 4),
      },
    };
  });

  // 印
  const markInput = analyzed.map((h) => ({
    number: h.number,
    winProb: h.prediction.winProb,
    index: h.prediction.index,
    ev: h.prediction.ev,
    popularity: h.prediction.popularity,
  }));
  const marks = assignMarks(markInput, config);
  const byMark = {};
  analyzed.forEach((h, i) => {
    const key = marks[i];
    h.prediction.mark = key;
    h.prediction.markSymbol = key ? MARKS[key].symbol : '';
    h.prediction.markLabel = key ? MARKS[key].label : '';
    if (key && !byMark[key]) byMark[key] = h;
  });

  // 評価理由
  analyzed.forEach((h) => {
    h.prediction.reasons = buildReasons(h, {
      ev: h.prediction.ev,
      winProb: h.prediction.winProb,
      popularity: h.prediction.popularity,
      coverage: h.prediction.coverage,
      factors: scored[analyzed.indexOf(h)].factors,
    });
  });

  // 予想順に並べ替え（表示用）
  const order = rankOrder(markInput);
  order.forEach((idx, rank) => {
    analyzed[idx].prediction.rank = rank + 1;
  });

  // 単勝候補
  const winCandidates = analyzed
    .filter((h) => (num(h.prediction.ev) ?? 0) >= config.candidates.winMinEv && h.prediction.winProb >= config.candidates.winMinProb)
    .sort((a, b) => b.prediction.ev - a.prediction.ev)
    .slice(0, config.candidates.maxWin);

  // 危険な人気馬: 上位人気なのに期待値が低い（◎は除く）
  const dangerous = analyzed
    .filter(
      (h) =>
        h.prediction.mark !== 'honmei' &&
        h.prediction.popularity !== null &&
        h.prediction.popularity <= config.danger.maxPopularity &&
        h.prediction.ev !== null &&
        h.prediction.ev < config.danger.maxEv,
    )
    .sort((a, b) => a.prediction.popularity - b.prediction.popularity);

  const skip = judgeSkip(analyzed, winCandidates, config);

  return {
    race: {
      trackId: r.trackId ?? null,
      trackName: r.trackName ?? null,
      raceNo: num(r.raceNo),
      name: r.name ?? null,
      raceClass: r.raceClass ?? null,
      surface: r.surface ?? null,
      distance: num(r.distance),
      going: r.going ?? null,
      startTime: r.startTime ?? null,
      headcount: horses.length,
    },
    horses: order.map((idx) => analyzed[idx]),
    summary: {
      honmei: brief(byMark.honmei),
      taikou: brief(byMark.taikou),
      tanana: brief(byMark.tanana),
      ana: brief(byMark.ana),
      dangerous: dangerous.map(brief),
      winCandidates: winCandidates.map(brief),
      quinellaCandidates: quinellaCandidates(byMark, config),
      verdict: skip,
    },
    meta: { factorLabels: FACTOR_LABELS, weights: config.weights },
  };
}

module.exports = { analyzeRace, judgeSkip };
