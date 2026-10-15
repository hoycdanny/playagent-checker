/**
 * 使用說明頁的內容(依語系)。zh-Hant 與 en 在本檔;zh-Hans / ja / ko 在 ./guide/。
 * 內容須忠實反映實際系統,不杜撰功能。改功能時記得同步改這裡(五個語系)。
 */
import type { Locale } from '../i18n/messages.ts';
import { zhHans } from './guide/zhHans.ts';
import { ja } from './guide/ja.ts';
import { ko } from './guide/ko.ts';

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
  heroTitle: '使用說明',
  heroLead:
    '這份說明分四部分:系統用途、操作流程、系統架構,以及技術名詞、模型、費用與各功能的詳細操作。',
  purposeTitle: '系統用途',
  purposeBody:
    'AI 驅動的遊戲/App 自動化測試平台。你用白話描述要測的流程,AI 就會自己看畫面、點擊操作、判斷成敗,並產出含截圖的多語報告。',
  flowTitle: '技術架構說明',
  flowLead:
    '從上傳產物到拿到報告的完整流程如下。核心是先讓 Agent 自主探索、建出記憶地圖,再據此產生測試場景範本。第六步「掛知識庫」是可選的。',
  archTitle: '系統架構說明',
  archLead:
    '這是實際部署在 AWS us-east-2 的雲端架構。每個方框都標了對應的 AWS 服務;綠框=已端到端驗證,橘色虛線框=已有程式骨架但尚未端到端驗證。連線顏色代表資料流類型(見圖下圖例)。所有執行資源都是「有任務才開、結束就關」,沒有常駐主機。',
  flow: [
    { label: '① 產物擷取', desc: '上傳被測 App(APK/IPA/XAPK/ZIP/EXE)或設定 Web 網址,填類型、版本、識別碼。' },
    { label: '② 自主探索', desc: '依應用類型,Agent 自主遊玩、走遍可達畫面,收集畫面與轉移。' },
    { label: '③ 記憶地圖', desc: '把探索所得的畫面節點與操作轉移,匯成一張導覽記憶地圖。' },
    { label: '④ 場景範本', desc: '依記憶地圖上的可達路徑,自動產生測試場景範本供挑選。' },
    { label: '⑤ AI 編修範本', desc: '用自然語言微調範本,AI 產出可執行的 YAML 案例。' },
    { label: '⑥ 知識庫', desc: '(可選)掛內建遊戲類型知識,或自建特殊知識(Markdown / PDF 檢索)。' },
    { label: '⑦ 任務建立', desc: '選執行環境、模型與知識庫,送入雲端佇列執行。' },
    { label: '⑧ Agent 執行', desc: '截圖 → VLM 判座標 → Agent 決策 → 執行操作 → 再截圖,循環並回饋記憶地圖。' },
    { label: '⑨ 報告產出', desc: '依型態產出含截圖、逐步軌跡、成本與導覽圖的多語報告。' },
  ],
  sections: [
    {
      id: 'quickstart',
      title: '快速開始:第一次跑測試',
      intro: '第一次使用時照下面五步走,大約 10 分鐘就能看到第一份報告。',
      steps: [
        { title: '1. 建立應用', body: '上方「應用管理」→「建立應用程式」,填名稱、平台、遊戲類型,上傳安裝檔(Web 則填網址)。' },
        { title: '2. 設定測試憑證(需要登入才填)', body: '進入應用工作區 →「測試憑證」分頁,把帳號、密碼等填成一列一個欄位。不需要登入的遊戲可以跳過。' },
        { title: '3. 寫測試案例', body: '「測試案例」分頁 → 用白話描述流程(例如「用訪客登入,進入拉霸機台,連續轉 10 次」)→「用 AI 草擬」→ 檢查後儲存。' },
        { title: '4. 送出任務', body: '「測試任務」分頁 → 選案例與執行環境。第一次建議先用預設模型、把「步數上限」設 50~100,避免意外花太多。' },
        { title: '5. 看結果', body: '任務詳情頁可即時看畫面與 AI 的思考;結束後點「查看報告」看判定、截圖與花費。' },
      ],
    },
    {
      id: 'runtimes',
      title: '執行環境怎麼選',
      intro: '送出任務時要選「在哪裡跑」。每種環境都是有任務才開、結束就關,只在執行期間計費。',
      steps: [
        { title: 'Web 瀏覽器', body: '雲端無頭 Chromium(Playwright)。給網頁遊戲或網站用,啟動最快、最便宜(約每小時 US$0.05)。' },
        { title: 'Android 真機(Device Farm)', body: 'AWS Device Farm 的實體手機。最接近玩家實際環境,有錄影與音效判斷,遊戲不會偵測到模擬器。每台每分鐘 US$0.17;單次連線最長 150 分鐘(AWS 限制),開機約 3~5 分鐘。可指定機型,或留「自動」挑第一台可用的。' },
        { title: 'Android 真機・長時', body: '超過 150 分鐘的測試用。系統每 140 分鐘換一條新連線,換線時遊戲會重啟,所以測試腳本要能自己回到測試點。' },
        { title: 'iOS 真機(Device Farm)', body: '需要可以安裝的 .ipa 檔。單次連線最長 150 分鐘,錄影沒有聲音。' },
        { title: 'Android 容器(Redroid)', body: '每個任務開一台 ARM 雲端主機跑 Android 容器(約每小時 US$0.17),可以跑 1~72 小時、也適合大量平行。限制:有反模擬器檢查的遊戲會自己關閉(例如嘎嘎特攻),這類請改用真機;沒有錄影與音效判斷;不支援雙指縮放。' },
        { title: 'Windows PC 遊戲(GameLift Streams)', body: '雲端 NVIDIA GPU 主機,需要管理員先做一次性設定才會出現。單次最長 60 分鐘;解析度總像素最多 1920×1080(直式最多 1080×1920);首次啟動約 10~15 分鐘。' },
        { title: '怎麼判斷', body: '一般手機遊戲先用 Android 容器(便宜、可長跑);遊戲一開就閉退,或要驗證音效、錄影,改用真機;網頁遊戲用 Web。' },
      ],
    },
    {
      id: 'apps',
      title: '應用管理',
      intro: '被測遊戲/App 的入口。每款 App 是一個工作區,裡面集中放它的測試案例、任務、報告、記憶地圖與測試憑證。',
      steps: [
        { title: '建立應用', body: '點「建立應用程式」,填名稱、平台、遊戲類型;Android/iOS/Windows 需上傳安裝檔(APK、XAPK、IPA、ZIP 或 EXE),Web 填網址即可。可上傳圖示。' },
        { title: '遊戲類型', body: '選主類型(Slot、MMORPG、RPG、休閒等)與次要類型。系統會依類型自動掛上對應的內建知識庫,報告也會套用該類型的判定規格。' },
        { title: '識別碼', body: 'Android 填套件名稱(例如 com.example.game)。系統用它在裝置上啟動與偵測 App,也用來過濾裝置 log。' },
        { title: '版本', body: '同一款 App 可以上傳多個版本,送任務時選要測哪一版;報告會記錄測的是哪一版,方便比對不同版本的結果。' },
        { title: '進入工作區', body: '點卡片或「進入工作區」,用分頁切換這款遊戲的案例、任務、報告、記憶地圖與測試憑證。' },
      ],
    },
    {
      id: 'credentials',
      title: '測試憑證(帳號密碼)',
      intro: '需要登入、註冊或選伺服器的流程,把帳號密碼存在這裡,AI 會在遇到表單時自己填,案例裡不用寫。',
      steps: [
        { title: '新增欄位', body: '應用工作區 →「測試憑證」→ 每個欄位一列,例如「帳號」、「密碼」、「伺服器名稱」。欄位名稱可以用中文。' },
        { title: '遮罩(預設)', body: '帳號密碼這類機密用遮罩。AI 永遠看不到值,只知道有這個欄位,輸入時打 ${帳號},由執行端在輸入當下換成真正的值。' },
        { title: '可見給 AI', body: '只給「AI 必須從清單中選出來」且不敏感的值,例如伺服器名稱。可見的值會進入 AI 的上下文。' },
        { title: '安全性', body: '值只存在 AWS Secrets Manager。遮罩值不會出現在畫面、API 回應、模型提示、S3、報告或執行軌跡;每個租戶的每個 App 只能讀到自己的憑證。案例裡直接寫密碼會被系統擋下。' },
      ],
    },
    {
      id: 'cases',
      title: '測試案例',
      intro: '一個案例 = 一段要 AI 執行的測試流程,加上用來判定成敗的條件(assertions)。',
      steps: [
        { title: '用 AI 草擬', body: '用白話描述流程,按「用 AI 草擬」,系統用 Claude Sonnet 4.5 產出 YAML 草稿(含步驟與判定條件),你審閱修改後儲存。' },
        { title: '寫好案例的訣竅', body: '寫清楚起點、要做的事與完成條件,例如「用訪客 Play now 進入 → 關掉所有彈窗 → 進 Slots 任一台 → 連續轉 10 次」。次數、金額這類數字寫明確,AI 才知道什麼時候算完成。' },
        { title: '從試算表匯入', body: '已有 Excel 測試清單時可以直接匯入:系統會讀表格版面、拆成一列一個案例,匯入前可逐列修改,也能整份匯成一個測試套件。' },
        { title: '版本', body: '每次修改都會留一個案例版本。送任務時預設用目前版本,也可以指定舊版本重跑。' },
        { title: '密鑰邊界', body: '案例中不可寫字面量密碼;需要登入時用「測試憑證」,系統會擋下明文密鑰。' },
      ],
    },
    {
      id: 'tasks',
      title: '測試任務',
      intro: '把某個案例送去實際執行,並在執行中即時監看與介入。',
      steps: [
        { title: '送出', body: '選案例、執行環境(見上方「執行環境怎麼選」),以及要測的版本。Device Farm 可指定機型;Android 容器與 Windows 可選最長執行時數;Windows 可選解析度。' },
        { title: '模型', body: '三個座位可各自換模型,預設是決策 Nova Lite、畫面分析 Kimi K3、輔助 Nova Micro。下拉選單會標價格與推薦星號。UI-TARS 只有在管理員開啟時才會出現。' },
        { title: '上限', body: '「步數上限」與「預算上限」都建議設定。花費達到預算就停止(狀態 budget_exceeded);不設代表沒有上限。' },
        { title: '知識庫', body: '可複選知識庫(例如 Slot + RTP)。App 的預設知識庫與類型內建知識會自動帶入。' },
        { title: '即時畫面', body: '任務詳情頁上方的時間軸顯示開機各階段與耗時。開好後可看即時畫面,點畫面可放大到新視窗(適合雙螢幕)。' },
        { title: '與控制遊戲 Agent 互動', body: '執行中在即時畫面上點一下或拖一下,按「直接點這裡」/「直接照這樣拖」,系統會馬上在裝置上執行(不經 AI),並把座標告訴控制遊戲 Agent。也可以打字告訴 Agent 該怎麼做,它下一步照做。勾「記住」會把提示存進這款 App 的記憶,之後的任務也會用到。' },
        { title: '右側日誌', body: '分頁切換:裝置 log(真機與 Android 容器的 logcat,閃退原因看這裡)、音效、視覺/決策/輔助 Agent 每一步的輸入輸出、即時分析,以及各模型的 token 用量。' },
        { title: '取消與刪除', body: '進行中的任務可以取消(會停止計費);已結束的任務紀錄可以刪除。' },
      ],
    },
    {
      id: 'reports',
      title: '測試報告',
      intro: '任務結束後的產出,唯讀。內容依遊戲類型的報告規格整理。',
      steps: [
        { title: '判定', body: '每個判定條件各自標通過或失敗,並附上證據截圖與 AI 的理由。fail 通常是被測 App 或案例的問題;error 通常是環境或基礎設施的問題。' },
        { title: '軌跡與截圖', body: '逐步列出 AI 看到的畫面、決定的動作與結果。真機任務有整場錄影(含聲音),點某一步可直接跳到那一段。' },
        { title: '導覽圖', body: '這次走過的畫面與轉移,同時會累積進記憶地圖。' },
        { title: '成本', body: '顯示預算上限、實際花費與各模型的 token 用量。' },
        { title: '多語', body: '報告的 AI 敘述可切換語言。' },
      ],
    },
    {
      id: 'memory',
      title: '記憶地圖',
      intro: '跨多次測試累積的 App 全景:AI 走過的畫面成為節點、操作轉移成為連線,幫助後續測試更快走到目標。測試人員在任務中「記住」的提示也存在這裡。可以清除某款 App 的記憶重新累積。',
    },
    {
      id: 'knowledge',
      title: '知識管理',
      intro:
        '可重用的知識庫,跨所有登入使用者共用。分兩種:遊戲類別型(如 Slot)與情境型(如 RTP)。每座可放兩種知識:',
      steps: [
        { title: '內建知識庫', body: '系統內建各遊戲類型的知識(例如 Slot、Casino、大逃殺)。想客製時可以複製一份來改,之後就用你的版本取代內建版本,不會重複注入。' },
        { title: 'Markdown 知識', body: '在網頁直接編輯的 Markdown,執行時整份注入 AI,適合「少量確定事實、術語、判讀規則」。' },
        { title: 'PDF/文件檢索', body: '建立時勾「啟用文件檢索」會建雲端向量知識庫,可上傳 PDF、攻略、企畫書,按「同步」後 AI 執行時依任務目標檢索相關片段,適合「大量參考資料」。' },
        { title: '測試時多選', body: '建立測試時複選要用的知識庫,兩層(通用類別 + 特定情境)可疊加。App 也能設預設知識庫。正在被 App 或案例使用的知識庫不能直接刪除。' },
      ],
    },
    {
      id: 'devices',
      title: '裝置管理',
      intro: '看目前有哪些執行資源。執行容器與主機都是任務送出時自動建立、結束時自動回收,不需要手動管理。',
      steps: [
        { title: '雲端真機', body: 'Device Farm 目前可用的實體手機清單(機型、系統版本、解析度、記憶體、CPU)。' },
        { title: '容器 / 主機 / 串流', body: '正在跑的 Fargate 容器、Android 容器主機(EC2),以及 Windows 串流容量。忘記取消的長時間任務可以在這裡發現。' },
      ],
    },
    {
      id: 'cost',
      title: '費用分析',
      intro: '兩種數字並列,基準不同,不要互相相減。',
      steps: [
        { title: '任務估算', body: '每次任務的模型 token × 單價,加上 Device Farm 實際計量分鐘 × US$0.17,依天、依 App、依模型統計。打開就能用。' },
        { title: 'AWS 真實帳單', body: '從 AWS Cost Explorer 讀取,包含所有基礎設施。需要帳號擁有者先啟用 Cost Explorer 與成本分攤標籤,資料約延遲 24 小時,每次查詢 AWS 收約 US$0.01。' },
      ],
    },
    {
      id: 'members',
      title: '成員管理(管理員)',
      intro: '只有管理員看得到。系統不開放自行註冊,所有帳號都在這裡建立。',
      steps: [
        { title: '新增成員', body: '填 email、初始密碼與租戶(tenant)。租戶決定這個人看得到哪一份資料,不同租戶的資料互相隔離。可以直接設為管理員。' },
        { title: '管理', body: '可重設密碼、停用/啟用、移到別的租戶、授予或取消管理員、刪除。系統會擋下會把自己鎖在外面的操作(例如取消自己的管理員)。' },
        { title: '權限生效', body: '被設為管理員的人要登出再登入,才會看到管理員頁面。' },
      ],
    },
    {
      id: 'system',
      title: '系統管理(管理員)',
      intro: '平台本身的維護:從 GitHub 更新整個系統,以及開關 UI-TARS 定位模型。',
      steps: [
        { title: '系統更新', body: '頁面會比對目前部署的版本與 GitHub 上的最新版本。按「更新到…」並輸入版本字串確認後,雲端會先跑測試,通過才重新部署前端、API 與執行環境,約 5~15 分鐘,可即時看進度與 log。每次更新都記在更新歷史。' },
        { title: '更新注意', body: '這個動作會以高權限重新部署整個平台,建議在沒有任務執行時進行。要回到舊版,就在輸入框打舊的 commit 或 tag 再更新一次。第一次使用要先貼上 GitHub token(只需 Contents 與 Metadata 唯讀)。' },
        { title: 'UI-TARS 開關', body: 'UI-TARS 是專門做 GUI 定位的模型,跑在 GPU 上,開著就計費(約每天 US$62.5,不管有沒有任務),所以預設關閉。按「開啟」約 8~15 分鐘後變「已開啟」,建立任務的 VLM 選單才會出現它;不用時按「關閉」。目前只有 Device Farm 真機會用到。' },
      ],
    },
    {
      id: 'troubleshoot',
      title: '常見問題',
      intro: '遇到狀況時先看這裡。',
      steps: [
        { title: '遊戲一開就閃退(Android 容器)', body: '多半是遊戲有反模擬器檢查。打開任務的「裝置 log」看最後的錯誤,改用 Android 真機測。' },
        { title: '畫面一直不動,任務變 error', body: '安裝卡住、App 凍結或碰到驗證碼時,系統會先等待,畫面長時間完全沒變才結束任務,避免在計費的真機上空轉。' },
        { title: '任務變 budget_exceeded', body: '花費達到你設定的預算上限。調高預算或減少步數後重跑。' },
        { title: 'AI 一直點錯位置', body: '在即時畫面上點正確位置按「直接點這裡」,並勾「記住」;或在案例中把按鈕的位置與外觀描述得更具體。仍不準時,可請管理員暫時開啟 UI-TARS(真機任務)。' },
        { title: '選單裡沒有 UI-TARS', body: '代表 UI-TARS 目前是關閉的,請管理員到「系統管理」開啟。' },
        { title: '看不到成員管理 / 系統管理', body: '這兩頁只有管理員看得到;剛被設為管理員的話請登出再登入。' },
      ],
    },
  ],
  seatsTitle: '模型職責(三個 Seat)',
  seatsLead:
    '系統把模型依「職責」分為三個 Seat,而不是綁定某個供應商。每個 Seat 可獨立選模型,執行前會鎖定單價快照(查不到價則拒絕執行,絕不以未知成本起跑)。',
  seats: [
    { seat: 'Agent(決策)', role: '主腦:看當前畫面與目標,決定下一步做什麼(點哪、輸入什麼、是否完成)。預設 Amazon Nova Lite。' },
    { seat: 'VLM(判座標)', role: '視覺:讀畫面,把「要點的東西」轉成畫面上的實際座標(x, y)。預設 Moonshot Kimi K3。' },
    { seat: 'Subagent(輔助)', role: '輔助:核對每一步有沒有生效、整理數據、核對是否真的完成(會擋下假完成),用便宜的模型省成本。預設 Amazon Nova Micro。' },
  ],
  modelsTitle: '可用模型',
  modelsLead:
    '下表直接向後端取得完整的可用模型清單(隨目錄更新,不會過時)。有視覺能力的模型才可坐 VLM(要看截圖判座標),純文字模型只坐 Agent/Subagent。預設組合是 Nova Lite / Kimi K3 / Nova Micro;UI-TARS(SageMaker GPU)只有在管理員於「系統管理」開啟時才會列出。使用者不需選 SDK 或端點,系統依 modelId 自動推導;非 Anthropic 模型的價格由 AWS Pricing API 抓取並標「估算」。',
  models: [
    { name: 'Amazon Nova Lite(預設決策)', modelId: 'us.amazon.nova-lite-v1:0', seat: 'Agent', price: '$0.066 / $0.264 每百萬 token(估算)', note: '預設決策模型,便宜且夠用。' },
    { name: 'Moonshot Kimi K3(預設畫面分析)', modelId: 'us.moonshotai.kimi-k3', seat: 'VLM', price: '$3.63 / $18.15 每百萬 token(估算)', note: '離線定位基準中像素誤差最小。' },
    { name: 'Amazon Nova Micro(預設輔助)', modelId: 'us.amazon.nova-micro-v1:0', seat: 'Subagent', price: '$0.0385 / $0.154 每百萬 token(估算)', note: '最省的輔助模型。' },
    { name: 'UI-TARS-1.5-7B(選用)', modelId: 'uitars', seat: 'VLM', price: 'GPU 開著就計費,約每天 US$62.5', note: '預設關閉,管理員在系統管理開啟。' },
  ],
  modelsFootnote:
    '測試案例草擬與試算表匯入使用 Claude Sonnet 4.5。知識庫的 PDF 檢索另用 Amazon Titan Text Embeddings v2(1024 維)產生向量、以 Amazon Bedrock Knowledge Bases + S3 Vectors 儲存與檢索。',
  costTitle: '費用與成本護欄',
  costBody:
    '沒有任務時,平台本身每月大約只要 US$2~5(主要是 S3 與映像儲存),因為沒有常駐主機。費用主要來自執行期間:AI 模型 token(以預設模型跑一次 26 步、轉 10 次的拉霸測試不到 US$0.80)、Device Farm 真機每分鐘 US$0.17、Android 容器主機每小時約 US$0.17。唯一的大筆選用費用是 UI-TARS GPU(開著約每天 US$62.5),預設關閉。每個任務可設步數與預算上限;執行前先鎖定各 Seat 的單價快照(查不到價就拒絕執行),花費達上限即停止,報告會顯示實際花費與 token 用量。',
  detailsTitle: '技術名詞、模型、費用與各功能操作',
  featuresTitle: '各功能操作',
  glossaryTitle: '技術名詞',
  glossary: [
    { term: 'Seat(座位)', desc: '模型的「職責」而非供應商。分 Agent(決策)、VLM(判座標)、Subagent(輔助)三種,可各自選不同模型。' },
    { term: 'VLM', desc: 'Vision-Language Model,能同時看圖與讀文字的模型;負責把「要點的東西」轉成畫面上的實際座標。' },
    { term: 'UI-TARS', desc: '專為 GUI 操作/座標定位微調的視覺模型(ByteDance),部署在 SageMaker GPU。選用、預設關閉,由管理員在「系統管理」開關;目前只有 Device Farm 真機會用到。' },
    { term: 'Redroid', desc: '在雲端 ARM 主機上以容器方式執行的 Android,即「Android 容器」執行環境。' },
    { term: 'Device Farm', desc: 'AWS 的實體手機租用服務,依使用分鐘計費,單次連線最長 150 分鐘。' },
    { term: 'GameLift Streams', desc: 'AWS 的雲端 GPU 串流服務,本系統用它跑 Windows PC 遊戲,沒有測試時不保留容量、不計費。' },
    { term: 'Agent 執行迴圈', desc: '截圖 → VLM 判座標 → Agent 決策 → 執行動作 → 再截圖,如此循環直到完成或停止。由雲端的 Lambda 編排,執行端在 Fargate、EC2 或 GameLift Streams。' },
    { term: '座標系(pixel / norm1000)', desc: '模型回報座標的單位。有些模型回像素,有些用千分制(0–1000),系統會自動換算成實際像素。' },
    { term: '知識庫(Markdown / 檢索)', desc: 'Markdown 整份注入 AI(少量確定事實);PDF/文件則建向量庫,執行時依任務目標檢索片段(大量資料)。' },
    { term: '租戶(Tenant)', desc: '資料隔離單位。每個帳號屬於一個租戶,只看得到自己租戶的 App、案例、任務與報告。' },
    { term: 'Locality(運行地)', desc: '被測裝置在哪:cloud(雲端供給)或 attached(你註冊的本地裝置,仍由雲端大腦遠端驅動)。' },
    { term: '終局狀態', desc: '任務的互斥結束狀態:pass(通過)/ fail(未通過)/ error(環境錯誤)/ cancelled(已取消)/ budget_exceeded(超出預算)/ dead(失聯)。' },
    { term: 'Fail Closed', desc: '查不到某模型單價時,在花任何錢之前直接拒絕執行,絕不以未知成本起跑。' },
    { term: 'S3 Vectors', desc: 'Amazon Bedrock Knowledge Bases 的向量儲存後端,搭配 Titan 文字嵌入做文件檢索。' },
  ],
};

