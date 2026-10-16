/**
 * 使用者顯示名稱:介面上只顯示短名,完整識別(email / sub)放在提示與複製裡,方便追蹤。
 *   qa.lead@example.com      → qa.lead
 *   averyveryverylongname@x  → averyveryv…
 *   3f9a2c1e-…(Cognito sub) → 3f9a2c1e
 */
const MAX = 10;

export function shortUser(id: string | null | undefined): string {
  const s = (id ?? '').trim();
  if (!s) return '';
  const at = s.indexOf('@');
  const base = at > 0 ? s.slice(0, at) : /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(s) ? s.slice(0, 8) : s;
  return [...base].length > MAX ? `${[...base].slice(0, MAX).join('')}…` : base;
}
