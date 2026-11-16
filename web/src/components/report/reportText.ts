/**
 * 結構化報告的固定文字(五語 L5:繁中 / English / 简体 / 日本語 / 한국어)。
 * 報告內容本身(指標名、缺陷、摘要)由後端以 { zh, en } 雙語產出,tr() 把 zh-Hant / zh-Hans 對到 zh,
 * 日文 / 韓文對到 en;固定標題與欄位則依介面語系取對應的五語值。
 */
import { loc5, pick5, type L5, type Loc5 } from '../../i18n/locale5.ts';
import type { InsightsMap, InsightsSuffix, L10n, ReportInsights } from './reportTypes.ts';
import { ZH_HANS_REPORT } from './zhHansReport.ts';
export type RLang = Loc5;
export function reportLang(locale: string): RLang {
  return loc5(locale);
}
/** 固定文字挑選:L5 = [繁中, English, 简体, 日本語, 한국어]。 */
export function pr(v: L5, lang: RLang): string {
  return pick5(v, lang);
}
/** 後端雙語資料只有 zh / en:zh-Hant 與 zh-Hans 讀 zh,其餘(en / ja / ko)讀 en。 */
export function dataLang(lang: RLang): 'zh' | 'en' {
  return lang === 'zh-Hant' || lang === 'zh-Hans' ? 'zh' : 'en';
}
/** AI 洞察的快取後綴(與後端 cacheSuffix 一致):zh-Hant -> zh,其餘用語系碼。 */
export function insightsSuffix(lang: RLang): InsightsSuffix {
  return lang === 'zh-Hant' ? 'zh' : lang;
}
/** 顯示用的洞察:先取當前語系精確的那份,沒有再退回 dataLang 對應的(舊的 zh / en)。 */
export function pickInsights(map: InsightsMap | undefined, lang: RLang): ReportInsights | undefined {
  if (!map) return undefined;
  const dl = dataLang(lang);
  return map[insightsSuffix(lang)] ?? map[dl] ?? map[dl === 'zh' ? 'en' : 'zh'];
}
const HANS_STATIC = new Map<string, string>();
const HANS_TEMPLATES: Array<{ re: RegExp; to: string; weight: number }> = [];
for (const [k, v] of ZH_HANS_REPORT) {
  if (!k.includes('{0}')) { HANS_STATIC.set(k, v); continue; }
  const parts = k.split(/\{\d+\}/);
  const re = new RegExp('^' + parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('([\\s\\S]*?)') + '$');
  HANS_TEMPLATES.push({ re, to: v, weight: parts.join('').length });
}
HANS_TEMPLATES.sort((a, b) => b.weight - a.weight);
const HANS_CACHE = new Map<string, string>();
/**
 * zh-Hans text for backend report text that only exists as zh-Hant. Looks the sentence up in ZH_HANS_REPORT (exact rows,
 * then rows with interpolated parts, whose captured parts are converted the same way). Text with no row is returned as is.
 */
export function hansText(zh: string): string {
  const hit = HANS_CACHE.get(zh);
  if (hit !== undefined) return hit;
  let out = HANS_STATIC.get(zh);
  if (out === undefined) {
    for (const t of HANS_TEMPLATES) {
      const m = t.re.exec(zh);
      if (m) { out = t.to.replace(/\{(\d+)\}/g, (_, i: string) => hansText(m[Number(i) + 1] ?? '')); break; }
    }
  }
  // Text composed from other report text: pieces joined with ; 、 or sentence ends, or an id prefix ("AC-G05 " + title). A row
  // whose holes swallowed several pieces can come back unchanged, so the split is tried then too. A delimiter stays attached to
  // a piece (before it for ; and 、, after it for sentence ends); a piece with no row of its own is retried without its delimiter.
  if (out === undefined || out === zh) {
    const D = [0x3b, 0xff1b, 0x3001, 0x2c, 0xff0c, 0x3002].map((c) => String.fromCharCode(c));
    const SPLITS: RegExp[] = [...D.slice(0, 5).map((d) => new RegExp(`(?=${d})`)), new RegExp(`(?<=${D[5]})`)];
    const piece = (p: string): string => {
      const r = hansText(p);
      if (r !== p || p.length < 2) return r;
      if (D.includes(p[0] ?? '')) return p[0] + hansText(p.slice(1));
      if (D.includes(p[p.length - 1] ?? '')) return hansText(p.slice(0, -1)) + p[p.length - 1];
      return p;
    };
    let split: string | undefined;
    for (const re of SPLITS) {
      const parts = zh.split(re);
      if (parts.length < 2) continue;
      const conv = parts.map(piece);
      if (conv.some((c, i) => c !== parts[i])) { split = conv.join(''); break; }
    }
    if (split !== undefined) out = split;
    else if (out === undefined) {
      const lead = /^([A-Za-z0-9_.-]+ )([\s\S]+)$/.exec(zh);
      if (lead) {
        const rest = hansText(lead[2] ?? '');
        if (rest !== lead[2]) out = `${lead[1] ?? ''}${rest}`;
      }
    }
  }
  const res = out ?? zh;
  HANS_CACHE.set(zh, res);
  return res;
}
/** 後端 { zh, en } 資料或前端 L5 固定值 → 當前語系的文字。 */
export function tr(v: L10n | L5 | undefined, lang: RLang): string {
  if (!v) return '';
  if (Array.isArray(v)) return pick5(v as L5, lang);
  const d = v as L10n;
  if (lang === 'zh-Hans') return d.zh ? hansText(d.zh) : d.en || '';
  return d[dataLang(lang)] || d.en || d.zh;
}

