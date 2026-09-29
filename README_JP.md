# PlayAgent Checker

**ゲーム / アプリ向けの AI 駆動自動 QA プラットフォーム。** テストしたいフローを普通の言葉で書けば、AI エージェントが画面を見て、タップやスワイプを代行し、成否を判定し、スクリーンショット・ステップ軌跡・ナビゲーションマップ付きの多言語レポートを生成します。

> 言語:[English](README.md) · [繁體中文](README_ZH.md) · [简体中文](README_CN.md) · **日本語** · [한국어](README_KR.md)

---

## 概要

PlayAgent Checker は **AWS(リージョン `us-east-2`)** 上で完結する、サーバーレスのコントロールプレーンとオンデマンド実行ランナーで構成されます。アプリをアップロード(または Web の URL を指定)すると、エージェントが自律的に探索し、再現可能でレビュー可能なテスト結果が得られます。

- **実運用の 2 つの実行バックエンド(いずれもエンドツーエンド検証済み):** **Web**(Playwright ヘッドレス Chromium を ECS Fargate 上で実行)と **Device Farm**(AWS Device Farm の Android/iOS 実機を Appium で駆動)。
- **エージェントループ:** スクリーンショット → VLM が測位 → Agent が決定 → 端末で実行 → 再びスクリーンショット、を目標達成または停止条件まで繰り返します。
- **高精度な GUI グラウンディング(任意):** 座標担当の VLM シートは SageMaker 上の **UI-TARS-1.5-7B** を利用でき、絵の多いゲーム画面で格段に正確です。
- **ナレッジベース、コストガードレール、5 言語 UI**(zh-Hant、en、zh-Hans、ja、ko)。

アーキテクチャ詳細:[docs/architecture.md](docs/architecture.md)。

## 想定ユーザー

- **QA チーム**:壊れやすい UI スクリプトを書かず・保守せずにゲーム/アプリをテストしたい。
- **多数のタイトルを出すスタジオ**(スロット、RPG、MMORPG、カジュアル…):ビルドごとに再現可能なスモーク/リグレッションが必要。
- **誰でも**:フローを言葉で説明できるが、自動化フレームワークは学びたくない。

## 仕組み(エンドツーエンド)

```
① アプリ作成    APK/IPA/ZIP をアップロード、または Web URL を指定。ジャンルを設定。
② テストケース  フローを普通の言葉で記述 → AI が実行可能な YAML を生成。
③ (任意)ナレッジ  ジャンル/シナリオ知識を付与し、AI に領域を理解させる。
④ タスク送信    実行環境(Web / Device Farm)+ 座標モデルを選び、クラウドに投入。
⑤ AI が実行    スクリーンショット → VLM が座標測位 → Agent が決定 → 実行 → 繰り返し。
⑥ レポート+記憶  多言語レポート(説明・スクショ・軌跡・コスト)+ 実行を跨いで蓄積するナビマップ。
```

AI は**壊れやすい要素セレクタに依存しません** —— 人間のテスターのように「実際の画面を見る」ため、検査可能な UI ツリーを持たないキャンバス系ゲーム(Cocos2d-x、Unity)でも動作します。

## 機能一覧(各ページの役割)

| ページ | 役割 |
| --- | --- |
| **ガイド** | 組み込みのウォークスルー(ログイン後の最初のページ)。5 言語対応。 |
| **アプリ** | ゲーム/アプリごとのワークスペース。名前 + プラットフォーム + ジャンルを設定。ネイティブは成果物、Web は URL。ケース・タスク・レポート・記憶を集約。 |
| **テストケース** | ケース = AI が実行する 1 つのフロー。普通の言葉で下書き(AI → YAML)、または YAML を手書き。シークレットは `${ENV}` プレースホルダ、リテラルパスワードは拒否。 |
| **タスク** | ケースを実行。**実行環境**(Web ブラウザ or Device Farm 実機)、**座標モデル**(既定 UI-TARS)、複数の**ナレッジベース**を選択。ライブ監視・キャンセル可。 |
| **レポート** | 読み取り専用の結果:AI の説明、ステップ軌跡、ゲーム画面、ナビグラフ、予算 vs 実費・トークン使用量。 |
| **メモリマップ** | 全実行を跨いで蓄積するアプリ全体像:訪れた画面がノード、遷移がエッジ —— 後続テストが速く到達。 |
| **ナレッジ** | ユーザー間で共有する再利用可能なナレッジベース。2 種(ジャンル / シナリオ)、各々 **Markdown**(全文注入)と/または **PDF 検索**(アップロード文書のベクトル検索)。 |
| **デバイス** | AWS Device Farm で現在利用可能な実機モデルを閲覧。クラウドランナーはタスクごとに自動作成・完了時回収、手動管理不要。 |

