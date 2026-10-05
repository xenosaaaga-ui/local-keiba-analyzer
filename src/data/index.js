'use strict';

const { createMockAdapter } = require('./adapters/mockAdapter');

/**
 * データソースの選択。DATA_SOURCE 環境変数で切り替える。
 * 実データ対応時は adapters/ に新しいアダプターを追加し、ここに登録する。
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
