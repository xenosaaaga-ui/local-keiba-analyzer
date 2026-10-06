'use strict';

const { URLS, download, unzip } = require('./client');

const MIN_INTERVAL_MS = 2 * 60 * 1000; // 公式推奨（当日ファイルは2分に1回程度）に合わせる

/**
 * Render → NAR の疎通診断。当日 race.zip を1回だけ取得し、
 * HTTPステータス / Content-Type / サイズ / 取得時間 / ZIPとして正常か を返す。
 * 連打されても NAR へのアクセスは2分に1回までに抑え、それ以内は前回結果を返す。
 */
function createNarDiagnostics({ fetchImpl = fetch, now = Date.now } = {}) {
  let last = null;
  let inFlight = null;

  async function run() {
    const checkedAt = new Date(now()).toISOString();
    const result = { url: URLS.dailyRace, checkedAt };
    try {
      const res = await download(URLS.dailyRace, { fetchImpl });
      Object.assign(result, { status: res.status, contentType: res.contentType, bytes: res.bytes.length, ms: res.ms });
      try {
        const files = unzip(res.bytes);
        result.zip = {
          valid: true,
          entries: Object.entries(files).map(([name, data]) => ({ name, bytes: data.length })),
        };
      } catch (e) {
        result.zip = { valid: false, error: e.message };
      }
      result.ok = res.status === 200 && result.zip.valid;
    } catch (e) {
      result.ok = false;
      result.error = e.name === 'TimeoutError' ? 'タイムアウト' : e.message;
    }
    return result;
  }

  return async function diagnose() {
    if (last && now() - last.at < MIN_INTERVAL_MS) {
      return { ...last.result, cached: true, nextAllowedAt: new Date(last.at + MIN_INTERVAL_MS).toISOString() };
    }
    if (!inFlight) {
      inFlight = run().then((result) => {
        last = { at: now(), result };
        inFlight = null;
        return result;
      });
    }
    return { ...(await inFlight), cached: false };
  };
}

module.exports = { createNarDiagnostics, MIN_INTERVAL_MS };
