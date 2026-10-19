/**
 * AI 洞察:把「程式已計算好的」結構化報告交給 LLM 做歸納 ——
 * 需求逐條驗證矩陣、根因、修正建議。LLM 不得改任何數字;輸出經嚴格清洗後才存檔。
 *
 * 由使用者在報告頁按鈕觸發(POST /reports/{id}/insights),結果快取在
 * tenants/<t>/jobs/<id>/insights.json,之後 GET /reports/{id} 直接附上。
 */
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { getGenreProfile } from './profiles.js';
import type {
  L10n,
  Recommendation,
  ReportInsights,
  RequirementResult,
  RequirementVerdict,
  StructuredReport,
} from './types.js';

/** 便宜、快(需在 API Gateway 30 秒內完成);無權限時退回 Sonnet。 */
export const INSIGHTS_MODELS = [
  'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
];

let client: BedrockRuntimeClient | null = null;
function bedrock(): BedrockRuntimeClient {
  client ??= new BedrockRuntimeClient({ region: process.env['AWS_REGION'] ?? 'us-east-2' });
  return client;
}

const SYSTEM = `你是資深遊戲 QA 測試顧問,負責撰寫給客戶的正式測試報告結論。
你會收到一份由程式從測試證據計算出的結構化報告(JSON)。規則:
- 只能根據提供的證據下結論;不可捏造步驟、數字、截圖內容。所有數字以輸入為準,不得重新計算或更改。
- 區分「遊戲缺陷」與「AI 測試代理/測試環境問題」;後者不得說成遊戲缺陷。
- profiles 說明這次套用了哪些報告樣板(通用 + 該遊戲類型)。請用該類型的專業角度解讀數字:
  例如拉霸看 RTP 與中獎頻率是否偏離標稱值、三消看關卡失敗率、效能類看 fps 與記憶體成長。
- metrics 是程式算出來的數字,必須被用到:summary 至少引用一個關鍵指標的數值。
  source='ai_evaluation' 的數字由 AI 觀察彙總而來,可信度低於 'objective',提及時要說明這點。
- metricsNotCollected 列出「沒量到」的指標:這些要說成「本次未覆蓋」,絕對不可當成 0 或當成通過。
- thresholds 是生效的門檻、spec.values 是使用者填的遊戲設計規格(如標稱 RTP)。
  指標與門檻/規格有落差時要明確講出「實際 X vs 門檻/規格 Y」。spec.values 沒有的項目表示客戶沒提供規格,
  不可自行假設業界值來判定不合格,只能說「未提供規格,無法判定」。
- coverage 與樣本數偏低時(例如 spin_count 只有數十局),結論必須保守:講觀察到的現象,
  不要把短期樣本說成統計結論。dataQuality 有排除讀錯數值時,引用相關數字要附帶這個保留。
- referenceBands 是「這個遊戲類型常見的範圍」,**不是驗收標準,也不可用來判定不合格**。
  每筆附的 note 已寫明它的性質,寫進 watchouts 時要照實講(例如「類型常見區間約 X,本次 Y」),
  並明確說它不作為判定依據。只有落在常見範圍外的項目才會出現在這個清單裡。
- watchouts:針對數字逐條點出「值得注意的地方」,2~6 條。每條必須引用一個指標 id 或門檻,
  並說明為什麼值得注意(偏離客戶規格 / 樣本不足 / 落在類型常見區間外 / 資料品質有疑慮)。
  這裡只描述現象,不要寫怎麼修(怎麼修寫在 recommendations)。
- 需求矩陣:把 testCase.testSteps 與 testCase.expectedResult 拆成逐條需求(每行/每個編號一條;若沒有案例步驟,改用測試目標拆成 2~6 條可驗證需求)。
  每條給 result(pass/fail/unclear/not_tested)、evidenceSteps(對應的步驟編號,取自 evidence/checks 的 step)、reason(判定依據,引用畫面名或 AI 觀察)、suggestion(fail/unclear 時的具體修正建議)。
- recommendations:依優先級 P0(阻斷發布)/P1/P2 列 2~6 條可執行建議,owner 為 dev(遊戲開發修正)/qa(調整案例或知識庫)/env(測試環境)。
- notes:針對 findings 或失敗 checks(以其 id 為 key)給比模板更具體的修正建議。
- 數量上限:requirements 最多 8 條、watchouts 最多 6 條、recommendations 最多 5 條、notes 最多 5 條;evidenceSteps 每條最多 4 個。
- 文字欄位一律用使用者指定的語言撰寫,簡潔、專業;summary/rootCause 不超過 150 字,其餘每段不超過 70 字。
- 字串內不得出現未跳脫的雙引號(需要引用時改用「」)。
- 只輸出一個 JSON 物件,不要 markdown 圍欄或其他文字。格式:
{"summary":"","rootCause":"","watchouts":[""],"requirements":[{"text":"","result":"pass","evidenceSteps":[1],"reason":"","suggestion":""}],"recommendations":[{"priority":"P0","owner":"dev","text":"","relatedFindings":["DEF-001"]}],"notes":{"DEF-001":""}}`;