export const T = {
  toc: ['目錄', 'Contents', '目录', '目次', '목차'],
  cover: ['報告封面', 'Cover', '报告封面', 'レポート表紙', '보고서 표지'],
  executive: ['執行摘要', 'Executive Summary', '运行摘要', 'エグゼクティブサマリー', '요약'],
  environment: ['測試環境', 'Test Environment', '测试环境', 'テスト環境', '테스트 환경'],
  scope: ['測試範疇', 'Test Scope', '测试范畴', 'テスト範囲', '테스트 범위'],
  dashboard: ['品質儀表板', 'Quality Dashboard', '品质仪表板', '品質ダッシュボード', '품질 대시보드'],
  coverage: ['測試覆蓋', 'Test Coverage', '测试覆盖', 'テストカバレッジ', '테스트 커버리지'],
  results: ['測試結果', 'Test Results', '测试结果', 'テスト結果', '테스트 결과'],
  modules: ['功能 / 模組結果', 'Feature / Module Results', '功能 / 模块结果', '機能 / モジュール結果', '기능 / 모듈 결과'],
  genre: ['類型專屬分析', 'Genre-specific Analysis', '类型专属分析', 'ジャンル別分析', '장르별 분석'],
  mechanics: ['遊戲機制', 'Gameplay Mechanics', '游戏机制', 'ゲームメカニクス', '게임 메커닉'],
  performance: ['效能', 'Performance', '性能', 'パフォーマンス', '성능'],
  stability: ['穩定性', 'Stability', '稳定性', '安定性', '안정성'],
  visual: ['視覺品質', 'Visual Quality', '视觉品质', 'ビジュアル品質', '시각 품질'],
  ux: ['UX / 可玩性', 'UX / Playability', 'UX / 可玩性', 'UX / プレイアビリティ', 'UX / 플레이 편의성'],
  progression: ['進度', 'Progression', '进度', '進行', '진행'],
  economy: ['經濟', 'Economy', '经济', 'エコノミー', '경제'],
  aiReliability: ['AI 可靠度', 'AI Reliability', 'AI 可靠度', 'AI 信頼性', 'AI 신뢰도'],
  defects: ['缺陷摘要', 'Defect Summary', '缺陷摘要', '不具合サマリー', '결함 요약'],
  criticalDefects: ['重大缺陷', 'Critical Defects', '重大缺陷', '重大な不具合', '중대한 결함'],
  testCase: ['測試案例明細', 'Test Case Details', '测试用例明细', 'テストケース詳細', '테스트 케이스 상세'],
  evidence: ['AI 執行證據', 'AI Execution Evidence', 'AI 运行证据', 'AI 実行証跡', 'AI 실행 증거'],
  risk: ['風險評估', 'Risk Assessment', '风险评估', 'リスク評価', '위험 평가'],
  release: ['發布準備度', 'Release Readiness', '发布准备度', 'リリース準備度', '릴리스 준비도'],
  appendix: ['附錄', 'Appendix', '附录', '付録', '부록'],
  // 報告助手:這份報告有 29 節、權重相同,讀者不容易知道先看哪裡。
  // 助手不產生新結論,只把報告裡已經有的三件事提到最前面:結論憑什麼、
  // 不涵蓋什麼、平台做不到什麼。
  // 用語與報告本文一致:名詞短語、不用第二人稱、不用修辭句。
  // 「可自動執行 / 部分(有缺口)/ 結構性做不到」沿用 T07 可執行範圍表的同一組詞 ——
  // 一個概念只用一個詞,legend 自創簡稱會讓讀者以為是兩件事。
  asstOpen: ['報告導讀', 'Report guide', '报告导读', 'レポートガイド', '보고서 안내'],
  asstClose: ['收合', 'Collapse', '收合', '折りたたむ', '접기'],
  asstTabGuide: ['導讀', 'Overview', '导读', 'ガイド', '안내'],
  asstTabAsk: ['問答', 'Q&A', '问答', 'Q&A', '질문·답변'],
  asstTabReview: ['判定覆核', 'Review', '判定覆核', '判定レビュー', '판정 검토'],
  // 覆核:標為誤判或調整嚴重性。用語避開「回報誤判」這種指控式說法,
  // 因為使用者也可能是「確認這是缺陷」。
  asstReviewIntro: ['待判讀的缺陷由系統標出,但未能確認是否為實際缺陷。確認或駁回後,驗收判定會依調整後的值重算,原判定保留於缺陷明細。', 'Findings awaiting triage were flagged by the system but not confirmed as actual defects. Once confirmed or dismissed, the acceptance verdict is recomputed from the adjusted values and the original judgement is kept in the defect detail.', '待判读的缺陷由系统标出,但未能确认是否为实际缺陷。确认或驳回后,验收判定会依调整后的值重算,原判定保留于缺陷明细。', '判定待ちの不具合はシステムが検出したもので、実際の不具合かどうかは未確認です。確認または却下すると、受け入れ判定は調整後の値で再計算され、元の判定は不具合の詳細に残ります。', '판독 대기 중인 결함은 시스템이 표시했지만 실제 결함인지 확인되지 않은 것입니다. 확인하거나 기각하면 합격 판정이 조정된 값으로 다시 계산되며, 원래 판정은 결함 상세에 남습니다.'],
  asstReviewNone: ['目前沒有待判讀的缺陷', 'No findings awaiting triage', '目前没有待判读的缺陷', '判定待ちの不具合はありません', '판독 대기 중인 결함이 없습니다'],
  asstConfirm: ['確認為缺陷', 'Confirm as defect', '确认为缺陷', '不具合として確認', '결함으로 확인'],
  asstDismiss: ['標為誤判', 'Dismiss as misjudgement', '标为误判', '誤判定として却下', '오판으로 처리'],
  asstReasonLabel: ['理由(必填)', 'Reason (required)', '理由(必填)', '理由(必須)', '사유(필수)'],
  asstReasonHint: ['報告會原文顯示這段理由,並記錄覆核者與時間。', 'The report shows this reason verbatim and records the reviewer and time.', '报告会原文显示这段理由,并记录覆核者与时间。', 'この理由はレポートにそのまま表示され、レビュー担当者と日時が記録されます。', '이 사유는 보고서에 그대로 표시되고 검토자와 시간이 기록됩니다.'],
  asstRemember: ['記住,讓下次測試先知道', 'Remember this for future runs', '记住,让下次测试先知道', '記憶して次回以降のテストに反映', '기억해 두어 다음 테스트에 반영'],
  asstRememberHint: ['會寫進這個應用的記憶,影響之後每一次測試(不只這一次)。可在記憶地圖停用,來源標為「判定覆核」。', 'This is written to the app\u2019s memory and affects every future run, not just this one. It can be disabled in the memory map, where its source is marked as a verdict review.', '会写进这个应用的记忆,影响之后每一次测试(不只这一次)。可在记忆地图停用,来源标为「判定覆核」。', 'このアプリのメモリに書き込まれ、今回だけでなく以降のすべてのテストに影響します。メモリマップで無効にでき、出典は「判定レビュー」と表示されます。', '이 앱의 기억에 기록되어 이번 한 번만이 아니라 이후 모든 테스트에 영향을 줍니다. 기억 지도에서 비활성화할 수 있으며 출처는 \'판정 검토\'로 표시됩니다.'],
  asstSubmit: ['送出', 'Submit', '送出', '送信', '제출'],
  asstSubmitting: ['送出中…', 'Submitting…', '送出中…', '送信中…', '제출하는 중…'],
  asstOverridden: ['已覆核', 'Reviewed', '已覆核', 'レビュー済み', '검토됨'],
  asstOverrideFailed: ['送出失敗:', 'Failed: ', '送出失败:', '送信に失敗しました:', '제출하지 못했습니다:'],
  asstReasonRequired: ['請填寫理由', 'A reason is required', '请填写理由', '理由を入力してください', '사유를 입력하세요'],
  // 缺陷卡片上的覆寫痕跡
  ovrTitle: ['人工覆核', 'Manual review', '人工覆核', '手動レビュー', '수동 검토'],
  ovrOriginal: ['原判定', 'Original judgement', '原判定', '元の判定', '원래 판정'],
  ovrDismissed: ['已標為誤判(不計入已確認缺陷)', 'Dismissed as a misjudgement (not counted as a confirmed defect)', '已标为误判(不计入已确认缺陷)', '誤判定として却下済み(確認済み不具合に含めない)', '오판으로 처리됨(확인된 결함에 포함하지 않음)'],
  ovrReason: ['理由', 'Reason', '理由', '理由', '사유'],
  ovrBy: ['覆核者', 'Reviewed by', '覆核者', 'レビュー担当', '검토자'],
  ovrNote: ['含人工覆寫:{total} 筆(標為誤判 {dismissed}、改判 {reclassified})', 'Includes {total} manual override(s) ({dismissed} dismissed, {reclassified} reclassified)', '含人工覆写:{total} 笔(标为误判 {dismissed}、改判 {reclassified})', '手動上書きあり:{total} 件(誤判定として却下 {dismissed}、判定変更 {reclassified})', '수동 덮어쓰기 포함: {total}건(오판 처리 {dismissed}, 판정 변경 {reclassified})'],
  asstPending: ['待人工確認', 'Pending manual review', '待人工确认', '手動確認待ち', '수동 확인 대기'],
  asstVerdictWhy: ['判定結果 {status} — 依據', 'Verdict {status} — basis', '判定结果 {status} — 依据', '判定結果 {status} — 根拠', '판정 결과 {status} — 근거'],
  asstEvidencePath: ['檢視判定明細(各項依據與截圖)', 'View verdict detail (basis and screenshot per row)', '查看判定明细(各项依据与截图)', '判定の詳細を表示(各項目の根拠とスクリーンショット)', '판정 상세 보기(항목별 근거와 스크린샷)'],
  asstNotCovered: ['本結論未涵蓋範圍({n} 項)', 'Outside the scope of this verdict ({n})', '本结论未涵盖范围({n} 项)', 'この結論の対象外({n} 件)', '이 결론에서 다루지 않는 범위({n}건)'],
  asstNotCoveredFrom: ['詳見「適用邊界」章節', 'See the claim scope section', '详见「适用边界」章节', '「適用範囲」の章を参照', '\'적용 경계\' 장을 참조'],
  asstNoClaimScope: ['本報告未提供適用邊界資料(由舊版後端產生)', 'This report provides no claim-scope data (produced by an earlier backend)', '本报告未提供适用边界数据(由旧版后端产生)', 'このレポートには適用範囲のデータがありません(旧バージョンのバックエンドで生成)', '이 보고서에는 적용 경계 데이터가 없습니다(이전 버전 백엔드에서 생성)'],
  asstCapability: ['平台可執行範圍({total} 類測項分類)', 'Platform execution coverage ({total} test-item categories)', '平台可运行范围({total} 类测项分类)', 'プラットフォームの実行範囲(テスト項目 {total} 分類)', '플랫폼 실행 범위(테스트 항목 {total}개 분류)'],
  asstCapAuto: ['可自動執行', 'Automated', '可自动运行', '自動実行可能', '자동 실행 가능'],
  asstCapPartial: ['部分(有缺口)', 'Partial, with gaps', '部分(有缺口)', '一部(ギャップあり)', '부분(공백 있음)'],
  asstCapNone: ['結構性做不到', 'Structurally out of reach', '结构性做不到', '構造的に不可能', '구조적으로 불가능'],
  asstTriage: ['{n} 項缺陷待判讀:系統未能確認是否為實際缺陷', '{n} finding(s) awaiting triage: not confirmed as actual defects', '{n} 项缺陷待判读:系统未能确认是否为实际缺陷', '不具合 {n} 件が判定待ち:実際の不具合かどうか未確認', '결함 {n}건이 판독 대기 중: 실제 결함인지 확인되지 않음'],
  asstTriageGo: ['檢視明細', 'View detail', '查看明细', '詳細を表示', '상세 보기'],
  asstUnclear: ['{n} 項判定無法認定,記為未通過而非通過', '{n} check(s) could not be determined and are recorded as not passed rather than passed', '{n} 项判定无法认定,记为未通过而非通过', '{n} 件の判定が確定できず、合格ではなく不合格として記録されています', '{n}개 판정을 확정할 수 없어 통과가 아닌 미통과로 기록되었습니다'],
  asstAllClear: ['無待確認項目', 'No items pending review', '无待确认项目', '確認待ちの項目はありません', '확인 대기 항목 없음'],
  // 欄位
  reportId: ['報告編號', 'Report ID', '报告编号', 'レポート番号', '보고서 번호'],
  gameName: ['遊戲名稱', 'Game Name', '游戏名称', 'ゲーム名', '게임 이름'],
  gameVersion: ['遊戲版本', 'Game Version', '游戏版本', 'ゲームバージョン', '게임 버전'],
  build: ['Build', 'Build Number', 'Build', 'ビルド', '빌드 번호'],
  genreLabel: ['遊戲類型', 'Game Genre', '游戏类型', 'ゲームジャンル', '게임 장르'],
  secondaryGenre: ['次要類型', 'Secondary Genre', '次要类型', 'サブジャンル', '보조 장르'],
  platform: ['平台', 'Platform', '平台', 'プラットフォーム', '플랫폼'],
  os: ['作業系統', 'Operating System', '操作系统', 'OS', '운영 체제'],
  device: ['裝置', 'Device', '设备', 'デバイス', '기기'],
  resolution: ['解析度', 'Resolution', '分辨率', '解像度', '해상도'],
  testEnv: ['測試環境', 'Test Environment', '测试环境', 'テスト環境', '테스트 환경'],
  region: ['伺服器區域', 'Server Region', '服务器区域', 'サーバーリージョン', '서버 리전'],
  start: ['開始時間', 'Test Start Time', '开始时间', '開始時刻', '테스트 시작 시각'],
  end: ['結束時間', 'Test End Time', '结束时间', '終了時刻', '테스트 종료 시각'],
  duration: ['測試時長', 'Test Duration', '测试时长', 'テスト所要時間', '테스트 소요 시간'],
  aiModel: ['AI / VLM 模型', 'AI / VLM Model', 'AI / VLM 模型', 'AI / VLM モデル', 'AI / VLM 모델'],
  agentModel: ['Agent 模型', 'Agent Model', 'Agent 模型', 'エージェントモデル', '에이전트 모델'],
  engine: ['測試引擎版本', 'Test Engine Version', '测试引擎版本', 'テストエンジンのバージョン', '테스트 엔진 버전'],
  kbVersion: ['知識庫版本', 'Knowledge Base Version', '知识库版本', 'ナレッジベースのバージョン', '지식 베이스 버전'],
  planVersion: ['測試規格版本(Profile)', 'Test Plan Version (Profile)', '测试规格版本(Profile)', 'テスト仕様バージョン(プロファイル)', '테스트 사양 버전(프로파일)'],
  overall: ['整體測試狀態', 'Overall Test Status', '整体测试状态', 'テスト全体のステータス', '전체 테스트 상태'],
  readiness: ['發布建議', 'Release Readiness', '发布建议', 'リリース判定', '릴리스 권고'],
  totalChecks: ['檢查總數', 'Total Checks', '检查总数', 'チェック総数', '전체 검사 수'],
  executed: ['已執行', 'Executed', '已运行', '実行済み', '실행됨'],
  passed: ['通過', 'Passed', '通过', '合格', '통과'],
  failed: ['失敗', 'Failed', '失败', '不合格', '실패'],
  blocked: ['受阻', 'Blocked', '受阻', 'ブロック', '차단됨'],
  skipped: ['略過', 'Skipped', '略过', 'スキップ', '건너뜀'],
  passRate: ['通過率', 'Pass Rate', '通过率', '合格率', '통과율'],
  executionRate: ['執行率', 'Execution Rate', '运行率', '実行率', '실행률'],
  notCollected: ['未收集', 'Not collected', '未收集', '未収集', '수집 안 됨'],
  notExecuted: ['未執行', 'Not executed', '未运行', '未実行', '실행 안 됨'],
  notApplicable: ['不適用', 'N/A', '不适用', '対象外', '해당 없음'],
  selected: ['已選定', 'Selected', '已选定', '選択済み', '선택됨'],
  aiEval: ['AI 評估', 'AI Evaluation', 'AI 评估', 'AI 評価', 'AI 평가'],
  objective: ['客觀指標', 'Objective', '客观指标', '客観指標', '객관 지표'],
  scoreFormula: ['分數 = 100 − 該維度遊戲缺陷扣分(Critical 40 / High 20 / Medium 10 / Low 5);未執行的維度不給分。', 'Score = 100 − penalties for game defects in that dimension (Critical 40 / High 20 / Medium 10 / Low 5); dimensions not executed are not scored.', '分数 = 100 − 该维度游戏缺陷扣分(Critical 40 / High 20 / Medium 10 / Low 5);未运行的维度不给分。', 'スコア = 100 − そのディメンションのゲーム不具合による減点(Critical 40 / High 20 / Medium 10 / Low 5)。未実行のディメンションは採点されません。', '점수 = 100 − 해당 차원의 게임 결함 감점(Critical 40 / High 20 / Medium 10 / Low 5). 실행되지 않은 차원은 점수를 매기지 않습니다.'],
  featureCov: ['功能覆蓋', 'Feature Coverage', '功能覆盖', '機能カバレッジ', '기능 커버리지'],
  scenarioCov: ['情境覆蓋', 'Scenario Coverage', '情境覆盖', 'シナリオカバレッジ', '시나리오 커버리지'],
  stateCov: ['遊戲狀態覆蓋', 'Game State Coverage', '游戏状态覆盖', 'ゲーム状態カバレッジ', '게임 상태 커버리지'],
  deviceCov: ['裝置覆蓋', 'Device Coverage', '设备覆盖', 'デバイスカバレッジ', '기기 커버리지'],
  mechanicCov: ['機制覆蓋', 'Mechanic Coverage', '机制覆盖', 'メカニクスカバレッジ', '메커닉 커버리지'],
  inferred: ['由畫面名推斷', 'inferred from screen', '由画面名推断', '画面名から推定', '화면 이름에서 추정'],
  aiTagged: ['AI 標註', 'AI-tagged', 'AI 标注', 'AI タグ付け', 'AI 태그'],
  module: ['模組', 'Module', '模块', 'モジュール', '모듈'],
  checks: ['檢查數', 'Checks', '检查数', 'チェック数', '검사 수'],
  critical: ['Critical', 'Critical', 'Critical', 'Critical', 'Critical'],
  high: ['High', 'High', 'High', 'High', 'High'],
  avgDuration: ['平均耗時', 'Avg Duration', '平均耗时', '平均所要時間', '평균 소요 시간'],
  steps: ['步數', 'Steps', '步数', 'ステップ数', '단계 수'],
  tested: ['已測', 'Tested', '已测', 'テスト済み', '테스트됨'],
  noFindings: ['無', 'None', '无', 'なし', '없음'],
  gameDefects: ['遊戲缺陷', 'Game Defects', '游戏缺陷', 'ゲーム不具合', '게임 결함'],
  aiFailures: ['AI 測試失敗(不計入遊戲缺陷)', 'AI Testing Failures (not game defects)', 'AI 测试失败(不计入游戏缺陷)', 'AI テストの失敗(ゲーム不具合には含めない)', 'AI 테스트 실패(게임 결함에 포함하지 않음)'],
  severity: ['嚴重度', 'Severity', '严重度', '重大度', '심각도'],
  category: ['類別', 'Category', '类别', '分類', '분류'],
  classification: ['歸因', 'Attribution', '归因', '帰属', '귀속'],
  certainty: ['判定方式', 'Basis', '判定方式', '判定方法', '판정 방식'],
  frequency: ['次數', 'Frequency', '次数', '回数', '횟수'],
  reproducibility: ['重現性', 'Reproducibility', '重现性', '再現性', '재현성'],
  firstLast: ['首次 / 末次步驟', 'First / Last Step', '首次 / 末次步骤', '最初 / 最後のステップ', '처음 / 마지막 단계'],
  expected: ['預期結果', 'Expected', '预期结果', '期待結果', '기대 결과'],
  actual: ['實際結果', 'Actual', '实际结果', '実際の結果', '실제 결과'],
  stepsToRepro: ['重現步驟', 'Steps to Reproduce', '重现步骤', '再現手順', '재현 단계'],
  suspected: ['疑似原因', 'Suspected Cause', '疑似原因', '推定原因', '추정 원인'],
  confidence: ['AI 信心', 'AI Confidence', 'AI 信心', 'AI の確信度', 'AI 신뢰도'],
  gameState: ['遊戲狀態', 'Game State', '游戏状态', 'ゲーム状態', '게임 상태'],
  precondition: ['前置條件', 'Precondition', '前置条件', '前提条件', '사전 조건'],
  input: ['輸入', 'Input', '输入', '入力', '입력'],
  testSteps: ['測試步驟 / 目標', 'Test Steps / Goal', '测试步骤 / 目标', 'テストステップ / 目標', '테스트 단계 / 목표'],
  result: ['結果', 'Result', '结果', '結果', '결과'],
  aiGenerated: ['AI 產生預期', 'AI-generated expectations', 'AI 产生预期', 'AI が生成した期待結果', 'AI가 생성한 기대 결과'],
  retry: ['重試次數', 'Retry Count', '重试次数', 'リトライ回数', '재시도 횟수'],
  recovery: ['恢復次數', 'Recovery Count', '恢复次数', '復旧回数', '복구 횟수'],
  caseId: ['案例 ID', 'Test Case ID', '用例 ID', 'ケース ID', '케이스 ID'],
  caseName: ['案例名稱', 'Test Case Name', '用例名称', 'ケース名', '케이스 이름'],
  priority: ['優先級', 'Priority', '优先级', '優先度', '우선순위'],
  observed: ['觀察畫面', 'Observed', '观察画面', '観察された画面', '관찰된 화면'],
  reason: ['推理', 'Reason', '推理', '推論', '추론'],
  action: ['動作', 'Action', '动作', 'アクション', '동작'],
  assertion: ['判定', 'Assertion', '判定', '判定', '판정'],
  latency: ['延遲', 'Latency', '延迟', 'レイテンシ', '지연 시간'],
  before: ['動作前', 'Before', '动作前', '操作前', '동작 전'],
  showAll: ['顯示全部', 'Show all', '显示全部', 'すべて表示', '모두 보기'],
  showLess: ['收合', 'Show less', '收合', '折りたたむ', '접기'],
  override: ['Runner 介入', 'Runner override', 'Runner 介入', 'Runner の介入', 'Runner 개입'],
  excludedValue: ['數值疑似讀錯(不計入)', 'Likely misread (excluded)', '数值疑似读错(不计入)', '数値の読み取りミスの疑い(集計対象外)', '수치 오독 의심(집계 제외)'],
  dataQuality: ['數據品質', 'Data quality', '数据品质', 'データ品質', '데이터 품질'],
  dqExcluded: ['已排除的讀錯數值(不計入 RTP 與經濟指標)', 'Excluded misread values (not used for RTP or economy metrics)', '已排除的读错数值(不计入 RTP 与经济指标)', '除外された読み取りミスの数値(RTP と経済指標には使用しません)', '제외된 오독 수치(RTP 및 경제 지표에 사용하지 않음)'],
  dqBetChanges: ['投注額變更', 'Bet changes', '投注额变更', 'ベット額の変更', '베팅액 변경'],
  dqStep: ['步驟', 'Step', '步骤', 'ステップ', '단계'],
  dqField: ['欄位', 'Field', '字段', 'フィールド', '필드'],
  dqRaw: ['讀到的值', 'Value read', '读到的值', '読み取った値', '읽은 값'],
  dqReason: ['判斷依據', 'Reason', '判断依据', '判断根拠', '판단 근거'],
  dqChange: ['變更', 'Change', '变更', '変更', '변경'],
  segment: ['連線段', 'Session', '连接段', '接続区間', '연결 구간'],
  riskEvidence: ['證據', 'Evidence', '证据', '証跡', '증거'],
  impact: ['影響', 'Impact', '影响', '影響', '영향'],
  affected: ['影響範圍', 'Affected', '影响范围', '影響範囲', '영향 범위'],
  related: ['相關缺陷 / 步驟', 'Related Defects / Steps', '相关缺陷 / 步骤', '関連する不具合 / ステップ', '관련 결함 / 단계'],
  noRisks: ['規則未觸發任何風險。', 'No risk rules triggered.', '规则未触发任何风险。', 'リスクルールは発動していません。', '발동된 위험 규칙이 없습니다.'],
  rulesHit: ['觸發的放行規則', 'Triggered Release Rules', '触发的放行规则', '発動したリリースルール', '발동된 릴리스 규칙'],
  noRulesHit: ['沒有放行規則被觸發。', 'No release rules triggered.', '没有放行规则被触发。', '発動したリリースルールはありません。', '발동된 릴리스 규칙이 없습니다.'],
  thresholds: ['門檻設定(可由知識庫 playagent-report 區塊覆寫)', 'Thresholds (override via knowledge base playagent-report block)', '门槛设置(可由知识库 playagent-report 区块覆写)', 'しきい値設定(ナレッジベースの playagent-report ブロックで上書き可能)', '임계값 설정(지식 베이스의 playagent-report 블록으로 덮어쓰기 가능)'],
  readinessNote: ['發布建議由規則引擎依 Critical 缺陷、核心玩法阻斷、Crash、覆蓋率等規則判定,不是 AI 自由判斷,也不是只看通過率。', 'Readiness is decided by the rules engine (critical defects, core gameplay blocks, crashes, coverage…), not by AI judgment or pass rate alone.', '发布建议由规则引擎依 Critical 缺陷、内核玩法阻断、Crash、覆盖率等规则判定,不是 AI 自由判断,也不是只看通过率。', 'リリース判定はルールエンジンが Critical 不具合、コアプレイの阻害、クラッシュ、カバレッジなどのルールで判定します。AI の自由な判断でも、合格率だけの判断でもありません。', '릴리스 권고는 규칙 엔진이 Critical 결함, 핵심 플레이 차단, 크래시, 커버리지 등의 규칙으로 판정하며, AI의 자유로운 판단도 통과율만 보는 것도 아닙니다.'],
  profiles: ['套用的類型 Profile', 'Applied Genre Profiles', '套用的类型 Profile', '適用したジャンルプロファイル', '적용된 장르 프로파일'],
  specValues: ['知識庫規格值', 'Knowledge Base Spec Values', '知识库规格值', 'ナレッジベースの仕様値', '지식 베이스 사양 값'],
  notes: ['資料限制說明', 'Data Limitations', '数据限制说明', 'データの制約について', '데이터 제한 사항'],
  visualHint: ['以下為 AI 從截圖觀察到的視覺問題(AI 評估,需人工確認)。', 'Visual issues observed by AI from screenshots (AI evaluation; confirm manually).', '以下为 AI 从截图观察到的视觉问题(AI 评估,需人工确认)。', '以下は AI がスクリーンショットから観察した視覚上の問題です(AI 評価、人による確認が必要)。', '다음은 AI가 스크린샷에서 관찰한 시각적 문제입니다(AI 평가, 사람의 확인 필요).'],
  uxHint: ['UX 指標多為 AI 評估,與確定性缺陷分開呈現。', 'UX metrics are mostly AI evaluations and are kept separate from deterministic defects.', 'UX 指标多为 AI 评估,与确定性缺陷分开呈现。', 'UX 指標の多くは AI 評価であり、確定的な不具合とは分けて表示します。', 'UX 지표는 대부분 AI 평가이며 확정적인 결함과 분리하여 표시합니다.'],
  noData: ['本次沒有可呈現的資料。', 'No data for this run.', '本次没有可呈现的数据。', '今回表示できるデータはありません。', '이번에 표시할 데이터가 없습니다.'],
  dimension: ['維度', 'Dimension', '维度', 'ディメンション', '차원'],
  score: ['分數', 'Score', '分数', 'スコア', '점수'],
  // 判定明細 / AI 洞察 / 版面
  verdicts: ['判定明細', 'Verdict Matrix', '判定明细', '判定マトリクス', '판정 매트릭스'],
  verdictsHint: ['每一列都是一次通過/失敗判定:里程碑由程式依整體證據判定;逐步判定是 AI 在動作前宣告預期、下一步看到新畫面後判定是否達成。點擊列可展開動作前後截圖、判定依據與修正建議。', 'Each row is one pass/fail verdict. Milestones are decided by rules over the whole evidence; step checks are AI-declared expectations judged on the next screenshot. Click a row for before/after screenshots, reasoning and fix suggestions.', '每一列都是一次通过/失败判定:里程碑由程序依整体证据判定;逐步判定是 AI 在动作前声明预期、下一步看到新画面后判定是否达成。点击列可展开动作前后截图、判定依据与修正建议。', '各行が合否判定の 1 件です。マイルストーンは全体の証跡にもとづきルールで判定し、ステップごとの判定は AI が操作前に期待結果を宣言し、次の画面を見て達成したかを判定します。行をクリックすると、操作前後のスクリーンショット、判定根拠、修正提案が開きます。', '각 행은 통과/실패 판정 하나입니다. 마일스톤은 전체 증거를 바탕으로 규칙으로 판정하고, 단계별 판정은 AI가 동작 전에 기대 결과를 선언한 뒤 다음 화면을 보고 달성 여부를 판정합니다. 행을 클릭하면 동작 전후 스크린샷, 판정 근거, 수정 제안이 펼쳐집니다.'],
  requirements: ['需求驗證矩陣', 'Requirement Traceability', '需求验证矩阵', '要件検証マトリクス', '요구사항 검증 매트릭스'],
  requirementsHint: ['依測試案例的步驟與預期逐條對應證據(AI 歸納,數字以程式計算為準)。', 'Each test-case step/expectation mapped to evidence (AI summary; all numbers come from the rules engine).', '依测试用例的步骤与预期逐条对应证据(AI 归纳,数字以程序计算为准)。', 'テストケースのステップと期待結果を1件ずつ証跡に対応付けています(AI による要約。数値はルールエンジンの計算が正です)。', '테스트 케이스의 단계와 기대 결과를 항목별로 증거에 대응시켰습니다(AI 요약, 숫자는 규칙 엔진의 계산이 기준).'],
  insights: ['AI 分析與修正建議', 'AI Analysis & Recommendations', 'AI 分析与修正建议', 'AI 分析と修正提案', 'AI 분석 및 수정 제안'],
  generateInsights: ['產生 AI 分析', 'Generate AI analysis', '产生 AI 分析', 'AI 分析を生成', 'AI 분석 생성'],
  regenerate: ['重新產生', 'Regenerate', '重新产生', '再生成', '다시 생성'],
  generating: ['AI 分析中(約 20 秒)…', 'Analyzing (about 20s)…', 'AI 分析中(约 20 秒)…', 'AI が分析中(約 20 秒)…', 'AI 분석 중(약 20초)…'],
  insightsFailed: ['AI 分析失敗,請稍後再試。', 'AI analysis failed. Please try again.', 'AI 分析失败,请稍后再试。', 'AI 分析に失敗しました。しばらくしてからもう一度お試しください。', 'AI 분석에 실패했습니다. 잠시 후 다시 시도해 주세요.'],
  insightsEmpty: ['尚未產生 AI 分析。AI 會依已計算的證據歸納需求驗證結果、根因與修正建議,不會更改任何數字。', 'No AI analysis yet. The AI summarizes requirement verdicts, root cause and fixes from the computed evidence without changing any numbers.', '尚未产生 AI 分析。AI 会依已计算的证据归纳需求验证结果、根因与修正建议,不会更改任何数字。', 'AI 分析はまだ生成されていません。AI は計算済みの証跡をもとに、要件の検証結果、根本原因、修正提案をまとめます。数値は一切変更しません。', '아직 AI 분석이 생성되지 않았습니다. AI는 계산된 증거를 바탕으로 요구사항 검증 결과, 근본 원인, 수정 제안을 정리하며 어떤 숫자도 바꾸지 않습니다.'],
  rootCause: ['根因分析', 'Root Cause', '根因分析', '根本原因分析', '근본 원인 분석'],
  watchouts: ['需要注意的點', 'Points to Watch', '需要注意的点', '注意すべき点', '주의할 점'],
  watchoutsHint: [
    '依本次遊戲類型的報告樣板,逐條點出算出來的數字裡值得注意的地方(現象描述;怎麼修見修正建議)。',
    'Notable observations in the computed metrics, judged against this genre’s report template (observations only; fixes are in Recommendations).', '依本次游戏类型的报告样板,逐条点出算出来的数字里值得注意的地方(现象描述;怎么修见修正建议)。', '今回のゲームジャンルのレポートテンプレートに照らして、計算された数値のうち注意すべき点を 1 件ずつ挙げます(現象の記述のみ。対処は修正提案を参照)。', '이번 게임 장르의 보고서 템플릿에 비추어 계산된 수치 중 주목할 점을 항목별로 짚습니다(현상 서술만 하며, 해결 방법은 수정 제안 참조).',
  ],
  recommendations: ['修正建議(依優先級)', 'Recommendations (by priority)', '修正建议(依优先级)', '修正提案(優先度順)', '수정 제안(우선순위순)'],
  owner: ['負責', 'Owner', '负责', '担当', '담당'],
  ownerDev: ['遊戲開發', 'Game dev', '游戏开发', 'ゲーム開発', '게임 개발'],
  ownerQa: ['測試設定', 'QA setup', '测试设置', 'テスト設定', '테스트 설정'],
  ownerEnv: ['測試環境', 'Environment', '测试环境', 'テスト環境', '테스트 환경'],
  generatedBy: ['產生模型', 'Generated by', '产生模型', '生成モデル', '생성 모델'],
  all: ['全部', 'All', '全部', 'すべて', '전체'],
  unclear: ['不確定', 'Unclear', '不确定', '不明', '불확실'],
  milestone: ['里程碑', 'Milestone', '里程碑', 'マイルストーン', '마일스톤'],
  stepCheck: ['逐步判定', 'Step check', '逐步判定', 'ステップ判定', '단계 판정'],
  checkItem: ['檢查項目', 'Check', '检查项目', 'チェック項目', '검사 항목'],
  screen: ['畫面', 'Screen', '画面', '画面', '화면'],
  basisCol: ['判定依據', 'Rationale', '判定依据', '判定根拠', '판정 근거'],
  evidenceCol: ['證據', 'Evidence', '证据', '証跡', '증거'],
  suggestion: ['修正建議', 'Fix Suggestion', '修正建议', '修正提案', '수정 제안'],
  aiNote: ['AI 補充建議', 'AI suggestion', 'AI 补充建议', 'AI の補足提案', 'AI 추가 제안'],
  after: ['動作後', 'After', '动作后', '操作後', '동작 후'],
  screenChanged: ['畫面變化', 'Screen changed', '画面变化', '画面の変化', '화면 변화'],
  yes: ['是', 'Yes', '是', 'はい', '예'],
  no: ['否', 'No', '否', 'いいえ', '아니요'],
  relatedFinding: ['相關缺陷', 'Related finding', '相关缺陷', '関連する不具合', '관련 결함'],
  noChecks: ['沒有符合條件的判定。', 'No verdicts match this filter.', '没有符合条件的判定。', '条件に一致する判定はありません。', '조건에 맞는 판정이 없습니다.'],
  viewDetails: ['查看細節', 'View details', '查看细节', '詳細を見る', '세부 정보 보기'],
  hideDetails: ['收合細節', 'Hide details', '收合细节', '詳細を閉じる', '세부 정보 접기'],
  defectDetails: ['缺陷明細', 'Defect Details', '缺陷明细', '不具合の詳細', '결함 상세'],
  print: ['列印 / 匯出 PDF', 'Print / Export PDF', '打印 / 导出 PDF', '印刷 / PDF として出力', '인쇄 / PDF 내보내기'],
  keyFacts: ['測試概況', 'At a glance', '测试概况', 'テスト概要', '테스트 개요'],
  stepsRun: ['執行步數', 'Steps run', '运行步数', '実行ステップ数', '실행 단계 수'],
  clickToFilter: ['點擊查看明細', 'Click to view details', '点击查看明细', 'クリックして詳細を表示', '클릭하여 상세 보기'],
  groupBy: ['歸類', 'Group by', '归类', 'グループ化', '그룹화'],
  groupNone: ['不分組', 'None', '不分组', 'グループなし', '그룹 안 함'],
  groupCategory: ['依功能模組', 'By module', '依功能模块', '機能モジュール別', '기능 모듈별'],
  groupResult: ['依判定結果', 'By result', '依判定结果', '判定結果別', '판정 결과별'],
  uncategorized: ['未歸類', 'Uncategorized', '未归类', '未分類', '미분류'],
  overallMilestones: ['整體里程碑', 'Overall milestones', '整体里程碑', '全体のマイルストーン', '전체 마일스톤'],
  filteredBy: ['篩選中', 'Filtered by', '筛选中', '絞り込み中', '필터 적용 중'],
  clearFilter: ['清除', 'Clear', '清除', 'クリア', '지우기'],
  notTested: ['未測', 'Not tested', '未测', '未テスト', '테스트 안 됨'],
  caseVersion: ['案例版本', 'Test Case Version', '用例版本', 'ケースのバージョン', '케이스 버전'],
  caseVersionLegacy: ['(版本功能上線前執行,未記錄)', '(run before versioning; not recorded)', '(版本功能上线前运行,未记录)', '(バージョン機能の導入前に実行、記録なし)', '(버전 기능 도입 전에 실행되어 기록 없음)'],
  // 驗收標準
  acceptance: ['驗收結論與標準', 'Acceptance Verdict & Criteria', '验收结论与标准', '受け入れ結論と基準', '합격 결론 및 기준'],
  boardCapture: ['逐局盤面證據', 'Per-spin Board Evidence', '逐局盘面证据', 'スピンごとの盤面証跡', '스핀별 보드 증거'],
  acStandard: ['驗收標準', 'Acceptance standard', '验收标准', '受け入れ基準', '합격 기준'],
  acDecidedBy: ['決定結論的項目', 'Decided by', '决定结论的项目', '結論を決めた項目', '결론을 결정한 항목'],
  acId: ['編號', 'ID', '编号', '番号', '번호'],
  acItem: ['驗收項目', 'Criterion', '验收项目', '受け入れ項目', '합격 항목'],
  acLevel: ['等級', 'Level', '等级', 'レベル', '등급'],
  acMust: ['必要', 'MUST', '必要', '必須', '필수'],
  acShould: ['建議', 'SHOULD', '建议', '推奨', '권장'],
  acRequirement: ['要求', 'Requirement', '要求', '要件', '요구사항'],
  acThreshold: ['門檻', 'Threshold', '门槛', 'しきい値', '임계값'],
  acActual: ['實際', 'Actual', '实际', '実測値', '실제 값'],
  acResult: ['結果', 'Result', '结果', '結果', '결과'],
  acAttribution: ['歸因', 'Attribution', '归因', '帰属', '귀속'],
  acBasis: ['判定依據', 'Basis', '判定依据', '判定根拠', '판정 근거'],
  acEvidence: ['證據步驟', 'Evidence', '证据步骤', '証跡ステップ', '증거 단계'],
  acSource: ['要求來源', 'Source', '要求来源', '要件の出典', '요구 출처'],
  acCaseQuote: ['案例原文', 'Case text', '用例原文', 'ケース原文', '케이스 원문'],
  acRules: ['結論判定規則', 'Verdict rules', '结论判定规则', '結論判定ルール', '결론 판정 규칙'],
  acRefs: ['參考標準', 'References', '参考标准', '参照基準', '참조 기준'],
  acNotEvaluable: ['無法判定', 'Not evaluable', '无法判定', '判定不能', '판정 불가'],
  acNotApplicable: ['不適用', 'N/A', '不适用', '対象外', '해당 없음'],
  acDeterministic: ['程式判定', 'Deterministic', '程序判定', 'プログラム判定', '프로그램 판정'],
  acAiEvaluation: ['AI 判讀', 'AI evaluation', 'AI 判读', 'AI 判読', 'AI 판독'],
  attrGame: ['遊戲', 'Game', '游戏', 'ゲーム', '게임'],
  attrExecution: ['測試執行', 'Test execution', '测试运行', 'テスト実行', '테스트 실행'],
  attrEnvironment: ['環境', 'Environment', '环境', '環境', '환경'],
  attrAi: ['AI 代理', 'AI agent', 'AI 代理', 'AI エージェント', 'AI 에이전트'],
  attrData: ['數據', 'Data', '数据', 'データ', '데이터'],
  rtpLedger: ['RTP 帳務(可溯源)', 'RTP ledger (traceable)', 'RTP 账务(可溯源)', 'RTP 台帳(追跡可能)', 'RTP 원장(추적 가능)'],
  rtpWindows: ['量測區間', 'Measurement windows', '量测区间', '計測区間', '측정 구간'],
  rtpWindow: ['區間', 'Window', '区间', '区間', '구간'],
  rtpBet: ['投注額', 'Bet', '投注额', 'ベット額', '베팅액'],
  rtpCounter: ['AutoSpin 計數', 'AutoSpin counter', 'AutoSpin 计数', 'オートスピン回数', '오토스핀 카운터'],
  rtpSpins: ['付費局數', 'Paid spins', '付费局数', '有料スピン数', '유료 스핀 수'],
  rtpWagered: ['投注', 'Wagered', '投注', 'ベット', '베팅'],
  rtpBalance: ['餘額', 'Balance', '余额', '残高', '잔액'],
  rtpDelta: ['餘額變化', 'Balance change', '余额变化', '残高の変化', '잔액 변화'],
  rtpCredits: ['非拉霸收入', 'Non-slot credits', '非拉霸收入', 'スロット以外の収入', '슬롯 외 수입'],
  rtpAmount: ['金額', 'Amount', '金额', '金額', '금액'],
  rtpCreditBasis: ['金額依據', 'Amount basis', '金额依据', '金額の根拠', '금액 근거'],
  rtpInWindow: ['在量測區間內', 'In window', '在量测区间内', '計測区間内', '측정 구간 내'],
  rtpTotal: ['合計', 'Total', '合计', '合計', '합계'],
  rtpNet: ['淨 RTP', 'Net RTP', '净 RTP', '純 RTP', '순 RTP'],
  rtpGross: ['未扣非拉霸收入', 'Before non-slot credits', '未扣非拉霸收入', 'スロット以外の収入を差し引く前', '슬롯 외 수입 차감 전'],
  rtpNotComputable: ['不可算', 'Not computable', '不可算', '算出不可', '산출 불가'],
  rtpFormula: ['公式', 'Formula', '公式', '計算式', '공식'],
  rtpStats: ['統計精度', 'Statistical precision', '统计精度', '統計精度', '통계 정밀도'],
  rtpSigma: ['單局標準差 σ', 'Per-spin σ', '单局标准差 σ', '1 スピンあたりの標準偏差 σ', '스핀당 표준편차 σ'],
  rtpSigmaAssumed: ['未提供,採中波動參考值', 'not provided; medium-volatility reference', '未提供,采中波动参考值', '未提供のため中ボラティリティの参考値を使用', '제공되지 않아 중간 변동성 참고값 사용'],
  rtpSigmaSpec: ['知識庫規格', 'from spec', '知识库规格', 'ナレッジベースの仕様', '지식 베이스 사양'],
  rtpCi: ['95% 信賴區間', '95% CI', '95% 信赖区间', '95% 信頼区間', '95% 신뢰구간'],
  rtpFor1pp: ['±1 個百分點所需局數', 'Spins for ±1 pp', '±1 个百分点所需局数', '±1 ポイントに必要なスピン数', '±1%p에 필요한 스핀 수'],
  rtpNoCredits: ['沒有偵測到非拉霸收入事件', 'No non-slot credit events detected', '没有侦测到非拉霸收入事件', 'スロット以外の収入イベントは検出されませんでした', '슬롯 외 수입 이벤트가 감지되지 않았습니다'],
  basisObs: ['畫面讀值', 'Read from screen', '画面读值', '画面の読み取り値', '화면에서 읽은 값'],
  basisBalanceDiff: ['餘額差(期間無旋轉)', 'Balance difference (no spins)', '余额差(期间无旋转)', '残高の差(期間中スピンなし)', '잔액 차이(기간 중 스핀 없음)'],
  basisAiRead: ['AI 說明中的金額', 'Amount stated by AI', 'AI 说明中的金额', 'AI の説明に記載された金額', 'AI 설명에 적힌 금액'],
  basisNoneSeen: ['沒有入帳描述(視為 0)', 'No credit wording (treated as 0)', '没有入账描述(视为 0)', '入金の記述なし(0 として扱う)', '입금 서술 없음(0으로 처리)'],
  basisUnresolved: ['無法確認', 'Unconfirmed', '无法确认', '確認できません', '확인 불가'],
  // 交付文件規範
  qaDocs: ['交付文件', 'Deliverable Documents', '交付文档', '納品ドキュメント', '납품 문서'],
  qaDocStandard: ['文件規範', 'Document standard', '文档规范', 'ドキュメント規格', '문서 규격'],
  qaDocInternal: ['內部判定標準', 'Internal verdict standard', '内部判定标准', '内部判定基準', '내부 판정 기준'],
  qaDocCoverage: ['覆蓋狀態', 'Coverage', '覆盖状态', 'カバー状況', '커버 상태'],
  qaDocDerived: ['可由本次執行產生', 'Derived from this run', '可由本次运行产生', '今回の実行から生成可能', '이번 실행에서 생성 가능'],
  qaDocGaps: ['部分欄位需人工補填', 'Some fields need manual entry', '部分字段需人工补填', '一部の項目は手動入力が必要', '일부 항목은 수동 입력 필요'],
  qaDocNotDerivable: ['不由執行證據產生', 'Not derived from execution evidence', '不由运行证据产生', '実行証跡からは生成されません', '실행 증거로는 생성되지 않음'],
  qaDocUnfilled: ['需人工補填', 'Needs manual entry', '需人工补填', '手動入力が必要', '수동 입력 필요'],
  qaDocLinks: ['關聯與補充紀錄', 'Links and supplementary records', '关联与补充纪录', '関連・補足記録', '연관 및 보충 기록'],
  qaDocReason: ['原因', 'Reason', '原因', '理由', '사유'],
  qaDocStats: ['原有統計指標', 'Original statistics', '原有统计指标', '既存の統計指標', '기존 통계 지표'],
  qaDocFormula: ['來源公式', 'Formula', '来源公式', '元の計算式', '원 공식'],
  qaDocNumerator: ['分子', 'Numerator', '分子', '分子', '분자'],
  qaDocDenominator: ['分母', 'Denominator', '分母', '分母', '분모'],
  qaDocValue: ['值', 'Value', '值', '値', '값'],
  qaDocInclusion: ['納入範圍', 'Inclusion', '纳入范围', '対象範囲', '포함 범위'],
  qaDocBoundary: ['定義界線', 'Boundary', '定义界线', '定義の境界', '정의 경계'],
  qaDocNotComputed: ['不計算', 'Not computed', '不计算', '計算しない', '계산하지 않음'],
  qaDocLegendResult: ['結果狀態', 'Result states', '结果状态', '結果ステータス', '결과 상태'],
  qaDocLegendGrade: ['缺陷分級', 'Defect grades', '缺陷分级', '不具合のグレード', '결함 등급'],
  qaDocLegendDiscovery: ['發現分級', 'Discovery grades', '发现分级', '検出グレード', '발견 등급'],
  qaDocEmpty: ['本報告沒有交付文件投影(舊版報告)', 'This report carries no deliverable-document projection (legacy report)', '本报告没有交付文档投影(旧版报告)', 'このレポートには納品ドキュメントの投影がありません(旧バージョンのレポート)', '이 보고서에는 납품 문서 투영이 없습니다(이전 버전 보고서)'],
  qaGroupPlanning: ['送測與規劃', 'Submission and planning', '送测与规划', 'テスト依頼と計画', '테스트 의뢰 및 계획'],
  qaGroupExecution: ['執行與結果', 'Execution and results', '运行与结果', '実行と結果', '실행 및 결과'],
  qaGroupDefects: ['問題與複驗', 'Defects and retest', '问题与复验', '不具合と再検証', '결함 및 재검증'],
  qaGroupClosure: ['結案與交付', 'Closure and delivery', '结案与交付', '完了と納品', '종결 및 납품'],
  qaGroupSpecialty: ['健檢與專項', 'Health checks and specialty', '健检与专项', 'ヘルスチェックと専門テスト', '헬스 체크 및 전문 테스트'],
  qaGroupResearch: ['研究與支援', 'Research and support', '研究与支持', '調査とサポート', '조사 및 지원'],
  qaGroupTraining: ['教育與支援', 'Training and support', '教育与支持', '教育とサポート', '교육 및 지원'],
  // 交付文件匯出
  qaDocExport: ['匯出交付文件(Excel)', 'Export deliverables (Excel)', '导出交付文档(Excel)', '納品ドキュメントを出力(Excel)', '납품 문서 내보내기(Excel)'],
  qaDocExporting: ['匯出中…', 'Exporting…', '导出中…', '出力中…', '내보내는 중…'],
  qaDocExportFailed: ['匯出失敗,請重試', 'Export failed, please retry', '导出失败,请重试', '出力に失敗しました。もう一度お試しください', '내보내기에 실패했습니다. 다시 시도해 주세요'],
  qaDocExportHint: ['一份文件一張工作表;不可產生的文件在覆蓋表逐類列出原因。', 'One worksheet per document; documents that cannot be derived are listed with their reason on the coverage sheet.', '一份文档一张工作表;不可产生的文档在覆盖表逐类列出原因。', 'ドキュメントごとに 1 シート。生成できないドキュメントは、カバレッジシートに理由が分類ごとに記載されます。', '문서 하나당 시트 하나입니다. 생성할 수 없는 문서는 커버리지 시트에 사유가 분류별로 나열됩니다.'],
  qaDocOverview: ['總覽', 'Overview', '总览', '概要', '개요'],
  qaDocCoverageSheet: ['文件覆蓋', 'Document coverage', '文档覆盖', 'ドキュメントのカバー状況', '문서 커버리지'],
  qaDocLegendSheet: ['分級對照', 'Legends', '分级对照', 'グレード凡例', '등급 범례'],
  qaDocGeneratedAt: ['產生時間', 'Generated at', '产生时间', '生成日時', '생성 시각'],
  qaDocTitle: ['文件名稱', 'Document', '文档名称', 'ドキュメント名', '문서 이름'],
  qaDocGroupCol: ['群組', 'Group', '群组', 'グループ', '그룹'],
  // 主張紀律:未測理由、門檻來源、適用邊界(yes / no 沿用判定明細既有的鍵)
  scopeCol: ['測試範疇', 'Scope', '测试范畴', 'テスト範囲', '테스트 범위'],
  scopeReasons: ['未執行的理由', 'Why a scope was not executed', '未运行的理由', '未実行の理由', '실행되지 않은 이유'],
  scopeReasonsNote: ['「平台可偵測 = 否」代表目前沒有這類偵測器,任何一次執行都不會有證據;那是工具缺口,不是這次沒走到。', '"Platform can detect = No" means there is no detector for this today, so no run will ever produce evidence. That is a tooling gap, not something this run merely missed.', '「平台可侦测 = 否」代表目前没有这类侦测器,任何一次运行都不会有证据;那是工具缺口,不是这次没走到。', '「プラットフォームで検出可能 = いいえ」は、現在この種の検出器がなく、どの実行でも証跡が得られないことを意味します。今回たまたま到達しなかったのではなく、ツール側の不足です。', '\'플랫폼 감지 가능 = 아니요\'는 현재 이런 감지기가 없어 어떤 실행에서도 증거가 나오지 않는다는 뜻입니다. 이번에 우연히 도달하지 못한 것이 아니라 도구상의 공백입니다.'],
  scopeDetectable: ['平台可偵測', 'Platform can detect', '平台可侦测', 'プラットフォームで検出可能', '플랫폼에서 감지 가능'],
  scopeUndetectable: ['平台限制', 'platform limit', '平台限制', 'プラットフォームの制約', '플랫폼 제한'],
  thresholdSources: ['門檻與來源', 'Thresholds and their source', '门槛与来源', 'しきい値とその出典', '임계값과 그 출처'],
  thresholdKey: ['門檻', 'Threshold', '门槛', 'しきい値', '임계값'],
  thresholdOrigin: ['來源', 'Origin', '来源', '出典', '출처'],
  thresholdApproved: ['客戶核定', 'Customer-approved', '客户核定', '顧客承認', '고객 승인'],
  thresholdDefault: ['平台預設', 'Platform default', '平台默认', 'プラットフォーム既定', '플랫폼 기본값'],
  claimScope: ['適用邊界', 'Scope of Claim', '适用边界', '適用範囲', '적용 경계'],
  claimEnvelope: ['實際受測組合', 'Combination actually exercised', '实际受测组合', '実際にテストされた組み合わせ', '실제로 테스트된 조합'],
  claimNotVaried: ['不得延伸的主張', 'Claims the evidence does not support', '不得延伸的主张', '証跡では裏付けられない主張', '증거로 뒷받침되지 않는 주장'],
  claimStatements: ['適用範圍聲明', 'Scope statements', '适用范围声明', '適用範囲の宣言', '적용 범위 선언'],
  claimDimension: ['維度', 'Dimension', '维度', 'ディメンション', '차원'],
  claimValue: ['本次受測值', 'Value exercised', '本次受测值', '今回テストした値', '이번에 테스트한 값'],
  claimObserved: ['已觀測', 'Observed', '已观测', '観測済み', '관측됨'],
  claimCutoff: ['統計截止點', 'Statistics cut-off', '统计截止点', '統計の締め切り時点', '통계 마감 시점'],
  claimCutoffNote: ['報告的數字都是到這一刻為止的證據算出來的。', 'Every number in this report is computed from evidence up to this point.', '报告的数字都是到这一刻为止的证据算出来的。', 'このレポートの数値はすべて、この時点までの証跡から計算されています。', '이 보고서의 모든 숫자는 이 시점까지의 증거로 계산되었습니다.'],
} as const;

