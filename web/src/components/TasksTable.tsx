import { Link, useNavigate } from 'react-router-dom';
import { useI18n } from '../i18n/I18nProvider.tsx';
import type { MessageKey } from '../i18n/messages.ts';
import AppBadge, { type AppRef } from './AppRef.tsx';
import TaskIcon from './TaskIcon.tsx';
import { modelLabel } from './modelProvider.ts';

/** 任務列(欄位為 TasksPage 與工作區共用的最小集合)。 */
export interface TaskRow {
  jobId: string;
  backend: string;
  locality: string;
  appId: string;
  state: string;
  createdAt: string;
  vlmModel?: string;
  seatModels?: { agent?: string; vlm?: string; subagent?: string };
  billableSpendUsd?: number;
  spendEstimated?: boolean;
  stepCount?: number;
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

function stateClass(state: string): string {
  if (state === 'pass') return 'task-state--pass';
  if (state === 'fail') return 'task-state--fail';
  if (state === 'error') return 'task-state--error';
  if (state === 'cancelled') return 'task-state--cancelled';
  if (state === 'budget_exceeded') return 'task-state--budget';
  if (state === 'dead') return 'task-state--dead';
  if (state === 'running') return 'task-state--running';
  return 'task-state--queued';
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
  const { t } = useI18n();
  const navigate = useNavigate();
  const sel = selectedIds ?? new Set<string>();

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
          <th className="tasks__col-icon">{t('tasks.colBackend')}</th>
          <th className="tasks__col-icon">{t('tasks.colLocality')}</th>
          <th className="tasks__col-steps">{t('tasks.colSteps')}</th>
          <th>{t('tasks.colCost')}</th>
          <th title={t('tasks.roleAgentHint')}>{t('tasks.roleAgent')}</th>
          <th title={t('tasks.roleVlmHint')}>{t('tasks.roleVlm')}</th>
          <th title={t('tasks.roleSubagentHint')}>{t('tasks.roleSubagent')}</th>
        </tr>
      </thead>
      <tbody>
        {tasks.map((x) => {
          const backendLabel = t(`backend.${x.backend}` as MessageKey);
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
                <span className={`tasks__state-link ${stateClass(x.state)}`}>
                  <TaskIcon
                    kind="state"
                    value={x.state}
                    label={t(`state.${x.state}` as MessageKey)}
                  />
                </span>
              </td>
              <td className="tasks__created">
                {/* 鍵盤 / 螢幕閱讀器的入口(滑鼠點整列即可) */}
                <Link to={`/tasks/${x.jobId}`} className="tasks__row-link" aria-label={`${t('tasks.view')} ${formatCreated(x.createdAt)}`}>
                  {formatCreated(x.createdAt)}
                </Link>
              </td>
              <td>
                <AppBadge app={appById(x.appId)} fallbackId={x.appId} />
              </td>
              <td className="tasks__col-icon">
                <TaskIcon kind="backend" value={x.backend} label={backendLabel} />
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
              <td className="tasks__cost">
                {typeof x.billableSpendUsd === 'number' ? (
                  <span
                    title={
                      x.spendEstimated
                        ? `${t('detail.cost')} (${t('tasks.costEstimatedShort')})`
                        : t('detail.cost')
                    }
                  >
                    ${x.billableSpendUsd.toFixed(2)}
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