export type InsightsLang = 'zh' | 'en';
const LANG_NAME: Record<InsightsLang, string> = { zh: '繁體中文', en: 'English' };

const cut = (s: unknown, n: number): string | undefined => (typeof s === 'string' && s ? s.slice(0, n) : undefined);

/** 指標上限:類型專屬的先進,通用的補到這個數為止(控制 token)。 */
const MAX_METRICS = 60;

/**
 * 類型參考區間(政策③)。只在這裡讀出來給模型寫「需要注意的點」——
 * 報告引擎從頭到尾看不到它,所以它在結構上就不可能影響 pass / fail。
 *
 * 只送「實際落在區間外」的項目:落在常見範圍內的事情不值得佔模型的注意力與 token。
 * 樣本不足時連提都不提(minSamples),避免用 20 局去談返還率。
 */
function referenceBandsForModel(r: StructuredReport): Array<Record<string, unknown>> {
  const value = (id: string) => {
    const m = r.metrics.find((x) => x.id === id);
    return m && m.status === 'ok' ? m.value : null;
  };
  const out: Array<Record<string, unknown>> = [];
  for (const p of r.profiles) {
    const prof = getGenreProfile(p.id);
    for (const b of prof?.referenceBands ?? []) {
      const actual = value(b.metric);
      if (actual === null) continue;
      if (b.minSamples) {
        const n = value(b.minSamples.metric);
        if (n === null || n < b.minSamples.value) continue;
      }
      const below = b.min !== undefined && actual < b.min;
      const above = b.max !== undefined && actual > b.max;
      if (!below && !above) continue;
      out.push({
        metric: b.metric,
        actual,
        ...(b.min !== undefined ? { commonMin: b.min } : {}),
        ...(b.max !== undefined ? { commonMax: b.max } : {}),
        direction: below ? 'below_common_range' : 'above_common_range',
        note: b.note.zh,
      });
    }
  }
  return out.slice(0, 8);
}

/**
 * 送進模型的指標。
 *
 * 原本完全沒送 —— 模型在「沒看到任何數字」的情況下寫總結,所以它只能重述 checks 與
 * findings 的文字。這裡只送真的有量到的(status==='ok' 且有值),並且把類型專屬的指標
 * 排在通用指標前面:一份拉霸報告裡,observed_rtp 與 hit_frequency 比 tokens_total 重要。
 */
function metricsForModel(r: StructuredReport): Array<Record<string, unknown>> {
  const collected = r.metrics.filter((m) => m.status === 'ok' && m.value !== null);
  const genreFirst = [
    ...collected.filter((m) => m.profile !== 'global'),
    ...collected.filter((m) => m.profile === 'global'),
  ];
  return genreFirst.slice(0, MAX_METRICS).map((m) => ({
    id: m.id,
    label: m.label.zh,
    value: m.value,
    unit: m.unit,
    group: m.group,
    profile: m.profile,
    // ai_evaluation 的數字是 AI 觀察彙總而來,可信度與 objective 不同,模型要知道差別。
    source: m.source,
  }));
}

