# PlayAgent Checker

**ゲームとアプリのための AI 駆動自動 QA。** テストフローを自然言語で記述すると、AI エージェントが画面を見ながらタップやスワイプを代行し、合否を判定して、スクリーンショット、ステップごとのトレース、ナビゲーションマップ付きの多言語レポートを作成します。

> 言語:[English](README.md) · [繁體中文](README_ZH.md) · [简体中文](README_CN.md) · **日本語** · [한국어](README_KR.md)

---

## 概要

PlayAgent Checker は、ゲームとアプリのための AI 駆動自動 QA で、すべてあなた自身の AWS アカウント内で動作します。

- テストケースを自然言語で記述すると、AI エージェントが画面を見ながら実際のユーザーのように操作(タップ、スワイプ、入力)してケースを実行します。
- 検査可能な UI ツリーを持たない Canvas 描画のゲーム(Unity、Cocos2d-x)でも動作します。
- あなたの AWS アカウント内でサーバーレス・従量課金:リソースはタスクごとに起動し、終了時に停止するため、アイドル時のコストはほぼゼロです。
- スクリーンショット、ステップごとのトレース、ナビゲーションマップ、実行ごとの費用を含む多言語レポート。
- Web、Android/iOS 実機、Android コンテナ、Windows PC ゲームのランタイムを利用できます。

## クイックスタート

必要なのは Web ブラウザだけで、コンピューターには何もインストールしません。

