/**
 * 使用說明頁的 AWS 架構圖資料(可編輯)。
 * 節點/連線/分層都在這裡定義,ArchitectureGraph 只負責渲染。要改架構圖 → 改這個檔。
 *
 * 版面原則(避免連線糾結):
 *  - 主資料流走「中央直線脊椎」由上而下:使用者 → API Gateway → Dispatcher → Engine。
 *  - 不畫「橫向穿過整排節點」的長線;旁支(前端、授權、佇列、資料)只做一小段短連接。
 *  - Engine 下方左右兩欄:左=裝置後端、右=AI 大腦,各以少數短邊連接。
 *  - 每條邊用 fromSide/toSide(+可選 slot)指定進出點,分叉的邊各走一個 slot,不重疊。
 *
 * 誠實原則:status 'ok' = 已端到端驗證;'todo' = 有程式骨架但未端到端驗證。
 */
import { loc5, pick5, type L5 } from '../i18n/locale5.ts';
import type { Locale } from '../i18n/messages.ts';
import { getConfig } from '../config.ts';

export type ArchStatus = 'ok' | 'todo';
export type ArchKind = 'edge' | 'api' | 'compute' | 'msg' | 'device' | 'ai' | 'data' | 'external';
export type Side = 'top' | 'bottom' | 'left' | 'right';
export type Slot = 'a' | 'b' | 'c';

export interface ArchNode {
  id: string;
  layer: string;
  kind: ArchKind;
  title: string;
  sub?: L5;
  status?: ArchStatus;
  col: number;
  row: number;
}

export interface ArchEdge {
  from: string;
  to: string;
  kind: 'flow' | 'async' | 'model' | 'support';
  fromSide?: Side;
  toSide?: Side;
  fromSlot?: Slot;
  toSlot?: Slot;
  label?: L5;
}

export interface ArchLayer {
  id: string;
  title: L5;
  col: number;
  row: number;
  cols: number;
  rows: number;
}

export interface ArchDiagram {
  layers: ArchLayer[];
  nodes: ArchNode[];
  edges: ArchEdge[];
  legend: { ok: string; todo: string; flow: string; async: string; model: string };
  caption: string;
}


/**
 * 版面(嚴格分層,每層之間留一整排空白 row 當「走線通道」,線只在相鄰層垂直移動 → 不穿框)。
 *  row0                     [使用者]col3
 *  row2  [前端]col0-1        [API]col3  [授權]col5-6
 *  row4  [Lambda+佇列]col0..7:WS / API Handler / SQS / Dispatcher(同排相鄰)
 *  row6                     [Engine]col3
 *  row8  [裝置]col0-2   [支援]col3   [AI]col5-7
 *  row10                                 [S3]col6
 */
