/**
 * 交付文件規範(QA-DS 1.0)—— 把引擎算好的 StructuredReport 投影成客戶要求的 19 類交付文件。
 *
 * 為什麼要這一層:
 *  平台內部的判定語彙(verdict PASS / PASS_WITH_RISK / FAIL / BLOCKED、severity
 *  critical / high / medium / low)對齊 ISTQB,見 docs/design/acceptance-standard.md。
 *  客戶的品檢文件體系用的是另一套語彙(PASS / FAIL / BLOCK / N-A、A~D 級、E0~E3 發現分級)
 *  與另一套統計公式。兩套都要存在:內部判定不改,交付文件按客戶語彙重新表述。
 *
 * 三條不可退讓的規則(直接寫進資料結構,不靠使用者自律):
 *  1. **未執行與無資料不填 PASS**。待判讀、未執行、無下一步可判定一律落到 BLOCK,
 *     並在備註保留原判定,不得四捨五入成通過。
 *  2. **算不出來就回 null**。三個統計指標各自宣告分子、分母與定義界線;缺輸入時
 *     value = null 並附原因,不以 0 或估計值充數(與 metrics.ts 的 not_collected 同一原則)。
 *  3. **不可衍生的文件要具名列出**。19 類文件全部出現在 documents[],單次自動化執行
 *     無法產生的(會議紀錄、訓練考核、排程…)標 not_derivable 並寫明原因,
 *     不靜默省略 —— 「完整」指的是覆蓋狀態完整,不是硬填。
 *
 * 本模組是純函式,不讀 S3、不呼叫模型,所有數字沿用 StructuredReport 既有欄位。
 */
import { round2, spinTransactions } from './metrics.js';
import { CATEGORY_CAPABILITY, capabilitySummary, type CapabilityLevel } from './qaCapability.js';
import type { AcResult, Acceptance } from './acceptance.js';
import type {
  CheckItem,
  CheckResult,
  Finding,
  L10n,
  Reproducibility,
  Severity,
  StructuredReport,
} from './types.js';

const L = (zh: string, en: string): L10n => ({ zh, en });

export const QA_DOC_STANDARD = { id: 'QA-DS', version: '1.0' } as const;
export const QA_DOC_STANDARD_TAG = `${QA_DOC_STANDARD.id}-${QA_DOC_STANDARD.version}`;

// ───────────────────────── 1. 結果狀態(四態)─────────────────────────

/** 交付文件的結果欄位只有這四個值;'NA' 在文件上印為 N/A。 */
export type QaItemResult = 'PASS' | 'FAIL' | 'BLOCK' | 'NA';

export const QA_RESULT_LEGEND: ReadonlyArray<{ result: QaItemResult; label: string; definition: L10n }> = [
  { result: 'PASS', label: 'PASS', definition: L('實際執行結果與預期符合', 'Actual result matches the expected result') },
  { result: 'FAIL', label: 'FAIL', definition: L('實際執行結果與預期不符合', 'Actual result does not match the expected result') },
  { result: 'BLOCK', label: 'BLOCK', definition: L('不具備可執行條件', 'Preconditions for execution are not met') },
  { result: 'NA', label: 'N/A', definition: L('本次版本未包含用例描述功能', 'This version does not include the function the case describes') },
];

/**
 * 逐步判定 → 四態。
 * 'unclear'(執行完成但證據不足以判定)與 'skipped'(沒有下一步可判定)都不是通過,
 * 依規則 1 落到 BLOCK;原判定保留在 resultNote,報告上可對照。
 */
export function qaResultOfCheck(result: CheckResult): { result: QaItemResult; note?: L10n } {
  switch (result) {
    case 'pass':
      return { result: 'PASS' };
    case 'fail':
      return { result: 'FAIL' };
    case 'unclear':
      return {
        result: 'BLOCK',
        note: L('原判定為待判讀:已執行但證據不足以判定,未得出結果不填 PASS', 'Originally indeterminate: executed but evidence was insufficient; an undetermined result is not recorded as PASS'),
      };
    case 'skipped':
      return {
        result: 'BLOCK',
        note: L('無後續畫面可判定本步預期,未得出結果不填 PASS', 'No subsequent screen was available to judge this expectation; an undetermined result is not recorded as PASS'),
      };
  }
}

/** 驗收項目結果 → 四態。not_applicable 是唯一會落到 N/A 的來源。 */
export function qaResultOfCriterion(result: AcResult): { result: QaItemResult; note?: L10n } {
  switch (result) {
    case 'pass':
      return { result: 'PASS' };
    case 'fail':
      return { result: 'FAIL' };
    case 'not_evaluable':
      return {
        result: 'BLOCK',
        note: L('本次證據無法判定此項', 'This criterion could not be evaluated from the available evidence'),
      };
    case 'not_applicable':
      return { result: 'NA', note: L('本次測試範圍不含此項', 'Out of scope for this test run') };
  }
}

/** 允收欄位:只有 PASS 記 Y;N/A 不是允收也不是退回,記「—」。 */
export function qaAcceptanceMark(result: QaItemResult): 'Y' | 'N' | '—' {
  if (result === 'PASS') return 'Y';
  if (result === 'NA') return '—';
  return 'N';
}

// ───────────────────────── 2. 缺陷嚴重度與發現分級 ─────────────────────────

export type QaDefectGrade = 'A' | 'B' | 'C' | 'D';

export const QA_GRADE_LEGEND: ReadonlyArray<{ grade: QaDefectGrade; label: L10n; definition: L10n }> = [
  { grade: 'A', label: L('A級致命', 'Grade A - fatal'), definition: L('嚴重導致遊戲停止與影響遊戲功能玩法', 'Stops the game and impairs its functions or gameplay') },
  { grade: 'B', label: L('B級嚴重', 'Grade B - major'), definition: L('不導致遊戲停止,但影響玩法', 'Does not stop the game but affects gameplay') },
  { grade: 'C', label: L('C級缺陷', 'Grade C - minor'), definition: L('外觀或很小的問題,不影響玩法', 'Cosmetic or very small, gameplay unaffected') },
  { grade: 'D', label: L('D級建議', 'Grade D - suggestion'), definition: L('有助改善遊戲內容的意見', 'An opinion that would improve the game') },
];

const GRADE_OF_SEVERITY: Record<Severity, QaDefectGrade> = { critical: 'A', high: 'B', medium: 'C', low: 'D' };

export function qaGradeOf(severity: Severity): QaDefectGrade {
  return GRADE_OF_SEVERITY[severity];
}

export type QaDiscoveryGrade = 'E0' | 'E1' | 'E2' | 'E3';

export const QA_DISCOVERY_LEGEND: ReadonlyArray<{ grade: QaDiscoveryGrade; definition: L10n }> = [
  { grade: 'E1', definition: L('一般操作觸發', 'Triggered by ordinary operation') },
  { grade: 'E2', definition: L('滿足特定流程或條件觸發', 'Triggered only when a specific flow or condition is met') },
  { grade: 'E3', definition: L('特殊環境造成', 'Caused by a special environment') },
  { grade: 'E0', definition: L('已知問題與優化建議', 'Known issue or improvement suggestion') },
];

/** 一般操作就會踩到的重現性 → E1;其餘需要特定條件 → E2。 */
const ORDINARY_REPRO: ReadonlySet<Reproducibility> = new Set<Reproducibility>(['always', 'frequent']);
/** 歸因為環境的缺陷類別(弱網、裝置相容)→ E3。 */
const ENVIRONMENT_CATEGORIES: ReadonlySet<string> = new Set(['network', 'compatibility']);

/**
 * 發現分級。判定順序固定,並回傳採用的理由 —— 分級要能被覆核,不能只給一個字母。
 */
export function qaDiscoveryOf(f: Pick<Finding, 'severity' | 'category' | 'classification' | 'reproducibility'>): {
  grade: QaDiscoveryGrade;
  reason: L10n;
} {
  if (f.classification === 'ENVIRONMENT' || ENVIRONMENT_CATEGORIES.has(f.category)) {
    return { grade: 'E3', reason: L('歸因或類別屬測試環境條件', 'Attributed to, or categorised as, a test-environment condition') };
  }
  if (f.severity === 'low') {
    return { grade: 'E0', reason: L('D級建議,列為優化建議', 'Grade D suggestion, recorded as an improvement item') };
  }
  if (ORDINARY_REPRO.has(f.reproducibility)) {
    return { grade: 'E1', reason: L('一般操作即可重現', 'Reproducible through ordinary operation') };
  }
  return { grade: 'E2', reason: L('需滿足特定流程或條件才重現', 'Reproduces only under a specific flow or condition') };
}

/** 優先權由嚴重度推導(A→P0…D→P3);原文件由人工填寫,此處標示為推導值。 */
const PRIORITY_OF_GRADE: Record<QaDefectGrade, string> = { A: 'P0', B: 'P1', C: 'P2', D: 'P3' };

const FREQUENCY_LABEL: Record<Reproducibility, L10n> = {
  always: L('一定', 'Always'),
  frequent: L('經常', 'Frequent'),
  intermittent: L('間歇', 'Intermittent'),
  rare: L('偶發', 'Rare'),
  single: L('單次', 'Single occurrence'),
  unable: L('無法重現', 'Not reproducible'),
};

// ───────────────────────── 3. 統計指標(保留原公式)─────────────────────────

/**
 * 一個統計指標。分子、分母與定義界線都外顯 ——
 * 原標準三個公式的分母各不相同,只給一個百分比會被誤讀。
 */
