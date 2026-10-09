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
import type { Locale } from '../i18n/messages.ts';

export type ArchStatus = 'ok' | 'todo';
export type ArchKind = 'edge' | 'api' | 'compute' | 'msg' | 'device' | 'ai' | 'data' | 'external';
export type Side = 'top' | 'bottom' | 'left' | 'right';
export type Slot = 'a' | 'b' | 'c';

export interface ArchNode {
  id: string;
  layer: string;
  kind: ArchKind;
  title: string;
  sub?: { 'zh-Hant': string; en: string };
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
  label?: { 'zh-Hant': string; en: string };
}

export interface ArchLayer {
  id: string;
  title: { 'zh-Hant': string; en: string };
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

const L = (zh: string, en: string) => ({ 'zh-Hant': zh, en });

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
  { id: 'user', layer: 'ext', kind: 'external', title: 'User', sub: L('使用者 · 瀏覽器 Web Console', 'Browser · Web Console'), col: 3, row: 0 },

  { id: 'cf', layer: 'edge', kind: 'edge', title: 'CloudFront', sub: L('Amazon CloudFront · CDN', 'Amazon CloudFront · CDN'), col: 0, row: 2 },
  { id: 's3web', layer: 'edge', kind: 'edge', title: 'S3', sub: L('Amazon S3 · 靜態站', 'Amazon S3 · static site'), col: 1, row: 2 },
  { id: 'apigw', layer: 'api', kind: 'api', title: 'API Gateway', sub: L('Amazon API Gateway', 'Amazon API Gateway'), col: 3, row: 2 },
  { id: 'cognito', layer: 'api', kind: 'api', title: 'Cognito', sub: L('Amazon Cognito · 登入/JWT', 'Amazon Cognito · JWT'), col: 5, row: 2 },
  { id: 'iam', layer: 'api', kind: 'api', title: 'IAM / STS', sub: L('IAM/STS · 租戶隔離', 'IAM/STS · tenant iso'), col: 6, row: 2 },

  // Lambda + 佇列一整排(row4):WS / API Handler / SQS / Dispatcher 依序,提交鏈=同排相鄰短線
  // 每個 Lambda 框都在副標寫明「AWS Lambda」+ 該函式職責。
  // 提交鏈由左到右一整排:WS / API Handler → SQS → Dispatcher → Engine
  { id: 'lws', layer: 'compute', kind: 'compute', title: 'WS Connect/Auth', sub: L('Lambda · 授權·推送', 'Lambda · auth/push'), col: 0, row: 4 },
  { id: 'lapi', layer: 'compute', kind: 'compute', title: 'API Handler', sub: L('Lambda · REST 路由', 'Lambda · REST routes'), col: 2, row: 4 },
  { id: 'sqs', layer: 'compute', kind: 'msg', title: 'SQS', sub: L('Amazon SQS · 派發佇列', 'Amazon SQS · queue'), col: 4, row: 4 },
  { id: 'ldisp', layer: 'compute', kind: 'compute', title: 'Dispatcher', sub: L('Lambda · SQS 觸發', 'Lambda · SQS trigger'), col: 6, row: 4 },
  { id: 'leng', layer: 'compute', kind: 'compute', title: 'Engine', sub: L('Lambda · AI 執行迴圈編排', 'Lambda · AI loop orchestrator'), col: 8, row: 4 },
  { id: 'eb', layer: 'compute', kind: 'msg', title: 'EventBridge', sub: L('Amazon EventBridge · 即時回推', 'Amazon EventBridge · push'), col: 8, row: 2 },

