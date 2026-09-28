/**
 * 使用說明頁的內容(依語系)。zh-Hant 與 en 為完整版;其餘語系回退 en。
 * 內容須忠實反映實際系統,不杜撰功能。
 */
import type { Locale } from '../i18n/messages.ts';

export interface GuideModel {
  name: string;
  modelId: string;
  seat: string;
  price: string;
  note: string;
}

export interface GuideStep {
  title: string;
  body: string;
}

export interface GuideSection {
  id: string;
  title: string;
  intro: string;
  steps?: GuideStep[];
}

export interface GuideGlossaryItem {
  term: string;
  desc: string;
}

export interface GuideContent {
  heroTitle: string;
  heroLead: string;
  /** ① 系統用途(≤100 字)。 */
  purposeTitle: string;
  purposeBody: string;
  /** ② 技術架構說明 —— 操作流程圖區塊標題/引言。 */
  flowTitle: string;
  flowLead: string;
  /** ③ 系統架構說明 —— AWS 架構圖區塊標題/引言。 */
  archTitle: string;
  archLead: string;
  /** 架構流程節點(依序,文字補充)。 */
  flow: { label: string; desc: string }[];
  sections: GuideSection[];
  seatsTitle: string;
  seatsLead: string;
  seats: { seat: string; role: string }[];
  modelsTitle: string;
  modelsLead: string;
  models: GuideModel[];
  modelsFootnote: string;
  costTitle: string;
  costBody: string;
  /** ④ 技術名詞說明。 */
  glossaryTitle: string;
  glossary: GuideGlossaryItem[];
  /** ④ 區塊大標與各小節標題。 */
  detailsTitle: string;
  featuresTitle: string;
}

