'use strict';

const { URLS, downloadZip } = require('./client');
const { compactMonthly, encode, decode, horseKey } = require('./monthly');

/**
 * 今日の出走馬の近走を、NAR 月次ファイル（過去6か月分）から照合するサービス。
 *
 * 月次ファイルの取得方針（公式推奨: 1日1回が上限、毎日 午前2時頃 更新）
 *  - 月ごとに Key Value へ保存し、Web サービスがスリープしても再取得しない。
 *  - 確定済みの月（翌月2日 03:00 JST 以降に取得したもの）は二度と取得しない。
 *  - 未確定の月（当月など）は、前回取得が直近の 03:00 JST より前のときだけ再取得する
 *    → 同じ月を取りに行くのは 1日1回まで。
 *  - 取得失敗時は保存済みデータを使い続け、1時間は再試行しない。
 */

const MONTHS_BACK = 6; // 当月を含めて6か月分
const RECENT_RUNS = 5;
const UPDATE_HOUR_JST = 3; // 公式の更新（午前2時頃）に余裕を持たせた境界
const FAILURE_BACKOFF_MS = 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 10 * 60 * 1000; // 保存済みデータの鮮度確認の間隔
const FETCH_GAP_MS = 1000; // 複数月を取るときの間隔

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** "20261006" → ["202610", "202609", …]（当月から過去へ） */
function monthsFor(dateYmd, count = MONTHS_BACK) {
  let y = Number(dateYmd.slice(0, 4));
  let m = Number(dateYmd.slice(4, 6));
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(`${y}${String(m).padStart(2, '0')}`);
    if (--m === 0) {
      m = 12;
      y--;
    }
  }
  return out;
}

/** JST の y/m/d h:00 を UTC ミリ秒に */
const jstTime = (y, m, d, h) => Date.UTC(y, m - 1, d, h) - JST_OFFSET_MS;

/** now 以前で最も新しい「03:00 JST」 */
function latestBoundary(now) {
  const j = new Date(now + JST_OFFSET_MS);
  let t = jstTime(j.getUTCFullYear(), j.getUTCMonth() + 1, j.getUTCDate(), UPDATE_HOUR_JST);
  if (t > now) t -= 24 * 60 * 60 * 1000;
  return t;
}

/** この時刻以降に取得した月次ファイルは、その月の全成績を含む（翌月1日の更新で最終日の成績が入る） */
function finalAfter(month) {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(4, 6));
  return m === 12 ? jstTime(y + 1, 1, 2, UPDATE_HOUR_JST) : jstTime(y, m + 1, 2, UPDATE_HOUR_JST);
}

function needsFetch(month, meta, now) {
  if (meta && meta.failedAt && now - meta.failedAt < FAILURE_BACKOFF_MS) return false;
  if (!meta || !meta.fetchedAt) return true;
  if (meta.final) return false;
  return meta.fetchedAt < latestBoundary(now);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createHistoryService({ store, fetchImpl = fetch, now = Date.now, fetchGapMs = FETCH_GAP_MS } = {}) {
  let cached = null; // { months: { [month]: fetchedAt }, index: Map, status, checkedAt, anchor }
  let inFlight = null;

  async function refreshMonth(month, meta, t, log) {
    try {
      const res = await downloadZip(URLS.monthlyRace(month), { fetchImpl, timeoutMs: 60000 });
      const compact = compactMonthly(res.files);
      const newMeta = { fetchedAt: t, final: t >= finalAfter(month), runs: compact.runs.length, bytes: res.bytes.length };
      await store.setData(month, encode(compact), newMeta);
      log.fetched.push(month);
      return newMeta;
    } catch (e) {
      const message = e.name === 'TimeoutError' ? 'タイムアウト' : e.message;
      console.error(`[history] ${month} 取得失敗:`, message);
      log.errors.push(`${month}: ${message}`);
      await store.setMeta(month, { ...(meta || {}), failedAt: t, error: message });
      return meta;
    }
  }

  async function build(anchorDate) {
    const t = now();
    const months = monthsFor(anchorDate);
    const log = { fetched: [], errors: [] };
    const metas = {};
    let first = true;
    for (const month of months) {
      let meta = await store.getMeta(month);
      if (needsFetch(month, meta, t)) {
        if (!first) await sleep(fetchGapMs);
        first = false;
        meta = await refreshMonth(month, meta, t, log);
      }
      metas[month] = meta;
    }

    // 保存内容が前回と同じなら索引を作り直さない
    const signature = months.map((m) => `${m}:${(metas[m] && metas[m].fetchedAt) || 0}`).join(',');
    if (cached && cached.signature === signature) {
      return { ...cached, checkedAt: t, status: { ...cached.status, fetchedNow: log.fetched, errors: log.errors } };
    }

    const index = new Map();
    const loaded = [];
    for (const month of months) {
      const meta = metas[month];
      if (!meta || !meta.fetchedAt) continue;
      const buf = await store.getData(month);
      if (!buf) continue;
      const { races, runs } = decode(buf);
      for (const [key, raceIdx, finish, margin, time, last3F, behind, runners] of runs) {
        const [date, track, raceNo, distance, surface, going, raceName] = races[raceIdx];
        const list = index.get(key) || index.set(key, []).get(key);
        list.push({ date, track, raceNo, distance, surface, going, raceName, finish, margin, time, last3F, behind, runners });
      }
      loaded.push({ month, fetchedAt: new Date(meta.fetchedAt).toISOString(), final: Boolean(meta.final), runs: meta.runs });
    }
    for (const list of index.values()) list.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.raceNo - a.raceNo));

    return {
      signature,
      index,
      checkedAt: t,
      anchor: anchorDate,
      status: { store: store.kind, months: loaded, fetchedNow: log.fetched, errors: log.errors },
    };
  }

  /** 今日（YYYYMMDD）を基準に、必要なら月次ファイルを取得して索引を返す */
  async function load(todayYmd) {
    const t = now();
    if (cached && cached.anchor === todayYmd && t - cached.checkedAt < CHECK_INTERVAL_MS) return cached;
    if (!inFlight) {
      inFlight = build(todayYmd)
        .then((result) => {
          cached = result;
          return result;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  }

  /**
   * 馬の近走（今日より前、新しい順に最大5走）。前走からの日数も付ける。
   * @returns {{ runs: object[], daysSinceLast: number|null }}
   */
  function recentRunsFor(index, name, birthDate, todayYmd) {
    if (!name || !birthDate) return { runs: [], daysSinceLast: null };
    const all = index.get(horseKey(name, birthDate)) || [];
    const runs = all.filter((r) => r.date < todayYmd).slice(0, RECENT_RUNS);
    const toUtc = (ymd) => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)));
    const daysSinceLast = runs.length ? Math.round((toUtc(todayYmd) - toUtc(runs[0].date)) / 86400000) : null;
    return { runs, daysSinceLast };
  }

  return { load, recentRunsFor };
}

module.exports = { createHistoryService, monthsFor, latestBoundary, finalAfter, needsFetch, MONTHS_BACK };
