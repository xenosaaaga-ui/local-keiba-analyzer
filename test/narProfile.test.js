'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeRace } = require('../src/prediction');
const { recordEstimates } = require('../src/prediction/profiles/narDaily');
const { createMockAdapter } = require('../src/data/adapters/mockAdapter');

const rec = (w, s, t, o) => ({ starts: w + s + t + o, wins: w, seconds: s, thirds: t, places: w + s + t });

/** NAR 当日データ形式の馬（架空） */
function narHorse(number, overrides = {}) {
  return {
    number,
    frame: Math.min(8, number),
    name: `ナーホース${number}`,
    weight: 55,
    bodyWeight: 470,
    bodyWeightDiff: 0,
    odds: 6 + number,
    careerRecord: rec(2, 2, 2, 10),
    trackRecord: rec(1, 1, 1, 5),
    sameDistanceRecord: rec(1, 0, 1, 2),
    bestTime: 88 + number * 0.2,
    recentFinishes: [],
    ...overrides,
  };
}

const narRace = (horses, extra = {}) => ({ trackId: 'ooi', trackName: '大井', raceNo: 1, distance: 1400, scoringProfile: 'narDaily', horses, ...extra });
const field = () => Array.from({ length: 10 }, (_, i) => narHorse(i + 1));

function assertAllFinite(value, path = 'root') {
  if (typeof value === 'number') assert.ok(Number.isFinite(value), `${path} = ${value}`);
  else if (Array.isArray(value)) value.forEach((v, i) => assertAllFinite(v, `${path}[${i}]`));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) assertAllFinite(v, `${path}.${k}`);
}

const pred = (result, number) => result.horses.find((h) => h.number === number).prediction;

test('NAR: scoringProfile で専用プロファイルが選ばれ、モックは従来プロファイルのまま', async () => {
  const nar = analyzeRace(narRace(field()));
  assert.equal(nar.meta.profile, 'narDaily');
  assert.deepEqual(Object.keys(nar.meta.factorLabels), ['career', 'track', 'distance', 'bestTime', 'weight', 'bodyWeight']);
  assert.ok(Math.abs(Object.values(nar.meta.weights).reduce((a, b) => a + b, 0) - 1) < 1e-9);

  const mock = createMockAdapter();
  const m = analyzeRace(await mock.getRace('ooi', 1));
  assert.equal(m.meta.profile, 'default');
  assert.ok('recentForm' in m.meta.factorLabels);
  assert.ok(['high', 'medium', 'low'].includes(m.summary.confidence.key));
});

test('NAR: 単勝オッズを変えても予想指数・予測勝率は変わらない', () => {
  const a = analyzeRace(narRace(field()));
  const b = analyzeRace(narRace(field().map((h, i) => ({ ...h, odds: i === 0 ? 1.1 : 99.9 }))));
  for (const h of a.horses) {
    assert.equal(pred(b, h.number).index, h.prediction.index);
    assert.equal(pred(b, h.number).winProb, h.prediction.winProb);
  }
});

test('NAR: 少数サンプルの好成績を過大評価しない（1戦1勝 < 20戦8勝）', () => {
  const lucky = recordEstimates({ careerRecord: rec(1, 0, 0, 0) });
  const proven = recordEstimates({ careerRecord: rec(8, 4, 2, 6) });
  assert.ok(lucky.career.rate < proven.career.rate, `${lucky.career.rate} vs ${proven.career.rate}`);

  // 当距離 1戦1勝は、その馬の当競馬場成績の推定値に強く寄せられる
  const h = recordEstimates({ careerRecord: rec(1, 1, 1, 12), trackRecord: rec(1, 1, 0, 6), sameDistanceRecord: rec(1, 0, 0, 0) });
  assert.ok(h.distance.rate > h.track.rate, '好成績の方向には動く');
  assert.ok(h.distance.rate < 0.5, `1戦だけで満点級にならない: ${h.distance.rate}`);
});

test('NAR: 当競馬場・当距離は「全成績の水準 + 適性」で評価し、少数サンプルや見かけの差で動かない', () => {
  const factors = (overrides) => pred(analyzeRace(narRace([narHorse(1, overrides), narHorse(2), narHorse(3)])), 1).factors;

  // 当地しか走っていない（当地成績 = 全成績）→ 当地の評価は全成績と同じ
  const homeOnly = factors({ careerRecord: rec(5, 3, 2, 10), trackRecord: rec(5, 3, 2, 10), sameDistanceRecord: rec(5, 3, 2, 10) });
  assert.equal(homeOnly.track, homeOnly.career);
  assert.equal(homeOnly.distance, homeOnly.career);

  // 当地1戦だけ2着 → 他場の成績と比べても信頼度が低いので、全成績の水準からほぼ動かない
  const oneStart = factors({ careerRecord: rec(3, 2, 2, 13), trackRecord: rec(0, 1, 0, 0), sameDistanceRecord: rec(0, 1, 0, 0) });
  assert.ok(Math.abs(oneStart.track - oneStart.career) <= 5, JSON.stringify(oneStart));

  // 他場は凡走続きだが当地で好走が多い → 当地の評価が全成績より明確に高い
  const local = factors({ careerRecord: rec(4, 3, 3, 20), trackRecord: rec(4, 3, 2, 3) });
  assert.ok(local.track - local.career >= 10, JSON.stringify(local));
});

