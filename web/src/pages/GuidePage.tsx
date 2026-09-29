import { Suspense, lazy } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../i18n/I18nProvider.tsx';
import { guideContent } from './guideContent.ts';
import { useQuery } from '../api/useQuery.ts';
import { apiGet, type ListResponse } from '../api/client.ts';
import FlowGraph from '../components/FlowGraph.tsx';
import './ListPage.css';
import './GuidePage.css';

// React Flow 較重,懶載入不計入首包(與專案 code-splitting 一致)。
const ArchitectureGraph = lazy(() => import('../components/ArchitectureGraph.tsx'));

/** /models 回傳的目錄項(完整可用模型清單,永遠與後端一致,不會過時)。 */
interface CatalogModel {
  modelId: string;
  displayName: string;
  seats: string[];
  regions?: string[];
}
const SEAT_LABEL: Record<string, string> = { agent: 'Agent', vlm: 'VLM', subagent: 'SubAgent' };

/**
 * 使用說明頁,四大區塊:
 *  ① 系統用途(≤100 字)
 *  ② 技術架構說明 —— 大型操作流程圖
 *  ③ 系統架構說明 —— AWS 架構圖(每框標 AWS 服務)
 *  ④ 技術名詞說明與模型 / 架構細節
 */
export default function GuidePage() {
  const { locale } = useI18n();
  const g = guideContent(locale);
  // 完整可用模型清單:直接向後端 /models 取得(隨 Bedrock 目錄更新,不會過時)。
  const models = useQuery<ListResponse<CatalogModel>>('models-all', () =>
    apiGet<ListResponse<CatalogModel>>('/models'),
  );
  const catalog = models.data?.items ?? [];

  return (
    <section className="listpage listpage--wide guide">
      {/* Hero */}
      <header className="guide__hero">
        <h1 className="guide__hero-title">{g.heroTitle}</h1>
      </header>

      {/* ① 系統用途 */}
      <div className="guide__block">
        <h2 className="guide__h2"><span className="guide__num-badge">1</span>{g.purposeTitle}</h2>
        <p className="guide__purpose">{g.purposeBody}</p>
      </div>

      {/* ② 技術架構說明 —— 操作流程圖 */}
      <div className="guide__block">
        <h2 className="guide__h2"><span className="guide__num-badge">2</span>{g.flowTitle}</h2>
        <p className="guide__lead">{g.flowLead}</p>
        <FlowGraph />
      </div>

      {/* ③ 系統架構說明 —— AWS 架構圖 */}
      <div className="guide__block">
        <h2 className="guide__h2"><span className="guide__num-badge">3</span>{g.archTitle}</h2>
        <p className="guide__lead">{g.archLead}</p>
        <Suspense
          fallback={
            <div className="guide__arch-loading">
              {locale === 'en' ? 'Loading diagram…' : '載入架構圖…'}
            </div>
          }
        >
          <ArchitectureGraph />
        </Suspense>
      </div>

      {/* ④ 技術名詞說明與模型 / 架構細節 */}
      <div className="guide__block">
        <h2 className="guide__h2"><span className="guide__num-badge">4</span>{g.detailsTitle}</h2>

        {/* 名詞 */}
        <h3 className="guide__h3">{g.glossaryTitle}</h3>
        <dl className="guide__glossary">
          {g.glossary.map((it) => (
            <div key={it.term} className="guide__gloss-item">
              <dt className="guide__gloss-term">{it.term}</dt>
              <dd className="guide__gloss-desc">{it.desc}</dd>
            </div>
          ))}
        </dl>

        {/* 模型職責(Seat) */}
        <h3 className="guide__h3">{g.seatsTitle}</h3>
        <p className="guide__section-intro">{g.seatsLead}</p>
        <ul className="guide__seats">
          {g.seats.map((s) => (
            <li key={s.seat} className="guide__seat">
              <strong className="guide__seat-name">{s.seat}</strong>
              <span className="guide__seat-role">{s.role}</span>
            </li>
          ))}
        </ul>

        {/* 模型清單 —— 直接列出後端目錄的「全部」可用模型(非硬編範例) */}
        <h3 className="guide__h3">
          {g.modelsTitle}
          {catalog.length > 0 && <span className="guide__count">{catalog.length}</span>}
        </h3>
        <p className="guide__section-intro">{g.modelsLead}</p>
        {catalog.length > 0 ? (
          <div className="guide__table-wrap">
            <table className="guide__table">
              <thead>
                <tr>
                  <th>{locale === 'en' ? 'Model' : '模型'}</th>
                  <th>Model ID</th>
                  <th>{locale === 'en' ? 'Seats' : '可坐 Seat'}</th>
                </tr>
              </thead>
              <tbody>
                {catalog.map((m) => (
                  <tr key={m.modelId}>
                    <td><span className="guide__model-name">{m.displayName}</span></td>
                    <td><code className="guide__model-id">{m.modelId}</code></td>
                    <td className="guide__model-note">
                      {m.seats.map((s) => SEAT_LABEL[s] ?? s).join(' / ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="guide__section-intro">
            {locale === 'en' ? 'Loading model catalog…' : '載入模型目錄…'}
          </p>
        )}
        <p className="guide__footnote">{g.modelsFootnote}</p>

        {/* 成本護欄 */}
        <h3 className="guide__h3">{g.costTitle}</h3>
        <p className="guide__section-intro">{g.costBody}</p>

        {/* 各功能操作 */}
        <h3 className="guide__h3">{g.featuresTitle}</h3>
        {g.sections.map((s) => (
          <div key={s.id} className="guide__section">
            <h4 className="guide__h4">{s.title}</h4>
            <p className="guide__section-intro">{s.intro}</p>
            {s.steps && (
              <ul className="guide__steps">
                {s.steps.map((st) => (
                  <li key={st.title} className="guide__step">
                    <strong className="guide__step-title">{st.title}</strong>
                    <span className="guide__step-body">{st.body}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>

      <div className="guide__cta">
        <Link to="/apps" className="guide__cta-btn">
          {locale === 'en' ? 'Go to Apps →' : '前往應用管理 →'}
        </Link>
      </div>
    </section>
  );
}
