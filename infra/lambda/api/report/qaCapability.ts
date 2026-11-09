/**
 * 平台可執行範圍宣告 —— 這個平台在客戶的測項分類上「做得到什麼、做不到什麼」。
 *
 * 為什麼要有這一層:
 *   AI 測試平台最危險的失效模式不是測失敗,是**報告看起來很完整**。
 *   一份 2,000 列全綠的報告,如果它涵蓋的是客戶測試實務裡的 60%,
 *   而剩下 40% 連「做不到」都沒寫,那份報告會被當成放行依據 —— 這比測出一堆缺陷糟得多。
 *
 * 所以能力宣告是**資料**,不是文件裡的一段散文:它跟著每份報告輸出、有測試鎖住,
 * 改了平台能力就要改這裡,不改就會跟報告對不上。
 *
 * 分級只有三種,刻意不給中間地帶:
 *   automated     —— 平台可自動產生這一類的判定證據。
 *   partial       —— 可產生部分證據,但有明確的缺口(covers / gap 兩欄說清楚)。
 *   not_supported —— 結構性做不到;任何一次執行都不會有證據,需要人工或別的工具。
 *
 * **不在這裡放客戶的測項數量。** 各分類的實際占比要從客戶自己的測項庫即時統計,
 * 不該把某一次快照的數字寫死在程式裡(那既是客戶資料,也會過期)。
 */
import type { L10n } from './types.js';

const L = (zh: string, en: string): L10n => ({ zh, en });

export type CapabilityLevel = 'automated' | 'partial' | 'not_supported';

export interface CategoryCapability {
  /** 對應測項主要分類代碼(M01~M19)。 */
  code: string;
  level: CapabilityLevel;
  /** 平台在這一類做得到什麼。 */
  covers: L10n;
  /** 做不到什麼,以及為什麼(level !== 'automated' 時必填)。 */
  gap?: L10n;
  /** 缺口要怎麼補:人工、別的工具,或平台哪一層要先補能力。 */
  fallback?: L10n;
}

/**
 * 逐類能力宣告。
 * 每一條都對應到平台實際存在的機制(截圖/VLM 觀察、逐步判定、逐局帳務重建、
 * 效能取樣、閃退偵測、語系觀測),沒有機制支撐的就不寫成 automated。
 */
