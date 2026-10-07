import { useState, type FormEvent } from 'react';
import { apiGet, apiPut, apiDelete, type ListResponse } from '../../api/client.ts';
import { useQuery } from '../../api/useQuery.ts';
import { useI18n } from '../../i18n/I18nProvider.tsx';
import './SecretRefsPanel.css';

export interface SecretRefEntry {
  name: string;
  label: string;
  createdAt: string;
}

/**
 * SecretRefsPanel —— 被測登入機密引用(`${鍵名}` / `secretRef:全名`)。
 *
 * 使用者填「短鍵 + 值 + 標籤」,後端組出完整機密名、把值寫進 Secrets Manager,
 * 前端永遠拿不到值(API 只回名稱與標籤)。任務執行時由執行容器讀值替換。
 *
 * 範圍是**整個租戶共用**(`playagent/tenant/<tenantId>/<鍵名>`),不是單一應用 ——
 * 嵌在應用工作區只是為了順手,所以呼叫端要把這件事寫清楚(見 workspace.secretsShared)。
 * 只屬於某個應用的帳密請用 /apps/{id}/credentials(工作區的「測試憑證」)。
 *
 * i18n 沿用原本在裝置管理頁的 devices.secret* 鍵(文案未變,只是搬了位置)。
 */
export default function SecretRefsPanel() {
  const { t } = useI18n();
  const secrets = useQuery<ListResponse<SecretRefEntry>>('secret-refs', () =>
    apiGet<ListResponse<SecretRefEntry>>('/secret-refs'),
  );

  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [label, setLabel] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setAdding(true);
    try {
      await apiPut('/secret-refs', {
        key: key.trim(),
        value,
        ...(label ? { label } : {}),
      });
      setKey('');
      setValue('');
      setLabel('');
      secrets.refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  }

  async function onRemove(name: string) {
    await apiDelete(`/secret-refs?name=${encodeURIComponent(name)}`);
    secrets.refetch();
  }

  const items = secrets.data?.items ?? [];

  return (
    <div className="srf">
      <p className="srf__desc">{t('devices.secretsDesc')}</p>

      <form className="srf__form" onSubmit={onAdd}>
        <label className="srf__field">
          <span className="srf__label">{t('devices.secretKey')}</span>
          <input
            required
            value={key}
            placeholder="TEST_USERNAME"
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
        <label className="srf__field">
          <span className="srf__label">{t('devices.secretValue')}</span>
          <input
            required
            type="password"
            autoComplete="new-password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        <label className="srf__field">
          <span className="srf__label">{t('devices.secretLabel')}</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <button type="submit" className="ws__primary" disabled={adding}>
          {adding ? t('devices.secretAdding') : t('devices.secretAdd')}
        </button>
      </form>
      <p className="srf__hint">{t('devices.secretHint')}</p>
      {error && <p className="listpage__error" role="alert">{error}</p>}

      {items.length === 0 ? (
        <div className="listpage__empty"><p>{t('devices.noSecrets')}</p></div>
      ) : (
        <ul className="listpage__list">
          {items.map((s) => (
            <li key={s.name} className="srf__item">
              <span className="srf__item-name">{s.label || s.name.split('/').pop()}</span>
              <code className="srf__item-full">{s.name}</code>
              <button type="button" className="ws__remove" onClick={() => void onRemove(s.name)}>
                {t('devices.secretRemove')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
