'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { analyzeRace } = require('../src/prediction');
const { winProbabilities } = require('../src/prediction/probability');
const { expectedValue, evRating, popularityRanks } = require('../src/prediction/expectedValue');
const { computeIndex, scoreFactors } = require('../src/prediction/scoring');
const { assignMarks } = require('../src/prediction/marks');
const { DEFAULT_CONFIG } = require('../src/prediction/config');
const { createMockAdapter } = require('../src/data/adapters/mockAdapter');

function horse(number, overrides = {}) {
  return {
    number,
    frame: Math.min(8, number),
    name: `テスト${number}`,
    jockey: `騎手${number}`,
    weight: 55,
    lastWeight: 55,
    odds: 5 + number,
    recentFinishes: [number, number + 1, number, 2, 3],
    recentMargins: [0.2 * number, 0.5, 0.3, 0.4, 0.6],
    sameDistanceRecord: { starts: 5, wins: 1, places: 2 },
    trackRecord: { starts: 6, wins: 1, places: 3 },
    surfaceAptitude: 3,
    jockeyRating: 60,
    classRating: 55,
    restDays: 28,
    ...overrides,
  };
}

function race(horses) {
  return { trackId: 't', trackName: 'テスト', raceNo: 1, distance: 1400, horses };
}

/** オブジェクト内のすべての数値が有限であることを再帰的に確認 */
function assertAllFinite(value, path = 'root') {
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), `${path} is not finite: ${value}`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => assertAllFinite(v, `${path}[${i}]`));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertAllFinite(v, `${path}.${k}`);
  }
}

function predictionsOf(result) {
  return result.horses.map((h) => h.prediction);
}

const field = () => Array.from({ length: 10 }, (_, i) => horse(i + 1));

test('予測勝率の合計が約100%', () => {
  const sum = predictionsOf(analyzeRace(race(field()))).reduce((a, p) => a + p.winProb, 0);
  assert.ok(Math.abs(sum - 1) < 0.001, `sum=${sum}`);
});

test('全モックレースで予測勝率の合計が約100%・NaN/Infinityなし', async () => {
  const ds = createMockAdapter();
  for (const t of await ds.getTracks()) {
    for (const r of await ds.getRaces(t.id)) {
      const result = analyzeRace(await ds.getRace(t.id, r.raceNo));
      const sum = predictionsOf(result).reduce((a, p) => a + p.winProb, 0);
      assert.ok(Math.abs(sum - 1) < 0.001, `${t.id}${r.raceNo} sum=${sum}`);
      assertAllFinite(result, `${t.id}${r.raceNo}`);
    }
  }
});

test('期待値計算が正しい（25% × 5.0倍 = 1.25）', () => {
  assert.equal(expectedValue(0.25, 5.0), 1.25);
  assert.equal(expectedValue(0.1, 12.3), 1.23);
  assert.equal(evRating(1.25).label, '高期待値');
  assert.equal(evRating(1.2).label, '高期待値');
  assert.equal(evRating(1.0).label, '妙味あり');
  assert.equal(evRating(0.9).label, 'やや割高');
  assert.equal(evRating(0.5).label, '妙味低い');
  assert.equal(evRating(null).label, 'オッズ未取得');
});

test('レース分析の期待値 = 予測勝率 × 単勝オッズ', () => {
  for (const h of analyzeRace(race(field())).horses) {
    assert.ok(Math.abs(h.prediction.ev - h.prediction.winProb * h.odds) < 0.01);
  }
});

test('予想指数は0〜100の範囲', () => {
  const extremes = [
    horse(1, { recentFinishes: [1, 1, 1, 1, 1], recentMargins: [-2, -2, -2, -2, -2], jockeyRating: 500, classRating: 999, surfaceAptitude: 99, sameDistanceRecord: { starts: 10, wins: 10, places: 10 }, weight: 40 }),
    horse(2, { recentFinishes: [99, 99, 99, 99, 99], recentMargins: [99, 99, 99, 99, 99], jockeyRating: -50, classRating: -10, surfaceAptitude: -3, weight: 80, lastWeight: 50 }),
    horse(3),
  ];
  for (const p of predictionsOf(analyzeRace(race(extremes)))) {
    assert.ok(p.index >= 0 && p.index <= 100, `index=${p.index}`);
  }
});

test('出走馬0頭でも落ちない', () => {
  const result = analyzeRace(race([]));
  assert.equal(result.horses.length, 0);
  assert.equal(result.summary.honmei, null);
  assert.equal(result.summary.verdict.skip, true);
  assert.doesNotThrow(() => analyzeRace(null));
  assert.doesNotThrow(() => analyzeRace({}));
  assert.doesNotThrow(() => analyzeRace({ horses: 'invalid' }));
});

