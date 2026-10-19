/**
 * 知識庫管理頁的介面文字(五語系)。
 *
 * 原本只有繁中 / 英文兩語系(kbLang 是 `locale.startsWith('zh') ? 'zh' : 'en'`),所以
 * 日文 / 韓文介面整頁拿到英文 —— 不是中文,但也不是多國語系。
 *
 * 這裡的 `lang` 刻意保留原本的參數位置與名稱,只是把型別從 RLang 換成 KbLang(五種語系),
 * 讓將近一百個 `kt('x', lang)` 呼叫點一行都不用改。樣板內容(模組/指標/規則名稱)仍由後端
 * 以 { zh, en } 雙語提供,所以本檔的 `tr` 會把 KbLang 收斂回 zh / en 再取值。
 */
import { tr as trBilingual } from '../report/reportText.ts';
import { fill, loc5, pick5, type L5, type Loc5 } from '../../i18n/locale5.ts';
import type { L10n } from './kbTypes.ts';

/** 介面語系(與 I18nProvider 的 locale 一致)。 */
export type KbLang = Loc5;

/** locale → KbLang;認不出來退回英文。 */
export const kbLang = loc5;

/**
 * 後端的 { zh, en } 雙語資料。五語系收斂回兩語:zh-Hant / zh-Hans → zh,其餘 → en。
 * (資料本身只有兩語,日韓拿英文是目前資料能給的最好結果。)
 */
export function tr(v: L10n | undefined, lang: KbLang): string {
  return trBilingual(v, lang.startsWith('zh') ? 'zh' : 'en');
}

