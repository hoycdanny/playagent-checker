# PlayAgent Checker

**ゲーム / アプリ向けの AI 駆動自動 QA プラットフォーム。** テストしたいフローを普通の言葉で書けば、AI エージェントが画面を見て、タップやスワイプを代行し、成否を判定し、スクリーンショット・ステップ軌跡・ナビゲーションマップ付きの多言語レポートを生成します。

> 言語:[English](README.md) · [繁體中文](README_ZH.md) · [简体中文](README_CN.md) · **日本語** · [한국어](README_KR.md)

---

## 概要

PlayAgent Checker は **AWS(us-east-2)** 上で動く、サーバーレスのコントロールプレーンとオンデマンドの実行ランナーで構成されます。アプリをアップロード(または Web の URL を指定)すると、エージェントが自律的に探索し、再現可能でレビュー可能なテスト結果が得られます。

- **実運用の 2 つの実行バックエンド(いずれもエンドツーエンドで検証済み):**
  - **Web** — Playwright によるヘッドレス Chromium を ECS Fargate 上で実行。
  - **Device Farm** — AWS Device Farm の Android/iOS 実機を、Fargate ランナーから Appium で駆動。
- **エージェントループ:** スクリーンショット → VLM が対象を測位 → Agent が次の操作を決定 → 端末で実行 → 再びスクリーンショット、を目標達成または停止条件まで繰り返します。
- **高精度な GUI グラウンディング:** 座標担当の VLM「シート」は、SageMaker にデプロイした **UI-TARS-1.5-7B**(GUI グラウンディング向けにファインチューニング)を利用でき、ネイティブ要素のない絵の多いゲーム画面で汎用視覚モデルより格段に正確です。
- **ナレッジベース:** ジャンル別・シナリオ別の知識を付与(インライン Markdown、または Amazon Bedrock Knowledge Bases + S3 Vectors による PDF/文書検索)。
- **コストガードレール:** 各タスクは実行前にシートごとの単価スナップショットを固定(価格不明なら実行拒否)し、予算に達したら停止します。
- **多言語 UI とレポート:** 5 ロケール(zh-Hant、en、zh-Hans、ja、ko)。

## アーキテクチャ概観

```
ブラウザ(Web Console)
  → CloudFront + S3(静的サイト)
  → API Gateway(+ Cognito JWT、IAM/STS テナント分離)
  → Lambda API handler → SQS → Dispatcher Lambda → Engine Lambda(オーケストレーション)
        ├─ AI ブレイン(Amazon Bedrock):Agent / VLM / SubAgent + ナレッジベース
        │     └─ VLM の座標測位は Amazon SageMaker 上の UI-TARS へルーティング可能
        └─ 端末バックエンド(ECS Fargate):
              ├─ Web    → Playwright headless Chromium
              └─ Device Farm → 実機 + Appium
  → S3(スクリーンショット、軌跡、レポート、メモリマップ)
  → EventBridge → WebSocket → ブラウザへリアルタイムに反映
```

Engine(Lambda)はオーケストレーションのみを担当します。重い処理(大きな APK のアップロード、端末セッション、スクリーンショット→操作ループ)は時間制限のない Fargate コンテナで実行されます。詳細は [docs/architecture.md](docs/architecture.md) を参照。

## リポジトリ構成

```
agent/            実行ランナー(Fargate コンテナ内で動作)
  explorationRunner.mjs   Device Farm 実機ランナー(Appium ループ)
  webExplorationRunner.mjs Web ランナー(Playwright headless Chromium)
  appiumClient.mjs / playwrightClient.mjs  端末ドライバ
  imageTools.mjs          VLM 用の smart-resize と着地点アノテーション
  uitarsClient.mjs        UI-TARS(SageMaker)測位クライアント
  apkMerge.mjs            Device Farm 用の XAPK / split-APK マージ
  sagemaker/              UI-TARS デプロイ:vLLM BYOC コンテナ + CodeBuild スクリプト
infra/            AWS CDK アプリ(コントロールプレーン、実行、スケジューリング、基盤、フロントエンド)
  lib/            CDK スタック
  lambda/         API、engine、dispatcher、WS ハンドラ
  test/           CDK・ユニットテスト
web/              React + Vite Web コンソール(5 ロケール i18n、自作 SVG)
docs/             アーキテクチャ、設計メモ、リサーチ
```

