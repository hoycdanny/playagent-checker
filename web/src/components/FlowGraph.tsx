import type { ReactNode } from 'react';
import { useI18n } from '../i18n/I18nProvider.tsx';
import { loc5, pick5, type L5 } from '../i18n/locale5.ts';
import './FlowGraph.css';
/**
 * 操作流程圖(端到端工作流程,專業呈現)。橫向階段卡片 + 有向連接;第 3 階段為可選。
 * 以極簡線性圖示(stroke-only SVG)標示,不使用表情符號,純 CSS/SVG,首包友善。
 */
interface Stage {
  id: string;
  icon: ReactNode;
  title: L5;
  desc: L5;
  optional?: boolean;
}
const ARIA_LABEL: L5 = ['端到端工作流程', 'End-to-end workflow', '端到端工作流程', 'エンドツーエンドのワークフロー', '엔드투엔드 워크플로'];
const OPTIONAL: L5 = ['可選', 'Optional', '可选', '任意', '선택'];
const ic = (paths: ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {paths}
  </svg>
);
const STAGES: Stage[] = [
  {
    id: 'artifact',
    icon: ic(<><rect x="3" y="7" width="18" height="13" rx="1.5" /><path d="M3 7l3-3h12l3 3M12 4v3" /></>),
    title: ['產物擷取', 'Artifact intake', '产物获取', '成果物の取り込み', '산출물 수집'],
    desc: [
      '上傳受測應用(APK/IPA/ZIP)或登錄 Web 目標',
      'Upload the app (APK/IPA/ZIP) or register a Web target',
      '上传受测应用(APK/IPA/ZIP)或登记 Web 目标',
      'テスト対象アプリ(APK/IPA/ZIP)をアップロード、または Web ターゲットを登録',
      '테스트 대상 앱(APK/IPA/ZIP)을 업로드하거나 웹 대상을 등록',
    ],
  },
  {
    id: 'explore',
    icon: ic(<><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></>),
    title: ['自主探索', 'Autonomous exploration', '自主探索', '自律探索', '자율 탐색'],
    desc: [
      '依應用類型,Agent 自主遊玩、走遍可達畫面',
      'By app genre, the agent explores reachable screens on its own',
      '按应用类型,Agent 自主游玩、走遍可达画面',
      'アプリのジャンルに応じて、エージェントが自律的にプレイし到達可能な画面を巡ります',
      '앱 장르에 따라 에이전트가 스스로 플레이하며 도달 가능한 화면을 탐색',
    ],
  },
  {
    id: 'memory',
    icon: ic(<><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="7" r="2.5" /><circle cx="12" cy="18" r="2.5" /><path d="M8 7l8 0M7 8l4 8M17 9l-4 7" /></>),
    title: ['記憶地圖', 'Memory map', '记忆地图', 'メモリマップ', '메모리 맵'],
    desc: [
      '探索所得的畫面節點與轉移,匯成導覽地圖',
      'Screens and transitions from exploration form a navigation map',
      '探索所得的画面节点与转移,汇成导览地图',
      '探索で得た画面ノードと遷移をナビゲーションマップにまとめます',
      '탐색으로 얻은 화면 노드와 전이를 탐색 지도로 만듭니다',
    ],
  },
  {
    id: 'template',
    icon: ic(<><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M4 9h16M9 9v11" /></>),
    title: ['場景範本', 'Scenario templates', '场景范本', 'シナリオテンプレート', '시나리오 템플릿'],
    desc: [
      '依記憶地圖上的可達路徑,產生測試場景範本',
      'Generate test scenario templates from reachable paths on the map',
      '按记忆地图上的可达路径,生成测试场景范本',
      'マップ上の到達可能な経路からテストシナリオのテンプレートを生成します',
      '지도상의 도달 가능한 경로로 테스트 시나리오 템플릿을 생성',
    ],
  },
  {
    id: 'refine',
    icon: ic(<><path d="M4 20h4l10-10-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></>),
    title: ['AI 編修範本', 'AI refine templates', 'AI 编修范本', 'AI によるテンプレート編集', 'AI 템플릿 편집'],
    desc: [
      '用自然語言微調範本,AI 產出可執行 YAML',
      'Tune templates in natural language; AI emits executable YAML',
      '用自然语言微调范本,AI 生成可执行 YAML',
      '自然言語でテンプレートを調整し、AI が実行可能な YAML を出力します',
      '자연어로 템플릿을 다듬으면 AI가 실행 가능한 YAML을 생성',
    ],
  },
  {
    id: 'knowledge',
    icon: ic(<><path d="M4 5a2 2 0 0 1 2-2h6v16H6a2 2 0 0 0-2 2zM20 5a2 2 0 0 0-2-2h-6v16h6a2 2 0 0 1 2 2z" /></>),
    title: ['知識庫綁定', 'Knowledge binding', '知识库绑定', 'ナレッジベースの紐付け', '지식 베이스 연결'],
    desc: [
      '掛內建類型知識庫,或自建特殊知識(Markdown / 向量檢索)',
      'Attach built-in genre knowledge, or your own (Markdown / retrieval)',
      '挂载内置类型知识库,或自建特殊知识(Markdown / 向量检索)',
      '組み込みのジャンル別ナレッジベース、または独自の知識(Markdown / ベクトル検索)を紐付けます',
      '내장 장르 지식 베이스 또는 직접 만든 지식(Markdown / 벡터 검색)을 연결',
    ],
    optional: true,
  },
  {
    id: 'task',
    icon: ic(<><path d="M4 6h16M4 12h16M4 18h10" /><path d="M18 16l2 2 3-3" /></>),
    title: ['任務建立', 'Task creation', '任务创建', 'タスクの作成', '작업 생성'],
    desc: [
      '選裝置後端、附加範本與知識庫,排入雲端執行',
      'Pick device backend, attach templates & knowledge, queue to cloud',
      '选设备后端、附加范本与知识库,排入云端执行',
      'デバイスのバックエンドを選び、テンプレートとナレッジベースを添付してクラウド実行にキューイングします',
      '디바이스 백엔드를 고르고 템플릿과 지식 베이스를 첨부해 클라우드 실행 대기열에 추가',
    ],
  },
  {
    id: 'loop',
    icon: ic(<><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4" /></>),
    title: ['Agent 執行迴圈', 'Agent loop', 'Agent 执行循环', 'エージェント実行ループ', '에이전트 실행 루프'],
    desc: [
      '截圖→VLM 定位→決策→操作,反覆迭代並回饋記憶地圖',
      'Screenshot → VLM locate → decide → act; loops and feeds the memory map',
      '截图→VLM 定位→决策→操作,反复迭代并回馈记忆地图',
      'スクリーンショット→VLM で位置特定→判断→操作を繰り返し、メモリマップにフィードバックします',
      '스크린샷→VLM 위치 파악→판단→조작을 반복하며 메모리 맵에 반영',
    ],
  },
  {
    id: 'report',
    icon: ic(<><path d="M4 20V4M4 20h16" /><path d="M8 16v-4M12 16V8M16 16v-6" /></>),
    title: ['報告產出', 'Reporting', '报告产出', 'レポート出力', '리포트 생성'],
    desc: [
      '依型態產出:軌跡、截圖、成本與多語敘述',
      'Reports by type: trace, screenshots, cost, multilingual narrative',
      '按类型产出:轨迹、截图、成本与多语叙述',
      '種類別に出力:軌跡、スクリーンショット、コスト、多言語の説明',
      '유형별 생성: 궤적, 스크린샷, 비용, 다국어 서술',
    ],
  },
];
export default function FlowGraph() {
  const { locale } = useI18n();
  const lc = loc5(locale);
  return (
    <ol className="flowg" aria-label={pick5(ARIA_LABEL, lc)}>
      {STAGES.map((s, i) => (
        <li
          key={s.id}
          className={`flowg__card${s.optional ? ' flowg__card--opt' : ''}${i < STAGES.length - 1 ? ' flowg__card--linked' : ''}`}
        >
          <div className="flowg__head">
            <span className="flowg__num">{String(i + 1).padStart(2, '0')}</span>
            <span className="flowg__icon">{s.icon}</span>
            {s.optional && <span className="flowg__opt">{pick5(OPTIONAL, lc)}</span>}
          </div>
          <span className="flowg__title">{pick5(s.title, lc)}</span>
          <span className="flowg__desc">{pick5(s.desc, lc)}</span>
        </li>
      ))}
    </ol>
  );
}