export interface QaStatistic {
  id: 'item_coverage' | 'execution_pass_rate' | 'defect_fix_rate';
  label: L10n;
  /** 原公式原文。 */
  formula: L10n;
  numerator: number | null;
  denominator: number | null;
  /** 百分比(四捨五入到小數 2 位);算不出來為 null。 */
  value: number | null;
  /** 分子分母的納入範圍(逐報告確認用)。 */
  basis: L10n;
  /** 定義界線:這個數字「不是」什麼。 */
  caveat: L10n;
}

/** 單次執行報告之外才有的輸入:測項母體與缺陷處理狀態。沒有就不算,不猜。 */
export interface QaDocOptions {
  /** 測項母體:定版測項數與本次新增測項數。 */
  itemBaseline?: { baselined: number; added: number };
  /** 缺陷處理狀態(跨版本追蹤才有):已修正、不做處理、缺陷總數。 */
  defectDisposition?: { fixed: number; wontFix: number; total: number };
  /** 產生時間(ISO);預設取測試結束時間,讓同一份報告每次投影結果相同。 */
  generatedAt?: string;
  /**
   * 逐列表格的列數上限(預設 400)。
   * 逐筆證據可達數百列,整份文件集是跟著報告回應一起送出的,不設上限會讓回應量翻倍。
   * 超過上限時只截斷列,並在 emptyReason 寫明被截掉多少列與完整資料在哪 —— 不靜默刪資料。
   */
  maxRows?: number;
}

const DEFAULT_MAX_ROWS = 400;

/** 截斷過長的表格,並把截斷事實寫進表格本身。 */
function capRows(table: QaDocTable, maxRows: number, fullSource: L10n): QaDocTable {
  if (table.rows.length <= maxRows) return table;
  const dropped = table.rows.length - maxRows;
  return {
    ...table,
    rows: table.rows.slice(0, maxRows),
    emptyReason: L(
      `共 ${table.rows.length} 列,本文件集只列前 ${maxRows} 列;其餘 ${dropped} 列請見${fullSource.zh}。`,
      `${table.rows.length} rows in total; this document set lists the first ${maxRows}. The remaining ${dropped} are in ${fullSource.en}.`,
    ),
  };
}

function pct(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator <= 0) return null;
  return round2((numerator / denominator) * 100);
}

export function buildQaStatistics(report: StructuredReport, opts: QaDocOptions = {}): QaStatistic[] {
  const { passed, failed, unclear } = report.counts;
  // 執行總數 = 已執行列數(通過＋失敗＋待判讀);不含未執行與不適用。
  const executed = passed + failed + unclear;

  const baseline = opts.itemBaseline;
  const coverageDenominator = baseline ? baseline.baselined + baseline.added : null;

  const disposition = opts.defectDisposition;
  const fixNumerator = disposition ? disposition.fixed + disposition.wontFix : null;

  return [
    {
      id: 'item_coverage',
      label: L('測項覆蓋率', 'Test-item coverage'),
      formula: L('定版測項／(定版測項＋新增測項)', 'Baselined items / (baselined items + newly added items)'),
      numerator: baseline ? baseline.baselined : null,
      denominator: coverageDenominator,
      value: pct(baseline ? baseline.baselined : null, coverageDenominator),
      basis: baseline
        ? L('由輸入的測項母體計算', 'Computed from the supplied test-item population')
        : L('未提供定版測項與新增測項數,單次執行報告不含測項母體,故不計算', 'Baselined and newly added item counts were not supplied; a single-run report carries no item population, so this is not computed'),
      caveat: L('定版測項占比,不是需求覆蓋率', 'A share of baselined items, not requirements coverage'),
    },
    {
      id: 'execution_pass_rate',
      label: L('執行通過率', 'Execution pass rate'),
      formula: L('PASS／測試用例執行總數', 'PASS / total executed cases'),
      numerator: passed,
      denominator: executed,
      value: pct(passed, executed),
      basis: L('分母為已執行列數(通過＋失敗＋待判讀),不含未執行與不適用', 'Denominator is the executed rows (pass + fail + indeterminate), excluding not-executed and not-applicable rows'),
      caveat: L('執行總數的納入範圍須隨報告確認;與平台內部通過率(通過÷(通過＋失敗))分母不同,兩者不可互換', 'The inclusion range of the executed total must be confirmed per report; the platform pass rate uses pass / (pass + fail) and the two denominators are not interchangeable'),
    },
    {
      id: 'defect_fix_rate',
      label: L('Bug修正率', 'Defect fix rate'),
      formula: L('(已修正＋不做處理)／Bug總數', '(Fixed + will-not-fix) / total defects'),
      numerator: fixNumerator,
      denominator: disposition ? disposition.total : null,
      value: pct(fixNumerator, disposition ? disposition.total : null),
      basis: disposition
        ? L('由輸入的缺陷處理狀態計算', 'Computed from the supplied defect disposition')
        : L('本次執行的缺陷皆為開立狀態,修正與複驗屬後續版本,故不計算', 'Every defect from this run is open; fixes and retests belong to later versions, so this is not computed'),
      caveat: L('分子包含不做處理,不能解讀為全數實際修復', 'The numerator includes will-not-fix items, so it cannot be read as the share actually repaired'),
    },
  ];
}

// ───────────────────────── 4. 測項分類與交叉條件 ─────────────────────────

export interface QaCategory {
  code: string;
  label: L10n;
  /** 由畫面名 / 模組名推斷分類用;小寫比對。 */
  keywords: readonly string[];
}

/**
 * 測項主要分類(M01~M19)。
 * 這是檢索索引:每個測項只歸一類,平台、弱網、中斷與語系等條件另以交叉標籤標記。
 */
export const QA_CATEGORIES: readonly QaCategory[] = [
  { code: 'M01', label: L('安裝更新與啟動載入', 'Install, update, boot and loading'), keywords: ['install', 'update', 'patch', 'download', 'boot', 'splash', 'loading', 'logo', '啟動', '載入', '安裝', '更新', '下載'] },
  { code: 'M02', label: L('帳號身份與存取', 'Account, identity and access'), keywords: ['login', 'logout', 'signup', 'register', 'account', 'auth', 'password', 'kyc', '登入', '登出', '註冊', '帳號', '密碼', '驗證'] },
  { code: 'M03', label: L('遊戲規則與回合狀態', 'Game rules and round state'), keywords: ['spin', 'round', 'bet', 'gameplay', 'battle', 'free game', 'feature', 'demo', '回合', '規則', '下注', '對戰', '結算'] },
  { code: 'M04', label: L('資產交易與帳務一致', 'Assets, transactions and ledger consistency'), keywords: ['balance', 'credit', 'wallet', 'purchase', 'payment', 'deposit', 'shop', 'ledger', '資產', '金幣', '餘額', '儲值', '購買', '帳務', '金流'] },
  { code: 'M05', label: L('活動任務與營運獎勵', 'Events, missions and operational rewards'), keywords: ['event', 'mission', 'quest', 'reward', 'bonus', 'daily', 'season', '活動', '任務', '獎勵', '賽季', '簽到'] },
  { code: 'M06', label: L('社交排行與玩家互動', 'Social, leaderboards and player interaction'), keywords: ['friend', 'chat', 'rank', 'leaderboard', 'guild', 'social', 'invite', '好友', '排行', '聊天', '公會', '互動'] },
  { code: 'M07', label: L('操作介面與顯示互動', 'UI and display interaction'), keywords: ['ui', 'button', 'menu', 'panel', 'popup', 'dialog', 'hud', 'bar', '介面', '按鈕', '選單', '面板', '彈窗', '提示'] },
  { code: 'M08', label: L('影音語系與內容呈現', 'Audio, locale and content presentation'), keywords: ['audio', 'sound', 'music', 'voice', 'locale', 'language', 'i18n', 'subtitle', 'animation', '音效', '音樂', '語系', '語音', '動畫', '演出', '翻譯'] },
  { code: 'M09', label: L('網路通訊與服務同步', 'Network and service synchronisation'), keywords: ['network', 'latency', 'packet', 'disconnect', 'reconnect', 'sync', 'gateway', 'api', '網路', '延遲', '斷線', '重連', '同步', '封包', '弱網'] },
  { code: 'M10', label: L('保存中斷與狀態復原', 'Persistence, interruption and state recovery'), keywords: ['save', 'resume', 'recover', 'recovery', 'restore', 'reset', 'background', 'interrupt', '保存', '復原', '重啟', '中斷', '還原', '重置'] },
  { code: 'M11', label: L('平台裝置與適配', 'Platform, device and adaptation'), keywords: ['device', 'resolution', 'aspect', 'platform', 'os', 'browser', 'emulator', 'compat', '裝置', '解析度', '適配', '相容', '機型'] },
  { code: 'M12', label: L('效能資源與長期穩定', 'Performance, resources and long-run stability'), keywords: ['fps', 'cpu', 'gpu', 'memory', 'battery', 'temperature', 'performance', 'soak', 'stability', '效能', '記憶體', '耗電', '溫度', '穩定', '掛測'] },
  { code: 'M13', label: L('廣告推播與外部套件', 'Ads, push and third-party SDKs'), keywords: ['ad', 'ads', 'advert', 'push', 'notification', 'sdk', 'webview', 'tracking', '廣告', '推播', '通知', '套件'] },
  { code: 'M14', label: L('後台報表與系統串接', 'Back-office reports and system integration'), keywords: ['backend', 'backoffice', 'admin', 'report', 'dashboard', 'export', 'audit', '後台', '報表', '日報', '月報', '串接', '稽核'] },
  { code: 'M15', label: L('設備周邊與實體操作', 'Peripherals and physical operation'), keywords: ['printer', 'ticket', 'coin', 'hopper', 'button panel', 'joystick', 'lamp', 'peripheral', '出票', '投幣', '搖桿', '燈號', '周邊', '機構'] },
  { code: 'M16', label: L('自動化執行與分析方法', 'Automation execution and analysis method'), keywords: ['automation', 'script', 'batch', 'run', 'sampling', 'analysis', '自動化', '腳本', '逐筆', '取樣', '分析'] },
  { code: 'M17', label: L('體驗研究與競品分析', 'Experience research and competitive analysis'), keywords: ['ux research', 'survey', 'questionnaire', 'usability', 'benchmark', 'competitor', '體驗研究', '問卷', '易用', '競品'] },
  { code: 'M18', label: L('送測送審與版本允收', 'Submission, review and version acceptance'), keywords: ['submission', 'review', 'store', 'release check', 'acceptance', 'signoff', '送測', '送審', '允收', '放行', '檢驗'] },
  { code: 'M19', label: L('專案規格與跨功能組合', 'Project specification and cross-function combinations'), keywords: ['spec', 'requirement', 'cross', 'combination', 'end to end', '規格', '需求', '跨功能', '組合', '流程'] },
];