  // AI 大腦(左欄 col 0-2):三個 Seat + KB。Agent/SubAgent 在 Bedrock;VLM(判座標)可選 Bedrock 通用
  // 視覺模型,或 UI-TARS(GUI grounding,部署在 SageMaker)以取得更準的座標。
  { id: 'vlm', layer: 'ai', kind: 'ai', title: 'VLM', sub: L('Bedrock / UI-TARS · 判座標', 'Bedrock / UI-TARS · locate'), status: 'ok', col: 0, row: 8 },
  { id: 'agent', layer: 'ai', kind: 'ai', title: 'Agent', sub: L('Bedrock · 主決策', 'Bedrock · decide'), status: 'ok', col: 1, row: 8 },
  { id: 'sub', layer: 'ai', kind: 'ai', title: 'SubAgent', sub: L('Bedrock · 子任務', 'Bedrock · subtask'), status: 'ok', col: 2, row: 8 },
  { id: 'uitars', layer: 'ai', kind: 'ai', title: 'UI-TARS', sub: L('SageMaker · 選用,預設關閉', 'SageMaker · optional, off by default'), status: 'ok', col: 0, row: 9 },
  { id: 'kb', layer: 'ai', kind: 'ai', title: 'Knowledge Base', sub: L('Bedrock KB · Titan+S3 Vectors', 'Bedrock KB · Titan+S3 Vectors'), status: 'ok', col: 2, row: 9 },
  { id: 'data', layer: 'data', kind: 'data', title: 'S3', sub: L('Amazon S3 · 截圖·軌跡·報告', 'Amazon S3 · shots·trace·report'), col: 1, row: 10 },

  // 裝置後端(右欄 col 5-7):Web(Playwright)與 Device Farm 實機皆走 ECS Fargate,已端到端驗證。
  { id: 'df', layer: 'device', kind: 'device', title: 'Device Farm', sub: L('Fargate+Appium · 實機', 'Fargate+Appium · real device'), status: 'ok', col: 5, row: 8 },
  { id: 'web', layer: 'device', kind: 'device', title: 'Web', sub: L('Fargate · Playwright Chromium', 'Fargate · Playwright Chromium'), status: 'ok', col: 6, row: 8 },
  { id: 'redroid', layer: 'device', kind: 'device', title: 'Android Redroid', sub: L('EC2 Graviton · 容器', 'EC2 Graviton · container'), status: 'ok', col: 7, row: 8 },
  { id: 'win', layer: 'device', kind: 'device', title: 'Windows', sub: L('GameLift Streams · GPU(選用)', 'GameLift Streams · GPU (optional)'), status: 'ok', col: 5, row: 9 },
  { id: 'att', layer: 'device', kind: 'device', title: 'Attached', sub: L('本地裝置 + 輕量代理', 'local device + agent'), status: 'todo', col: 6, row: 9 },

  // 支援:放在裝置下方,留一整排空 row(row10)當走線通道,支援層在 row11(與裝置層不重疊)。
  { id: 'ssm', layer: 'support', kind: 'api', title: 'SSM', sub: L('SSM Parameter Store · AMI', 'SSM Parameter Store · AMI'), col: 6, row: 11 },
  { id: 'sm', layer: 'support', kind: 'api', title: 'Secrets Manager', sub: L('AWS Secrets Manager', 'AWS Secrets Manager'), col: 7, row: 11 },
];

/**
 * 連線:一律「本層底(bottom)→ 下一層頂(top)」的短垂直線,或同排相鄰的左右短線。
 * 每兩層之間都有一整排空 row,垂直線不會經過任何其他框。分叉用 slot 散開。
 */
