import { fill, pick5, type L5, type Loc5 } from '../i18n/locale5.ts';

/** 後端 /models 回的單價(每百萬 token 美元)。 */
export interface ModelPricing {
  inputPerM: number;
  outputPerM: number;
  estimated?: boolean;
  /**
   * 有值 = 顯示的是區域價(平台用美國區域 / 跨區端點呼叫),官方另有較便宜的 Global 價。
   * 客戶拿 AWS 官網的 Global 那欄比,會看到差 10%,所以介面要標出來。
   */
  globalPrice?: { inputPerM: number; outputPerM: number };
}

/**
 * 模型單價(每百萬 token 美元)的顯示格式。
 *
 * 不用 toFixed(2):官方有 $0.035(Nova Micro)這種三位小數的價格,toFixed(2) 會顯示成
 * $0.04 或 $0.03(浮點誤差),和官方價目表對不上。這裡至少兩位小數、最多四位,多餘的 0 去掉。
 */
export function formatPerM(n: number): string {
  if (!Number.isFinite(n)) return '$—';
  const s = n.toFixed(4).replace(/0+$/, '');
  const [i, d = ''] = s.split('.');
  return `$${i}.${d.padEnd(2, '0')}`;
}

/** 下拉選項裡價格後面的短標記。 */
export const REGIONAL_TAG: L5 = ['區域價', 'regional price', '区域价', 'リージョン価格', '리전 가격'];

const REGIONAL_NOTE: L5 = [
  '標「區域價」的模型,平台透過美國區域端點呼叫,按區域價計費。區域價比 AWS 官網價目表上的 Global 價高 10%,例如 {name}:區域價 {regional},Global 價 {global}(每百萬 token,輸入/輸出)。',
  'Models marked "regional price" are called through a US regional endpoint and billed at the regional price, which is 10% higher than the Global price on the AWS pricing page. Example, {name}: regional {regional}, Global {global} (per million tokens, input/output).',
  '标「区域价」的模型,平台通过美国区域端点调用,按区域价计费。区域价比 AWS 官网价目表上的 Global 价高 10%,例如 {name}:区域价 {regional},Global 价 {global}(每百万 token,输入/输出)。',
  '「リージョン価格」と表示されたモデルは、米国リージョンのエンドポイント経由で呼び出され、リージョン価格で課金されます。リージョン価格は AWS 料金ページの Global 価格より 10% 高くなります。例:{name} はリージョン価格 {regional}、Global 価格 {global}(100 万トークンあたり、入力/出力)。',
  '"리전 가격"으로 표시된 모델은 미국 리전 엔드포인트로 호출되며 리전 가격으로 과금됩니다. 리전 가격은 AWS 요금 페이지의 Global 가격보다 10% 높습니다. 예: {name} 리전 가격 {regional}, Global 가격 {global}(100만 토큰당, 입력/출력).',
];

const GLOBAL_TIP: L5 = [
  '區域價;AWS 官網的 Global 價為 {global}',
  'Regional price; the Global price on the AWS pricing page is {global}',
  '区域价;AWS 官网的 Global 价为 {global}',
  'リージョン価格。AWS 料金ページの Global 価格は {global}',
  '리전 가격. AWS 요금 페이지의 Global 가격은 {global}',
];

/** 「$輸入/$輸出」。 */
export function pricePair(p: { inputPerM: number; outputPerM: number }): string {
  return `${formatPerM(p.inputPerM)}/${formatPerM(p.outputPerM)}`;
}

/** 下拉選項用:價格後面接「· 區域價」(只有官方另有 Global 價時)。 */
export function regionalSuffix(p: ModelPricing | undefined, lc: Loc5): string {
  return p?.globalPrice ? ` · ${pick5(REGIONAL_TAG, lc)}` : '';
}

/** 滑鼠移上去的說明(顯示官方 Global 價)。沒有區域價時回空字串。 */
export function regionalTip(p: ModelPricing | undefined, lc: Loc5): string {
  return p?.globalPrice ? fill(pick5(GLOBAL_TIP, lc), { global: pricePair(p.globalPrice) }) : '';
}

/** 清單裡有任何區域價模型時,選單下方的說明(拿第一個當例子);沒有就回 null。 */
export function regionalNote(models: Array<{ displayName: string; pricing?: ModelPricing }>, lc: Loc5): string | null {
  const m = models.find((x) => x.pricing?.globalPrice);
  if (!m || !m.pricing?.globalPrice) return null;
  return fill(pick5(REGIONAL_NOTE, lc), {
    name: m.displayName,
    regional: pricePair(m.pricing),
    global: pricePair(m.pricing.globalPrice),
  });
}
