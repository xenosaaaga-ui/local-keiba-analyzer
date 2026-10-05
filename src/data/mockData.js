'use strict';

/**
 * v0.1 用モックデータ（すべて架空。実在の馬・騎手・レースとは関係ありません）。
 *
 * シード付き乱数で生成するため、起動のたびに同じデータになる。
 * 各馬には「隠れた能力値」を持たせ、成績データとオッズを別々のノイズで生成することで、
 * 予想ロジックと市場評価（オッズ）にズレ＝期待値の差が出るようにしている。
 */

const TRACKS = [
  { id: 'ooi', name: '大井', region: '南関東', distances: [1200, 1400, 1600, 1800, 2000], races: 8, firstPost: '15:00' },
  { id: 'kawasaki', name: '川崎', region: '南関東', distances: [900, 1400, 1500, 1600, 2100], races: 8, firstPost: '14:45' },
  { id: 'sonoda', name: '園田', region: '兵庫', distances: [820, 1230, 1400, 1700, 1870], races: 8, firstPost: '10:50' },
  { id: 'kochi', name: '高知', region: '高知', distances: [800, 1300, 1400, 1600, 1900], races: 8, firstPost: '14:55' },
];

const CLASSES = ['C3', 'C2', 'C2', 'C1', 'C1', 'B3', 'B2', 'A2'];
const GOINGS = ['良', '良', '稍重', '重', '不良'];

const NAME_HEAD = ['サクラ', 'ゴールド', 'ミラクル', 'ダイヤ', 'スター', 'ブレイブ', 'シルバー', 'ホワイト', 'レッド', 'キング', 'ラッキー', 'ハッピー', 'マジック', 'サンダー', 'ムーン', 'スプリング', 'ノーブル', 'アース'];
const NAME_TAIL = ['ボルト', 'ウイング', 'フラッシュ', 'ドリーム', 'ロード', 'ハート', 'クイーン', 'スマイル', 'ブリッツ', 'アロー', 'ジェット', 'エース', 'ソング', 'ライト', 'ファイア', 'ガイア', 'リーフ', 'ノヴァ'];
const JOCKEY_FAMILY = ['山田', '佐藤', '鈴木', '高橋', '田中', '伊藤', '渡辺', '中村', '小林', '加藤', '吉田', '山本', '松本', '井上'];
const JOCKEY_GIVEN = ['翔太', '健', '大輔', '誠', '拓也', '亮', '直樹', '彩', '優', '蓮'];

/**
 * 特別なシナリオ（ロジック確認用）
 *  strong : 抜けた本命 + 過小評価された穴馬
 *  flat   : 能力差が小さい混戦（見送りになりやすい）
 *  missing: 欠損データが多い（見送り判定・再正規化の確認）
 *  noOdds : 一部オッズ未取得 / 0
 */
const SCENARIOS = {
  'ooi-5': 'strong',
  'kochi-1': 'flat',
  'kawasaki-3': 'missing',
  'sonoda-2': 'noOdds',
};

