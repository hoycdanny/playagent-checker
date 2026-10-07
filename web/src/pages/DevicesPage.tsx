import { useState, type FormEvent } from 'react';
import { apiGet, apiPost, apiDelete, type ListResponse, type CloudDevice } from '../api/client.ts';
import { useQuery } from '../api/useQuery.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import type { MessageKey } from '../i18n/messages.ts';
import './ListPage.css';
import './DevicesPage.css';

interface DeviceView {
  deviceId: string;
  label: string;
  tokenHint: string;
  status: 'registered' | 'online' | 'offline';
  createdAt: string;
  lastSeenAt?: string;
}

/** GET /devices/infra —— 執行基礎設施現況(平台共用,不分租戶)。 */
interface RuntimeInfra {
  containers: { taskArn: string; cluster: string; status: string; cpu?: string; memory?: string; startedAt?: string }[];
  hosts: { instanceId: string; instanceType: string; state: string; az?: string; launchedAt?: string; jobId?: string }[];
  streams: {
    groupId: string;
    status?: string;
    locations: { location: string; alwaysOn?: number; onDemand?: number; allocated?: number; idle?: number; status?: string }[];
    activeSessions?: number;
  } | null;
  errors?: string[];
}

/** 從 errors 裡挑出某一段的訊息(段名由後端給:containers / hosts / streams)。 */
function errorFor(infra: RuntimeInfra | undefined, part: string): string | null {
  const hit = (infra?.errors ?? []).find((e) => e.startsWith(`${part}:`));
  return hit ? hit.slice(part.length + 1).trim() : null;
}

function shortTaskId(arn: string): string {
  return arn.split('/').pop() ?? arn;
}

