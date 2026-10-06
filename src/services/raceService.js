'use strict';

const { analyzeRace } = require('../prediction');

/**
 * リクエストごとに使うアダプターと表示用の状態を決める。
 * fallbackAdapter のように resolve() を持つデータソースはそれに従い、
 * それ以外（モック等）はデータソース自身を使う。
 */
async function resolveSource(dataSource) {
  if (typeof dataSource.resolve === 'function') return dataSource.resolve();
  return { source: dataSource, status: { source: dataSource.name, mock: Boolean(dataSource.isMock) } };
}

/** データ取得層と予想ロジックをつなぐサービス層。各メソッドは { ..., dataStatus } を返す */
function createRaceService(dataSource) {
  return {
    dataSourceName: dataSource.name,

    async listTracks() {
      const { source, status } = await resolveSource(dataSource);
      return { tracks: await source.getTracks(), dataStatus: status };
    },

    /** レース一覧（各レースの見送り判定と本命も付ける）。競馬場が無ければ races は null */
    async listRaces(trackId) {
      const { source, status } = await resolveSource(dataSource);
      const headers = await source.getRaces(trackId);
      if (!headers) return { races: null, dataStatus: status };
      const races = await Promise.all(
        headers.map(async (h) => {
          const race = await source.getRace(trackId, h.raceNo);
          const { summary } = analyzeRace(race);
          return {
            raceNo: h.raceNo,
            name: h.name,
            distance: h.distance,
            surface: h.surface,
            startTime: h.startTime,
            headcount: race ? race.horses.length : h.headcount,
            skip: summary.verdict.skip,
            honmei: summary.honmei ? { number: summary.honmei.number, name: summary.honmei.name } : null,
          };
        }),
      );
      return { races, dataStatus: status };
    },

    /** レース分析。レースが無ければ analysis は null */
    async getRaceAnalysis(trackId, raceNo) {
      const { source, status } = await resolveSource(dataSource);
      const race = await source.getRace(trackId, raceNo);
      return { analysis: race ? analyzeRace(race) : null, dataStatus: status };
    },
  };
}

module.exports = { createRaceService };