function mulberry32(seed) {
  let s = seed >>> 0;
  return function rand() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed) {
  const rand = mulberry32(seed);
  return {
    rand,
    int: (min, max) => min + Math.floor(rand() * (max - min + 1)),
    pick: (list) => list[Math.floor(rand() * list.length)],
    gauss: () => {
      const u = Math.max(rand(), 1e-9);
      const v = rand();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    shuffle: (list) => {
      const a = list.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
  };
}

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const round1 = (v) => Math.round(v * 10) / 10;

/** 頭数から枠番を割り当てる（8頭以下は馬番=枠番、9頭以上は外枠から2頭ずつ） */
function frameNumbers(n) {
  const counts = new Array(8).fill(n >= 8 ? 1 : 0);
  if (n < 8) {
    for (let i = 0; i < n; i++) counts[i] = 1;
  } else {
    for (let extra = n - 8, f = 7; extra > 0; extra--, f--) counts[f] += 1;
  }
  const frames = [];
  counts.forEach((c, i) => {
    for (let k = 0; k < c; k++) frames.push(i + 1);
  });
  return frames;
}

function binomial(rng, n, p) {
  let k = 0;
  for (let i = 0; i < n; i++) if (rng.rand() < p) k++;
  return k;
}

function makeRecord(rng, ability, maxStarts) {
  const starts = rng.int(0, maxStarts);
  const wins = binomial(rng, starts, 0.04 + ability * 0.32);
  const places = wins + binomial(rng, starts - wins, 0.1 + ability * 0.4);
  return { starts, wins, places };
}

function makeHorse(rng, ability, ctx) {
  const finishes = [];
  const margins = [];
  for (let i = 0; i < 5; i++) {
    const expected = 1 + (1 - ability) * 9;
    const pos = clamp(Math.round(expected + rng.gauss() * 2.2), 1, 12);
    finishes.push(pos);
    margins.push(pos === 1 ? -round1(rng.rand() * 0.6) : round1((pos - 1) * 0.22 + rng.rand() * 0.6));
  }
  const weight = 52 + rng.int(0, 10) * 0.5;
  const restRoll = rng.rand();
  const restDays = restRoll < 0.08 ? rng.int(5, 9) : restRoll < 0.85 ? rng.int(14, 45) : rng.int(90, 240);

  return {
    ability,
    name: ctx.name,
    jockey: ctx.jockey,
    weight,
    lastWeight: weight + rng.pick([-1, 0, 0, 0, 0, 1, 2]),
    recentFinishes: finishes,
    recentMargins: margins,
    sameDistanceRecord: makeRecord(rng, ability, 8),
    trackRecord: makeRecord(rng, ability, 12),
    surfaceAptitude: clamp(Math.round(2 + ability * 2.2 + rng.gauss() * 0.8), 1, 5),
    jockeyRating: clamp(Math.round(55 + rng.gauss() * 15 + ability * 10), 25, 98),
    classRating: clamp(Math.round(35 + ability * 45 + rng.gauss() * 8), 10, 95),
    restDays,
  };
}

function makeRace(track, raceNo, trackIndex) {
  const rng = makeRng(trackIndex * 1000 + raceNo * 37 + 2026);
  const scenario = SCENARIOS[`${track.id}-${raceNo}`] || 'normal';
  const headcount = rng.int(8, 12);
  const distance = rng.pick(track.distances);
  const raceClass = CLASSES[Math.min(CLASSES.length - 1, raceNo - 1)];

  // 能力値
  let abilities = Array.from({ length: headcount }, () => clamp(0.5 + rng.gauss() * 0.2, 0.05, 0.95));
  if (scenario === 'flat') abilities = abilities.map(() => clamp(0.5 + rng.gauss() * 0.015, 0.4, 0.6));
  if (scenario === 'strong') {
    abilities = abilities.map((a) => Math.min(a, 0.5));
    abilities[2] = 0.93;
    abilities[headcount - 2] = 0.72;
  }

  const names = rng.shuffle(NAME_HEAD).map((h, i) => h + rng.shuffle(NAME_TAIL)[i % NAME_TAIL.length]);
  const jockeys = rng.shuffle(JOCKEY_FAMILY).map((f) => `${f} ${rng.pick(JOCKEY_GIVEN)}`);
  const frames = frameNumbers(headcount);

  const horses = abilities.map((ability, i) =>
    makeHorse(rng, ability, { name: names[i], jockey: jockeys[i % jockeys.length] }),
  );

  // 市場評価（オッズ）: 能力とは別のノイズ + 騎手人気バイアス
  const marketScores = horses.map((h) => h.ability + rng.gauss() * 0.1 + (h.jockeyRating - 60) / 500);
  if (scenario === 'strong') marketScores[headcount - 2] -= 0.25; // 穴馬は人気薄
  const exps = marketScores.map((s) => Math.exp(s * 5));
  const total = exps.reduce((a, b) => a + b, 0);

  const entries = horses.map((h, i) => {
    const marketProb = exps[i] / total;
    const { ability, ...rest } = h; // 能力値は公開しない
    return {
      number: i + 1,
      frame: frames[i],
      ...rest,
      odds: clamp(round1(0.78 / marketProb), 1.1, 499.9),
    };
  });

  if (scenario === 'missing') {
    entries.forEach((e, i) => {
      if (i % 2 === 0) {
        e.recentFinishes = [e.recentFinishes[0], null, null, null, null];
        e.recentMargins = [null, null, null, null, null];
        e.sameDistanceRecord = null;
        e.trackRecord = null;
        e.surfaceAptitude = null;
      }
      if (i % 3 === 0) e.jockeyRating = null;
      if (i % 4 === 1) e.odds = null;
    });
  }
  if (scenario === 'noOdds') {
    entries[1].odds = null;
    entries[4].odds = 0;
    delete entries[6].odds;
  }

  const [hh, mm] = track.firstPost.split(':').map(Number);
  const minutes = hh * 60 + mm + (raceNo - 1) * 30;

  return {
    trackId: track.id,
    trackName: track.name,
    raceNo,
    name: `${raceClass}${raceNo >= 7 ? ' 特別' : ''}`,
    raceClass,
    surface: 'ダート',
    distance,
    going: rng.pick(GOINGS),
    startTime: `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`,
    headcount,
    scenario,
    horses: entries,
  };
}

let cache = null;

function buildMockDatabase() {
  if (cache) return cache;
  const races = {};
  TRACKS.forEach((track, ti) => {
    races[track.id] = [];
    for (let r = 1; r <= track.races; r++) races[track.id].push(makeRace(track, r, ti));
  });
  cache = {
    tracks: TRACKS.map(({ id, name, region, races: count }) => ({ id, name, region, raceCount: count })),
    races,
  };
  return cache;
}

module.exports = { buildMockDatabase, frameNumbers };
