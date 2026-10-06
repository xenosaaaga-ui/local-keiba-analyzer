'use strict';

const { defaultProfile } = require('./default');
const { narDailyProfile } = require('./narDaily');

/** 予想プロファイル。レースの scoringProfile で選び、未指定・未知なら default */
const PROFILES = Object.freeze({
  default: defaultProfile,
  narDaily: narDailyProfile,
});

function profileFor(race) {
  const key = race && typeof race === 'object' ? race.scoringProfile : null;
  return (key && PROFILES[key]) || PROFILES.default;
}

module.exports = { PROFILES, profileFor };