/** 交叉條件標籤:與主要分類正交,可同時成立多個。 */
export type QaCrossTag = 'interruption_recovery' | 'boundary_anomaly' | 'platform_compat' | 'data_consistency' | 'repeat_sequence' | 'locale_av';

export const QA_CROSS_TAGS: ReadonlyArray<{ id: QaCrossTag; label: L10n; keywords: readonly string[] }> = [
  { id: 'interruption_recovery', label: L('中斷復原', 'Interruption and recovery'), keywords: ['recover', 'resume', 'restore', 'background', 'interrupt', 'restart', 'disconnect', '中斷', '復原', '重啟', '斷線', '後台'] },
  { id: 'boundary_anomaly', label: L('邊界異常', 'Boundary and anomaly'), keywords: ['boundary', 'overflow', 'max', 'min', 'invalid', 'error', 'empty', '邊界', '上限', '下限', '異常', '錯誤', '超框'] },
  { id: 'platform_compat', label: L('平台相容', 'Platform compatibility'), keywords: ['platform', 'device', 'resolution', 'browser', 'os', 'compat', '平台', '裝置', '解析度', '相容'] },
  { id: 'data_consistency', label: L('資料一致', 'Data consistency'), keywords: ['consistency', 'ledger', 'balance', 'sync', 'record', 'audit', '一致', '帳務', '紀錄', '同步', '對帳'] },
  { id: 'repeat_sequence', label: L('連續重複', 'Repetition and sequencing'), keywords: ['repeat', 'again', 'twice', 'consecutive', 'loop', 'duplicate', '連續', '重複', '多次', '再次'] },
  { id: 'locale_av', label: L('語系影音', 'Locale, audio and video'), keywords: ['locale', 'language', 'i18n', 'translation', 'audio', 'sound', 'voice', 'music', '語系', '語言', '翻譯', '音效', '語音', '影音'] },
];

function matchKeywords(haystack: string, keywords: readonly string[]): boolean {
  return keywords.some((k) => haystack.includes(k));
}

/** 由畫面名、模組與動作文字推斷主要分類;推不出來歸 M19(跨功能組合)。 */
export function qaCategoryOf(text: string): QaCategory {
  const hay = text.toLowerCase();
  for (const c of QA_CATEGORIES) {
    if (c.code === 'M19') continue;
    if (matchKeywords(hay, c.keywords)) return c;
  }
  return QA_CATEGORIES[QA_CATEGORIES.length - 1]!;
}

export function qaCrossTagsOf(text: string): QaCrossTag[] {
  const hay = text.toLowerCase();
  return QA_CROSS_TAGS.filter((t) => matchKeywords(hay, t.keywords)).map((t) => t.id);
}

// ───────────────────────── 5. 文件模型 ─────────────────────────

export type QaDocCode =
  | 'T01' | 'T02' | 'T03' | 'T04' | 'T05' | 'T06' | 'T07' | 'T08' | 'T09' | 'T10'
  | 'T11' | 'T12' | 'T13' | 'T14' | 'T15' | 'T16' | 'T17' | 'T18' | 'T19';

export type QaDocGroup = 'planning' | 'execution' | 'defects' | 'closure' | 'specialty' | 'research' | 'training';

export const QA_DOC_GROUP_LABEL: Record<QaDocGroup, L10n> = {
  planning: L('送測與規劃', 'Submission and planning'),
  execution: L('執行與結果', 'Execution and results'),
  defects: L('問題與複驗', 'Defects and retest'),
  closure: L('結案與交付', 'Closure and delivery'),
  specialty: L('健檢與專項', 'Health checks and specialty testing'),
  research: L('研究與支援', 'Research and support'),
  training: L('教育與支援', 'Training and support'),
};

/**
 * 覆蓋狀態:
 *  derived            —— 單次自動化執行即可填滿本文件的工作紀錄。
 *  derived_with_gaps  —— 可填主要欄位,但有需人工補填的欄位(列在 unfilled)。
 *  not_derivable      —— 本文件的輸入不是執行證據(會議、計畫、訓練、排程),不可由報告推導。
 */
export type QaDocCoverage = 'derived' | 'derived_with_gaps' | 'not_derivable';

export interface QaDocField {
  key: string;
  label: L10n;
  value: string;
}

export interface QaDocTable {
  id: string;
  title: L10n;
  columns: Array<{ key: string; label: L10n }>;
  rows: Array<Record<string, string>>;
  /** 本表未產生任何列的原因(rows 為空時必填)。 */
  emptyReason?: L10n;
}

export interface QaDocument {
  code: QaDocCode;
  title: L10n;
  group: QaDocGroup;
  coverage: QaDocCoverage;
  /** 覆蓋狀態的理由(not_derivable 必填;derived_with_gaps 說明缺口)。 */
  reason?: L10n;
  /** 表頭欄位。 */
  header: QaDocField[];
  /** 工作紀錄。 */
  tables: QaDocTable[];
  /** 關聯與補充紀錄。 */
  links: QaDocField[];
  /** 需人工補填的欄位名稱。 */
  unfilled: L10n[];
}

export interface QaDocumentSet {
  standard: string;
  generatedAt: string;
  /** 內部判定標準的版本(可追溯兩套語彙的對應關係)。 */
  internalStandard: string;
  resultLegend: typeof QA_RESULT_LEGEND;
  gradeLegend: typeof QA_GRADE_LEGEND;
  discoveryLegend: typeof QA_DISCOVERY_LEGEND;
  statistics: QaStatistic[];
  documents: QaDocument[];
  /** 覆蓋狀態統計(19 類文件一個都不漏)。 */
  coverageSummary: Record<QaDocCoverage, number>;
  notes: L10n[];
}

// ───────────────────────── 6. 文件產生 ─────────────────────────

const DASH = '—';

/** 可執行性分級的顯示名稱。 */
const CAPABILITY_LABEL: Record<CapabilityLevel, L10n> = {
  automated: L('可自動執行', 'Automated'),
  partial: L('部分(有缺口)', 'Partial'),
  not_supported: L('結構性做不到', 'Not supported'),
};

const f = (key: string, label: L10n, value: string | number | undefined | null): QaDocField => ({
  key,
  label,
  value: value === undefined || value === null || value === '' ? DASH : String(value),
});

const dateOnly = (iso?: string): string => (iso ? (iso.split('T')[0] ?? iso) : DASH);

/**
 * 原表的「執行／測試人員代碼」欄。本平台的執行者是自動化代理,不是人 ——
 * 留白會讓人以為漏填,填一個人員代碼則是造假,所以明寫是自動化並帶上模型。
 */
function executorOf(report: StructuredReport): string {
  const model = report.header.agentModel ?? report.header.testEngineVersion;
  return `自動化執行(${model ?? DASH})`;
}

/** 由指標 id 推出「統計量」(原表與「統計項目」分開兩欄:要知道這個數字是平均還是最低)。 */
function statisticKindOf(metricId: string): L10n {
  if (/_avg$/.test(metricId)) return L('平均', 'Average');
  if (/_min$/.test(metricId)) return L('最低', 'Minimum');
  if (/_max$|_peak$/.test(metricId)) return L('最高／峰值', 'Maximum / peak');
  if (/_p1$/.test(metricId)) return L('1% 低值', '1% low');
  if (/_p95$/.test(metricId)) return L('P95', 'P95');
  if (/_rate$|_pct$/.test(metricId)) return L('比率', 'Rate');
  if (/_stddev$/.test(metricId)) return L('標準差', 'Standard deviation');
  if (/growth/.test(metricId)) return L('增量', 'Growth');
  if (/per_hour$/.test(metricId)) return L('每小時', 'Per hour');
  if (/_count$|samples$/.test(metricId)) return L('計數', 'Count');
  return L('單一量測值', 'Single measurement');
}