const NODES: ArchNode[] = [
  { id: 'user', layer: 'ext', kind: 'external', title: 'User', sub: ['使用者 · 瀏覽器 Web Console', 'Browser · Web Console', '用户 · 浏览器 Web Console', 'ユーザー · ブラウザ Web Console', '사용자 · 브라우저 Web Console'], col: 3, row: 0 },

  { id: 'cf', layer: 'edge', kind: 'edge', title: 'CloudFront', sub: ['Amazon CloudFront · CDN', 'Amazon CloudFront · CDN', 'Amazon CloudFront · CDN', 'Amazon CloudFront · CDN', 'Amazon CloudFront · CDN'], col: 0, row: 2 },
  { id: 's3web', layer: 'edge', kind: 'edge', title: 'S3', sub: ['Amazon S3 · 靜態站', 'Amazon S3 · static site', 'Amazon S3 · 静态站', 'Amazon S3 · 静的サイト', 'Amazon S3 · 정적 사이트'], col: 1, row: 2 },
  { id: 'apigw', layer: 'api', kind: 'api', title: 'API Gateway', sub: ['Amazon API Gateway', 'Amazon API Gateway', 'Amazon API Gateway', 'Amazon API Gateway', 'Amazon API Gateway'], col: 3, row: 2 },
  { id: 'cognito', layer: 'api', kind: 'api', title: 'Cognito', sub: ['Amazon Cognito · 登入/JWT', 'Amazon Cognito · JWT', 'Amazon Cognito · 登录/JWT', 'Amazon Cognito · サインイン/JWT', 'Amazon Cognito · 로그인/JWT'], col: 5, row: 2 },
  { id: 'iam', layer: 'api', kind: 'api', title: 'IAM / STS', sub: ['IAM/STS · 租戶隔離', 'IAM/STS · tenant iso', 'IAM/STS · 租户隔离', 'IAM/STS · テナント分離', 'IAM/STS · 테넌트 격리'], col: 6, row: 2 },

  // Lambda + 佇列一整排(row4):WS / API Handler / SQS / Dispatcher 依序,提交鏈=同排相鄰短線
  // 每個 Lambda 框都在副標寫明「AWS Lambda」+ 該函式職責。
  // 提交鏈由左到右一整排:WS / API Handler → SQS → Dispatcher → Engine
  { id: 'lws', layer: 'compute', kind: 'compute', title: 'WS Connect/Auth', sub: ['Lambda · 授權·推送', 'Lambda · auth/push', 'Lambda · 授权·推送', 'Lambda · 認可·プッシュ', 'Lambda · 인증·푸시'], col: 0, row: 4 },
  { id: 'lapi', layer: 'compute', kind: 'compute', title: 'API Handler', sub: ['Lambda · REST 路由', 'Lambda · REST routes', 'Lambda · REST 路由', 'Lambda · REST ルート', 'Lambda · REST 라우트'], col: 2, row: 4 },
  { id: 'sqs', layer: 'compute', kind: 'msg', title: 'SQS', sub: ['Amazon SQS · 派發佇列', 'Amazon SQS · queue', 'Amazon SQS · 派发队列', 'Amazon SQS · ディスパッチキュー', 'Amazon SQS · 디스패치 큐'], col: 4, row: 4 },
  { id: 'ldisp', layer: 'compute', kind: 'compute', title: 'Dispatcher', sub: ['Lambda · SQS 觸發', 'Lambda · SQS trigger', 'Lambda · SQS 触发', 'Lambda · SQS トリガー', 'Lambda · SQS 트리거'], col: 6, row: 4 },
  { id: 'leng', layer: 'compute', kind: 'compute', title: 'Engine', sub: ['Lambda · AI 執行迴圈編排', 'Lambda · AI loop orchestrator', 'Lambda · AI 执行循环编排', 'Lambda · AI 実行ループのオーケストレーション', 'Lambda · AI 실행 루프 오케스트레이션'], col: 8, row: 4 },
  { id: 'eb', layer: 'compute', kind: 'msg', title: 'EventBridge', sub: ['Amazon EventBridge · 即時回推', 'Amazon EventBridge · push', 'Amazon EventBridge · 实时回推', 'Amazon EventBridge · リアルタイムプッシュ', 'Amazon EventBridge · 실시간 푸시'], col: 8, row: 2 },

  // AI 大腦(左欄 col 0-2):三個 Seat + KB。Agent/SubAgent 在 Bedrock;VLM(判座標)可選 Bedrock 通用
  // 視覺模型,或 UI-TARS(GUI grounding,部署在 SageMaker)以取得更準的座標。
  { id: 'vlm', layer: 'ai', kind: 'ai', title: 'VLM', sub: ['Bedrock / UI-TARS · 判座標', 'Bedrock / UI-TARS · locate', 'Bedrock / UI-TARS · 判定坐标', 'Bedrock / UI-TARS · 座標判定', 'Bedrock / UI-TARS · 좌표 판단'], status: 'ok', col: 0, row: 8 },
  { id: 'agent', layer: 'ai', kind: 'ai', title: 'Agent', sub: ['Bedrock · 主決策', 'Bedrock · decide', 'Bedrock · 主决策', 'Bedrock · メイン判断', 'Bedrock · 주 의사결정'], status: 'ok', col: 1, row: 8 },
  { id: 'sub', layer: 'ai', kind: 'ai', title: 'SubAgent', sub: ['Bedrock · 子任務', 'Bedrock · subtask', 'Bedrock · 子任务', 'Bedrock · サブタスク', 'Bedrock · 하위 작업'], status: 'ok', col: 2, row: 8 },
  { id: 'uitars', layer: 'ai', kind: 'ai', title: 'UI-TARS', sub: ['SageMaker · 選用,預設關閉', 'SageMaker · optional, off by default', 'SageMaker · 选用,默认关闭', 'SageMaker · 任意、デフォルトはオフ', 'SageMaker · 선택 사항, 기본 꺼짐'], status: 'ok', col: 0, row: 9 },
  { id: 'kb', layer: 'ai', kind: 'ai', title: 'Knowledge Base', sub: ['Bedrock KB · Titan+S3 Vectors', 'Bedrock KB · Titan+S3 Vectors', 'Bedrock KB · Titan+S3 Vectors', 'Bedrock KB · Titan+S3 Vectors', 'Bedrock KB · Titan+S3 Vectors'], status: 'ok', col: 2, row: 9 },
  { id: 'data', layer: 'data', kind: 'data', title: 'S3', sub: ['Amazon S3 · 截圖·軌跡·報告', 'Amazon S3 · shots·trace·report', 'Amazon S3 · 截图·轨迹·报告', 'Amazon S3 · スクリーンショット·軌跡·レポート', 'Amazon S3 · 스크린샷·궤적·리포트'], col: 1, row: 10 },

  // 裝置後端(右欄 col 5-7):Web(Playwright)與 Device Farm 實機皆走 ECS Fargate,已端到端驗證。
  { id: 'df', layer: 'device', kind: 'device', title: 'Device Farm', sub: ['Fargate+Appium · 實機', 'Fargate+Appium · real device', 'Fargate+Appium · 真机', 'Fargate+Appium · 実機', 'Fargate+Appium · 실기기'], status: 'ok', col: 5, row: 8 },
  { id: 'web', layer: 'device', kind: 'device', title: 'Web', sub: ['Fargate · Playwright Chromium', 'Fargate · Playwright Chromium', 'Fargate · Playwright Chromium', 'Fargate · Playwright Chromium', 'Fargate · Playwright Chromium'], status: 'ok', col: 6, row: 8 },
  { id: 'redroid', layer: 'device', kind: 'device', title: 'Android Redroid', sub: ['EC2 Graviton · 容器', 'EC2 Graviton · container', 'EC2 Graviton · 容器', 'EC2 Graviton · コンテナ', 'EC2 Graviton · 컨테이너'], status: 'ok', col: 7, row: 8 },
  { id: 'win', layer: 'device', kind: 'device', title: 'Windows', sub: ['GameLift Streams · GPU(選用)', 'GameLift Streams · GPU (optional)', 'GameLift Streams · GPU(选用)', 'GameLift Streams · GPU(任意)', 'GameLift Streams · GPU(선택)'], status: 'ok', col: 5, row: 9 },
  { id: 'att', layer: 'device', kind: 'device', title: 'Attached', sub: ['本地裝置 + 輕量代理', 'local device + agent', '本地设备 + 轻量代理', 'ローカルデバイス + 軽量エージェント', '로컬 디바이스 + 경량 에이전트'], status: 'todo', col: 6, row: 9 },

  // 支援:放在裝置下方,留一整排空 row(row10)當走線通道,支援層在 row11(與裝置層不重疊)。
  { id: 'ssm', layer: 'support', kind: 'api', title: 'SSM', sub: ['SSM Parameter Store · AMI', 'SSM Parameter Store · AMI', 'SSM Parameter Store · AMI', 'SSM Parameter Store · AMI', 'SSM Parameter Store · AMI'], col: 6, row: 11 },
  { id: 'sm', layer: 'support', kind: 'api', title: 'Secrets Manager', sub: ['AWS Secrets Manager', 'AWS Secrets Manager', 'AWS Secrets Manager', 'AWS Secrets Manager', 'AWS Secrets Manager'], col: 7, row: 11 },
];

