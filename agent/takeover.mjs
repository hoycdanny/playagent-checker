/**
 * 接管模式(takeover):測試人員自己動手操作被測畫面,AI 退到旁邊看。
 *
 * 為什麼不沿用既有的 commands/ 指令通道
 * ────────────────────────────────────
 * 那條通道是給「偶發的一句指示」用的,拿來即時driving 會壞在兩個地方:
 *   1. MAX_COMMANDS_PER_JOB = 100 —— 手動操作幾十下就滿了
 *   2. writeCommand 每次寫入都先 LIST 整個前綴(O(n)),操作越多寫入越慢
 * 所以接管走自己的前綴 takeover/<id>.json,用「游標」讀(StartAfter),寫入不 LIST。
 * id 是時間可排序的,字典序 == 時間序。
 *
 * 為什麼延遲會變短
 * ────────────────
 * 原本測試人員的點擊只在「步與步之間」被取用,而那個迴圈被 VLM 綁住:
 * 等 VLM 回應(實測 2.1~3.9 秒)+ 動作後固定等待 2.5 秒,整體 5~10 秒才落地。
 * 接管開啟時 runner 不呼叫 VLM,改成這裡的快速輪詢(預設 250ms)收到就做,
 * 同時也不產生模型費用。
 *
 * 狀態與輸入分開
 * ──────────────
 * takeover.json  { enabled, by, at }   開關(前端切換;runner 每輪讀,有短快取)
 * takeover/<id>.json                   一筆操作(相對座標 0–1,與裝置解析度無關)
 * takeover-ack/<id>.json               回執(前端顯示「已在裝置上執行」)
 */

/** 允許的操作種類。與兩個 runner 的 client.act 能力對齊。 */
export const TAKEOVER_KINDS = ['tap', 'drag', 'key', 'type', 'back', 'swipe'];

/** 檔名 → id(只收合法 id,擋掉路徑穿越與垃圾檔名)。 */
const ID_RE = /^cmd-[a-z0-9]{6,32}$/;

function idsFromKeys(keys, prefix) {
  return keys
    .map((k) => (k.startsWith(prefix) ? k.slice(prefix.length) : ''))
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.slice(0, -5))
    .filter((id) => ID_RE.test(id))
    .sort();
}

