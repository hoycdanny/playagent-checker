import { describe, expect, test } from 'vitest';
import { shortUser } from './userLabel.ts';

describe('shortUser', () => {
  test('email → local part', () => {
    expect(shortUser('qa.lead@example.com')).toBe('qa.lead');
    expect(shortUser('  ann@x.io ')).toBe('ann');
  });
  test('long names are cut with an ellipsis', () => {
    expect(shortUser('averyveryverylongname@example.com')).toBe('averyveryv…');
    expect(shortUser('王小明測試帳號一號二號三號@example.com')).toBe('王小明測試帳號一號二…');
  });
  test('Cognito sub → first 8 chars', () => {
    expect(shortUser('3f9a2c1e-1111-4222-8333-944445555666')).toBe('3f9a2c1e');
  });
  test('empty → empty', () => {
    expect(shortUser(undefined)).toBe('');
    expect(shortUser('')).toBe('');
  });
});
