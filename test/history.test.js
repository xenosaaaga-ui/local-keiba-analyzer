'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { unzipSync } = require('fflate');
const { compactMonthly, parsePackedTime, encode, decode } = require('../src/data/nar/monthly');
const { createHistoryService, monthsFor, latestBoundary, finalAfter } = require('../src/data/nar/history');
const { createMemoryStore } = require('../src/data/nar/historyStore');
const { createNarAdapter } = require('../src/data/adapters/narAdapter');
const { buildMonthlyZip, createFakeNarFetch } = require('./helpers/narFixture');

const JST = 9 * 3600 * 1000;
const jst = (y, m, d, h, min = 0) => Date.UTC(y, m - 1, d, h, min) - JST;

// 架空の過去走: テストホース1(20220401) と 同名で生年月日違い、テストホース2(20220402)
function septemberRuns() {
  return [
    { date: '20260920', track: '大井', raceNo: 3, distance: 1400, going: '良', name: 'テストホース1', birth: '20220401', finish: 1, time: 87.0, margin: '', last3F: 38.1 },
    { date: '20260920', track: '大井', raceNo: 3, distance: 1400, going: '良', name: 'テストホース2', birth: '20220402', finish: 2, time: 87.4, margin: '2', last3F: 38.5 },
    { date: '20260920', track: '大井', raceNo: 3, distance: 1400, going: '良', name: '他の馬', birth: '20200101', finish: 3, time: 88.0, margin: '3', last3F: 39.0 },
    { date: '20260920', track: '大井', raceNo: 3, distance: 1400, going: '良', name: '取消の馬', birth: '20200102', finish: null, time: null, margin: '出走取消' },
    { date: '20260905', track: '川崎', raceNo: 1, distance: 1500, going: '重', name: 'テストホース1', birth: '20220401', finish: 5, time: 95.1, margin: '3', last3F: 40.0 },
    { date: '20260905', track: '川崎', raceNo: 1, distance: 1500, going: '重', name: 'テストホース1', birth: '20190101', finish: 1, time: 94.0, margin: '', last3F: 39.0 }, // 同名別馬
    { date: '20260905', track: '川崎', raceNo: 1, distance: 1500, going: '重', name: '中止の馬', birth: '20200103', finish: null, time: null, margin: '競走中止' },
  ];
}
const octoberRuns = () => [
  { date: '20261001', track: '大井', raceNo: 5, distance: 1600, going: '稍重', name: 'テストホース1', birth: '20220401', finish: 3, time: 101.2, margin: 'クビ', last3F: 38.9 },
  { date: '20261001', track: '大井', raceNo: 5, distance: 1600, going: '稍重', name: '勝った馬', birth: '20200104', finish: 1, time: 100.8, margin: '' },
  // 今日の出馬表（月次ファイルには当日以降の出走予定も入る）→ 近走に含めない
  { date: '20261006', track: '大井', raceNo: 1, distance: 1400, going: '良', name: 'テストホース1', birth: '20220401', finish: null, time: null },
];

function monthlyFor(month) {
  if (month === '202609') return buildMonthlyZip(month, septemberRuns());
  if (month === '202610') return buildMonthlyZip(month, octoberRuns());
  return buildMonthlyZip(month, [{ date: `${month}10`, track: '園田', raceNo: 1, distance: 1230, name: '古い馬', birth: '20190505', finish: 1, time: 75.0 }]);
}

