import type { ReactNode } from 'react';
import { useI18n } from '../i18n/I18nProvider.tsx';
import './FlowGraph.css';

/**
 * 操作流程圖(端到端工作流程,專業呈現)。橫向階段卡片 + 有向連接;第 3 階段為可選。
 * 以極簡線性圖示(stroke-only SVG)標示,不使用表情符號,純 CSS/SVG,首包友善。
 */
interface Stage {
  id: string;
  icon: ReactNode;
  title: { 'zh-Hant': string; en: string };
  desc: { 'zh-Hant': string; en: string };
  optional?: boolean;
}

const ic = (paths: ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {paths}
  </svg>
);

const STAGES: Stage[] = [
  {
    id: 'artifact',
    icon: ic(<><rect x="3" y="7" width="18" height="13" rx="1.5" /><path d="M3 7l3-3h12l3 3M12 4v3" /></>),
    title: { 'zh-Hant': '產物擷取', en: 'Artifact intake' },
    desc: { 'zh-Hant': '上傳受測應用(APK/IPA/ZIP)或登錄 Web 目標', en: 'Upload the app (APK/IPA/ZIP) or register a Web target' },
  },
  {
    id: 'explore',
    icon: ic(<><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></>),
    title: { 'zh-Hant': '自主探索', en: 'Autonomous exploration' },
    desc: { 'zh-Hant': '依應用類型,Agent 自主遊玩、走遍可達畫面', en: 'By app genre, the agent explores reachable screens on its own' },
  },
  {
    id: 'memory',
    icon: ic(<><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="7" r="2.5" /><circle cx="12" cy="18" r="2.5" /><path d="M8 7l8 0M7 8l4 8M17 9l-4 7" /></>),
    title: { 'zh-Hant': '記憶地圖', en: 'Memory map' },
    desc: { 'zh-Hant': '探索所得的畫面節點與轉移,匯成導覽地圖', en: 'Screens and transitions from exploration form a navigation map' },
  },
  {
    id: 'template',
    icon: ic(<><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M4 9h16M9 9v11" /></>),
    title: { 'zh-Hant': '場景範本', en: 'Scenario templates' },
    desc: { 'zh-Hant': '依記憶地圖上的可達路徑,產生測試場景範本', en: 'Generate test scenario templates from reachable paths on the map' },
  },
  {
    id: 'refine',
    icon: ic(<><path d="M4 20h4l10-10-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></>),
    title: { 'zh-Hant': 'AI 編修範本', en: 'AI refine templates' },
    desc: { 'zh-Hant': '用自然語言微調範本,AI 產出可執行 YAML', en: 'Tune templates in natural language; AI emits executable YAML' },
  },
  {
    id: 'knowledge',
    icon: ic(<><path d="M4 5a2 2 0 0 1 2-2h6v16H6a2 2 0 0 0-2 2zM20 5a2 2 0 0 0-2-2h-6v16h6a2 2 0 0 1 2 2z" /></>),
    title: { 'zh-Hant': '知識庫綁定', en: 'Knowledge binding' },
    desc: { 'zh-Hant': '掛內建類型知識庫,或自建特殊知識(Markdown / 向量檢索)', en: 'Attach built-in genre knowledge, or your own (Markdown / retrieval)' },
    optional: true,
  },
  {
    id: 'task',
    icon: ic(<><path d="M4 6h16M4 12h16M4 18h10" /><path d="M18 16l2 2 3-3" /></>),
    title: { 'zh-Hant': '任務建立', en: 'Task creation' },
    desc: { 'zh-Hant': '選裝置後端、附加範本與知識庫,排入雲端執行', en: 'Pick device backend, attach templates & knowledge, queue to cloud' },
  },
  {
    id: 'loop',
    icon: ic(<><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4" /></>),
    title: { 'zh-Hant': 'Agent 執行迴圈', en: 'Agent loop' },
    desc: { 'zh-Hant': '截圖→VLM 定位→決策→操作,反覆迭代並回饋記憶地圖', en: 'Screenshot → VLM locate → decide → act; loops and feeds the memory map' },
  },
  {
    id: 'report',
    icon: ic(<><path d="M4 20V4M4 20h16" /><path d="M8 16v-4M12 16V8M16 16v-6" /></>),
    title: { 'zh-Hant': '報告產出', en: 'Reporting' },
    desc: { 'zh-Hant': '依型態產出:軌跡、截圖、成本與多語敘述', en: 'Reports by type: trace, screenshots, cost, multilingual narrative' },
  },
];

export default function FlowGraph() {
  const { locale } = useI18n();
  const t = locale === 'en' ? 'en' : 'zh-Hant';
  return (
    <ol className="flowg" aria-label={t === 'en' ? 'End-to-end workflow' : '端到端工作流程'}>
      {STAGES.map((s, i) => (
        <li
          key={s.id}
          className={`flowg__card${s.optional ? ' flowg__card--opt' : ''}${i < STAGES.length - 1 ? ' flowg__card--linked' : ''}`}
        >
          <div className="flowg__head">
            <span className="flowg__num">{String(i + 1).padStart(2, '0')}</span>
            <span className="flowg__icon">{s.icon}</span>
            {s.optional && <span className="flowg__opt">{t === 'en' ? 'Optional' : '可選'}</span>}
          </div>
          <span className="flowg__title">{s.title[t]}</span>
          <span className="flowg__desc">{s.desc[t]}</span>
        </li>
      ))}
    </ol>
  );
}
