import { Link, useNavigate } from 'react-router-dom';
import { useI18n } from '../i18n/I18nProvider.tsx';
import type { MessageKey } from '../i18n/messages.ts';
import AppBadge, { type AppRef } from './AppRef.tsx';
import TaskIcon, { backendIcon } from './TaskIcon.tsx';
import { modelLabel } from './modelProvider.ts';
import { CaseVersionBadge } from './cases/CaseVersions.tsx';
import { outcomeClass, outcomeOf, outcomeTip, type VerdictInfo } from './outcome.ts';
import { usd4 } from './money.ts';
import { fmtDur, formatDuration, taskDurationMs, taskRunDurationMs } from './duration.ts';
import UserTag from './UserTag.tsx';

/** 任務列(欄位為 TasksPage 與工作區共用的最小集合)。 */
export interface TaskRow {
  jobId: string;
  backend: string;
  locality: string;
  appId: string;
  state: string;
  createdAt: string;
  /** 最後狀態更新時間;與 finishedAt 一起算耗時(見 duration.ts)。 */
  updatedAt?: string;
  /** 結束時間(報告產生時間;無報告則為最後狀態更新)。 */
  finishedAt?: string;
  /** AI 開始操作遊戲的時間 —— 操作時間欄的起點(見 duration.ts)。 */
  runStartedAt?: string;
  vlmModel?: string;
  seatModels?: { agent?: string; vlm?: string; subagent?: string };
  billableSpendUsd?: number;
  spendEstimated?: boolean;
  stepCount?: number;
  /** 執行時的案例名稱 / 版本快照(舊任務可能沒有)。 */
  caseName?: string;
  caseVersion?: string;
  /** Device Farm 段數(0 = 不限、>1 = 長時)。 */
  maxSegments?: number;
  /** 測試結論(驗收標準;終局且有報告才有)。 */
  verdict?: VerdictInfo;
  /** 送出任務的使用者(email;舊任務沒有)。 */
  submittedBy?: string;
}

/** 終局狀態(不再變動):決定顯示「取消」或「刪除」。 */
export const TERMINAL_STATES = new Set([
  'pass',
  'fail',
  'error',
  'cancelled',
  'budget_exceeded',
  'dead',
]);

