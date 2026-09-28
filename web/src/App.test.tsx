import { describe, test, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { App } from './App.tsx';
import { AuthProvider } from './auth/AuthProvider.tsx';
import { I18nProvider } from './i18n/I18nProvider.tsx';
import { ThemeProvider } from './theme/ThemeProvider.tsx';

/** 造一個僅供顯示解碼用的假 idToken(header.payload.sig,payload 為 base64 JSON)。 */
function fakeIdToken(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => btoa(JSON.stringify(o));
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
}

/** 在 sessionStorage 種入 token,使 AuthProvider 初始即為已登入。 */
function seedAuth(claims: Record<string, unknown> = { email: 'qa@example.com', 'custom:tenantId': 'acme' }) {
  sessionStorage.setItem(
    'playagent.auth',
    JSON.stringify({
      idToken: fakeIdToken(claims),
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
    }),
  );
}

function renderApp() {
  return render(
    <ThemeProvider>
      <I18nProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

function langSelect(): HTMLSelectElement {
  return screen.getByRole('combobox') as HTMLSelectElement;
}

describe('App 路由守衛', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  test('未登入顯示登入頁', () => {
    renderApp();
    // 登入頁有 email/password 欄位;此時沒有導覽
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/電子郵件|Email/)).toBeInTheDocument();
  });

  test('已登入顯示 shell 與八個導覽連結', async () => {
    seedAuth();
    renderApp();
    const navs = screen.getAllByRole('navigation');
    expect(within(navs[0]!).getAllByRole('link')).toHaveLength(8);
    // 頂欄顯示租戶
    expect(screen.getByText(/acme/)).toBeInTheDocument();
  });
});

describe('已登入 shell 行為', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    seedAuth();
  });

  test('切換語言即時改變導覽文字並記憶選擇', () => {
    renderApp();
    const select = langSelect();

    fireEvent.change(select, { target: { value: 'zh-Hant' } });
    const nav = screen.getAllByRole('navigation')[0]!;
    expect(within(nav).getByText('應用管理')).toBeInTheDocument();
    expect(within(nav).getByText('測試任務')).toBeInTheDocument();
    expect(localStorage.getItem('playagent.locale')).toBe('zh-Hant');

    fireEvent.change(select, { target: { value: 'en' } });
    expect(within(nav).getByText('Apps')).toBeInTheDocument();
    expect(within(nav).getByText('Test Tasks')).toBeInTheDocument();
    expect(localStorage.getItem('playagent.locale')).toBe('en');
  });

  test('切換主題更新 data-theme 並記憶', () => {
    renderApp();
    const initial = document.documentElement.getAttribute('data-theme');
    const toggle = screen.getByRole('button', { name: /切換佈景主題|Toggle theme/ });
    fireEvent.click(toggle);
    const after = document.documentElement.getAttribute('data-theme');
    expect(after).not.toBe(initial);
    expect(['light', 'dark']).toContain(after);
    expect(localStorage.getItem('playagent.theme')).toBe(after);
  });

  test('登出後回到登入頁', () => {
    renderApp();
    const logout = screen.getByRole('button', { name: /登出|Log out/ });
    fireEvent.click(logout);
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/電子郵件|Email/)).toBeInTheDocument();
  });
});