/** 精簡輸入(控制 token 與延遲):只放判定需要的欄位。 */
export function insightsInput(r: StructuredReport): Record<string, unknown> {
  const failedChecks = r.checks.filter((c) => c.result !== 'pass');
  const passedChecks = r.checks.filter((c) => c.result === 'pass');
  const tail = r.evidence.slice(-12);
  // 取樣:每 N 步一筆,讓 LLM 看到完整流程的輪廓。
  const stride = Math.max(1, Math.ceil(r.evidence.length / 30));
  const outline = r.evidence.filter((_, i) => i % stride === 0).map((s) => `#${s.index} ${s.screen} → ${s.action}`);
  const metrics = metricsForModel(r);
  const bands = referenceBandsForModel(r);
  return {
    testCase: {
      name: r.testCase.name,
      category: r.testCase.category,
      testSteps: cut(r.testCase.testSteps, 1500),
      expectedResult: cut(r.testCase.expectedResult, 600),
      precondition: cut(r.testCase.precondition, 300),
    },
    game: { name: r.header.gameName, genre: r.header.genre, platform: r.header.platform, device: r.header.device },
    overallStatus: r.overallStatus,
    statusReason: r.statusReason.zh,
    release: r.release.readiness,
    terminal: r.terminal,
    counts: r.counts,
    // ── 以下是「程式算出來的數字」:模型只能解讀,不得重算或改動 ──
    /** 這次套用了哪些報告樣板(通用 + 遊戲類型),讓模型知道該用哪個類型的專業角度看。 */
    profiles: r.profiles.map((p) => ({ id: p.id, version: p.version, label: p.label.zh })),
    metrics,
    /** 指標被截掉的數量(模型不該說「沒有其他數據」)。 */
    metricsOmitted: Math.max(0, r.metrics.filter((m) => m.status === 'ok' && m.value !== null).length - metrics.length),
    /** 沒量到的指標 id:模型據此說「此項未覆蓋」,而不是當成 0。 */
    metricsNotCollected: r.metrics.filter((m) => m.status !== 'ok' || m.value === null).map((m) => m.id).slice(0, 40),
    /** 生效的門檻值(放行 / 風險規則用的),讓模型能說「超過門檻 X」。 */
    thresholds: r.release.thresholds,
    /** 使用者填的遊戲設計規格(例如標稱 RTP);未填的項目本來就不會被檢查。 */
    spec: { values: r.spec.values, sources: r.spec.sources },
    /** 觸發的放行規則(含該規則看的指標與理由)。 */
    releaseHits: r.release.hits.map((h) => ({ ruleId: h.ruleId, outcome: h.outcome, metric: h.metric, reason: cut(h.reason.zh, 200) })),
    /** 風險清單(程式依風險規則產生)。 */
    risks: r.risks.slice(0, 12).map((x) => ({
      id: x.id, level: x.level, title: x.title.zh,
      evidence: cut(x.evidence.zh, 200), impact: cut(x.impact.zh, 160),
    })),
    /** 各品質面向分數。 */
    dashboard: r.dashboard.map((d) => ({ dimension: d.dimension, score: d.score })),
    /** 覆蓋率摘要:分母大但覆蓋少時,結論要保守。 */
    coverage: {
      feature: `${r.coverage.feature.filter((c) => c.covered).length}/${r.coverage.feature.length}`,
      mechanic: `${r.coverage.mechanic.filter((c) => c.covered).length}/${r.coverage.mechanic.length}`,
    },
    /** 數據品質:被排除的讀錯數值等;有排除就不能把數字講得太肯定。 */
    ...(r.dataQuality ? { dataQuality: r.dataQuality } : {}),
    /**
     * 類型參考區間比對結果(只列落在常見範圍外的)。**這不是驗收標準**:
     * 每筆的 note 已說明它的性質,prompt 要求寫進 watchouts 時照實說「類型常見區間」。
     */
    referenceBands: bands,
    checks: [
      ...failedChecks.slice(0, 25),
      ...passedChecks.slice(0, 15),
    ].map((c) => ({
      id: c.id, kind: c.kind, title: c.title?.zh, step: c.step, afterStep: c.afterStep, screen: c.screen, action: c.action,
      expected: c.expected, actual: c.actual, result: c.result, reason: cut(c.reason, 240), relatedFinding: c.relatedFinding,
    })),
    findings: [...r.findings, ...r.aiFailures].slice(0, 20).map((f) => ({
      id: f.id, title: f.title.zh, classification: f.classification, severity: f.severity, category: f.category,
      description: cut(f.description.zh, 300), steps: [f.firstStep, f.lastStep], frequency: f.frequency,
    })),
    flowOutline: outline,
    lastSteps: tail.map((s) => ({ step: s.index, screen: s.screen, action: s.action, thinking: cut(s.thinking, 300) })),
    summaryLines: r.summaryLines.map((l) => l.zh),
  };
}