/** 建立時間:24 小時制 MM/DD HH:mm:ss(不顯示年份、不受地區 AM/PM 影響)。 */
function formatCreated(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export interface TasksTableProps {
  /** 要顯示的任務列(呼叫端已完成篩選/排序/分頁)。 */
  tasks: TaskRow[];
  /** appId → AppRef 對照(供 AppBadge 顯示名稱/圖示)。 */
  appById: (appId: string) => AppRef | undefined;
  /** 是否顯示勾選欄(勾選後由呼叫端上方的按鈕批次刪除 / 取消)。點整列 = 進任務詳情。 */
  showCheckbox?: boolean;
  /** 已勾選集合(showCheckbox 時必要)。 */
  selectedIds?: Set<string>;
  /** 切換單列勾選。 */
  onToggleRow?: (jobId: string, checked: boolean) => void;
  /** 切換全選(依目前顯示的列)。 */
  onToggleAll?: (checked: boolean) => void;
}

/**
 * 共用任務表格 —— 「測試任務」頁與 App 工作區「測試任務」分頁共用同一份表格,確保介面一致。
 * 差異僅由 props 控制:工作區不顯示勾選欄(showCheckbox=false)、由呼叫端決定要傳哪些列。
 */
export default function TasksTable({
  tasks,
  appById,
  showCheckbox = false,
  selectedIds,
  onToggleRow,
  onToggleAll,
}: TasksTableProps) {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const sel = selectedIds ?? new Set<string>();
  // 執行中的任務沒有結束時間,操作時間算到「現在」。整張表取同一個時間點,
  // 每列才不會各自落在不同毫秒;值隨呼叫端重新取清單而更新。
  const now = Date.now();

  const renderModel = (modelId: string | undefined) =>
    modelId ? (
      <span className="tasks__model" title={modelId}>
        {modelLabel(modelId)}
      </span>
    ) : (
      <span className="tasks__muted-cell">—</span>
    );

  return (
    <table className="tasks__table">
      <thead>
        <tr>
          {showCheckbox && (
            <th className="tasks__col-check">
              <input
                type="checkbox"
                aria-label={t('tasks.selectAll')}
                checked={tasks.length > 0 && tasks.every((x) => sel.has(x.jobId))}
                onChange={(e) => onToggleAll?.(e.target.checked)}
              />
            </th>
          )}
          <th className="tasks__col-icon">{t('tasks.colState')}</th>
          <th>{t('tasks.colCreated')}</th>
          <th>{t('tasks.colApp')}</th>
          <th className="tasks__col-case">{t('reports.col.case')}</th>
          <th className="tasks__col-icon">{t('tasks.colBackend')}</th>
          <th className="tasks__col-icon">{t('tasks.colLocality')}</th>
          <th className="tasks__col-steps">{t('tasks.colSteps')}</th>
          {/* 欄位順序與報告列表一致:步數 → 操作時間 → 花費 */}
          <th className="tasks__duration" title={t('tasks.colRunTimeTip')}>{t('tasks.colRunTime')}</th>
          <th>{t('tasks.colCost')}</th>
          <th title={t('tasks.roleAgentHint')}>{t('tasks.roleAgent')}</th>
          <th title={t('tasks.roleVlmHint')}>{t('tasks.roleVlm')}</th>
          <th title={t('tasks.roleSubagentHint')}>{t('tasks.roleSubagent')}</th>
        </tr>
      </thead>
      <tbody>
        {tasks.map((x) => {
          const bi = backendIcon(x.backend, x.maxSegments, (k) => t(k as MessageKey));
          const localityLabel = t(`locality.${x.locality}` as MessageKey);
          return (
            <tr
              key={x.jobId}
              className={`tasks__row--link${sel.has(x.jobId) ? ' tasks__row--selected' : ''}`}
              onClick={(e) => {
                // 點勾選框 / 連結時不跳頁;選取文字時也不跳頁。
                if ((e.target as HTMLElement).closest('input, a, button, label, .tasks__col-check')) return;
                if (window.getSelection()?.toString()) return;
                navigate(`/tasks/${x.jobId}`);
              }}
            >
              {showCheckbox && (
                <td className="tasks__col-check">
                  <input
                    type="checkbox"
                    aria-label={t('tasks.selectRow')}
                    checked={sel.has(x.jobId)}
                    onChange={(e) => onToggleRow?.(x.jobId, e.target.checked)}
                  />
                </td>
              )}
              <td className="tasks__col-icon">
                {/* 終局任務顯示測試結論(與報告封面同一個值);執行中 / 沒有結論才顯示執行狀態。 */}
                <span className={`tasks__state-link ${outcomeClass(outcomeOf(x))}`}>
                  <TaskIcon
                    kind="state"
                    value={outcomeOf(x)}
                    label={outcomeTip(x, (k) => t(k), locale === 'en' ? 'en' : 'zh')}
                  />
                </span>
              </td>
              <td className="tasks__created">
                {/* 鍵盤 / 螢幕閱讀器的入口(滑鼠點整列即可) */}
                <Link to={`/tasks/${x.jobId}`} className="tasks__row-link" aria-label={`${t('tasks.view')} ${formatCreated(x.createdAt)}`}>
                  {formatCreated(x.createdAt)}
                </Link>
                {x.submittedBy && (
                  <div className="tasks__by">
                    <UserTag user={x.submittedBy} prefix={t('tasks.submittedBy')} />
                  </div>
                )}
              </td>
              <td>
                <AppBadge app={appById(x.appId)} fallbackId={x.appId} />
              </td>
              <td className="tasks__col-case" title={x.caseName}>
                {x.caseName ? (
                  <>
                    <span className="tasks__case-name">{x.caseName}</span>
                    {x.caseVersion && <CaseVersionBadge version={x.caseVersion} />}
                  </>
                ) : (
                  <span className="tasks__muted-cell">—</span>
                )}
              </td>
              <td className="tasks__col-icon">
                <TaskIcon kind="backend" value={bi.value} label={bi.label} />
              </td>
              <td className="tasks__col-icon">
                <TaskIcon kind="locality" value={x.locality} label={localityLabel} />
              </td>
              <td className="tasks__col-steps">
                {typeof x.stepCount === 'number' ? (
                  x.stepCount
                ) : (
                  <span className="tasks__muted-cell">—</span>
                )}
              </td>
              {/* 操作時間:AI 真的在操作遊戲的那段(扣掉排隊、開機、連線)。
                  = 任務詳情頁時間軸上「測試中」那一段,格式也用同一個 fmtDur。
                  還沒開始操作 → 「—」;執行中 → 加 ~(到目前為止,下次輪詢才更新)。
                  總耗時(含開機)放在 title 裡,需要時滑過去看。 */}
              <td className="tasks__duration">
                {(() => {
                  const runMs = taskRunDurationMs(x, now);
                  if (runMs === null) return <span className="tasks__muted-cell">—</span>;
                  const running = !TERMINAL_STATES.has(x.state);
                  const total = taskDurationMs(x);
                  const tip = [
                    running ? t('tasks.runTimeRunning') : t('tasks.colRunTimeTip'),
                    total === null ? '' : `${t('reports.col.duration')} ${formatDuration(total)}`,
                  ].filter(Boolean).join('\n');
                  return (
                    <span title={tip}>
                      {running ? '~' : ''}
                      {fmtDur(runMs)}
                    </span>
                  );
                })()}
              </td>
              <td className="tasks__cost">
                {typeof x.billableSpendUsd === 'number' ? (
                  <span
                    title={
                      x.spendEstimated
                        ? `${t('detail.cost')} (${t('tasks.costEstimatedShort')})`
                        : t('detail.cost')
                    }
                  >
                    {usd4(x.billableSpendUsd)}
                    {x.spendEstimated && (
                      <span className="tasks__cost-est"> {t('tasks.costEstimatedShort')}</span>
                    )}
                  </span>
                ) : (
                  <span className="tasks__muted-cell">—</span>
                )}
              </td>
              <td className="tasks__text-cell">{renderModel(x.seatModels?.agent ?? x.vlmModel)}</td>
              <td className="tasks__text-cell">{renderModel(x.seatModels?.vlm ?? x.vlmModel)}</td>
              <td className="tasks__text-cell">{renderModel(x.seatModels?.subagent)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
