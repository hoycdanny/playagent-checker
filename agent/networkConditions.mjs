/**
 * 網路劣化條件 —— 解析、正規化,以及「哪一項這個後端做不到」。
 *
 * 為什麼需要這一層:
 *   弱網測項寫的是「延遲 1000ms」「掉封包 10%」這類具體條件。測試報告要能主張
 *   「這個條件下驗過了」,前提是**真的施加了那個條件**,而且施加失敗時要講出來。
 *   最糟的情況是案例寫了 1000ms、實際沒生效、報告照樣寫「弱網通過」。
 *
 * 所以這支的輸出刻意分成三塊:
 *   requested   —— 案例要求什麼
 *   applied     —— 實際送進瀏覽器/裝置的是什麼
 *   unsupported —— 要求了但這個後端做不到的項目(附原因)
 *
 * **瀏覽器後端做不到丟包。** CDP 的 Network.emulateNetworkConditions 只有
 * offline / latency / downloadThroughput / uploadThroughput,沒有封包遺失率。
 * 要做丟包得在主機層做流量塑形(tc netem),不在瀏覽器能力內 —— 這一點必須回報,
 * 不能把「只套了延遲」當成「弱網條件已套用」。
 */

/** CDP 用 -1 表示「不限制」。 */
const NO_LIMIT = -1;

/**
 * 解析條件字串或物件。
 *
 * 接受:
 *   'latency=1000'                     → 延遲 1000ms
 *   'latency=1000,down=400,up=200'     → 另含上下行頻寬(kbps)
 *   'loss=10'                          → 丟包 10%(瀏覽器做不到,會進 unsupported)
 *   'offline'                          → 離線
 *   { latencyMs: 1000, lossPct: 10 }   → 物件形式
 *
 * 看不懂的鍵會被忽略而不是猜:猜錯會讓報告主張一個沒套用的條件。
 */
export function parseNetworkCondition(spec) {
  if (!spec) return null;
  if (typeof spec === 'object') return normalize(spec);

  const text = String(spec).trim();
  if (!text) return null;
  if (/^(off|none|0)$/i.test(text)) return null;

  const out = {};
  if (/(^|,)\s*offline\s*(,|$)/i.test(text)) out.offline = true;

  for (const part of text.split(',')) {
    const m = part.split('=');
    if (m.length !== 2) continue;
    const key = m[0].trim().toLowerCase();
    const num = Number(String(m[1]).trim().replace(/(kbps|ms|%)$/i, ''));
    if (!Number.isFinite(num)) continue;
    if (key === 'latency' || key === 'rtt') out.latencyMs = num;
    else if (key === 'down' || key === 'download') out.downloadKbps = num;
    else if (key === 'up' || key === 'upload') out.uploadKbps = num;
    else if (key === 'loss' || key === 'packetloss') out.lossPct = num;
  }
  return normalize(out);
}

/** 夾到合理範圍並丟掉無意義的值;全空回 null(等同「不施加條件」)。 */
function normalize(raw) {
  const out = {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  if (raw.offline === true) out.offline = true;

  const lat = num(raw.latencyMs);
  if (lat !== null && lat > 0) out.latencyMs = Math.min(lat, 60_000);

  const down = num(raw.downloadKbps);
  if (down !== null && down > 0) out.downloadKbps = down;

  const up = num(raw.uploadKbps);
  if (up !== null && up > 0) out.uploadKbps = up;

  const loss = num(raw.lossPct);
  if (loss !== null && loss > 0) out.lossPct = Math.min(loss, 100);

  return Object.keys(out).length ? out : null;
}

/** kbps → bytes/s(CDP 要 bytes/s)。 */
function kbpsToBytes(kbps) {
  return Math.max(1, Math.round((kbps * 1000) / 8));
}

/**
 * 條件 → CDP Network.emulateNetworkConditions 參數,並列出做不到的項目。
 * @returns {{ payload: object, applied: object, unsupported: Array<{key:string, reason:string}> }}
 */
export function toCdpPayload(cond) {
  const applied = {};
  const unsupported = [];

  const offline = cond.offline === true;
  if (offline) applied.offline = true;

  const latency = cond.latencyMs ?? 0;
  if (latency > 0) applied.latencyMs = latency;

  const download = cond.downloadKbps ? kbpsToBytes(cond.downloadKbps) : NO_LIMIT;
  if (cond.downloadKbps) applied.downloadKbps = cond.downloadKbps;

  const upload = cond.uploadKbps ? kbpsToBytes(cond.uploadKbps) : NO_LIMIT;
  if (cond.uploadKbps) applied.uploadKbps = cond.uploadKbps;

  // 瀏覽器層沒有封包遺失率這個旋鈕。要求了就必須回報做不到,不可當成已套用。
  if (cond.lossPct) {
    unsupported.push({
      key: 'lossPct',
      reason: '瀏覽器後端無封包遺失控制(CDP 只有延遲與頻寬);丟包需在主機層做流量塑形',
    });
  }

  return {
    payload: { offline, latency, downloadThroughput: download, uploadThroughput: upload },
    applied,
    unsupported,
  };
}

/** 給報告看的一行摘要(中文);沒套用任何條件回 null。 */
export function describeCondition(cond) {
  if (!cond) return null;
  const bits = [];
  if (cond.offline) bits.push('離線');
  if (cond.latencyMs) bits.push(`延遲 ${cond.latencyMs}ms`);
  if (cond.downloadKbps) bits.push(`下行 ${cond.downloadKbps}kbps`);
  if (cond.uploadKbps) bits.push(`上行 ${cond.uploadKbps}kbps`);
  if (cond.lossPct) bits.push(`丟包 ${cond.lossPct}%`);
  return bits.length ? bits.join('、') : null;
}

/**
 * 組出寫進報告的紀錄。
 *
 * `verified` 刻意預設 false:CDP 接受參數不代表實際行為達到那個延遲。
 * 要宣稱已驗證,得有獨立量測(例如對已知端點計時)把 measuredRttMs 填進來。
 * 沒有量測就誠實標 false —— 報告寧可說「已套用、未獨立驗證」。
 */
export function conditionRecord({ requested, applied, unsupported, ok, error, measuredRttMs }) {
    return {
    requested: requested ?? null,
    applied: ok ? (applied ?? null) : null,
    unsupported: unsupported ?? [],
    ok: Boolean(ok),
    verified: typeof measuredRttMs === 'number',
    ...(typeof measuredRttMs === 'number' ? { measuredRttMs } : {}),
    ...(error ? { error: String(error) } : {}),
    summary: ok ? describeCondition(applied) : null,
  };
}
