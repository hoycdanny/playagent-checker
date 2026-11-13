import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet } from '../api/client.ts';
import { useQuery } from '../api/useQuery.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import type { MessageKey } from '../i18n/messages.ts';
import { modelLabel } from '../components/modelProvider.ts';
import AppBadge, { useAppLookup } from '../components/AppRef.tsx';
import { SERIES_COLORS, StackedBarChart, type StackSeries } from '../components/charts/StackedBarChart.tsx';
import { reportLang, type RLang } from '../components/report/reportText.ts';
import { pick5 } from '../i18n/locale5.ts';
import './ListPage.css';
import './CostPage.css';

interface CostBucket { key: string; amountUsd: number }
interface MonthlyCost { month: string; amountUsd: number }
interface RealCost {
  available: boolean;
  start: string;
  end: string;
  currency: string;
  totalUsd: number;
  byService: CostBucket[];
  byComponent: CostBucket[];
  byMonth: MonthlyCost[];
  byDay?: Array<{ date: string; totalUsd: number; byService: Record<string, number> }>;
  byUsageType?: Array<{ service: string; usageType: string; quantity: number; unit: string; amountUsd: number }>;
  projectFilter?: { key: string; value: string };
  includedServices?: string[];
  /** Amazon Bedrock 帳單(部署區域、整個帳號;不算進 totalUsd,只供對照)。 */
  bedrock?: { region: string; totalUsd: number; byUsageType: Array<{ usageType: string; quantity: number; unit: string; amountUsd: number }> };
  note?: string;
}
interface EstimatedCost {
  totalUsd: number;
  taskCount: number;
  pricedTaskCount: number;
  byApp: CostBucket[];
  byModel: CostBucket[];
  byMonth: MonthlyCost[];
}
/** 逐筆測試的花費明細(/cost 的 daily.tasks)。 */
interface TaskCostRow {
  jobId: string;
  appId: string;
  caseId: string;
  caseName?: string;
  createdAt: string;
  state: string;
  backend: string;
  model?: string;
  steps?: number;
  tokensIn?: number;
  tokensOut?: number;
  tokensBySeat?: Partial<Record<'agent' | 'vlm' | 'subagent', { input?: number; output?: number }>>;
  modelUsd: number;
  deviceUsd: number;
  deviceMinutes: number;
  totalUsd: number;
  estimated?: boolean;
}

interface DailyCost {
  from: string;
  to: string;
  days: Array<{ date: string; totalUsd: number; modelUsd: number; deviceUsd: number; runs: number; byApp: Record<string, number> }>;
  tasks?: TaskCostRow[];
  byApp: Array<{ appId: string; totalUsd: number; modelUsd: number; deviceUsd: number; deviceMinutes: number; runs: number }>;
  totals: { totalUsd: number; modelUsd: number; deviceUsd: number; deviceMinutes: number; runs: number };
  deviceDataAvailable: boolean;
  unattributed?: { deviceUsd: number; deviceMinutes: number; sessions: number };
  pricing: { deviceFarmUsdPerMinute: number };
}
interface CostResponse { real: RealCost; estimated: EstimatedCost; daily?: DailyCost }

