/**
 * 驗收標準(PlayAgent Acceptance Standard, PA-AS)—— 一次測試只有一個結論,列表、任務詳情、報告都讀這裡。
 *
 * 結論(對齊 ISTQB 的測試判定用語;BLOCKED = 測試無法得出結論):
 *  - FAIL            有「必要」驗收項目不通過,且歸因是遊戲本身(確定性證據或已確認的遊戲缺陷)。
 *  - BLOCKED         有「必要」項目不通過或無法判定,但原因不是遊戲(執行未依協定、環境、AI 代理、數據不可溯源)
 *                    —— 這次的結果不能拿來驗收,需重測或人工判讀。
 *  - PASS_WITH_RISK  必要項目全部通過,但「建議」項目不通過、或有待判讀異常 / 高風險。
 *  - PASS            全部通過。
 * 優先序:FAIL > BLOCKED > PASS_WITH_RISK > PASS(遊戲缺陷一經確認就要讓人看到,即使測試沒跑完)。
 *
 * 每個項目都附:要求來源(案例原文 / 標準)、門檻、實際值、證據步驟(可點到截圖)、判定依據(確定性 / AI 判讀)。
 * 純函式、確定性:同一份證據永遠得到同一個結論。
 */
import type { DataQuality } from './dataQuality.js';
import { buildRtpLedger, ESTIMATE_RE, type RtpLedger } from './rtpLedger.js';
import type { EvidenceStep, Finding, FailureClass, L10n, OverallStatus, Risk, SlotCaptureManifest } from './types.js';

const L = (zh: string, en: string): L10n => ({ zh, en });
const fmt = (n: number) => n.toLocaleString('en-US');

export const ACCEPTANCE_STANDARD = { id: 'PA-AS', version: '1.0' } as const;
export const ACCEPTANCE_STANDARD_TAG = `${ACCEPTANCE_STANDARD.id}-${ACCEPTANCE_STANDARD.version}`;

export type AcLevel = 'must' | 'should';
export type AcResult = 'pass' | 'fail' | 'not_evaluable' | 'not_applicable';
/** 不通過的歸因:只有 game 會讓結論變 FAIL;其餘讓結論變 BLOCKED(測試無效)。 */
export type AcAttribution = 'game' | 'test_execution' | 'environment' | 'ai_agent' | 'data';
export type AcGroup = 'execution' | 'stability' | 'defects' | 'protocol' | 'data_integrity' | 'rtp' | 'ai_reliability';

export interface AcSource {
  kind: 'case' | 'standard' | 'engine';
  /** case = 案例原文片段;standard = 參考標準 id(見 references)。 */
  ref: string;
  quote?: string;
}

export interface AcceptanceCriterion {
  id: string;
  group: AcGroup;
  level: AcLevel;
  title: L10n;
  requirement: L10n;
  threshold?: L10n;
  actual?: L10n;
  result: AcResult;
  attribution?: AcAttribution;
  basis: 'deterministic' | 'ai_evaluation';
  evidenceSteps: number[];
  relatedFindings: string[];
  sources: AcSource[];
  note?: L10n;
}

export interface AcReference {
  id: string;
  title: string;
  url: string;
  use: L10n;
}

export interface Acceptance {
  standard: string;
  verdict: OverallStatus;
  verdictReason: L10n;
  /** 決定結論的項目 id。 */
  decidedBy: string[];
  criteria: AcceptanceCriterion[];
  rtp?: RtpLedger;
  references: AcReference[];
  rules: L10n[];
}

export interface AcceptanceInput {
  task: string;
  state: string;
  terminal: { blocked: boolean; reason: L10n; classification?: FailureClass };
  conclusion?: string;
  steps: EvidenceStep[];
  findings: Finding[];
  aiFailures: Finding[];
  risks: Risk[];
  quality: DataQuality;
  values: Record<string, number>;
  thresholds: Record<string, number>;
  /** 案例帶結構化測項(items:):以測項為主,知識庫衍生的建議項目/風險僅供參考,不下修結論。 */
  scripted?: boolean;
  slotCapture?: SlotCaptureManifest;
}