export const CATEGORY_CAPABILITY: readonly CategoryCapability[] = [
  {
    code: 'M01',
    level: 'automated',
    covers: L('安裝、啟動、載入流程可由執行器驅動;開機畫面與載入頁以截圖與 VLM 觀察,冷啟動與載入耗時有量測', 'Install, launch and loading flows are driven by the runner; boot and loading screens are observed from screenshots, and cold-start and load times are measured'),
  },
  {
    code: 'M02',
    level: 'partial',
    covers: L('登入、註冊、設定選單的流程可自動執行;憑證以遮罩方式在輸入時才代入,不進入提示詞與報告', 'Login, registration and settings flows run automatically; credentials are masked and substituted only at type time, never entering the prompt or report'),
    gap: L('需要簡訊或信箱驗證碼的流程無法自行完成;多裝置同時登入的互斥行為需要第二個客戶端', 'Flows requiring an SMS or email verification code cannot be completed; mutual-exclusion behaviour across devices needs a second client'),
    fallback: L('驗證碼類流程需人工配合或由專案提供測試用固定碼', 'Verification-code flows need manual assistance or a fixed test code from the project'),
  },
  {
    code: 'M03',
    level: 'automated',
    covers: L('回合流程、狀態轉換與結果結算可逐步驅動並逐步判定;每一步的預期與實際都對得到截圖', 'Round flow, state transitions and settlement are driven and judged step by step, with every expectation and actual result traceable to a screenshot'),
  },
  {
    code: 'M04',
    level: 'automated',
    covers: L('逐局下注與派彩可由畫面讀值重建成帳(資產前、操作值、累積值、結果值),並做餘額遞推對帳;RTP 以帳務公式重算而非採用 AI 自報', 'Per-round stake and payout are reconstructed into a ledger from on-screen readings and reconciled by balance recurrence; RTP is recomputed from the ledger rather than taken from the AI'),
  },
  {
    code: 'M05',
    level: 'partial',
    covers: L('活動與任務的介面流程、領獎與資產異動可自動執行與核對', 'Event and mission UI flows, reward collection and asset changes run and reconcile automatically'),
    gap: L('需要後台置獎、調整活動期間或改玩家狀態才能觸發的條件,平台不會自行去動營運後台', 'Conditions that require granting rewards, shifting event windows or editing player state in the back office are not performed by the platform'),
    fallback: L('前置條件請由專案先在後台設好,或改用網頁執行器另測後台本身', 'Have the project set the preconditions in the back office first, or test the back office itself with the web runner'),
  },
  {
    code: 'M06',
    level: 'partial',
    covers: L('排行榜、好友與互動介面的顯示與操作可自動驗', 'Leaderboard, friend and interaction UI display and operation can be verified automatically'),
    gap: L('真正需要兩個玩家同時在線互動的行為,單一執行只有一個客戶端', 'Behaviour that genuinely needs two players online at once cannot be covered: a run has a single client'),
    fallback: L('雙人互動需安排兩個執行同時進行,或人工配合', 'Two-player interaction needs two concurrent runs or manual assistance'),
  },
  {
    code: 'M07',
    level: 'automated',
    covers: L('介面顯示、按鈕回饋與彈窗流程以截圖與 VLM 逐步觀察;動作後畫面有無變化由程式以影像訊號判定,不只靠 AI 自述', 'UI display, button feedback and dialog flows are observed step by step; whether the screen actually changed after an action is determined programmatically from image signals, not from the AI\u2019s own account'),
  },
  {
    code: 'M08',
    level: 'not_supported',
    covers: L('可讀出當下介面語系,畫面上的文字破圖、缺字與排版異常可由 VLM 觀察', 'The current UI locale can be read, and broken glyphs, missing characters and layout faults are observable from screenshots'),
    gap: L('音訊軌未擷取,音效時機與破音無法判定;也沒有核定文案可對照,無法判定各語系的文字與版面是否正確 —— 這一類的判定基準本身不在平台內', 'No audio track is captured, so sound timing and distortion cannot be judged; there is also no approved copy to compare against, so per-locale text and layout correctness cannot be judged \u2014 the basis for this judgement does not exist inside the platform'),
    fallback: L('音效需人工聽測或另接音訊擷取;語系文案需專案提供核定文案後做比對', 'Audio needs manual listening or a separate audio capture path; locale copy needs the approved text from the project before it can be compared'),
  },
  {
    code: 'M09',
    level: 'partial',
    covers: L('若遊戲自行斷線或重連,畫面狀態的變化可被觀察與記錄', 'If the game disconnects or reconnects on its own, the resulting screen states are observed and recorded'),
    // 這是最容易被誤解的一條:能觀察 ≠ 能製造。
    gap: L('平台無法施加網路劣化條件:沒有延遲注入、沒有丟包、沒有頻寬限制。任何指定「延遲 N ms」或「掉包 N%」的測項都不在可執行範圍內', 'The platform cannot impose degraded network conditions: no latency injection, no packet loss, no bandwidth limiting. Any item specifying a target latency or loss rate is outside its executable range'),
    fallback: L('弱網測項需在執行環境外施加網路條件(主機層的流量塑形),目前不在平台能力內', 'Weak-network items need the condition imposed outside the run (traffic shaping at the host layer), which the platform does not currently provide'),
  },
  {
    code: 'M10',
    level: 'partial',
    covers: L('可重啟 App 並比對重啟前後的畫面狀態,中斷後的流程續接可逐步驗', 'The app can be relaunched and the before/after screen state compared, so flow resumption after an interruption is verifiable step by step'),
    gap: L('未做存檔檔案層級的前後差異比對,只看畫面呈現;來電、系統彈窗等真實中斷事件無法自行製造', 'No file-level save-data diff is performed, only the on-screen result; real interruptions such as incoming calls or system dialogs cannot be induced'),
    fallback: L('存檔資料一致性需另接檔案比對;系統級中斷需人工或裝置層腳本', 'Save-data consistency needs a separate file comparison; system-level interruptions need manual steps or device-layer scripting'),
  },
  {
    code: 'M11',
    level: 'partial',
    covers: L('可在雲端真機與模擬器上執行,解析度與裝置型號記入報告的受測組合', 'Runs on cloud real devices and emulators, with resolution and device model recorded in the report\u2019s tested combination'),
    gap: L('一次執行只覆蓋一個裝置組合,不構成裝置矩陣;報告會明寫不得主張跨機型適配已驗', 'A single run covers one device combination and does not constitute a device matrix; the report states explicitly that no cross-device claim is supported'),
    fallback: L('適配性需多次執行涵蓋裝置母體,並由排程彙整', 'Compatibility needs multiple runs across the device population, aggregated by scheduling'),
  },
  {
    code: 'M12',
    level: 'automated',
    covers: L('FPS、幀時間分布、卡頓率、CPU、GPU、記憶體、溫度與耗電(含佔電池容量百分比)皆有量測;未收集到的指標回報「未收集」而不以 0 充數', 'FPS, frame-time distribution, stutter rate, CPU, GPU, memory, temperature and battery use (including as a share of capacity) are measured; metrics that were not collected are reported as such rather than substituted with 0'),
  },
  {
    code: 'M13',
    level: 'partial',
    covers: L('廣告播放、推播點擊導向與外部頁面跳轉的介面流程可自動執行', 'Ad playback, push-notification click-through and external page transitions can be run automatically'),
    gap: L('推播需由專案端發送;廣告庫存與填充率由第三方決定,沒有廣告可播時無法與「不該播」區分', 'Push messages must be sent by the project; ad inventory and fill rate are controlled by third parties, so \u201cno ad available\u201d cannot be distinguished from \u201cad should not play\u201d'),
    fallback: L('推播請專案配合發送;廣告類測項需在有穩定測試廣告源的環境執行', 'Ask the project to send push messages; ad items need an environment with a stable test ad source'),
  },
  {
    code: 'M14',
    level: 'automated',
    covers: L('後台與報表屬網頁介面,由網頁執行器驅動:查詢、篩選、匯出與欄位數值核對可自動執行', 'Back office and reports are web interfaces driven by the web runner: queries, filters, exports and field-value checks run automatically'),
  },
  {
    code: 'M15',
    level: 'not_supported',
    covers: L('畫面上與周邊連動的顯示(例如燈號、出票提示)可觀察', 'On-screen indications tied to peripherals, such as lamp or ticket prompts, are observable'),
    gap: L('出票、投幣、搖桿與實體燈號屬機台硬體,平台沒有實體 I/O,無法操作也無法量測', 'Ticket dispensing, coin input, joysticks and physical lamps are machine hardware; the platform has no physical I/O and can neither operate nor measure them'),
    fallback: L('需在實機現場由人工執行,或另接機台 I/O 治具', 'Requires manual execution on the physical machine, or a separate machine-I/O rig'),
  },
  {
    code: 'M16',
    level: 'automated',
    covers: L('這一類就是平台本身:逐筆結果、目標與實際有效量、中止原因、排除的讀錯值與分析完成狀態都是產出的一部分', 'This category is the platform itself: per-record results, target versus actual effective volume, abort reasons, excluded misreads and analysis state are all part of its output'),
  },
  {
    code: 'M17',
    level: 'not_supported',
    covers: L('無', 'None'),
    gap: L('使用體驗研究與競品分析的輸入是人的觀察與對外部產品的取樣,不是受測版本的執行證據', 'Experience research and competitive analysis take human observation and sampling of external products as input, not execution evidence from the build under test'),
    fallback: L('屬人工研究工作;平台可提供同類場景的量測數據作為素材', 'Human research work; the platform can supply measurements from comparable scenarios as input material'),
  },
  {
    code: 'M18',
    level: 'partial',
    covers: L('版本允收的判定與統計由驗收標準與報告引擎產出', 'Version acceptance verdicts and statistics come from the acceptance standard and the report engine'),
    gap: L('各商店與渠道的送審檢查項需依平台規則逐項人工確認,且本平台的結果不代替商店正式審查', 'Per-store submission checks must be confirmed manually against each store\u2019s rules, and this platform\u2019s result does not substitute for the store\u2019s own review'),
    fallback: L('送審檢驗由人工依商店規則填寫', 'Submission checklists are filled in manually against store rules'),
  },
  {
    code: 'M19',
    level: 'partial',
    covers: L('跨功能的流程組合可用腳本化測項串起來逐項驗', 'Cross-feature flow combinations can be chained as scripted items and verified one by one'),
    gap: L('組合的「完整性」取決於測項寫得多全,平台不會自行推導出應該測哪些組合', 'How complete the combinations are depends on how thoroughly the items were written; the platform does not derive which combinations ought to be tested'),
    fallback: L('組合覆蓋範圍由測試設計決定,需人工規劃', 'Combination coverage is a test-design decision and needs human planning'),
  },
];