test('月次: 走破タイム・勝ち馬とのタイム差・取消の除外', () => {
  assert.equal(parsePackedTime('1270'), 87.0);
  assert.equal(parsePackedTime('2043'), 124.3);
  assert.equal(parsePackedTime('589'), 58.9);
  assert.equal(parsePackedTime(''), null);

  const c = compactMonthly(unzipSync(buildMonthlyZip('202609', septemberRuns())));
  const runs = c.runs.map(([key, , finish, margin, time, last3F, behind, runners]) => ({ key, finish, margin, time, last3F, behind, runners }));
  assert.ok(!runs.some((r) => r.key.startsWith('取消の馬')), '出走取消は近走に含めない');
  const winner = runs.find((r) => r.key === 'テストホース1|20220401' && r.time === 87);
  assert.equal(winner.behind, -0.4, '勝ち馬は2着とのタイム差をマイナスで持つ');
  assert.equal(winner.runners, 3);
  assert.equal(runs.find((r) => r.key === 'テストホース2|20220402').behind, 0.4);
  const dnf = runs.find((r) => r.key.startsWith('中止の馬'));
  assert.equal(dnf.finish, null, '競走中止は着順なしの1走');
  assert.deepEqual(decode(encode(c)), c);
});

test('月の範囲・更新境界（03:00 JST）・確定時刻', () => {
  assert.deepEqual(monthsFor('20260215'), ['202602', '202601', '202512', '202511', '202510', '202509']);
  assert.equal(latestBoundary(jst(2026, 10, 6, 12)), jst(2026, 10, 6, 3));
  assert.equal(latestBoundary(jst(2026, 10, 6, 2)), jst(2026, 10, 5, 3));
  assert.equal(finalAfter('202609'), jst(2026, 10, 2, 3));
  assert.equal(finalAfter('202612'), jst(2027, 1, 2, 3));
});

test('近走の照合: 馬名＋生年月日・今日以降は除外・新しい順・前走からの日数', async () => {
  const fake = createFakeNarFetch({ monthly: monthlyFor });
  const h = createHistoryService({ store: createMemoryStore(), fetchImpl: fake.fetch, now: () => jst(2026, 10, 6, 12), fetchGapMs: 0 });
  const { index, status } = await h.load('20261006');
  assert.equal(status.months.length, 6);

  const { runs, daysSinceLast } = h.recentRunsFor(index, 'テストホース1', '20220401', '20261006');
  assert.deepEqual(runs.map((r) => r.date), ['20261001', '20260920', '20260905']);
  assert.deepEqual(runs.map((r) => r.finish), [3, 1, 5]);
  assert.equal(runs[0].going, '稍重');
  assert.equal(runs[0].margin, 'クビ');
  assert.equal(runs[0].behind, 0.4);
  assert.equal(runs[0].last3F, 38.9);
  assert.equal(daysSinceLast, 5);

  // 同名でも生年月日が違えば別馬
  assert.deepEqual(h.recentRunsFor(index, 'テストホース1', '20190101', '20261006').runs.map((r) => r.finish), [1]);
  assert.deepEqual(h.recentRunsFor(index, '未登録の馬', '20220101', '20261006'), { runs: [], daysSinceLast: null });
});

test('月次ファイルの取得は1日1回まで: 再起動しても保存済みなら取りに行かない', async () => {
  const fake = createFakeNarFetch({ monthly: monthlyFor });
  const store = createMemoryStore(); // Render Key Value の代わり（プロセスをまたいで残る）
  let t = jst(2026, 10, 6, 12);
  const service = () => createHistoryService({ store, fetchImpl: fake.fetch, now: () => t, fetchGapMs: 0 });

  await service().load('20261006');
  assert.deepEqual(fake.calls.monthly.sort(), ['202605', '202606', '202607', '202608', '202609', '202610']);

  // 同じ日に何度起動し直しても（スリープ復帰）取得しない
  fake.calls.monthly.length = 0;
  t = jst(2026, 10, 6, 18);
  await service().load('20261006');
  t = jst(2026, 10, 7, 2, 59);
  await service().load('20261006');
  assert.deepEqual(fake.calls.monthly, []);

  // 翌日 03:00 JST 以降は、未確定の当月だけ取り直す（9月以前は10/2以降に取ったので確定済み）
  t = jst(2026, 10, 7, 3, 1);
  const h = service();
  await h.load('20261007');
  assert.deepEqual(fake.calls.monthly, ['202610']);

  // 同じプロセス内でも、境界を越えるまでは取り直さない
  fake.calls.monthly.length = 0;
  t = jst(2026, 10, 7, 23);
  await h.load('20261007');
  assert.deepEqual(fake.calls.monthly, []);
});