test('NAR: 欠損項目は残りのウェイトで再正規化し、NaN/Infinity を出さない', () => {
  const hs = field();
  hs[0] = narHorse(1, { careerRecord: null, trackRecord: null, sameDistanceRecord: null, bestTime: null }); // 初出走
  hs[1] = narHorse(2, { bestTime: NaN, bodyWeightDiff: null, weight: Infinity });
  hs[2] = narHorse(3, { careerRecord: { starts: Infinity, wins: 1 }, bestTime: 9999 }); // 不正な成績・非現実的な時計
  hs[3] = narHorse(4, { careerRecord: { starts: NaN }, trackRecord: 'x', odds: 0 });
  const result = analyzeRace(narRace(hs));
  assertAllFinite(result);
  const debut = pred(result, 1);
  assert.equal(debut.factors.career, null);
  assert.ok(debut.coverage > 0 && debut.coverage < 0.2, `coverage=${debut.coverage}`);
  assert.equal(pred(result, 3).factors.bestTime, null, '距離に対して非現実的な時計は使わない');
  const sum = result.horses.reduce((s, h) => s + h.prediction.winProb, 0);
  assert.ok(Math.abs(sum - 1) < 0.001);
});

test('NAR: 成績・持ち時計が良い馬ほど指数が高い', () => {
  const hs = field();
  hs[4] = narHorse(5, { careerRecord: rec(8, 4, 2, 6), trackRecord: rec(5, 2, 1, 2), sameDistanceRecord: rec(3, 1, 0, 1), bestTime: 86.0 });
  hs[5] = narHorse(6, { careerRecord: rec(0, 0, 1, 25), trackRecord: rec(0, 0, 0, 12), sameDistanceRecord: rec(0, 0, 0, 6), bestTime: 91.5 });
  const result = analyzeRace(narRace(hs));
  assert.equal(result.horses[0].number, 5);
  assert.equal(result.horses[result.horses.length - 1].number, 6);
});

test('NAR: 見送りと予想信頼度は別々に判定される', () => {
  // 明確な上位馬がいて、市場と大きく乖離しない妙味 → 勝負可
  const hs = field();
  hs[4] = narHorse(5, { careerRecord: rec(8, 4, 2, 6), trackRecord: rec(5, 2, 1, 2), sameDistanceRecord: rec(3, 1, 0, 1), bestTime: 86.0, odds: 3.2 });
  const go = analyzeRace(narRace(hs));
  assert.equal(go.summary.verdict.skip, false, JSON.stringify(go.summary.verdict));
  assert.ok(go.summary.winCandidates.some((c) => c.number === 5));
  assert.ok(['high', 'medium', 'low'].includes(go.summary.confidence.key));
  assert.equal(go.summary.confidence.details.length, 3);

  // データは十分でもオッズ発売前 → 見送り（理由はオッズ）。信頼度はデータで決まる
  const noOdds = analyzeRace(narRace(hs.map((h) => ({ ...h, odds: null }))));
  assert.equal(noOdds.summary.verdict.skip, true);
  assert.deepEqual(noOdds.summary.verdict.reasons, ['オッズ未発表（発売前）または未取得']);
  assert.equal(noOdds.summary.confidence.key, go.summary.confidence.key);
});

test('NAR: 新馬戦のように評価できるデータが極端に少なければ見送り・信頼度低', () => {
  const debut = Array.from({ length: 8 }, (_, i) => narHorse(i + 1, { careerRecord: null, trackRecord: null, sameDistanceRecord: null, bestTime: null }));
  const result = analyzeRace(narRace(debut));
  assert.equal(result.summary.verdict.skip, true);
  assert.ok(result.summary.verdict.reasons.includes('評価可能なデータが極端に少ない'));
  assert.ok(result.summary.verdict.reasons.includes('上位馬の差が非常に小さい（横一線）'));
  assert.equal(result.summary.confidence.key, 'low');
  assertAllFinite(result);
});

test('NAR: 市場勝率の2倍を超える予測勝率の馬は、期待値が高くても単勝候補・☆にしない', () => {
  const hs = field();
  // 成績は抜けているのに 11番人気級のオッズ（市場は当日データに無い不安要素を織り込んでいる可能性）
  hs[7] = narHorse(8, { careerRecord: rec(9, 3, 2, 4), trackRecord: rec(6, 2, 1, 1), sameDistanceRecord: rec(4, 1, 0, 0), bestTime: 85.5, odds: 80 });
  const result = analyzeRace(narRace(hs));
  const p = pred(result, 8);
  assert.ok(p.ev >= 1.0, `ev=${p.ev}`);
  assert.ok(p.winProb / p.marketProb > 2);
  assert.ok(!result.summary.winCandidates.some((c) => c.number === 8));
  assert.notEqual(p.mark, 'ana');
  assert.ok(p.reasons.some((r) => r.text.includes('市場の評価と大きく乖離')));
});

test('NAR: 評価理由は2〜5個で、近走データ不足のような当日データに無い項目の指摘は出さない', () => {
  const result = analyzeRace(narRace(field()));
  for (const h of result.horses) {
    const rs = h.prediction.reasons;
    assert.ok(rs.length >= 2 && rs.length <= 5);
    assert.ok(!rs.some((r) => r.text.includes('近走')));
  }
});