test('オッズ未取得（null/undefined）でも落ちず「オッズ未取得」になる', () => {
  const hs = field();
  hs[0].odds = null;
  delete hs[1].odds;
  const result = analyzeRace(race(hs));
  for (const h of result.horses.filter((x) => x.number <= 2)) {
    assert.equal(h.odds, null);
    assert.equal(h.prediction.ev, null);
    assert.equal(h.prediction.evRating.label, 'オッズ未取得');
    assert.equal(h.prediction.popularity, null);
  }
});

test('オッズ0・負数・文字列でも落ちない', () => {
  const hs = field();
  hs[0].odds = 0;
  hs[1].odds = -3;
  hs[2].odds = 'abc';
  hs[3].odds = Infinity;
  const result = analyzeRace(race(hs));
  for (const h of result.horses.filter((x) => x.number <= 4)) {
    assert.equal(h.prediction.ev, null);
    assert.equal(h.prediction.evRating.key, 'none');
  }
  assertAllFinite(result);
});

test('各項目がnullでも落ちない', () => {
  const keys = ['weight', 'lastWeight', 'recentFinishes', 'recentMargins', 'sameDistanceRecord', 'trackRecord', 'surfaceAptitude', 'jockeyRating', 'classRating', 'restDays', 'odds', 'name', 'frame'];
  const hs = keys.map((k, i) => horse(i + 1, { [k]: null }));
  hs.push(Object.fromEntries(keys.map((k) => [k, null])));
  hs.push(null, undefined);
  const result = analyzeRace(race(hs));
  assert.equal(result.horses.length, keys.length + 1);
  assertAllFinite(result);
});

test('同点評価（全馬同一データ）でも落ちず、勝率は均等・印は重複しない', () => {
  const same = Array.from({ length: 8 }, (_, i) => horse(i + 1, { recentFinishes: [3, 3, 3, 3, 3], recentMargins: [0.5, 0.5, 0.5, 0.5, 0.5], odds: 8 }));
  const result = analyzeRace(race(same));
  const probs = predictionsOf(result).map((p) => p.winProb);
  probs.forEach((p) => assert.ok(Math.abs(p - 1 / 8) < 0.001));
  const marks = predictionsOf(result).map((p) => p.mark).filter(Boolean);
  assert.equal(new Set(marks.filter((m) => m !== 'renka')).size, marks.filter((m) => m !== 'renka').length);
  assert.equal(result.summary.honmei.number, 1); // 同点時は馬番の若い順
  assert.equal(result.summary.verdict.skip, true); // 混戦扱いで見送り
});

test('NaNにならない（NaN入力を含む）', () => {
  const hs = field();
  hs[0].weight = NaN;
  hs[1].recentFinishes = [NaN, NaN, NaN, NaN, NaN];
  hs[2].jockeyRating = NaN;
  hs[3].sameDistanceRecord = { starts: NaN, wins: NaN, places: NaN };
  hs[4].odds = NaN;
  const result = analyzeRace(race(hs));
  for (const p of predictionsOf(result)) {
    assert.ok(!Number.isNaN(p.index));
    assert.ok(!Number.isNaN(p.winProb));
  }
  assertAllFinite(result);
});

