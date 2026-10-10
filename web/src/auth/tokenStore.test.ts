import { describe, test, expect, beforeEach } from 'vitest';
import { loadTokens, needsRefresh, saveTokens, sessionExpired, SESSION_MAX_MS, type AuthTokens } from './tokenStore.ts';

const NOW = Date.parse('2026-10-10T12:00:00Z');
const tok = (over: Partial<AuthTokens> = {}): AuthTokens => ({
  idToken: 'id', accessToken: 'ac', refreshToken: 'rt', expiresAt: NOW + 3600_000, signedInAt: NOW, ...over,
});

describe('48-hour session', () => {
  test('still valid just before 48 hours, expired at 48 hours', () => {
    expect(sessionExpired(tok({ signedInAt: NOW - SESSION_MAX_MS + 1000 }), NOW)).toBe(false);
    expect(sessionExpired(tok({ signedInAt: NOW - SESSION_MAX_MS }), NOW)).toBe(true);
  });

  test('old tokens without signedInAt are not treated as expired', () => {
    expect(sessionExpired(tok({ signedInAt: undefined }), NOW)).toBe(false);
  });

  test('refresh when the id token expires within 5 minutes', () => {
    expect(needsRefresh(tok({ expiresAt: NOW + 10 * 60_000 }), NOW)).toBe(false);
    expect(needsRefresh(tok({ expiresAt: NOW + 4 * 60_000 }), NOW)).toBe(true);
    expect(needsRefresh(tok({ expiresAt: NOW - 1 }), NOW)).toBe(true);
  });
});

describe('storage', () => {
  beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });

  test('tokens survive in localStorage (stay logged in after closing the tab)', () => {
    saveTokens(tok());
    expect(localStorage.getItem('playagent.auth')).not.toBeNull();
    expect(loadTokens()?.refreshToken).toBe('rt');
  });

  test('tokens saved by the old version (sessionStorage) are still read', () => {
    sessionStorage.setItem('playagent.auth', JSON.stringify(tok({ idToken: 'old' })));
    expect(loadTokens()?.idToken).toBe('old');
  });
});
