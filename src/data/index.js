'use strict';

const { createMockAdapter } = require('./adapters/mockAdapter');

/**
 * 公開版（/api）のデータソース選択。DATA_SOURCE 環境変数で切り替える。
 * NAR 実データ（narAdapter）は本人専用モード（/real）専用のため、意図的にここへは登録しない。
 * 公開版で実データを配信しないことを、設定ミスがあっても保証するため。
 */
const ADAPTERS = {
  mock: createMockAdapter,
};

function createDataSource(name = process.env.DATA_SOURCE || 'mock') {
  const factory = ADAPTERS[name];
  if (!factory) {
    throw new Error(`Unknown DATA_SOURCE "${name}". Available: ${Object.keys(ADAPTERS).join(', ')}`);
  }
  return factory();
}

module.exports = { createDataSource, ADAPTERS };
