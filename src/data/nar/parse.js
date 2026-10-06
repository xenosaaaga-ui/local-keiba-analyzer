'use strict';

const { parse } = require('csv-parse/sync');
const { scoreRecord } = require('../../prediction/scoring');

/**
 * NAR 公式データダウンロード（当日ファイル）の CSV を、アプリ内部のデータ形式に変換する。
 * CSV 仕様: UTF-8(BOM付き) / CRLF / 1行目ヘッダ / ダブルクォートで囲まれた項目あり。
 */

// 競馬場名 → URL ハッシュ用 ID（未知の競馬場は track1, track2 … を割り当てる）
const TRACK_IDS = {
  帯広: 'obihiro',
  帯広ば: 'obihiro', // 月次ファイルではばんえいがこの表記
  門別: 'monbetsu',
  盛岡: 'morioka',
  水沢: 'mizusawa',
  浦和: 'urawa',
  船橋: 'funabashi',
  大井: 'ooi',
  川崎: 'kawasaki',
  金沢: 'kanazawa',
  笠松: 'kasamatsu',
  名古屋: 'nagoya',
  園田: 'sonoda',
  姫路: 'himeji',
  高知: 'kochi',
  佐賀: 'saga',
};

// 出走取消・競走除外の馬は分析対象から外す（着差欄に表記される）
const SCRATCH_PATTERN = /取消|除外/;

function parseCsv(bytes, options = {}) {
  return parse(Buffer.from(bytes), { columns: true, bom: true, skip_empty_lines: true, relax_column_count: true, ...options });
}

/** ZIP 内のファイルを名前の末尾で探す（例: "_horselist.csv"） */
function findFile(files, suffix) {
  const name = Object.keys(files).find((n) => n.endsWith(suffix));
  return name ? files[name] : null;
}

/** 数値に変換。"★50" や "+10" のような記号付きも数値部分を取り出す */
function toNum(value) {
  if (value === null || value === undefined) return null;
  const m = /-?\d+(?:\.\d+)?/.exec(String(value).replace(/[＋+]/g, ''));
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function toInt(value) {
  const n = toNum(value);
  return n === null ? null : Math.trunc(n);
}

/** "1-2-0-5"（1着-2着-3着-着外）→ { starts, wins, seconds, thirds, places }。0戦は null */
function parseRecord(value) {
  const m = /^(\d+)-(\d+)-(\d+)-(\d+)$/.exec(String(value || '').trim());
  if (!m) return null;
  const [w, s, t, o] = m.slice(1).map(Number);
  const starts = w + s + t + o;
  return starts > 0 ? { starts, wins: w, seconds: s, thirds: t, places: w + s + t } : null;
}

/** "1:28.2" / "58.9" / "良1:28.2" → 秒。読めなければ null */
function parseRaceTime(value) {
  const m = /(?:(\d+):)?(\d{1,2}\.\d)/.exec(String(value || ''));
  if (!m) return null;
  const sec = (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]);
  return sec > 0 ? sec : null;
}

