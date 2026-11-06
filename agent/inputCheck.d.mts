/** 型別宣告:agent/inputCheck.mjs。 */

/**
 * 讀回欄位內容之後,判斷剛才那段字有沒有進去。
 * true = 確實有;false = 確定沒有;null = 無法確認(讀不到 / 密碼遮罩)。
 */
export function judgeTypedText(want: string, got: string | null | undefined): boolean | null;