## AI:3 つのモデル「シート」

モデルはベンダーではなく**役割(シート)**で構成され、タスクごとに個別選択できます:

- **Agent(意思決定)** —— 頭脳。現在の画面と目標を見て次の操作を決定。
- **VLM(座標)** —— 視覚。「タップ対象」を画面上の実ピクセルに変換。**既定は SageMaker 上の UI-TARS-1.5-7B**(GUI グラウンディング用にファインチューニング。ゲーム画面で汎用モデルより格段に正確、繁体字中国語で応答)。
- **Subagent(補助)** —— 安価なモデルで軽量サブタスクを処理しコスト削減。

ナレッジ検索は **Amazon Titan Text Embeddings v2** と **Amazon Bedrock Knowledge Bases + S3 Vectors** を使用。SDK/エンドポイントは選ばず、modelId から自動導出されます。

## コストガードレール

各タスクには予算があります。実行前に各シートのモデルの**価格スナップショットを固定**(フェイルクローズ:価格不明なら実行拒否、不明コストで開始しない)。累積が予算に達すると停止し、レポートに実費とトークン使用量を表示します。

## 用語

- **Seat(シート)** —— モデルの役割(Agent / VLM / SubAgent)。ベンダーではない。
- **VLM** —— 視覚言語モデル。スクショを読み座標を測位。
- **UI-TARS** —— GUI グラウンディング用にファインチューニングされた ByteDance の視覚モデル。vLLM で SageMaker にデプロイ。smart-resize 後の画像上で絶対ピクセルを返す。
- **Agent ループ** —— スクショ → VLM 測位 → Agent 決定 → 実行 → 繰り返し。エンジンは常にクラウド(Lambda がオーケストレーション、ランナーは Fargate)。
- **ナレッジベース** —— Markdown(全文注入)または PDF 検索(タスク目標でベクトル検索)。
- **Locality** —— 被テスト端末の所在:`cloud`(クラウド提供)または `attached`(登録したローカル端末。クラウドの頭脳が遠隔駆動)。
- **終了状態** —— タスクの終了状態:`pass` / `fail` / `error` / `cancelled` / `budget_exceeded` / `dead`。
- **フェイルクローズ** —— 価格不明なら、不明コストで開始せず実行を拒否。

---

# 🚀 クリーンな AWS アカウントへのインストール(ステップバイステップ)

本節は **AWS 未経験** を前提に、上から順に進めます。所要時間は約 **45〜60 分**、大半は AWS の完了待ちです。

> すべて **`us-east-2`(オハイオ)** にデプロイします。変更する意図が明確でない限り、どこでもこのリージョンを使ってください。

## ステップ 0 — ローカルにツールを入れる

ローカルに 3 つ必要です。以下の確認コマンドを貼り付け、バージョンが表示されれば OK。

| ツール | 用途 | インストール |
| --- | --- | --- |
| **Node.js 22+** | ビルド・デプロイスクリプトの実行 | https://nodejs.org("LTS" を選択) |
| **AWS CLI v2** | AWS アカウントとの通信 | https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html |
| **Git** | このコードの取得 | https://git-scm.com/downloads |

```bash
node --version    # v22.x 以上
aws --version     # aws-cli/2.x
git --version
```

Docker は **不要** です(大きなコンテナイメージはクラウドでビルド)。

## ステップ 1 — コードを取得