/** 參考標準(報告附錄逐條列出;每個驗收項目以 id 引用)。 */
export const REFERENCES: AcReference[] = [
  {
    id: 'ISTQB',
    title: 'ISTQB Glossary(test verdict / pass / fail / blocked)',
    url: 'https://glossary.istqb.org/',
    use: L('測試判定用語與「實際結果 vs 預期結果」的判定原則', 'Verdict terms and the actual-vs-expected rule'),
  },
  {
    id: 'ISO29119-3',
    title: 'ISO/IEC/IEEE 29119-3:2021 Test documentation',
    url: 'https://www.iso.org/standard/79429.html',
    use: L('測試完成報告應載明的內容:範圍、偏差、結果、未解決風險與可追溯性', 'Test completion report contents: scope, deviations, results, residual risks, traceability'),
  },
  {
    id: 'GLI-11',
    title: 'GLI-11 v3.0 Gaming Devices(Gaming Laboratories International)',
    url: 'https://www.maine.gov/dps/sites/maine.gov.dps/files/inline-files/100%20-%20GLI-11-Gaming-Devices-V3.0.pdf',
    use: L(
      '實體 / 電子博弈機的理論 RTP 由數學模型(PAR 表)與 RNG 認證證明,預設下限 75%,各司法管轄可調高;實機抽樣只能做合理性檢查,不能取代認證',
      'Theoretical RTP is proven by the math model (PAR sheet) and RNG certification, default minimum 75% (jurisdictions may raise it); field sampling is a sanity check, not certification',
    ),
  },
  {
    id: 'MA-205CMR143',
    title: 'Massachusetts 205 CMR 143.01(採用 GLI-11 並將 75% 改為 80%)',
    url: 'https://www.law.cornell.edu/regulations/massachusetts/205-CMR-143-01',
    use: L('司法管轄調高最低 RTP 的實例', 'Example of a jurisdiction raising the minimum RTP'),
  },
  {
    id: 'GPLAY-GAMBLING',
    title: 'Google Play:Real-Money Gambling, Games, and Contests policy',
    url: 'https://support.google.com/googleplay/android-developer/answer/9877032',
    use: L('真錢博弈 App 的上架條件;社交博弈(不能兌現)不在真錢規範內,RTP 不受法規下限約束,但仍應與遊戲內公告一致', 'Listing rules for real-money gambling; social casino (no cash-out) is outside it, so no legal RTP floor applies, but RTP should match in-game disclosures'),
  },
  {
    id: 'APPLE-5.3',
    title: 'Apple App Store Review Guidelines 5.3 Gaming, Gambling, and Lotteries',
    url: 'https://developer.apple.com/app-store/review/guidelines/#gaming-gambling-and-lotteries',
    use: L('iOS 博弈類 App 的審核規範', 'App Review rules for gambling-related iOS apps'),
  },
];

export const VERDICT_RULES: L10n[] = [
  L('FAIL:任一「必要」項目不通過,且歸因為遊戲本身(確定性證據或已確認的遊戲缺陷)。', 'FAIL: any MUST criterion fails and the cause is the game itself (deterministic evidence or a confirmed game defect).'),
  L('BLOCKED(受阻):任一「必要」項目不通過或無法判定,但原因是執行未依協定、環境、AI 代理或數據不可溯源 —— 本次結果不能作為驗收依據。', 'BLOCKED: any MUST criterion fails or cannot be evaluated for a non-game reason (protocol deviation, environment, AI agent, untraceable data) — this run cannot be used for acceptance.'),
  L('PASS_WITH_RISK(通過・有風險):必要項目全部通過,但「建議」項目不通過,或仍有待判讀異常 / 高風險。', 'PASS_WITH_RISK: all MUST criteria pass, but a SHOULD criterion fails or open triage items / high risks remain.'),
  L('PASS(通過):全部項目通過。', 'PASS: every criterion passes.'),
  L('優先序 FAIL > BLOCKED > PASS_WITH_RISK > PASS。AI 判讀(非確定性)的觀察只能當證據線索,必須有實際操作紀錄佐證才算「已確認的遊戲缺陷」。', 'Precedence FAIL > BLOCKED > PASS_WITH_RISK > PASS. AI observations are leads; they count as confirmed game defects only when backed by recorded actions.'),
];

export function isRtpTask(task: string): boolean {
  return /RTP|Return\s*To\s*Player|派彩率|回報率|返還率|返奖率/i.test(task);
}

