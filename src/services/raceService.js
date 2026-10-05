'use strict';

const { analyzeRace } = require('../prediction');

/** データ取得層と予想ロジックをつなぐサービス層 */
function createRaceService(dataSource) {
  return {
    dataSourceName: dataSource.name,
    isMock: Boolean(dataSource.isMock),

    async listTracks() {
      return dataSource.getTracks();
    },

    /** レース一覧（各レースの見送り判定と本命も付ける） */
    async listRaces(trackId) {
      const headers = await dataSource.getRaces(trackId);
      if (!headers) return null;
      return Promise.all(
        headers.map(async (h) => {
          const race = await dataSource.getRace(trackId, h.raceNo);
          const { summary } = analyzeRace(race);
          return {
            raceNo: h.raceNo,
            name: h.name,
            distance: h.distance,
            surface: h.surface,
            startTime: h.startTime,
            headcount: h.headcount,
            skip: summary.verdict.skip,
            honmei: summary.honmei ? { number: summary.honmei.number, name: summary.honmei.name } : null,
          };
        }),
      );
    },

    async getRaceAnalysis(trackId, raceNo) {
      const race = await dataSource.getRace(trackId, raceNo);
      if (!race) return null;
      return analyzeRace(race);
    },
  };
}

module.exports = { createRaceService };
