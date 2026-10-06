'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { unzipSync } = require('fflate');
const { buildSnapshot, parseRecord, toNum, formatTime } = require('../src/data/nar/parse');
const { createNarAdapter } = require('../src/data/adapters/narAdapter');
const { createMockAdapter } = require('../src/data/adapters/mockAdapter');
const { createFallbackSource } = require('../src/data/adapters/fallbackAdapter');
const { createApp } = require('../src/app');
const { analyzeRace } = require('../src/prediction');
const { buildRaceZip, buildOddsZip, createFakeNarFetch } = require('./helpers/narFixture');

test('値の変換: 成績・減量記号付き斤量・発走時刻', () => {
  assert.deepEqual(parseRecord('1-2-0-5'), { starts: 8, wins: 1, places: 3 });
  assert.equal(parseRecord('0-0-0-0'), null);
  assert.equal(parseRecord(''), null);
  assert.equal(toNum('★53'), 53);
  assert.equal(toNum('▲51.5'), 51.5);
  assert.equal(toNum('+10'), 10);
  assert.equal(toNum('-8'), -8);
  assert.equal(toNum(''), null);
  assert.equal(formatTime('1540'), '15:40');
  assert.equal(formatTime('945'), '09:45');
  assert.equal(formatTime(''), null);
});

test('buildSnapshot: CSV を競馬場・レース・出走馬に変換する', () => {
  const snap = buildSnapshot(unzipSync(buildRaceZip()), unzipSync(buildOddsZip()));
  assert.equal(snap.date, '20261006');
  assert.equal(snap.hasOdds, true);
  assert.deepEqual(
    snap.tracks.map((t) => [t.id, t.name, t.raceCount]),
    [['ooi', '大井', 2], ['track1', '新競馬場', 1]],
  );

  const race = snap.races.ooi[0];
  assert.equal(race.startTime, '15:40');
  assert.equal(race.distance, 1400);
  assert.equal(race.turn, '右');
  // 出走取消（馬番3）は除外し、頭数も取消後の数にする
  assert.deepEqual(race.horses.map((h) => h.number), [1, 2, 4]);
  assert.equal(race.headcount, 3);

  const [h1, h2, h4] = race.horses;
  assert.equal(h1.weight, 53); // ★53
  assert.equal(h1.odds, 2.4); // 単勝のみ採用（複勝 1.1 ではない）
  assert.equal(h2.odds, 15);
  assert.equal(h4.odds, 5.1);
  assert.deepEqual(h1.trackRecord, { starts: 5, wins: 1, places: 2 });
  assert.deepEqual(h1.sameDistanceRecord, { starts: 2, wins: 1, places: 1 });
  assert.equal(h2.trackRecord, null); // 0戦は null
  assert.ok(h1.surfaceAptitude >= 1 && h1.surfaceAptitude <= 5); // 右回り → ダート右成績から算出
  assert.equal(h1.bodyWeightDiff, 2);
  assert.deepEqual(h1.recentFinishes, []);
  assert.equal(snap.races.ooi[1].horses[0].odds, null); // オッズ行が無いレース
});

test('buildSnapshot: オッズ無しでも動き、必須ファイルが無ければ例外', () => {
  const snap = buildSnapshot(unzipSync(buildRaceZip()), null);
  assert.equal(snap.hasOdds, false);
  assert.equal(snap.races.ooi[0].horses[0].odds, null);
  assert.throws(() => buildSnapshot({}, null), /racelist/);
});

test('実データのレースも予想ロジックで NaN を出さずに分析できる', () => {
  const snap = buildSnapshot(unzipSync(buildRaceZip()), unzipSync(buildOddsZip()));
  const result = analyzeRace(snap.races.ooi[0]);
  assert.equal(result.horses.length, 3);
  assert.ok(!JSON.stringify(result).includes('NaN'));
  const total = result.horses.reduce((s, h) => s + h.prediction.winProb, 0);
  assert.ok(Math.abs(total - 1) < 0.01);
});

test('narAdapter: 5分キャッシュ・同時アクセスは1回の取得にまとめる', async () => {
  const fake = createFakeNarFetch();
  let t = 0;
  const nar = createNarAdapter({ fetchImpl: fake.fetch, now: () => t });

  await Promise.all([nar.getTracks(), nar.getRaces('ooi'), nar.getRace('ooi', 1)]);
  assert.deepEqual(fake.calls, { race: 1, odds: 1 });

  t += 4 * 60 * 1000;
  await nar.getRace('ooi', 2);
  assert.deepEqual(fake.calls, { race: 1, odds: 1 }); // 5分以内は再取得しない

  t += 61 * 1000;
  await nar.getTracks();
  assert.deepEqual(fake.calls, { race: 2, odds: 2 });
  assert.equal(nar.status().date, '20261006');
});