const BY_CODE = new Map(CATEGORY_CAPABILITY.map((c) => [c.code, c]));

export function capabilityOf(code: string): CategoryCapability | undefined {
  return BY_CODE.get(code);
}

export interface CapabilitySummary {
  automated: number;
  partial: number;
  not_supported: number;
  total: number;
  /** 一句話結論,避免只看到三個數字就以為涵蓋率很高。 */
  note: L10n;
}

export function capabilitySummary(): CapabilitySummary {
  const count = (l: CapabilityLevel) => CATEGORY_CAPABILITY.filter((c) => c.level === l).length;
  const a = count('automated');
  const p = count('partial');
  const n = count('not_supported');
  return {
    automated: a,
    partial: p,
    not_supported: n,
    total: CATEGORY_CAPABILITY.length,
    note: L(
      `${CATEGORY_CAPABILITY.length} 類中 ${a} 類可自動執行、${p} 類有缺口、${n} 類結構性做不到。分類數不等於測項數 —— 實際影響要用專案自己的測項庫按分類統計,不能用「19 類裡有幾類」代表涵蓋率。`,
      `Of ${CATEGORY_CAPABILITY.length} categories, ${a} run automatically, ${p} have gaps and ${n} are structurally out of reach. A category count is not an item count: real impact must be weighed against the project\u2019s own item library per category, not inferred from how many of the categories are covered.`,
    ),
  };
}