```bash
git clone https://github.com/hoycdanny/playagent-checker.git
cd playagent-checker
```

## ステップ 2 — AWS CLI をアカウントに接続

アカウント所有者から **Access Key ID** と **Secret Access Key** を入手します(AWS Console → IAM → ユーザー → セキュリティ認証情報 → アクセスキーの作成)。

```bash
aws configure
# AWS Access Key ID     : <貼り付け>
# AWS Secret Access Key : <貼り付け>
# Default region name   : us-east-2
# Default output format  : json
```

接続確認(アカウント番号が表示されます):

```bash
aws sts get-caller-identity
```

> この認証情報にはリソース作成権限が必要です(Lambda、S3、Cognito、API Gateway、IAM、ECS、SageMaker、Bedrock、CloudFront)。初回は管理者(AWS 管理ポリシー `AdministratorAccess`)が最も簡単です。後で絞れます。

## ステップ 3 — AI モデルを有効化(Amazon Bedrock)

新規アカウントでは AI モデルが既定で **無効** です。一度有効化しないと、テスト実行は毎回失敗します。

1. AWS Console →「Bedrock」を検索 → 開く → 右上のリージョンが **US East (Ohio) us-east-2** であることを確認。
2. 左メニュー → **Model access** → **Enable specific models / Manage model access**。
3. 少なくとも以下を有効化して **Save**(通常は即時承認):
   - **Anthropic – Claude Sonnet 4.5**(テストケース作成・強力なフォールバック VLM)
   - **Amazon – Titan Text Embeddings V2**(ナレッジベース検索)
   - **Amazon – Nova Micro**(補助サブタスク)
   - 一覧にあれば **Qwen – Qwen3-VL** と **MiniMax**(既定の視覚/意思決定モデル)
4. ステータスが **Access granted** になれば完了。後で追加可能。アプリは利用可能なモデルを一覧します。

> ヒント:評価目的ならこのリージョンで「すべて有効化」でも構いません。

## ステップ 4 — CDK を準備(アカウントごとに一度)

インフラは **AWS CDK** で定義します。リージョンで一度だけ "bootstrap" が必要です。

```bash
cd infra
npm install
npx cdk bootstrap aws://アカウント番号/us-east-2
```

「アカウント番号」はステップ 2 の数値(`aws sts get-caller-identity`)に置き換えます。CDK がコードをアップロードする小さなステージング用バケットを作成します。

## ステップ 5 — バックエンドをデプロイ

`infra/` フォルダ内で:

```bash
AWS_REGION=us-east-2 npx cdk deploy \
  PlayAgentDev-Foundation \
  PlayAgentDev-ControlPlane \
  PlayAgentDev-Scheduling \
  PlayAgentDev-Execution \
  --require-approval never
```

> **任意 —— コスト配分タグ。** すべてのリソースに `project`、`stage`、`component` が自動付与されます。デプロイ時に `-c` で独自のタグ(コストセンターへのチャージバックなど)を渡せます。これらは実行時に起動する EC2/Fargate を含む全リソースに伝播し、有効化後は「コスト分析」ページで使われます(下記「コスト分析ページを有効化する」参照)。
>
> ```bash
> AWS_REGION=us-east-2 npx cdk deploy \
>   PlayAgentDev-Foundation PlayAgentDev-ControlPlane \
>   PlayAgentDev-Scheduling PlayAgentDev-Execution \
>   --require-approval never \
>   -c costCenter=QA-1234 -c owner=alice -c team=game-qa
> ```
>
> 使用可能なキー:`costCenter`、`owner`、`team`、`env`、`costAllocation`。タグを一貫させるため、各スタックのデプロイ時に同じ `-c` フラグを付けてください。

約 10〜15 分。完了後、以下を実行すると必要な 4 つの値が表示されます(命名は自動処理):

```bash
aws cloudformation describe-stacks --region us-east-2 \
  --stack-name PlayAgentDev-Foundation \
  --query "Stacks[0].Outputs[?contains(OutputKey,'UserPool')].[OutputKey,OutputValue]" --output table
aws cloudformation describe-stacks --region us-east-2 \
  --stack-name PlayAgentDev-ControlPlane \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'||OutputKey=='WsUrl'].[OutputKey,OutputValue]" --output table
```