const T = {
  intro: [
    '依天、依測試的應用統計測試花費。每次測試的費用 = AI 模型費用(token × 單價)+ Device Farm 真機實際計量分鐘 × US$0.17。',
    'Testing spend by day and by app under test. Each run = AI model cost (tokens × price) + Device Farm metered device minutes × US$0.17.', '依天、依测试的应用统计测试花费。每次测试的费用 = AI 模型费用(token × 单价)+ Device Farm 真机实际计量分钟 × US$0.17。', '日別・テスト対象アプリ別のテスト費用を集計します。1 回のテストの費用 = AI モデル費用(トークン × 単価)+ Device Farm 実機の実測分数 × US$0.17。', '일별·테스트 대상 앱별 테스트 비용을 집계합니다. 한 번의 테스트 비용 = AI 모델 비용(토큰 × 단가) + Device Farm 실제 기기의 실측 분 × US$0.17.',
  ],
  tabTest: ['測試費用(依應用)', 'Testing cost (by app)', '测试费用(依应用)', 'テスト費用(アプリ別)', '테스트 비용(앱별)'],
  tabReal: ['AWS 帳單(實際)', 'AWS bill (actual)', 'AWS 账单(实际)', 'AWS 請求(実績)', 'AWS 청구(실제)'],
  range: ['區間', 'Range', '区间', '期間', '기간'],
  days: ['近 {n} 天', 'Last {n} days', '近 {n} 天', '過去 {n} 日', '최근 {n}일'],
  app: ['應用', 'App', '应用', 'アプリ', '앱'],
  allApps: ['全部應用', 'All apps', '全部应用', 'すべてのアプリ', '모든 앱'],
  total: ['區間總費用', 'Total in range', '区间总费用', '期間合計', '기간 합계'],
  model: ['AI 模型', 'AI models', 'AI 模型', 'AI モデル', 'AI 모델'],
  device: ['真機(Device Farm)', 'Real devices (Device Farm)', '真机(Device Farm)', '実機(Device Farm)', '실제 기기(Device Farm)'],
  runs: ['測試次數', 'Runs', '测试次数', 'テスト回数', '테스트 횟수'],
  perRun: ['平均每次', 'Avg per run', '平均每次', '1 回あたり平均', '회당 평균'],
  minutes: ['{n} 分鐘', '{n} min', '{n} 分钟', '{n} 分', '{n}분'],
  dailyTitle: ['每日費用(依應用堆疊)', 'Daily cost (stacked by app)', '每日费用(依应用堆栈)', '日別費用(アプリ別の積み上げ)', '일별 비용(앱별 누적)'],
  dailyComp: ['每日費用(模型 vs 真機)', 'Daily cost (models vs devices)', '每日费用(模型 vs 真机)', '日別費用(モデル vs 実機)', '일별 비용(모델 vs 실제 기기)'],
  byStack: ['堆疊方式', 'Stack by', '堆栈方式', '積み上げ方法', '누적 기준'],
  stackApp: ['應用', 'App', '应用', 'アプリ', '앱'],
  stackComp: ['費用類型', 'Cost type', '费用类型', '費用の種類', '비용 유형'],
  byAppTitle: ['各應用費用', 'Cost by app', '各应用费用', 'アプリ別費用', '앱별 비용'],
  colApp: ['應用', 'App', '应用', 'アプリ', '앱'],
  colRuns: ['次數', 'Runs', '次数', '回数', '횟수'],
  colMinutes: ['真機分鐘', 'Device min', '真机分钟', '実機の分数', '기기 사용 분'],
  colModel: ['模型費用', 'Model', '模型费用', 'モデル費用', '모델 비용'],
  colDevice: ['真機費用', 'Device', '真机费用', '実機費用', '기기 비용'],
  colTotal: ['總計', 'Total', '总计', '合計', '합계'],
  colShare: ['占比', 'Share', '占比', '割合', '비중'],
  colAvg: ['平均每次', 'Avg / run', '平均每次', '1 回あたり平均', '회당 평균'],
  byModelTitle: ['模型費用(依模型,全部期間)', 'Model cost by model (all time)', '模型费用(依模型,全部期间)', 'モデル別のモデル費用(全期間)', '모델별 모델 비용(전체 기간)'],
  dayTable: ['每日明細', 'Daily breakdown', '每日明细', '日別の内訳', '일별 내역'],
  colDate: ['日期', 'Date', '日期', '日付', '날짜'],
  noData: ['此區間沒有測試費用。', 'No testing cost in this range.', '此区间没有测试费用。', 'この期間にテスト費用はありません。', '이 기간에는 테스트 비용이 없습니다.'],
  taskTable: ['每次測試明細', 'Per-run breakdown', '每次测试明细', 'テストごとの内訳', '테스트별 내역'],
  taskHint: [
    '每一列是一次測試。token 是該次執行三個 AI 座位的實際用量(報告記錄);步數 ≈ 分析畫面的模型呼叫次數(每步一次)。',
    'One row per run. Tokens are the actual usage of the three AI seats recorded in the report; steps ≈ the number of screen-analysis model calls (one per step).', '每一列是一次测试。token 是该次运行三个 AI 座位的实际用量(报告记录);步数 ≈ 分析画面的模型调用次数(每步一次)。', '1 行が 1 回のテストです。トークンはその実行で 3 つの AI 枠が実際に使用した量(レポートの記録)で、ステップ数 ≈ 画面分析のモデル呼び出し回数(1 ステップにつき 1 回)です。', '한 행이 테스트 한 번입니다. 토큰은 해당 실행에서 AI 3개 좌석이 실제로 사용한 양(보고서 기록)이며, 단계 수 ≈ 화면 분석 모델 호출 횟수(단계당 1회)입니다.',
  ],
  colTime: ['時間', 'Time', '时间', '時刻', '시간'],
  colCase: ['案例', 'Case', '用例', 'ケース', '케이스'],
  colBackend: ['環境', 'Runtime', '环境', '環境', '환경'],
  colSteps: ['步數', 'Steps', '步数', 'ステップ数', '단계 수'],
  colTokIn: ['輸入 token', 'Input tokens', '输入 token', '入力トークン', '입력 토큰'],
  colTokOut: ['輸出 token', 'Output tokens', '输出 token', '出力トークン', '출력 토큰'],
  colSeatTokens: ['各座位 token', 'Tokens by seat', '各座位 token', '枠別トークン', '좌석별 토큰'],
  showAll: ['顯示全部 {n} 筆', 'Show all {n}', '显示全部 {n} 笔', '全 {n} 件を表示', '전체 {n}건 보기'],
  showLess: ['只顯示前 {n} 筆', 'Show first {n}', '只显示前 {n} 笔', '先頭 {n} 件のみ表示', '처음 {n}건만 보기'],
  estTag: ['估', 'est.', '估', '推定', '추정'],
  usageTable: ['用量明細(依服務 × 用量類型)', 'Usage detail (service × usage type)', '用量明细(依服务 × 用量类型)', '使用量の内訳(サービス × 使用タイプ)', '사용량 내역(서비스 × 사용 유형)'],
  usageHint: [
    '數量是 AWS 自己的計量值,不是我們記的:例如 Requests-Tier1 = S3 寫入次數、Lambda-GB-Second = 執行時間、InputTokenCount = 送進模型的 token。免費額度內的項目金額會是 $0,但數量看得到。',
    'Quantities come from AWS metering, not from our own counters: e.g. Requests-Tier1 = S3 writes, Lambda-GB-Second = execution time, InputTokenCount = tokens sent to the model. Items inside the free tier cost $0 but still show their quantity.', '数量是 AWS 自己的计量值,不是我们记的:例如 Requests-Tier1 = S3 写入次数、Lambda-GB-Second = 运行时间、InputTokenCount = 送进模型的 token。免费额度内的项目金额会是 $0,但数量看得到。', '数量は当社の集計ではなく AWS 自身の計測値です。例:Requests-Tier1 = S3 書き込み回数、Lambda-GB-Second = 実行時間、InputTokenCount = モデルに送ったトークン数。無料枠内の項目は金額が $0 ですが、数量は確認できます。', '수량은 당사가 집계한 것이 아니라 AWS 자체의 계량값입니다. 예: Requests-Tier1 = S3 쓰기 횟수, Lambda-GB-Second = 실행 시간, InputTokenCount = 모델에 보낸 토큰 수. 프리 티어 내 항목은 금액이 $0이지만 수량은 확인할 수 있습니다.',
  ],
  colService: ['服務', 'Service', '服务', 'サービス', '서비스'],
  colUsageType: ['用量類型', 'Usage type', '用量类型', '使用タイプ', '사용 유형'],
  colQty: ['數量', 'Quantity', '数量', '数量', '수량'],
  colUnit: ['單位', 'Unit', '单位', '単位', '단위'],
  method: [
    '計算方式:模型費用以每次任務的 token 用量 × 官方單價估算;真機費用取 Device Farm 每個 session 的實際計量分鐘(session 由任務建立,名稱帶任務編號),× US$0.17/分鐘。日期以台北時間、任務建立時間為準。不含 Fargate、S3、API 等基礎設施(見「AWS 帳單」分頁)。',
    'Method: model cost = tokens per run × list price; device cost = each Device Farm session’s actual metered minutes (sessions are named after the run) × US$0.17/min. Days use Taipei time of run creation. Infrastructure (Fargate, S3, API) is excluded — see the AWS bill tab.', '计算方式:模型费用以每次任务的 token 用量 × 官方单价估算;真机费用取 Device Farm 每个 session 的实际计量分钟(session 由任务创建,名称带任务编号),× US$0.17/分钟。日期以台北时间、任务创建时间为准。不含 Fargate、S3、API 等基础设施(见「AWS 账单」分页)。', '計算方法:モデル費用は 1 回のタスクあたりのトークン使用量 × 公式単価で推定します。実機費用は Device Farm の各セッションの実測分数(セッションはタスクが作成し、名前にタスク番号を含む)× US$0.17/分です。日付はタスク作成時刻の台北時間基準です。Fargate、S3、API などのインフラは含みません(「AWS 請求」タブを参照)。', '계산 방법: 모델 비용은 작업당 토큰 사용량 × 공식 단가로 추정합니다. 기기 비용은 Device Farm 각 세션의 실측 분(세션은 작업이 생성하며 이름에 작업 번호 포함) × US$0.17/분입니다. 날짜는 작업 생성 시각의 타이베이 시간 기준입니다. Fargate, S3, API 등 인프라는 포함하지 않습니다(\'AWS 청구\' 탭 참조).',
  ],
  deviceMissing: ['無法讀取 Device Farm 用量,真機費用暫未計入。', 'Device Farm usage could not be read; device cost is not included.', '无法读取 Device Farm 用量,真机费用暂未计入。', 'Device Farm の使用量を読み取れないため、実機費用は含まれていません。', 'Device Farm 사용량을 읽을 수 없어 기기 비용이 포함되지 않았습니다.'],
  unattributed: ['另有 {n} 個非任務的 Device Farm session(手動測試等)共 {m} 分鐘、{usd},不歸屬任何應用(僅管理員可見)。', '{n} non-run Device Farm session(s) (manual tests etc.) used {m} min, {usd}; not attributed to any app (admins only).', '另有 {n} 个非任务的 Device Farm session(手动测试等)共 {m} 分钟、{usd},不归属任何应用(仅管理员可见)。', 'このほか、タスクに属さない Device Farm セッション(手動テストなど)が {n} 件あり、合計 {m} 分、{usd}。どのアプリにも帰属しません(管理者のみ表示)。', '이 외에 작업에 속하지 않는 Device Farm 세션(수동 테스트 등) {n}개가 총 {m}분, {usd} 사용되었으며 어느 앱에도 귀속되지 않습니다(관리자에게만 표시).'],
  realTotal: ['帳單總額', 'Billed total', '账单总额', '請求合計', '청구 합계'],
  realDaily: ['每日帳單(依服務,UTC 日界線)', 'Daily bill by service (UTC days)', '每日账单(依服务,UTC 日界线)', '日別請求(サービス別、UTC 日境界)', '일별 청구(서비스별, UTC 일 경계)'],
  realNote: [
    '來自 AWS Cost Explorer 的實際帳單:本專案標籤(project)的資源,加上無法貼標的 {svc}。資料約有 24 小時延遲;Amazon Bedrock 為帳號共用服務無法區分專案,模型費用請看「測試費用」分頁。',
    'Actual AWS bill from Cost Explorer: resources tagged with the project tag, plus untaggable {svc}. Data lags ~24h. Amazon Bedrock is account-wide and cannot be split by project; see the Testing cost tab for model spend.', '来自 AWS Cost Explorer 的实际账单:本项目标签(project)的资源,加上无法贴标的 {svc}。数据约有 24 小时延迟;Amazon Bedrock 为账号共用服务无法区分项目,模型费用请看「测试费用」分页。', 'AWS Cost Explorer の実際の請求です。本プロジェクトのタグ(project)が付いたリソースと、タグを付けられない {svc} が対象です。データには約 24 時間の遅延があります。Amazon Bedrock はアカウント共通のサービスのためプロジェクト別に分けられません。モデル費用は「テスト費用」タブをご覧ください。', 'AWS Cost Explorer의 실제 청구입니다. 이 프로젝트 태그(project)가 붙은 리소스와 태그를 붙일 수 없는 {svc}가 대상입니다. 데이터는 약 24시간 지연됩니다. Amazon Bedrock은 계정 공용 서비스라 프로젝트별로 구분할 수 없으므로 모델 비용은 \'테스트 비용\' 탭을 보세요.',
  ],
  bedrockTitle: ['Amazon Bedrock 實際帳單({region},整個帳號)', 'Amazon Bedrock actual bill ({region}, whole account)', 'Amazon Bedrock 实际账单({region},整个账号)', 'Amazon Bedrock の実際の請求({region}、アカウント全体)', 'Amazon Bedrock 실제 청구({region}, 계정 전체)'],
  bedrockNote: [
    '用來核對模型費用:這是 AWS 對模型呼叫的實收金額,同一區域其他應用的用量也會算在裡面,所以不加進上面的帳單總額。「cache-write / cache-read」是模型自動做的 prompt 快取,寫入按 1.25 倍輸入單價收費 —— 測試費用從 2026-10 起也會算進去。',
    'Use this to check model spend: it is what AWS actually charged for model calls. Other apps in the same region are included, so it is not added to the billed total above. "cache-write / cache-read" is automatic prompt caching; writes are billed at 1.25× the input price. Testing cost includes them from 2026-10.', '用来核对模型费用:这是 AWS 对模型调用的实收金额,同一区域其他应用的用量也会算在里面,所以不加进上面的账单总额。「cache-write / cache-read」是模型自动做的 prompt 缓存,写入按 1.25 倍输入单价收费 —— 测试费用从 2026-10 起也会算进去。', 'モデル費用の照合用です。AWS がモデル呼び出しに対して実際に請求した金額で、同じリージョンの他のアプリの使用分も含まれるため、上の請求合計には加算しません。「cache-write / cache-read」はモデルが自動で行うプロンプトキャッシュで、書き込みは入力単価の 1.25 倍で課金されます。テスト費用にも 2026-10 から含まれます。', '모델 비용을 대조하기 위한 것입니다. AWS가 모델 호출에 대해 실제로 청구한 금액이며 같은 리전의 다른 앱 사용분도 포함되므로 위의 청구 합계에는 더하지 않습니다. \'cache-write / cache-read\'는 모델이 자동으로 수행하는 프롬프트 캐시이며, 쓰기는 입력 단가의 1.25배로 청구됩니다. 테스트 비용에도 2026-10부터 포함됩니다.',
  ],
  byMonth: ['每月', 'Monthly', '每月', '月別', '월별'],
  byService: ['依服務', 'By service', '依服务', 'サービス別', '서비스별'],
  byComponent: ['依元件標籤', 'By component tag', '依组件标签', 'コンポーネントタグ別', '구성 요소 태그별'],
  unavailable: ['AWS 帳單資料暫時無法取得。', 'AWS billing data is unavailable.', 'AWS 账单数据暂时无法取得。', 'AWS 請求データを一時的に取得できません。', 'AWS 청구 데이터를 일시적으로 가져올 수 없습니다.'],
  retry: ['重試', 'Retry', '重试', '再試行', '다시 시도'],
  loadError: ['載入失敗', 'Failed to load', '加载失败', '読み込みに失敗しました', '불러오지 못했습니다'],
  unknownModel: ['(未知)', '(unknown)', '(未知)', '(不明)', '(알 수 없음)'],
} as const;
const tx = (k: keyof typeof T, lang: RLang) => pick5(T[k], lang);
// i18n-allow: bucket key emitted by the cost API (infra/lambda/api/cost.ts); matched, not displayed
const UNKNOWN_MODEL_KEY = '(未知)';

