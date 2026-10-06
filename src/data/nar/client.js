'use strict';

const { unzipSync } = require('fflate');

/**
 * NAR 地方競馬情報サイトの公式データダウンロード機能へのアクセス。
 * 仕様: https://www.keiba.go.jp/pdf/manual/data_pdf_manual.pdf
 * 推奨取得頻度: 当日ファイルは2分に1回程度、月次ファイルは1日1回が上限。
 */

const BASE_URL = 'https://www.keiba.go.jp/KeibaWeb/DataDownload';
const USER_AGENT = 'local-keiba-analyzer/0.2 (personal use; +https://github.com/xenosaaaga-ui/local-keiba-analyzer)';
const TIMEOUT_MS = 20000;

const URLS = {
  dailyRace: `${BASE_URL}/RaceDataDownload?type=daily`,
  dailyOdds: `${BASE_URL}/OddsDataDownload?type=daily`,
};

/** ZIP のローカルファイルヘッダ "PK\x03\x04" で始まるか */
function hasZipSignature(bytes) {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/**
 * URL を1回だけ GET してバイト列を返す（リトライしない）。
 * @returns {Promise<{status, contentType, bytes: Uint8Array, ms}>}
 */
async function download(url, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const started = Date.now();
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/zip' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  return {
    status: res.status,
    contentType: res.headers.get('content-type'),
    bytes,
    ms: Date.now() - started,
  };
}

/** ZIP を展開して { ファイル名: Uint8Array } を返す。ZIP として不正なら例外 */
function unzip(bytes) {
  if (!hasZipSignature(bytes)) throw new Error('ZIP形式ではありません');
  return unzipSync(bytes);
}

/** ZIP をダウンロードして展開する。HTTP エラーや ZIP 不正は例外 */
async function downloadZip(url, options) {
  const res = await download(url, options);
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${url}`);
  return { ...res, files: unzip(res.bytes) };
}

module.exports = { URLS, USER_AGENT, download, downloadZip, unzip, hasZipSignature };