function elapsed(iso: string | undefined): string {
  if (!iso) return '';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export default function DevicesPage() {
  const { t } = useI18n();

  const devices = useQuery<ListResponse<DeviceView>>('devices', () =>
    apiGet<ListResponse<DeviceView>>('/devices'),
  );
  // Device Farm 真機池(唯讀,自動建立/回收);顯示實際可用機清單而非靜態文字。
  const cloudDevices = useQuery<ListResponse<CloudDevice>>('devices-cloud', () =>
    apiGet<ListResponse<CloudDevice>>('/devices/cloud'),
  );
  // 容器 / EC2 主機 / GameLift Streams 現況(後端快取 30 秒)。
  const infra = useQuery<RuntimeInfra>('devices-infra', () => apiGet<RuntimeInfra>('/devices/infra'));

  // 註冊本地裝置
  const [label, setLabel] = useState('');
  const [registering, setRegistering] = useState(false);
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function onRegister(e: FormEvent) {
    e.preventDefault();
    setRegistering(true);
    try {
      const res = await apiPost<{ device: DeviceView; token: string }>(
        '/devices/register',
        { label: label || undefined },
      );
      setIssuedToken(res.token); // 只顯示這一次
      setLabel('');
      devices.refetch();
    } finally {
      setRegistering(false);
    }
  }

  async function onRemoveDevice(deviceId: string) {
    if (!window.confirm(t('devices.removeConfirm'))) return;
    await apiDelete(`/devices?deviceId=${encodeURIComponent(deviceId)}`);
    devices.refetch();
  }

  function copyToken() {
    if (!issuedToken) return;
    void navigator.clipboard?.writeText(issuedToken);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const deviceItems = devices.data?.items ?? [];
  const containers = infra.data?.containers ?? [];
  const hosts = infra.data?.hosts ?? [];
  const streams = infra.data?.streams ?? null;

  return (
    <section className="listpage listpage--wide devices">
      <header className="listpage__header">
        <h1 className="listpage__title">{t('devices.title')}</h1>
      </header>
      <p className="devices__subtitle">{t('devices.subtitle')}</p>

      {/* 雲端真機(Device Farm):任務執行時自動建立/回收,顯示實際可用機池 */}
      <div className="devices__card">
        <h2 className="devices__section">{t('devices.cloudSection')}</h2>
        <p className="devices__desc">{t('devices.cloudDesc')}</p>
        {cloudDevices.loading ? (
          <p className="devices__desc">{t('devices.cloudLoading')}</p>
        ) : cloudDevices.error ? (
          <p className="devices__desc">{t('devices.cloudError')}</p>
        ) : (cloudDevices.data?.items.length ?? 0) === 0 ? (
          <p className="devices__desc">{t('devices.cloudEmpty')}</p>
        ) : (
          <>
            <p className="devices__desc">
              {t('devices.cloudCount').replace(
                '{n}',
                String(cloudDevices.data?.items.length ?? 0),
              )}
            </p>
            <ul className="devices__cloud-list">
              {(cloudDevices.data?.items ?? []).map((d, i) => (
                <li key={`${d.name}-${d.os}-${i}`} className="devices__cloud-item">
                  <span className="devices__cloud-name">{d.name}</span>
                  <span className="devices__cloud-meta">
                    Android {d.os} · {d.arch}
                    {d.resolution ? ` · ${d.resolution}` : ''}
                    {typeof d.memoryBytes === 'number'
                      ? ` · ${Math.round(d.memoryBytes / 1024 / 1024 / 1024)} GB`
                      : ''}
                    {d.cpu ? ` · ${d.cpu}` : ''}
                  </span>
                  <span className="devices__badge devices__badge--auto">
                    {t('devices.sourceLabel')}: {t('devices.sourceProvisioned')}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {/* 容器(Fargate):Device Farm 控制器 / Web runner / Android 容器 */}
      <div className="devices__card">
        <h2 className="devices__section">{t('devices.containersSection')}</h2>
        <p className="devices__desc">{t('devices.containersDesc')}</p>
        {infra.loading && !infra.data ? (
          <p className="devices__desc">{t('devices.infraLoading')}</p>
        ) : errorFor(infra.data, 'containers') || infra.error ? (
          <p className="devices__desc">
            {t('devices.infraError').replace('{msg}', errorFor(infra.data, 'containers') ?? infra.error ?? '')}
          </p>
        ) : containers.length === 0 ? (
          <p className="devices__desc">{t('devices.infraEmpty')}</p>
        ) : (
          <ul className="devices__cloud-list">
            {containers.map((c) => (
              <li key={c.taskArn} className="devices__cloud-item">
                <span className="devices__cloud-name">{shortTaskId(c.taskArn)}</span>
                <span className="devices__cloud-meta">
                  {c.cluster}
                  {c.cpu ? ` · ${Number(c.cpu) / 1024} vCPU` : ''}
                  {c.memory ? ` · ${Math.round(Number(c.memory) / 1024)} GB` : ''}
                  {c.startedAt ? ` · ${elapsed(c.startedAt)}` : ''}
                </span>
                <span className="devices__badge devices__badge--auto">{c.status}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 每任務 EC2 主機(Android 容器跑在 Graviton 上) */}
      <div className="devices__card">
        <h2 className="devices__section">{t('devices.hostsSection')}</h2>
        <p className="devices__desc">{t('devices.hostsDesc')}</p>
        {infra.loading && !infra.data ? (
          <p className="devices__desc">{t('devices.infraLoading')}</p>
        ) : errorFor(infra.data, 'hosts') ? (
          <p className="devices__desc">
            {t('devices.infraError').replace('{msg}', errorFor(infra.data, 'hosts') ?? '')}
          </p>
        ) : hosts.length === 0 ? (
          <p className="devices__desc">{t('devices.infraEmpty')}</p>
        ) : (
          <ul className="devices__cloud-list">
            {hosts.map((h) => (
              <li key={h.instanceId} className="devices__cloud-item">
                <span className="devices__cloud-name">{h.instanceId}</span>
                <span className="devices__cloud-meta">
                  {h.instanceType}
                  {h.az ? ` · ${h.az}` : ''}
                  {h.launchedAt ? ` · ${elapsed(h.launchedAt)}` : ''}
                  {h.jobId ? ` · ${t('devices.hostJob')} ${h.jobId}` : ''}
                </span>
                <span className="devices__badge devices__badge--auto">{h.state}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Windows 串流(GameLift Streams):容量與進行中的 session */}
      <div className="devices__card">
        <h2 className="devices__section">{t('devices.streamsSection')}</h2>
        <p className="devices__desc">{t('devices.streamsDesc')}</p>
        {infra.loading && !infra.data ? (
          <p className="devices__desc">{t('devices.infraLoading')}</p>
        ) : errorFor(infra.data, 'streams') ? (
          <p className="devices__desc">
            {t('devices.infraError').replace('{msg}', errorFor(infra.data, 'streams') ?? '')}
          </p>
        ) : !streams ? (
          <p className="devices__desc">{t('devices.streamsNone')}</p>
        ) : (
          <>
            <p className="devices__desc">
              {t('devices.streamsGroup')}: <code>{streams.groupId}</code>
              {streams.status ? ` · ${streams.status}` : ''}
              {typeof streams.activeSessions === 'number'
                ? ` · ${t('devices.streamsActive')} ${streams.activeSessions}`
                : ''}
            </p>
            <ul className="devices__cloud-list">
              {streams.locations.map((l) => (
                <li key={l.location} className="devices__cloud-item">
                  <span className="devices__cloud-name">{l.location}</span>
                  <span className="devices__cloud-meta">
                    {[
                      typeof l.alwaysOn === 'number' ? `${t('devices.streamsAlwaysOn')} ${l.alwaysOn}` : null,
                      typeof l.onDemand === 'number' ? `${t('devices.streamsOnDemand')} ${l.onDemand}` : null,
                      typeof l.allocated === 'number' ? `${t('devices.streamsAllocated')} ${l.allocated}` : null,
                      typeof l.idle === 'number' ? `${t('devices.streamsIdle')} ${l.idle}` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  {l.status && <span className="devices__badge devices__badge--auto">{l.status}</span>}
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="devices__hint">{t('devices.infraNote')}</p>
      </div>

      {/* 本地裝置(attached):尚未開發完成,整區反灰避免誤按 */}
      <div className="devices__card devices__card--disabled" aria-disabled="true">
        <h2 className="devices__section">
          {t('devices.attachedSection')}
          <span className="devices__badge devices__badge--wip">{t('devices.attachedWip')}</span>
        </h2>
        <p className="devices__desc">{t('devices.attachedDesc')}</p>

        <form className="devices__form" onSubmit={onRegister}>
          <label className="devices__field">
            <span className="devices__label">{t('devices.label')}</span>
            <input
              value={label}
              disabled
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t('devices.labelHint')}
            />
          </label>
          {/* 註冊流程(本地代理)還沒做完,先停用按鈕;已註冊的裝置仍可移除。 */}
          <button type="submit" className="devices__btn" disabled>
            {registering ? t('devices.registering') : t('devices.register')}
          </button>
        </form>

        {issuedToken && (
          <div className="devices__token" role="alert">
            <div className="devices__token-head">
              <strong>{t('devices.tokenOnce')}</strong>
              <button
                type="button"
                className="devices__token-close"
                onClick={() => setIssuedToken(null)}
                aria-label={t('devices.close')}
              >
                ×
              </button>
            </div>
            <code className="devices__token-value">{issuedToken}</code>
            <div className="devices__token-actions">
              <button type="button" className="devices__btn" onClick={copyToken}>
                {copied ? t('devices.copied') : t('devices.copy')}
              </button>
            </div>
            <p className="devices__token-warn">{t('devices.tokenWarn')}</p>
          </div>
        )}

        {deviceItems.length === 0 ? (
          <div className="listpage__empty">
            <p>{t('devices.noDevices')}</p>
          </div>
        ) : (
          <ul className="listpage__list">
            {deviceItems.map((d) => (
              <li key={d.deviceId} className="devices__item">
                <span className="devices__item-name">{d.label}</span>
                <span
                  className={`devices__badge devices__badge--${d.status}`}
                  role="status"
                >
                  {t(`devices.status.${d.status}` as MessageKey)}
                </span>
                <span className="devices__item-hint">{d.tokenHint}</span>
                <button
                  type="button"
                  className="devices__remove"
                  onClick={() => void onRemoveDevice(d.deviceId)}
                >
                  {t('devices.remove')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
