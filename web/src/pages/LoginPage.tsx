import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthProvider.tsx';
import { LanguageSelect } from '../components/LanguageSelect.tsx';
import { isAuthConfigured } from '../config.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import './LoginPage.css';

/** 社群登入預留:UI 先到位,實際串接(Cognito IdP)之後再做,故暫 disabled。 */
const SOCIAL_PROVIDERS = [
  { id: 'google', labelKey: 'auth.continueGoogle' as const, glyph: 'G' },
  { id: 'facebook', labelKey: 'auth.continueFacebook' as const, glyph: 'f' },
];

export function LoginPage() {
  const { t } = useI18n();
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const configured = isAuthConfigured();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'NotAuthorizedException' || name === 'UserNotFoundException') {
        setError(t('auth.errorInvalid'));
      } else {
        setError(t('auth.errorGeneric'));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login">
      {/* 左側:品牌與系統用途介紹,讓第一次來的人知道這是什麼 */}
      <aside className="login__intro" aria-hidden="true">
        <div className="login__brand">
          <span className="login__logo">▸</span>
          <span className="login__brand-name">{t('app.name')}</span>
        </div>
        <p className="login__lead">{t('auth.introLead')}</p>
        <ul className="login__features">
          <li>{t('auth.feature1')}</li>
          <li>{t('auth.feature2')}</li>
          <li>{t('auth.feature3')}</li>
        </ul>
      </aside>

      {/* 右側:登入表單 */}
      <main className="login__panel" role="main">
        <div className="login__panel-top">
          <LanguageSelect className="login__lang" />
        </div>

        <form
          className="login__card"
          onSubmit={onSubmit}
          aria-labelledby="login-title"
        >
          {/* 小螢幕(介紹區隱藏時)也看得到品牌名 */}
          <div className="login__card-brand">
            <span className="login__logo">▸</span>
            <span className="login__brand-name">{t('app.name')}</span>
          </div>
          <h1 id="login-title" className="login__title">
            {t('auth.welcome')}
          </h1>

          {!configured && (
            <p className="login__notice" role="status">
              {t('auth.notConfigured')}
            </p>
          )}

          {/* 社群登入(預留):先 disabled + 即將推出 */}
          <div className="login__social">
            {SOCIAL_PROVIDERS.map((p) => (
              <button
                key={p.id}
                type="button"
                className="login__social-btn"
                disabled
                title={t('auth.comingSoon')}
                aria-label={`${t(p.labelKey)} (${t('auth.comingSoon')})`}
              >
                <span className="login__social-glyph" aria-hidden="true">
                  {p.glyph}
                </span>
                <span>{t(p.labelKey)}</span>
                <span className="login__badge">{t('auth.comingSoon')}</span>
              </button>
            ))}
          </div>

          <div className="login__divider">
            <span>{t('auth.orDivider')}</span>
          </div>

          <label className="login__field">
            <span className="login__label">{t('auth.email')}</span>
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting || !configured}
            />
          </label>

          <label className="login__field">
            <span className="login__label">{t('auth.password')}</span>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting || !configured}
            />
          </label>

          {error && (
            <p className="login__error" role="alert">
              {error}
            </p>
          )}

          <button
            type="submit"
            className="login__submit"
            disabled={submitting || !configured}
          >
            {submitting ? t('auth.signingIn') : t('auth.submit')}
          </button>
        </form>
      </main>
    </div>
  );
}