const RANGES = [7, 14, 30, 90] as const;

function usd(n: number): string {
  if (n === 0) return '$0';
  // 單筆/每局花費通常是幾分錢,顯示到小數點後四位才評估得準;金額 ≥ $1 的彙總維持兩位好讀。
  if (Math.abs(n) < 1) return `$${n.toFixed(4)}`;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
const shortDate = (d: string) => `${d.slice(5, 7)}/${d.slice(8, 10)}`;
/** 逐筆明細預設顯示筆數(其餘按「顯示全部」展開)。 */
const TASK_ROWS = 25;
const num = (n: number | undefined) => (typeof n === 'number' ? n.toLocaleString() : '—');
/** 各座位 token 的 tooltip 文字:agent/vlm/subagent 各自的進出量。 */
function seatTokenText(r: TaskCostRow): string {
  const parts = (['agent', 'vlm', 'subagent'] as const)
    .map((s) => {
      const v = r.tokensBySeat?.[s];
      return v ? `${s}: ${num(v.input)} / ${num(v.output)}` : null;
    })
    .filter(Boolean);
  return parts.length > 0 ? parts.join('\n') : '';
}
/** 大數字縮寫(用量明細的數量欄:1,234,567 → 1.23M)。 */
function qty(n: number, unit: string): string {
  const abs = Math.abs(n);
  const s = abs >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : abs >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : abs >= 1e4 ? `${(n / 1e3).toFixed(1)}K` : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return unit ? `${s}` : s;
}

export default function CostPage() {
  const { t, locale } = useI18n();
  const lang = reportLang(locale);
  const [days, setDays] = useState<number>(30);
  const [appFilter, setAppFilter] = useState<string>('all');
  const [stack, setStack] = useState<'app' | 'type'>('app');
  const [tab, setTab] = useState<'test' | 'real'>('test');
  const [showAllTasks, setShowAllTasks] = useState(false);
  const { data, loading, error, refetch } = useQuery<CostResponse>(`cost:${days}`, () => apiGet<CostResponse>(`/cost?days=${days}`));
  const { lookup } = useAppLookup();
  const appName = (id: string) => lookup(id)?.name ?? id;

  const daily = data?.daily;
  const real = data?.real;
  // 逐筆明細:套用上方的應用篩選(其餘排序由後端給好,依花費高到低)。
  const taskRows = useMemo(
    () => (daily?.tasks ?? []).filter((r) => appFilter === 'all' || r.appId === appFilter),
    [daily, appFilter],
  );

  // 應用篩選後的資料。
  const view = useMemo(() => {
    if (!daily) return null;
    const apps = appFilter === 'all' ? daily.byApp : daily.byApp.filter((a) => a.appId === appFilter);
    const ids = new Set(apps.map((a) => a.appId));
    const totals = apps.reduce(
      (s, a) => ({ totalUsd: s.totalUsd + a.totalUsd, modelUsd: s.modelUsd + a.modelUsd, deviceUsd: s.deviceUsd + a.deviceUsd, deviceMinutes: s.deviceMinutes + a.deviceMinutes, runs: s.runs + a.runs }),
      { totalUsd: 0, modelUsd: 0, deviceUsd: 0, deviceMinutes: 0, runs: 0 },
    );
    const rows = daily.days.map((d) => {
      const byApp = Object.fromEntries(Object.entries(d.byApp).filter(([k]) => ids.has(k)));
      return { date: d.date, byApp, total: Object.values(byApp).reduce((a, b) => a + b, 0) };
    });
    return { apps, totals, rows };
  }, [daily, appFilter]);

  const appSeries: StackSeries[] = useMemo(
    () => (view?.apps ?? []).map((a, i) => ({ key: a.appId, label: appName(a.appId), color: SERIES_COLORS[i % SERIES_COLORS.length]! })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, lookup],
  );
  const typeSeries: StackSeries[] = [
    { key: 'model', label: tx('model', lang), color: SERIES_COLORS[0]! },
    { key: 'device', label: tx('device', lang), color: SERIES_COLORS[2]! },
  ];
  // 依費用類型堆疊只在「全部應用」時精確(每日模型/真機拆分是全應用彙總)。
  const typeValues = (daily?.days ?? []).map((d) => ({ model: d.modelUsd, device: d.deviceUsd }));

  const realServices = useMemo(() => {
    const totals = new Map<string, number>();
    for (const d of real?.byDay ?? []) for (const [k, v] of Object.entries(d.byService)) totals.set(k, (totals.get(k) ?? 0) + v);
    return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([k], i) => ({ key: k, label: k, color: SERIES_COLORS[i % SERIES_COLORS.length]! }));
  }, [real]);

  return (
    <section className="listpage listpage--wide cost">
      <header className="listpage__header cost__header">
        <div>
          <h1 className="listpage__title">{t('page.cost.title')}</h1>
          <p className="cost__intro">{tx('intro', lang)}</p>
        </div>
        <div className="cost__controls">
          <div className="cost__seg" role="group" aria-label={tx('range', lang)}>
            {RANGES.map((n) => (
              <button key={n} type="button" className={`cost__seg-btn ${days === n ? 'is-active' : ''}`} aria-pressed={days === n} onClick={() => setDays(n)}>
                {tx('days', lang).replace('{n}', String(n))}
              </button>
            ))}
          </div>
          {tab === 'test' && (
            <label className="cost__select">
              <span className="visually-hidden">{tx('app', lang)}</span>
              <select value={appFilter} onChange={(e) => setAppFilter(e.target.value)}>
                <option value="all">{tx('allApps', lang)}</option>
                {(daily?.byApp ?? []).map((a) => <option key={a.appId} value={a.appId}>{appName(a.appId)}</option>)}
              </select>
            </label>
          )}
        </div>
      </header>

      <div className="cost__tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'test'} className={`cost__tab${tab === 'test' ? ' cost__tab--active' : ''}`} onClick={() => setTab('test')}>{tx('tabTest', lang)}</button>
        <button type="button" role="tab" aria-selected={tab === 'real'} className={`cost__tab${tab === 'real' ? ' cost__tab--active' : ''}`} onClick={() => setTab('real')}>{tx('tabReal', lang)}</button>
      </div>

      {loading && !data ? (
        <div className="listpage__skeleton" aria-hidden="true"><div className="listpage__skeleton-row" /><div className="listpage__skeleton-row" /></div>
      ) : error && !data ? (
        <div className="listpage__error" role="alert">
          {tx('loadError', lang)}
          <button type="button" className="cost__retry" onClick={refetch}>{tx('retry', lang)}</button>
        </div>
      ) : tab === 'test' ? (
        daily && view ? (
          <div className="cost__panel">
            <div className="cost__kpis">
              <div className="cost__kpi cost__kpi--main"><span>{tx('total', lang)}</span><strong>{usd(view.totals.totalUsd)}</strong><small>{daily.from} ~ {daily.to}</small></div>
              <div className="cost__kpi"><span>{tx('model', lang)}</span><strong>{usd(view.totals.modelUsd)}</strong></div>
              <div className="cost__kpi"><span>{tx('device', lang)}</span><strong>{usd(view.totals.deviceUsd)}</strong><small>{tx('minutes', lang).replace('{n}', view.totals.deviceMinutes.toFixed(1))}</small></div>
              <div className="cost__kpi"><span>{tx('runs', lang)}</span><strong>{view.totals.runs}</strong></div>
              <div className="cost__kpi"><span>{tx('perRun', lang)}</span><strong>{view.totals.runs ? usd(view.totals.totalUsd / view.totals.runs) : '—'}</strong></div>
            </div>
            {!daily.deviceDataAvailable && <p className="cost__note cost__note--warn" role="status">{tx('deviceMissing', lang)}</p>}

            <div className="cost__card">
              <div className="cost__card-head">
                <h2 className="cost__section-title">{stack === 'app' || appFilter !== 'all' ? tx('dailyTitle', lang) : tx('dailyComp', lang)}</h2>
                {appFilter === 'all' && (
                  <div className="cost__seg cost__seg--sm" role="group" aria-label={tx('byStack', lang)}>
                    <button type="button" className={`cost__seg-btn ${stack === 'app' ? 'is-active' : ''}`} aria-pressed={stack === 'app'} onClick={() => setStack('app')}>{tx('stackApp', lang)}</button>
                    <button type="button" className={`cost__seg-btn ${stack === 'type' ? 'is-active' : ''}`} aria-pressed={stack === 'type'} onClick={() => setStack('type')}>{tx('stackComp', lang)}</button>
                  </div>
                )}
              </div>
              {stack === 'type' && appFilter === 'all' ? (
                <StackedBarChart categories={daily.days.map((d) => d.date)} categoryLabel={shortDate} series={typeSeries} values={typeValues} format={usd} ariaLabel={tx('dailyComp', lang)} emptyText={tx('noData', lang)} />
              ) : (
                <StackedBarChart categories={view.rows.map((r) => r.date)} categoryLabel={shortDate} series={appSeries} values={view.rows.map((r) => r.byApp)} format={usd} ariaLabel={tx('dailyTitle', lang)} emptyText={tx('noData', lang)} />
              )}
            </div>

            <div className="cost__card">
              <h2 className="cost__section-title">{tx('byAppTitle', lang)}</h2>
              {view.apps.length === 0 ? <p className="cost__muted">{tx('noData', lang)}</p> : (
                <div className="cost__table-wrap">
                  <table className="cost__table">
                    <thead>
                      <tr>
                        <th scope="col">{tx('colApp', lang)}</th>
                        <th scope="col" className="num">{tx('colRuns', lang)}</th>
                        <th scope="col" className="num">{tx('colMinutes', lang)}</th>
                        <th scope="col" className="num">{tx('colModel', lang)}</th>
                        <th scope="col" className="num">{tx('colDevice', lang)}</th>
                        <th scope="col" className="num">{tx('colTotal', lang)}</th>
                        <th scope="col" className="num">{tx('colAvg', lang)}</th>
                        <th scope="col">{tx('colShare', lang)}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {view.apps.map((a, i) => {
                        const share = view.totals.totalUsd > 0 ? (a.totalUsd / view.totals.totalUsd) * 100 : 0;
                        return (
                          <tr key={a.appId}>
                            <th scope="row">
                              <span className="cost__app">
                                <span className="cost__swatch" style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} aria-hidden="true" />
                                <AppBadge app={lookup(a.appId)} fallbackId={a.appId} />
                              </span>
                            </th>
                            <td className="num">{a.runs}</td>
                            <td className="num">{a.deviceMinutes.toFixed(1)}</td>
                            <td className="num">{usd(a.modelUsd)}</td>
                            <td className="num">{usd(a.deviceUsd)}</td>
                            <td className="num"><strong>{usd(a.totalUsd)}</strong></td>
                            <td className="num">{a.runs ? usd(a.totalUsd / a.runs) : '—'}</td>
                            <td>
                              <span className="cost__share">
                                <span className="cost__share-track" aria-hidden="true"><span style={{ width: `${share}%`, background: SERIES_COLORS[i % SERIES_COLORS.length] }} /></span>
                                {share.toFixed(1)}%
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* 逐筆測試明細:最細的一層,回答「這一次測試到底花在哪」。 */}
            {taskRows.length > 0 && (
              <div className="cost__card">
                <h2 className="cost__section-title">{tx('taskTable', lang)}</h2>
                <p className="cost__muted">{tx('taskHint', lang)}</p>
                <div className="cost__table-wrap">
                  <table className="cost__table">
                    <thead>
                      <tr>
                        <th scope="col">{tx('colTime', lang)}</th>
                        <th scope="col">{tx('colApp', lang)}</th>
                        <th scope="col">{tx('colCase', lang)}</th>
                        <th scope="col">{tx('colBackend', lang)}</th>
                        <th scope="col" className="num">{tx('colSteps', lang)}</th>
                        <th scope="col" className="num">{tx('colTokIn', lang)}</th>
                        <th scope="col" className="num">{tx('colTokOut', lang)}</th>
                        <th scope="col" className="num">{tx('colMinutes', lang)}</th>
                        <th scope="col" className="num">{tx('colModel', lang)}</th>
                        <th scope="col" className="num">{tx('colDevice', lang)}</th>
                        <th scope="col" className="num">{tx('colTotal', lang)}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(showAllTasks ? taskRows : taskRows.slice(0, TASK_ROWS)).map((r) => (
                        <tr key={r.jobId}>
                          <th scope="row">
                            <Link to={`/tasks/${r.jobId}`} className="cost__link">
                              {r.createdAt.slice(5, 16).replace('T', ' ')}
                            </Link>
                          </th>
                          <td><AppBadge app={lookup(r.appId)} fallbackId={r.appId} /></td>
                          <td className="cost__ellipsis" title={r.caseName ?? r.caseId}>{r.caseName ?? r.caseId}</td>
                          <td>{t(`backend.${r.backend}` as MessageKey)}</td>
                          <td className="num">{r.steps ?? '—'}</td>
                          {/* token 總量 + hover 看各座位拆分(agent / vlm / subagent) */}
                          <td className="num" title={seatTokenText(r)}>{num(r.tokensIn)}</td>
                          <td className="num" title={seatTokenText(r)}>{num(r.tokensOut)}</td>
                          <td className="num">{r.deviceMinutes > 0 ? r.deviceMinutes.toFixed(1) : '—'}</td>
                          <td className="num">
                            {usd(r.modelUsd)}
                            {r.estimated && <small> {tx('estTag', lang)}</small>}
                          </td>
                          <td className="num">{usd(r.deviceUsd)}</td>
                          <td className="num"><strong>{usd(r.totalUsd)}</strong></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {taskRows.length > TASK_ROWS && (
                  <button type="button" className="cost__retry" onClick={() => setShowAllTasks((v) => !v)}>
                    {showAllTasks
                      ? tx('showLess', lang).replace('{n}', String(TASK_ROWS))
                      : tx('showAll', lang).replace('{n}', String(taskRows.length))}
                  </button>
                )}
              </div>
            )}

            <details className="cost__card cost__details">
              <summary>{tx('dayTable', lang)}</summary>
              <div className="cost__table-wrap">
                <table className="cost__table">
                  <thead>
                    <tr>
                      <th scope="col">{tx('colDate', lang)}</th>
                      <th scope="col" className="num">{tx('colRuns', lang)}</th>
                      {appFilter === 'all' && <th scope="col" className="num">{tx('colModel', lang)}</th>}
                      {appFilter === 'all' && <th scope="col" className="num">{tx('colDevice', lang)}</th>}
                      <th scope="col" className="num">{tx('colTotal', lang)}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...view.rows].reverse().filter((r) => r.total > 0).map((row) => {
                      const d = daily.days.find((x) => x.date === row.date)!;
                      return (
                        <tr key={d.date}>
                          <th scope="row">{d.date}</th>
                          <td className="num">{appFilter === 'all' ? d.runs : '—'}</td>
                          {appFilter === 'all' && <td className="num">{usd(d.modelUsd)}</td>}
                          {appFilter === 'all' && <td className="num">{usd(d.deviceUsd)}</td>}
                          <td className="num"><strong>{usd(row.total)}</strong></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </details>

            {data?.estimated && data.estimated.byModel.length > 0 && (
              <div className="cost__card">
                <h2 className="cost__section-title">{tx('byModelTitle', lang)}</h2>
                <BarList items={data.estimated.byModel} labelOf={(k) => (k === UNKNOWN_MODEL_KEY ? tx('unknownModel', lang) : modelLabel(k))} />
              </div>
            )}

            {daily.unattributed && (
              <p className="cost__note">
                {tx('unattributed', lang)
                  .replace('{n}', String(daily.unattributed.sessions))
                  .replace('{m}', daily.unattributed.deviceMinutes.toFixed(1))
                  .replace('{usd}', usd(daily.unattributed.deviceUsd))}
              </p>
            )}
            <p className="cost__note">{tx('method', lang)}</p>
          </div>
        ) : null
      ) : real?.available ? (
        <div className="cost__panel">
          <div className="cost__kpis">
            <div className="cost__kpi cost__kpi--main"><span>{tx('realTotal', lang)}</span><strong>{usd(real.totalUsd)}</strong><small>{real.start} ~ {real.end}</small></div>
          </div>
          <p className="cost__note">{tx('realNote', lang).replace('{svc}', (real.includedServices ?? []).join(', ') || '—')}</p>
          {real.byDay && real.byDay.length > 0 && (
            <div className="cost__card">
              <h2 className="cost__section-title">{tx('realDaily', lang)}</h2>
              <StackedBarChart
                categories={real.byDay.map((d) => d.date)}
                categoryLabel={shortDate}
                series={realServices}
                values={real.byDay.map((d) => d.byService)}
                format={usd}
                ariaLabel={tx('realDaily', lang)}
                emptyText={tx('noData', lang)}
              />
            </div>
          )}
          {/* 模型帳單對照:Bedrock 帳號共用、分不出專案,所以單獨列出、不加總。 */}
          {real.bedrock && real.bedrock.byUsageType.length > 0 && (
            <div className="cost__card">
              <h2 className="cost__section-title">
                {tx('bedrockTitle', lang).replace('{region}', real.bedrock.region)} · {usd(real.bedrock.totalUsd)}
              </h2>
              <p className="cost__muted">{tx('bedrockNote', lang)}</p>
              <div className="cost__table-wrap">
                <table className="cost__table">
                  <thead>
                    <tr>
                      <th scope="col">{tx('colUsageType', lang)}</th>
                      <th scope="col" className="num">{tx('colQty', lang)}</th>
                      <th scope="col">{tx('colUnit', lang)}</th>
                      <th scope="col" className="num">{tx('colTotal', lang)}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {real.bedrock.byUsageType.slice(0, 15).map((u) => (
                      <tr key={u.usageType}>
                        <th scope="row" className="cost__mono">{u.usageType}</th>
                        <td className="num" title={u.quantity.toLocaleString()}>{qty(u.quantity, u.unit)}</td>
                        <td className="cost__muted">{u.unit}</td>
                        <td className="num"><strong>{usd(u.amountUsd)}</strong></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {/* 用量明細:API 呼叫次數、S3 請求數、token 數…都在這裡(AWS 自己的計量值)。 */}
          {real.byUsageType && real.byUsageType.length > 0 && (
            <div className="cost__card">
              <h2 className="cost__section-title">{tx('usageTable', lang)}</h2>
              <p className="cost__muted">{tx('usageHint', lang)}</p>
              <div className="cost__table-wrap">
                <table className="cost__table">
                  <thead>
                    <tr>
                      <th scope="col">{tx('colService', lang)}</th>
                      <th scope="col">{tx('colUsageType', lang)}</th>
                      <th scope="col" className="num">{tx('colQty', lang)}</th>
                      <th scope="col">{tx('colUnit', lang)}</th>
                      <th scope="col" className="num">{tx('colTotal', lang)}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {real.byUsageType.map((u) => (
                      <tr key={`${u.service}-${u.usageType}`}>
                        <th scope="row" className="cost__ellipsis" title={u.service}>{u.service}</th>
                        <td className="cost__mono">{u.usageType}</td>
                        <td className="num" title={u.quantity.toLocaleString()}>{qty(u.quantity, u.unit)}</td>
                        <td className="cost__muted">{u.unit}</td>
                        <td className="num"><strong>{usd(u.amountUsd)}</strong></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="cost__grid2">
            <div className="cost__card">
              <h2 className="cost__section-title">{tx('byService', lang)}</h2>
              <BarList items={real.byService} />
            </div>
            <div className="cost__card">
              <h2 className="cost__section-title">{tx('byMonth', lang)}</h2>
              <BarList items={real.byMonth.map((m) => ({ key: m.month, amountUsd: m.amountUsd }))} />
              <h2 className="cost__section-title">{tx('byComponent', lang)}</h2>
              <BarList items={real.byComponent} />
            </div>
          </div>
        </div>
      ) : (
        <div className="cost__unavailable">
          <p>{tx('unavailable', lang)}</p>
          <ol className="cost__enable-steps">
            <li>{t('cost.enableStep1')}</li>
            <li>{t('cost.enableStep2')}</li>
            <li>{t('cost.enableStep3')}</li>
          </ol>
          {real?.note && <p className="cost__error-detail">{real.note}</p>}
        </div>
      )}
    </section>
  );
}

/** 水平長條:依最大值等比,顯示 label + 金額。 */
function BarList({ items, labelOf }: { items: CostBucket[]; labelOf?: (key: string) => string }) {
  const max = Math.max(1e-9, ...items.map((i) => i.amountUsd));
  if (items.length === 0) return null;
  return (
    <ul className="cost__bars">
      {items.map((it) => (
        <li key={it.key} className="cost__bar-row">
          <span className="cost__bar-label" title={it.key}>{labelOf ? labelOf(it.key) : it.key}</span>
          <span className="cost__bar-track" aria-hidden="true">
            <span className="cost__bar-fill" style={{ width: `${Math.max(2, (it.amountUsd / max) * 100)}%` }} />
          </span>
          <span className="cost__bar-amount">{usd(it.amountUsd)}</span>
        </li>
      ))}
    </ul>
  );
}