const zhHant: GuideContent = {
  heroTitle: 'PlayAgent Checker 使用說明',
  heroLead:
    '這份說明分四部分:系統用途、操作流程、系統架構,以及技術名詞與模型細節。',
  purposeTitle: '系統用途',
  purposeBody:
    'AI 驅動的遊戲/App 自動化測試平台。你用白話描述要測的流程,AI 就會自己看畫面、點擊操作、判斷成敗,並產出含截圖的多語報告。',
  flowTitle: '技術架構說明',
  flowLead:
    '從上傳產物到拿到報告的完整流程如下。核心是先讓 Agent 自主探索、建出記憶地圖,再據此產生測試場景範本。第六步「掛知識庫」是可選的。',
  archTitle: '系統架構說明',
  archLead:
    '這是實際部署在 AWS us-east-2 的雲端架構。每個方框都標了對應的 AWS 服務;綠框=已端到端驗證,橘色虛線框=已有程式骨架但尚未端到端驗證。連線顏色代表資料流類型(見圖下圖例)。',
  flow: [
    { label: '① 產物擷取', desc: '上傳被測 App(APK/IPA/ZIP)或設定 Web,填類型、版本、識別碼。' },
    { label: '② 自主探索', desc: '依應用類型,Agent 自主遊玩、走遍可達畫面,收集畫面與轉移。' },
    { label: '③ 記憶地圖', desc: '把探索所得的畫面節點與操作轉移,匯成一張導覽記憶地圖。' },
    { label: '④ 場景範本', desc: '依記憶地圖上的可達路徑,自動產生測試場景範本供挑選。' },
    { label: '⑤ AI 編修範本', desc: '用自然語言微調範本,AI 產出可執行的 YAML 案例。' },
    { label: '⑥ 知識庫', desc: '(可選)掛內建遊戲類型知識,或自建特殊知識(Markdown / PDF 檢索)。' },
    { label: '⑦ 任務建立', desc: '選裝置後端、附加範本與知識庫,送入雲端佇列執行。' },
    { label: '⑧ Agent 執行', desc: '截圖 → VLM 判座標 → Agent 決策 → 執行操作 → 再截圖,循環並回饋記憶地圖。' },
    { label: '⑨ 報告產出', desc: '依型態產出含截圖、逐步軌跡、成本與導覽圖的多語報告。' },
  ],
  sections: [
    {
      id: 'apps',
      title: '應用管理',
      intro: '被測遊戲/App 的入口。每款 App 是一個工作區,點進去可看它的案例、任務、報告、記憶。',
      steps: [
        { title: '建立應用', body: '點「建立應用程式」,填名稱、平台、遊戲類型;Android/iOS/Windows 需上傳產物(APK/IPA/ZIP),Web 不用。可上傳圖示當小截圖。' },
        { title: '遊戲類型', body: '選 Slot、MMORPG、RPG 等類型(帶小圖示),用於分類與篩選,也能對應知識庫。' },
        { title: '進入工作區', body: '點卡片或「進入工作區」,在分頁中集中管理這款遊戲的所有測試資料。' },
      ],
    },
    {
      id: 'cases',
      title: '測試案例',
      intro: '一個案例 = 一段要 AI 執行的測試流程。支援自然語言草擬與手寫 YAML。',
      steps: [
        { title: '用 AI 草擬', body: '選所屬 App,用自然語言描述(例如「開啟遊戲,登入後完成第一個關卡」),按「用 AI 草擬」,系統用 Claude 產出 YAML 草稿供你審閱修改。' },
        { title: '密鑰邊界', body: '案例中不可寫字面量密碼;需登入時用 ${ENV} 佔位或機密引用,系統會擋下明文密鑰。' },
        { title: '編輯/刪除', body: '每個案例可再編輯名稱與 YAML,或刪除。' },
      ],
    },
    {
      id: 'tasks',
      title: '測試任務',
      intro: '把某個案例送去實際執行。可選執行環境並多選知識庫。',
      steps: [
        { title: '提交', body: '選 App + 案例 + 執行環境。目前可端到端執行的是 Web 瀏覽器與 Android 模擬器;其餘(Windows、Device Farm 實機、本地裝置)標「尚未支援」。' },
        { title: '掛知識庫', body: '可複選知識庫(例如 Slot + RTP),執行時一起注入,讓 AI 依這些知識測試。' },
        { title: '監看與取消', body: '執行中的任務可即時監看畫面與軌跡;可取消進行中的任務,或刪除已結束的任務紀錄。' },
      ],
    },
    {
      id: 'reports',
      title: '測試報告',
      intro: '任務完成後的產出,唯讀。含 AI 敘述、逐步軌跡、遊戲畫面截圖與導覽關係圖。',
      steps: [
        { title: '多語敘述', body: '報告的 AI 敘述可切換語言(繁中/英固定,其餘視預生成而定)。' },
        { title: '成本', body: '報告顯示本次的預算上限、實際花費與 token 用量。' },
      ],
    },
    {
      id: 'memory',
      title: '記憶地圖',
      intro: '跨多次測試累積的 App 全景:AI 走過的畫面成為節點、操作轉移成為連線,幫助後續測試更快定位。',
    },
    {
      id: 'knowledge',
      title: '知識管理',
      intro:
        '可重用的知識庫,跨所有登入使用者共用。分兩種:遊戲類別型(如 Slot)與情境型(如 RTP)。每座可放兩種知識:',
      steps: [
        { title: 'Markdown 知識', body: '在網頁直接編輯的 Markdown,執行時整份注入 AI —— 適合「少量確定事實/術語/判讀規則」。' },
        { title: 'PDF/文件檢索', body: '建立時勾「啟用文件檢索」會建雲端向量知識庫,可上傳 PDF/攻略/企畫,按「同步」後 AI 執行時依任務目標檢索相關片段 —— 適合「大量參考資料」。' },
        { title: '測試時多選', body: '建立測試時複選要用的知識庫,兩層(通用類別 + 特定情境)可疊加。App 也能設預設知識庫。' },
      ],
    },
    {
      id: 'devices',
      title: '裝置管理',
      intro:
        '雲端裝置(Android 模擬器 / Windows / Device Farm)在任務執行時自動建立、結束即回收,無需手動管理。你也可以註冊本地裝置:在自己機器上跑代理程式,主動連上雲端,畫面上送、雲端判斷、指令回傳。',
    },
  ],
  seatsTitle: '模型職責(三個 Seat)',
  seatsLead:
    '系統把模型依「職責」分為三個 Seat,而不是綁定某個供應商。每個 Seat 可獨立選模型,執行前會鎖定單價快照(查不到價則拒絕執行,絕不以未知成本起跑)。',
  seats: [
    { seat: 'Agent(決策)', role: '主腦:看當前畫面與目標,決定下一步做什麼(點哪、輸入什麼、是否完成)。' },
    { seat: 'VLM(判座標)', role: '視覺:把「要點的東西」轉成畫面上的實際座標(x, y),讓點擊落在正確位置。' },
    { seat: 'Subagent(輔助)', role: '輔助:處理較輕量的子任務,用較便宜的模型省成本。' },
  ],
  modelsTitle: '可用模型',
  modelsLead:
    '以下是後端模型目錄目前「全部」可用的模型(直接向 /models API 取得,隨 Bedrock 目錄更新,不會過時)。你可以針對不同 App、不同 Seat 換模型調效能。有視覺能力的模型才可坐 VLM(要看截圖判座標),純文字模型只坐 Agent/Subagent。使用者不需選 Channel/SDK,系統依 modelId 自動推導;非 Anthropic 模型的價格由 AWS Pricing API 抓取並標「估算」。',
  models: [
    {
      name: 'Claude Sonnet 4.5',
      modelId: 'us.anthropic.claude-sonnet-4-5',
      seat: 'Agent / VLM / Subagent',
      price: '$3 / $15 每百萬 token',
      note: '主力模型,座標系為像素。',
    },
    {
      name: 'Claude Opus 4.7',
      modelId: 'us.anthropic.claude-opus-4-7',
      seat: 'Agent',
      price: '$15 / $75 每百萬 token',
      note: '最強決策,成本最高;適合難度高的流程。',
    },
    {
      name: 'Claude 3 Haiku',
      modelId: 'us.anthropic.claude-3-haiku',
      seat: 'Subagent',
      price: '$0.25 / $1.25 每百萬 token',
      note: '最便宜,用於輔助子任務。',
    },
  ],
  modelsFootnote:
    '知識庫的 PDF 檢索另用 Amazon Titan Text Embeddings v2(1024 維)產生向量、以 Amazon Bedrock Knowledge Bases + S3 Vectors 儲存與檢索。',
  costTitle: '成本護欄',
  costBody:
    '每個任務都有預算上限。執行前先鎖定各 Seat 模型的單價快照(Fail Closed:查不到價就拒絕執行);執行中累計花費達上限即停止。報告會顯示實際花費與 token 用量,方便你控管成本。',
  detailsTitle: '技術名詞說明與模型細節',
  featuresTitle: '各功能操作',
  glossaryTitle: '技術名詞',
  glossary: [
    { term: 'Seat(座位)', desc: '模型的「職責」而非供應商。分 Agent(決策)、VLM(判座標)、SubAgent(輔助)三種,可各自選不同模型。' },
    { term: 'VLM', desc: 'Vision-Language Model,能同時看圖與讀文字的模型;負責把「要點的東西」轉成畫面上的實際座標。' },
    { term: 'Agent 執行迴圈', desc: '截圖 → VLM 判座標 → Agent 決策 → 執行動作 → 再截圖,如此循環直到完成或停止。引擎恆在雲端。' },
    { term: '座標系(pixel / norm1000)', desc: '模型回報座標的單位。Claude 系為像素;部分模型用千分制(0–1000)再換算成實際像素。' },
    { term: 'Channel', desc: 'SDK+端點+認證的組合,由 modelId 自動推導(bedrock / bedrock-converse / openai),使用者不需選。' },
    { term: '知識庫(Markdown / 檢索)', desc: 'Markdown 整份注入 AI(少量確定事實);PDF/文件則建向量庫,執行時依任務目標檢索片段(大量資料)。' },
    { term: 'Locality(運行地)', desc: '被測裝置在哪:cloud(雲端供給)或 attached(你註冊的本地裝置,仍由雲端大腦遠端驅動)。' },
    { term: '終局狀態', desc: '任務的互斥結束狀態:pass / fail / error / cancelled / budget_exceeded / dead。' },
    { term: 'Fail Closed', desc: '查不到某模型單價時,在花任何錢之前直接拒絕執行,絕不以未知成本起跑。' },
    { term: 'S3 Vectors', desc: 'Amazon Bedrock Knowledge Bases 的向量儲存後端,搭配 Titan 文字嵌入做文件檢索。' },
  ],
};