test('Infinityにならない（Infinity入力・極端な指数差を含む）', () => {
  const hs = field();
  hs[0].restDays = Infinity;
  hs[1].classRating = -Infinity;
  hs[2].trackRecord = { starts: Infinity, wins: 1, places: 1 };
  assertAllFinite(analyzeRace(race(hs)));
  const probs = winProbabilities([100, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  probs.forEach((p) => assert.ok(Number.isFinite(p)));
  assert.ok(Math.max(...probs) < 0.99, '1頭だけ99%のような極端な値にしない');
});

test('勝率は負にならず、100%を超えない', () => {
  const cases = [[100, 0], [0, 0, 0], [50], [-500, 900, NaN, null, 'x'], Array.from({ length: 16 }, (_, i) => i * 6)];
  for (const c of cases) {
    const probs = winProbabilities(c);
    assert.equal(probs.length, c.length);
    for (const p of probs) assert.ok(p >= 0 && p <= 1, `p=${p}`);
  }
  assert.deepEqual(winProbabilities([]), []);
});

test('欠損データでもウェイトを再正規化して評価できる', () => {
  const full = scoreFactors(horse(1), 55);
  const partial = { ...full, distance: null, course: null, jockey: null };
  const r = computeIndex(partial, DEFAULT_CONFIG.weights);
  assert.ok(r.index > 0 && r.index <= 100);
  assert.ok(Math.abs(r.coverage - 0.55) < 0.001);
  assert.deepEqual(computeIndex({}, DEFAULT_CONFIG.weights), { index: 50, coverage: 0 });

  const sparse = horse(1, { sameDistanceRecord: null, trackRecord: null, surfaceAptitude: null, jockeyRating: null, recentMargins: [] });
  const result = analyzeRace(race([sparse, horse(2), horse(3)]));
  const p = result.horses.find((h) => h.number === 1).prediction;
  assert.ok(p.coverage < 1 && p.index > 0);
});

test('印が重複せず、◎○▲☆は各1頭まで・△は最大2頭', async () => {
  const ds = createMockAdapter();
  for (const t of await ds.getTracks()) {
    for (const r of await ds.getRaces(t.id)) {
      const marks = analyzeRace(await ds.getRace(t.id, r.raceNo)).horses.map((h) => h.prediction.mark).filter(Boolean);
      for (const key of ['honmei', 'taikou', 'tanana', 'ana']) {
        assert.ok(marks.filter((m) => m === key).length <= 1, `${t.id}${r.raceNo} ${key}`);
      }
      assert.ok(marks.filter((m) => m === 'renka').length <= 2);
      assert.equal(marks.filter((m) => m === 'honmei').length, 1);
    }
  }
});

test('☆は5番手ではなく、人気薄で期待値の高い馬を優先する', () => {
  const input = [
    { number: 1, winProb: 0.4, index: 70, ev: 0.8, popularity: 1 },
    { number: 2, winProb: 0.2, index: 60, ev: 0.9, popularity: 2 },
    { number: 3, winProb: 0.15, index: 58, ev: 0.9, popularity: 3 },
    { number: 4, winProb: 0.1, index: 55, ev: 0.6, popularity: 4 }, // 4番手（期待値低）
    { number: 5, winProb: 0.08, index: 52, ev: 0.7, popularity: 5 }, // 5番手（期待値低）
    { number: 6, winProb: 0.05, index: 50, ev: 1.6, popularity: 8 }, // 人気薄・高期待値
    { number: 7, winProb: 0.02, index: 40, ev: 3.0, popularity: 9 }, // 勝率が低すぎる
  ];
  const marks = assignMarks(input);
  assert.deepEqual(marks, ['honmei', 'taikou', 'tanana', 'renka', 'renka', 'ana', null]);
});

test('見送り判定: 期待値1.0以上がいない場合は見送り', () => {
  const hs = field().map((h) => ({ ...h, odds: 1.5 }));
  const v = analyzeRace(race(hs)).summary.verdict;
  assert.equal(v.skip, true);
  assert.equal(v.message, 'このレースは見送り推奨');
  assert.ok(v.reasons.includes('期待値1.0以上の馬がいない'));
});

test('見送り判定: 欠損データが多い場合は見送り、条件を満たせば勝負可', () => {
  const missing = field().map((h, i) => (i < 6 ? { ...h, odds: null } : h));
  assert.ok(analyzeRace(race(missing)).summary.verdict.reasons.includes('欠損データが多く信頼度が低い'));

  // 明確な本命がいて、オッズに妙味がある → 勝負可
  const strong = field();
  strong[0] = horse(1, { recentFinishes: [1, 1, 1, 2, 1], recentMargins: [-0.5, -0.3, -0.2, 0.1, -0.4], jockeyRating: 90, classRating: 85, sameDistanceRecord: { starts: 5, wins: 4, places: 5 }, odds: 4.0 });
  const v = analyzeRace(race(strong)).summary.verdict;
  assert.equal(v.skip, false, JSON.stringify(v));
  assert.equal(v.message, '勝負可能：単勝候補あり');
});

test('危険な人気馬・単勝候補・馬連候補が仕様どおり', async () => {
  const ds = createMockAdapter();
  for (const t of await ds.getTracks()) {
    for (const r of await ds.getRaces(t.id)) {
      const { summary } = analyzeRace(await ds.getRace(t.id, r.raceNo));
      for (const d of summary.dangerous) assert.ok(d.popularity <= 3 && d.ev < 0.8 && d.mark !== 'honmei');
      for (const w of summary.winCandidates) assert.ok(w.ev >= 1.0 && w.winProb >= 0.05);
      assert.ok(summary.quinellaCandidates.length >= 1 && summary.quinellaCandidates.length <= 3);
      const keys = summary.quinellaCandidates.map((q) => q.numbers.join('-'));
      assert.equal(new Set(keys).size, keys.length, '組み合わせが重複しない');
    }
  }
});

test('評価理由は2〜5個で、プラスとマイナスの両方を含む', async () => {
  const ds = createMockAdapter();
  const result = analyzeRace(await ds.getRace('ooi', 1));
  for (const h of result.horses) {
    const rs = h.prediction.reasons;
    assert.ok(rs.length >= 2 && rs.length <= 5, `${h.name}: ${rs.length}`);
    assert.ok(rs.some((r) => r.type === 'plus'));
    assert.ok(rs.some((r) => r.type === 'minus'));
  }
  const empty = analyzeRace(race([{ number: 1 }, { number: 2 }]));
  for (const h of empty.horses) assert.ok(h.prediction.reasons.length >= 2);
});

test('人気順はオッズの低い順、未取得は人気なし', () => {
  assert.deepEqual(popularityRanks([5, 2, null, 10, 0, 2]), [3, 1, null, 4, null, 2]);
});