/** "1540" → "15:40" */
function formatTime(value) {
  const m = /^(\d{1,2})(\d{2})$/.exec(String(value || '').trim());
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

/** ダート左/右成績のうち、今回の回りに合う方を 1〜5 の馬場適性に換算する */
function surfaceAptitude(row, race) {
  if (race.surface !== 'ダート') return null;
  const key = race.turn === '左' ? 'ダート左成績' : race.turn === '右' ? 'ダート右成績' : null;
  const score = key ? scoreRecord(parseRecord(row[key])) : null;
  return score === null ? null : Math.round(1 + 4 * score);
}

const raceKey = (track, raceNo) => `${track}#${raceNo}`;

/** odds.csv から単勝オッズだけを { "大井#9": { 馬番: オッズ } } で取り出す */
function parseWinOdds(bytes) {
  const rows = parseCsv(bytes, {
    on_record: (r) => (r['賭式'] === '単勝' ? r : null), // 単勝以外は読み捨ててメモリを節約
  });
  const odds = {};
  for (const r of rows) {
    const key = raceKey(r['競馬場'], toInt(r['レース番号']));
    const number = toInt(r['番号1']);
    const value = toNum(r['オッズ']);
    if (number === null) continue;
    (odds[key] ||= {})[number] = value !== null && value > 0 ? value : null;
  }
  return odds;
}

function toHorse(row, race, winOdds) {
  const number = toInt(row['馬番']);
  return {
    number,
    frame: toInt(row['枠番']),
    name: row['馬名'] || null,
    birthDate: row['生年月日'] || null, // 馬名 + 生年月日 で過去走と照合する（公式に馬IDは無い）
    sex: row['性'] || null,
    age: toInt(row['齢']),
    jockey: row['騎手名'] || null,
    trainer: row['調教師'] || null,
    weight: toNum(row['負担重量']), // 斤量（★☆▲◇ の減量記号は除去）
    lastWeight: null, // 当日ファイルに前走斤量は無い
    bodyWeight: toInt(row['馬体重']),
    bodyWeightDiff: toInt(row['馬体重増減']),
    odds: winOdds && number !== null && number in winOdds ? winOdds[number] : null,
    recentFinishes: [], // 当日ファイルに近走着順は無い
    recentMargins: [],
    careerRecord: parseRecord(row['全成績']),
    sameDistanceRecord: parseRecord(row['うち当距離成績']), // 当競馬場・当距離の成績
    trackRecord: parseRecord(row['当競馬場成績']),
    bestTime: parseRaceTime(row['最高タイム']), // 秒（当競馬場・当距離の最高タイムと推定）
    bestTimeGood: parseRaceTime(row['最高タイム良馬場']),
    surfaceAptitude: surfaceAptitude(row, race),
    jockeyRating: null, // 「騎手成績」の集計範囲が仕様書に無いため使わない
    classRating: null,
    restDays: null,
  };
}

/**
 * race.zip / odds.zip の展開結果からスナップショットを作る。
 * @param {object} raceFiles  { ファイル名: Uint8Array }
 * @param {object|null} oddsFiles  オッズ取得に失敗した場合は null
 * @returns {{ date, tracks, races }}
 */
function buildSnapshot(raceFiles, oddsFiles) {
  const racelist = findFile(raceFiles, '_racelist.csv');
  const horselist = findFile(raceFiles, '_horselist.csv');
  if (!racelist || !horselist) throw new Error('race.zip に racelist / horselist がありません');

  const oddsCsv = oddsFiles ? findFile(oddsFiles, '_odds.csv') : null;
  const winOdds = oddsCsv ? parseWinOdds(oddsCsv) : {};

  const trackIds = { ...TRACK_IDS };
  let unknown = 0;
  const trackIdOf = (name) => (trackIds[name] ||= `track${++unknown}`);

  const races = {};
  const byKey = {};
  let date = null;
  for (const r of parseCsv(racelist)) {
    const trackName = r['競馬場'];
    const raceNo = toInt(r['レース番号']);
    if (!trackName || raceNo === null) continue;
    date ||= r['競走年月日'] || null;
    const trackId = trackIdOf(trackName);
    const race = {
      trackId,
      trackName,
      raceNo,
      name: r['レース名'] || null,
      raceClass: r['競走種類名称'] || null,
      surface: r['芝ダート区分'] || null,
      turn: r['回り'] || null,
      distance: toInt(r['距離']),
      going: r['馬場'] || null,
      weather: r['天候'] || null,
      startTime: formatTime(r['発走時刻']),
      headcount: toInt(r['頭数']),
      scoringProfile: 'narDaily', // 当日NARデータ専用の予想プロファイルを使う
      horses: [],
    };
    (races[trackId] ||= []).push(race);
    byKey[raceKey(trackName, raceNo)] = race;
  }

  for (const row of parseCsv(horselist)) {
    const key = raceKey(row['競馬場'], toInt(row['レース番号']));
    const race = byKey[key];
    if (!race || SCRATCH_PATTERN.test(row['着差'] || '')) continue;
    race.horses.push(toHorse(row, race, winOdds[key]));
  }

  const tracks = Object.entries(races).map(([id, list]) => {
    list.sort((a, b) => a.raceNo - b.raceNo);
    list.forEach((race) => {
      race.horses.sort((a, b) => (a.number ?? 99) - (b.number ?? 99));
      race.headcount = race.horses.length; // 取消・除外を除いた頭数
    });
    return { id, name: list[0].trackName, raceCount: list.length };
  });

  return { date, tracks, races, hasOdds: Boolean(oddsCsv) };
}

module.exports = { buildSnapshot, parseCsv, findFile, parseRecord, parseRaceTime, toNum, toInt, formatTime, parseWinOdds, TRACK_IDS, SCRATCH_PATTERN };