const en: GuideContent = {
  heroTitle: 'PlayAgent Checker Guide',
  heroLead:
    'Four parts: what the system is for, how you use it, the system architecture, and technical terms & model details.',
  purposeTitle: 'What it is for',
  purposeBody:
    'An AI-driven automated testing platform for games/apps. Describe a flow in plain words and the AI watches the screen, taps for you, judges pass/fail, and produces multilingual reports with screenshots.',
  flowTitle: 'How it works',
  flowLead:
    'From creating an app to getting a report, here is the whole workflow. Step 3 (attach knowledge) is optional.',
  archTitle: 'System architecture',
  archLead:
    'The actual cloud architecture deployed on AWS us-east-2. Every box is labeled with its AWS service; green = verified end-to-end, dashed orange = scaffolded but not yet verified. Edge colors show the data-flow type (see legend below the diagram).',
  flow: [
    { label: '① App', desc: 'Upload the app under test (APK/IPA/ZIP) or set up Web; fill genre, version, identifier.' },
    { label: '② Test case', desc: 'Describe the flow in plain language; AI drafts an executable YAML case.' },
    { label: '③ Knowledge', desc: '(Optional) attach category/scenario knowledge (Markdown or PDF retrieval) so the AI understands the game.' },
    { label: '④ Submit task', desc: 'Pick App + case + runtime (Web / Android emulator); enqueue in the cloud.' },
    { label: '⑤ AI runs', desc: 'Engine screenshots → VLM finds coordinates → Agent decides → taps → screenshots again, looping until done or stopped.' },
    { label: '⑥ Report & memory', desc: 'Produces a multilingual report with screenshots, step trace, and navigation graph; visited screens accumulate into a memory map.' },
  ],
  sections: [
    {
      id: 'apps',
      title: 'Apps',
      intro: 'The entry point for each game/app under test. Each app is a workspace holding its cases, tasks, reports, and memory.',
      steps: [
        { title: 'Create an app', body: 'Click Create app; fill name, platform, genre. Android/iOS/Windows need an artifact (APK/IPA/ZIP); Web does not. You can upload an icon as a thumbnail.' },
        { title: 'Genre', body: 'Pick Slot, MMORPG, RPG, etc. (with icons) — used for grouping/filtering and to match knowledge bases.' },
        { title: 'Open workspace', body: 'Click a card or Open workspace to manage all of a game\u2019s test data in tabs.' },
      ],
    },
    {
      id: 'cases',
      title: 'Test Cases',
      intro: 'A case = one test flow for the AI to run. Supports AI drafting and hand-written YAML.',
      steps: [
        { title: 'Draft with AI', body: 'Pick the app, describe the flow in plain language (e.g. "open the game, log in, finish level 1"), click Draft with AI; the system uses Claude to produce YAML for you to review.' },
        { title: 'Secret boundary', body: 'No literal passwords in cases; use ${ENV} placeholders or secret references for login. Literal secrets are rejected.' },
        { title: 'Edit / delete', body: 'Each case can be renamed, its YAML edited, or deleted.' },
      ],
    },
    {
      id: 'tasks',
      title: 'Test Tasks',
      intro: 'Send a case to actually run. Choose a runtime and multi-select knowledge bases.',
      steps: [
        { title: 'Submit', body: 'Pick App + case + runtime. Web browser and Android emulator run end-to-end today; others (Windows, Device Farm, local device) are marked not yet supported.' },
        { title: 'Attach knowledge', body: 'Multi-select knowledge bases (e.g. Slot + RTP); they are injected together so the AI tests against that knowledge.' },
        { title: 'Watch & cancel', body: 'Watch a running task live; cancel an in-progress task, or delete a finished task record.' },
      ],
    },
    {
      id: 'reports',
      title: 'Test Reports',
      intro: 'Read-only output after a task completes: AI narrative, step trace, gameplay screenshots, navigation graph.',
      steps: [
        { title: 'Multilingual narrative', body: 'The AI narrative can switch language (zh-Hant/en always; others depend on pre-generation).' },
        { title: 'Cost', body: 'The report shows the budget, actual spend, and token usage for the run.' },
      ],
    },
    {
      id: 'memory',
      title: 'Memory Map',
      intro: 'An app-wide picture accumulated across tests: screens the AI visited become nodes, transitions become edges, helping later tests navigate faster.',
    },
    {
      id: 'knowledge',
      title: 'Knowledge',
      intro:
        'Reusable knowledge bases, shared across all logged-in users. Two kinds: game category (e.g. Slot) and scenario (e.g. RTP). Each can hold two forms of knowledge:',
      steps: [
        { title: 'Markdown knowledge', body: 'Markdown you edit in the browser, injected in full at run time — best for a small set of certain facts / terminology / reading rules.' },
        { title: 'PDF/document retrieval', body: 'Checking "enable document retrieval" at creation builds a cloud vector knowledge base; upload PDFs/guides/specs, click Sync, and the AI retrieves relevant snippets by task goal at run time — best for large reference material.' },
        { title: 'Multi-select at run', body: 'Select multiple knowledge bases per run; a general category + a specific scenario can stack. Apps can also set default knowledge bases.' },
      ],
    },
    {
      id: 'devices',
      title: 'Devices',
      intro:
        'Cloud devices (Android emulator / Windows / Device Farm) are created automatically per task and reclaimed when done — no manual management. You can also register a local device: run the agent on your own machine; it dials out to the cloud, frames go up, the cloud decides, commands come back.',
    },
  ],
  seatsTitle: 'Model roles (three Seats)',
  seatsLead:
    'Models are organized by role into three Seats, not by vendor. Each Seat picks its own model; a price snapshot is locked before running (if a price is unknown, the run is refused — never start at unknown cost).',
  seats: [
    { seat: 'Agent (decision)', role: 'The brain: looks at the current screen and goal, decides the next action (where to tap, what to type, whether done).' },
    { seat: 'VLM (coordinates)', role: 'Vision: turns "the thing to tap" into actual on-screen coordinates (x, y) so taps land correctly.' },
    { seat: 'Subagent (helper)', role: 'Helper: handles lighter sub-tasks with a cheaper model to save cost.' },
  ],
  modelsTitle: 'Available models',
  modelsLead:
    'Below is the complete set of models currently in the backend catalog (fetched live from the /models API, so it never goes stale). You can swap models per app and per seat to tune performance. Only vision-capable models can take the VLM seat (it reads screenshots to locate coordinates); text-only models take Agent/Subagent. You never pick a Channel/SDK — the system derives it from the modelId; non-Anthropic prices come from the AWS Pricing API and are marked "estimated".',
  models: [
    {
      name: 'Claude Sonnet 4.5',
      modelId: 'us.anthropic.claude-sonnet-4-5',
      seat: 'Agent / VLM / Subagent',
      price: '$3 / $15 per 1M tokens',
      note: 'Primary model; pixel coordinate system.',
    },
    {
      name: 'Claude Opus 4.7',
      modelId: 'us.anthropic.claude-opus-4-7',
      seat: 'Agent',
      price: '$15 / $75 per 1M tokens',
      note: 'Strongest decision-making, highest cost; for harder flows.',
    },
    {
      name: 'Claude 3 Haiku',
      modelId: 'us.anthropic.claude-3-haiku',
      seat: 'Subagent',
      price: '$0.25 / $1.25 per 1M tokens',
      note: 'Cheapest, for helper sub-tasks.',
    },
  ],
  modelsFootnote:
    'PDF retrieval additionally uses Amazon Titan Text Embeddings v2 (1024-dim) for vectors, stored and queried via Amazon Bedrock Knowledge Bases + S3 Vectors.',
  costTitle: 'Cost guardrail',
  costBody:
    'Every task has a budget. Before running, a price snapshot is locked for each Seat model (Fail Closed: unknown price means the run is refused); during the run, execution stops once spend hits the budget. The report shows actual spend and token usage so you can manage cost.',
  detailsTitle: 'Technical terms & model details',
  featuresTitle: 'Feature guide',
  glossaryTitle: 'Glossary',
  glossary: [
    { term: 'Seat', desc: 'A model role, not a vendor. Three: Agent (decide), VLM (locate), SubAgent (helper); each can pick its own model.' },
    { term: 'VLM', desc: 'Vision-Language Model — reads image + text; turns "the thing to tap" into actual on-screen coordinates.' },
    { term: 'Agent loop', desc: 'Screenshot → VLM locates → Agent decides → act → screenshot again, looping until done or stopped. The engine always runs in the cloud.' },
    { term: 'Coordinate system (pixel / norm1000)', desc: 'Units the model reports coordinates in. Claude uses pixels; some models use 0–1000 normalized, then mapped to pixels.' },
    { term: 'Channel', desc: 'SDK+endpoint+auth combo, derived automatically from the modelId (bedrock / bedrock-converse / openai). You never pick it.' },
    { term: 'Knowledge base (Markdown / retrieval)', desc: 'Markdown is injected in full (small, certain facts); PDFs build a vector store queried by task goal (large reference material).' },
    { term: 'Locality', desc: 'Where the device under test is: cloud (cloud-provided) or attached (your registered local device, still driven by the cloud brain).' },
    { term: 'Terminal state', desc: 'Mutually exclusive end states of a task: pass / fail / error / cancelled / budget_exceeded / dead.' },
    { term: 'Fail Closed', desc: 'If a model price is unknown, the run is refused before spending anything — never start at unknown cost.' },
    { term: 'S3 Vectors', desc: 'Vector store backend for Amazon Bedrock Knowledge Bases, paired with Titan text embeddings for document retrieval.' },
  ],
};

const CONTENT: Record<Locale, GuideContent> = {
  'zh-Hant': zhHant,
  en,
  'zh-Hans': zhHant, // 暫以繁中呈現(內容為主,非 UI 字串);可日後補簡中
  ja: en,
  ko: en,
};

export function guideContent(locale: Locale): GuideContent {
  return CONTENT[locale] ?? en;
}