const en: GuideContent = {
  heroTitle: 'Guide',
  heroLead:
    'Four parts: what the system is for, how you use it, the system architecture, and terms, models, costs and detailed how-tos for every page.',
  purposeTitle: 'What it is for',
  purposeBody:
    'An AI-driven automated testing platform for games/apps. Describe a flow in plain words and the AI watches the screen, taps for you, judges pass/fail, and produces multilingual reports with screenshots.',
  flowTitle: 'How it works',
  flowLead:
    'The full flow from uploading an app to getting a report. The core idea: the Agent explores on its own and builds a memory map, which then seeds test scenario templates. Step 6 (knowledge bases) is optional.',
  archTitle: 'System architecture',
  archLead:
    'The actual cloud architecture deployed on AWS us-east-2. Every box is labeled with its AWS service; green = verified end-to-end, dashed orange = scaffolded but not yet verified. Edge colors show the data-flow type (see legend below the diagram). Every execution resource starts with a task and stops when it ends; there are no always-on hosts.',
  flow: [
    { label: '① App', desc: 'Upload the app under test (APK/IPA/XAPK/ZIP/EXE) or a web URL; fill genre, version, identifier.' },
    { label: '② Explore', desc: 'Based on the genre, the Agent plays on its own and visits reachable screens, collecting screens and transitions.' },
    { label: '③ Memory map', desc: 'Visited screens and transitions are merged into a navigation memory map.' },
    { label: '④ Templates', desc: 'Test scenario templates are generated from reachable paths on the map.' },
    { label: '⑤ AI edits', desc: 'Refine a template in plain language; the AI produces an executable YAML case.' },
    { label: '⑥ Knowledge', desc: '(Optional) attach built-in genre knowledge or your own (Markdown / PDF retrieval).' },
    { label: '⑦ Submit', desc: 'Pick runtime, models, and knowledge bases; the task is queued in the cloud.' },
    { label: '⑧ Agent runs', desc: 'Screenshot → VLM locates → Agent decides → act → screenshot again, feeding the memory map.' },
    { label: '⑨ Report', desc: 'A multilingual report with screenshots, step trace, cost, and navigation graph.' },
  ],
  sections: [
    {
      id: 'quickstart',
      title: 'Quick start: your first test',
      intro: 'Follow these five steps the first time; you should see a first report in about 10 minutes.',
      steps: [
        { title: '1. Create an app', body: 'Apps → Create app. Fill name, platform, genre and upload the install file (or a URL for Web).' },
        { title: '2. Test credentials (only if login is needed)', body: 'In the app workspace → Test credentials, add one row per field (account, password…). Skip it for games without login.' },
        { title: '3. Write a test case', body: 'Test cases tab → describe the flow in plain words (e.g. "log in as guest, open a slot machine, spin 10 times") → Draft with AI → review and save.' },
        { title: '4. Submit a task', body: 'Test tasks tab → pick the case and runtime. For a first run keep the default models and set a step limit of 50–100 to avoid surprises.' },
        { title: '5. See the result', body: 'The task page shows the live screen and the AI\'s reasoning; when it ends, open the report for verdicts, screenshots, and spend.' },
      ],
    },
    {
      id: 'runtimes',
      title: 'Choosing a runtime',
      intro: 'When submitting a task you choose where it runs. Every runtime starts with the task and stops when it ends, so you only pay while it runs.',
      steps: [
        { title: 'Web browser', body: 'Headless Chromium (Playwright) in the cloud. For web games and sites; fastest to start and cheapest (about US$0.05/hour).' },
        { title: 'Android real device (Device Farm)', body: 'Physical phones on AWS Device Farm. Closest to real players, with video and audio checks, and games cannot detect an emulator. US$0.17 per device minute; at most 150 minutes per session (AWS limit); boot takes about 3–5 minutes. Pick a model or leave it on Auto.' },
        { title: 'Android real device, long', body: 'For runs longer than 150 minutes. A new session starts every 140 minutes and the game restarts, so the case must be able to get back to the test point by itself.' },
        { title: 'iOS real device (Device Farm)', body: 'Needs an installable .ipa. At most 150 minutes per session; recordings have no audio.' },
        { title: 'Android container (Redroid)', body: 'One ARM cloud host per task running Android in a container (about US$0.17/hour). Runs for 1–72 hours and suits large parallel runs. Limits: games with anti-emulator checks close themselves (use a real device for those); no video or audio checks; no pinch.' },
        { title: 'Windows PC game (GameLift Streams)', body: 'A cloud NVIDIA GPU host; appears only after an admin does a one-time setup. At most 60 minutes per run; at most 1920×1080 total pixels (portrait up to 1080×1920); first start takes about 10–15 minutes.' },
        { title: 'How to decide', body: 'For most mobile games start with the Android container (cheap, long runs). If the game closes immediately, or you need audio/video checks, use a real device. Use Web for browser games.' },
      ],
    },
    {
      id: 'apps',
      title: 'Apps',
      intro: 'The entry point for each game/app under test. Each app is a workspace holding its cases, tasks, reports, memory map, and test credentials.',
      steps: [
        { title: 'Create', body: 'Click Create app; fill name, platform, genre. Android/iOS/Windows need an install file (APK, XAPK, IPA, ZIP or EXE); Web only needs a URL. You can upload an icon.' },
        { title: 'Genre', body: 'Pick a main genre (Slot, MMORPG, RPG, casual…) and secondary genres. Matching built-in knowledge bases are attached automatically, and reports use that genre\'s rules.' },
        { title: 'Identifier', body: 'For Android, the package name (e.g. com.example.game). Used to launch and detect the app on the device and to filter device logs.' },
        { title: 'Versions', body: 'Upload several versions of the same app and choose which one a task tests; the report records the version, so you can compare results across versions.' },
        { title: 'Workspace', body: 'Open the card to switch between the app\'s cases, tasks, reports, memory map, and test credentials.' },
      ],
    },
    {
      id: 'credentials',
      title: 'Test credentials (accounts and passwords)',
      intro: 'For flows that log in, register, or pick a server. Store the values here; the AI fills forms by itself, and the case never contains them.',
      steps: [
        { title: 'Add fields', body: 'App workspace → Test credentials → one row per field, e.g. account, password, server name. Field names can be in any language.' },
        { title: 'Masked (default)', body: 'For secrets. The AI never sees the value, only that the field exists; it types ${account} and the runner swaps in the real value at input time.' },
        { title: 'Visible to AI', body: 'Only for non-sensitive values the AI must pick from a list, such as a server name. Visible values enter the AI\'s context.' },
        { title: 'Security', body: 'Values live only in AWS Secrets Manager. Masked values never appear in the UI, API responses, model prompts, S3, reports, or traces; each tenant\'s app can read only its own. Literal passwords in a case are rejected.' },
      ],
    },
    {
      id: 'cases',
      title: 'Test cases',
      intro: 'A case = one flow for the AI to run, plus the assertions that decide pass or fail.',
      steps: [
        { title: 'Draft with AI', body: 'Describe the flow in plain words and click Draft with AI; Claude Sonnet 4.5 produces a YAML draft (steps + assertions) for you to review and save.' },
        { title: 'Writing a good case', body: 'State the starting point, what to do, and when it is done, e.g. "enter as guest → close all pop-ups → open any slot → spin 10 times". Make counts and amounts explicit so the AI knows when it is finished.' },
        { title: 'Import from a spreadsheet', body: 'Import an existing Excel test list: the system reads the sheet layout and splits it into one case per row; edit rows before importing, or import the sheet as one suite.' },
        { title: 'Versions', body: 'Every edit keeps a case version. Tasks use the current version by default; you can rerun an older one.' },
        { title: 'Secrets boundary', body: 'No literal passwords in cases; use Test credentials for logins. Plain-text secrets are blocked.' },
      ],
    },
    {
      id: 'tasks',
      title: 'Test tasks',
      intro: 'Run a case, then watch and steer it live.',
      steps: [
        { title: 'Submit', body: 'Pick the case, the runtime (see "Choosing a runtime"), and the version to test. Device Farm lets you pick a device model; Android container and Windows let you set the maximum hours; Windows lets you pick a resolution.' },
        { title: 'Models', body: 'Each of the three seats can use a different model. Defaults: decision Nova Lite, screen analysis Kimi K3, helper Nova Micro. Menus show prices and recommendation stars. UI-TARS appears only while an admin has it on.' },
        { title: 'Limits', body: 'Set both a step limit and a budget. The run stops when spend reaches the budget (state budget_exceeded); leaving them empty means no limit.' },
        { title: 'Knowledge bases', body: 'Multi-select (e.g. Slot + RTP). The app\'s default knowledge bases and genre built-ins are added automatically.' },
        { title: 'Live screen', body: 'The timeline above the screen shows each boot stage and its time. Once up, you see the live screen; click it to open a larger window (good for a second monitor).' },
        { title: 'Interact with the game-control Agent', body: 'While it runs, click or drag on the live screen and press "Tap here now" / "Drag like this now": the device does it right away (no AI) and the coordinates are passed to the game-control Agent. You can also type what the Agent should do; it follows on its next step. Tick Remember to save the hint into this app\'s memory for later runs.' },
        { title: 'Logs on the right', body: 'Tabs for device logs (logcat from real devices and the Android container; check here for crash causes), audio, each step\'s input/output for the vision/decision/helper agents, live analysis, and per-model token usage.' },
        { title: 'Cancel and delete', body: 'Cancel a running task (billing stops); delete finished task records.' },
      ],
    },
    {
      id: 'reports',
      title: 'Test reports',
      intro: 'Read-only output after a task ends, organized by the genre\'s report rules.',
      steps: [
        { title: 'Verdicts', body: 'Each assertion is marked pass or fail with evidence screenshots and the AI\'s reasoning. fail usually points to the app or the case; error usually points to the environment or infrastructure.' },
        { title: 'Trace and screenshots', body: 'Step by step: what the AI saw, what it did, and the result. Real-device runs include a full recording with sound; click a step to jump there.' },
        { title: 'Navigation graph', body: 'Screens and transitions from this run, also merged into the memory map.' },
        { title: 'Cost', body: 'Budget, actual spend, and token usage per model.' },
        { title: 'Languages', body: 'Switch the language of the AI narrative.' },
      ],
    },
    {
      id: 'memory',
      title: 'Memory map',
      intro: 'An app-wide picture built across all runs: visited screens become nodes and transitions become edges, so later runs reach the goal faster. Hints testers ticked Remember on during runs are stored here too. You can clear an app\'s memory to start over.',
    },
    {
      id: 'knowledge',
      title: 'Knowledge',
      intro: 'Reusable knowledge bases shared by all signed-in users. Two kinds: game genre (e.g. Slot) and scenario (e.g. RTP). Each can hold:',
      steps: [
        { title: 'Built-in knowledge', body: 'Built-in knowledge for each genre (e.g. Slot, Casino, Battle royale). To customize, clone one and edit it; your copy then replaces the built-in, so it is not injected twice.' },
        { title: 'Markdown', body: 'Edited on the page and injected in full at run time; best for a small set of firm facts, terms, and reading rules.' },
        { title: 'PDF / document retrieval', body: 'Tick "Enable document retrieval" to create a cloud vector knowledge base; upload PDFs, guides, design docs and click Sync. At run time the AI retrieves passages relevant to the goal; best for large reference material.' },
        { title: 'Multi-select per task', body: 'Pick several knowledge bases per task; genre and scenario layers stack. Apps can have default knowledge bases. A knowledge base in use by an app or case cannot be deleted.' },
      ],
    },
    {
      id: 'devices',
      title: 'Devices',
      intro: 'What execution resources exist right now. Containers and hosts are created when a task starts and removed when it ends; nothing to manage by hand.',
      steps: [
        { title: 'Cloud real devices', body: 'Phones available on Device Farm now (model, OS version, resolution, memory, CPU).' },
        { title: 'Containers / hosts / streams', body: 'Running Fargate containers, Android container hosts (EC2), and Windows stream capacity. Useful for spotting a long run someone forgot to cancel.' },
      ],
    },
    {
      id: 'cost',
      title: 'Cost Analysis',
      intro: 'Two numbers side by side on different bases; do not subtract one from the other.',
      steps: [
        { title: 'Task estimates', body: 'Model tokens × price for each task plus Device Farm metered minutes × US$0.17, by day, app, and model. Works immediately.' },
        { title: 'Real AWS bill', body: 'Read from AWS Cost Explorer and includes all infrastructure. The account owner must enable Cost Explorer and cost allocation tags first; data lags about 24 hours and each query costs about US$0.01.' },
      ],
    },
    {
      id: 'members',
      title: 'Members (admins)',
      intro: 'Visible to admins only. Self sign-up is disabled; every account is created here.',
      steps: [
        { title: 'Add a member', body: 'Enter email, initial password, and tenant. The tenant decides which data the person sees; tenants are isolated from each other. You can make them an admin right away.' },
        { title: 'Manage', body: 'Reset passwords, disable/enable, move to another tenant, grant or remove admin, delete. Actions that would lock you out (such as removing your own admin) are blocked.' },
        { title: 'When it takes effect', body: 'A newly promoted admin must log out and back in to see admin pages.' },
      ],
    },
    {
      id: 'system',
      title: 'System admin (admins)',
      intro: 'Platform maintenance: update the whole system from GitHub, and turn the UI-TARS grounding model on or off.',
      steps: [
        { title: 'System update', body: 'Compares the deployed version with the latest on GitHub. Press "Update to…" and type the version to confirm; the cloud runs tests first and only then redeploys the frontend, API, and runtimes (about 5–15 minutes) with live progress and logs. Every update is recorded in the history.' },
        { title: 'Update notes', body: 'This redeploys the whole platform with high privileges; prefer a time with no running tasks. To roll back, type an older commit or tag and update again. The first time, paste a GitHub token (read-only Contents and Metadata only).' },
        { title: 'UI-TARS switch', body: 'UI-TARS is a GUI-grounding model on a GPU that is billed while on (about US$62.5/day, tasks or not), so it is off by default. Press Turn on; after about 8–15 minutes it shows On and appears in the task VLM menu. Press Turn off when done. Only Device Farm real devices use it today.' },
      ],
    },
    {
      id: 'troubleshoot',
      title: 'Troubleshooting',
      intro: 'Check here first when something goes wrong.',
      steps: [
        { title: 'The game closes right away (Android container)', body: 'Usually an anti-emulator check. Open the task\'s device logs to see the last error, and test on an Android real device instead.' },
        { title: 'The screen never changes and the task ends in error', body: 'For a stuck install, a frozen app, or a captcha, the system waits first and ends the run only when the screen has not changed for a long time, so it does not loop on a billed device.' },
        { title: 'The task ends in budget_exceeded', body: 'Spend reached your budget. Raise the budget or lower the steps and rerun.' },
        { title: 'The AI keeps tapping the wrong spot', body: 'Click the right spot on the live screen, press "Tap here now", and tick Remember; or describe the button\'s position and look more precisely in the case. If it is still off, ask an admin to turn on UI-TARS for real-device runs.' },
        { title: 'UI-TARS is not in the menu', body: 'It is turned off; ask an admin to turn it on in System admin.' },
        { title: 'No Members / System admin pages', body: 'They are for admins only; if you were just made an admin, log out and back in.' },
      ],
    },
  ],
  seatsTitle: 'Model roles (three seats)',
  seatsLead:
    'Models are grouped by role (seat), not by vendor. Each seat picks its own model; a price snapshot is locked before running (unknown price → the run is refused, never started at unknown cost).',
  seats: [
    { seat: 'Agent (decision)', role: 'The brain: looks at the screen and the goal and decides the next move (where to tap, what to type, whether it is done). Default Amazon Nova Lite.' },
    { seat: 'VLM (coordinates)', role: 'Vision: reads the screen and turns "the thing to tap" into on-screen coordinates (x, y). Default Moonshot Kimi K3.' },
    { seat: 'Subagent (helper)', role: 'Helper: checks whether each step worked, tracks numbers, and verifies completion (it blocks false "done"), on a cheap model. Default Amazon Nova Micro.' },
  ],
  modelsTitle: 'Available models',
  modelsLead:
    'The table below is the full model list fetched from the backend, so it never goes stale. Only vision-capable models can sit in the VLM seat; text-only models sit in Agent/Subagent. The default set is Nova Lite / Kimi K3 / Nova Micro; UI-TARS (SageMaker GPU) is listed only while an admin has it on in System admin. You never pick an SDK or endpoint; it is derived from the modelId. Non-Anthropic prices come from the AWS Pricing API and are marked "estimated".',
  models: [
    { name: 'Amazon Nova Lite (default decision)', modelId: 'us.amazon.nova-lite-v1:0', seat: 'Agent', price: '$0.066 / $0.264 per M tokens (est.)', note: 'Default decision model; cheap and good enough.' },
    { name: 'Moonshot Kimi K3 (default screen analysis)', modelId: 'us.moonshotai.kimi-k3', seat: 'VLM', price: '$3.63 / $18.15 per M tokens (est.)', note: 'Smallest pixel error in our offline grounding benchmark.' },
    { name: 'Amazon Nova Micro (default helper)', modelId: 'us.amazon.nova-micro-v1:0', seat: 'Subagent', price: '$0.0385 / $0.154 per M tokens (est.)', note: 'Cheapest helper.' },
    { name: 'UI-TARS-1.5-7B (optional)', modelId: 'uitars', seat: 'VLM', price: 'GPU billed while on, about US$62.5/day', note: 'Off by default; admins turn it on in System admin.' },
  ],
  modelsFootnote:
    'Test case drafting and spreadsheet import use Claude Sonnet 4.5. Knowledge-base PDF retrieval uses Amazon Titan Text Embeddings v2 (1024-dim) with Amazon Bedrock Knowledge Bases + S3 Vectors.',
  costTitle: 'Costs and guardrails',
  costBody:
    'With no tasks running, the platform itself costs only about US$2–5 per month (mostly S3 and image storage) because nothing is always on. Spend comes from runs: model tokens (a 26-step, 10-spin slot test on the default models cost under US$0.80), Device Farm at US$0.17 per device minute, and the Android container host at about US$0.17/hour. The one large optional cost is the UI-TARS GPU (about US$62.5/day while on), which is off by default. Each task can have a step limit and a budget; a price snapshot is locked per seat before running (unknown price → refused), the run stops at the budget, and the report shows actual spend and tokens.',
  detailsTitle: 'Terms, models, costs and how-tos',
  featuresTitle: 'Using each page',
  glossaryTitle: 'Terms',
  glossary: [
    { term: 'Seat', desc: 'A model role, not a vendor: Agent (decision), VLM (coordinates), Subagent (helper). Each can use a different model.' },
    { term: 'VLM', desc: 'Vision-Language Model: reads images and text; turns "the thing to tap" into on-screen coordinates.' },
    { term: 'UI-TARS', desc: 'A ByteDance vision model fine-tuned for GUI grounding, on a SageMaker GPU. Optional and off by default; admins switch it in System admin. Only Device Farm real devices use it today.' },
    { term: 'Redroid', desc: 'Android running as a container on a cloud ARM host: the "Android container" runtime.' },
    { term: 'Device Farm', desc: 'AWS service renting physical phones, billed per minute, at most 150 minutes per session.' },
    { term: 'GameLift Streams', desc: 'AWS cloud GPU streaming; used here for Windows PC games. No capacity is reserved and nothing is billed when no test runs.' },
    { term: 'Agent loop', desc: 'Screenshot → VLM locates → Agent decides → act → screenshot again, until done or stopped. Orchestrated by Lambda in the cloud; runners on Fargate, EC2, or GameLift Streams.' },
    { term: 'Coordinate system (pixel / norm1000)', desc: 'The unit a model reports coordinates in. Some return pixels, some use 0–1000; the system converts to real pixels.' },
    { term: 'Knowledge base (Markdown / retrieval)', desc: 'Markdown is injected in full (a few firm facts); PDFs/documents become a vector store searched by the task goal at run time (large material).' },
    { term: 'Tenant', desc: 'The data isolation unit. Each account belongs to one tenant and only sees that tenant\'s apps, cases, tasks, and reports.' },
    { term: 'Locality', desc: 'Where the device under test is: cloud (provided) or attached (your registered local device, still driven by the cloud brain).' },
    { term: 'Terminal state', desc: 'Mutually exclusive end states: pass / fail / error (environment) / cancelled / budget_exceeded / dead (lost contact).' },
    { term: 'Fail Closed', desc: 'If a model price is unknown, the run is refused before spending anything; never start at unknown cost.' },
    { term: 'S3 Vectors', desc: 'Vector store backend for Amazon Bedrock Knowledge Bases, paired with Titan text embeddings for document retrieval.' },
  ],
};

const CONTENT: Record<Locale, GuideContent> = {
  'zh-Hant': zhHant,
  en,
  'zh-Hans': zhHans,
  ja,
  ko,
};

export function guideContent(locale: Locale): GuideContent {
  return CONTENT[locale] ?? en;
}

/** 給 ./guide/ 的翻譯檔當來源(維護時對照用)。 */
export const guideSource = { zhHant, en };