探すのは次の 4 つです:

- **User Pool ID** — 名前に `UserPoolId` を含む出力;例 `us-east-2_XXXXXXXXX`
- **User Pool Client ID** — 名前に `UserPoolClientId` を含む出力;長い英数字
- **ApiUrl** — `https://xxxx.execute-api.us-east-2.amazonaws.com`
- **WsUrl** — `wss://xxxx.execute-api.us-east-2.amazonaws.com/prod`

## ステップ 6 — UI-TARS 座標モデルをデプロイ(必須)

PlayAgent は正確な画面座標のために SageMaker 上の **UI-TARS-1.5-7B** を使います。これは既定であり、良い結果に必須です(汎用モデルはゲーム画面でタップ位置を数百ピクセル外します)。ビルドはすべてクラウドで行われ、ローカルのディスク/帯域を**消費しません**。

```bash
cd ../agent/sagemaker && npm install
# 1) クラウドビルド:モデルのダウンロード、サービスイメージのビルド、あなたのアカウントへ push(AWS CodeBuild)。
#    約 20〜40 分。AWS 内で実行され、ローカルには何もダウンロードされません。
AWS_REGION=us-east-2 node cloudBuild.mjs
# 2) エンドポイント作成(重みとイメージは準備済み)。InService になると ENDPOINT_NAME を表示します。
PA_SKIP_DOWNLOAD=1 PA_SKIP_UPLOAD=1 PA_SKIP_BUILD=1 AWS_REGION=us-east-2 node deployUitars.mjs
```

最後に表示される `ENDPOINT_NAME=ui-tars-...` を控えます。次に engine へ接続し、execution スタックだけ再デプロイします:

```bash
cd ../../infra
AWS_REGION=us-east-2 npx cdk deploy PlayAgentDev-Execution \
  --require-approval never --exclusively -c uitarsEndpoint=貼り付け_ENDPOINT_NAME
```

> **💲 重要なコスト注意:** UI-TARS は GPU インスタンス(`ml.g6e.xlarge`、約 US$1.86/時)で動作し、**起動中は継続課金**されます。その日のテストが終わったら停止してください:
> ```bash
> node agent/sagemaker/teardownUitars.mjs 貼り付け_ENDPOINT_NAME
> ```
> モデルとイメージは保存されるため、再開は数分です(上記ステップ 2 を skip フラグ付きで再実行し、execution スタックを再デプロイ)。

## ステップ 7 — その値で Web コンソールをビルド

Web アプリはビルド時にこの 4 つの値を埋め込みます。`web/.env.production` を作成します(リポジトリ直下から):

```bash
cd ../web
npm install
cat > .env.production <<'EOF'
VITE_COGNITO_REGION=us-east-2
VITE_COGNITO_USER_POOL_ID=貼り付け_UserPoolId
VITE_COGNITO_CLIENT_ID=貼り付け_UserPoolClientId
VITE_API_URL=貼り付け_ApiUrl
VITE_WS_URL=貼り付け_WsUrl
EOF
```

各 `貼り付け_...` をステップ 5 の対応する Output に置き換え、ビルド:

```bash
npm run build
```

## ステップ 8 — Web コンソールをデプロイ

```bash
cd ../infra
AWS_REGION=us-east-2 npx cdk deploy PlayAgentDev-Frontend --require-approval never
```

アプリの URL(`https://xxxx.cloudfront.net`)を表示して開くと、ログインページが表示されます:

```bash
aws cloudformation describe-stacks --region us-east-2 \
  --stack-name PlayAgentDev-Frontend \
  --query "Stacks[0].Outputs[?contains(OutputKey,'SiteUrl')].OutputValue" --output text
```

## ステップ 9 — 最初の(管理者)ログインを作成

