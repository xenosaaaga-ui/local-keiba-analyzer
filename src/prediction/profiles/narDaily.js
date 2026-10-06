'use strict';

const { DEFAULT_CONFIG } = require('../config');
const { num, clamp, round } = require('../utils');
const { placeRate } = require('../scoring');
const { validOdds } = require('../expectedValue');
const { finalizeReasons } = require('../reasons');
const { assessConfidence, DEFAULT_THRESHOLDS } = require('../confidence');

/**
 * NAR 当日データ専用の予想プロファイル。
 *
 * 当日ファイルには近走着順・騎手評価・休養日数が無いため、v0.1 のファクターでは
 * 重みの最大45%しか埋まらず、全レースが「欠損で見送り」になっていた。
 * ここでは当日ファイルに実在する項目だけで予想指数を組み立てる。単勝オッズは指数に使わない。
 *
 * ウェイトの検討（暫定案 → 採用値）
 *   全成績        25% → 25%
 *   当競馬場成績  20% → 20%
 *   当距離成績    25% → 25%
 *   最高タイム    15% → 20%  出走馬間で直接比較できる唯一の「能力の物差し」。成績系は相手関係
 *                            （クラス）を反映しないため、比較可能な時計の比重を上げる。
 *   斤量          10% →  5%  NAR の斤量差は性別・年齢・減量騎手（★☆▲◇）・ハンデなど、能力差を
 *                            埋めるために付けられている。「軽い＝有利」は一部しか成り立たない。
 *   馬体重増減     5% →  5%
 *
 * 全成績 ⊇ 当競馬場成績 ⊇ 当距離成績 の入れ子構造なので、3項目を別々に「水準」として評価すると
 * 同じ成績を3重に数えたり、少数サンプルの補正の仕方で見かけの差が出たりする。そこで、すべて
 * 着順ポイント率という同じ単位で「この条件での推定水準」を組み立てる:
 *   全成績       … 能力水準 L = 全体平均へ寄せた全成績のポイント率
 *   当競馬場成績 … L + 当地適性 A_t
 *   当距離成績   … L + A_t + 距離適性 A_d
 * A_t = 当地の率 − 他場の率、A_d = 当コース当距離の率 − 当地の他距離の率。
 * 差には両方の出走数による信頼度 n/(n+k) を掛けるので、出走数が少ないほど 0 に近づき、
 * 「1戦1勝」のような少数サンプルの好成績は過大評価されない。比較相手が無い（当地しか
 * 走っていない等）ときは適性 0（＝全成績の水準のまま）とする。当地・当距離の出走が無ければ欠損。
 */

const NAR_WEIGHTS = Object.freeze({
  career: 0.25,
  track: 0.2,
  distance: 0.25,
  bestTime: 0.2,
  weight: 0.05,
  bodyWeight: 0.05,
});

const NAR_FACTOR_LABELS = Object.freeze({
  career: '全成績',
  track: '当競馬場成績',
  distance: '当距離成績',
  bestTime: '持ち時計',
  weight: '斤量',
  bodyWeight: '馬体重増減',
});

