/**
 * 由 modelId 推供應商並提供顯示名稱(純文字,無圖示/商標)。
 * 供任務列表以文字呈現「模型」欄(顯示供應商名,完整 modelId 於 hover)。
 */

export type ModelProvider =
  | 'anthropic'
  | 'amazon'
  | 'qwen'
  | 'meta'
  | 'mistral'
  | 'deepseek'
  | 'openai'
  | 'google'
  | 'moonshot'
  | 'minimax'
  | 'nvidia'
  | 'writer'
  | 'zai'
  | 'unknown';

/** 由 modelId(可能含 us./eu. 等 geo 前綴)推供應商。 */
export function providerOf(modelId: string | undefined): ModelProvider {
  if (!modelId) return 'unknown';
  const id = modelId.replace(/^(us|eu|apac|jp|au|global)\./, '');
  const vendor = id.split('.')[0] ?? '';
  const map: Record<string, ModelProvider> = {
    anthropic: 'anthropic',
    amazon: 'amazon',
    qwen: 'qwen',
    meta: 'meta',
    mistral: 'mistral',
    deepseek: 'deepseek',
    openai: 'openai',
    google: 'google',
    moonshot: 'moonshot',
    moonshotai: 'moonshot',
    minimax: 'minimax',
    nvidia: 'nvidia',
    writer: 'writer',
    zai: 'zai',
  };
  return map[vendor] ?? 'unknown';
}

/** 去掉 geo/global 前綴,回傳基礎 model id。 */
function stripPrefix(modelId: string): string {
  return modelId.replace(/^(us|eu|apac|jp|au|global)\./, '');
}

/**
 * 由 modelId 解析「供應商 · 型號 版本」的人類可讀標籤。
 * 例:us.anthropic.claude-sonnet-4-5-20250929-v1:0 → "Anthropic · Sonnet 4.5"。
 * 解析不出精確版本時,盡量回傳去前綴後的精簡型號名;完整 id 仍建議放在 hover(title)。
 */
export function modelLabel(modelId: string | undefined): string {
  if (!modelId) return '—';
  const provider = providerOf(modelId);
  const providerName = PROVIDER_LABEL[provider];
  const base = stripPrefix(modelId);
  // 去掉供應商前綴段(anthropic. / amazon. ...)
  const afterVendor = base.includes('.') ? base.slice(base.indexOf('.') + 1) : base;

  let short = afterVendor;

  // Anthropic:claude-<family>-<major>[-<minor>]-<date?>-vN:0 → "Sonnet 4.5"
  // 只取「主版[.次版]」;後面的日期戳(6-8 位)不算版本。
  const claude = /^claude-(sonnet|opus|haiku|fable)-(\d{1,2})(?:-(\d{1,2}))?(?!\d)/i.exec(afterVendor);
  if (provider === 'anthropic' && claude) {
    const family = claude[1]![0]!.toUpperCase() + claude[1]!.slice(1).toLowerCase();
    const ver = claude[3] ? `${claude[2]}.${claude[3]}` : claude[2]!;
    short = `${family} ${ver}`;
  } else {
    // 通用清理:去掉結尾的日期戳(-20250929)、版本尾(-v1:0 / -v1:0:128k)、供應色調尾。
    short = afterVendor
      .replace(/[:-]\d{6,8}/g, '') // 日期戳
      .replace(/-v\d+(?::\d+)*(?::\d+k)?$/i, '') // -v1:0 / -v1:0:128k
      .replace(/:0(?::\d+k)?$/i, '') // 尾端 :0 / :0:128k
      .replace(/-instruct$/i, '')
      .replace(/-/g, ' ')
      .trim();
    // 標題化每個詞的首字(數字與已含大小寫者不動)
    short = short
      .split(' ')
      .map((w) => (/[a-z]/.test(w[0] ?? '') ? w[0]!.toUpperCase() + w.slice(1) : w))
      .join(' ');
  }

  if (providerName === '—') return short || modelId;
  return `${providerName} · ${short}`;
}

/** 供應商顯示名(純文字標籤)。 */
export const PROVIDER_LABEL: Record<ModelProvider, string> = {
  anthropic: 'Anthropic',
  amazon: 'Amazon',
  qwen: 'Qwen',
  meta: 'Meta',
  mistral: 'Mistral',
  deepseek: 'DeepSeek',
  openai: 'OpenAI',
  google: 'Google',
  moonshot: 'Moonshot',
  minimax: 'MiniMax',
  nvidia: 'NVIDIA',
  writer: 'Writer',
  zai: 'Z.ai',
  unknown: '—',
};
