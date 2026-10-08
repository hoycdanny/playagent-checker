import { useMemo, useRef, useState, type FormEvent } from 'react';
import { apiGet, apiPost, apiPut, apiDelete, type ListResponse } from '../api/client.ts';
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
  /** 是否在 admins 群組。 */
  admin?: boolean;
  /** 帳號資料最後修改時間(**不是**最後登入;Cognito 不提供登入時間)。 */
  updatedAt?: string | null;
}

const EMPTY_FORM = { email: '', password: '', tenantId: '', admin: false };
type Filter = 'all' | 'active' | 'disabled' | 'admins';

/**
 * 產生一組符合 pool 政策(大小寫 + 數字 + 符號)的隨機密碼。
 * 用 crypto.getRandomValues,不用 Math.random —— 這是會真的被拿去登入的密碼。
 */
function generatePassword(len = 16): string {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%^&*-_=+'];
  const all = sets.join('');
  const bytes = new Uint32Array(len);
  crypto.getRandomValues(bytes);
  // 先各取一個確保四類都有,再補滿剩下的長度,最後打散。
  const chars = sets.map((s, i) => s[bytes[i]! % s.length]!);
  for (let i = sets.length; i < len; i++) chars.push(all[bytes[i]! % all.length]!);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = bytes[i]! % (i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

const fmtDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString() : '—');
const fmtDateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '—';

export default function MembersPage() {
  const { t } = useI18n();
  const { isAdmin, email: myEmail } = useAuth();
  const { data, loading, error, refetch } = useQuery<ListResponse<Member>>('members', () =>
    apiGet<ListResponse<Member>>('/users'),
  );
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [busyUser, setBusyUser] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const formRef = useRef<HTMLFormElement>(null);

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

  const members = data?.items ?? [];
  const isMe = (m: Member) => (m.email ?? m.username).toLowerCase() === (myEmail ?? '').toLowerCase();

  const stats = useMemo(() => {
    const tenants = new Set(members.map((m) => m.tenantId ?? '—'));
    return {
      total: members.length,
      active: members.filter((m) => m.enabled).length,
      disabled: members.filter((m) => !m.enabled).length,
      admins: members.filter((m) => m.admin).length,
      tenants: tenants.size,
    };
  }, [members]);

  // 已存在的租戶清單(新增成員時可直接選,不用背 id)。
  const tenantOptions = useMemo(
    () => [...new Set(members.map((m) => m.tenantId).filter((x): x is string => !!x))].sort(),
    [members],
  );

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return members.filter((m) => {
      if (filter === 'active' && !m.enabled) return false;
      if (filter === 'disabled' && m.enabled) return false;
      if (filter === 'admins' && !m.admin) return false;
      if (!q) return true;
      return `${m.email ?? ''} ${m.username} ${m.tenantId ?? ''}`.toLowerCase().includes(q);
    });
  }, [members, search, filter]);

  function openForm() {
    setForm({ ...EMPTY_FORM, password: generatePassword(), tenantId: tenantOptions[0] ?? '' });
    setFormError(null);
    setShowForm(true);
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
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
      setNotice(t('members.resetDone').replace('{email}', form.email.trim()));
      setForm(EMPTY_FORM);
      setShowForm(false);
      refetch();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  /** 包一層:統一的忙碌狀態、錯誤顯示與重新整理。 */
  async function run(m: Member, fn: () => Promise<void>, done?: string) {
    setActionError(null);
    setNotice(null);
    setBusyUser(m.username);
    try {
      await fn();
      if (done) setNotice(done);
      refetch();
    } catch (err) {
      setActionError(t('members.actionFailed').replace('{msg}', err instanceof Error ? err.message : String(err)));
    } finally {
      setBusyUser(null);
    }
  }

  function onToggle(m: Member) {
    const label = m.email ?? m.username;
    if (m.enabled && !window.confirm(t('members.disableConfirm').replace('{email}', label))) return;
    void run(m, async () => {
      await apiPost(`/users/${encodeURIComponent(m.username)}/${m.enabled ? 'disable' : 'enable'}`, {});
    });
  }

  function onSetAdmin(m: Member, admin: boolean) {
    const label = m.email ?? m.username;
    const msg = admin ? t('members.adminConfirm') : t('members.revokeConfirm');
    if (!window.confirm(msg.replace('{email}', label))) return;
    void run(m, async () => {
      await apiPost(`/users/${encodeURIComponent(m.username)}/admin`, { admin });
    });
  }

  function onResetPassword(m: Member) {
    const label = m.email ?? m.username;
    const suggested = generatePassword();
    const next = window.prompt(t('members.resetPasswordPrompt').replace('{email}', label), suggested);
    if (next === null) return;
    if (next.trim().length < 8) {
      setActionError(t('members.passwordHint'));
      return;
    }
    void run(
      m,
      async () => {
        await apiPost(`/users/${encodeURIComponent(m.username)}/password`, { password: next.trim() });
      },
      t('members.resetDone').replace('{email}', label),
    );
  }

  function onChangeTenant(m: Member) {
    const label = m.email ?? m.username;
    const next = window.prompt(t('members.changeTenantPrompt').replace('{email}', label), m.tenantId ?? '');
    if (next === null) return;
    const tenantId = next.trim();
    if (!/^[A-Za-z0-9_-]{2,64}$/.test(tenantId)) {
      setActionError(t('members.changeTenantPrompt').replace('{email}', label));
      return;
    }
    void run(m, async () => {
      await apiPut(`/users/${encodeURIComponent(m.username)}`, { tenantId });
    });
  }

  function onDelete(m: Member) {
    const label = m.email ?? m.username;
    const typed = window.prompt(t('members.deleteConfirm').replace('{email}', label));
    if (typed === null) return;
    if (typed.trim().toLowerCase() !== label.toLowerCase()) {
      setActionError(t('members.deleteMismatch'));
      return;
    }
    void run(m, async () => {
      await apiDelete(`/users/${encodeURIComponent(m.username)}`);
    });
  }

  function copyPassword() {
    void navigator.clipboard?.writeText(form.password);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <section className="listpage listpage--wide members">
      <header className="listpage__header members__header">
        <div>
          <h1 className="listpage__title">{t('page.members.title')}</h1>
          <p className="members__intro">{t('members.intro')}</p>
        </div>
        {!showForm && (
          <button type="button" className="members__add-btn" onClick={openForm}>
            {t('members.add')}
          </button>
        )}
      </header>

      {/* 總覽數字:一眼看出有幾個人、幾個管理員、幾個租戶 */}
      <div className="members__stats">
        <div className="members__stat"><b>{stats.total}</b><span>{t('members.statTotal')}</span></div>
        <div className="members__stat"><b>{stats.active}</b><span>{t('members.statActive')}</span></div>
        <div className={`members__stat${stats.disabled > 0 ? ' is-warn' : ''}`}><b>{stats.disabled}</b><span>{t('members.statDisabled')}</span></div>
        <div className="members__stat"><b>{stats.admins}</b><span>{t('members.statAdmins')}</span></div>
        <div className="members__stat"><b>{stats.tenants}</b><span>{t('members.statTenants')}</span></div>
      </div>

      {notice && <p className="members__notice" role="status">{notice}</p>}
      {actionError && <p className="listpage__error" role="alert">{actionError}</p>}

      {/* 新增成員(展開式;密碼預設幫你產生一組強密碼) */}
      {showForm && (
        <form ref={formRef} className="members__form" onSubmit={onSubmit}>
          <h2 className="members__form-title">{t('members.addTitle')}</h2>
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
                list="members-tenants"
                value={form.tenantId}
                onChange={(e) => setForm((f) => ({ ...f, tenantId: e.target.value }))}
                placeholder="globex-us"
                required
              />
              <datalist id="members-tenants">
                {tenantOptions.map((x) => <option key={x} value={x} />)}
              </datalist>
              <span className="members__hint">{t('members.tenantHint')}</span>
            </label>
            <label className="members__field members__field--pw">
              <span className="members__label">{t('members.password')}</span>
              <input
                type="text"
                value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                placeholder={t('members.passwordHint')}
                required
              />
              <span className="members__pw-actions">
                <button type="button" className="members__link" onClick={() => setForm((f) => ({ ...f, password: generatePassword() }))}>
                  {t('members.generate')}
                </button>
                <button type="button" className="members__link" onClick={copyPassword}>
                  {copied ? t('members.copied') : 'Copy'}
                </button>
              </span>
            </label>
          </div>
          <div className="members__form-foot">
            <label className="members__admin-check">
              <input
                type="checkbox"
                checked={form.admin}
                onChange={(e) => setForm((f) => ({ ...f, admin: e.target.checked }))}
              />
              <span>{t('members.makeAdmin')}</span>
            </label>
            <span className="members__spacer" />
            <button type="button" className="members__cancel" onClick={() => setShowForm(false)}>
              {t('members.cancel')}
            </button>
            <button type="submit" className="members__add-btn" disabled={submitting}>
              {submitting ? t('members.adding') : t('members.add')}
            </button>
          </div>
          {formError && <p className="listpage__error" role="alert">{formError}</p>}
        </form>
      )}

      {/* 搜尋 + 狀態篩選 */}
      {members.length > 0 && (
        <div className="members__toolbar">
          <input
            className="members__search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('members.searchPlaceholder')}
            aria-label={t('members.searchPlaceholder')}
          />
          <div className="members__chips" role="group">
            {(['all', 'active', 'disabled', 'admins'] as Filter[]).map((f) => (
              <button
                key={f}
                type="button"
                className={`members__chip${filter === f ? ' is-active' : ''}`}
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
              >
                {t(`members.filter${f === 'all' ? 'All' : f === 'active' ? 'Active' : f === 'disabled' ? 'Disabled' : 'Admins'}` as const)}
              </button>
            ))}
          </div>
        </div>
      )}

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
      ) : shown.length === 0 ? (
        <div className="listpage__empty">
          <p>{t('members.noMatch')}</p>
        </div>
      ) : (
        <div className="members__table-wrap">
          <table className="members__table">
            <thead>
              <tr>
                <th scope="col">{t('members.email')}</th>
                <th scope="col">{t('members.role')}</th>
                <th scope="col">{t('members.tenant')}</th>
                <th scope="col">{t('members.status')}</th>
                <th scope="col">{t('members.createdAt')}</th>
                <th scope="col">{t('members.updatedAt')}</th>
                <th scope="col">{t('members.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((m) => {
                const label = m.email ?? m.username;
                const me = isMe(m);
                const busy = busyUser === m.username;
                return (
                  <tr key={m.username} className={m.enabled ? '' : 'members__row--disabled'}>
                    <th scope="row">
                      <span className="members__who">
                        {/* 頭像用首字母,不打外部服務 */}
                        <span className="members__avatar" aria-hidden="true">{label.slice(0, 1).toUpperCase()}</span>
                        <span className="members__who-main">
                          <span className="members__mail">{label}</span>
                          {me && <span className="members__you">{t('members.you')}</span>}
                        </span>
                      </span>
                    </th>
                    <td>
                      <span className={`members__badge ${m.admin ? 'members__badge--admin' : 'members__badge--member'}`}>
                        {m.admin ? t('members.roleAdmin') : t('members.roleMember')}
                      </span>
                    </td>
                    <td><code className="members__tenant">{m.tenantId ?? '—'}</code></td>
                    <td>
                      <span className={`members__badge ${m.enabled ? 'members__badge--on' : 'members__badge--off'}`}>
                        {m.enabled ? t('members.enabled') : t('members.disabled')}
                      </span>
                      {m.status === 'FORCE_CHANGE_PASSWORD' && (
                        <span className="members__badge members__badge--pending">{t('members.pending')}</span>
                      )}
                    </td>
                    <td className="members__muted">{fmtDate(m.createdAt)}</td>
                    <td className="members__muted">{fmtDateTime(m.updatedAt)}</td>
                    <td>
                      <div className="members__actions">
                        <button type="button" className="members__act" disabled={busy} onClick={() => onResetPassword(m)}>
                          {t('members.resetPassword')}
                        </button>
                        <button type="button" className="members__act" disabled={busy} onClick={() => onChangeTenant(m)}>
                          {t('members.changeTenant')}
                        </button>
                        {/* 自己的管理員權限與帳號狀態不開放自己動:避免把自己鎖在門外 */}
                        <button
                          type="button"
                          className="members__act"
                          disabled={busy || (me && m.admin === true)}
                          onClick={() => onSetAdmin(m, !m.admin)}
                        >
                          {m.admin ? t('members.revokeAdmin') : t('members.grantAdmin')}
                        </button>
                        <button type="button" className="members__act" disabled={busy || me} onClick={() => onToggle(m)}>
                          {m.enabled ? t('members.disable') : t('members.enable')}
                        </button>
                        <button type="button" className="members__act members__act--danger" disabled={busy || me} onClick={() => onDelete(m)}>
                          {t('members.delete')}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="members__note">{t('members.updatedHint')}</p>
    </section>
  );
}
