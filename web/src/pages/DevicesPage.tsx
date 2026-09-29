import { useState, type FormEvent } from 'react';
import { apiGet, apiPost, apiPut, apiDelete, type ListResponse, type CloudDevice } from '../api/client.ts';
import { useQuery } from '../api/useQuery.ts';
import { useAuth } from '../auth/AuthProvider.tsx';
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

interface SecretRefEntry {
  name: string;
  label: string;
  createdAt: string;
}

export default function DevicesPage() {
  const { t } = useI18n();
  const { tenantId } = useAuth();
  const secretPrefix = `playagent/tenant/${tenantId ?? ''}/`;

  const devices = useQuery<ListResponse<DeviceView>>('devices', () =>
    apiGet<ListResponse<DeviceView>>('/devices'),
  );
  const secrets = useQuery<ListResponse<SecretRefEntry>>('secret-refs', () =>
    apiGet<ListResponse<SecretRefEntry>>('/secret-refs'),
  );
  // Device Farm 真機池(唯讀,自動建立/回收);顯示實際可用機清單而非靜態文字。
  const cloudDevices = useQuery<ListResponse<CloudDevice>>('devices-cloud', () =>
    apiGet<ListResponse<CloudDevice>>('/devices/cloud'),
  );

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

  // 機密引用
  const [secretName, setSecretName] = useState(secretPrefix);
  const [secretLabel, setSecretLabel] = useState('');
  const [addingSecret, setAddingSecret] = useState(false);
  const [secretError, setSecretError] = useState<string | null>(null);

  async function onAddSecret(e: FormEvent) {
    e.preventDefault();
    setSecretError(null);
    setAddingSecret(true);
    try {
      await apiPut('/secret-refs', { name: secretName, label: secretLabel || undefined });
      setSecretName(secretPrefix);
      setSecretLabel('');
      secrets.refetch();
    } catch (err) {
      setSecretError(err instanceof Error ? err.message : String(err));
    } finally {
      setAddingSecret(false);
    }
  }

  async function onRemoveSecret(name: string) {
    await apiDelete(`/secret-refs?name=${encodeURIComponent(name)}`);
    secrets.refetch();
  }

  function copyToken() {
    if (!issuedToken) return;
    void navigator.clipboard?.writeText(issuedToken);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const deviceItems = devices.data?.items ?? [];
  const secretItems = secrets.data?.items ?? [];

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

      {/* 本地裝置(attached) */}
      <div className="devices__card">
        <h2 className="devices__section">{t('devices.attachedSection')}</h2>
        <p className="devices__desc">{t('devices.attachedDesc')}</p>

        <form className="devices__form" onSubmit={onRegister}>
          <label className="devices__field">
            <span className="devices__label">{t('devices.label')}</span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t('devices.labelHint')}
            />
          </label>
          <button type="submit" className="devices__btn" disabled={registering}>
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

      {/* 被測登入機密引用(只管理引用,不回傳值) */}
      <div className="devices__card">
        <h2 className="devices__section">{t('devices.secretsSection')}</h2>
        <p className="devices__desc">{t('devices.secretsDesc')}</p>

        <form className="devices__form devices__form--secret" onSubmit={onAddSecret}>
          <label className="devices__field">
            <span className="devices__label">{t('devices.secretName')}</span>
            <input
              required
              value={secretName}
              onChange={(e) => setSecretName(e.target.value)}
            />
          </label>
          <label className="devices__field">
            <span className="devices__label">{t('devices.secretLabel')}</span>
            <input
              value={secretLabel}
              onChange={(e) => setSecretLabel(e.target.value)}
            />
          </label>
          <button type="submit" className="devices__btn" disabled={addingSecret}>
            {addingSecret ? t('devices.secretAdding') : t('devices.secretAdd')}
          </button>
        </form>
        <p className="devices__hint">{t('devices.secretHint')}</p>
        {secretError && (
          <p className="listpage__error" role="alert">
            {secretError}
          </p>
        )}

        {secretItems.length === 0 ? (
          <div className="listpage__empty">
            <p>{t('devices.noSecrets')}</p>
          </div>
        ) : (
          <ul className="listpage__list">
            {secretItems.map((s) => (
              <li key={s.name} className="devices__item">
                <span className="devices__item-name">{s.label}</span>
                <code className="devices__item-hint">{s.name}</code>
                <button
                  type="button"
                  className="devices__remove"
                  onClick={() => void onRemoveSecret(s.name)}
                >
                  {t('devices.secretRemove')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