const NAR_SCORING = Object.freeze({
  // 1走あたりの着順ポイント（1着=1, 2着=0.5, 3着=0.3。2・3着の内訳不明時は 0.4）
  points: Object.freeze({ win: 1, second: 0.5, third: 0.3, placeUnknown: 0.4 }),
  // 全体平均のポイント率（10頭立て前後なら (1+0.5+0.3)/10 ≒ 0.18）
  priorRate: 0.18,
  // 水準: ポイント率 → 1 - exp(-率/0.3)。平均0.18で0.45、0.5で0.81。上限で頭打ちにしない
  levelScale: 0.3,
  // 事前分布の強さ（仮想出走数）。大きいほど少数サンプルを割り引く。
  // track / distance は適性の差に掛ける信頼度 n/(n+k) の k（比較する両方の成績に適用）。
  // 適性は2つのばらつく率の差なので水準より強めに割り引く（当地1戦2着で動くのは+3点程度）
  priorStarts: Object.freeze({ career: 6, track: 8, distance: 6 }),
  // 持ち時計: 出走馬の中央値との差(秒)をロジスティックで 0〜1 に。0.8秒差で約0.73
  timeScaleSec: 0.8,
  timeMinHorses: 3, // 時計を比較する最低頭数
  timeSpeedRange: Object.freeze([12.5, 18.5]), // m/秒。外れる時計は距離違い等とみなして使わない
  timeReliabilityK: 2, // 当距離の出走数が少ない時計は 0.5 へ寄せる: n / (n + K)
  // 斤量: 出走馬平均より 1kg 重いごとに -0.05
  weightPerKg: 0.05,
  // 馬体重増減: exp(-(Δ/12)^2)。±6kg で 0.78、±12kg で 0.37
  bodyWeightScaleKg: 12,
});

/**
 * 予測勝率と買い目の較正（2026-10-06 の実データ58レースで分布を確認して決めた暫定値）
 *
 * - softmax 温度 7: 1番手の予測勝率の平均が0.34になる値。近走・クラス情報が無いモデルは市場より
 *   情報が少ないので、市場の1番人気の平均(0.41)より控えめにする。
 * - 単勝候補の最低勝率 8%: 情報の少ないモデルでは低勝率の推定誤差が大きいため。
 * - 市場との乖離ガード 2倍: 予測勝率がオッズから逆算した市場勝率の2倍を超える馬は、期待値が高く
 *   見えても単勝候補・☆にしない。当日データに無いクラス・近走・調子の情報を市場は織り込んでおり、
 *   大きな乖離はモデルの見落としである可能性が高い（ガード無しでは期待値の中央値2.5・最大38と
 *   非現実的な値が並んだ）。オッズは予想指数・予測勝率には使わず、この期待値の段階でだけ使う。
 *   いずれもバックテストで再較正する前提の暫定値。
 */
const NAR_CONFIG = Object.freeze({
  ...DEFAULT_CONFIG,
  weights: NAR_WEIGHTS,
  probability: Object.freeze({ temperature: 7, maxProb: 0.5, uniformBlend: 0.03 }),
  candidates: Object.freeze({ ...DEFAULT_CONFIG.candidates, winMinProb: 0.08, maxModelMarketRatio: 2 }),
  marks: Object.freeze({ ...DEFAULT_CONFIG.marks, maxModelMarketRatio: 2 }),
  // 見送りは「買う根拠が無い」ときだけ。データの薄さは予想信頼度で表す
  skip: Object.freeze({
    maxMissingOddsRatio: 0.25, // これを超えるとオッズ未発表扱い
    flatTopRatio: 1.25, // 1番手の予測勝率が均等割(1/頭数)のこの倍率未満なら横一線
    flatMinIndexGap: 2, // または予想指数の1位と3位の差がこれ未満なら横一線（実データの下位10%未満）
    minEvaluableCoverage: 0.3, // この利用率未満の馬は「評価不能」
    maxUnevaluableRatio: 0.5, // 評価不能な馬がこの割合を超えると見送り
  }),
  // 実データの上位3頭の指数差は 下位10%=2.0 / 中央値=7.0 / 上位10%=14.9。
  // 指数差 6 以上で1点・12 以上で2点（モック用の 3/6 では大半が「高」になる）
  confidence: Object.freeze({
    ...DEFAULT_THRESHOLDS,
    coverage: [0.75, 0.9],
    primaryShare: [0.5, 0.8],
    distanceShare: 0.6,
    gap: [6, 12],
  }),
});

// ---------- 成績（少数サンプル補正つき） ----------