/** 案例要求的付費局數(「玩滿 500 局」「累計 500 次付費旋轉」)。 */
export function targetSpins(task: string): number | null {
  const m = /(?:玩滿|累計|累积|至少|共|完成|跑滿|滿)\s*(\d{2,6})\s*(?:局|次|spins?)/i.exec(task) ?? /(\d{2,6})\s*(?:局|次)\s*(?:「?付費|付费)/.exec(task);
  return m ? Number(m[1]) : null;
}

/** 從案例原文擷取一小段做為要求來源(可溯源)。 */
function quoteOf(task: string, re: RegExp, span = 60): string | undefined {
  const m = re.exec(task);
  if (!m) return undefined;
  const start = Math.max(0, m.index - 10);
  return task.slice(start, start + span).replace(/\s+/g, ' ').trim();
}

const ATTR_OF_CLASS: Record<FailureClass, AcAttribution> = {
  GAME_FAILURE: 'game',
  AI_TEST_FAILURE: 'ai_agent',
  ENVIRONMENT: 'environment',
  NEEDS_TRIAGE: 'test_execution',
};

export function buildAcceptance(input: AcceptanceInput): Acceptance {
  const { task, state, terminal, steps, findings, aiFailures, risks, quality } = input;
  const last = steps[steps.length - 1];
  const lastIdx = last ? [last.index] : [];
  const criteria: AcceptanceCriterion[] = [];
  const push = (c: Omit<AcceptanceCriterion, 'relatedFindings' | 'sources'> & Partial<Pick<AcceptanceCriterion, 'relatedFindings' | 'sources'>>) =>
    criteria.push({ relatedFindings: [], sources: [], ...c });

  // ── 通用項目 ──
  const completed = state === 'pass';
  push({
    id: 'AC-G01', group: 'execution', level: 'must', basis: completed ? 'ai_evaluation' : 'deterministic',
    title: L('測試流程執行完成', 'Test procedure completed'),
    requirement: L('依案例步驟執行到完成條件,而不是因時間 / 步數 / 預算上限、取消或錯誤而停止', 'The case is executed until its completion condition, not stopped by a time / step / budget limit, cancellation or error'),
    actual: completed ? L(`AI 在第 ${last?.index ?? '?'} 步宣告完成`, `AI declared completion at step ${last?.index ?? '?'}`) : terminal.reason,
    result: completed ? 'pass' : 'fail',
    ...(completed ? {} : { attribution: terminal.classification ? ATTR_OF_CLASS[terminal.classification] : 'test_execution' }),
    evidenceSteps: lastIdx,
    sources: [{ kind: 'standard', ref: 'ISTQB' }],
    ...(completed ? { note: L('「完成」是 AI 的宣告;是否真的達成案例要求,由下方各項目逐一驗證。', '"Completed" is the AI\'s claim; whether the case requirements were really met is verified item by item below.') } : {}),
  });

  const crashes = findings.filter((f) => f.category === 'crash' && f.classification === 'GAME_FAILURE');
  push({
    id: 'AC-G02', group: 'stability', level: 'must', basis: 'deterministic',
    title: L('執行期間無閃退', 'No crash during the run'),
    requirement: L('App 程序全程維持執行(runner 每步查詢 App 狀態)', 'The app process stays alive throughout (the runner queries app state every step)'),
    threshold: L('閃退 0 次', '0 crashes'),
    actual: L(`閃退 ${crashes.length} 次`, `${crashes.length} crash(es)`),
    result: crashes.length ? 'fail' : steps.length ? 'pass' : 'not_evaluable',
    ...(crashes.length ? { attribution: 'game' as const } : steps.length ? {} : { attribution: 'test_execution' as const }),
    evidenceSteps: crashes.map((f) => f.firstStep).filter((x): x is number => typeof x === 'number'),
    relatedFindings: crashes.map((f) => f.id),
  });

  const severe = findings.filter((f) => f.classification === 'GAME_FAILURE' && (f.severity === 'critical' || f.severity === 'high'));
  push({
    id: 'AC-G03', group: 'defects', level: 'must', basis: severe.some((f) => f.certainty === 'ai_evaluation') ? 'ai_evaluation' : 'deterministic',
    title: L('無已確認的 Critical / High 遊戲缺陷', 'No confirmed Critical / High game defect'),
    requirement: L('已確認 = 程式規則判定,或 AI 重複觀察且有實際操作紀錄佐證', 'Confirmed = rule-based, or repeatedly observed by the AI and backed by recorded actions'),
    threshold: L('0 個', '0'),
    actual: L(severe.length ? `${severe.length} 個:${severe.map((f) => f.title.zh).join('、')}` : '0 個', severe.length ? `${severe.length}: ${severe.map((f) => f.title.en).join(', ')}` : '0'),
    result: severe.length ? 'fail' : 'pass',
    ...(severe.length ? { attribution: 'game' as const } : {}),
    evidenceSteps: severe.flatMap((f) => [f.firstStep, f.lastStep]).filter((x): x is number => typeof x === 'number'),
    relatedFindings: severe.map((f) => f.id),
  });

  const triage = findings.filter((f) => f.classification === 'NEEDS_TRIAGE');
  push({
    id: 'AC-G04', group: 'defects', level: 'should', basis: 'deterministic',
    title: L('沒有待人工判讀的異常', 'No anomaly awaiting triage'),
    requirement: L('無法自動歸因的異常需人工確認後才能結案', 'Anomalies that cannot be attributed automatically must be triaged before closing'),
    threshold: L('0 項', '0'),
    actual: L(`${triage.length} 項`, `${triage.length}`),
    result: triage.length ? 'fail' : 'pass',
    ...(triage.length ? { attribution: 'test_execution' as const } : {}),
    evidenceSteps: triage.map((f) => f.firstStep).filter((x): x is number => typeof x === 'number'),
    relatedFindings: triage.map((f) => f.id),
  });

  const aiSerious = aiFailures.filter((f) => f.severity !== 'low');
  push({
    id: 'AC-G05', group: 'ai_reliability', level: 'should', basis: 'deterministic',
    title: L('AI 測試代理行為可靠', 'AI test agent behaved reliably'),
    requirement: L('AI 的回報要與實際操作紀錄一致,模型輸出可解析;低嚴重度(偶發無效點擊)不計', 'AI reports must match recorded actions and model output must parse; low-severity issues (occasional ineffective taps) are ignored'),
    threshold: L('Medium 以上 0 項', '0 at Medium or above'),
    actual: L(aiSerious.length ? `${aiSerious.length} 項:${aiSerious.map((f) => f.title.zh).join('、')}` : `0 項(低嚴重度 ${aiFailures.length} 項)`, aiSerious.length ? `${aiSerious.length}: ${aiSerious.map((f) => f.title.en).join(', ')}` : `0 (low severity: ${aiFailures.length})`),
    result: aiSerious.length ? 'fail' : 'pass',
    ...(aiSerious.length ? { attribution: 'ai_agent' as const } : {}),
    evidenceSteps: aiSerious.map((f) => f.firstStep).filter((x): x is number => typeof x === 'number'),
    relatedFindings: aiSerious.map((f) => f.id),
  });

  // ── 拉霸 RTP 量測 ──
  let ledger: RtpLedger | null = null;
  if (isRtpTask(task)) {
    ledger = buildRtpLedger(steps, input.values);
    const target = targetSpins(task) ?? input.thresholds['rtpMinSamples'] ?? 100;
    const targetQuote = quoteOf(task, /(?:玩滿|累計|累积|至少|跑滿)\s*\d{2,6}\s*(?:局|次)/);
    const fixedBetRe = /固定投注|固定下注|同一.{0,6}投注|投注額.{0,4}固定|fixed\s*bet/i;
    const fixedBet = fixedBetRe.test(task);
    const readOnlyRe = /實際讀到|实际读到|不可以估算|不可估算|不得估算|不要估算|不可以.{0,4}編造|讀不到就寫/;
    const readOnly = readOnlyRe.test(task);
    const windowSteps = ledger ? ledger.windows.flatMap((w) => [w.counterStart.step, w.counterEnd.step]) : [];

    push({
      id: 'AC-S01', group: 'protocol', level: 'must', basis: 'deterministic',
      title: L('付費旋轉樣本數達標', 'Paid-spin sample size reached'),
      requirement: L('付費局數由 AutoSpin 計數的遞減加總(程式計算,不採用 AI 自報的累計數)', 'Paid spins = sum of AutoSpin counter decrements (computed, not the AI\'s self-reported tally)'),
      threshold: L(`≥ ${fmt(target)} 局`, `≥ ${fmt(target)} spins`),
      actual: ledger ? L(`${fmt(ledger.spins)} 局(${ledger.windows.length} 個量測區間)`, `${fmt(ledger.spins)} spins (${ledger.windows.length} window(s))`) : L('沒有可用的 AutoSpin 計數讀值', 'No usable AutoSpin counter readings'),
      result: !ledger ? 'not_evaluable' : ledger.spins >= target ? 'pass' : 'fail',
      ...(!ledger ? { attribution: 'data' as const } : ledger.spins >= target ? {} : { attribution: 'test_execution' as const }),
      evidenceSteps: windowSteps,
      sources: targetQuote ? [{ kind: 'case', ref: 'case', quote: targetQuote }] : [{ kind: 'engine', ref: 'rtpMinSamples' }],
    });

    const bc = quality.betChanges;
    push({
      id: 'AC-S02', group: 'protocol', level: fixedBet ? 'must' : 'should', basis: 'deterministic',
      title: L('投注額全程固定', 'Bet held constant'),
      requirement: L('同一台機台、同一投注額;投注額改變後的局數不能與前段合併成一個 RTP', 'Same machine, same bet; spins after a bet change cannot be pooled into one RTP'),
      threshold: L('投注額變更 0 次', '0 bet changes'),
      actual: bc.length
        ? L(bc.map((c) => `#${c.step}:${fmt(c.from)} → ${fmt(c.to)}`).join(';'), bc.map((c) => `#${c.step}: ${fmt(c.from)} → ${fmt(c.to)}`).join('; '))
        : L('0 次', '0'),
      result: bc.length ? 'fail' : 'pass',
      ...(bc.length ? { attribution: 'test_execution' as const } : {}),
      evidenceSteps: bc.flatMap((c) => [c.prevStep, c.step]),
      sources: fixedBet ? [{ kind: 'case', ref: 'case', quote: quoteOf(task, fixedBetRe) ?? '' }] : [],
      ...(bc.length ? { note: L('投注額改變的原因若是遊戲按鈕失效,需在缺陷清單有「已確認」紀錄;否則歸為執行偏差。', 'If the bet changed because a game button failed, a confirmed defect must exist; otherwise it is an execution deviation.') } : {}),
    });

    const conclusion = input.conclusion ?? '';
    // 以子句為單位引用(「7日寶箱約16,800由餘額推斷」),方便對照原文。
    const estimates = conclusion
      .split(/[。;;\n]|[,,](?=[^\d])|[((]/)
      .map((c) => c.replace(/[))]/g, '').trim())
      .filter((c) => c && ESTIMATE_RE.test(c))
      .map((c) => (c.length > 48 ? `${c.slice(0, 46)}…` : c));
    push({
      id: 'AC-S03', group: 'data_integrity', level: readOnly ? 'must' : 'should', basis: 'deterministic',
      title: L('統計數字皆為畫面實讀', 'All figures read from screen'),
      requirement: L('進入 RTP 的數字不得估算、推斷或使用被遮擋的值;讀錯的值會被排除並列在數據品質', 'Figures used for RTP must not be estimated, inferred or occluded; misreads are excluded and listed under data quality'),
      threshold: L('估計值 0 筆', '0 estimated values'),
      actual: estimates.length
        ? L(`AI 結論含 ${estimates.length} 處估計:${estimates.slice(0, 4).map((e) => `「${e}」`).join('、')}`, `AI conclusion contains ${estimates.length} estimate(s): ${estimates.slice(0, 4).map((e) => `"${e}"`).join(', ')}`)
        : L(`0 筆(已排除疑似讀錯 ${quality.excluded.length} 筆)`, `0 (excluded misreads: ${quality.excluded.length})`),
      result: estimates.length ? 'fail' : 'pass',
      ...(estimates.length ? { attribution: 'data' as const } : {}),
      evidenceSteps: lastIdx,
      sources: readOnly ? [{ kind: 'case', ref: 'case', quote: quoteOf(task, readOnlyRe) ?? '' }] : [],
    });

    const inWin = ledger?.credits.filter((c) => c.windowId) ?? [];
    const unresolved = inWin.filter((c) => c.amount === null);
    const noneSeen = inWin.filter((c) => c.basis === 'none_seen').length;
    push({
      id: 'AC-S04', group: 'rtp', level: 'must', basis: inWin.some((c) => c.basis === 'ai_read' || c.basis === 'obs') ? 'ai_evaluation' : 'deterministic',
      title: L('非拉霸收入已逐筆分離', 'Non-slot credits isolated item by item'),
      requirement: L('量測區間內的升級 / 任務 / 登入 / 活動贈送,金額必須可確認(餘額差或畫面清楚讀到)並從 RTP 扣除', 'Level-up / mission / login / event credits inside a measurement window must have a confirmed amount (balance difference or clearly read) and be deducted from RTP'),
      threshold: L('未確認金額 0 筆', '0 unconfirmed amounts'),
      actual: !ledger
        ? L('沒有 RTP 帳務', 'No RTP ledger')
        : L(
          `區間內 ${inWin.length} 筆,已確認 ${inWin.length - unresolved.length} 筆(合計 ${fmt(ledger.creditsInWindow)}${noneSeen ? `;其中 ${noneSeen} 筆沒有入帳描述,視為 0` : ''}),未確認 ${unresolved.length} 筆`,
          `${inWin.length} in window, ${inWin.length - unresolved.length} confirmed (total ${fmt(ledger.creditsInWindow)}${noneSeen ? `; ${noneSeen} with no credit wording, treated as 0` : ''}), ${unresolved.length} unconfirmed`,
        ),
      result: !ledger ? 'not_evaluable' : unresolved.length ? 'fail' : 'pass',
      ...(!ledger || unresolved.length ? { attribution: 'data' as const } : {}),
      evidenceSteps: inWin.flatMap((c) => c.steps),
    });

    push({
      id: 'AC-S05', group: 'rtp', level: 'must', basis: 'deterministic',
      title: L('RTP 可由證據重算', 'RTP reproducible from evidence'),
      requirement: L('RTP 由程式依帳務公式重算(不採用 AI 自算的結果),每個輸入都對應到步驟截圖', 'RTP is recomputed by the engine from the ledger formula (not the AI\'s own arithmetic); every input maps to a step screenshot'),
      actual: !ledger
        ? L('沒有可用的 AutoSpin 計數 + 餘額讀值', 'No usable AutoSpin counter + balance readings')
        : ledger.rtpNet !== null
          ? L(`淨 RTP ${ledger.rtpNet}%(未扣贈送 ${ledger.rtpGross}%)`, `Net RTP ${ledger.rtpNet}% (before credits ${ledger.rtpGross}%)`)
          : L(`淨 RTP 不可算(有 ${ledger.unresolvedInWindow} 筆贈送金額未確認);未扣贈送上限 ${ledger.rtpGross}%`, `Net RTP not computable (${ledger.unresolvedInWindow} unconfirmed credit(s)); upper bound before credits ${ledger.rtpGross}%`),
      result: !ledger || ledger.rtpNet === null ? 'not_evaluable' : 'pass',
      ...(!ledger || ledger.rtpNet === null ? { attribution: 'data' as const } : {}),
      evidenceSteps: windowSteps,
    });

    const exp = input.values['expectedRtp'];
    const z = ledger?.stats.z;
    push({
      id: 'AC-S06', group: 'rtp', level: 'should', basis: 'deterministic',
      title: L('RTP 與理論值無顯著差異', 'RTP consistent with theoretical value'),
      requirement: L('|觀測 − 理論| ÷ 標準誤 ≤ 2.576(99% 雙尾);σ 取自 PAR 表(知識庫 rtpStdDev)', '|observed − theoretical| ÷ standard error ≤ 2.576 (99% two-sided); σ from the PAR sheet (knowledge base rtpStdDev)'),
      threshold: L('|z| ≤ 2.576', '|z| ≤ 2.576'),
      actual: typeof exp !== 'number'
        ? L('知識庫沒有提供理論 RTP(expectedRtp),無法比對', 'No theoretical RTP (expectedRtp) in the knowledge base')
        : z === undefined
          ? L('淨 RTP 不可算,無法比對', 'Net RTP not computable')
          : L(`理論 ${exp}%,z = ${z}`, `Theoretical ${exp}%, z = ${z}`),
      result: typeof exp !== 'number' ? 'not_applicable' : z === undefined ? 'not_evaluable' : Math.abs(z) <= 2.576 ? 'pass' : 'fail',
      ...(typeof exp === 'number' && z !== undefined && Math.abs(z) > 2.576 ? { attribution: 'game' as const } : typeof exp === 'number' && z === undefined ? { attribution: 'data' as const } : {}),
      evidenceSteps: windowSteps,
      sources: [{ kind: 'standard', ref: 'GLI-11' }],
      ...(ledger ? { note: L(`σ = ${ledger.stats.sigma}(${ledger.stats.sigmaSource === 'spec' ? '知識庫規格' : '未提供,採中波動參考值'});${fmt(ledger.spins)} 局的 95% 信賴區間 ±${ledger.stats.ci95Pp} 個百分點;要把誤差壓到 ±1 個百分點約需 ${fmt(ledger.stats.spinsFor1Pp)} 局。`, `σ = ${ledger.stats.sigma} (${ledger.stats.sigmaSource === 'spec' ? 'from spec' : 'not provided; medium-volatility reference'}); 95% CI over ${fmt(ledger.spins)} spins is ±${ledger.stats.ci95Pp} pp; about ${fmt(ledger.stats.spinsFor1Pp)} spins are needed for ±1 pp.`) } : {}),
    });

    // slot-board-v1 才有:逐局盤面證據本身也要驗收。舊 runner 沒有此資料時不新增項目,不回頭讓舊報告受阻。
    const cap = input.slotCapture;
    if (cap) {
      const s = cap.summary;
      const captureOk = s.detectedSpins > 0 && s.capturedBoards === s.detectedSpins && s.captureFailures === 0 && s.analysisFailures === 0;
      push({
        id: 'AC-S07', group: 'data_integrity', level: 'must', basis: 'deterministic',
        title: L('偵測到的停輪盤面全數保存', 'Every detected stable board was saved'),
        requirement: L('影片狀態機每次 busy→stable 都要保存 board + 完整 context,抽幀 / 分析失敗不可靜默略過', 'Every busy→stable transition must save board + full context; extraction / analysis failures must never be silently dropped'),
        threshold: L('保存率 100%,抽幀與分析失敗 0', '100% save rate; 0 extraction and analysis failures'),
        actual: L(`偵測 ${s.detectedSpins} 局,保存 ${s.capturedBoards} 局,抽幀失敗 ${s.captureFailures},分析失敗 ${s.analysisFailures}`, `${s.detectedSpins} detected, ${s.capturedBoards} saved, ${s.captureFailures} extraction failures, ${s.analysisFailures} analysis failures`),
        result: captureOk ? 'pass' : 'fail',
        ...(!captureOk ? { attribution: 'data' as const } : {}),
        evidenceSteps: [],
        note: L('這是「偵測事件的保存完整率」;付費 / Free Spin 分類與 AutoSpin 計數逐局對帳由機台 profile 的盤面分類階段完成。', 'This is completeness for detected events; paid/free-spin classification and one-to-one counter reconciliation are completed by the machine-profile recognition stage.'),
      });
      const gapOk = s.gapCount === 0;
      push({
        id: 'AC-S08', group: 'data_integrity', level: 'must', basis: 'deterministic',
        title: L('盤面影片時間軸無缺口', 'No gap in the board-video timeline'),
        requirement: L('所有 screenrecord 分段時間戳必須連續;有缺口就可能漏掉一局或短彈窗,不可宣稱完整逐局驗證', 'All screenrecord segment timestamps must be continuous; a gap can hide a spin or short popup, so complete per-spin validation cannot be claimed'),
        threshold: L('缺口 0 段 / 0 ms', '0 gaps / 0 ms'),
        actual: L(`缺口 ${s.gapCount} 段,合計 ${fmt(s.gapMs)} ms`, `${s.gapCount} gap(s), ${fmt(s.gapMs)} ms total`),
        result: gapOk ? 'pass' : 'not_evaluable',
        ...(!gapOk ? { attribution: 'data' as const } : {}),
        evidenceSteps: [],
      });
      const paidMatched = Boolean(ledger) && s.unknownSpins === 0 && s.paidSpins === ledger!.spins;
      push({
        id: 'AC-S09', group: 'data_integrity', level: 'must', basis: 'deterministic',
        title: L('付費盤面與 AutoSpin 計數逐局對上', 'Paid boards reconcile one-to-one with the AutoSpin counter'),
        requirement: L('影片狀態機分類為 paid 的盤面數必須等於 AutoSpin 計數遞減加總,且未分類盤面為 0', 'The number of video boards classified as paid must equal the summed AutoSpin counter decrements, with zero unclassified boards'),
        threshold: ledger ? L(`付費盤面 = ${ledger.spins},未分類 = 0`, `paid boards = ${ledger.spins}, unknown = 0`) : L('需有 RTP 帳務', 'RTP ledger required'),
        actual: L(`付費 ${s.paidSpins ?? 0},Free Spin ${s.freeSpins ?? 0},未分類 ${s.unknownSpins ?? 0}`, `paid ${s.paidSpins ?? 0}, free ${s.freeSpins ?? 0}, unknown ${s.unknownSpins ?? 0}`),
        result: paidMatched ? 'pass' : 'not_evaluable',
        ...(!paidMatched ? { attribution: 'data' as const } : {}),
        evidenceSteps: windowSteps,
      });
    }
  }

  // ── 結論 ──
  const mustFails = criteria.filter((c) => c.level === 'must' && c.result === 'fail');
  const gameFails = mustFails.filter((c) => c.attribution === 'game');
  const mustOpen = criteria.filter((c) => c.level === 'must' && ((c.result === 'fail' && c.attribution !== 'game') || c.result === 'not_evaluable'));
  const shouldFails = criteria.filter((c) => c.level === 'should' && c.result === 'fail');
  const highRisks = risks.filter((r) => r.level === 'critical' || r.level === 'high');
  const titles = (cs: AcceptanceCriterion[], lang: 'zh' | 'en') => cs.map((c) => `${c.id} ${c.title[lang]}`).join(lang === 'zh' ? '、' : ', ');
  let verdict: OverallStatus;
  let verdictReason: L10n;
  let decidedBy: string[];
  if (gameFails.length) {
    verdict = 'FAIL';
    decidedBy = gameFails.map((c) => c.id);
    verdictReason = L(`遊戲不符合必要驗收項目:${titles(gameFails, 'zh')}`, `The game fails MUST criteria: ${titles(gameFails, 'en')}`);
  } else if (mustOpen.length) {
    verdict = 'BLOCKED';
    decidedBy = mustOpen.map((c) => c.id);
    verdictReason = L(`本次測試無法作為驗收依據 —— ${titles(mustOpen, 'zh')} 未通過或無法判定(原因不是遊戲缺陷),需修正後重測`, `This run cannot be used for acceptance — ${titles(mustOpen, 'en')} failed or could not be evaluated for a non-game reason; fix and re-run`);
  } else if ((shouldFails.length || highRisks.length) && input.scripted) {
    // 以測項為主:使用者有明確測項且「必要項目」全部通過 → 判定通過。
    // 建議項目(如待判讀異常、AI 可靠度)與類型/知識庫衍生的風險僅供參考,逐條仍列在報告中,但不把結論下修為「通過・有風險」。
    verdict = 'PASS';
    decidedBy = [];
    const advisory = [shouldFails.length ? `建議項目 ${titles(shouldFails, 'zh')}` : '', highRisks.length ? `高風險 ${highRisks.length} 項` : ''].filter(Boolean).join(';');
    const advisoryEn = [shouldFails.length ? `SHOULD items ${titles(shouldFails, 'en')}` : '', highRisks.length ? `${highRisks.length} high risk(s)` : ''].filter(Boolean).join('; ');
    verdictReason = L(
      `必要項目全部通過(測項為主);另有供參考事項${advisory ? `:${advisory}` : ''},不影響結論`,
      `All MUST criteria pass (test items are authoritative); advisory items noted${advisoryEn ? `: ${advisoryEn}` : ''}, not affecting the verdict`,
    );
  } else if (shouldFails.length || highRisks.length) {
    verdict = 'PASS_WITH_RISK';
    decidedBy = shouldFails.map((c) => c.id);
    verdictReason = L(
      `必要項目全部通過;${[shouldFails.length ? `建議項目未通過:${titles(shouldFails, 'zh')}` : '', highRisks.length ? `高風險 ${highRisks.length} 項` : ''].filter(Boolean).join(';')}`,
      `All MUST criteria pass; ${[shouldFails.length ? `SHOULD criteria not met: ${titles(shouldFails, 'en')}` : '', highRisks.length ? `${highRisks.length} high risk(s)` : ''].filter(Boolean).join('; ')}`,
    );
  } else {
    verdict = 'PASS';
    decidedBy = [];
    verdictReason = L('所有驗收項目通過', 'All acceptance criteria pass');
  }
  return {
    standard: ACCEPTANCE_STANDARD_TAG,
    verdict,
    verdictReason,
    decidedBy,
    criteria,
    ...(ledger ? { rtp: ledger } : {}),
    references: REFERENCES,
    rules: VERDICT_RULES,
  };
}
