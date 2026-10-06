'use strict';

const path = require('path');
const express = require('express');
const { createDataSource } = require('./data');
const { createRaceService } = require('./services/raceService');
const { basicAuth } = require('./auth/basicAuth');
const { createNarDiagnostics } = require('./data/nar/diagnostics');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/** /tracks /races /race /health を持つ API ルーター（公開モック版・本人専用モードで共通） */
function createApiRouter(service) {
  const api = express.Router();
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  api.get('/health', (req, res) => {
    res.json({ ok: true, dataSource: service.dataSourceName, mock: service.isMock });
  });

  api.get('/tracks', async (req, res, next) => {
    try {
      res.json({ tracks: await service.listTracks(), mock: service.isMock });
    } catch (e) {
      next(e);
    }
  });

  api.get('/races', async (req, res, next) => {
    try {
      const track = String(req.query.track || '');
      if (!track) return res.status(400).json({ error: 'track パラメータが必要です' });
      const races = await service.listRaces(track);
      if (!races) return res.status(404).json({ error: `競馬場 "${track}" が見つかりません` });
      res.json({ track, races });
    } catch (e) {
      next(e);
    }
  });

  api.get('/race', async (req, res, next) => {
    try {
      const track = String(req.query.track || '');
      const raceNo = Number(req.query.race);
      if (!track) return res.status(400).json({ error: 'track パラメータが必要です' });
      if (!Number.isInteger(raceNo) || raceNo < 1) {
        return res.status(400).json({ error: 'race パラメータは1以上の整数で指定してください' });
      }
      const analysis = await service.getRaceAnalysis(track, raceNo);
      if (!analysis) return res.status(404).json({ error: 'レースが見つかりません' });
      res.json({ ...analysis, mock: service.isMock });
    } catch (e) {
      next(e);
    }
  });

  return api;
}

/**
 * @param {object} [options]
 * @param {object} [options.dataSource]  公開版のデータソース（常にモック）
 * @param {object} [options.auth]        本人専用モードの認証情報 { user, password }
 * @param {Function} [options.diagnose]  NAR 疎通診断（テスト用に差し替え可能）
 */
function createApp({
  dataSource = createDataSource(),
  auth = { user: process.env.REAL_AUTH_USER, password: process.env.REAL_AUTH_PASSWORD },
  diagnose = createNarDiagnostics(),
} = {}) {
  const app = express();
  app.disable('x-powered-by');

  // ---------- 本人専用モード（/real 以下はすべて Basic 認証） ----------
  const real = express.Router();
  real.use(basicAuth(auth));

  const realApi = express.Router();
  realApi.get('/diag', async (req, res, next) => {
    try {
      const result = await diagnose();
      res.status(result.ok ? 200 : 502).json(result);
    } catch (e) {
      next(e);
    }
  });
  realApi.use((req, res) => res.status(404).json({ error: 'Not found' }));
  real.use('/api', realApi);
  real.use(express.static(PUBLIC_DIR));
  app.use('/real', real);

  // ---------- 公開モック版 ----------
  const api = createApiRouter(createRaceService(dataSource));
  api.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use('/api', api);
  app.use(express.static(PUBLIC_DIR, { maxAge: '5m' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  });

  return app;
}

module.exports = { createApp };
