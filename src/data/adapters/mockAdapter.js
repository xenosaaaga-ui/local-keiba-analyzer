'use strict';

const { buildMockDatabase } = require('../mockData');

/**
 * モックデータ用アダプター。
 *
 * すべてのデータソース・アダプターは次のインターフェースを実装する:
 *   name: string
 *   isMock: boolean
 *   getTracks(): Promise<Track[]>
 *   getRaces(trackId): Promise<RaceHeader[] | null>   // 競馬場が無ければ null
 *   getRace(trackId, raceNo): Promise<Race | null>
 *
 * Race.horses[] の各要素は README の「データ形式」を参照。
 */
function createMockAdapter() {
  const db = buildMockDatabase();
  const clone = (v) => structuredClone(v);

  return {
    name: 'mock',
    isMock: true,
    async getTracks() {
      return clone(db.tracks);
    },
    async getRaces(trackId) {
      const races = db.races[trackId];
      if (!races) return null;
      return races.map(({ horses, ...header }) => clone(header));
    },
    async getRace(trackId, raceNo) {
      const races = db.races[trackId];
      if (!races) return null;
      const race = races.find((r) => r.raceNo === raceNo);
      return race ? clone(race) : null;
    },
  };
}

module.exports = { createMockAdapter };
