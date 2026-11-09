/** 型別宣告:agent/networkConditions.mjs。 */

/** 正規化後的網路劣化條件;全空時解析結果為 null(等同不施加)。 */
export interface NetworkCondition {
  offline?: true;
  latencyMs?: number;
  downloadKbps?: number;
  uploadKbps?: number;
  lossPct?: number;
}

/** 這個後端做不到的項目(附原因);要求了但做不到必須回報,不可當成已套用。 */
export interface UnsupportedItem {
  key: string;
  reason: string;
}

/** CDP Network.emulateNetworkConditions 的參數。 */
export interface CdpNetworkPayload {
  offline: boolean;
  latency: number;
  downloadThroughput: number;
  uploadThroughput: number;
}

/** 寫進報告的施加紀錄。 */
export interface NetworkConditionRecord {
  requested: NetworkCondition | null;
  applied: NetworkCondition | null;
  unsupported: UnsupportedItem[];
  ok: boolean;
  /** CDP 接受參數不等於行為達到該延遲;有獨立量測才為 true。 */
  verified: boolean;
  measuredRttMs?: number;
  error?: string;
  summary: string | null;
}

/**
 * 解析條件字串或物件;看不懂的鍵忽略而不是猜。
 * 例:'latency=1000'、'latency=1000,down=400,up=200'、'offline'、{ latencyMs: 1000 }
 */
export function parseNetworkCondition(
  spec: string | NetworkCondition | null | undefined,
): NetworkCondition | null;

/** 條件 → CDP 參數,並列出這個後端做不到的項目。 */
export function toCdpPayload(cond: NetworkCondition): {
  payload: CdpNetworkPayload;
  applied: NetworkCondition;
  unsupported: UnsupportedItem[];
};

/** 給報告看的一行摘要;沒有任何條件回 null。 */
export function describeCondition(cond: NetworkCondition | null | undefined): string | null;

/** 組出寫進報告的施加紀錄。 */
export function conditionRecord(args: {
  requested?: NetworkCondition | null;
  applied?: NetworkCondition | null;
  unsupported?: UnsupportedItem[];
  ok?: boolean;
  error?: unknown;
  measuredRttMs?: number;
}): NetworkConditionRecord;