サインアップは意図的に無効です。ユーザーはご自身で作成します。メールとパスワード(8 文字以上、大小英字と数字を含む)を決めます。`tenantId` は顧客ごとのデータを分離します — 会社名など短い文字列で構いません。最初のユーザーを**管理者**にすると、以降はアプリ内の「メンバー管理」ページで他のユーザーを管理できます。

いずれか一つを選びます:

**方法 A — ワンコマンドスクリプト(推奨)。** ユーザー作成・恒久パスワード設定を行い、`--admin` で `admins` グループにも追加します。User Pool は自動解決されます。

```bash
cd agent/sagemaker && npm install
AWS_REGION=us-east-2 node createUser.mjs \
  --email you@example.com --tenant acme --password 'ChangeMe123!' --admin
```

**方法 B — デプロイ時に管理者を作成。** Foundation スタック(または任意のデプロイ)で `-c` を渡すと、CDK が作成し `admins` グループに追加します:

```bash
AWS_REGION=us-east-2 npx cdk deploy PlayAgentDev-Foundation --require-approval never \
  -c adminEmail=you@example.com -c adminPassword='ChangeMe123!' -c adminTenant=acme
```

管理者が一人いれば、他のユーザーはアプリの「メンバー管理」ページで作成できます(ステップ 10 参照)— コマンド不要です。管理者以外にはそのページは表示されません。

<details>
<summary>方法 C — 生の AWS CLI(スクリプト不使用)</summary>

```bash
POOL_ID=貼り付け_UserPoolId    # ステップ 5 より
aws cognito-idp admin-create-user --region us-east-2 --user-pool-id "$POOL_ID" \
  --username you@example.com \
  --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true "Name=custom:tenantId,Value=acme" \
  --message-action SUPPRESS
aws cognito-idp admin-set-user-password --region us-east-2 --user-pool-id "$POOL_ID" \
  --username you@example.com --password 'ChangeMe123!' --permanent
# 管理者にする(「メンバー管理」ページを使うため)
aws cognito-idp admin-add-user-to-group --region us-east-2 --user-pool-id "$POOL_ID" \
  --username you@example.com --group-name admins
```
</details>

## ステップ 10 — ログイン

ステップ 8 の CloudFront URL を開き、ステップ 9 のメール/パスワードでログイン。**最初に表示されるのは「ガイド」ページ** — 全機能を言語別に案内する組み込みウォークスルーです。そこから:

1. **アプリ** — アプリを作成。ネイティブは APK/IPA/ZIP をアップロード、Web は URL のみ。
2. **テストケース** — フローを普通の言葉で記述、AI が実行可能なケースに変換。
3. **タスク** — アプリ + ケース + 実行環境(**Web** または **Device Farm**)を選んで送信。座標モデルは**ステップ 6** で導入した **UI-TARS 1.5 7B** が既定です。ライブ監視可。
4. **レポート** — AI の説明、スクリーンショット、ステップ軌跡、コストを確認。

✅ **これで動作する環境が完成です。**

UI-TARS グラウンディングの仕組みは [docs/design/uitars-sagemaker-grounding.md](docs/design/uitars-sagemaker-grounding.md) を参照。

## コスト分析ページを有効化する

**コスト分析**ページ(「ナレッジ管理」の隣)は 2 つの数値を並べて表示します:

- **AWS 実コスト** —— **AWS Cost Explorer** からリアルタイム取得:実際の請求を、サービス別・`component` タグ別・月別に分解。すべて(SageMaker GPU、Fargate、EC2、CloudFront など)を含みます。
- **タスク推定コスト** —— タスクの token × 単価の推定を合計し、アプリ別・モデル別に集計。インフラを含まないため実請求より低く、基準が異なるので直接引き算しないでください。

推定側はすぐ使えます。実コスト側は **1 回だけのアカウント設定**が必要です(Cost Explorer はアカウントレベルで、CDK では有効化できません):