const EDGES: ArchEdge[] = [
  // 使用者只載入前端(CloudFront);前端 SPA(S3 靜態站)才去呼叫 API Gateway。
  { from: 'user', to: 'cf', kind: 'flow', fromSide: 'bottom', toSide: 'top', label: L('載入前端', 'load app') },
  { from: 'cf', to: 's3web', kind: 'flow', fromSide: 'right', toSide: 'left' },
  { from: 's3web', to: 'apigw', kind: 'flow', fromSide: 'right', toSide: 'left', label: L('SPA 呼叫 API', 'SPA calls API') },
  { from: 'cognito', to: 'apigw', kind: 'support', fromSide: 'left', toSide: 'right', label: L('授權', 'authz') },
  // API Gateway → 一條線指向「Lambda + 佇列」群組框(進頂部左側,短垂直線,不繞左邊、不碰前端 Edge 框)。
  { from: 'apigw', to: 'grp-compute', kind: 'flow', fromSide: 'bottom', fromSlot: 'a', toSide: 'top', toSlot: 'a' },
  // 提交鏈(同排相鄰左→右短線):API Handler → SQS → Dispatcher → Engine
  { from: 'lapi', to: 'sqs', kind: 'async', fromSide: 'right', toSide: 'left', label: L('入列', 'enqueue') },
  { from: 'sqs', to: 'ldisp', kind: 'async', fromSide: 'right', toSide: 'left' },
  { from: 'ldisp', to: 'leng', kind: 'flow', fromSide: 'right', toSide: 'left', label: L('觸發', 'trigger') },
  // Engine → 裝置:一條線接到整個「裝置後端」群組框的右邊。
  { from: 'leng', to: 'grp-device', kind: 'flow', fromSide: 'bottom', fromSlot: 'c', toSide: 'right', label: L('驅動裝置', 'drive') },
  // 呼叫模型:一條線指向整個「AI 大腦 · Bedrock」群組框(不再分三條到各 Seat)。
  { from: 'leng', to: 'grp-ai', kind: 'model', fromSide: 'bottom', toSide: 'top', label: L('呼叫模型', 'invoke') },
  // AI 內部:VLM 判座標可改用 SageMaker 上的 UI-TARS(GUI grounding);Agent → KB → S3。
  { from: 'vlm', to: 'uitars', kind: 'model', fromSide: 'bottom', toSide: 'top', label: L('可選', 'optional') },
  { from: 'agent', to: 'kb', kind: 'model', fromSide: 'bottom', toSide: 'top' },
  { from: 'kb', to: 'data', kind: 'flow', fromSide: 'bottom', toSide: 'top' },
  // 支援:SSM(AMI)/ Secrets(登入)各一條線往上接到整個「裝置後端」群組框的底部(不接個別節點)。
  { from: 'ssm', to: 'grp-device', kind: 'support', fromSide: 'top', toSide: 'bottom', toSlot: 'a', label: L('AMI', 'AMI') },
  { from: 'sm', to: 'grp-device', kind: 'support', fromSide: 'top', toSide: 'bottom', toSlot: 'c', label: L('登入', 'login') },
  // 被測身分:Engine 以 Cognito 帶入的租戶身分,只讀本租戶(playagent/tenant/<t>/)的 Secrets;
  // 再由引擎注入裝置 session。Secrets Manager 在最右端(col7),線走最右外圍往下接其右側,不穿框。
  { from: 'leng', to: 'sm', kind: 'support', fromSide: 'right', toSide: 'right', label: L('租戶機密', 'tenant secret') },
  // 登入身分:Cognito 帶入的登入資訊(租戶身分)最終傳到後端引擎。
  { from: 'cognito', to: 'leng', kind: 'support', fromSide: 'bottom', toSide: 'top', toSlot: 'a', label: L('登入身分', 'identity') },
  // 即時串流回推:Engine 把狀態/軌跡吐到 EventBridge,再經 WebSocket 推回前端 User。走 top 右側 slot,與登入身分分開。
  { from: 'leng', to: 'eb', kind: 'async', fromSide: 'top', fromSlot: 'c', toSide: 'bottom', label: L('狀態回吐', 'status') },
  { from: 'eb', to: 'user', kind: 'async', fromSide: 'top', toSide: 'right', label: L('即時回推', 'live push') },
];

const LAYERS: ArchLayer[] = [
  { id: 'edge', title: L('前端 Edge', 'Frontend Edge'), col: 0, row: 2, cols: 2, rows: 1 },
  { id: 'api', title: L('API / 授權', 'API / Auth'), col: 3, row: 2, cols: 4, rows: 1 },
  { id: 'compute', title: L('Lambda(serverless 大腦) + 佇列', 'Lambda (serverless brain) + queue'), col: 0, row: 4, cols: 9, rows: 1 },
  { id: 'ai', title: L('AI 大腦 · Bedrock', 'AI brain · Bedrock'), col: 0, row: 8, cols: 3, rows: 2 },
  { id: 'device', title: L('裝置後端', 'Device backends'), col: 5, row: 8, cols: 3, rows: 2 },
  { id: 'support', title: L('支援', 'Support'), col: 6, row: 11, cols: 2, rows: 1 },
];

export function architectureDiagram(locale: Locale): ArchDiagram {
  const t = locale === 'en' ? 'en' : 'zh-Hant';
  return {
    layers: LAYERS,
    nodes: NODES,
    edges: EDGES,
    legend:
      t === 'en'
        ? { ok: 'Verified end-to-end', todo: 'Scaffolded (not verified)', flow: 'Sync flow', async: 'Async / push', model: 'Model call / retrieve' }
        : { ok: '已端到端驗證', todo: '骨架(未驗證)', flow: '同步資料流', async: '非同步 / 回推', model: '呼叫模型 / 檢索' },
    caption: t === 'en' ? 'Region us-east-2' : 'Region us-east-2',
  };
}