test('narAdapter: オッズだけ失敗したらオッズ無しの実データ + 警告', async () => {
  const fake = createFakeNarFetch({ odds: () => ({ status: 500 }) });
  const nar = createNarAdapter({ fetchImpl: fake.fetch });
  const race = await nar.getRace('ooi', 1);
  assert.equal(race.horses[0].odds, null);
  assert.equal(nar.status().hasOdds, false);
  assert.match(nar.status().warnings[0], /オッズ/);
});

test('narAdapter: race.zip 失敗時は例外、2分間は再アクセスしない', async () => {
  const fake = createFakeNarFetch({ race: () => ({ status: 403 }) });
  let t = 0;
  const nar = createNarAdapter({ fetchImpl: fake.fetch, now: () => t });
  await assert.rejects(nar.getTracks(), /HTTP 403/);
  await assert.rejects(nar.getTracks(), /待機中/);
  assert.equal(fake.calls.race, 1);
  t += 2 * 60 * 1000 + 1;
  await assert.rejects(nar.getTracks(), /HTTP 403/);
  assert.equal(fake.calls.race, 2);
});

test('fallbackAdapter: 実データ失敗時はモックを使い、理由を返す', async () => {
  const ok = createFallbackSource(createNarAdapter({ fetchImpl: createFakeNarFetch().fetch }), createMockAdapter());
  const r1 = await ok.resolve();
  assert.equal(r1.status.source, 'nar');
  assert.equal(r1.status.mock, false);

  const html = createFakeNarFetch({ race: () => new TextEncoder().encode('<html>maintenance</html>') });
  const ng = createFallbackSource(createNarAdapter({ fetchImpl: html.fetch }), createMockAdapter());
  const r2 = await ng.resolve();
  assert.equal(r2.status.source, 'mock');
  assert.equal(r2.status.fallback, true);
  assert.match(r2.status.reason, /ZIP/);
  assert.ok((await r2.source.getTracks()).some((t) => t.name === '大井'));
});

// ---------- API ----------
const AUTH = { user: 'me', password: 'pw' };
const headers = { Authorization: `Basic ${Buffer.from('me:pw').toString('base64')}` };

async function withApp(realFetch, fn) {
  const realDataSource = createFallbackSource(createNarAdapter({ fetchImpl: realFetch }), createMockAdapter());
  const server = createApp({ auth: AUTH, realDataSource, diagnose: async () => ({ ok: true }) }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

test('API: /real/api は実データを返し、dataStatus で「実データ」と分かる', async () => {
  const fake = createFakeNarFetch();
  await withApp(fake.fetch, async (base) => {
    const tracks = await (await fetch(`${base}/real/api/tracks`, { headers })).json();
    assert.equal(tracks.mock, false);
    assert.equal(tracks.dataStatus.source, 'nar');
    assert.ok(tracks.dataStatus.fetchedAt);
    assert.deepEqual(tracks.tracks.map((t) => t.id), ['ooi', 'track1']);

    const races = await (await fetch(`${base}/real/api/races?track=ooi`, { headers })).json();
    assert.deepEqual(races.races.map((r) => [r.raceNo, r.headcount]), [[1, 3], [2, 2]]);

    const race = await (await fetch(`${base}/real/api/race?track=ooi&race=1`, { headers })).json();
    assert.equal(race.race.trackName, '大井');
    assert.equal(race.dataStatus.source, 'nar');

    // 公開版はモックのまま。NAR へはアクセスしない
    const before = { ...fake.calls };
    const pub = await (await fetch(`${base}/api/tracks`)).json();
    assert.equal(pub.mock, true);
    assert.equal(pub.dataStatus.source, 'mock');
    assert.deepEqual(fake.calls, before);
  });
});

test('API: NAR 取得失敗時はモックへフォールバックし、そのことを返す', async () => {
  const fake = createFakeNarFetch({
    race: () => {
      throw new Error('ECONNREFUSED');
    },
  });
  await withApp(fake.fetch, async (base) => {
    const body = await (await fetch(`${base}/real/api/tracks`, { headers })).json();
    assert.equal(body.mock, true);
    assert.equal(body.dataStatus.fallback, true);
    assert.match(body.dataStatus.reason, /ECONNREFUSED/);
    assert.ok(body.tracks.some((t) => t.id === 'ooi'));
    const race = await fetch(`${base}/real/api/race?track=ooi&race=1`, { headers });
    assert.equal(race.status, 200);
  });
});

test('API: 認証なしでは実データ API にアクセスできない', async () => {
  const fake = createFakeNarFetch();
  await withApp(fake.fetch, async (base) => {
    assert.equal((await fetch(`${base}/real/api/tracks`)).status, 401);
    assert.equal(fake.calls.race, 0);
  });
});