function l10n(v: unknown, max = 400): L10n | undefined {
  if (typeof v === 'string' && v.trim()) return { zh: v.slice(0, max), en: v.slice(0, max) };
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const zh = cut(o['zh'], max);
  const en = cut(o['en'], max);
  if (!zh && !en) return undefined;
  return { zh: zh ?? en!, en: en ?? zh! };
}

const RESULTS = new Set<RequirementResult>(['pass', 'fail', 'unclear', 'not_tested']);
const PRIORITIES = new Set<Recommendation['priority']>(['P0', 'P1', 'P2']);
const OWNERS = new Set<Recommendation['owner']>(['dev', 'qa', 'env']);

/** 清洗 LLM 輸出:型別不符的欄位丟棄,步驟編號只保留證據中真的存在者。 */
export function sanitizeInsights(raw: unknown, r: StructuredReport, model: string, now = new Date(), lang: InsightsLang = 'zh'): ReportInsights {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const validSteps = new Set(r.evidence.map((s) => s.index));
  const validIds = new Set([...r.findings, ...r.aiFailures].map((f) => f.id).concat(r.checks.map((c) => c.id)));
  const requirements: RequirementVerdict[] = [];
  for (const it of Array.isArray(o['requirements']) ? o['requirements'].slice(0, 30) : []) {
    if (typeof it !== 'object' || it === null) continue;
    const q = it as Record<string, unknown>;
    const text = cut(q['text'], 300);
    const result = q['result'] as RequirementResult;
    const reason = l10n(q['reason']);
    if (!text || !RESULTS.has(result) || !reason) continue;
    const steps = Array.isArray(q['evidenceSteps']) ? q['evidenceSteps'].map(Number).filter((n) => validSteps.has(n)).slice(0, 8) : [];
    const suggestion = result === 'pass' ? undefined : l10n(q['suggestion']);
    requirements.push({ id: `REQ-${String(requirements.length + 1).padStart(2, '0')}`, text, result, evidenceSteps: [...new Set(steps)], reason, ...(suggestion ? { suggestion } : {}) });
  }
  const recommendations: Recommendation[] = [];
  for (const it of Array.isArray(o['recommendations']) ? o['recommendations'].slice(0, 8) : []) {
    if (typeof it !== 'object' || it === null) continue;
    const q = it as Record<string, unknown>;
    const text = l10n(q['text']);
    if (!text) continue;
    const priority = PRIORITIES.has(q['priority'] as Recommendation['priority']) ? (q['priority'] as Recommendation['priority']) : 'P2';
    const owner = OWNERS.has(q['owner'] as Recommendation['owner']) ? (q['owner'] as Recommendation['owner']) : 'dev';
    const rel = Array.isArray(q['relatedFindings']) ? q['relatedFindings'].filter((x): x is string => typeof x === 'string' && validIds.has(x)) : [];
    recommendations.push({ priority, owner, text, relatedFindings: rel });
  }
  recommendations.sort((a, b) => a.priority.localeCompare(b.priority));
  // 需要注意的點:字串陣列(容忍模型回 { zh, en } 物件),去空去重,最多 6 條。
  const watchouts: L10n[] = [];
  for (const it of Array.isArray(o['watchouts']) ? o['watchouts'].slice(0, 12) : []) {
    const v = l10n(it, 300);
    if (v && !watchouts.some((w) => w.zh === v.zh)) watchouts.push(v);
    if (watchouts.length >= 6) break;
  }
  const notes: Record<string, L10n> = {};
  if (typeof o['notes'] === 'object' && o['notes'] !== null) {
    for (const [k, v] of Object.entries(o['notes'] as Record<string, unknown>).slice(0, 12)) {
      const t = l10n(v);
      if (t && validIds.has(k)) notes[k] = t;
    }
  }
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    model,
    lang,
    summary: l10n(o['summary'], 800) ?? { zh: r.statusReason.zh, en: r.statusReason.en },
    rootCause: l10n(o['rootCause'], 800) ?? { zh: '—', en: '—' },
    watchouts,
    requirements,
    recommendations,
    notes,
  };
}