**始める前に:** 管理者として AWS コンソールにサインインし、先に対象リージョンで Bedrock モデルを有効にして([AI モデルを有効にする](#ステップ-3--ai-モデルを有効にするamazon-bedrock) — 有効にしないとすべての実行が失敗します)、コンソール上部バーの `>_` アイコンで **CloudShell** を開きます。

コマンドを 1 行貼り付けます。

```bash
curl -fsSL https://raw.githubusercontent.com/hoycdanny/playagent-checker/main/scripts/cloudshell-install.sh | bash
```

- 最初に**言語メニュー**が表示され(デフォルトは英語、フラグ不要。`--lang en|zh-Hant|zh-Hans|ja|ko` も使えます)、生ログの代わりに**ステップごとの進捗**を表示し、失敗時はエラーログを出力します。
- デフォルトリージョンは `us-west-2` です。別のリージョンを使う場合は `--region <region>` を付けます。選んだリージョンで Bedrock モデルが有効になっている必要があり、デフォルトのモデルは `us.` のクロスリージョン推論プロファイルを使うため、米国以外のリージョンでは別のモデル ID が必要になる場合があります。Device Farm の実機は常に `us-west-2` で動きます。
- 管理者アカウントは **Cognito のメール招待**で作成されます。一時パスワードは最後に画面に表示され、同時にメールでも届きます。初回サインイン時に Web ページで新しいパスワードの設定を求められます。
- **同じコマンドをもう一度実行すると、最新版に更新できます。**

`scripts/cloudshell-install.sh` が行うこと：

- このアカウント/リージョンで CDK bootstrap が未実施なら 1 回だけ実行します。管理者権限が必要なのはこのステップだけです。
- CodeBuild だけを信頼する IAM ロール `playagent-installer` を作成し、最小権限ポリシー [`infra/iam/playagent-deployer-policy.json`](infra/iam/playagent-deployer-policy.json) をアタッチします。ビルドに AdministratorAccess は使いません。
- CodeBuild プロジェクト `playagent-installer` を作成します。公開 GitHub リポジトリを clone し、同じデプロイコア（`scripts/deploy-latest.mjs`）を実行します。EC2 インスタンスは不要です。
- 進捗を表示し、完了するとサイトの URL を表示します。

このポリシーで許可されるのは、このアカウントの CDK bootstrap ロールの引き受け、PlayAgent スタックの読み取り、ランナーイメージのプッシュ、Cognito 管理者の作成、`/playagent/*` SSM パラメータの書き込みだけです。CloudFormation の変更は CDK の `cdk-hnb659fds-cfn-exec-role` 経由で実行されます。このロールはデフォルトで管理者権限を持つため、デプロイできる人は CloudFormation 経由でリソースを作成できます。

## クイック削除

PlayAgent を削除するには、CloudShell でコマンドを 1 行実行します。

```bash
curl -fsSL https://raw.githubusercontent.com/hoycdanny/playagent-checker/main/scripts/cloudshell-uninstall.sh | bash
```

- 同じ**言語メニュー**が表示され、環境をスキャンして、削除されるものと保持されるものを一覧表示します。確定するまで何も削除されません。続行するには**12 桁のアカウント id を入力**する必要があります。`--yes` は確認プロンプトを省略します(手動では非推奨)。`--region` のデフォルトは `us-west-2` です。
- PlayAgent 自身のリソースを削除します:6 つの `PlayAgentDev-*` スタック、保持されたデータバケット / Cognito ユーザープール / ランナー ECR リポジトリ、インストーラーの CodeBuild プロジェクトと IAM ロール、PlayAgent の SSM パラメータとロググループ。
- CDK bootstrap(`CDKToolkit`)と共有の `cdk-hnb659fds-*` アセット(他のアプリが共有している可能性があります)は保持するため、再インストール時には bootstrap をスキップできます。

手動での完全な削除(とトラブルシューティング)は[クリーンアップとトラブルシューティング](#クリーンアップとトラブルシューティング)を参照してください。

## 技術詳細

### ランタイム

| ランタイム | 実行基盤 | インストール後に利用可能 | 制限 |
| --- | --- | --- | --- |
| **Web ブラウザ** | ECS Fargate 上のヘッドレス Chromium(Playwright) | ✅ | — |
| **Android 実機**(Device Farm) | AWS Device Farm + Appium、コントローラーは Fargate | ✅ | 1 セッション 150 分(AWS の制限)。「長時間」オプションは 140 分ごとに再接続し、ゲームは再起動されます |
| **iOS 実機**(Device Farm) | AWS Device Farm + Appium | ✅ | インストール可能な `.ipa` が必要。1 セッション 150 分 |
| **Android コンテナ**(Redroid) | タスクごとに Graviton EC2 を 1 台(`m7g.xlarge`)起動し Redroid を実行 | ✅ | エミュレーター検出のあるゲームは自ら終了します(実機を使用してください)。動画/音声チェック不可、ピンチ不可、1 回の実行は 1–72 時間 |
| **Windows PC ゲーム** | Amazon GameLift Streams(NVIDIA GPU、`gen6n_medium_win2022`) | ⚙️ 初回のみセットアップが必要(下記「任意:Windows PC ゲーム(GameLift Streams)」を参照) | 1 回の実行 ≤ 60 分、総ピクセル数 ≤ 1920×1080 |
| iOS シミュレーター / Linux | — | ❌ 未実装 | — |

どのゲームにどのランタイムを選ぶか:[docs/design/multi-platform-workers.md](docs/design/multi-platform-workers.md)。

### デフォルトで利用できる機能

以下のインストール手順を完了した時点で、有効なもの、無効なもの、追加手順が必要なものは次のとおりです。

| 機能 | デフォルト | 備考 |
| --- | --- | --- |
| Web コンソール、ログイン(Cognito)、5 言語 | ✅ 有効 | セルフサインアップは無効です。ユーザーは管理者が作成します。 |
| アプリ / テストケース / タスク / レポート / メモリマップ | ✅ 有効 | AI が自然言語からテストケースを下書きします(Claude Sonnet 4.5)。 |
| ランタイム:Web、Device Farm Android/iOS、Android コンテナ | ✅ 有効 | 各実行は自身のリソースを起動し、終了時に停止します。 |
| デフォルトモデル | ✅ 有効 | 判断は **Amazon Nova Lite**、画面解析は **Moonshot Kimi K3**、補助は **Amazon Nova Micro**。各シートはタスクごとに変更できます。 |
| ナレッジベース(Markdown + PDF 検索) | ✅ 有効 | PDF 検索は Bedrock Knowledge Bases + S3 Vectors + Titan Embeddings V2 を使用します。 |
| テスト認証情報(Secrets Manager) | ✅ 有効 | アプリごと。マスクされた値がモデルに渡ることはありません。 |
| コストガードレール(予算 + フェイルクローズ価格) | ✅ 有効 | — |
| コスト分析ページ — タスク見積もり | ✅ 有効 | タスクごとのトークン × 単価。 |
| コスト分析ページ — 実際の AWS 請求 | ⚙️ アカウント設定が必要 | Cost Explorer を有効化し、タグをアクティブ化します(下記「コスト分析ページを有効にする」を参照)。 |
| メンバー管理ページ(管理者) | ✅ 有効 | ユーザー追加、パスワードリセット、テナント移動、管理者権限付与。 |
| システム管理ページ → **システム更新** | ✅ 有効 | GitHub からワンクリックで更新します。トークンは不要です(リポジトリは公開)。トークンは任意で、GitHub API のレート制限を上げる用途のみ(下記「任意:ワンクリックシステム更新」を参照)。 |
| システム管理ページ → **集中ログ** | ✅ 有効 | すべてのサービスの CloudWatch ログを 1 か所で検索し、失敗を調査します(下記「集中ログ」を参照)。 |
| システム管理ページ → **UI-TARS** | ⛔ **無効** | GPU グラウンディングモデル。管理者がページ上でオン/オフし、オンの間のみ課金されます(下記「任意:UI-TARS グラウンディングモデル」を参照)。 |
| Windows ランタイム | ⚙️ 任意 | Windows マシンから GameLift Streams を初回のみセットアップします。 |

### アーキテクチャ

```mermaid
flowchart TB
  user["ユーザー / ブラウザー"]
  cf["CloudFront + S3<br/>Web コンソール(React)"]
  cognito["Amazon Cognito"]

  subgraph cp["コントロールプレーン"]
    apigw["API Gateway<br/>HTTP + WebSocket"]
    api["API Lambda"]
    sqs["SQS ディスパッチキュー"]
    disp["Dispatcher Lambda"]
    engine["Engine Lambda<br/>(オーケストレーター)"]
  end

  subgraph data["データと AI"]
    s3[("S3 データバケット<br/>(テナント別プレフィックス)")]
    sm["Secrets Manager<br/>(テスト用認証情報;任意の GitHub token)"]
    bedrock["Amazon Bedrock<br/>(モデル、ナレッジベース)"]
  end

  subgraph rt["実行環境(タスクごとに起動し、終了時に停止)"]
    web["Fargate:Web runner<br/>(Playwright Chromium)"]
    df["Fargate:Device Farm runner"]
    dfx["AWS Device Farm<br/>実機(us-west-2)"]
    redroid["EC2 Graviton:Android コンテナ<br/>(Redroid)"]
    win["GameLift Streams:Windows<br/>(GPU、オプション)"]
  end

  subgraph adm["システム管理(管理者のみ)"]
    update["CodeBuild 自己更新<br/>(GitHub から cdk deploy)"]
    uitars["SageMaker UI-TARS<br/>(オプション、デフォルトはオフ)"]
  end

  user --> cf
  user -- "REST + WebSocket<br/>(Cognito JWT)" --> apigw
  cognito -. JWT .- apigw
  apigw --> api
  api -- "POST /tasks" --> sqs --> disp --> engine
  api --> s3
  api --> sm
  api --> bedrock
  engine -- "runner を起動" --> web
  engine --> df
  engine --> redroid
  engine --> win
  df --> dfx
  web & df & redroid & win -- "スクリーンショット → モデル → 操作" --> bedrock
  web & df & redroid & win -- "進捗、スクリーンショット、レポート" --> s3
  df -. "座標特定(オン時)" .-> uitars
  apigw -. "リアルタイム進捗" .-> user
  api -- "オン / オフ" --> uitars
  api --> update
  update -- "stack を再デプロイ" --> cp
```

CDK スタック(すべて `us-west-2`):

| スタック | 内容 |
| --- | --- |
| **Foundation** | S3 データバケット、Cognito ユーザープール、テナント IAM ロール、Bedrock KB サービスロール。 |
| **ControlPlane** | HTTP API + JWT オーソライザー、API Lambda、WebSocket API。 |
| **Scheduling** | SQS ディスパッチキュー + Dispatcher Lambda。 |
| **Execution** | Engine Lambda、ECS クラスター + Fargate タスク定義、ECR リポジトリ、VPC(NAT ゲートウェイなし)、タスクごとの EC2 起動設定。 |
| **Frontend** | CloudFront + S3 静的サイト。 |
| **Updater** | 上記 5 つのスタックを GitHub のバージョンから再デプロイする CodeBuild プロジェクト。インストーラーが自動でデプロイします。 |

詳細:[docs/architecture.md](docs/architecture.md)。

### コスト

本プロジェクト自身のアカウント(2026 年 10 月)での実測値です。AWS の価格は変動するため、見積もりとして扱ってください。

**何も実行していないとき(アイドル時):** 約 **US$2–5 / 月**。NAT ゲートウェイ、常時稼働サーバー、予約ストリーム容量はありません。残るのは次のとおりです。

- S3 ストレージ(スクリーンショット、レポート、アップロードしたアプリ。UI-TARS の重みを配置した場合は約 31 GB が加わり、約 US$0.7/月)
- ECR イメージ(ランナーイメージ。ビルドした場合は約 10 GB の UI-TARS サービングイメージも)
- Secrets Manager(シークレット 1 つにつき月 US$0.40)、CloudWatch Logs、CloudFront
- Lambda、API Gateway、SQS、Cognito はリクエスト課金で、利用が少なければごく僅かです

**テスト実行ごと(実行中のみ):**

| 項目 | 価格 | 例 |
| --- | --- | --- |
| AI モデル(Bedrock トークン) | トークン単位、送信時に固定。各レポートに表示 | デフォルトモデルでの 26 ステップ・10 スピンのスロットテストで、入力約 141k / 出力約 14k トークンを使用し、**US$0.80 未満** |
| Device Farm 実機 | **デバイス 1 分あたり US$0.17** | 30 分 ≈ US$5.10 |
| Android コンテナ(EC2 `m7g.xlarge`) | **US$0.1632 / 時間** + ディスク | 1 時間 ≈ US$0.17 |
| Fargate ランナー(1 vCPU / 2 GB) | 約 US$0.05 / 時間 | Web 実行と Device Farm コントローラー |
| Windows(GameLift Streams) | セッション実行中の秒単位課金 | [GameLift Streams の料金](https://aws.amazon.com/gamelift/streams/pricing/)を参照 |
| 自己更新 | CodeBuild の分数 | 更新 1 回あたり約 5–15 分、数セント |
| Cost Explorer クエリ(コスト分析ページ) | 1 クエリあたり約 US$0.01 | — |

**唯一の大きな任意コスト:UI-TARS。** `ml.g6e.xlarge` GPU で、実測 **US$62.53 / 日(約 US$2.6 / 時間)**。タスクがなくてもオンの間はずっと課金されます。**デフォルトはオフ**です。必要な場合以外はオフのままにしてください。

実際、当アカウントの支出の大半は Bedrock トークンと Device Farm の分数でした。どちらもテストしていないときは費用がかかりません。

### 機能(各ページの役割)

| ページ | 用途 |
| --- | --- |
| **ガイド** | アプリ内ウォークスルー(ログイン後のランディングページ)、5 言語対応。 |
| **アプリ管理** | ゲーム/アプリごとに 1 つのワークスペース:名前、プラットフォーム、ジャンル、成果物(APK/IPA/XAPK/ZIP/EXE)または URL。中にテストケース、タスク、レポート、メモリマップ、テスト認証情報があります。 |
| **テストケース**(アプリワークスペース内) | AI に実行させる 1 つのフロー。自然言語で下書き(AI → YAML)、YAML を手書き、またはスプレッドシートからインポートできます。パスワードの直接記述は拒否されます。テスト認証情報を使用してください。 |
| **テストタスク**(アプリワークスペース内) | ケースを実行します。**ランタイム**、3 つの**モデル**、ステップ/予算の上限、**ナレッジベース**を選択します。ライブ画面、デバイスログ(実機と Android コンテナ)、エージェントの推論を確認でき、実行中に AI へ指示を出したり、いつでもキャンセルしたりできます。 |
| **テストレポート** | AI による説明、ステップトレース、スクリーンショット、録画再生(実機)、ナビゲーショングラフ、支出とトークン。 |
| **メモリマップ** | 全実行で訪れた画面がノード、遷移がエッジになります。以降の実行はより速くナビゲートできます。 |
| **デバイス管理** | 現在利用可能な Device Farm の端末に加え、稼働中のコンテナ、EC2 ホスト、GameLift 容量。 |
| **ナレッジ** | 共有ナレッジベース(ゲームジャンル / シナリオ):Markdown の全文注入と/または PDF 検索。 |
| **コスト分析** | アプリ別・モデル別のタスク見積もりと、サービス / コンポーネント別の実際の AWS 請求(有効化後)。 |
| **メンバー管理**(管理者) | ユーザー追加、パスワードリセット、無効化/有効化、テナント移動、管理者権限の付与・剥奪。 |
| **システム管理**(管理者) | GitHub からの**システム更新**(ワンクリック、トークン不要。バージョン比較、進捗、履歴)、**UI-TARS** のオン/オフスイッチ、**集中ログ**(すべてのサービスの CloudWatch ログを検索)。 |

### AI:3 つのモデル「シート」

モデルはベンダーではなく**役割(シート)**で整理されています。各シートはタスクごとに選択します。

- **Agent(判断)** — 画面と目標から次のアクションを決定します。デフォルトは **Amazon Nova Lite**。
- **VLM(画面解析 / 座標)** — 「タップすべきもの」をピクセル座標に変換します。デフォルトは **Moonshot Kimi K3**。UI-TARS-1.5-7B は管理者がオンにしている間のみここに表示されます。
- **Subagent(補助)** — アクションが成功したかの確認、数値の追跡、完了の検証を行います。デフォルトは **Amazon Nova Micro**。

SDK やエンドポイントを選ぶ必要はありません。システムがモデル ID から導出します。

### コストガードレール

各タスクにステップ上限と予算を設定できます。実行前に、エンジンが各シートのモデルの**価格スナップショットを固定**します(フェイルクローズ:価格が不明な場合は実行を拒否)。支出が予算に達すると実行は停止し、レポートに実際の支出とトークンが表示されます。

### システム管理

**システム管理**ページ(管理者のみ)には 3 つのツールがあります。

**ワンクリック自己更新。** Updater スタックはインストーラーが自動でデプロイするため、インストール直後からすぐに使えます。**システム管理 → システム更新**を開き、バージョンを選んで確定します。まずテストを実行し、その後 CodeBuild で `cdk deploy` を実行します。GitHub トークンは不要です。リポジトリは公開されており、更新は直接 clone します。トークンは任意で、GitHub API のレート制限を上げる用途のみです。**システム管理**で設定した場合は Secrets Manager(`playagent/github`)に保存され、二度と表示されません。フォークを使う場合は `-c githubRepo=owner/name` を付けてデプロイしてください。更新ボタンは IAM とリソースを高い権限で再デプロイするため、管理者にのみ表示され、すべての実行が記録されます。設計メモ:[docs/design/self-update.md](docs/design/self-update.md)。

**集中ログ。** デバッグ用のサービス横断ログビューアーです。CloudWatch Logs Insights を使って、すべてのサービスの CloudWatch ログ(コントロールプレーン API、engine、dispatcher、WebSocket、2 つの Fargate ランナー、自己更新とイメージビルドの CodeBuild)を一度に検索します。サービスでの絞り込み、期間(直近 15 分 / 1 時間 / 3 時間 / 24 時間)、キーワードを指定でき、結果は新しい順で、ダウンロードできます。管理者専用です。設計メモ:[docs/design/centralized-logs.md](docs/design/centralized-logs.md)。

**UI-TARS のオン/オフ。** 管理者はここで任意の GPU グラウンディングモデルをオン/オフできます。課金されるのはオンの間だけです。セットアップと詳細は[手動インストール](#手動インストール)の「任意:UI-TARS グラウンディングモデル」を参照してください。

### 用語集

- **シート(Seat)** — モデルの役割(Agent / VLM / Subagent)。ベンダーではありません。
- **VLM** — Vision-Language Model。スクリーンショットを読み取り、座標を特定します。
- **UI-TARS** — ByteDance の GUI グラウンディング向けにファインチューニングされた視覚モデル。vLLM により SageMaker 上で提供されます。任意で、デフォルトはオフです。
- **Redroid** — ARM EC2 ホスト上のコンテナで動作する Android(「Android コンテナ」ランタイム)。
- **Locality** — デバイスの所在:`cloud`(提供される)または `attached`(ローカルデバイス。操作は引き続きクラウドから)。
- **終了状態(Terminal state)** — `pass` / `fail` / `error` / `cancelled` / `budget_exceeded` / `dead`。
- **フェイルクローズ(Fail-closed)** — 不明な価格で支出するのではなく、実行を拒否すること。

---

## ユーザーマニュアル

以下では、初回実行でたどる順にウェブコンソールの全ページを説明します。本節全体に共通する前提は 5 点です。

- スクリーンショットは英語インターフェイスです。インターフェイス言語は上部バーの言語セレクターで 5 言語を切り替えられます。
- 画面に写るデータはすべて隔離テナント内の合成デモデータです。`Example Slots`、`Example Slots Mobile`、`com.example.slotsgame`、`https://example.com` はいずれもプレースホルダーで、実在のタイトルではありません。
- *管理者のみ* と記したページおよびコントロールは、管理者ロールのないアカウントには表示されません。
- ルートはハッシュルートで、インストーラーが出力したサイト URL の後ろに続きます。例:`https://<site-url>/#/apps`。
- レポート、タスク詳細、コスト分析、画面ワークスペースのタブ名は日本語インターフェイスでも英語で表示されるため、以下では画面どおりに引用します。

### サインイン

ルート:`#/` —— 認証が成功するまでこのページが表示され、それ以前は他のルートに到達できません。

![項目が未入力のサインインページ](docs/screenshots/01-login.png)

サインインカードは、インストーラーが作成した Cognito ユーザープールに対してアカウントを認証します。

- 資格情報:インストール時に発行されたメールアドレスとパスワード、または後から管理者が**メンバー管理**で作成したアカウント。
- 言語:カード内のセレクターでサインイン前にインターフェイス言語を切り替えられます。
- 招待されたアカウントは初回サインイン時に恒久パスワードの設定が必要です。

### 使い方

ルート:`#/guide`

![アプリ内ガイド](docs/screenshots/02-guide.png)

**使い方**はサインイン後のランディングページで、14 セクションでプラットフォーム全体を説明します。

- 内容はランタイム、3 つのモデルシート、コストガードレール、レポート形式、用語集です。
- 認識できないルートはすべてここへリダイレクトされます。

### アプリ管理

ルート:`#/apps`

![アプリのカード一覧](docs/screenshots/04-apps.png)

**アプリ管理**はゲームまたはアプリごとにワークスペースを 1 つ保持し、カードを選ぶとそのワークスペースが開きます。

- 各カードには名称、プラットフォーム、ジャンル、現在のビルドまたはテスト URL が表示されます。
- アプリを削除するとケース、タスク、レポート、記憶マップまで連鎖的に削除され、完了するまで進捗が返されます。

#### アプリの新規作成

![アプリ作成フォーム](docs/screenshots/03-apps-create-form.png)

作成フォームはテスト対象を登録するもので、他のすべてのページの前提になります。

- 名称とジャンル:ジャンルが、後続タスクに提示される組み込みナレッジベースを決めます。
- プラットフォーム:`web`、`android`、`ios`、`windows` のいずれかで、既定のランタイムも決まります。
- 対象:ウェブタイトルはテスト URL、ストア版はパッケージ識別子(例 `com.example.slotsgame`)。バイナリは後から**ビルド**タブでアップロードします。

### アプリワークスペース

ルート:`#/apps/:appId`

ワークスペースはアプリ単位のビューです。8 つのタブの状態は `?tab=` クエリパラメーターに保持されるため、単一タブへ直接リンクできます。

#### 概要

![ワークスペースの概要タブ](docs/screenshots/09-workspace-overview.png)

**概要**はアプリの要約です。ケース、タスク、レポートの件数と直近の実行を示します。

#### テストケース

![ワークスペースのテストケースタブ](docs/screenshots/11-workspace-cases.png)

**テストケース**はこのアプリに定義されたフローの一覧で、エディターは後述の「テストケース」と同一です。

- 各行にケース名、バージョンスタンプ、作成者が表示されます。
- ケースは保存時にバージョン化されるため、レポートには必ず実行されたバージョンが記載されます。

#### テストタスク

![ワークスペースのテストタスクタブ](docs/screenshots/24-workspace-tasks.png)

**テストタスク**はこのアプリの実行一覧であり、新しい実行を投入する場所です。

![入力済みのタスク投入フォーム](docs/screenshots/25-task-submit-form.png)

投入フォームは、実行開始前に必要な条件をすべて確定させます。

- ケースとランタイム:ランタイムの既定値はアプリのプラットフォームに従います(ウェブタイトルは `Web browser`)。
- モデルシート:Agent、VLM、Subagent の 3 つで、それぞれ価格スナップショットを固定します。価格が不明な場合は実行を拒否します。
- 上限:ステップ上限と米ドル建ての予算。どちらかに達した時点で実行を停止します。
- ナレッジベース:ジャンルの組み込み分が事前選択され、追加のベースも添付できます。

#### テストレポート

**テストレポート**タブはこのアプリで絞り込んだレポート一覧です。内容は後述の「テストレポート」と同一で、図はそちらに掲載しています。

#### 記憶マップ

![ワークスペースの記憶マップタブ](docs/screenshots/45-workspace-memory.png)

**記憶マップ**はこのアプリの実行が学習した画面を、サムネイル付きのノードと遷移のエッジで表示します。

#### テスト認証情報

![ワークスペースのテスト認証情報タブ](docs/screenshots/13-workspace-credentials.png)

**テスト認証情報**はアプリのログイン機密を AWS Secrets Manager に保管し、キー名のみを返します。

- ケースからは `${KEY}` で参照します。ケース内の平文パスワードは保存時に拒否されます。
- 値は実行コンテナ内でのみ置換され、レポートやスクリーンショットには書き込まれません。

#### ビルド

![ワークスペースのビルドタブ](docs/screenshots/10-workspace-builds.png)

**ビルド**はアップロード済みのアーティファクト(APK/IPA/XAPK/ZIP/EXE)を保持し、次の実行でインストールするものを示します。

#### ナレッジ

![ワークスペースのナレッジタブ](docs/screenshots/12-workspace-knowledge.png)

**ナレッジ**はナレッジベースをアプリに紐付け、すべてのタスクに継承させます。スクリーンショットには組み込みベースのみが並んでいます。

### テストケース

ルート:`#/cases`

![全アプリ横断のテストケース](docs/screenshots/14-cases.png)

**テストケース**はテナント内の全アプリのケースを一覧し、開くエディターはワークスペースタブが埋め込むものと同一です。エディターには 3 つの作成モードがあります。

#### 自然言語

![自然言語モード](docs/screenshots/05-case-form-nl.png)

**自然言語**は平易な説明文からケースを下書きします。ドラフト用モデルがそれを YAML に変換し、レビューに回します。

- ドラフト用モデルはフォームで選択し、下書きは必ず **YAML** に出力されるため保存前に確認できます。

#### 受け入れ基準

![構造化された受け入れ基準エディター](docs/screenshots/06-case-form-acceptance.png)

受け入れ基準エディターは合格条件を 1 行 1 基準で定義し、その行がレポートの判定表になります。

- 各行には ID、説明、AI が提示すべき証跡が含まれます。

#### YAML

![YAML モード](docs/screenshots/07-case-form-yaml.png)

**YAML** はケースの保存形式であり、モデル呼び出しを伴わない決定的な経路です。

- キー:`url` またはアプリの対象、目的を表す `task`、基準を表す `acceptance`。
- 資格情報らしいキーの値が `${ENV}` プレースホルダーでも機密参照でもない場合、保存時に拒否されます。

#### Excel から取り込み

![Excel 取り込みモード](docs/screenshots/08-case-form-excel.png)

**Excel から取り込み**は既存のテスト手順表をケースに変換し、行ブロック 1 つがケース 1 件になります。

### ナレッジ管理

ルート:`#/knowledge`

![組み込みナレッジテンプレート](docs/screenshots/15-knowledge-templates.png)

**ナレッジ管理**はタスクが読み取れる内容を管理します。Markdown は全文を注入し、PDF は必要に応じて検索します。

#### ジャンルテンプレート(組み込み)

1 つめのタブはプラットフォーム同梱のジャンル別・シナリオ別ベースを提供し、設定は不要です。

#### マイナレッジベース

2 つめのタブはこのプラットフォームにアップロードされたベースを保持します。内容がテナント横断で共有されるため、公開画像に共有素材を載せない方針から、ここでは本文のみで説明しスクリーンショットは掲載しません。

### デバイス管理

ルート:`#/devices`

![デバイス管理ページ](docs/screenshots/16-devices.png)

**デバイス管理**は現在利用できる実行リソースと、プラットフォームに接続されたローカルデバイスを報告します。

- **クラウドデバイス**:現在利用できる Device Farm の実機。実行ごとに 1 台を確保し、終了時に返却します。
- **コンテナ(Fargate)**、**タスク専用ホスト(EC2)**、**Windows ストリーミング(GameLift Streams)**:約 30 秒ごとに更新される読み取り専用のスナップショットです。この 3 つの一覧はテナント単位ではなくアカウント全体を対象とするため、スクリーンショットでは行を非表示にして撮影しています。
- **ローカルデバイス**:登録済みのローカルマシンがエージェントを実行し、操作はクラウドから行われます。
- **ログイン機密の参照**:ワークスペースの**テスト認証情報**タブと同じ機密ストアを、キー名で一覧します。

### コスト分析

ルート:`#/cost`

![テストコストのタブ](docs/screenshots/17-cost.png)

**コスト分析**は、テストに要した費用と AWS が実際に請求した金額を分けて示します。

#### Testing cost (by app)

1 つめのタブは各実行のトークン数と Device Farm の課金分数から、アプリ別・モデル別の費用を日単位で算出します。

#### AWS bill (actual)

2 つめのタブは Cost Explorer から実際の請求額を読み取ります。このビューはアカウント全体を対象とし、1 回の表示ごとに Cost Explorer のクエリ費用が発生するため、ここでは本文のみで説明しスクリーンショットは掲載しません。料金と実測の日次金額は[コスト](#コスト)にあります。

### メンバー管理

ルート:`#/members` —— *管理者のみ*

![1 件のアカウントに絞り込んだメンバー一覧](docs/screenshots/18-members.png)

**メンバー管理**はサインインできる対象と、各アカウントが属するテナントを管理します。

- 検索ボックスと 4 つのフィルター(**すべて** / **有効** / **無効** / **管理者**)で表を絞り込めます。スクリーンショットは 1 件のアカウントに絞り込んだ状態です。
- 行の操作:パスワードのリセット、無効化と有効化、テナントの変更、管理者権限の付与と取り消し、削除。

#### メンバー追加

![メンバー追加フォーム](docs/screenshots/19-members-add.png)

追加フォームはテナントと初期パスワードを指定してアカウントを作成します。同一テナントのアカウントは、そのアプリとテストデータを共有します。

- **初期パスワード**は 8 文字以上で、大文字・小文字と数字を含む必要があります。スクリーンショットでは空欄です。

### モデル管理

ルート:`#/model-admin` —— *管理者のみ*

![モデル管理ページ](docs/screenshots/20-model-admin.png)

**モデル管理**は各シートで利用できるモデルと定価を一覧します。実行時の価格スナップショットはここから取得されます。

- 価格が不明なモデルは選択できません。価格不明での実行は拒否されるためです。

### システム管理

ルート:`#/system` —— *管理者のみ*

#### システム更新

![システム更新セクション](docs/screenshots/21-system-update.png)

**システム更新**は現在のバージョンと GitHub の最新バージョンを比較し、CodeBuild 経由で再デプロイします。

- 現在のバージョン、GitHub の最新バージョン、更新履歴が表示され、デプロイ前にテストが実行されます。
- この操作の確認は IAM とインフラを高権限で再デプロイするため、管理者のみに限定され、実行はすべて記録されます。

#### UI-TARS グラウンディングモデル

![オフのままの UI-TARS スイッチ](docs/screenshots/22-system-uitars.png)

**UI-TARS グラウンディングモデル**のスイッチは、任意利用の GPU エンドポイントを起動・停止します。オンの間は継続的に課金されます。

- スイッチは既定でオフで、本キャプチャでもオフのままです。オン時の実測費用は 1 日あたり US$62.53 です。

#### 集中ログ

![集中ログの検索条件](docs/screenshots/23-system-logs.png)

**集中ログ**は CloudWatch Logs Insights で全サービスのログを一度に検索します。

- コントロール:サービスフィルター、期間(15 分〜24 時間)、キーワード。スクリーンショットはクエリ未実行の状態です。

### テストタスク

ルート:`#/tasks`

![実行中タスクを含むタスク一覧](docs/screenshots/26-tasks-running.png)

**テストタスク**はテナント内の全実行を新しい順に一覧し、実行中のタスクへの入口になります。

- 各行にジョブ ID、アプリ、ケース、ランタイム、状態、経過時間が表示されます。
- 終了状態は `pass`、`fail`、`error`、`cancelled`、`budget_exceeded`、`dead` です。

### タスク詳細

ルート:`#/tasks/:jobId`

詳細ページは左にライブ画面を固定し、右に 8 つのペインのいずれかを表示します。3 つのペインは実行中のみライブデータを持ちます。

#### Live log

![実行中のタスク詳細](docs/screenshots/27-task-detail-live.png)

**Live log** は実行中の進行をステップごとに追い、ライブ画面とステップタイムラインと並んで表示されます。

#### Full logs

![実行中の Full logs ペイン](docs/screenshots/28-task-detail-live-logs.png)

**Full logs** はその実行のランナーログとデバイスログを集約します。

![実行終了後の Full logs ペイン](docs/screenshots/31-task-detail-logs.png)

終了状態に入ると、同じペインに完了した実行の全ログが残ります。

#### Steps

![Steps ペイン](docs/screenshots/30-task-detail-trace.png)

**Steps** はトレースです。1 行が 1 アクションで、スクリーンショット、操作対象、結果を伴います。

#### Metrics

![Metrics ペイン](docs/screenshots/32-task-detail-analysis.png)

**Metrics** は実行中に観測した数値をグラフ化し、選択した指標ごとに 1 系列を描きます。

#### Token usage

![Token usage ペイン](docs/screenshots/33-task-detail-usage.png)

**Token usage** は費用をシート別・ステップ別に分解し、その実行の総コストを示します。

#### Script & run info

![Script & run info ペイン](docs/screenshots/34-task-detail-script.png)

**Script & run info** は、この実行に用いたケースのバージョン、ランタイム、上限設定を記録します。

#### Ask AI

![質問と回答がある Ask AI ペイン](docs/screenshots/35-task-detail-ask.png)

**Ask AI** はその実行自身のトレース、ログ、指標に基づいて質問に回答します。

#### Interact with screen

**Interact with screen** は各エージェントの推論を表示し、実行中の指示も受け付けます。独立したタブになるのは縦向きレイアウトのみで、スクリーンショットの横向きレイアウトではこの内容がライブ画面の隣に置かれます。

### ライブ画面

ルート:`#/live/:jobId`

![ポップアウトのライブ画面](docs/screenshots/29-live-popout.png)

ポップアウトはナビゲーションを含まず、ライブ画面だけを描画します。セカンドモニターや共有表示に向いています。

- このルートは詳細ページから開き、実行が終了状態に達するまで利用できます。

### テストレポート

ルート:`#/reports`

![レポート一覧](docs/screenshots/36-reports.png)

**テストレポート**はテナント内の完成したレポートを一覧します。終了状態に達した実行ごとに 1 件のレポートが生成されます。

### レポート

ルート:`#/reports/:jobId`

レポートはスクロール可能な 1 つの文書です。以下では読む順にセクションを説明します。

#### Cover

![レポート表紙](docs/screenshots/37-report-cover.png)

表紙には全体のテストステータス、アプリ、ケースのバージョン、実行サマリーが載ります。

#### Acceptance Verdict & Criteria

![受け入れ判定表](docs/screenshots/38-report-acceptance.png)

このセクションはケースの受け入れ基準を 1 条ずつ判定し、判定の根拠となる証跡を示します。

#### Verdict Matrix

![判定マトリクス](docs/screenshots/39-report-verdicts.png)

マトリクスの 1 行が 1 件の合否判定です。マイルストーンは証跡全体に対するルールで判定され、ステップ判定は AI がアクション前に宣言した期待値を次の画面で判定したものです。

- 行を開くと、アクション前後のスクリーンショット、判断理由、修正案が展開されます。

#### AI Execution Evidence

![AI 実行証跡](docs/screenshots/40-report-evidence.png)

証跡セクションは実行をステップごとに再現し、各ステップに当時のスクリーンショットと推論記録を添えます。

#### Release Readiness

![リリース準備度](docs/screenshots/41-report-release.png)

リリース準備度は設定したしきい値に照らして判定を推奨へ換算します。カバレッジ不足で判断できない場合も含みます。

#### Report guide —— Overview

![レポートアシスタントの Overview タブ](docs/screenshots/42-report-assistant-guide.png)

レポートアシスタントはレポート端のランチャーから開き、既定で **Overview** を表示します。判定が何に基づくか、主張がどこまで及ぶかを述べるタブです。

#### Report guide —— Q&A

![レポートアシスタントの Q&A タブ](docs/screenshots/43-report-assistant-ask.png)

**Q&A** は開いているレポート自身のデータに基づいて質問に回答します。スクリーンショットは質問欄が未使用の状態です。同一コンポーネントで回答済みのやり取りは、前述の **Ask AI** に掲載しています。

#### Report guide —— Review

![レポートアシスタントの Review タブ](docs/screenshots/44-report-assistant-review.png)

**Review** は争点のある判定を訂正する場所です。所見は理由付きで上書きでき、その上書きはレポートとともに保存され、アプリの記憶マップにも書き戻されます。スクリーンショットは、この実行に未処理の所見がない空の状態です。

### 記憶マップ

ルート:`#/memory`

記憶マップは実行をまたいで蓄積されます。画面がノード、遷移がエッジになり、以降の実行は再探索せずにこれを使って移動します。

#### 関係図

![記憶マップの関係図ビュー](docs/screenshots/46-memory-graph.png)

**関係図**はセレクターで選んだアプリの画面と遷移を描画し、画面数・遷移数・コントロール数を示します。

#### ギャラリー

![記憶マップのギャラリービュー](docs/screenshots/47-memory-grid.png)

**ギャラリー**は同じ画面群をサムネイルで表示します。見た目から画面を探す場合はこちらが速いです。

#### 画面ワークスペース

![1 画面を開いた画面ワークスペース](docs/screenshots/48-memory-screen-studio.png)

画面を選ぶとそのワークスペースが開き、3 つのタブが並びます。**Script & actions** は記録されたコントロール、**Screen details** は説明、**Appium code** は生成されたスクリプトです。

- アプリの記憶を消去すると、次の実行はゼロから学習し直します。

---

## 手動インストール

自分のコンピューターからデプロイしたい場合や、一度きりの任意セットアップが必要な場合は、以下の方法を使用してください。[クイックスタート](#クイックスタート)の CloudShell ワンライナーが最も簡単な方法で、このセクションはそれ以外のすべてを扱います。

### Windows / macOS 推奨：ワンクリックでインストール／更新

**Node.js 22、AWS CLI v2、Git、Docker Desktop** をインストールし、AWS にログインして下記の Bedrock モデルを有効にします。その後リポジトリを clone し、次を実行します。

```text
Windows: Install-Latest.cmd をダブルクリック
macOS:   Install-Latest.command をダブルクリック
Linux:   scripts/deploy-latest.sh を実行
```

3 つのランチャーは同じデプロイコアを使用し、デフォルトリージョンは **`us-west-2`(米国西部、オレゴン)** です(`--region` で変更できます)。

どの OS でも `npm run deploy:latest -- --expected-account-id 123456789012` で AWS アカウントを検証できます。従来の PowerShell スクリプトは互換ラッパーとして残りますが、全 OS が同じ Node.js デプロイコアを使用します。

`npm run deploy:latest` でも実行できます。インストーラーは**このフォルダーをそのままデプロイ**し、新しい版を自動取得しません。最新の `main` をデプロイするには先に `git pull` してください。バージョンタグは Git commit SHA です(`.git` のない ZIP を展開した場合は `local-<UTC 時刻>`)。未コミットの変更がある場合は警告を表示し、`<sha12>-dirty-<UTC 時刻>` タグで一緒にデプロイします。lockfile からのインストール、テスト、全スタックとアップデータ(Updater)のデプロイを行い、両ランナーにバージョンタグと `latest` を付け、ECS タスク定義はバージョンタグに固定します。最後に CloudFormation、ECR digest、ECS イメージ、CloudFront を検証します。ローカルファイルをリセット・stash・削除することはありません。

誤った AWS アカウントへのデプロイを防ぐため、`npm run deploy:latest -- --expected-account-id 123456789012` の使用を推奨します。初回インストールの対話モードで入力するのは、管理者の **Email（ログイン username）** と、画面に表示されないパスワードだけです。tenant のデフォルトは `default` です。高度な構成で変更する場合だけ `--admin-tenant <tenant>` を使用します。

非対話の自動化では、パスワードをコマンドライン引数に絶対に置かないでください。シークレットマネージャーの出力を stdin に pipe します。

```bash
# bash / zsh（macOS または Linux）
aws secretsmanager get-secret-value --region us-west-2 --secret-id playagent/admin-password --query SecretString --output text | npm run deploy:latest -- --non-interactive --admin-email admin@example.com --admin-password-stdin
```

```powershell
# PowerShell
(aws secretsmanager get-secret-value --region us-west-2 --secret-id playagent/admin-password --query SecretString --output text) | npm run deploy:latest -- --non-interactive --admin-email admin@example.com --admin-password-stdin
```

```bat
rem コマンドプロンプト（cmd.exe）
aws secretsmanager get-secret-value --region us-west-2 --secret-id playagent/admin-password --query SecretString --output text | npm run deploy:latest -- --non-interactive --admin-email admin@example.com --admin-password-stdin
```

これらの例にリテラルのパスワードはありません。デフォルト tenant を変更する場合だけ `--admin-tenant <tenant>` を追加します。

> ワンクリック方式には Docker Desktop が必要です。下記の手動 CodeBuild 方式では Docker は不要です。
>
> **`cdk destroy` 後の再インストール:** データバケット、Cognito User Pool、ランナー ECR は `Retain` で保護されます。インストーラーは残存 ECR を検出して再利用するため、同名リポジトリで再インストールが止まりません。古いデータバケット/User Pool は自動削除・自動移行しません。完全に空にする場合は必要なデータをバックアップし、保留リソースを明示的に削除してください。

### 手動インストール（ステップバイステップ）

このセクションは **AWS の経験がないこと**を前提としています。上から順に進めてください。所要時間は合計約 **60–90 分**で、その大半は AWS の待ち時間です。

> すべて **`us-west-2`(米国西部、オレゴン)** にデプロイします。変更内容を理解していない限り、すべての箇所でこのリージョンを使用してください。
>
> コマンドは **bash**(macOS、Linux、Git Bash、WSL)向けに書かれています。Windows PowerShell では、`NAME=value command` の代わりに `$env:NAME="value"` で変数を設定してください。

#### ステップ 0 — コンピューターにツールをインストールする

| ツール | 用途 | インストール |
| --- | --- | --- |
| **Node.js 22+** | ビルドとデプロイのスクリプトを実行 | https://nodejs.org(「LTS」インストーラー) |
| **AWS CLI v2** | AWS アカウントと通信 | https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html |
| **Git** | このコードを取得 | https://git-scm.com/downloads |

```bash
node --version    # v22.x 以上
aws --version     # aws-cli/2.x
git --version
```

Docker は**不要**です。コンテナイメージはクラウド(AWS CodeBuild)でビルドされます。

#### ステップ 1 — コードを取得する

```bash
git clone https://github.com/hoycdanny/playagent-checker.git
cd playagent-checker
npm install
```

#### ステップ 2 — AWS CLI をアカウントに接続する

アカウント所有者に **Access Key ID** と **Secret Access Key** を依頼してください(AWS コンソール → IAM → ユーザー → セキュリティ認証情報 → アクセスキーを作成)。その後:

```bash
aws configure
# AWS Access Key ID     : <貼り付け>
# AWS Secret Access Key : <貼り付け>
# Default region name   : us-west-2
# Default output format : json

aws sts get-caller-identity   # アカウント番号が表示されるはずです
```

> 認証情報には、Lambda、S3、Cognito、API Gateway、IAM、ECS、EC2、ECR、CodeBuild、SageMaker、Bedrock、CloudFront のリソースを作成できる権限が必要です。初回セットアップでは、管理者ユーザー(`AdministratorAccess`)が最も簡単です。

#### ステップ 3 — AI モデルを有効にする(Amazon Bedrock)

新しいアカウントでは Bedrock モデルが**無効**です。一度有効にしないと、すべての実行が失敗します。

1. AWS コンソール → **Bedrock** → リージョン(右上)で **US West (Oregon) us-west-2** を選択。
2. 左メニュー → **Model access** → **Enable specific models**。
3. 少なくとも以下を有効にします:
   - **Amazon – Nova Lite**(デフォルトの判断モデル)
   - **Amazon – Nova Micro**(デフォルトの補助モデル)
   - **Moonshot AI – Kimi K3**(デフォルトの画面解析モデル)
   - **Anthropic – Claude Sonnet 4.5**(テストケースの下書き、インポートしたスプレッドシートの読み取り)
   - **Amazon – Titan Text Embeddings V2**(ナレッジベース検索)
4. **Access granted** になるまで待ちます。評価目的であれば、リージョン内のすべてのモデルを有効にしても構いません。アプリは各シートで利用可能なモデルを一覧表示します。

#### ステップ 4 — CDK を準備する(アカウントごとに 1 回)

```bash
cd infra
npx cdk bootstrap aws://ACCOUNT_ID/us-west-2
```

`ACCOUNT_ID` をステップ 2 で表示された番号に置き換えてください。

#### ステップ 5 — バックエンドをデプロイする

`infra/` から:

```bash
AWS_REGION=us-west-2 npx cdk deploy \
  PlayAgentDev-Foundation PlayAgentDev-ControlPlane \
  PlayAgentDev-Scheduling PlayAgentDev-Execution \
  --require-approval never
```

> **任意のコスト配分タグ。** すべてのリソースに `project`、`stage`、`component` のタグが付きます。`-c` で独自のタグを追加できます(実行時に起動される EC2/Fargate にも引き継がれます):
> `-c costCenter=QA-1234 -c owner=alice -c team=game-qa`(キー:`costCenter`、`owner`、`team`、`env`、`costAllocation`)。すべてのデプロイで同じフラグを使用してください。

約 10–15 分かかります。その後、次のステップで必要な値を表示します:

```bash
aws cloudformation describe-stacks --region us-west-2 --stack-name PlayAgentDev-Foundation \
  --query "Stacks[0].Outputs[].[OutputKey,OutputValue]" --output table
aws cloudformation describe-stacks --region us-west-2 --stack-name PlayAgentDev-ControlPlane \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'||OutputKey=='WsUrl'].[OutputKey,OutputValue]" --output table
```

以下を控えておいてください:

- **データバケット** — 出力名に `DataBucket`(Ref)を含み、`playagentdev-foundation-databucket…` のような値
- **User Pool ID** — `UserPoolId` を含み、`us-west-2_XXXXXXXXX` のような値
- **User Pool Client ID** — `UserPoolClientId` を含む
- **ApiUrl** — `https://xxxx.execute-api.us-west-2.amazonaws.com`
- **WsUrl** — `wss://xxxx.execute-api.us-west-2.amazonaws.com/prod`

#### ステップ 6 — ランナーイメージをビルドする(必須)

Web と Device Farm のランナー、および Windows の実行を 1 時間以上継続させるセッション維持タスクは、自分の ECR にあるコンテナイメージから実行されます。イメージは CodeBuild でクラウド上でビルドされるため、大きなファイルがコンピューターにダウンロードされることはありません。

```bash
cd ../agent/sagemaker && npm install
export PA_SM_BUCKET=PASTE_DataBucket     # ステップ 5 の値 — スクリプトはビルドソースをここにアップロードします
export AWS_REGION=us-west-2

# a) 共有 CodeBuild ロールを作成し、UI-TARS の重みとサービングイメージを配置します
#    (後で UI-TARS をオンにする場合のみ必要)。約 20–40 分、AWS 上で実行されます。
#    GPU は起動しません。ストレージ費用は約 US$2/月です。
node cloudBuild.mjs

# b) ランナーイメージをビルドしてプッシュします(それぞれ数分)。
node cloudBuildRunner.mjs
node cloudBuildWebRunner.mjs
node cloudBuildKeepAlive.mjs
```

> `PA_SM_BUCKET` は必須です。自分の Foundation スタックが出力した DataBucket を設定してください。スクリプトにはアカウント固有のバケット既定値を含めません。

#### ステップ 7 — Web コンソールをビルドする

```bash
cd ../../web
cat > .env.production <<'EOF'
VITE_COGNITO_REGION=us-west-2
VITE_COGNITO_USER_POOL_ID=PASTE_UserPoolId
VITE_COGNITO_CLIENT_ID=PASTE_UserPoolClientId
VITE_API_URL=PASTE_ApiUrl
VITE_WS_URL=PASTE_WsUrl
EOF
npm run build
```

ビルド前に、各 `PASTE_...` をステップ 5 の値に置き換えてください。

#### ステップ 8 — Web コンソールをデプロイする

```bash
cd ../infra
AWS_REGION=us-west-2 npx cdk deploy PlayAgentDev-Frontend --require-approval never
aws cloudformation describe-stacks --region us-west-2 --stack-name PlayAgentDev-Frontend \
  --query "Stacks[0].Outputs[?contains(OutputKey,'SiteUrl')].OutputValue" --output text
```

表示された `https://xxxx.cloudfront.net` のアドレスを開くと、ログインページが表示されます。

#### ステップ 9 — 最初の(管理者)ログインを作成する

セルフサインアップは意図的に無効にしています。最も簡単なのは上記のワンクリックインストーラーです。手動セットアップでは次のツールを実行します。パスワードは非表示で入力するため、コマンドや shell history に残りません。tenant を分離する明確な理由がなければ、デフォルトの `default` を使用してください。

```bash
cd ../agent/sagemaker
AWS_REGION=us-west-2 node createUser.mjs --email admin@example.com --tenant default --admin
```

自動化では、パスワードを argv に置かず、シークレットマネージャーから stdin に pipe します。

```bash
aws secretsmanager get-secret-value --region us-west-2 --secret-id playagent/admin-password --query SecretString --output text | AWS_REGION=us-west-2 node createUser.mjs --email admin@example.com --tenant default --admin --password-stdin
```

パスワードは 8 文字以上で、大文字、小文字、数字を含めてください。

以降のユーザーは**メンバー管理**ページから作成します。

#### ステップ 10 — ログインして最初のテストを実行する

CloudFront の URL を開いてログインすると、**ガイド**が表示されます。その後:

1. **アプリ管理** → アプリを作成します(APK/IPA/XAPK をアップロード、または Web の場合は URL を入力)。
2. アプリワークスペース内 → **テストケース** → フローを記述すると、AI がケースに変換します。
3. **テストタスク** → ケースとランタイム(**Web**、**Android/iOS 実機**、または **Android コンテナ**)を選択 → 送信します。モデルのデフォルトは Nova Lite / Kimi K3 / Nova Micro です。
4. ライブで確認し、その後**レポート**を読みます。

> **メンバー管理 / システム管理の項目が表示されない場合** これらは管理者にのみ表示され、ログイントークンはサインイン時にのみグループの変更を反映します。管理者に設定された後は、一度ログアウトして再ログインしてください。

✅ **これで動作する環境が整いました。** 以下はすべて任意です。

---

### 任意:UI-TARS グラウンディングモデル

UI-TARS-1.5-7B は、小さなボタンに対してより高精度になり得る GUI グラウンディングモデルです。GPU が**オンの間は約 US$62.5 / 日**かかるため、**デフォルトはオフ**です。現在は Device Farm 実機ランタイムのみが使用し、他のランタイムは Bedrock の視覚モデルにフォールバックします。

スイッチが機能するには、アカウントに以下が必要です:

1. **ステップ 6a**(`cloudBuild.mjs`)で配置した重みとサービングイメージ。
2. **`ArtSmokerSageMakerRole`** という名前の SageMaker 実行ロール(スタックがデフォルトで想定する名前。SageMaker がイメージを取得し重みを読み取れるようにします):
   ```bash
   ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
   BUCKET=PASTE_DataBucket
   aws iam create-role --role-name ArtSmokerSageMakerRole --assume-role-policy-document \
     '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"sagemaker.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
   aws iam put-role-policy --role-name ArtSmokerSageMakerRole --policy-name uitars --policy-document "{
     \"Version\":\"2012-10-17\",\"Statement\":[
     {\"Effect\":\"Allow\",\"Action\":\"ecr:GetAuthorizationToken\",\"Resource\":\"*\"},
     {\"Effect\":\"Allow\",\"Action\":[\"ecr:BatchGetImage\",\"ecr:GetDownloadUrlForLayer\",\"ecr:BatchCheckLayerAvailability\"],
      \"Resource\":\"arn:aws:ecr:us-west-2:${ACCOUNT}:repository/playagent-vllm-byoc\"},
     {\"Effect\":\"Allow\",\"Action\":\"s3:ListBucket\",\"Resource\":\"arn:aws:s3:::${BUCKET}\"},
     {\"Effect\":\"Allow\",\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::${BUCKET}/sagemaker-models/ui-tars/*\"},
     {\"Effect\":\"Allow\",\"Action\":[\"logs:CreateLogGroup\",\"logs:CreateLogStream\",\"logs:PutLogEvents\",\"logs:DescribeLogStreams\",\"cloudwatch:PutMetricData\"],\"Resource\":\"*\"}]}"
   ```
   別のロールを使用する場合は、ControlPlane を `-c uitarsRoleArn=arn:aws:iam::…:role/…` 付きでデプロイしてください。

その後、**システム管理 → UI-TARS → オンにする**を使用します。**オン**になるまで約 8–15 分かかり、起動中からすでに課金されます。その後、UI-TARS がタスクの VLM メニューに表示されます。使い終わったら同じページで**オフ**にしてください。GPU エンドポイントは削除されますがモデル設定は保持されるため、再度オンにする際にセットアップは不要です。オフの間はモデルメニューに UI-TARS が表示されず、UI-TARS を指定したタスクは拒否されます。

詳細:[docs/design/uitars-sagemaker-grounding.md](docs/design/uitars-sagemaker-grounding.md)。

### 任意:Windows PC ゲーム(GameLift Streams)

**Windows マシンから**一度だけ実行してください(GPU ホスト用の Windows ツールをパッケージ化します):

```powershell
cd worker\windows-host\gamelift
npm install
$env:AWS_REGION="us-west-2"; node setup.mjs --capacity 2
```

GameLift Streams アプリケーションと、**常時稼働容量なし**(テストを実行していない間は課金なし)・最大 2 同時実行のストリームグループを作成します。その後、タスク送信時に **Windows** ランタイムが表示されます。初回の起動には 10–15 分かかり、各実行は 60 分が上限です。Windows ホストのスクリプトを変更した後は `setup.mjs` を再実行してください。自己更新はこれをカバーしません。

### コスト分析ページを有効にする

**コスト分析**ページには、実際の AWS 請求(Cost Explorer から取得)とタスク見積もり(トークン × 単価)が並べて表示されます。見積もりはすぐに利用できます。実際の請求を表示するには、アカウントごとに一度:

1. **Billing and Cost Management → Cost Explorer** → 有効化します。データは約 24 時間後に表示されます。
2. **Billing and Cost Management → Cost allocation tags** → `project`、`stage`、`component`(およびカスタムタグ)をアクティブ化します。
3. 1 日待ちます。タグはアクティブ化以降のコストにのみ適用され、それ以前のコストに遡って適用されることはありません。

Cost Explorer は `us-east-1` にのみ存在し(アプリはそこでクエリします)、1 クエリあたり約 US$0.01 かかり、約 24 時間の遅延があります。タグのアクティブ化には請求情報へのアクセス権が必要です。

注:Bedrock トークンと Device Farm の分数にはリソースタグが付かないため、`component` 別の実際の請求ビューでは個別に表示されます。Device Farm の分数は、セッション名によって各実行とも照合されます。

## Device Farm(実機)に関する注意

追加のセットアップは不要です。Device Farm は **us-west-2** にあり、ランナーがプロジェクトを自動作成します。実機ランタイムを選択すると、現在利用可能な端末(機種、OS、解像度、メモリ、CPU)がドロップダウンに一覧表示されます。「自動」は最初に利用可能な端末を選択します。画面がハードリミットを超えて変化しない場合(インストールの停止、アプリのフリーズ、reCAPTCHA の壁)、ループで課金し続けるのではなく、実行は `error` として終了します。

## テスト認証情報(登録/ログインフロー)

アカウントとパスワードは、アプリごとに**アプリ → テスト認証情報**で管理します。1 フィールドにつき 1 行のキー–値です(例:`帳號`、`密碼`、`伺服器名稱`)。各行は**マスク**(デフォルト。AI には `${key}` のみが見え、ランナーが入力時に値を埋め込みます)または**表示**(AI がリストから選択する必要がある、機密でない値向け)のいずれかです。ケースは認証情報を参照せず、通常どおり記述してください。

値は **AWS Secrets Manager**(`playagent/tenant/<tenant>/app/<appId>/credentials`)にのみ保存されます。マスクされた値は UI に表示されず、API から返されず、モデルに送信されず、S3、タスク定義、レポート、トレースにも書き込まれません。詳細:[docs/design/test-credentials.md](docs/design/test-credentials.md)。

---

## クリーンアップとトラブルシューティング

**まず最大のコストを止めます:** システム管理ページで UI-TARS を**オフ**にし、長時間の Android コンテナや Device Farm の実行が残っていないことを確認してください(デバイス管理ページ)。

**すべてを削除する**(データバケットと Cognito ユーザープールは設計上保持されます。本当に削除したい場合は手動で削除してください):

```bash
cd infra
AWS_REGION=us-west-2 npx cdk destroy --all
```

他にも次のものが残ります:ランナーの ECR リポジトリ `playagent-exploration-runner` / `playagent-web-runner` / `playagent-keepalive-runner`(CDK がデフォルトで保持)、ECR リポジトリ `playagent-vllm-byoc`、CodeBuild プロジェクト `playagent-uitars-build` / `playagent-runner-build` / `playagent-web-runner-build` / `playagent-keepalive-runner-build`、ロール `PlayAgentCodeBuildUitarsRole`、SageMaker のモデル/設定 `ui-tars-playagent-*`、および(セットアップした場合)GameLift Streams アプリケーションとストリームグループ。

| 症状 | 対処 |
| --- | --- |
| デプロイが失敗する:*"not bootstrapped"* | `us-west-2` でステップ 4 を実行してください。 |
| 実行が *AccessDenied* / モデル利用不可でエラーになる | **us-west-2** でモデルアクセスを有効にしてください(ステップ 3)。 |
| Web / Device Farm の実行が起動しない(イメージが見つからない) | ランナーイメージをビルドしてください(ステップ 6)。 |
| ログインページは表示されるがサインインに失敗する、またはページが空白 | `web/.env.production` の値が誤っているか、編集後に Web を再ビルド + 再デプロイしていません(ステップ 7–8)。 |
| Android コンテナでゲームがすぐに自ら終了する | エミュレーター検出があります。Android 実機を使用してください。 |
| UI-TARS が**失敗**と表示される | オフにし(課金停止)、カード上の理由を確認し、ステップ 6a と SageMaker ロールを確認してから、再度オンにしてください。 |
| システム更新でトークンの権限不足と表示される | トークンにはこのリポジトリに対する **Contents: Read-only** が必要です。 |
| サインアップできない | 仕様です。ユーザーは管理者が作成します(ステップ 9 / メンバー管理ページ)。 |

---

## リポジトリ構成

```
agent/            Execution runners
  explorationRunner.mjs    Device Farm / Android container / Windows runner (one loop, different drivers)
  webExplorationRunner.mjs Web runner (Playwright headless Chromium)
  uitarsClient.mjs         UI-TARS (SageMaker) grounding client
  sagemaker/               Cloud build scripts (runner images, UI-TARS), createUser.mjs
infra/            AWS CDK app (Foundation, ControlPlane, Scheduling, Execution, Frontend, Updater)
web/              React + Vite web console (5-locale i18n)
worker/           Platform workers, incl. windows-host/gamelift (Windows GameLift Streams setup)
docs/             Architecture, design notes, research
```

## 開発者向け

```bash
npm run test:web       # Web のユニットテスト
npm run test:worker    # Worker のユニットテスト
cd infra && npm test   # CDK + Lambda のユニットテスト
npm run build:web      # i18n チェック + 型チェック + ビルド
```

[CONTRIBUTING.md](CONTRIBUTING.md) と [docs/architecture.md](docs/architecture.md) を参照してください。

## ライセンス

リポジトリの設定を参照してください。社内評価用に現状のまま提供されます。
