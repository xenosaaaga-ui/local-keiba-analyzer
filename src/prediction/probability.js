'use strict';

const { num, clamp } = require('./utils');

function softmax(xs, temperature) {
  const max = Math.max(...xs);
  const exps = xs.map((x) => Math.exp((x - max) / temperature));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

/**
 * 予想指数の配列 → 予測勝率の配列（合計 1.0）。
 * softmax で差を強調しつつ、1頭が maxProb を超える場合は温度を上げて平準化し、
 * 最後に一様分布を少しブレンドして 0% / 100% のような極端値を避ける。
 */
function winProbabilities(indices, options = {}) {
  const list = Array.isArray(indices) ? indices : [];
  const n = list.length;
  if (n === 0) return [];
  if (n === 1) return [1];

  const xs = list.map((v) => clamp(num(v) ?? 50, 0, 100));
  let temperature = num(options.temperature) > 0 ? options.temperature : 6;
  const maxProb = num(options.maxProb) > 0 ? options.maxProb : 0.6;
  const blend = clamp(num(options.uniformBlend) ?? 0.05, 0, 1);

  let p = softmax(xs, temperature);
  for (let i = 0; i < 40 && Math.max(...p) > maxProb; i++) {
    temperature *= 1.2;
    p = softmax(xs, temperature);
  }
  p = p.map((v) => (1 - blend) * v + blend / n);
  const sum = p.reduce((a, b) => a + b, 0);
  return p.map((v) => clamp(v / sum, 0, 1));
}

module.exports = { winProbabilities, softmax };
