/** 型別宣告:agent/pageSignature.mjs(infra 測試會引用)。 */

/**
 * 回傳頁面互動狀態指紋。在瀏覽器頁面內執行(Playwright evaluate),
 * 依賴全域 `document` 與 `location`;測試時可用 stub 取代這兩個全域。
 */
export declare function buildPageSignature(): string;