/** 文件標題與群組(19 類全列;順序即交付順序)。 */
const DOC_META: Record<QaDocCode, { title: L10n; group: QaDocGroup }> = {
  T01: { title: L('送測前檢驗', 'Pre-test intake check'), group: 'planning' },
  T02: { title: L('專案測試項目與允收表', 'Project test items and acceptance'), group: 'planning' },
  T03: { title: L('詳細測試項目與執行結果', 'Detailed test items and execution results'), group: 'execution' },
  T04: { title: L('測項會議紀錄', 'Test-item meeting minutes'), group: 'planning' },
  T05: { title: L('問題清單', 'Defect list'), group: 'defects' },
  T06: { title: L('專案問題紀錄表', 'Project defect record'), group: 'defects' },
  T07: { title: L('版本測試結案報告', 'Version test closure report'), group: 'closure' },
  T08: { title: L('送審檢驗表', 'Store submission checklist'), group: 'closure' },
  T09: { title: L('效能測試需求與腳本', 'Performance test requirements and script'), group: 'specialty' },
  T10: { title: L('適配性測試需求', 'Compatibility test requirements'), group: 'specialty' },
  T11: { title: L('自動化測試需求', 'Automation test requirements'), group: 'specialty' },
  T12: { title: L('自動化結果與數據分析', 'Automation results and data analysis'), group: 'specialty' },
  T13: { title: L('效能與自動化專項結案', 'Performance and automation specialty closure'), group: 'specialty' },
  T14: { title: L('使用體驗與白紙研究紀錄', 'Experience and exploratory research record'), group: 'research' },
  T15: { title: L('競品數據與研究分析', 'Competitive data and research analysis'), group: 'research' },
  T16: { title: L('專案訓練需求', 'Project training requirements'), group: 'training' },
  T17: { title: L('第一類訓練考核', 'Training assessment, type 1'), group: 'training' },
  T18: { title: L('第二類訓練考核', 'Training assessment, type 2'), group: 'training' },
  T19: { title: L('測試排程與交付追蹤', 'Test schedule and delivery tracking'), group: 'research' },
};

/** 不可由執行證據推導的文件,各自的原因(輸入本質不是證據)。 */
const NOT_DERIVABLE_REASON: Partial<Record<QaDocCode, L10n>> = {
  T04: L('輸入為測項草稿與規格疑義的討論與決議,屬人工會議紀錄,不由執行證據推導', 'Its inputs are discussion and decisions on draft items and spec queries; it is a human meeting record and cannot be derived from execution evidence'),
  T08: L('輸入為各平台或渠道的送審檢查項,且本表不代替平台正式審查結果;需以送審用例執行後另行填寫', 'Its inputs are per-store submission checks, and it does not substitute for the store review outcome; it must be filled from a dedicated submission run'),
  T09: L('本文件是量測前的需求與腳本(目的、場景、裝置分級),屬測試輸入而非結果', 'This document is the pre-measurement requirement and script (purpose, scenario, device tier) and is a test input rather than a result'),
  T10: L('本文件是相容性測試方案與裝置母體條件,屬測試輸入;單次執行只覆蓋一個裝置組合', 'This document is the compatibility plan and device population criteria, a test input; a single run covers only one device combination'),
  T11: L('本文件是腳本製作需求與可執行性確認,屬測試輸入而非執行結果', 'This document is the script-authoring requirement and feasibility confirmation, a test input rather than an execution result'),
  T14: L('輸入為研究目的、對象與任務觀察,屬人工使用體驗研究紀錄', 'Its inputs are research goals, subjects and task observations; it is a human experience-research record'),
  T15: L('輸入為競品研究對象與逐筆比較資料,不在受測版本的執行證據範圍內', 'Its inputs are competitor subjects and per-record comparisons, outside the execution evidence of the build under test'),
  T16: L('輸入為受訓角色與培訓方向,屬人員訓練規劃', 'Its inputs are trainee roles and training directions; it is personnel training planning'),
  T17: L('輸入為訓練作業與學習成果評分,屬人員考核', 'Its inputs are training assignments and learning outcomes; it is a personnel assessment'),
  T18: L('輸入為訓練作業與學習成果評分,屬人員考核', 'Its inputs are training assignments and learning outcomes; it is a personnel assessment'),
  T19: L('輸入為測試資源、依賴與交付時程,屬排程管理', 'Its inputs are test resources, dependencies and delivery timing; it is schedule management'),
};

function notDerivable(code: QaDocCode): QaDocument {
  const meta = DOC_META[code];
  return {
    code,
    title: meta.title,
    group: meta.group,
    coverage: 'not_derivable',
    reason: NOT_DERIVABLE_REASON[code] ?? L('本文件不由單次執行證據推導', 'This document is not derived from single-run execution evidence'),
    header: [],
    tables: [],
    links: [],
    unfilled: [],
  };
}

/** 共用表頭:專案、版本、平台、裝置。 */
function commonHeader(report: StructuredReport): QaDocField[] {
  const h = report.header;
  return [
    f('project', L('專案代碼', 'Project code'), report.testCase.id),
    f('build', L('受測版本代碼', 'Build under test'), h.gameVersion ?? h.buildNumber),
    f('platform', L('平台', 'Platform'), h.platform),
    f('device', L('裝置', 'Device'), h.device),
    f('caseVersion', L('測項版次', 'Test-item revision'), h.caseVersion),
    f('date', L('製表日期', 'Prepared on'), dateOnly(h.testEndTime ?? h.testStartTime)),
  ];
}

/** T01 送測前檢驗:可測性。受阻時記 BLOCK 並寫出阻擋原因。 */
function buildT01(report: StructuredReport): QaDocument {
  const blocked = report.overallStatus === 'BLOCKED';
  const testable = !blocked;
  const result: QaItemResult = testable ? 'PASS' : 'BLOCK';
  return {
    code: 'T01',
    title: DOC_META.T01.title,
    group: DOC_META.T01.group,
    coverage: 'derived_with_gaps',
    reason: L('可測性結果與阻擋原因由執行證據推導;送測版本的基本操作條件由人工確認', 'Testability and the blocking reason are derived from execution evidence; the basic operating conditions of the submitted build remain a manual confirmation'),
    header: commonHeader(report),
    tables: [
      {
        id: 'intake',
        title: L('工作紀錄', 'Work record'),
        columns: [
          { key: 'no', label: L('編號', 'No.') },
          { key: 'category', label: L('類別', 'Category') },
          { key: 'item', label: L('項目', 'Item') },
          { key: 'purpose', label: L('測試目的', 'Purpose') },
          { key: 'steps', label: L('步驟', 'Steps') },
          { key: 'expected', label: L('預期結果', 'Expected result') },
          { key: 'executor', label: L('執行人員代碼', 'Executed by') },
          { key: 'result', label: L('平台結果', 'Platform result') },
          { key: 'date', label: L('測試日期', 'Test date') },
          { key: 'note', label: L('備註', 'Note') },
        ],
        rows: [
          {
            no: '1',
            category: QA_CATEGORIES[0]!.code,
            item: L('版本可啟動與可測性', 'Build launches and is testable').zh,
            purpose: L('確認本次版本具備展開品檢的執行條件', 'Confirm the build can be put through QA').zh,
            steps: L('安裝並啟動受測版本 → 依案例執行 → 觀察是否走到完成條件', 'Install and launch the build, run the case, and observe whether it reaches the completion condition').zh,
            expected: L('版本可安裝啟動並依案例執行至完成條件', 'The build installs, launches and runs to the case completion condition').zh,
            executor: executorOf(report),
            result: result === 'PASS' ? 'PASS' : 'BLOCK',
            date: dateOnly(report.header.testStartTime),
            note: testable ? DASH : report.statusReason.zh,
          },
        ],
      },
    ],
    links: [
      f('blockReason', L('阻擋原因', 'Blocking reason'), testable ? DASH : report.terminal.message ?? report.statusReason.zh),
      f('env', L('環境代碼', 'Environment code'), report.header.testEnvironment),
      f('evidence', L('證據代碼', 'Evidence reference'), report.header.reportId),
    ],
    unfilled: [L('送測版本的基本操作條件', 'Basic operating conditions of the submitted build')],
  };
}

/** T02 專案測試項目與允收表:一列一個驗收項目。 */
function buildT02(report: StructuredReport, acceptance: Acceptance): QaDocument {
  const rows = acceptance.criteria.map((c, i) => {
    const mapped = qaResultOfCriterion(c.result);
    return {
      no: String(i + 1),
      item: c.title.zh,
      standard: c.threshold?.zh ?? c.requirement.zh,
      actual: c.actual?.zh ?? DASH,
      result: mapped.result === 'NA' ? 'N/A' : mapped.result,
      accept: qaAcceptanceMark(mapped.result),
      level: c.level === 'must' ? L('必要', 'Must').zh : L('建議', 'Should').zh,
      date: dateOnly(report.header.testEndTime),
      tester: executorOf(report),
      note: [mapped.note?.zh, c.note?.zh].filter(Boolean).join(';') || DASH,
    };
  });
  return {
    code: 'T02',
    title: DOC_META.T02.title,
    group: DOC_META.T02.group,
    coverage: 'derived_with_gaps',
    reason: L('測試項目、允收標準、實測結果與允收 Y/N 由驗收判定推導;審核主管允收欄位需人工簽核', 'Items, acceptance criteria, actual results and the Y/N mark are derived from the verdict; the supervisor sign-off field stays manual'),
    header: commonHeader(report),
    tables: [
      {
        id: 'acceptance',
        title: L('工作紀錄', 'Work record'),
        columns: [
          { key: 'no', label: L('NO', 'No.') },
          { key: 'item', label: L('測試項目', 'Test item') },
          { key: 'standard', label: L('允收標準', 'Acceptance criterion') },
          { key: 'actual', label: L('實測結果', 'Actual result') },
          { key: 'result', label: L('結果狀態', 'Result') },
          { key: 'accept', label: L('允收Y或N', 'Accepted Y/N') },
          { key: 'level', label: L('等級', 'Level') },
          { key: 'date', label: L('測試日期', 'Test date') },
          { key: 'tester', label: L('測試人員代碼', 'Tested by') },
          { key: 'note', label: L('備註', 'Note') },
        ],
        rows,
        ...(rows.length ? {} : { emptyReason: L('本次執行未產生驗收項目', 'This run produced no acceptance criteria') }),
      },
    ],
    links: [
      f('standard', L('採用標準版次', 'Standard revision'), acceptance.standard),
      f('decidedBy', L('決定結論的項目', 'Criteria that decided the verdict'), acceptance.decidedBy.join('、')),
      f('requirementBase', L('需求基準代碼', 'Requirement baseline'), report.header.caseVersion ?? report.testCase.version),
      f('caseFile', L('測項檔案代碼', 'Test-item file'), report.testCase.id),
      f('build', L('受測版本代碼', 'Build under test'), report.header.gameVersion ?? report.header.buildNumber),
    ],
    unfilled: [L('審核主管代碼與允收簽核', 'Reviewing supervisor and sign-off')],
  };
}

