/**
 * 五語系小表的共用型別與取值。
 *
 * 大部分介面文字走全域 i18n(messages.ts 的 MessageKey)。但有些區塊的文字量大、只在
 * 單一頁面用(知識庫頁的介面文字、集中日誌的服務名稱、內建樣板的說明),把上百個 key
 * 塞進全域字典反而難維護,所以就地用「五元組」小表。
 *
 * 這個檔案存在的理由是:那些小表原本各自抄一份 locale → index 的對照,抄到第四份時
 * 就該收斂了 —— 新增語系只要改這裡一個地方。
 */

/** [繁中, English, 简中, 日本語, 한국어] */
export type L5 = readonly [string, string, string, string, string];

/** 支援的介面語系(與 I18nProvider 的 locale 一致)。 */
export type Loc5 = 'zh-Hant' | 'en' | 'zh-Hans' | 'ja' | 'ko';

const IDX: Record<Loc5, number> = { 'zh-Hant': 0, en: 1, 'zh-Hans': 2, ja: 3, ko: 4 };

/** locale → Loc5;認不出來退回英文(與全域 i18n 的 fallback 一致)。 */
export function loc5(locale: string): Loc5 {
  return (locale in IDX ? locale : 'en') as Loc5;
}

/**
 * 從五元組取該語系的字;缺值退回英文。
 *
 * 空字串也視為缺值 —— 表裡留一格沒填時,顯示英文比顯示空白有用得多
 * (空白的按鈕或標題看起來像壞掉,而且不會有人回報「這裡少一個字」)。
 */
export function pick5(v: L5, lang: Loc5): string {
  const s = v[IDX[lang] ?? 1];
  return s && s.trim() !== '' ? s : v[1];
}

/** 把 `{name}` 這類佔位符換掉。 */
export function fill(s: string, vars?: Record<string, string | number>): string {
  if (!vars) return s;
  let out = s;
  for (const [k, v] of Object.entries(vars)) out = out.replace(`{${k}}`, String(v));
  return out;
}