/** 0–1 的相對座標;格式不對回 null(不自行猜值)。 */
function validPoint(p) {
  if (!p || typeof p !== 'object') return null;
  const x = Number(p.x);
  const y = Number(p.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

/**
 * @param {object} o
 * @param {object} o.s3
 * @param {string} o.bucket
 * @param {string} o.jobPrefix  tenants/<t>/jobs/<jobId>
 * @param {{ListObjectsV2Command:Function, GetObjectCommand:Function, PutObjectCommand:Function}} o.cmds
 * @param {(m:string)=>unknown} [o.log]
 * @param {()=>number} [o.now]
 */
export function createTakeover({ s3, bucket, jobPrefix, cmds, log = () => {}, now = () => Date.now() }) {
  const statePrefix = `${jobPrefix}/takeover.json`;
  const inputPrefix = `${jobPrefix}/takeover/`;
  let cursor = null;        // 已讀到的最後一個 id(StartAfter 用)
  let on = false;           // 最近一次讀到的開關狀態
  let checkedAt = 0;
  let announced = false;    // 已經記過一次「進入接管」的 log
  const stats = { actions: 0, enteredAt: null, totalMs: 0 };

  return {
    get stats() {
      return { ...stats, enabled: on };
    },

    /**
     * 接管是否開啟。maxAgeMs 內用快取(避免每 250ms 都打一次 S3)。
     * 讀不到檔案 = 沒開(預設不接管,AI 照跑)。
     */
    async enabled(maxAgeMs = 1000) {
      if (maxAgeMs && now() - checkedAt < maxAgeMs) return on;
      checkedAt = now();
      let next = false;
      try {
        const r = await s3.send(new cmds.GetObjectCommand({ Bucket: bucket, Key: statePrefix }));
        const doc = JSON.parse(await r.Body.transformToString());
        next = doc?.enabled === true;
      } catch { next = false; } // 沒有檔案就是沒開
      if (next !== on) {
        on = next;
        if (on) {
          stats.enteredAt = now();
          if (!announced) { log('[takeover] 測試人員接管中:暫停 AI 決策,改執行手動操作'); announced = true; }
          else log('[takeover] 測試人員再次接管');
        } else {
          if (stats.enteredAt) stats.totalMs += now() - stats.enteredAt;
          stats.enteredAt = null;
          log('[takeover] 接管結束:交回 AI');
        }
      }
      return on;
    },

    /**
     * 讀出尚未處理的手動操作(依時間序)。用游標讀,不重複讀舊的。
     * 回 [{ id, kind, point?, to?, dragMs?, key?, text?, repeat?, holdMs? }]
     */
    async poll() {
      let keys = [];
      try {
        const res = await s3.send(new cmds.ListObjectsV2Command({
          Bucket: bucket,
          Prefix: inputPrefix,
          MaxKeys: 50,
          ...(cursor ? { StartAfter: `${inputPrefix}${cursor}.json` } : {}),
        }));
        keys = (res.Contents ?? []).map((o) => o.Key ?? '');
      } catch { return []; }
      const ids = idsFromKeys(keys, inputPrefix);
      const out = [];
      for (const id of ids) {
        cursor = id;
        try {
          const r = await s3.send(new cmds.GetObjectCommand({ Bucket: bucket, Key: `${inputPrefix}${id}.json` }));
          const c = JSON.parse(await r.Body.transformToString());
          const act = normalizeAction(c, id);
          if (act) { out.push(act); stats.actions += 1; }
        } catch { /* 讀不到就跳過,不重試(不卡住迴圈) */ }
      }
      return out;
    },

    /** 回執:前端據此顯示「已在裝置上執行」與實際落點。 */
    async ack(action, info) {
      await s3.send(new cmds.PutObjectCommand({
        Bucket: bucket,
        Key: `${jobPrefix}/takeover-ack/${action.id}.json`,
        Body: JSON.stringify({ id: action.id, ...info, at: new Date(now()).toISOString() }),
        ContentType: 'application/json',
      })).catch(() => {});
    },
  };
}

/**
 * 原始 JSON → runner 能用的操作。無法辨識回 null(寧可丟掉,也不要送一個亂猜的動作到裝置)。
 * 座標保持 0–1 相對值,由呼叫端換算成當前畫面像素 —— 接管期間裝置解析度可能和前端預覽不同。
 */
export function normalizeAction(c, id) {
  if (!c || typeof c !== 'object') return null;
  const kind = String(c.kind || '').toLowerCase();
  if (!TAKEOVER_KINDS.includes(kind)) return null;
  const base = { id: id ?? String(c.id ?? ''), kind };
  if (kind === 'tap') {
    const point = validPoint(c.point);
    return point ? { ...base, point } : null;
  }
  if (kind === 'drag' || kind === 'swipe') {
    const point = validPoint(c.point);
    const to = validPoint(c.to);
    if (!point || !to) return null;
    return { ...base, kind: 'drag', point, to, dragMs: clampInt(c.dragMs, 50, 5000, 600) };
  }
  if (kind === 'key') {
    const key = String(c.key || '').trim().slice(0, 20);
    if (!key) return null;
    const repeat = clampInt(c.repeat, 1, 20, 1);
    const holdMs = c.holdMs === undefined || c.holdMs === null ? undefined : clampInt(c.holdMs, 10, 5000, 0);
    return { ...base, key, repeat, ...(holdMs ? { holdMs } : {}) };
  }
  if (kind === 'type') {
    const text = typeof c.text === 'string' ? c.text.slice(0, 500) : '';
    return text ? { ...base, text } : null;
  }
  return base; // back
}

/** 夾到 [lo, hi];不是數字回 fallback。 */
function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}
