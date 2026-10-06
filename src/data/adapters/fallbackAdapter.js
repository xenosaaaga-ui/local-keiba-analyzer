'use strict';

/**
 * 実データ（primary）を優先し、取得に失敗したらモック（fallback）へ切り替えるデータソース。
 * resolve() でリクエストごとに使うアダプターと表示用の状態を決める。
 * 1リクエスト内では同じアダプターを使うので、実データとモックが混ざらない。
 */
function createFallbackSource(primary, fallback) {
  return {
    name: `${primary.name}+${fallback.name}`,

    async resolve() {
      try {
        await primary.load();
        return { source: primary, status: { source: primary.name, mock: false, ...primary.status() } };
      } catch (e) {
        return {
          source: fallback,
          status: {
            source: fallback.name,
            mock: true,
            fallback: true,
            reason: e.name === 'TimeoutError' ? 'タイムアウト' : e.message,
          },
        };
      }
    },
  };
}

module.exports = { createFallbackSource };