/** T03 詳細測試項目與執行結果:一列一個逐步判定。 */
function buildT03(report: StructuredReport): QaDocument {
  /**
   * 原表一列同時記兩個平台(平台A／平台B)。一次執行只涵蓋一個平台,
   * 所以平台A填本次結果,平台B一律「未測」並附理由 —— 讓那一欄消失會讓讀者
   * 以為本表已涵蓋兩個平台(原始紀錄就警告過:一個平台的 PASS 不能推定另一個平台已測)。
   */
  const platformA = report.header.platform ?? report.header.device ?? L('本次受測平台', 'Platform under test').zh;
  const executor = executorOf(report);
  const notTestedB = L('未測', 'Not tested').zh;

  const rows = report.checks.map((c: CheckItem, i) => {
    const mapped = qaResultOfCheck(c.result);
    const text = [c.screen, c.module ?? '', c.action, c.expected].join(' ');
    const category = qaCategoryOf(text);
    const cross = qaCrossTagsOf(text)
      .map((id) => QA_CROSS_TAGS.find((t) => t.id === id)?.label.zh)
      .filter(Boolean)
      .join('／');
    return {
      no: String(i + 1),
      category: `${category.code} ${category.label.zh}`,
      cross: cross || DASH,
      item: c.title?.zh ?? c.screen,
      purpose: c.action,
      steps: `${c.screen} → ${c.action}`,
      expected: c.expected,
      executor,
      resultA: mapped.result === 'NA' ? 'N/A' : mapped.result,
      resultB: notTestedB,
      actual: c.actual ?? DASH,
      basis: c.basis === 'deterministic' ? L('程式判定', 'Deterministic').zh : L('AI 判讀', 'AI evaluation').zh,
      defect: c.relatedFinding ?? DASH,
      date: dateOnly(report.header.testStartTime),
      note: [mapped.note?.zh, c.reason].filter(Boolean).join(';') || DASH,
    };
  });
  return {
    code: 'T03',
    title: DOC_META.T03.title,
    group: DOC_META.T03.group,
    coverage: 'derived_with_gaps',
    reason: L('一次執行只涵蓋一個平台:平台A為本次受測平台,平台B全列未測,須另一次執行才能填', 'A single run covers one platform: platform A is the one under test and platform B is left as not tested, which requires a separate run'),
    header: [
      ...commonHeader(report),
      f('platformA', L('平台A', 'Platform A'), platformA),
      f('platformB', L('平台B', 'Platform B'), L('未測(本次未涵蓋)', 'Not tested (not covered by this run)').zh),
    ],
    tables: [
      {
        id: 'checks',
        title: L('工作紀錄', 'Work record'),
        columns: [
          { key: 'no', label: L('編號', 'No.') },
          { key: 'category', label: L('類別', 'Category') },
          { key: 'cross', label: L('交叉條件標籤', 'Cross-cutting tags') },
          { key: 'item', label: L('項目', 'Item') },
          { key: 'purpose', label: L('測試目的', 'Purpose') },
          { key: 'steps', label: L('步驟', 'Steps') },
          { key: 'expected', label: L('預期結果', 'Expected result') },
          { key: 'executor', label: L('執行人員代碼', 'Executed by') },
          { key: 'resultA', label: L('平台A結果', 'Platform A result') },
          { key: 'resultB', label: L('平台B結果', 'Platform B result') },
          { key: 'actual', label: L('實際結果', 'Actual result') },
          { key: 'basis', label: L('判定依據', 'Basis') },
          { key: 'defect', label: L('缺陷代碼', 'Defect ID') },
          { key: 'date', label: L('測試日期', 'Test date') },
          { key: 'note', label: L('備註', 'Note') },
        ],
        rows,
        ...(rows.length ? {} : { emptyReason: L('本次執行未產生逐步判定', 'This run produced no step-level checks') }),
      },
    ],
    links: [
      f('stage', L('階段', 'Stage'), report.testCase.category),
      f('requirement', L('需求代碼', 'Requirement reference'), report.testCase.id),
      f('env', L('環境代碼', 'Environment code'), report.header.testEnvironment),
      f('defects', L('缺陷代碼', 'Defect references'), report.findings.map((d) => d.id).join('、')),
      f('evidence', L('證據代碼', 'Evidence reference'), report.header.reportId),
      f('engine', L('測試引擎版次', 'Test engine version'), report.header.testEngineVersion),
    ],
    unfilled: [L('平台B的執行結果(須另一次執行)', 'Platform B results (requires a separate run)')],
  };
}

/** T05 問題清單:一列一個遊戲缺陷,附 A~D 級與 E0~E3 發現分級。 */
function buildT05(report: StructuredReport): QaDocument {
  const rows = report.findings.map((d: Finding, i) => {
    const grade = qaGradeOf(d.severity);
    const discovery = qaDiscoveryOf(d);
    const gradeLabel = QA_GRADE_LEGEND.find((g) => g.grade === grade)!.label.zh;
    return {
      no: String(i + 1),
      id: d.id,
      summary: d.title.zh,
      severity: gradeLabel,
      priority: PRIORITY_OF_GRADE[grade],
      discovery: `${discovery.grade}(${discovery.reason.zh})`,
      frequency: `${FREQUENCY_LABEL[d.reproducibility].zh}(本次出現 ${d.frequency} 次)`,
      reportedOn: dateOnly(report.header.testEndTime ?? report.header.testStartTime),
      module: d.module ?? DASH,
      analysis: d.suspectedCause?.zh ?? DASH,
      status: L('未處理(本次執行開立)', 'Open (raised by this run)').zh,
      basis: d.certainty === 'deterministic' ? L('程式判定', 'Deterministic').zh : L('AI 判讀,待人工確認', 'AI evaluation, pending manual confirmation').zh,
      detail: d.description.zh,
      note: d.suggestion?.zh ?? DASH,
    };
  });
  const aiRows = report.aiFailures.map((d: Finding, i) => ({
    no: String(i + 1),
    id: d.id,
    summary: d.title.zh,
    severity: QA_GRADE_LEGEND.find((g) => g.grade === qaGradeOf(d.severity))!.label.zh,
    detail: d.description.zh,
  }));
  return {
    code: 'T05',
    title: DOC_META.T05.title,
    group: DOC_META.T05.group,
    coverage: 'derived_with_gaps',
    reason: L('問題摘要、嚴重性、發現分級與頻率由證據推導;分配給、修正版本與複驗版本屬後續版本資訊', 'Summary, severity, discovery grade and frequency are derived from evidence; assignee, fix build and retest build belong to later versions'),
    header: [
      ...commonHeader(report),
      // 清單版次:一次執行產生一份清單,以報告代碼作為版次依據(不另造流水號)。
      f('listRevision', L('清單版次', 'List revision'), report.header.reportId),
      f('total', L('缺陷總數', 'Total defects'), report.findings.length),
      f('byGrade', L('分級統計', 'By grade'), QA_GRADE_LEGEND.map((g) => `${g.grade}:${report.findings.filter((d) => qaGradeOf(d.severity) === g.grade).length}`).join(' / ')),
    ],
    tables: [
      {
        id: 'defects',
        title: L('工作紀錄', 'Work record'),
        columns: [
          { key: 'no', label: L('編號', 'No.') },
          { key: 'id', label: L('問題代碼', 'Defect ID') },
          { key: 'summary', label: L('摘要', 'Summary') },
          { key: 'severity', label: L('嚴重性', 'Severity') },
          { key: 'priority', label: L('優先權(由嚴重性推導)', 'Priority (derived from severity)') },
          { key: 'discovery', label: L('BUG發現分級', 'Discovery grade') },
          { key: 'frequency', label: L('出現頻率', 'Frequency') },
          { key: 'reportedOn', label: L('回報日期', 'Reported on') },
          { key: 'module', label: L('模組', 'Module') },
          { key: 'analysis', label: L('問題分析', 'Analysis') },
          { key: 'status', label: L('狀態', 'Status') },
          { key: 'basis', label: L('判定依據', 'Basis') },
          { key: 'detail', label: L('說明', 'Detail') },
          { key: 'note', label: L('備註', 'Note') },
        ],
        rows,
        ...(rows.length ? {} : { emptyReason: L('本次執行未開立遊戲缺陷', 'This run raised no game defects') }),
      },
      {
        id: 'ai_failures',
        title: L('測試工具問題(不計入遊戲缺陷)', 'Test-tool problems (not counted as game defects)'),
        columns: [
          { key: 'no', label: L('編號', 'No.') },
          { key: 'id', label: L('代碼', 'ID') },
          { key: 'summary', label: L('摘要', 'Summary') },
          { key: 'severity', label: L('嚴重性', 'Severity') },
          { key: 'detail', label: L('說明', 'Detail') },
        ],
        rows: aiRows,
        ...(aiRows.length
          ? {}
          : { emptyReason: L('本次執行未發現測試工具問題', 'This run found no test-tool problems') }),
      },
    ],
    links: [
      f('case', L('案例代碼', 'Case reference'), report.testCase.id),
      f('firstBuild', L('初測版本', 'Initial build'), report.header.gameVersion ?? report.header.buildNumber),
      f('evidence', L('證據代碼', 'Evidence reference'), report.header.reportId),
    ],
    unfilled: [
      L('回報人代碼與分配給代碼', 'Reporter and assignee'),
      L('修正版本與複驗版本', 'Fix build and retest build'),
    ],
  };
}

