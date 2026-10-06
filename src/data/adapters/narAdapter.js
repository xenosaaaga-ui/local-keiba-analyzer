'use strict';

const { URLS, downloadZip } = require('../nar/client');
const { buildSnapshot } = require('../nar/parse');
const { createHistoryService } = require('../nar/history');
const { createHistoryStore } = require('../nar/historyStore');

const CACHE_TTL_MS = 5 * 60 * 1000; // 取得はアクセス時のみ、サーバー側で5分キャッシュ
const FAILURE_BACKOFF_MS = 2 * 60 * 1000; // 失敗後はこの間 NAR に再アクセスしない

/**
 * NAR 公式データダウンロード（当日ファイル）を使うアダプター。
 * インターフェースは mockAdapter と同じ（getTracks / getRaces / getRace）。
 * 取得はアクセス時のみ。5分以内は同じスナップショットを返し、同時アクセスは1回の取得にまとめる。
 * race.zip の取得・解析に失敗したら例外（→ fallbackAdapter がモックへ切り替える）。
 * odds.zip だけ失敗した場合はオッズ無しの実データを返す。
 * 月次ファイルの近走（history）は今日の出走馬に付けるだけ。失敗しても近走無しで続行する。
 */
function createNarAdapter({
  fetchImpl = fetch,
  now = Date.now,
  ttlMs = CACHE_TTL_MS,
  backoffMs = FAILURE_BACKOFF_MS,
  history = createHistoryService({ store: createHistoryStore(), fetchImpl, now }),
} = {}) {
  let cache = null; // { snapshot, fetchedAt, warnings }
  let failure = null; // { at, message }
  let inFlight = null;

  async function fetchSnapshot() {
    const race = await downloadZip(URLS.dailyRace, { fetchImpl });
    const warnings = [];
    let oddsFiles = null;
    try {
      oddsFiles = (await downloadZip(URLS.dailyOdds, { fetchImpl })).files;
    } catch (e) {
      warnings.push(`オッズを取得できませんでした（${e.message}）`);
    }
    const snapshot = buildSnapshot(race.files, oddsFiles);
    const historyStatus = await attachRecentRuns(snapshot, warnings);
    return { snapshot, warnings, historyStatus, fetchedAt: now() };
  }

  /** 今日の出走馬に近5走を付ける。月次データが使えなければ警告だけ出して近走無しで続行 */
  async function attachRecentRuns(snapshot, warnings) {
    if (!history || !snapshot.date) return null;
    try {
      const { index, status } = await history.load(snapshot.date);
      let total = 0;
      let matched = 0;
      for (const list of Object.values(snapshot.races)) {
        for (const race of list) {
          for (const horse of race.horses) {
            const { runs, daysSinceLast } = history.recentRunsFor(index, horse.name, horse.birthDate, snapshot.date);
            total++;
            if (runs.length) matched++;
            horse.recentRuns = runs.map(({ date, track, distance, surface, going, raceName, finish, runners, margin, behind, time, last3F }) => ({
              date, track, distance, surface, going, raceName, finish, runners, margin, behind, time, last3F,
            }));
            horse.recentFinishes = runs.map((r) => r.finish);
            horse.recentMargins = runs.map((r) => r.behind);
            horse.daysSinceLast = daysSinceLast;
          }
        }
      }
      if (status.errors.length) warnings.push(`近走データの一部を取得できませんでした（${status.errors.join(' / ')}）`);
      if (!status.months.length) warnings.push('近走データがありません（月次ファイル未取得）');
      return { ...status, matched, total };
    } catch (e) {
      console.error('[history]', e);
      warnings.push(`近走データを読み込めませんでした（${e.message}）`);
      return null;
    }
  }

  async function load() {
    const t = now();
    if (cache && t - cache.fetchedAt < ttlMs) return cache;
    if (failure && t - failure.at < backoffMs) {
      throw new Error(`NARデータ取得に失敗したため待機中（${failure.message}）`);
    }
    if (!inFlight) {
      inFlight = fetchSnapshot()
        .then((result) => {
          cache = result;
          failure = null;
          return result;
        })
        .catch((e) => {
          failure = { at: now(), message: e.name === 'TimeoutError' ? 'タイムアウト' : e.message };
          console.error('[nar] 取得失敗:', failure.message);
          throw e;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  }

  const clone = (v) => structuredClone(v);

  return {
    name: 'nar',
    isMock: false,
    load,

    /** 現在のキャッシュ状態（表示用） */
    status() {
      return {
        fetchedAt: cache ? new Date(cache.fetchedAt).toISOString() : null,
        date: cache ? cache.snapshot.date : null,
        hasOdds: cache ? cache.snapshot.hasOdds : false,
        history: cache && cache.historyStatus
          ? { matched: cache.historyStatus.matched, total: cache.historyStatus.total, months: cache.historyStatus.months.map((m) => m.month), store: cache.historyStatus.store }
          : null,
        warnings: cache ? cache.warnings : [],
      };
    },

    async getTracks() {
      return clone((await load()).snapshot.tracks);
    },
    async getRaces(trackId) {
      const races = (await load()).snapshot.races[trackId];
      if (!races) return null;
      return races.map(({ horses, ...header }) => clone(header));
    },
    async getRace(trackId, raceNo) {
      const races = (await load()).snapshot.races[trackId];
      const race = races && races.find((r) => r.raceNo === raceNo);
      return race ? clone(race) : null;
    },
  };
}

module.exports = { createNarAdapter, CACHE_TTL_MS, FAILURE_BACKOFF_MS };
