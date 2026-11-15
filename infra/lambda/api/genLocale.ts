/** 產生內容(agent 輸出、報告、洞察、問答)所用的語系。與 web 的五語系一致。 */
export type GenLocale = 'zh-Hant' | 'en' | 'zh-Hans' | 'ja' | 'ko';

export const GEN_LOCALES: readonly GenLocale[] = ['zh-Hant', 'en', 'zh-Hans', 'ja', 'ko'];

/** 解析語系字串;舊值 'zh' 視為 zh-Hant,未知值回傳 fallback。 */
export function parseGenLocale(v: unknown, fallback: GenLocale): GenLocale {
  if (v === 'zh') return 'zh-Hant';
  if (typeof v === 'string' && (GEN_LOCALES as readonly string[]).includes(v)) return v as GenLocale;
  return fallback;
}

/** 各語系的原生名稱(放進 prompt 的語言指示)。 */
export const LANG_NAME: Record<GenLocale, string> = {
  'zh-Hant': '繁體中文',
  en: 'English',
  'zh-Hans': '简体中文',
  ja: '日本語',
  ko: '한국어',
};

/** 快取檔名後綴:zh-Hant -> zh、en -> en,其餘用語系碼。 */
export function cacheSuffix(l: GenLocale): string {
  if (l === 'zh-Hant') return 'zh';
  return l;
}