1. **Cost Explorer を有効化。** AWS コンソールで **Billing and Cost Management → Cost Explorer** を開き有効化します。初回有効化後、約 **24 時間**でデータが出始めます。
2. **コスト配分タグを有効化。** **Billing and Cost Management → Cost allocation tags → User-defined cost allocation tags** で `project`、`stage`、`component`(およびデプロイ時に渡した `costCenter` / `owner` / `team` など)を選び **Activate** します。
3. **翌日に確認。** タグは有効化**後**に発生したコストにのみ適用されます —— 過去分は遡及されず、それまで `component` 別集計はすべて「未タグ」になります。翌日また見てください。

補足:

- Cost Explorer API は `us-east-1` のみ提供。デプロイ先リージョンに関わらず、アプリは同リージョンに固定して問い合わせます。
- クエリごとに AWS が約 **US$0.01** を課金し、データは通常約 24 時間遅延します(リアルタイムではありません)。
- コスト配分タグを有効化できるのはアカウント所有者 / 請求権限を持つ IAM ユーザーのみです。

## Device Farm(実機)について

Web バックエンドは追加設定なしで動作します。実機テストは **AWS Device Farm** を使用し、プロジェクトは **us-west-2** に置かれ、ランナーが自動作成します。デプロイ用の認証情報には Device Farm 権限が含まれるため、手動設定は不要です — タスク送信時に「Device Farm」を選ぶだけです。

---

## コスト・クリーンアップ・トラブルシューティング

**おおよその運用コスト(評価):** サーバーレスのコントロールプレーンは低使用時に月数ドル。テスト実行はトークン課金(1 回あたり数セント〜数ドル、レポートに表示)。最大のコストは **UI-TARS GPU エンドポイント**(`ml.g6e.xlarge`、約 US$1.86/時)—— 稼働中は継続課金されるため、**テストしないときは停止**してください(`node agent/sagemaker/teardownUitars.mjs <エンドポイント名>`)。再開は数分です。

**すべて削除**(スタックを削除。データバケットと Cognito ユーザープールは設計上保持され、データを失いません — 完全に消すには Console から手動削除):

```bash
cd infra
AWS_REGION=us-east-2 npx cdk destroy --all
# UI-TARS を有効化した場合は先にエンドポイントを削除:
node ../agent/sagemaker/teardownUitars.mjs <エンドポイント名>
```

**よくある問題**

| 症状 | 対処 |
| --- | --- |
| デプロイ失敗:*"not bootstrapped"* | ステップ 4(`cdk bootstrap`)を `us-east-2` で実行。 |
| 実行時にモデル関連 / Bedrock *AccessDenied* エラー | モデルアクセスを有効化(ステップ 3)、**us-east-2** で。 |
| ログインページは出るがサインインできない | `web/.env.production` の値が誤り、または編集後に再ビルド+再デプロイしていない(ステップ 6–7)。 |
| サインアップできない | 仕様です — ユーザーは CLI で作成(ステップ 8)。 |
| リージョン違い / リソースが見えない | すべて **us-east-2**。Console 右上のリージョン選択を確認。 |

---

## リポジトリ構成

```
agent/            実行ランナー(Fargate コンテナ内で動作)
  explorationRunner.mjs    Device Farm 実機ランナー(Appium ループ)
  webExplorationRunner.mjs Web ランナー(Playwright headless Chromium)
  imageTools.mjs           VLM 用の smart-resize と着地点アノテーション
  uitarsClient.mjs         UI-TARS(SageMaker)測位クライアント
  apkMerge.mjs             Device Farm 用の XAPK / split-APK マージ
  sagemaker/               UI-TARS デプロイ:vLLM BYOC コンテナ + CodeBuild スクリプト
infra/            AWS CDK アプリ(foundation、control-plane、scheduling、execution、frontend)
web/              React + Vite Web コンソール(5 言語 i18n、自作 SVG)
docs/             アーキテクチャ、設計メモ、リサーチ
```

## 開発者向け

```bash
cd infra && npm test     # CDK・ユニットテスト
cd web   && npm run ci    # check:i18n + 型チェック + テスト + build
```

[CONTRIBUTING.md](CONTRIBUTING.md) と [docs/architecture.md](docs/architecture.md) を参照。

## ライセンス

リポジトリ設定を参照。現状のまま社内評価用に提供されます。