/** 成績レコード → { n: 出走数, points: 着順ポイント合計 }。0戦・不正値は null */
function recordPoints(record) {
  if (!record || typeof record !== 'object') return null;
  const n = num(record.starts);
  if (n === null || n <= 0 || !Number.isFinite(n)) return null;
  const p = NAR_SCORING.points;
  const wins = clamp(num(record.wins) ?? 0, 0, n);
  const places = clamp(num(record.places) ?? wins, wins, n);
  const seconds = num(record.seconds);
  const thirds = num(record.thirds);
  const placePoints =
    seconds !== null && thirds !== null
      ? clamp(seconds, 0, n) * p.second + clamp(thirds, 0, n) * p.third
      : (places - wins) * p.placeUnknown;
  return { n, points: wins * p.win + placePoints };
}

/** 事前分布（親の推定値）へ寄せたポイント率。データ無しは null */
function shrunkRate(record, priorRate, priorStarts) {
  const rec = recordPoints(record);
  if (!rec) return null;
  return { n: rec.n, rate: (rec.points + priorRate * priorStarts) / (rec.n + priorStarts) };
}

const levelScore = (rate) => clamp(1 - Math.exp(-Math.max(0, rate) / NAR_SCORING.levelScale), 0, 1);

/**
 * 部分成績（当地など）と、親成績からそれを除いた残り（他場など）の着順ポイント率の差（適性）。
 * 両方の出走数による信頼度を掛けて割り引く。部分成績が無ければ null、残りが無ければ比較できないので 0。
 */
function aptitudeDiff(part, parent, k) {
  const p = recordPoints(part);
  const all = recordPoints(parent);
  if (!p || !all) return null;
  const restN = all.n - p.n;
  if (restN <= 0) return { n: p.n, aptitude: 0 };
  const restRate = clamp((all.points - p.points) / restN, 0, 1);
  const reliability = (p.n / (p.n + k)) * (restN / (restN + k));
  return { n: p.n, aptitude: (p.points / p.n - restRate) * reliability };
}

/**
 * 全成績の水準と、当競馬場・当距離での推定水準（ポイント率）。
 * 各要素は { n, rate }。当地・当距離の出走が無い / 全成績が無ければ null。
 */
function recordEstimates(horse) {
  const s = NAR_SCORING;
  const career = shrunkRate(horse.careerRecord, s.priorRate, s.priorStarts.career);
  if (!career) return { career: null, track: null, distance: null };
  const t = aptitudeDiff(horse.trackRecord, horse.careerRecord, s.priorStarts.track);
  const d = aptitudeDiff(horse.sameDistanceRecord, horse.trackRecord, s.priorStarts.distance);
  const trackApt = t ? t.aptitude : 0;
  return {
    career,
    track: t ? { n: t.n, rate: career.rate + trackApt, aptitude: trackApt } : null,
    distance: d ? { n: d.n, rate: career.rate + trackApt + d.aptitude, aptitude: d.aptitude } : null,
  };
}

// ---------- 持ち時計 ----------

/** 距離に対して現実的な時計なら秒数、そうでなければ null */
function validTime(horse, distance) {
  const t = num(horse.bestTime);
  const d = num(distance);
  if (t === null || t <= 0 || d === null || d <= 0) return null;
  const speed = d / t;
  const [lo, hi] = NAR_SCORING.timeSpeedRange;
  return speed >= lo && speed <= hi ? t : null;
}

