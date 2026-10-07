import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthProvider.tsx';
import { useI18n } from '../i18n/I18nProvider.tsx';
import { useTheme } from '../theme/ThemeProvider.tsx';
import { LanguageSelect } from './LanguageSelect.tsx';
import './TopBar.css';

const BASE_NAV_KEYS = [
  { key: 'nav.guide' as const, path: '/guide' },
  { key: 'nav.apps' as const, path: '/apps' },
  { key: 'nav.cases' as const, path: '/cases' },
  { key: 'nav.tasks' as const, path: '/tasks' },
  { key: 'nav.reports' as const, path: '/reports' },
  { key: 'nav.devices' as const, path: '/devices' },
  { key: 'nav.memory' as const, path: '/memory' },
  { key: 'nav.knowledge' as const, path: '/knowledge' },
  { key: 'nav.cost' as const, path: '/cost' },
];

export function TopBar() {
  const { t } = useI18n();
  const { theme, toggleTheme } = useTheme();
  const { email, tenantId, isAdmin, logout } = useAuth();
  // 成員管理與系統更新僅 admin 可見(真正授權在後端 requireAdmin)。
  const navKeys = isAdmin
    ? [
      ...BASE_NAV_KEYS,
      { key: 'nav.members' as const, path: '/members' },
      { key: 'nav.system' as const, path: '/system' },
    ]
    : BASE_NAV_KEYS;
  const [menuOpen, setMenuOpen] = useState(false);

  // 視窗放大回桌面寬度時自動關閉行動選單,避免狀態殘留。
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(min-width: 721px)');
    const onChange = () => {
      if (mq.matches) setMenuOpen(false);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return (
    <header className="topbar" role="banner">
      <div className="topbar__row">
        <div className="topbar__brand">
          <span className="topbar__logo" aria-hidden="true">
            ▸
          </span>
          <span className="topbar__name">{t('app.name')}</span>
        </div>

        {/* 桌面導覽 */}
        <nav className="topbar__nav" aria-label={t('app.name')}>
          {navKeys.map((item) => (
            <a
              key={item.path}
              className="topbar__nav-link"
              href={`#${item.path}`}
            >
              {t(item.key)}
            </a>
          ))}
        </nav>

        <div className="topbar__actions">
          <LanguageSelect className="topbar__lang" />

          <button
            type="button"
            className="topbar__theme"
            onClick={toggleTheme}
            aria-label={t('theme.toggle')}
            title={theme === 'dark' ? t('theme.light') : t('theme.dark')}
          >
            <span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
          </button>

          <div className="topbar__user">
            {(email || tenantId) && (
              <span className="topbar__user-info" title={email ?? undefined}>
                {email && <span className="topbar__email">{email}</span>}
                {tenantId && (
                  <span className="topbar__tenant">
                    {t('auth.tenant')}: {tenantId}
                  </span>
                )}
              </span>
            )}
            <button
              type="button"
              className="topbar__logout"
              onClick={logout}
            >
              {t('auth.logout')}
            </button>
          </div>

          {/* 行動漢堡鈕:僅窄螢幕顯示(CSS 控制) */}
          <button
            type="button"
            className="topbar__menu-btn"
            aria-label={t('nav.menu')}
            aria-expanded={menuOpen}
            aria-controls="mobile-nav"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <span aria-hidden="true">{menuOpen ? '✕' : '☰'}</span>
          </button>
        </div>
      </div>

      {/* 行動展開導覽:僅窄螢幕 + 開啟時顯示 */}
      {menuOpen && (
        <nav
          id="mobile-nav"
          className="topbar__mobile-nav"
          aria-label={t('nav.menu')}
        >
          {navKeys.map((item) => (
            <a
              key={item.path}
              className="topbar__mobile-link"
              href={`#${item.path}`}
              onClick={() => setMenuOpen(false)}
            >
              {t(item.key)}
            </a>
          ))}
        </nav>
      )}
    </header>
  );
}
