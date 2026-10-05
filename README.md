# local-keiba-analyzer

NAR地方競馬向けの予想・分析Webアプリ（v0.1）。
競馬場とレース番号を選ぶと、各出走馬の **予想指数・予測勝率・単勝オッズ・期待値・印・評価理由** を比較できます。
「一番勝ちそうな馬（本命）」と「オッズまで考えると買う価値が高い馬（単勝候補・穴馬）」を分けて表示します。

> **v0.1 はモックデータ（架空の馬・騎手）で動作します。** 実在のレースとは関係ありません。
> 本アプリは予想の参考情報であり、的中や利益を保証するものではありません。

## 使い方

```bash
npm install
npm start          # http://localhost:3000 （PORT 環境変数で変更可）
npm test           # 自動テスト（node:test）
```

スマートフォンのブラウザ向けに最適化しています（PCはレスポンシブで2カラム表示）。
URL の `#ooi-5` のようなハッシュで、競馬場とレースを指定して共有できます。

## 構成

```
server.js                      エントリーポイント（PORT / HOST 環境変数対応）
src/
  app.js                       Express アプリ（API + 静的配信）
  data/
    index.js                   データソース選択（DATA_SOURCE 環境変数）
    mockData.js                シード付きモックデータ生成（4場×8R、8〜12頭）
    adapters/mockAdapter.js    データ取得アダプター（実データ用はここに追加）
  prediction/
    config.js                  ウェイト・しきい値（重み調整はここ）
    scoring.js                 各ファクターの正規化・予想指数
    probability.js             予想指数 → 予測勝率（softmax）
    expectedValue.js           期待値・人気順・市場勝率
    marks.js                   印（◎○▲△☆）
    reasons.js                 評価理由
    index.js                   レース分析（見送り判定・買い目候補）
  services/raceService.js      データ取得層と予想ロジックの橋渡し
public/                        スマホUI（index.html / app.js / styles.css）
test/                          自動テスト
render.yaml                    Render 用 Blueprint
```

## API

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/tracks` | 競馬場一覧 |
| GET | `/api/races?track=ooi` | レース一覧（見送り判定・本命付き） |
| GET | `/api/race?track=ooi&race=1` | レース分析結果 |
| GET | `/api/health` | ヘルスチェック |

## 予想ロジック（v0.1：ルールベース）

1. **ファクタースコア（0〜1）**
   | 項目 | ウェイト | 内容 |
   | --- | --- | --- |
   | 近走成績 | 35% | 直近5走の着順・着差を直近ほど重く（35/25/18/12/10%） |
   | 距離適性 | 20% | 同距離成績（勝利=1、2-3着=0.5）を事前分布で平滑化 |
   | 競馬場適性 | 15% | 当地成績70% + 馬場適性30% |
   | 騎手評価 | 10% | 騎手評価 / 100 |
   | 斤量 | 10% | 出走馬平均との差 + 前走からの増減 |
   | クラス/休養 | 10% | クラス評価60% + 休養日数40% |
2. **予想指数（0〜100）**: 利用可能な項目だけでウェイトを再正規化。データのカバー率が低い馬は平均（50）寄りに補正。
3. **予測勝率**: softmax（温度7）。1頭が60%を超える場合は温度を上げて平準化し、一様分布を2%ブレンド。合計は100%。
4. **期待値** = 予測勝率 × 単勝オッズ（オッズが null / 0 / 未取得なら「オッズ未取得」）
   - 1.20以上 高期待値 / 1.00〜1.19 妙味あり / 0.80〜0.99 やや割高 / 0.80未満 妙味低い
5. **印**: 予測勝率上位から ◎○▲。☆は残りから「4番人気以下・期待値1.0以上・勝率3%以上」で期待値最大の馬。△は残りの上位2頭。
6. **レース結論**
   - 危険な人気馬: 3番人気以内で期待値0.8未満（◎を除く）
   - 単勝候補: 期待値1.0以上かつ予測勝率5%以上（最大3頭）
   - 馬連候補: ◎-○、◎-▲、◎-☆ などから3組
   - 見送り: 期待値1.0以上の馬がいない／上位3頭の指数差が4未満／欠損データが多い

## データ形式（アダプターが返す馬データ）

```js
{
  number, frame, name, jockey,
  weight, lastWeight,                       // 斤量（今回・前走）
  odds,                                      // 単勝オッズ（null可）
  recentFinishes: [1, 3, ...],               // 直近5走の着順（左が前走）
  recentMargins: [-0.2, 0.5, ...],           // 着差（秒、勝ち馬はマイナス）
  sameDistanceRecord: { starts, wins, places },
  trackRecord: { starts, wins, places },
  surfaceAptitude,                           // 馬場適性 1〜5
  jockeyRating, classRating,                 // 0〜100
  restDays
}
```

すべての項目は null / 欠損でも動作します（NaN・Infinity は出力しません）。

## 実データ化について

- `src/data/adapters/` に新しいアダプター（`getTracks / getRaces / getRace` を実装）を追加し、`src/data/index.js` に登録、`DATA_SOURCE` 環境変数で切り替えます。
- 実データの取得元は**利用規約で許可されたもの**に限ります。高頻度・大量のスクレイピングは行いません。
- 候補: 地方競馬DATA（UmaConn / NV-Link・有料・Windows向けSDK）、SPAIA競馬 等のデータAPI（法人向け契約）。公式サイト（keiba.go.jp）の自動取得は、規約を確認してから判断します。

## デプロイ（Render）

- Build Command: `npm install` / Start Command: `npm start`
- Render が設定する `PORT` で待ち受けます（`0.0.0.0`）。
- `render.yaml` の Blueprint でも作成できます。

## 今後の拡張予定

リアルタイムオッズ、ワイド・馬単・三連複・三連単と各買い目の期待値、資金配分、予想履歴・的中率・回収率、バックテスト、重み調整UI、過去データによる機械学習。