test('月末直後は前月も確定するまで1日1回取り直す', async () => {
  const fake = createFakeNarFetch({ monthly: monthlyFor });
  const store = createMemoryStore();
  let t = jst(2026, 10, 1, 12); // 10/1 に取得 → 9月の最終日(9/30)の成績は 10/1 の更新で入るが、念のため 10/2 まで未確定扱い
  await createHistoryService({ store, fetchImpl: fake.fetch, now: () => t, fetchGapMs: 0 }).load('20261001');
  fake.calls.monthly.length = 0;
  t = jst(2026, 10, 2, 12);
  await createHistoryService({ store, fetchImpl: fake.fetch, now: () => t, fetchGapMs: 0 }).load('20261002');
  assert.deepEqual(fake.calls.monthly.sort(), ['202609', '202610']);
  fake.calls.monthly.length = 0;
  t = jst(2026, 10, 3, 12);
  await createHistoryService({ store, fetchImpl: fake.fetch, now: () => t, fetchGapMs: 0 }).load('20261003');
  assert.deepEqual(fake.calls.monthly, ['202610']);
});

test('月次の取得失敗: 保存済みデータを使い続け、1時間は再試行しない', async () => {
  let fail = false;
  const fake = createFakeNarFetch({ monthly: (m) => (fail ? { status: 503 } : monthlyFor(m)) });
  const store = createMemoryStore();
  let t = jst(2026, 10, 6, 12);
  await createHistoryService({ store, fetchImpl: fake.fetch, now: () => t, fetchGapMs: 0 }).load('20261006');

  fail = true;
  fake.calls.monthly.length = 0;
  t = jst(2026, 10, 7, 4);
  const h = createHistoryService({ store, fetchImpl: fake.fetch, now: () => t, fetchGapMs: 0 });
  const r1 = await h.load('20261007');
  assert.deepEqual(fake.calls.monthly, ['202610']);
  assert.match(r1.status.errors[0], /202610/);
  assert.ok(h.recentRunsFor(r1.index, 'テストホース1', '20220401', '20261007').runs.length > 0, '前日の保存分で近走は出せる');

  t += 30 * 60 * 1000;
  await createHistoryService({ store, fetchImpl: fake.fetch, now: () => t, fetchGapMs: 0 }).load('20261007');
  assert.deepEqual(fake.calls.monthly, ['202610'], '1時間以内は再試行しない');
});

test('narAdapter: 今日の出走馬に近5走を付け、月次が全滅しても近走無しで表示を続ける', async () => {
  const fake = createFakeNarFetch({ monthly: monthlyFor });
  const now = () => jst(2026, 10, 6, 12);
  const history = createHistoryService({ store: createMemoryStore(), fetchImpl: fake.fetch, now, fetchGapMs: 0 });
  const nar = createNarAdapter({ fetchImpl: fake.fetch, now, history });
  const race = await nar.getRace('ooi', 1);
  const h1 = race.horses.find((h) => h.number === 1);
  assert.deepEqual(h1.recentFinishes, [3, 1, 5]);
  assert.deepEqual(h1.recentMargins.slice(0, 2), [0.4, -0.4]);
  assert.equal(h1.daysSinceLast, 5);
  assert.equal(h1.recentRuns[0].track, '大井');
  const h4 = race.horses.find((h) => h.number === 4);
  assert.deepEqual(h4.recentRuns, []);
  assert.equal(nar.status().history.matched >= 2, true);

  const down = createFakeNarFetch({ monthly: () => new Error('ECONNRESET') });
  const nar2 = createNarAdapter({
    fetchImpl: down.fetch,
    now,
    history: createHistoryService({ store: createMemoryStore(), fetchImpl: down.fetch, now, fetchGapMs: 0 }),
  });
  const r2 = await nar2.getRace('ooi', 1);
  assert.equal(r2.horses.length, 3);
  assert.ok(nar2.status().warnings.some((w) => w.includes('近走')));
});