/** T06 專案問題紀錄表:問題描述與處理追蹤(解決方式需後續版本)。 */
function buildT06(report: StructuredReport): QaDocument {
  const rows = report.findings.map((d, i) => ({
    no: String(i + 1),
    description: d.title.zh,
    severity: QA_GRADE_LEGEND.find((g) => g.grade === qaGradeOf(d.severity))!.label.zh,
    filedOn: dateOnly(report.header.testEndTime),
    resolution: DASH,
    confirmedOn: DASH,
    case: d.relatedTestCase ?? report.testCase.id,
  }));
  return {
    code: 'T06',
    title: DOC_META.T06.title,
    group: DOC_META.T06.group,
    coverage: 'derived_with_gaps',
    reason: L('問題描述與填寫日期由本次執行推導;解決方式、修改人員與確認日期須於修正後補填', 'Descriptions and filing dates come from this run; resolution, fixer and confirmation date must be filled after the fix'),
    header: [
      ...commonHeader(report),
      f('stage', L('測試階段', 'Test stage'), report.testCase.category),
      f('revision', L('版次', 'Revision'), report.header.reportId),
      f('page', L('頁次', 'Page'), '1 / 1'),
    ],
    tables: [
      {
        id: 'records',
        title: L('工作紀錄', 'Work record'),
        columns: [
          { key: 'no', label: L('NO', 'No.') },
          { key: 'description', label: L('問題描述或建議內容', 'Problem or suggestion') },
          { key: 'severity', label: L('嚴重性', 'Severity') },
          { key: 'filedOn', label: L('填寫日期', 'Filed on') },
          { key: 'resolution', label: L('解決方式', 'Resolution') },
          { key: 'confirmedOn', label: L('確認日期', 'Confirmed on') },
          { key: 'case', label: L('對應案例', 'Related case') },
        ],
        rows,
        ...(rows.length ? {} : { emptyReason: L('本次執行未開立問題', 'This run raised no problems') }),
      },
    ],
    links: [f('defectList', L('缺陷清單代碼', 'Defect list reference'), report.header.reportId)],
    unfilled: [
      L('發現人員代碼與修改人員代碼', 'Finder and fixer'),
      L('解決方式與確認日期', 'Resolution and confirmation date'),
      L('修正或複驗證據', 'Fix or retest evidence'),
    ],
  };
}

/** T07 版本測試結案報告:範圍、用例結果摘要、缺陷摘要、結論。 */
function buildT07(report: StructuredReport, stats: QaStatistic[]): QaDocument {
  const c = report.counts;
  const resultRows = QA_RESULT_LEGEND.map((legend) => {
    const count =
      legend.result === 'PASS' ? c.passed
        : legend.result === 'FAIL' ? c.failed
          : legend.result === 'BLOCK' ? c.unclear + c.skipped + c.blocked
            : report.scope.filter((s) => s.status === 'not_applicable').length;
    return {
      result: legend.result === 'NA' ? 'N/A' : legend.result,
      definition: legend.definition.zh,
      count: String(count),
      source:
        legend.result === 'BLOCK'
          ? L('含待判讀、無法判定與受阻', 'Includes indeterminate, unjudgeable and blocked').zh
          : legend.result === 'NA'
            ? L('本次範圍標為不適用的範疇數', 'Scopes marked not applicable for this run').zh
            : L('判定明細列數', 'Rows in the check detail').zh,
    };
  });
  const statRows = stats.map((s) => ({
    metric: s.label.zh,
    formula: s.formula.zh,
    numerator: s.numerator === null ? DASH : String(s.numerator),
    denominator: s.denominator === null ? DASH : String(s.denominator),
    value: s.value === null ? DASH : `${s.value}%`,
    basis: s.basis.zh,
    caveat: s.caveat.zh,
  }));
  const notTested = report.scope.filter((s) => s.status !== 'executed');
  return {
    code: 'T07',
    title: DOC_META.T07.title,
    group: DOC_META.T07.group,
    coverage: 'derived_with_gaps',
    reason: L('測試範圍、用例與缺陷統計、限制與結論由本次執行推導;工時與技術服務單代碼屬專案管理資訊', 'Scope, case and defect statistics, limitations and the conclusion come from this run; effort hours and the service-ticket code are project-management data'),
    header: [
      ...commonHeader(report),
      f('verdict', L('測試結論', 'Verdict'), report.overallStatus),
      f('verdictReason', L('結論理由', 'Verdict reason'), report.statusReason.zh),
      f('readiness', L('發布建議', 'Release readiness'), report.release.readiness),
      f('duration', L('測試時間', 'Test window'), `${report.header.testStartTime ?? DASH} ~ ${report.header.testEndTime ?? DASH}`),
    ],
    tables: [
      {
        id: 'claim_envelope',
        title: L('測試範圍(實際受測組合)', 'Test scope (the combination actually exercised)'),
        columns: [
          { key: 'dimension', label: L('維度', 'Dimension') },
          { key: 'value', label: L('本次受測值', 'Value exercised') },
          { key: 'observed', label: L('已觀測', 'Observed') },
        ],
        rows: (report.claimScope?.envelope ?? []).map((e) => ({
          dimension: e.label.zh,
          value: e.value,
          observed: e.observed ? 'Y' : 'N',
        })),
        ...(report.claimScope?.envelope?.length
          ? {}
          : { emptyReason: L('本報告未產生適用邊界(舊版報告)', 'This report carries no claim scope (legacy report)') }),
      },
      {
        id: 'platform_capability',
        title: L('本平台的可執行範圍(依測項分類)', 'What this platform can execute, by test-item category'),
        columns: [
          { key: 'code', label: L('分類', 'Category') },
          { key: 'name', label: L('名稱', 'Name') },
          { key: 'level', label: L('可執行性', 'Capability') },
          { key: 'covers', label: L('做得到', 'Covered') },
          { key: 'gap', label: L('做不到與原因', 'Gap and why') },
          { key: 'fallback', label: L('缺口怎麼補', 'How to cover the gap') },
        ],
        // 分類數不等於測項數:這張表說明「哪些類做不到」,實際影響要用專案自己的測項庫按類統計。
        rows: CATEGORY_CAPABILITY.map((c) => ({
          code: c.code,
          name: QA_CATEGORIES.find((x) => x.code === c.code)?.label.zh ?? DASH,
          level: CAPABILITY_LABEL[c.level].zh,
          covers: c.covers.zh,
          gap: c.gap?.zh ?? DASH,
          fallback: c.fallback?.zh ?? DASH,
        })),
      },
      {
        id: 'claim_limits',
        title: L('不得延伸的主張', 'Claims the evidence does not support'),
        columns: [
          { key: 'dimension', label: L('未變動的維度', 'Dimension not varied') },
          { key: 'note', label: L('說明', 'Note') },
        ],
        rows: (report.claimScope?.notVaried ?? []).map((n) => ({ dimension: n.label.zh, note: n.note.zh })),
        ...(report.claimScope?.notVaried?.length
          ? {}
          : { emptyReason: L('本報告未產生適用邊界(舊版報告)', 'This report carries no claim scope (legacy report)') }),
      },
      {
        id: 'case_summary',
        title: L('用例結果摘要', 'Case result summary'),
        columns: [
          { key: 'result', label: L('結果狀態', 'Result') },
          { key: 'definition', label: L('來源定義', 'Definition') },
          { key: 'count', label: L('列數', 'Count') },
          { key: 'source', label: L('納入範圍', 'Inclusion') },
        ],
        rows: resultRows,
      },
      {
        id: 'defect_summary',
        title: L('缺陷摘要', 'Defect summary'),
        columns: [
          { key: 'grade', label: L('分級', 'Grade') },
          { key: 'definition', label: L('來源定義', 'Definition') },
          { key: 'count', label: L('數量', 'Count') },
        ],
        rows: QA_GRADE_LEGEND.map((g) => ({
          grade: g.label.zh,
          definition: g.definition.zh,
          count: String(report.findings.filter((d) => qaGradeOf(d.severity) === g.grade).length),
        })),
      },
      {
        id: 'statistics',
        title: L('原有統計指標', 'Original statistics'),
        columns: [
          { key: 'metric', label: L('指標', 'Metric') },
          { key: 'formula', label: L('來源公式', 'Formula') },
          { key: 'numerator', label: L('分子', 'Numerator') },
          { key: 'denominator', label: L('分母', 'Denominator') },
          { key: 'value', label: L('值', 'Value') },
          { key: 'basis', label: L('納入範圍', 'Inclusion') },
          { key: 'caveat', label: L('定義界線', 'Boundary') },
        ],
        rows: statRows,
      },
      {
        id: 'known_issues',
        title: L('已知問題與建議', 'Known issues and recommendations'),
        columns: [
          { key: 'source', label: L('來源', 'Source') },
          { key: 'id', label: L('代碼', 'ID') },
          { key: 'level', label: L('分級', 'Level') },
          { key: 'summary', label: L('內容', 'Item') },
          { key: 'suggestion', label: L('建議', 'Recommendation') },
        ],
        // 已知問題 = 本次開立的缺陷(含修正建議);另附規則引擎算出的風險。
        rows: [
          ...report.findings.map((d) => ({
            source: L('缺陷', 'Defect').zh,
            id: d.id,
            level: QA_GRADE_LEGEND.find((g) => g.grade === qaGradeOf(d.severity))!.label.zh,
            summary: d.title.zh,
            suggestion: d.suggestion?.zh ?? DASH,
          })),
          ...report.risks.map((r) => ({
            source: L('風險', 'Risk').zh,
            id: r.id,
            level: QA_GRADE_LEGEND.find((g) => g.grade === qaGradeOf(r.level))!.label.zh,
            summary: `${r.title.zh}(${r.evidence.zh})`,
            suggestion: r.impact.zh,
          })),
        ],
        ...(report.findings.length || report.risks.length
          ? {}
          : { emptyReason: L('本次執行未開立缺陷,也未觸發風險規則', 'This run raised no defects and triggered no risk rules') }),
      },
      {
        id: 'not_tested',
        title: L('未測或阻擋理由', 'Not tested or blocked'),
        columns: [
          { key: 'scope', label: L('測試範疇', 'Scope') },
          { key: 'status', label: L('狀態', 'Status') },
          { key: 'detectable', label: L('平台可偵測', 'Platform can detect') },
          { key: 'reason', label: L('理由', 'Reason') },
        ],
        // 「這次沒走到」與「平台收不到這類證據」要分開:後者重測也不會有,屬工具缺口。
        rows: notTested.map((s) => ({
          scope: s.id,
          status: s.status,
          detectable: s.detectable === false ? 'N' : 'Y',
          reason: s.reason?.zh ?? DASH,
        })),
        ...(notTested.length ? {} : { emptyReason: L('本次範圍全部執行', 'Every selected scope was executed') }),
      },
    ],
    links: [
      f('cutoff', L('統計截止點', 'Statistics cut-off'), report.claimScope?.cutoff ?? report.header.testEndTime),
      f('defectList', L('問題清單代碼', 'Defect list reference'), report.header.reportId),
      // 複驗鏈是跨版本的,不在單次執行的證據範圍內;它由案例趨勢(trends.ts)跨任務彙整。
      f('retestChain', L('複驗鏈', 'Retest chain'), L('見案例趨勢的修正複驗鏈(跨版本彙整,不在單次報告內)', 'See the retest chain in the case trend (aggregated across builds, not inside a single report)').zh),
      f('standard', L('採用標準版次', 'Standard revision'), `${QA_DOC_STANDARD_TAG} / ${report.acceptance.standard}`),
    ],
    unfilled: [
      L('技術服務單代碼與工時', 'Service-ticket code and effort hours'),
      L('例外與正式放行決策', 'Exceptions and the formal release decision'),
    ],
  };
}