/**
 * 連線:一律「本層底(bottom)→ 下一層頂(top)」的短垂直線,或同排相鄰的左右短線。
 * 每兩層之間都有一整排空 row,垂直線不會經過任何其他框。分叉用 slot 散開。
 */
const EDGES: ArchEdge[] = [
  // 使用者只載入前端(CloudFront);前端 SPA(S3 靜態站)才去呼叫 API Gateway。
  { from: 'user', to: 'cf', kind: 'flow', fromSide: 'bottom', toSide: 'top', label: ['載入前端', 'load app', '加载前端', 'フロントエンドを読み込み', '프런트엔드 로드'] },
  { from: 'cf', to: 's3web', kind: 'flow', fromSide: 'right', toSide: 'left' },
  { from: 's3web', to: 'apigw', kind: 'flow', fromSide: 'right', toSide: 'left', label: ['SPA 呼叫 API', 'SPA calls API', 'SPA 调用 API', 'SPA が API を呼び出し', 'SPA가 API 호출'] },
  { from: 'cognito', to: 'apigw', kind: 'support', fromSide: 'left', toSide: 'right', label: ['授權', 'authz', '授权', '認可', '인증'] },
  // API Gateway → 一條線指向「Lambda + 佇列」群組框(進頂部左側,短垂直線,不繞左邊、不碰前端 Edge 框)。
  { from: 'apigw', to: 'grp-compute', kind: 'flow', fromSide: 'bottom', fromSlot: 'a', toSide: 'top', toSlot: 'a' },
  // 提交鏈(同排相鄰左→右短線):API Handler → SQS → Dispatcher → Engine
  { from: 'lapi', to: 'sqs', kind: 'async', fromSide: 'right', toSide: 'left', label: ['入列', 'enqueue', '入队', 'エンキュー', '큐에 추가'] },
  { from: 'sqs', to: 'ldisp', kind: 'async', fromSide: 'right', toSide: 'left' },
  { from: 'ldisp', to: 'leng', kind: 'flow', fromSide: 'right', toSide: 'left', label: ['觸發', 'trigger', '触发', 'トリガー', '트리거'] },
  // Engine → 裝置:一條線接到整個「裝置後端」群組框的右邊。
  { from: 'leng', to: 'grp-device', kind: 'flow', fromSide: 'bottom', fromSlot: 'c', toSide: 'right', label: ['驅動裝置', 'drive', '驱动设备', 'デバイスを駆動', '디바이스 구동'] },
  // 呼叫模型:一條線指向整個「AI 大腦 · Bedrock」群組框(不再分三條到各 Seat)。
  { from: 'leng', to: 'grp-ai', kind: 'model', fromSide: 'bottom', toSide: 'top', label: ['呼叫模型', 'invoke', '调用模型', 'モデル呼び出し', '모델 호출'] },
  // AI 內部:VLM 判座標可改用 SageMaker 上的 UI-TARS(GUI grounding);Agent → KB → S3。
  { from: 'vlm', to: 'uitars', kind: 'model', fromSide: 'bottom', toSide: 'top', label: ['可選', 'optional', '可选', '任意', '선택'] },
  { from: 'agent', to: 'kb', kind: 'model', fromSide: 'bottom', toSide: 'top' },
  { from: 'kb', to: 'data', kind: 'flow', fromSide: 'bottom', toSide: 'top' },
  // 支援:SSM(AMI)/ Secrets(登入)各一條線往上接到整個「裝置後端」群組框的底部(不接個別節點)。
  { from: 'ssm', to: 'grp-device', kind: 'support', fromSide: 'top', toSide: 'bottom', toSlot: 'a', label: ['AMI', 'AMI', 'AMI', 'AMI', 'AMI'] },
  { from: 'sm', to: 'grp-device', kind: 'support', fromSide: 'top', toSide: 'bottom', toSlot: 'c', label: ['登入', 'login', '登录', 'ログイン', '로그인'] },
  // 被測身分:Engine 以 Cognito 帶入的租戶身分,只讀本租戶(playagent/tenant/<t>/)的 Secrets;
  // 再由引擎注入裝置 session。Secrets Manager 在最右端(col7),線走最右外圍往下接其右側,不穿框。
  { from: 'leng', to: 'sm', kind: 'support', fromSide: 'right', toSide: 'right', label: ['租戶機密', 'tenant secret', '租户机密', 'テナントのシークレット', '테넌트 시크릿'] },
  // 登入身分:Cognito 帶入的登入資訊(租戶身分)最終傳到後端引擎。
  { from: 'cognito', to: 'leng', kind: 'support', fromSide: 'bottom', toSide: 'top', toSlot: 'a', label: ['登入身分', 'identity', '登录身份', 'サインイン ID', '로그인 ID'] },
  // 即時串流回推:Engine 把狀態/軌跡吐到 EventBridge,再經 WebSocket 推回前端 User。走 top 右側 slot,與登入身分分開。
  { from: 'leng', to: 'eb', kind: 'async', fromSide: 'top', fromSlot: 'c', toSide: 'bottom', label: ['狀態回吐', 'status', '状态回吐', 'ステータス送出', '상태 전송'] },
  { from: 'eb', to: 'user', kind: 'async', fromSide: 'top', toSide: 'right', label: ['即時回推', 'live push', '实时回推', 'リアルタイムプッシュ', '실시간 푸시'] },
];

