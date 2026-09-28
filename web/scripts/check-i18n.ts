/**
 * i18n 缺漏檢查(Req 10.7 / 10.8)。
 * - 以 zh-Hant 的 key 集為基準。
 * - 一級語系(zh-Hant, en)缺任何 key → 錯誤(exit 1)。
 * - 二級語系(zh-Hans, ja, ko)缺 key → 警告(不失敗),對齊優先序。
 * 供 CI 於 build 前執行。
 */
import {
  CATALOGS,
  PRIMARY_LOCALES,
  LOCALES,
  type Locale,
  type MessageKey,
} from '../src/i18n/messages.ts';

const baseKeys = Object.keys(CATALOGS['zh-Hant']) as MessageKey[];
let hasError = false;

for (const locale of LOCALES as readonly Locale[]) {
  const catalog = CATALOGS[locale];
  const missing = baseKeys.filter(
    (k) => catalog[k] === undefined || catalog[k] === '',
  );
  if (missing.length === 0) continue;

  const isPrimary = PRIMARY_LOCALES.includes(locale);
  const label = isPrimary ? 'ERROR' : 'WARN';
  if (isPrimary) hasError = true;

  console.log(
    `[${label}] locale "${locale}" 缺少 ${missing.length} 個 key: ${missing.join(', ')}`,
  );
}

if (hasError) {
  console.error('i18n 檢查失敗:一級語系(zh-Hant / en)有缺漏 key。');
  process.exit(1);
}
console.log('i18n 檢查通過:一級語系 key 齊備。');
