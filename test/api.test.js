'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

let server;
let base;

test.before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

test('GET /api/tracks は競馬場一覧を返す', async () => {
  const res = await fetch(`${base}/api/tracks`);
  assert.equal(res.status, 200);
  const body = await res.json();
  const names = body.tracks.map((t) => t.name);
  for (const n of ['大井', '川崎', '園田', '高知']) assert.ok(names.includes(n));
  assert.equal(body.mock, true);
});

test('GET /api/races はレース一覧（見送り判定付き）を返す', async () => {
  const res = await fetch(`${base}/api/races?track=ooi`);
  assert.equal(res.status, 200);
  const { races } = await res.json();
  assert.ok(races.length >= 2);
  for (const r of races) {
    assert.ok(Number.isInteger(r.raceNo));
    assert.ok(r.headcount >= 8 && r.headcount <= 12);
    assert.equal(typeof r.skip, 'boolean');
  }
});

test('GET /api/race は分析結果を返す', async () => {
  const res = await fetch(`${base}/api/race?track=kawasaki&race=1`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.race.trackName, '川崎');
  assert.ok(body.horses.length >= 8);
  const h = body.horses[0];
  for (const key of ['index', 'winProb', 'ev', 'evRating', 'mark', 'reasons']) assert.ok(key in h.prediction, key);
  assert.ok(body.summary.verdict);
});

test('APIの異常系（存在しない競馬場・不正なレース番号）', async () => {
  assert.equal((await fetch(`${base}/api/races?track=nowhere`)).status, 404);
  assert.equal((await fetch(`${base}/api/races`)).status, 400);
  assert.equal((await fetch(`${base}/api/race?track=ooi&race=abc`)).status, 400);
  assert.equal((await fetch(`${base}/api/race?track=ooi&race=99`)).status, 404);
  assert.equal((await fetch(`${base}/api/unknown`)).status, 404);
});

test('トップページ（スマホUI）が配信される', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('name="viewport"'));
  assert.ok(html.includes('app.js'));
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
});