/** T12 自動化結果與數據分析:逐筆結果、分析資料、執行摘要。 */
function buildT12(report: StructuredReport): QaDocument {
  /**
   * 逐筆結果是一份**逐局帳**:資產前、本局操作值(下注)、累積操作值、結果值(派彩)。
   * 由 spinTransactions() 重建 —— 它已經處理掉 AutoSpin 累計、Bonus 結算與未靜止的讀值,
   * 那些回合的數字不能當成單局結果。重建不出來(非拉霸玩法)就說明原因,不改用步驟傾印充數。
   */
  const txns = spinTransactions(report.evidence);
  const byStep = new Map(report.evidence.map((s) => [s.index, s]));
  let cumulative = 0;
  const perRun = txns.map((t, i) => {
    cumulative += t.bet;
    const s = byStep.get(t.step);
    const o = s?.obs ?? {};
    const pick = (...keys: string[]) => {
      for (const k of keys) {
        const v = o[k];
        if (v !== undefined && v !== null && String(v) !== '') return String(v);
      }
      return DASH;
    };
    // 資產前 = 本局結算後的餘額 − 本局派彩 + 本局下注(讀到餘額才算,算不出就留白)。
    const before = typeof t.balance === 'number' ? t.balance - t.win + t.bet : null;
    return {
      seq: String(i + 1),
      game: pick('game_kind', 'machine_kind'),
      at: s?.at ?? DASH,
      level: pick('level', 'stage', 'wave'),
      state: s?.screen ?? DASH,
      before: before === null ? DASH : String(before),
      bet: String(t.bet),
      cumulative: String(cumulative),
      result: String(t.win),
      specialA: pick('free_spins', 'free_game'),
      specialB: pick('bonus', 'feature'),
      specialC: pick('jackpot', 'non_slot_credit'),
      // 遞推鏈斷掉的那一筆,累積值與前後局不連續,必須標出來。
      note: t.contiguous === false ? L('與前一筆之間有未納入的餘額變動,累積值不連續', 'A balance change not included sits between this and the previous row; the cumulative figure is not continuous').zh : DASH,
    };
  });
  const analysis = report.metrics.map((m) => ({
    item: m.label.zh,
    unit: m.unit || DASH,
    value: m.value === null ? DASH : String(m.value),
    status: m.status === 'ok' ? L('已收集', 'Collected').zh : L('未收集(不以 0 充數)', 'Not collected (not substituted with 0)').zh,
    source: m.source === 'objective' ? L('程式計算', 'Computed').zh : L('AI 觀察彙總', 'Aggregated AI observation').zh,
    scope: m.profile,
  }));
  const excluded = report.dataQuality?.excluded ?? [];
  return {
    code: 'T12',
    title: DOC_META.T12.title,
    group: DOC_META.T12.group,
    coverage: 'derived',
    header: [
      ...commonHeader(report),
      f('period', L('測試期間', 'Test period'), `${report.header.testStartTime ?? DASH} ~ ${report.header.testEndTime ?? DASH}`),
      f('targetEffective', L('目標有效量', 'Target effective volume'), report.counts.totalChecks),
      f('actualEffective', L('實際有效量', 'Actual effective volume'), report.counts.executedChecks),
      f('abort', L('異常或中止', 'Abort or anomaly'), report.terminal.message ?? DASH),
    ],
    tables: [
      {
        id: 'per_run',
        title: L('逐筆結果', 'Per-record results'),
        columns: [
          { key: 'seq', label: L('項次', 'Seq') },
          { key: 'game', label: L('遊戲代碼', 'Game') },
          { key: 'at', label: L('測試時間', 'Timestamp') },
          { key: 'level', label: L('等級代碼', 'Level') },
          { key: 'state', label: L('遊戲狀態', 'Game state') },
          { key: 'before', label: L('資產前', 'Balance before') },
          { key: 'bet', label: L('操作數值', 'Stake') },
          { key: 'cumulative', label: L('累積操作值', 'Cumulative stake') },
          { key: 'result', label: L('結果值', 'Result value') },
          { key: 'specialA', label: L('特殊結果A', 'Special result A') },
          { key: 'specialB', label: L('特殊結果B', 'Special result B') },
          { key: 'specialC', label: L('特殊結果C', 'Special result C') },
          { key: 'note', label: L('備註', 'Note') },
        ],
        rows: perRun,
        ...(perRun.length
          ? {}
          : {
              emptyReason: L(
                '本次執行重建不出逐局帳(非拉霸玩法,或下注與派彩未逐局讀到);逐步證據見報告的逐步證據章節',
                'No per-round ledger could be reconstructed for this run (not a spin-based game, or stake and payout were not read per round); step-level evidence is in the report\u2019s evidence section',
              ),
            }),
      },
      {
        id: 'analysis',
        title: L('分析資料', 'Analysis data'),
        columns: [
          { key: 'item', label: L('分析項目', 'Analysis item') },
          { key: 'unit', label: L('單位', 'Unit') },
          { key: 'value', label: L('值', 'Value') },
          { key: 'status', label: L('分析狀態', 'Status') },
          { key: 'source', label: L('指標來源', 'Source') },
          { key: 'scope', label: L('資料範圍', 'Data scope') },
        ],
        rows: analysis,
        ...(analysis.length ? {} : { emptyReason: L('本次執行未產生指標', 'This run produced no metrics') }),
      },
      {
        id: 'excluded',
        title: L('排除的讀錯值', 'Excluded misread values'),
        columns: [
          { key: 'step', label: L('項次', 'Seq') },
          { key: 'key', label: L('欄位', 'Field') },
          { key: 'value', label: L('原值', 'Original value') },
          { key: 'reason', label: L('排除原因', 'Reason') },
        ],
        rows: excluded.map((e) => ({ step: String(e.step), key: e.key, value: String(e.value), reason: e.reason.zh })),
        ...(excluded.length ? {} : { emptyReason: L('本次執行無排除值', 'No values were excluded in this run') }),
      },
    ],
    links: [
      f('run', L('run代碼', 'Run reference'), report.header.reportId),
      f('effective', L('有效量', 'Effective volume'), report.counts.executedChecks),
      f('abortReason', L('中止原因', 'Abort reason'), report.terminal.state),
      f('rawEvidence', L('原始證據代碼', 'Raw evidence reference'), report.header.reportId),
    ],
    unfilled: [],
  };
}

