import { useState, type FormEvent } from 'react';
import { apiGet, apiPost, type ListResponse } from '../api/client.ts';
import { useQuery } from '../api/useQuery.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import { useAuth } from '../auth/AuthProvider.tsx';
import './ListPage.css';
import './MembersPage.css';

interface Member {
  username: string;
  email: string | null;
  tenantId: string | null;
  enabled: boolean;
  status: string | null;
  createdAt: string | null;
}

const EMPTY_FORM = { email: '', password: '', tenantId: '', admin: false };

export default function MembersPage() {
  const { t } = useI18n();
  const { isAdmin } = useAuth();
  const { data, loading, error, refetch } = useQuery<ListResponse<Member>>('members', () =>
    apiGet<ListResponse<Member>>('/users'),
  );
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [busyUser, setBusyUser] = useState<string | null>(null);

  // 非 admin 不應到這頁(導覽已隱藏;直接輸入網址時也擋下)。
  if (!isAdmin) {
    return (
      <section className="listpage listpage--wide">
        <header className="listpage__header">
          <h1 className="listpage__title">{t('page.members.title')}</h1>
        </header>
        <div className="listpage__empty">
          <p>{t('members.adminOnly')}</p>
        </div>
      </section>
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      await apiPost('/users', {
        email: form.email.trim(),
        password: form.password,
        tenantId: form.tenantId.trim(),
        admin: form.admin,
      });
      setForm(EMPTY_FORM);
      refetch();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function onToggle(m: Member) {
    setBusyUser(m.username);
    try {
      await apiPost(`/users/${encodeURIComponent(m.username)}/${m.enabled ? 'disable' : 'enable'}`, {});
      refetch();
    } catch {
      /* 忽略;refetch 會回到真實狀態 */
    } finally {
      setBusyUser(null);
    }
  }

  const members = data?.items ?? [];

  return (
    <section className="listpage listpage--wide">
      <header className="listpage__header">
        <h1 className="listpage__title">{t('page.members.title')}</h1>
        <p className="members__intro">{t('members.intro')}</p>
      </header>

      {/* 新增成員 */}
      <form className="members__form" onSubmit={onSubmit}>
        <div className="members__form-row">
          <label className="members__field">
            <span className="members__label">{t('members.email')}</span>
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              placeholder="user@example.com"
              required
            />
          </label>
          <label className="members__field">
            <span className="members__label">{t('members.tenant')}</span>
            <input
              type="text"
              value={form.tenantId}
              onChange={(e) => setForm((f) => ({ ...f, tenantId: e.target.value }))}
              placeholder="globex-us"
              required
            />
          </label>
          <label className="members__field">
            <span className="members__label">{t('members.password')}</span>
            <input
              type="text"
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
              placeholder={t('members.passwordHint')}
              required
            />
          </label>
          <label className="members__admin-check">
            <input
              type="checkbox"
              checked={form.admin}
              onChange={(e) => setForm((f) => ({ ...f, admin: e.target.checked }))}
            />
            <span>{t('members.makeAdmin')}</span>
          </label>
          <button type="submit" className="members__add-btn" disabled={submitting}>
            {submitting ? t('members.adding') : t('members.add')}
          </button>
        </div>
        {formError && <p className="listpage__error" role="alert">{formError}</p>}
      </form>

      {loading && !data ? (
        <div className="listpage__skeleton" aria-hidden="true">
          <div className="listpage__skeleton-row" />
          <div className="listpage__skeleton-row" />
        </div>
      ) : error ? (
        <p className="listpage__error" role="alert">{t('page.loadError')}</p>
      ) : members.length === 0 ? (
        <div className="listpage__empty">
          <p>{t('members.empty')}</p>
        </div>
      ) : (
        <table className="members__table">
          <thead>
            <tr>
              <th>{t('members.email')}</th>
              <th>{t('members.tenant')}</th>
              <th>{t('members.status')}</th>
              <th>{t('members.createdAt')}</th>
              <th>{t('tasks.colActions')}</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.username} className={m.enabled ? '' : 'members__row--disabled'}>
                <td>{m.email ?? m.username}</td>
                <td>{m.tenantId ?? '—'}</td>
                <td>
                  <span className={`members__badge ${m.enabled ? 'members__badge--on' : 'members__badge--off'}`}>
                    {m.enabled ? t('members.enabled') : t('members.disabled')}
                  </span>
                </td>
                <td className="members__muted">
                  {m.createdAt ? new Date(m.createdAt).toLocaleDateString() : '—'}
                </td>
                <td>
                  <button
                    type="button"
                    className="members__toggle-btn"
                    disabled={busyUser === m.username}
                    onClick={() => void onToggle(m)}
                  >
                    {m.enabled ? t('members.disable') : t('members.enable')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