export type TextKey = keyof typeof T;

export function txt(key: TextKey, lang: RLang): string {
  return pick5(T[key], lang);
}

export const STATUS_TEXT: Record<string, L5> = {
  PASS: ['通過', 'PASS', '通过', '合格', '통과'],
  PASS_WITH_RISK: ['通過(有風險)', 'PASS WITH RISK', '通过(有风险)', '合格(リスクあり)', '통과(위험 있음)'],
  FAIL: ['失敗', 'FAIL', '失败', '不合格', '실패'],
  BLOCKED: ['受阻', 'BLOCKED', '受阻', 'ブロック', '차단됨'],
  READY: ['可發布', 'READY', '可发布', 'リリース可', '출시 가능'],
  READY_WITH_RISK: ['可發布(有風險)', 'READY WITH RISK', '可发布(有风险)', 'リリース可(リスクあり)', '출시 가능(위험 있음)'],
  NOT_READY: ['不可發布', 'NOT READY', '不可发布', 'リリース不可', '출시 불가'],
  INSUFFICIENT_TESTING: ['測試不足', 'INSUFFICIENT TESTING', '测试不足', 'テスト不足', '테스트 부족'],
  GAME_FAILURE: ['遊戲缺陷', 'Game failure', '游戏缺陷', 'ゲーム不具合', '게임 결함'],
  AI_TEST_FAILURE: ['AI 測試失敗', 'AI test failure', 'AI 测试失败', 'AI テスト失敗', 'AI 테스트 실패'],
  ENVIRONMENT: ['測試環境', 'Environment', '测试环境', 'テスト環境', '테스트 환경'],
  NEEDS_TRIAGE: ['待判讀', 'Needs triage', '待判读', '判定待ち', '판독 대기'],
  deterministic: ['程式規則', 'Deterministic', '程序规则', 'プログラムルール', '프로그램 규칙'],
  ai_evaluation: ['AI 評估', 'AI evaluation', 'AI 评估', 'AI 評価', 'AI 평가'],
  always: ['每次', 'Always', '每次', '毎回', '매번'],
  frequent: ['經常', 'Frequent', '经常', '頻繁', '자주'],
  intermittent: ['偶發', 'Intermittent', '偶发', '散発', '간헐적'],
  rare: ['罕見', 'Rare', '罕见', 'まれ', '드묾'],
  single: ['單次', 'Single occurrence', '单次', '単発', '1회'],
  unable: ['無法重現', 'Unable to reproduce', '无法重现', '再現不可', '재현 불가'],
  pass: ['通過', 'Pass', '通过', '合格', '통과'],
  fail: ['失敗', 'Fail', '失败', '不合格', '실패'],
  unclear: ['不確定', 'Unclear', '不确定', '不明', '불확실'],
  skipped: ['略過', 'Skipped', '略过', 'スキップ', '건너뜀'],
  not_tested: ['未測', 'Not tested', '未测', '未テスト', '테스트 안 됨'],
  win: ['中獎', 'Win', '中奖', '当選', '당첨'],
  loss: ['未中', 'Loss', '未中', 'ハズレ', '미당첨'],
  bet: ['下注', 'Bet', '下注', 'ベット', '베팅'],
  payout: ['派彩', 'Payout', '派彩', '払い出し', '지급'],
  critical: ['Critical', 'Critical', 'Critical', 'Critical', 'Critical'],
  high: ['High', 'High', 'High', 'High', 'High'],
  medium: ['Medium', 'Medium', 'Medium', 'Medium', 'Medium'],
  low: ['Low', 'Low', 'Low', 'Low', 'Low'],
};

