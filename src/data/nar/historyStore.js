'use strict';

/**
 * 月次データ（コンパクト形式・gzip）の保存先。
 * Render Key Value（REDIS_URL）があればそれを使い、Web サービスがスリープしても消えないようにする。
 * 無ければプロセス内メモリ（ローカル開発・テスト用）。
 *
 * インターフェース:
 *   getMeta(month) → { fetchedAt, final, runs, failedAt, error } | null
 *   getData(month) → Buffer | null
 *   setData(month, buf, meta)
 *   setMeta(month, meta)
 */

const PREFIX = 'nar:monthly:v1:';

function createMemoryStore() {
  const data = new Map();
  const meta = new Map();
  return {
    kind: 'memory',
    async getMeta(month) {
      return meta.has(month) ? { ...meta.get(month) } : null;
    },
    async getData(month) {
      return data.get(month) || null;
    },
    async setData(month, buf, m) {
      data.set(month, buf);
      meta.set(month, { ...m });
    },
    async setMeta(month, m) {
      meta.set(month, { ...m });
    },
  };
}

function createRedisStore(url) {
  const Redis = require('ioredis');
  const redis = new Redis(url, { maxRetriesPerRequest: 2, enableOfflineQueue: true, lazyConnect: false });
  redis.on('error', (e) => console.error('[kv]', e.message));
  return {
    kind: 'keyvalue',
    async getMeta(month) {
      const v = await redis.get(`${PREFIX}${month}:meta`);
      return v ? JSON.parse(v) : null;
    },
    async getData(month) {
      return redis.getBuffer(`${PREFIX}${month}`);
    },
    async setData(month, buf, m) {
      await redis.multi().set(`${PREFIX}${month}`, buf).set(`${PREFIX}${month}:meta`, JSON.stringify(m)).exec();
    },
    async setMeta(month, m) {
      await redis.set(`${PREFIX}${month}:meta`, JSON.stringify(m));
    },
  };
}

function createHistoryStore(url = process.env.REDIS_URL) {
  return url ? createRedisStore(url) : createMemoryStore();
}

module.exports = { createHistoryStore, createMemoryStore };