## 前提条件

- Node.js 22+
- **us-east-2** 向けに認証情報を設定した AWS アカウント(Device Farm プロジェクトは us-west-2 にあり、ランナーが管理)
- Docker(ローカルでのイメージビルド時のみ必要。クラウドビルドは AWS CodeBuild を使用)
- AWS CDK v2(`npx cdk`)

## はじめ方

```bash
# 1. インストール
cd infra && npm install
cd ../web && npm install

# 2. テスト
cd ../infra && npm test          # CDK・ユニットテスト
cd ../web && npm run ci          # check:i18n + tsc + vitest + build

# 3. デプロイ(us-east-2)
cd ../infra
AWS_REGION=us-east-2 npx cdk deploy --all --require-approval never
```

デプロイ後、Web コンソールと API の URL がスタック出力に表示されます。

## 使い方

1. **アプリ** — アプリを作成(名前、プラットフォーム、ジャンル)。ネイティブは APK/IPA/ZIP をアップロード、Web は URL のみ。
2. **テストケース** — フローを普通の言葉で下書き(AI が実行可能な YAML に変換)、または YAML を手書き。シークレットは `${ENV}` プレースホルダを使用し、リテラルのパスワードは拒否されます。
3. **ナレッジ**(任意)— ジャンル/シナリオ知識を付与(Markdown は全文注入、PDF は検索)。
4. **タスク** — アプリ + ケース + 実行環境(Web または Device Farm)+ 座標モデルを選んで送信。実行中はライブ監視・キャンセル可能。
5. **レポート** — AI の説明、ステップ軌跡、スクリーンショット、ナビゲーショングラフ、予算と実費を確認。

Web コンソールの **ガイド** ページに詳細な操作説明があります。

## UI-TARS グラウンディング(任意・高精度)

汎用視覚モデルは絵の多いゲーム画面で正確なピクセル座標を出すのが苦手です。GUI グラウンディング向けにファインチューニングされた UI-TARS-1.5-7B は格段に正確です。利用するには SageMaker エンドポイントをデプロイします(ビルドは全てクラウドで行われ、ローカルのディスク/帯域を消費しません):

```bash
cd agent/sagemaker && npm install
# クラウドビルド:HF ダウンロード → S3 → vLLM イメージ → ECR(CodeBuild 経由)
AWS_REGION=us-east-2 node cloudBuild.mjs
# エンドポイント作成(重みとイメージは準備済み)
PA_SKIP_DOWNLOAD=1 PA_SKIP_UPLOAD=1 PA_SKIP_BUILD=1 AWS_REGION=us-east-2 node deployUitars.mjs
# エンドポイント名を engine に接続
cd ../../infra && AWS_REGION=us-east-2 npx cdk deploy PlayAgentDev-Execution \
  --require-approval never --exclusively -c uitarsEndpoint=<エンドポイント名>
```

> **コスト注意:** UI-TARS エンドポイントは `ml.g6e.xlarge`(約 US$1.86/時)で動作し、起動中は継続課金されます。使わないときは削除してください:
> ```bash
> node agent/sagemaker/teardownUitars.mjs <エンドポイント名>
> ```

設計は [docs/design/uitars-sagemaker-grounding.md](docs/design/uitars-sagemaker-grounding.md) を参照。

## ドキュメント

- [docs/architecture.md](docs/architecture.md) — システムアーキテクチャ、データフロー、テナンシー
- [docs/design/](docs/design/) — 主要サブシステムの設計メモ
- [docs/research/](docs/research/) — 調査と知見
- [CONTRIBUTING.md](CONTRIBUTING.md) · [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## ライセンス

リポジトリ設定を参照。本プロジェクトは現状のまま、社内評価用に提供されます。