function median(values) {
  const v = values.slice().sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function scoreBestTime(horse, ctx) {
  const t = validTime(horse, ctx.distance);
  if (t === null || ctx.medianTime === null) return null;
  const s = NAR_SCORING;
  const logistic = 1 / (1 + Math.exp(-(ctx.medianTime - t) / s.timeScaleSec));
  const n = Math.max(1, num(horse.sameDistanceRecord && horse.sameDistanceRecord.starts) ?? 1);
  const reliability = n / (n + s.timeReliabilityK);
  return clamp(0.5 + reliability * (logistic - 0.5), 0, 1);
}

// ---------- 斤量・馬体重 ----------

function scoreWeight(horse, ctx) {
  const w = num(horse.weight);
  if (w === null || w <= 0 || ctx.avgWeight === null) return null;
  return clamp(0.5 - (w - ctx.avgWeight) * NAR_SCORING.weightPerKg, 0, 1);
}

function scoreBodyWeight(horse) {
  const d = num(horse.bodyWeightDiff);
  if (d === null) return null;
  return clamp(Math.exp(-((d / NAR_SCORING.bodyWeightScaleKg) ** 2)), 0, 1);
}

// ---------- 評価理由 ----------

function buildNarReasons(horse, ctx) {
  const plus = [];
  const minus = [];
  const add = (list, text, strength) => list.push({ text, strength });
  const f = ctx.factors || {};

  const career = horse.careerRecord;
  const careerStarts = num(career && career.starts);
  const careerPlace = placeRate(career);
  if (careerStarts === null) add(minus, '初出走のため成績データなし', 0.8);
  else if (careerStarts <= 3) add(minus, `通算${careerStarts}戦とキャリアが浅く、成績は割り引いて評価`, 0.6);
  else if (careerPlace >= 0.45) add(plus, `通算${careerStarts}戦で3着内率${Math.round(careerPlace * 100)}%と安定`, 0.6 + careerPlace * 0.3);
  else if (careerStarts >= 8 && careerPlace < 0.15) add(minus, '通算成績が振るわない', 0.55);

  const distStarts = num(horse.sameDistanceRecord && horse.sameDistanceRecord.starts);
  const distPlace = placeRate(horse.sameDistanceRecord);
  if (distStarts === null) add(minus, '当競馬場の今回距離は未経験', 0.5);
  else if (distStarts >= 2 && distPlace >= 0.4) add(plus, `当コース・当距離で${distStarts}戦${Math.round(distPlace * distStarts)}回3着内`, 0.65 + distPlace * 0.2);
  else if (distStarts >= 3 && distPlace < 0.15) add(minus, '当コース・当距離で結果が出ていない', 0.5);

  const trackStarts = num(horse.trackRecord && horse.trackRecord.starts);
  const trackPlace = placeRate(horse.trackRecord);
  if (trackStarts === null) add(minus, '当競馬場は初出走', 0.45);
  else if (trackStarts >= 3 && trackPlace >= 0.4) add(plus, '当競馬場で好成績', 0.55 + trackPlace * 0.2);

  const ft = num(f.bestTime);
  if (ft !== null && ft >= 0.7) add(plus, '持ち時計が出走馬の中で上位', 0.6 + (ft - 0.7));
  else if (ft !== null && ft <= 0.3) add(minus, '持ち時計が見劣る', 0.55 + (0.3 - ft));

  const w = num(horse.weight);
  if (w !== null && ctx.avgWeight !== null) {
    const diff = round(w - ctx.avgWeight, 1);
    if (diff <= -2) add(plus, `斤量が出走馬平均より${Math.abs(diff)}kg軽い`, 0.4);
    else if (diff >= 2) add(minus, `斤量が出走馬平均より${diff}kg重い`, 0.4);
  }

  const bw = num(horse.bodyWeightDiff);
  if (bw !== null && Math.abs(bw) >= 10) add(minus, `馬体重の増減が大きい(${bw > 0 ? '+' : ''}${bw}kg)`, 0.5 + Math.min(Math.abs(bw), 30) / 100);

  const ev = num(ctx.ev);
  const pop = num(ctx.popularity);
  const prob = num(ctx.winProb) ?? 0;
  const market = num(ctx.marketProb);
  const maxRatio = num(NAR_CONFIG.candidates.maxModelMarketRatio);
  if (ev === null) add(minus, 'オッズ未取得のため期待値は算出不可', 0.7);
  else if (ev >= 1 && market !== null && market > 0 && maxRatio !== null && prob / market > maxRatio) {
    add(minus, '市場の評価と大きく乖離（当日データに無い不安要素の可能性）', 0.95);
  }
  else if (ev >= 1.2 && prob < 0.05) add(minus, '期待値は高いが勝率自体が低く大穴扱い', 0.65);
  else if (ev >= 1.2 && pop !== null && pop >= 4) add(plus, '成績評価に対してオッズが高く妙味あり', 0.95);
  else if (ev >= 1.2) add(plus, '評価に対してオッズに妙味あり', 0.7);
  else if (ev < 0.8 && pop !== null && pop <= 3) add(minus, '成績評価に対して人気しすぎ', 0.9);

  return finalizeReasons(plus, minus, f, NAR_FACTOR_LABELS);
}

// ---------- 見送り ----------

function judgeNarSkip(analyzed, winCandidates, config) {
  const c = config.skip;
  const n = analyzed.length;
  const reasons = [];
  if (n === 0) {
    reasons.push('出走馬データがありません');
  } else {
    const missingOdds = analyzed.filter((h) => validOdds(h.odds) === null).length / n;
    const unevaluable = analyzed.filter((h) => (num(h.prediction.coverage) ?? 0) < c.minEvaluableCoverage).length / n;
    const topProb = Math.max(...analyzed.map((h) => num(h.prediction.winProb) ?? 0));
    const idx = analyzed.map((h) => num(h.prediction.index) ?? 50).sort((a, b) => b - a);

    if (missingOdds > c.maxMissingOddsRatio) reasons.push('オッズ未発表（発売前）または未取得');
    else if (winCandidates.length === 0) reasons.push('期待値1.0以上の候補がいない');
    if (n >= 3 && (topProb < c.flatTopRatio / n || idx[0] - idx[2] < c.flatMinIndexGap)) {
      reasons.push('上位馬の差が非常に小さい（横一線）');
    }
    if (unevaluable > c.maxUnevaluableRatio) reasons.push('評価可能なデータが極端に少ない');
  }
  const skip = reasons.length > 0;
  return { skip, reasons, message: skip ? 'このレースは見送り推奨' : '勝負可能：単勝候補あり' };
}

// ---------- プロファイル ----------

const narDailyProfile = {
  id: 'narDaily',
  label: 'NAR当日データ（成績・持ち時計ベース）',
  config: NAR_CONFIG,
  factorLabels: NAR_FACTOR_LABELS,

  prepare(horses, race) {
    const distance = num(race && race.distance);
    const times = horses.map((h) => validTime(h, distance)).filter((t) => t !== null);
    const weights = horses.map((h) => num(h.weight)).filter((w) => w !== null && w > 0);
    return {
      distance,
      medianTime: times.length >= NAR_SCORING.timeMinHorses ? median(times) : null,
      avgWeight: weights.length ? weights.reduce((a, b) => a + b, 0) / weights.length : null,
    };
  },

  scoreHorse(horse, ctx) {
    const est = recordEstimates(horse);
    return {
      factors: {
        career: est.career ? levelScore(est.career.rate) : null,
        track: est.track ? levelScore(est.track.rate) : null,
        distance: est.distance ? levelScore(est.distance.rate) : null,
        bestTime: scoreBestTime(horse, ctx),
        weight: scoreWeight(horse, ctx),
        bodyWeight: scoreBodyWeight(horse),
      },
      samples: {
        primary: est.career ? est.career.n : 0,
        track: est.track ? est.track.n : 0,
        distance: est.distance ? est.distance.n : 0,
      },
    };
  },

  buildReasons: buildNarReasons,
  judgeSkip: judgeNarSkip,
  assessConfidence: (analyzed, config) => assessConfidence(analyzed, config.confidence),
};

module.exports = { narDailyProfile, NAR_WEIGHTS, NAR_CONFIG, NAR_SCORING, recordEstimates, recordPoints };