const T = {
  title: ['知識庫', 'Knowledge Bases', '知识库', 'ナレッジベース', '지식 베이스'],
  intro: [
    '知識庫同時決定兩件事:AI 測試時要懂的「遊戲知識」,以及報告要算哪些指標、用什麼門檻判定。內建類型樣板唯讀;複製成「我的知識庫」後即可依自己的遊戲客製。',
    'A knowledge base drives both what the AI knows while testing and which metrics, thresholds and rules the report uses. Built-in genre templates are read-only; clone one into “My knowledge bases” to customise it for your game.',
    '知识库同时决定两件事:AI 测试时要懂的「游戏知识」,以及报告要算哪些指标、用什么门槛判定。内建类型样板只读;复制成「我的知识库」后即可按自己的游戏定制。',
    'ナレッジベースは二つを決めます:AI がテスト中に知っておくべき「ゲーム知識」と、レポートで算出する指標・判定に使うしきい値です。組み込みのジャンルテンプレートは読み取り専用で、「マイナレッジベース」に複製すると自分のゲーム向けにカスタマイズできます。',
    '지식 베이스는 두 가지를 결정합니다: AI가 테스트 중 알아야 할 "게임 지식"과, 리포트에서 계산할 지표 및 판정 기준입니다. 내장 장르 템플릿은 읽기 전용이며, "내 지식 베이스"로 복제하면 게임에 맞게 수정할 수 있습니다.',
  ],
  tabTemplates: ['類型樣板(內建)', 'Genre templates (built-in)', '类型样板(内建)', 'ジャンルテンプレート(組み込み)', '장르 템플릿(내장)'],
  tabMine: ['我的知識庫', 'My knowledge bases', '我的知识库', 'マイナレッジベース', '내 지식 베이스'],
  createBlank: ['新增空白知識庫', 'New blank knowledge base', '新增空白知识库', '空のナレッジベースを作成', '빈 지식 베이스 만들기'],
  search: ['搜尋名稱、類型、說明…', 'Search name, genre, description…', '搜索名称、类型、说明…', '名称・ジャンル・説明を検索…', '이름, 장르, 설명 검색…'],
  showArchived: ['顯示已封存', 'Show archived', '显示已归档', 'アーカイブ済みを表示', '보관된 항목 표시'],
  view: ['檢視', 'View', '查看', '表示', '보기'],
  edit: ['編輯', 'Edit', '编辑', '編集', '편집'],
  clone: ['複製並客製化', 'Clone & customise', '复制并定制', '複製してカスタマイズ', '복제 후 수정'],
  duplicate: ['複製', 'Duplicate', '复制', '複製', '복제'],
  archive: ['封存', 'Archive', '归档', 'アーカイブ', '보관'],
  unarchive: ['取消封存', 'Unarchive', '取消归档', 'アーカイブ解除', '보관 해제'],
  delete: ['刪除', 'Delete', '删除', '削除', '삭제'],
  builtin: ['內建', 'Built-in', '内建', '組み込み', '내장'],
  readOnly: ['唯讀', 'Read-only', '只读', '読み取り専用', '읽기 전용'],
  archived: ['已封存', 'Archived', '已归档', 'アーカイブ済み', '보관됨'],
  inUse: ['使用中', 'In use', '使用中', '使用中', '사용 중'],
  basedOn: ['基於', 'Based on', '基于', 'ベース', '기반'],
  revision: ['修訂', 'Revision', '修订', 'リビジョン', '리비전'],
  apps: ['App', 'apps', 'App', 'アプリ', '앱'],
  jobs: ['任務', 'runs', '任务', 'タスク', '작업'],
  modules: ['模組', 'Modules', '模块', 'モジュール', '모듈'],
  mechanics: ['機制', 'Mechanics', '机制', 'メカニクス', '메커닉'],
  observe: ['AI 觀測欄位', 'AI observations', 'AI 观测字段', 'AI 観測項目', 'AI 관측 항목'],
  metrics: ['指標', 'Metrics', '指标', '指標', '지표'],
  charts: ['圖表', 'Charts', '图表', 'グラフ', '차트'],
  riskRules: ['風險規則', 'Risk rules', '风险规则', 'リスクルール', '위험 규칙'],
  releaseRules: ['放行規則', 'Release rules', '放行规则', 'リリースルール', '릴리스 규칙'],
  thresholds: ['門檻', 'Thresholds', '门槛', 'しきい値', '기준값'],
  specValues: ['規格值', 'Spec values', '规格值', '仕様値', '스펙 값'],
  scopes: ['測試範疇', 'Test scope', '测试范畴', 'テスト範囲', '테스트 범위'],
  noTemplatesMatch: ['沒有符合的樣板。', 'No templates match.', '没有符合的样板。', '該当するテンプレートはありません。', '일치하는 템플릿이 없습니다.'],
  noMine: [
    '還沒有自己的知識庫。從左邊的類型樣板「複製並客製化」開始最快。',
    'No knowledge bases yet. The quickest start is “Clone & customise” on a genre template.',
    '还没有自己的知识库。从左边的类型样板「复制并定制」开始最快。',
    'まだマイナレッジベースがありません。ジャンルテンプレートの「複製してカスタマイズ」から始めるのが最短です。',
    '아직 내 지식 베이스가 없습니다. 장르 템플릿의 "복제 후 수정"으로 시작하는 것이 가장 빠릅니다.',
  ],
  cloneName: ['新知識庫名稱', 'Name for the new knowledge base', '新知识库名称', '新しいナレッジベースの名前', '새 지식 베이스 이름'],
  cloneSuffix: ['(我的版本)', ' (my version)', '(我的版本)', '(マイ版)', ' (내 버전)'],
  // 編輯器
  editorCreate: ['新增知識庫', 'New knowledge base', '新增知识库', 'ナレッジベースを作成', '지식 베이스 만들기'],
  editorEdit: ['編輯知識庫', 'Edit knowledge base', '编辑知识库', 'ナレッジベースを編集', '지식 베이스 편집'],
  editorView: ['檢視類型樣板', 'View genre template', '查看类型样板', 'ジャンルテンプレートを表示', '장르 템플릿 보기'],
  secBasic: ['基本資料', 'Basics', '基本资料', '基本情報', '기본 정보'],
  secKnowledge: ['Agent 遊戲知識', 'Agent game knowledge', 'Agent 游戏知识', 'エージェントのゲーム知識', '에이전트 게임 지식'],
  secSpec: ['報告規格', 'Report spec', '报告规格', 'レポート仕様', '리포트 스펙'],
  secDocs: ['文件檢索', 'Document retrieval', '文档检索', 'ドキュメント検索', '문서 검색'],
  name: ['名稱', 'Name', '名称', '名称', '이름'],
  description: ['說明', 'Description', '说明', '説明', '설명'],
  kind: ['類型', 'Kind', '类型', '種別', '종류'],
  kindCategory: ['遊戲類型(綁定類型樣板)', 'Game genre (uses genre template)', '游戏类型(绑定类型样板)', 'ゲームジャンル(ジャンルテンプレートを使用)', '게임 장르(장르 템플릿 사용)'],
  kindScenario: ['情境(如 RTP、登入、付費)', 'Scenario (e.g. RTP, login, payments)', '情境(如 RTP、登录、付费)', 'シナリオ(RTP・ログイン・課金など)', '시나리오(RTP, 로그인, 결제 등)'],
  genre: ['對應遊戲類型', 'Genre', '对应游戏类型', '対応ジャンル', '해당 장르'],
  genreHint: [
    '綁定類型後,使用這座知識庫的測試會自動套用該類型樣板的模組、AI 觀測欄位、指標與規則,你在下方的設定是「覆寫 / 新增 / 停用」。',
    'With a genre, runs using this knowledge base apply that genre template’s modules, observations, metrics and rules; settings below override, add to, or disable them.',
    '绑定类型后,使用这座知识库的测试会自动套用该类型样板的模块、AI 观测字段、指标与规则,你在下方的设置是「覆写 / 新增 / 停用」。',
    'ジャンルを指定すると、このナレッジベースを使うテストにそのジャンルテンプレートのモジュール・AI 観測項目・指標・ルールが自動適用されます。以下の設定は上書き / 追加 / 無効化です。',
    '장르를 지정하면 이 지식 베이스를 사용하는 테스트에 해당 장르 템플릿의 모듈, AI 관측 항목, 지표, 규칙이 자동 적용됩니다. 아래 설정은 덮어쓰기 / 추가 / 비활성화입니다.',
  ],
  markdownHint: [
    'AI 每步都會讀到的遊戲知識(畫面、流程、術語、注意事項)。',
    'Game knowledge the AI reads on every step (screens, flows, terms, caveats).',
    'AI 每步都会读到的游戏知识(画面、流程、术语、注意事项)。',
    'AI が各ステップで読み込むゲーム知識(画面・フロー・用語・注意点)。',
    'AI가 매 단계마다 읽는 게임 지식(화면, 흐름, 용어, 주의사항).',
  ],
  readOnlyHint: [
    '內建樣板為唯讀。按「複製並客製化」建立自己的版本後即可修改。',
    'Built-in templates are read-only. Use “Clone & customise” to create an editable copy.',
    '内建样板为只读。按「复制并定制」建立自己的版本后即可修改。',
    '組み込みテンプレートは読み取り専用です。「複製してカスタマイズ」で編集可能なコピーを作成してください。',
    '내장 템플릿은 읽기 전용입니다. "복제 후 수정"으로 편집 가능한 사본을 만드세요.',
  ],
  cancel: ['取消', 'Cancel', '取消', 'キャンセル', '취소'],
  close: ['關閉', 'Close', '关闭', '閉じる', '닫기'],
  save: ['儲存', 'Save', '保存', '保存', '저장'],
  saving: ['儲存中…', 'Saving…', '保存中…', '保存中…', '저장 중…'],
  create: ['建立', 'Create', '建立', '作成', '만들기'],
  // 規格編輯器
  specIntro: [
    '數字一律由程式計算;這裡設定的是「判定依據」。留空 = 用樣板預設。',
    'All numbers are computed by code; these are the judging criteria. Leave blank to use the template default.',
    '数字一律由程序计算;这里设置的是「判定依据」。留空 = 用样板默认值。',
    '数値はすべてプログラムが算出します。ここで設定するのは「判定基準」です。空欄 = テンプレートの既定値。',
    '수치는 모두 프로그램이 계산합니다. 여기서 설정하는 것은 "판정 기준"입니다. 비워두면 템플릿 기본값을 사용합니다.',
  ],
  specValuesHint: [
    '遊戲的設計規格。AI 不會自行假設,未填的項目就不會做對應檢查。',
    'Your game’s design spec. The AI never assumes these; unset items are simply not checked.',
    '游戏的设计规格。AI 不会自行假设,未填的项目就不会做对应检查。',
    'ゲームの設計仕様です。AI は推測しません。未入力の項目はチェックされません。',
    '게임의 설계 스펙입니다. AI는 추측하지 않으며, 입력하지 않은 항목은 검사하지 않습니다.',
  ],
  thresholdsHint: [
    '放行/風險規則用的門檻。',
    'Thresholds used by release and risk rules.',
    '放行/风险规则用的门槛。',
    'リリース / リスクルールで使うしきい値。',
    '릴리스 / 위험 규칙에 사용하는 기준값.',
  ],
  defaultLabel: ['預設', 'Default', '默认', '既定値', '기본값'],
  yourValue: ['你的設定', 'Your value', '你的设置', 'あなたの設定', '내 설정'],
  inherited: [
    '繼承自樣板的項目(取消勾選 = 停用)',
    'Inherited from template (uncheck to disable)',
    '继承自样板的项目(取消勾选 = 停用)',
    'テンプレートから継承した項目(チェックを外すと無効)',
    '템플릿에서 상속한 항목(체크 해제 시 비활성화)',
  ],
  inheritedGlobal: ['通用規則(所有類型)', 'Global rules (all genres)', '通用规则(所有类型)', '共通ルール(全ジャンル)', '공통 규칙(모든 장르)'],
  inheritedGenre: ['類型樣板', 'Genre template', '类型样板', 'ジャンルテンプレート', '장르 템플릿'],
  customObserve: ['自訂 AI 觀測欄位', 'Custom AI observations', '自定义 AI 观测字段', 'カスタム AI 観測項目', '사용자 지정 AI 관측 항목'],
  customObserveHint: [
    '要 AI 每步從畫面讀的值(看不到就不填,不會猜)。報告會自動產生走勢圖與指標。',
    'Values the AI reads from each screen (left blank if not visible; never guessed). The report adds charts and metrics automatically.',
    '要 AI 每步从画面读的值(看不到就不填,不会猜)。报告会自动生成走势图与指标。',
    'AI が各画面から読み取る値(見えなければ空欄のまま、推測はしません)。レポートに推移グラフと指標が自動で追加されます。',
    'AI가 각 화면에서 읽는 값(보이지 않으면 비워 두며 추측하지 않습니다). 리포트에 추이 그래프와 지표가 자동으로 추가됩니다.',
  ],
  customModules: ['自訂測試模組', 'Custom test modules', '自定义测试模块', 'カスタムテストモジュール', '사용자 지정 테스트 모듈'],
  customModulesHint: [
    '報告的功能覆蓋與模組結果會包含這些模組;keywords 用來從畫面名推斷。',
    'Included in feature coverage and module results; keywords help infer the module from screen names.',
    '报告的功能覆盖与模块结果会包含这些模块;keywords 用来从画面名推断。',
    'レポートの機能カバレッジとモジュール結果に含まれます。keywords は画面名からモジュールを推定するために使います。',
    '리포트의 기능 커버리지와 모듈 결과에 포함됩니다. keywords는 화면 이름으로 모듈을 추정하는 데 사용됩니다.',
  ],
  extraScopes: ['額外納入的測試範疇', 'Additional test scopes', '额外纳入的测试范畴', '追加するテスト範囲', '추가 테스트 범위'],
  add: ['新增', 'Add', '新增', '追加', '추가'],
  remove: ['移除', 'Remove', '移除', '削除', '제거'],
  key: ['識別碼(英文)', 'Key (letters/digits)', '标识码(英文)', '識別子(半角英数)', '식별자(영문/숫자)'],
  zhLabel: ['中文名稱', 'Chinese label', '中文名称', '中国語名', '중국어 이름'],
  enLabel: ['英文名稱', 'English label', '英文名称', '英語名', '영어 이름'],
  hint: ['給 AI 的說明', 'Hint for the AI', '给 AI 的说明', 'AI への説明', 'AI를 위한 설명'],
  type: ['型別', 'Type', '类型', '型', '유형'],
  keywords: ['關鍵字(逗號分隔)', 'Keywords (comma-separated)', '关键字(逗号分隔)', 'キーワード(カンマ区切り)', '키워드(콤마 구분)'],
  core: ['核心', 'Core', '核心', 'コア', '핵심'],
  disabledCount: ['已停用 {n} 項', '{n} disabled', '已停用 {n} 项', '{n} 件を無効化', '{n}개 비활성화'],
  noGenreForSpec: [
    '尚未綁定遊戲類型:只會套用通用規則。選擇「遊戲類型」可帶入該類型的樣板。',
    'No genre selected: only global rules apply. Pick a genre to inherit its template.',
    '尚未绑定游戏类型:只会套用通用规则。选择「游戏类型」可带入该类型的样板。',
    'ジャンル未指定:共通ルールのみ適用されます。「ゲームジャンル」を選ぶとそのテンプレートを継承します。',
    '장르 미지정: 공통 규칙만 적용됩니다. "게임 장르"를 선택하면 해당 템플릿을 상속합니다.',
  ],
  // 刪除防呆
  deleteConfirm: [
    '確定刪除「{name}」?此動作無法復原。',
    'Delete “{name}”? This cannot be undone.',
    '确定删除「{name}」?此动作无法恢复。',
    '「{name}」を削除しますか?元に戻せません。',
    '"{name}"을(를) 삭제하시겠습니까? 되돌릴 수 없습니다.',
  ],
  inUseTitle: [
    '這座知識庫仍在使用中,不能刪除',
    'This knowledge base is still in use and cannot be deleted',
    '这座知识库仍在使用中,不能删除',
    'このナレッジベースは使用中のため削除できません',
    '이 지식 베이스는 사용 중이므로 삭제할 수 없습니다',
  ],
  inUseBody: [
    '刪除會讓下列 App 的預設設定與既有測試任務失去知識來源。你可以先改掉 App 的預設知識庫、刪除不需要的任務,或直接「封存」:封存後不會再出現在選單,但既有設定與報告保持不變。',
    'Deleting would break the defaults of the apps below and the knowledge source of existing runs. Change the apps’ defaults, delete runs you no longer need, or simply archive it: archived knowledge bases disappear from pickers but existing settings and reports stay intact.',
    '删除会让下列 App 的默认设置与既有测试任务失去知识来源。你可以先改掉 App 的默认知识库、删除不需要的任务,或直接「归档」:归档后不会再出现在选单,但既有设置与报告保持不变。',
    '削除すると、以下のアプリの既定設定と既存タスクのナレッジ参照先が失われます。アプリの既定ナレッジベースを変更する、不要なタスクを削除する、あるいは「アーカイブ」してください。アーカイブすると選択リストには出なくなりますが、既存の設定とレポートはそのまま残ります。',
    '삭제하면 아래 앱의 기본 설정과 기존 작업의 지식 출처가 사라집니다. 앱의 기본 지식 베이스를 변경하거나 불필요한 작업을 삭제하거나, 그냥 "보관"하세요. 보관하면 선택 목록에서는 사라지지만 기존 설정과 리포트는 그대로 유지됩니다.',
  ],
  usedByApps: ['App 預設使用', 'Default for apps', 'App 默认使用', 'アプリの既定', '앱 기본값'],
  usedByJobs: ['測試任務引用', 'Referenced by runs', '测试任务引用', 'タスクから参照', '작업에서 참조'],
  otherTenants: [
    '其他團隊:App {a} 個、任務 {j} 筆',
    'Other teams: {a} apps, {j} runs',
    '其他团队:App {a} 个、任务 {j} 条',
    '他のチーム:アプリ {a} 件、タスク {j} 件',
    '다른 팀: 앱 {a}개, 작업 {j}건',
  ],
  archiveInstead: ['改為封存', 'Archive instead', '改为归档', '代わりにアーカイブ', '대신 보관'],
  checking: ['檢查使用情況…', 'Checking usage…', '检查使用情况…', '使用状況を確認中…', '사용 현황 확인 중…'],
  archiveConfirm: [
    '封存「{name}」?封存後不會出現在選單中,但既有 App 設定、測試與報告不受影響。',
    'Archive “{name}”? It will be hidden from pickers; existing app settings, runs and reports are unaffected.',
    '归档「{name}」?归档后不会出现在选单中,但既有 App 设置、测试与报告不受影响。',
    '「{name}」をアーカイブしますか?選択リストから隠れますが、既存のアプリ設定・テスト・レポートには影響しません。',
    '"{name}"을(를) 보관하시겠습니까? 선택 목록에서 숨겨지지만 기존 앱 설정, 테스트, 리포트에는 영향이 없습니다.',
  ],
  viewTask: ['開啟', 'Open', '打开', '開く', '열기'],
} as const satisfies Record<string, L5>;

export type KbTextKey = keyof typeof T;

export function kt(key: KbTextKey, lang: KbLang, vars?: Record<string, string | number>): string {
  return fill(pick5(T[key] as L5, lang), vars);
}
