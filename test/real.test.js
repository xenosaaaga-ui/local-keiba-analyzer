'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { zipSync, strToU8 } = require('fflate');
const { createApp } = require('../src/app');
const { createNarDiagnostics } = require('../src/data/nar/diagnostics');

const AUTH = { user: 'me', password: 'secret-pass' };
const authHeader = (user, pass) => ({ Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` });

function fakeResponse(bytes, { status = 200, type = 'application/zip' } = {}) {
  return new Response(bytes, { status, headers: { 'content-type': type } });
}

async function listen(app) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('本人専用モード: 認証なし・誤りは401、正しければ通る', async () => {
  const { server, base } = await listen(createApp({ auth: AUTH, diagnose: async () => ({ ok: true }) }));
  try {
    const noAuth = await fetch(`${base}/real/`);
    assert.equal(noAuth.status, 401);
    assert.match(noAuth.headers.get('www-authenticate'), /^Basic /);
    assert.equal((await fetch(`${base}/real/api/diag`, { headers: authHeader('me', 'wrong') })).status, 401);
    assert.equal((await fetch(`${base}/real/api/diag`, { headers: authHeader('other', 'secret-pass') })).status, 401);

    const ok = await fetch(`${base}/real/`, { headers: authHeader('me', 'secret-pass') });
    assert.equal(ok.status, 200);
    assert.ok((await ok.text()).includes('app.js'));
    assert.equal((await fetch(`${base}/real/api/diag`, { headers: authHeader('me', 'secret-pass') })).status, 200);
  } finally {
    server.close();
  }
});

test('本人専用モード: 認証情報が未設定なら無効（503）', async () => {
  const { server, base } = await listen(createApp({ auth: {}, diagnose: async () => ({ ok: true }) }));
  try {
    assert.equal((await fetch(`${base}/real/`)).status, 503);
    assert.equal((await fetch(`${base}/real/api/diag`, { headers: authHeader('', '') })).status, 503);
    // 公開モック版は影響を受けない
    assert.equal((await fetch(`${base}/api/tracks`)).status, 200);
  } finally {
    server.close();
  }
});

test('診断: race.zip を1回取得してステータス・サイズ・ZIP検証を返す', async () => {
  const zip = zipSync({ '20261006_racelist.csv': strToU8('競馬場\n大井\n') });
  let calls = 0;
  let t = 0;
  const diagnose = createNarDiagnostics({
    fetchImpl: async () => {
      calls++;
      return fakeResponse(zip);
    },
    now: () => t,
  });

  const r1 = await diagnose();
  assert.equal(r1.ok, true);
  assert.equal(r1.status, 200);
  assert.equal(r1.contentType, 'application/zip');
  assert.equal(r1.bytes, zip.length);
  assert.equal(typeof r1.ms, 'number');
  assert.equal(r1.zip.valid, true);
  assert.deepEqual(r1.zip.entries.map((e) => e.name), ['20261006_racelist.csv']);
  assert.equal(r1.cached, false);

  // 2分以内の再実行は NAR にアクセスしない
  t += 60 * 1000;
  const r2 = await diagnose();
  assert.equal(r2.cached, true);
  assert.equal(calls, 1);

  t += 61 * 1000;
  await diagnose();
  assert.equal(calls, 2);
});

test('診断: HTML が返る・HTTPエラー・通信失敗は ok=false', async () => {
  const html = createNarDiagnostics({ fetchImpl: async () => fakeResponse(strToU8('<html>'), { type: 'text/html' }) });
  const r1 = await html();
  assert.equal(r1.ok, false);
  assert.equal(r1.zip.valid, false);

  const forbidden = createNarDiagnostics({ fetchImpl: async () => fakeResponse(strToU8('no'), { status: 403, type: 'text/plain' }) });
  const r2 = await forbidden();
  assert.equal(r2.ok, false);
  assert.equal(r2.status, 403);

  const down = createNarDiagnostics({
    fetchImpl: async () => {
      throw new Error('ECONNRESET');
    },
  });
  const r3 = await down();
  assert.equal(r3.ok, false);
  assert.equal(r3.error, 'ECONNRESET');
});