export const DIMENSION_TEXT: Record<string, L5> = {
  functional: ['功能品質', 'Functional Quality', '功能品质', '機能品質', '기능 품질'],
  gameplay: ['玩法品質', 'Gameplay Quality', '玩法品质', 'ゲームプレイ品質', '플레이 품질'],
  performance: ['效能品質', 'Performance Quality', '性能品质', 'パフォーマンス品質', '성능 품질'],
  visual: ['視覺品質', 'Visual Quality', '视觉品质', 'ビジュアル品質', '시각 품질'],
  audio: ['音效品質', 'Audio Quality', '音效品质', 'サウンド品質', '사운드 품질'],
  ux: ['UX 品質', 'UX Quality', 'UX 品质', 'UX 品質', 'UX 품질'],
  compatibility: ['相容性品質', 'Compatibility Quality', '兼容性品质', '互換性品質', '호환성 품질'],
  localization: ['在地化品質', 'Localization Quality', '在地化品质', 'ローカライズ品質', '현지화 품질'],
  network: ['網路品質', 'Network Quality', '网络品质', 'ネットワーク品質', '네트워크 품질'],
};

export const SCOPE_TEXT: Record<string, L5> = {
  functional: ['功能', 'Functional', '功能', '機能', '기능'],
  gameplay: ['玩法', 'Gameplay', '玩法', 'ゲームプレイ', '플레이'],
  mechanics: ['機制', 'Mechanics', '机制', 'メカニクス', '메커닉'],
  ui: ['UI', 'UI', 'UI', 'UI', 'UI'],
  ux: ['UX', 'UX', 'UX', 'UX', 'UX'],
  graphics: ['畫面', 'Graphics', '画面', '画面表示', '화면'],
  animation: ['動畫', 'Animation', '动画', 'アニメーション', '애니메이션'],
  audio: ['音效', 'Audio', '音效', 'サウンド', '사운드'],
  performance: ['效能', 'Performance', '性能', 'パフォーマンス', '성능'],
  compatibility: ['相容性', 'Compatibility', '兼容性', '互換性', '호환성'],
  network: ['網路', 'Network', '网络', 'ネットワーク', '네트워크'],
  multiplayer: ['多人', 'Multiplayer', '多人', 'マルチプレイ', '멀티플레이'],
  localization: ['在地化', 'Localization', '在地化', 'ローカライズ', '현지화'],
  save_load: ['存讀檔', 'Save / Load', '存读档', 'セーブ / ロード', '저장 / 불러오기'],
  account: ['帳號', 'Account', '账号', 'アカウント', '계정'],
  economy: ['經濟', 'Economy', '经济', 'エコノミー', '경제'],
  payment: ['付費', 'Payment', '付费', '課金', '결제'],
  ai_behavior: ['AI 行為', 'AI Behavior', 'AI 行为', 'AI の挙動', 'AI 동작'],
  physics: ['物理', 'Physics', '物理', '物理', '물리'],
  controller: ['操控', 'Controller', '操控', '操作性', '조작'],
  level: ['關卡', 'Level', '关卡', 'ステージ', '레벨'],
};