/** 從模型文字中取出第一個 JSON 物件(容忍圍欄/前後說明;輸出被 max_tokens 截斷時修補)。 */
export function extractJson(text: string): unknown {
  const t = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = t.indexOf('{');
  if (start < 0) throw new Error('模型未回傳 JSON');
  const end = t.lastIndexOf('}');
  if (end > start) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch { /* 改走修補 */ }
  }
  const repaired = repairTruncatedJson(t.slice(start));
  if (repaired === undefined) throw new Error('模型輸出不是有效 JSON');
  return repaired;
}

/**
 * 截斷修補:掃描字元追蹤字串/括號堆疊,在每個「完整值結束」的位置記下快照;
 * 從最後一個快照往回嘗試「截到該處 + 補上未閉合的括號」,第一個能解析的就用。
 * 只會丟掉最後一個不完整的元素,不會捏造內容。
 */
export function repairTruncatedJson(s: string): unknown {
  const stack: string[] = [];
  const cuts: Array<{ pos: number; closers: string }> = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') {
      stack.pop();
      if (stack.length === 0) return JSON.parse(s.slice(0, i + 1));
      cuts.push({ pos: i + 1, closers: [...stack].reverse().join('') });
    }
  }
  for (let k = cuts.length - 1; k >= 0 && k >= cuts.length - 200; k--) {
    const { pos, closers } = cuts[k]!;
    try { return JSON.parse(s.slice(0, pos) + closers); } catch { /* 往前一個 */ }
  }
  return undefined;
}

export async function generateInsights(
  r: StructuredReport,
  lang: InsightsLang = 'zh',
  deps?: { bedrock?: Pick<BedrockRuntimeClient, 'send'> },
): Promise<ReportInsights> {
  const br = deps?.bedrock ?? bedrock();
  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    // 多了 watchouts 一段(最多 6 條),輸出上限跟著放寬;截斷時 repairTruncatedJson 會接手。
    max_tokens: 4200,
    temperature: 0,
    system: SYSTEM,
    messages: [
      { role: 'user', content: `輸出語言:${LANG_NAME[lang]}\n結構化報告:\n${JSON.stringify(insightsInput(r))}` },
      // 預填 "{" 讓模型直接輸出 JSON 本體。
      { role: 'assistant', content: '{' },
    ],
  });
  let lastErr: unknown;
  for (const modelId of INSIGHTS_MODELS) {
    try {
      const res = await br.send(new InvokeModelCommand({ modelId, contentType: 'application/json', accept: 'application/json', body }));
      const parsed = JSON.parse(new TextDecoder().decode(res.body as Uint8Array)) as { content?: Array<{ type: string; text?: string }>; stop_reason?: string };
      const text = `{${parsed.content?.find((c) => c.type === 'text')?.text ?? ''}`;
      let json: unknown;
      try {
        json = extractJson(text);
      } catch (e) {
        throw new Error(`模型輸出不是有效 JSON(stop_reason=${parsed.stop_reason ?? '?'}):${e instanceof Error ? e.message : String(e)}`);
      }
      return sanitizeInsights(json, r, modelId, new Date(), lang);
    } catch (err) {
      lastErr = err;
      // 只有「模型不可用/無權限」才換下一個模型;輸出格式錯誤等直接回報。
      const name = err instanceof Error ? err.name : '';
      if (!/AccessDenied|ResourceNotFound|ValidationException/.test(name)) throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('AI 洞察產生失敗');
}
