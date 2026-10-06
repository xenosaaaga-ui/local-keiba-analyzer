'use strict';

const { num, round, arr, sanitize } = require('./utils');
const { computeIndex } = require('./scoring');
const { winProbabilities } = require('./probability');
const { validOdds, expectedValue, evRating, popularityRanks, marketProbabilities, withinMarketGuard } = require('./expectedValue');
const { assignMarks, rankOrder, MARKS } = require('./marks');
const { profileFor } = require('./profiles');
const { judgeSkip } = require('./profiles/default');

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
 * 予想指数・評価理由・見送り判定・予想信頼度は、レースの scoringProfile で選んだプロファイルに従う。
 * 単勝オッズは予想指数・予測勝率には使わず、期待値・人気・印（☆）の算出にだけ使う。
 * @param {object} race データアダプターが返すレース
 * @param {object} [config] 省略時はプロファイルの設定
 */
function analyzeRace(race, config) {
  const r = race && typeof race === 'object' ? race : {};
  const profile = profileFor(r);
  const cfg = config || profile.config;
  const horses = arr(r.horses)
    .filter((h) => h && typeof h === 'object')
    .map(sanitize);

  const ctx = profile.prepare(horses, r);
  const scored = horses.map((h) => {
    const { factors, samples } = profile.scoreHorse(h, ctx);
    return { factors, samples, ...computeIndex(factors, cfg.weights) };
  });

  const probs = winProbabilities(scored.map((s) => s.index), cfg.probability);
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
        samples: scored[i].samples,
        factors: Object.fromEntries(
          Object.entries(scored[i].factors).map(([k, v]) => [k, v === null ? null : round(v * 100, 0)]),
        ),
        winProb: round(winProb, 4),
        ev,
        evRating: evRating(ev, cfg.ev),
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
    marketProb: h.prediction.marketProb,
  }));
  const marks = assignMarks(markInput, cfg);
  const byMark = {};
  analyzed.forEach((h, i) => {
    const key = marks[i];
    h.prediction.mark = key;
    h.prediction.markSymbol = key ? MARKS[key].symbol : '';
    h.prediction.markLabel = key ? MARKS[key].label : '';
    if (key && !byMark[key]) byMark[key] = h;
  });

  // 評価理由
  analyzed.forEach((h, i) => {
    h.prediction.reasons = profile.buildReasons(h, {
      ...ctx,
      ev: h.prediction.ev,
      winProb: h.prediction.winProb,
      popularity: h.prediction.popularity,
      coverage: h.prediction.coverage,
      marketProb: h.prediction.marketProb,
      factors: scored[i].factors,
    });
  });

  // 予想順に並べ替え（表示用）
  const order = rankOrder(markInput);
  order.forEach((idx, rank) => {
    analyzed[idx].prediction.rank = rank + 1;
  });

  // 単勝候補（プロファイルによっては、市場勝率から大きく乖離した馬を除く）
  const winCandidates = analyzed
    .filter(
      (h) =>
        (num(h.prediction.ev) ?? 0) >= cfg.candidates.winMinEv &&
        h.prediction.winProb >= cfg.candidates.winMinProb &&
        withinMarketGuard(h.prediction.winProb, h.prediction.marketProb, cfg.candidates.maxModelMarketRatio),
    )
    .sort((a, b) => b.prediction.ev - a.prediction.ev)
    .slice(0, cfg.candidates.maxWin);

  // 危険な人気馬: 上位人気なのに期待値が低い（◎は除く）
  const dangerous = analyzed
    .filter(
      (h) =>
        h.prediction.mark !== 'honmei' &&
        h.prediction.popularity !== null &&
        h.prediction.popularity <= cfg.danger.maxPopularity &&
        h.prediction.ev !== null &&
        h.prediction.ev < cfg.danger.maxEv,
    )
    .sort((a, b) => a.prediction.popularity - b.prediction.popularity);

  // 見送り（買う根拠があるか）と予想信頼度（予想をどこまで信用できるか）は別々に判定する
  const skip = profile.judgeSkip(analyzed, winCandidates, cfg);
  const confidence = profile.assessConfidence(analyzed, cfg);

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
      quinellaCandidates: quinellaCandidates(byMark, cfg),
      verdict: skip,
      confidence,
    },
    meta: { profile: profile.id, profileLabel: profile.label, factorLabels: profile.factorLabels, weights: cfg.weights },
  };
}

module.exports = { analyzeRace, judgeSkip };