/** T13 效能與自動化專項結案:分裝置指標、門檻與判定。沒有效能取樣就不產生此文件的工作紀錄。 */
function buildT13(report: StructuredReport): QaDocument {
  const perfMetrics = report.metrics.filter((m) => m.group === 'performance' || m.group === 'stability');
  /**
   * 可否產生專項結案,只看有沒有「量測到的效能指標」。
   * 穩定性群組(例如閃退次數)就算沒有裝置取樣也一定算得出來,拿它當依據會讓
   * 每次執行都長出一份沒有量測值的專項結案 —— 那是硬填,不是交付。
   */
  const measured = report.metrics.filter((m) => m.group === 'performance' && m.status === 'ok');
  const collected = measured;
  const thresholds = report.release.thresholds;
  const rows = perfMetrics.map((m) => {
    const hit = report.release.hits.find((h) => h.metric === m.id);
    const threshold = hit ? `${hit.op} ${hit.threshold}` : (thresholds[m.id] !== undefined ? String(thresholds[m.id]) : DASH);
    const result: QaItemResult = m.status !== 'ok' ? 'BLOCK' : hit ? 'FAIL' : 'PASS';
    return {
      device: report.header.device ?? DASH,
      item: m.label.zh,
      // 原表把「統計項目」與「統計量」分成兩欄:要看得出這個數字是平均、最低還是 P95。
      statistic: statisticKindOf(m.id).zh,
      unit: m.unit || DASH,
      threshold,
      actual: m.value === null ? DASH : String(m.value),
      result,
      note:
        m.status !== 'ok'
          ? L('未收集到此指標,不判定', 'This metric was not collected; no judgement is made').zh
          : hit
            ? hit.reason.zh
            : DASH,
    };
  });
  return {
    code: 'T13',
    title: DOC_META.T13.title,
    group: DOC_META.T13.group,
    coverage: collected.length ? 'derived_with_gaps' : 'not_derivable',
    reason: collected.length
      ? L('分裝置指標、實測值與門檻比較由本次量測推導;核定標準值未由知識庫提供時不判定,裝置分級與取樣期間須隨報告確認', 'Per-device metrics, measured values and threshold comparisons come from this run; without an approved target from the knowledge base no judgement is made, and device tier and sampling window must be confirmed per report')
      : L('本次執行未收集到效能或穩定性指標,不產生專項結案', 'This run collected no performance or stability metrics, so no specialty closure is produced'),
    header: collected.length
      ? [
          ...commonHeader(report),
          f('scenario', L('測試場景', 'Test scenario'), report.testCase.name),
          f('deviceTier', L('裝置分級', 'Device tier'), DASH),
          f('samples', L('有效執行量', 'Effective volume'), report.counts.executedChecks),
        ]
      : [],
    tables: collected.length
      ? [
          {
            id: 'perf',
            title: L('工作紀錄', 'Work record'),
            columns: [
              { key: 'device', label: L('裝置代碼', 'Device') },
              { key: 'item', label: L('統計項目', 'Metric') },
              { key: 'statistic', label: L('統計量', 'Statistic') },
              { key: 'unit', label: L('單位', 'Unit') },
              { key: 'threshold', label: L('核定標準值', 'Approved target') },
              { key: 'actual', label: L('實測值', 'Measured value') },
              { key: 'result', label: L('測試結果', 'Result') },
              { key: 'note', label: L('備註', 'Note') },
            ],
            rows,
          },
        ]
      : [],
    links: collected.length
      ? [
          f('method', L('量測方法代碼', 'Measurement method'), report.header.testEngineVersion),
          f('raw', L('原始資料代碼', 'Raw data reference'), report.header.reportId),
          f('effective', L('有效執行量', 'Effective volume'), report.counts.executedChecks),
          f(
            'analysisState',
            L('分析完成狀態', 'Analysis state'),
            perfMetrics.some((m) => m.status !== 'ok')
              ? L(`部分指標未收集(${perfMetrics.filter((m) => m.status !== 'ok').length}/${perfMetrics.length})`, `Some metrics were not collected (${perfMetrics.filter((m) => m.status !== 'ok').length}/${perfMetrics.length})`).zh
              : L('全部指標已收集並完成分析', 'All metrics were collected and analysed').zh,
          ),
        ]
      : [],
    unfilled: collected.length
      ? [
          L('核定指標與門檻來源(須由知識庫提供)', 'Approved metrics and threshold source (must come from the knowledge base)'),
          L('裝置分級、量測工具與取樣期間', 'Device tier, measurement tool and sampling window'),
        ]
      : [],
  };
}

const DERIVED_ORDER: QaDocCode[] = ['T01', 'T02', 'T03', 'T05', 'T06', 'T07', 'T12', 'T13'];
const ALL_CODES: QaDocCode[] = [
  'T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08', 'T09', 'T10',
  'T11', 'T12', 'T13', 'T14', 'T15', 'T16', 'T17', 'T18', 'T19',
];

/**
 * 把一份 StructuredReport 投影成完整的 19 類交付文件集。
 * 無法由執行證據推導的文件仍會出現,帶 not_derivable 與原因。
 */
/** 被截斷時,完整資料的所在章節(讓讀者找得到,不是只說「已截斷」)。 */
const FULL_SOURCE: Record<string, L10n> = {
  checks: L('報告的判定明細章節', 'the check-detail section of the report'),
  per_run: L('報告的逐步證據章節', 'the step-evidence section of the report'),
  defects: L('報告的缺陷章節', 'the defects section of the report'),
  analysis: L('報告的指標章節', 'the metrics section of the report'),
  excluded: L('報告的數據品質章節', 'the data-quality section of the report'),
  records: L('報告的缺陷章節', 'the defects section of the report'),
  acceptance: L('報告的驗收結論章節', 'the acceptance section of the report'),
};

export function buildQaDocumentSet(report: StructuredReport, opts: QaDocOptions = {}): QaDocumentSet {
  const statistics = buildQaStatistics(report, opts);
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  const built = new Map<QaDocCode, QaDocument>();
  built.set('T01', buildT01(report));
  built.set('T02', buildT02(report, report.acceptance));
  built.set('T03', buildT03(report));
  built.set('T05', buildT05(report));
  built.set('T06', buildT06(report));
  built.set('T07', buildT07(report, statistics));
  built.set('T12', buildT12(report));
  built.set('T13', buildT13(report));

  const documents = ALL_CODES.map((code) => built.get(code) ?? notDerivable(code)).map((doc) => ({
    ...doc,
    tables: doc.tables.map((t) => capRows(t, maxRows, FULL_SOURCE[t.id] ?? L('報告本文', 'the report body'))),
  }));
  const coverageSummary: Record<QaDocCoverage, number> = { derived: 0, derived_with_gaps: 0, not_derivable: 0 };
  for (const d of documents) coverageSummary[d.coverage]++;

  return {
    standard: QA_DOC_STANDARD_TAG,
    generatedAt: opts.generatedAt ?? report.header.testEndTime ?? report.header.testStartTime ?? '',
    internalStandard: report.acceptance.standard,
    resultLegend: QA_RESULT_LEGEND,
    gradeLegend: QA_GRADE_LEGEND,
    discoveryLegend: QA_DISCOVERY_LEGEND,
    statistics,
    documents,
    coverageSummary,
    notes: [
      L('本文件集是內部判定結果的重新表述,不是另一次判定;結論仍以驗收標準為準。', 'This document set restates the internal verdict; it is not a second judgement. The verdict remains the one set by the acceptance standard.'),
      L('未執行與無資料不填 PASS:待判讀、無法判定與未執行一律列為 BLOCK,原判定保留在備註。', 'Not-executed and no-data rows are never recorded as PASS: indeterminate, unjudgeable and not-executed rows are all BLOCK, with the original judgement kept in the note.'),
      L('優先權由嚴重性推導,原文件由人工填寫;分級統計不等於實際修復數。', 'Priority is derived from severity, whereas the original document is filled in manually; grade counts are not a count of actual repairs.'),
      L(`${documents.filter((d) => d.coverage === 'not_derivable').length} 類文件的輸入不是執行證據(會議、計畫、研究、訓練與排程),已逐類列出原因而非省略。`, `${documents.filter((d) => d.coverage === 'not_derivable').length} document types take inputs that are not execution evidence (meetings, plans, research, training and scheduling); each is listed with its reason rather than omitted.`),
      capabilitySummary().note,
      L('結案報告附「本平台的可執行範圍」:做不到的分類逐類列出原因與補法。一份全綠的報告如果涵蓋的只是測試實務的一部分,而缺口沒寫出來,會被當成放行依據。', 'The closure report carries a statement of what this platform can execute, listing each out-of-reach category with its reason and the fallback. An all-green report that covers only part of the testing practice, with the gaps unstated, gets read as grounds for release.'),
    ],
  };
}

export { DERIVED_ORDER as QA_DERIVED_DOC_ORDER, ALL_CODES as QA_DOC_CODES };