export const CATEGORY_TEXT: Record<string, L5> = {
  crash: ['Crash', 'Crash', 'Crash', 'Crash', 'Crash'],
  functional: ['功能', 'Functional', '功能', '機能', '기능'],
  gameplay: ['玩法', 'Gameplay', '玩法', 'ゲームプレイ', '플레이'],
  graphics: ['畫面', 'Graphics', '画面', '画面表示', '화면'],
  animation: ['動畫', 'Animation', '动画', 'アニメーション', '애니메이션'],
  audio: ['音效', 'Audio', '音效', 'サウンド', '사운드'],
  ui: ['UI', 'UI', 'UI', 'UI', 'UI'],
  ux: ['UX', 'UX', 'UX', 'UX', 'UX'],
  performance: ['效能', 'Performance', '性能', 'パフォーマンス', '성능'],
  network: ['網路', 'Network', '网络', 'ネットワーク', '네트워크'],
  localization: ['在地化', 'Localization', '在地化', 'ローカライズ', '현지화'],
  compatibility: ['相容性', 'Compatibility', '兼容性', '互換性', '호환성'],
  physics: ['物理', 'Physics', '物理', '物理', '물리'],
  ai: ['AI', 'AI', 'AI', 'AI', 'AI'],
  save_data: ['存檔', 'Save Data', '存盘', 'セーブデータ', '저장 데이터'],
  economy: ['經濟', 'Economy', '经济', 'エコノミー', '경제'],
};