const LAYERS: ArchLayer[] = [
  { id: 'edge', title: ['前端 Edge', 'Frontend Edge', '前端 Edge', 'フロントエンド Edge', '프런트엔드 Edge'], col: 0, row: 2, cols: 2, rows: 1 },
  { id: 'api', title: ['API / 授權', 'API / Auth', 'API / 授权', 'API / 認可', 'API / 인증'], col: 3, row: 2, cols: 4, rows: 1 },
  { id: 'compute', title: ['Lambda(serverless 大腦) + 佇列', 'Lambda (serverless brain) + queue', 'Lambda(serverless 大脑) + 队列', 'Lambda(サーバーレスの頭脳)+ キュー', 'Lambda(서버리스 두뇌) + 큐'], col: 0, row: 4, cols: 9, rows: 1 },
  { id: 'ai', title: ['AI 大腦 · Bedrock', 'AI brain · Bedrock', 'AI 大脑 · Bedrock', 'AI の頭脳 · Bedrock', 'AI 두뇌 · Bedrock'], col: 0, row: 8, cols: 3, rows: 2 },
  { id: 'device', title: ['裝置後端', 'Device backends', '设备后端', 'デバイスバックエンド', '디바이스 백엔드'], col: 5, row: 8, cols: 3, rows: 2 },
  { id: 'support', title: ['支援', 'Support', '支持', 'サポート', '지원'], col: 6, row: 11, cols: 2, rows: 1 },
];

export function architectureDiagram(locale: Locale): ArchDiagram {
  const lc = loc5(locale);
  return {
    layers: LAYERS,
    nodes: NODES,
    edges: EDGES,
    legend: {
      ok: pick5(['已端到端驗證', 'Verified end-to-end', '已端到端验证', 'エンドツーエンドで検証済み', '엔드투엔드 검증 완료'], lc),
      todo: pick5(['骨架(未驗證)', 'Scaffolded (not verified)', '骨架(未验证)', '骨組みのみ(未検証)', '골격만 구현(미검증)'], lc),
      flow: pick5(['同步資料流', 'Sync flow', '同步数据流', '同期フロー', '동기 데이터 흐름'], lc),
      async: pick5(['非同步 / 回推', 'Async / push', '异步 / 回推', '非同期 / プッシュ', '비동기 / 푸시'], lc),
      model: pick5(['呼叫模型 / 檢索', 'Model call / retrieve', '调用模型 / 检索', 'モデル呼び出し / 検索', '모델 호출 / 검색'], lc),
    },
    // 部署區域可自訂(預設 us-west-2):顯示實際部署的區域,不寫死。
    caption: `Region ${getConfig().cognitoRegion || 'us-west-2'}`,
  };
}
