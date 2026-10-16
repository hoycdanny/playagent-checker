import type { ReactNode } from 'react';
import type { TaskMeta } from '../../api/useJobStream.ts';
import { modelLabel, PROVIDER_LABEL, providerOf } from '../modelProvider.ts';
import { useI18n } from '../../i18n/I18nProvider.tsx';
import { InfoIcon, type InfoIconName } from './InfoIcon.tsx';
import { usd4 } from '../money.ts';
import { shortUser } from '../userLabel.ts';

/**
 * 任務資訊精簡列:一排 icon 晶片(知識庫 / 裝置 / 三個模型 / 花費 / Token)。
 * 只顯示最必要的值;說明與完整數值放在滑鼠移過 / 鍵盤聚焦時的提示框,不佔版面。
 */
function Chip({ id, icon, tone, children, tip }: { id: string; icon: InfoIconName; tone?: string; children: ReactNode; tip: ReactNode }) {
  const tipId = `chip-tip-${id}`;
  return (
    <li className="dchip">
      <span className="dchip__body" tabIndex={0} aria-describedby={tipId}>
        <span className={`dchip__icon ${tone ? `dchip__icon--${tone}` : ''}`}>
          <InfoIcon name={icon} size={14} />
        </span>
        <span className="dchip__text">{children}</span>
      </span>
      <span role="tooltip" id={tipId} className="dchip__tip">{tip}</span>
    </li>
  );
}

const kfmt = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K` : String(n));

export function TaskInfoStrip({ meta, kbNames }: { meta: TaskMeta | undefined; kbNames: Map<string, string> }) {
  const { t } = useI18n();
  if (!meta) return null;
  const kbLabels = meta.knowledgeBaseIds.map((id) => kbNames.get(id) ?? id);
  const seatModel = (seat: string): string | undefined =>
    meta.seats.find((s) => s.seat === seat)?.modelId ?? (seat === 'vlm' ? meta.vlmModel : undefined);
  const roles: Array<{ seat: string; icon: InfoIconName; label: string; hint: string }> = [
    { seat: 'agent', icon: 'gamepad', label: t('detail.roleAgent'), hint: t('detail.roleAgentHint') },
    { seat: 'vlm', icon: 'eye', label: t('detail.roleVlm'), hint: t('detail.roleVlmHint') },
    { seat: 'subagent', icon: 'sparkle', label: t('detail.roleSubagent'), hint: t('detail.roleSubagentHint') },
  ];
  const fmtUsd = usd4;

  return (
    <ul className="dchips" aria-label={t('detail.info')}>
      {meta.submittedBy && (
        <Chip id="by" icon="user" tip={<><b>{t('tasks.submittedBy')}</b><span className="dchip__mono">{meta.submittedBy}</span></>}>
          {shortUser(meta.submittedBy)}
        </Chip>
      )}
      {kbLabels.length > 0 && (
        <Chip id="kb" icon="book" tip={<><b>{t('detail.knowledgeBases')}</b>{kbLabels.map((l) => <span key={l}>{l}</span>)}</>}>
          {kbLabels[0]}{kbLabels.length > 1 ? ` +${kbLabels.length - 1}` : ''}
        </Chip>
      )}
      {meta.deviceModel && (
        <Chip id="device" icon="phone" tip={<><b>{t('detail.ranOnDevice')}</b><span>{meta.deviceModel}</span></>}>
          {meta.deviceModel}
        </Chip>
      )}
      {roles.map((r) => {
        const modelId = seatModel(r.seat);
        if (!modelId) return null;
        return (
          <Chip
            key={r.seat}
            id={r.seat}
            icon={r.icon}
            tone={r.seat}
            tip={<><b>{r.label}</b><span>{r.hint}</span><span className="dchip__mono">{PROVIDER_LABEL[providerOf(modelId)]} · {modelId}</span></>}
          >
            {modelLabel(modelId).replace(/^[^·]+·\s*/, '')}
          </Chip>
        );
      })}
      {meta.billableSpendUsd !== undefined && (
        <Chip
          id="cost"
          icon="coin"
          tone="cost"
          tip={<><b>{t('detail.cost')}</b><span>{fmtUsd(meta.billableSpendUsd)}{meta.spendEstimated ? `(${t('detail.costEstimated')})` : ''}</span><span>{t('detail.budget')} {meta.budgetUsd !== undefined ? fmtUsd(meta.budgetUsd) : t('tasks.unlimited')}</span></>}
        >
          {fmtUsd(meta.billableSpendUsd)}
        </Chip>
      )}
      {meta.tokens && (
        <Chip
          id="tokens"
          icon="hash"
          tip={<><b>{t('detail.tokens')}</b><span className="dchip__mono">↑ {meta.tokens.input.toLocaleString()} · ↓ {meta.tokens.output.toLocaleString()}</span></>}
        >
          ↑{kfmt(meta.tokens.input)} ↓{kfmt(meta.tokens.output)}
        </Chip>
      )}
    </ul>
  );
}
