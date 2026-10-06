'use strict';

const crypto = require('crypto');

/** 長さに依存しない定数時間比較 */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function parseBasic(header) {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header || '');
  if (!m) return null;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  return i < 0 ? null : { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
}

/**
 * Basic 認証ミドルウェア。認証情報は環境変数（REAL_AUTH_USER / REAL_AUTH_PASSWORD）から渡す。
 * 未設定の場合は誰も通さない（本人専用モードを無効化）。
 */
function basicAuth({ user, password, realm = 'keiba-real' }) {
  const configured = Boolean(user && password);
  return (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    if (!configured) {
      return res.status(503).type('text/plain; charset=utf-8').send('本人専用モードは無効です（認証情報が未設定）');
    }
    const cred = parseBasic(req.get('authorization'));
    // ユーザー名とパスワードの両方を必ず比較する（短絡評価で応答時間に差を出さない）
    const userOk = cred ? safeEqual(cred.user, user) : false;
    const passOk = cred ? safeEqual(cred.pass, password) : false;
    if (userOk && passOk) return next();
    res.set('WWW-Authenticate', `Basic realm="${realm}", charset="UTF-8"`);
    return res.status(401).type('text/plain; charset=utf-8').send('認証が必要です');
  };
}

module.exports = { basicAuth, parseBasic };
