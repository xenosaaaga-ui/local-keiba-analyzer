'use strict';

const { zipSync, strToU8 } = require('fflate');

/**
 * テスト用の NAR 形式 ZIP（公式仕様の列構成に合わせた架空データ）。
 * 実データはリポジトリに含めない（利用規約上の転載・複製を避けるため）。
 */

const RACELIST_HEADER = [
  '競馬場', '競走年月日', 'レース番号', '発走時刻', '競走種類名称', 'レース名',
  ...Array.from({ length: 15 }, (_, i) => `副賞名${i + 1}`),
  '芝ダート区分', '回り', '距離', '天候', '馬場', '頭数', '条件',
  '1着賞金(円)', '2着賞金(円)', '3着賞金(円)', '4着賞金(円)', '5着賞金(円)', '上がり4F', '上がり3F',
  ...Array.from({ length: 15 }, (_, i) => `ハロンタイム${i + 1}`),
  ...Array.from({ length: 8 }, (_, i) => `コーナー名称${i + 1}`),
  ...Array.from({ length: 8 }, (_, i) => `コーナー通過順${i + 1}`),
];

const HORSELIST_HEADER = [
  '競馬場', '競走年月日', 'レース番号', '枠番', '帽色', '馬番', '馬名', '性', '齢', '毛色', '生年月日',
  '父馬名', '母馬名', '母父馬名', '騎手名', '騎手所属', '負担重量', '騎手成績', '調教師', '調教師所属',
  '馬主氏名', '生産牧場名', '馬体重', '馬体重増減', '全成績', 'ダート左成績', 'ダート右成績',
  '当競馬場成績', 'うち当距離成績', '最高タイム', '最高タイム良馬場', '着順', 'タイム', '着差', '上がり3F', '人気',
];

const ODDS_HEADER = ['競馬場', '競走年月日', 'レース番号', '賭式', '番号1', '番号2', '番号3', 'オッズ', 'オッズ（最大）', '人気'];

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function toCsv(header, rows) {
  const lines = [header, ...rows.map((r) => header.map((h) => r[h]))].map((cols) => cols.map(csvCell).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n'; // UTF-8 BOM + CRLF（公式ファイルと同じ）
}

function raceRow(track, raceNo, extra = {}) {
  return { 競馬場: track, 競走年月日: '20261006', レース番号: raceNo, 発走時刻: '1540', 競走種類名称: '普通', レース名: `テスト${raceNo}組`, 芝ダート区分: 'ダート', 回り: '右', 距離: 1400, 天候: '晴', 馬場: '良', 頭数: 4, ...extra };
}

function horseRow(track, raceNo, number, extra = {}) {
  return {
    競馬場: track, 競走年月日: '20261006', レース番号: raceNo, 枠番: number, 馬番: number, 馬名: `テストホース${number}`,
    性: '牡', 齢: 4, 騎手名: `騎手${number}`, 負担重量: 56, 調教師: `調教${number}`, 馬主氏名: '架空オーナー',
    馬体重: 470, 馬体重増減: '+2', 全成績: '2-1-1-6', ダート左成績: '0-0-0-0', ダート右成績: '2-1-1-6',
    当競馬場成績: '1-1-0-3', うち当距離成績: '1-0-0-1', 人気: number, ...extra,
  };
}

function buildRaceZip() {
  const races = [raceRow('大井', 1), raceRow('大井', 2, { 回り: '左', 距離: 1200 }), raceRow('新競馬場', 1)];
  const horses = [
    horseRow('大井', 1, 1, { 負担重量: '★53', 馬主氏名: '架空, カンマ入り（株）' }), // 減量記号・クォート項目
    horseRow('大井', 1, 2, { 全成績: '0-0-0-0', 当競馬場成績: '0-0-0-0', うち当距離成績: '0-0-0-0' }),
    horseRow('大井', 1, 3, { 着差: '出走取消', 馬体重: '', 人気: '' }), // 取消
    horseRow('大井', 1, 4),
    horseRow('大井', 2, 1),
    horseRow('大井', 2, 2),
    horseRow('新競馬場', 1, 1),
  ];
  return zipSync({
    '20261006_racelist.csv': strToU8(toCsv(RACELIST_HEADER, races)),
    '20261006_horselist.csv': strToU8(toCsv(HORSELIST_HEADER, horses)),
    '20261006_payback.csv': strToU8(toCsv(['競馬場'], [])),
  });
}

function buildOddsZip() {
  const odds = [
    { 競馬場: '大井', 競走年月日: '20261006', レース番号: 1, 賭式: '単勝', 番号1: 1, オッズ: '2.4', 人気: 1 },
    { 競馬場: '大井', 競走年月日: '20261006', レース番号: 1, 賭式: '単勝', 番号1: 2, オッズ: '15.0', 人気: 3 },
    { 競馬場: '大井', 競走年月日: '20261006', レース番号: 1, 賭式: '単勝', 番号1: 4, オッズ: '5.1', 人気: 2 },
    { 競馬場: '大井', 競走年月日: '20261006', レース番号: 1, 賭式: '複勝', 番号1: 1, オッズ: '1.1', 'オッズ（最大）': '1.5', 人気: 1 },
    { 競馬場: '大井', 競走年月日: '20261006', レース番号: 1, 賭式: '馬複', 番号1: 1, 番号2: 2, オッズ: '30.5', 人気: 4 },
  ];
  return zipSync({ '20261006_odds.csv': strToU8(toCsv(ODDS_HEADER, odds)) });
}

/** NAR の URL を見て race.zip / odds.zip を返す fetch の代用品。呼び出し回数を記録する */
function createFakeNarFetch({ race = () => buildRaceZip(), odds = () => buildOddsZip() } = {}) {
  const calls = { race: 0, odds: 0 };
  const respond = (body) => {
    if (body instanceof Error) throw body;
    if (body && body.status) return new Response(body.body ?? 'error', { status: body.status });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/zip' } });
  };
  async function fakeFetch(url) {
    if (String(url).includes('RaceDataDownload')) {
      calls.race++;
      return respond(race());
    }
    if (String(url).includes('OddsDataDownload')) {
      calls.odds++;
      return respond(odds());
    }
    throw new Error(`unexpected url ${url}`);
  }
  return { fetch: fakeFetch, calls };
}

module.exports = { buildRaceZip, buildOddsZip, createFakeNarFetch };
