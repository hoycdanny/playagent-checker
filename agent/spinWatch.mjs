/**
 * AutoSpin 看守模式:拉霸機 AutoSpin 進行中,AI 決定「等待」時,不再 sleep 後等下一次(慢的)VLM 判讀,
 * 而是 runner 每 ~1 秒自己抓一張畫面、用本機低解析灰階格子比對,只在「有事發生」時才叫醒 AI,
 * 並把「事件發生當下那一張」交給 AI —— 自動關閉的升級 / 任務獎勵彈窗就算一閃即逝也不會漏記。
 *
 * 2026-10-11 實測(job-mv36xxw4):AI 每步 21–81 秒(Kimi K3 看圖 10–68 秒),兩次之間 AutoSpin 已轉 15–37 局,
 * 自動關閉的 LEVEL UP 彈窗(非拉霸收入)整個被跳過 → RTP 偏高。
 *
 * 判斷方式(不需要知道每台機台的版面):
 *  1. 分格:每張跟上一張比,動過 ≥2 次的格子 = 轉軸 / 動畫(busy);其餘 = 平常靜止的格子(calm:外框、HUD、背景)。
 *     彈窗出現只會讓底下的格子「動 1 次」然後停住,所以剛出現的彈窗仍落在 calm 格子裡。
 *  2. 覆蓋事件(overlay):calm 格子裡有一大片同時偏離基準(種子 = AI 剛看過的正常畫面)→ 彈窗 / BIG WIN / Free Spins 進場 / 斷線 / 跳回大廳(通常整個畫面變暗或被蓋住)。
 *  3. 靜止事件(still):整張畫面連續數秒完全不動 → AutoSpin 停了(或卡住)。
 *  4. 心跳(heartbeat):都沒事時每 maxMs 交回 AI 一次,讀剩餘局數、更新進度。
 * 只有轉軸在轉 / 餘額數字跳動(少數格子)不會觸發。
 */

/** 拉霸 AutoSpin / Free Spins 期間的等待(AI 給 wait 且畫面名或想法提到 AutoSpin / 剩餘局數 / Free Spins)。 */
const AUTOSPIN_RE = /autospin|auto\s*spin|自動旋轉|自动旋转|剩餘\s*\d+|剩余\s*\d+|本段剩餘|free\s*spins?|免費旋轉|免费旋转|免費遊戲|免费游戏/i;
export function isAutoSpinWait(cmd) {
  if (!cmd || cmd.action !== 'wait' || cmd.override) return false;
  return AUTOSPIN_RE.test(`${cmd.screen ?? ''} ${cmd.thinking ?? ''}`);
}

export const DEFAULTS = {
  minTransitions: 2, // 至少比過這麼多組相鄰畫面才開始判斷覆蓋(先分出哪些格子是轉軸)
  busyDelta: 14, // 相鄰兩張差異 > 此值算「這格動了一次」(灰階 0–255)
  busyMinChanges: 2, // 動過 ≥ 此次數的格子 = busy(轉軸幾乎每張都變;彈窗出現只會讓底下的格子動 1 次)
  overlayCellDelta: 32, // calm 格子偏離基準 > 此值算「變了」
  overlayFraction: 0.3, // calm 格子有這個比例以上變了 → 覆蓋事件
  minCalmCells: 40, // calm 格子太少(整個畫面都在動)就不判斷覆蓋,只靠靜止 / 心跳
  stillDelta: 1.5, // 整張平均差異 < 此值視為「沒動」
  stillMs: 4000, // 連續沒動這麼久 → 靜止事件
};

/**
 * 逐張餵灰階格子(Uint8Array,長度固定),回事件或 null。
 * 用法:const a = createAnalyzer(); a.push(gray, t) → null | { reason: 'overlay'|'still', detail }
 */
export function createAnalyzer(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  let prev = null;
  let base = null; // 基準 = 第一張(種子)
  let changes = null; // 每格「相鄰兩張差異 > busyDelta」的次數
  let transitions = 0;
  let calmCount = 0;
  let stillSince = null;
  return {
    get calmCells() { return calmCount; },
    push(g, t) {
      if (!prev) {
        base = g; prev = g; changes = new Uint16Array(g.length);
        return null;
      }
      transitions += 1;
      let sum = 0;
      for (let i = 0; i < g.length; i++) {
        const d = Math.abs(g[i] - prev[i]);
        sum += d;
        if (d > o.busyDelta && changes[i] < 65535) changes[i] += 1;
      }
      prev = g;
      // 靜止:整張平均差異很小且持續 stillMs。
      if (sum / g.length < o.stillDelta) {
        stillSince ??= t;
        if (t - stillSince >= o.stillMs) return { reason: 'still', detail: { stillMs: t - stillSince } };
      } else stillSince = null;
      if (transitions < o.minTransitions) return null;
      // 覆蓋:calm 格子(動過 < busyMinChanges 次)中偏離基準的比例。
      let calm = 0;
      let changed = 0;
      for (let i = 0; i < g.length; i++) {
        if (changes[i] >= o.busyMinChanges) continue;
        calm += 1;
        if (Math.abs(g[i] - base[i]) > o.overlayCellDelta) changed += 1;
      }
      calmCount = calm;
      if (calm < o.minCalmCells) return null;
      const frac = changed / calm;
      if (frac >= o.overlayFraction) return { reason: 'overlay', detail: { changedFraction: Math.round(frac * 100) / 100, calmCells: calm } };
      return null;
    },
  };
}

/**
 * 看守迴圈。grab() → 截圖 b64;toGray(b64) → Uint8Array 灰階格子(失敗回 null);
 * onFrame(b64, i) 給 runner 更新即時畫面(可省略)。
 * 回 { reason: 'overlay'|'still'|'heartbeat'|'error', frame: b64|null, frames, ms, detail }。
 */
export async function watchAutoSpin({
  grab, toGray, onFrame, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  maxMs = 30_000, intervalMs = 1000, analyzer = createAnalyzer(), seed = null,
}) {
  const t0 = now();
  let frames = 0;
  let last = null;
  let failures = 0;
  // 種子:AI 剛看過的那張(AutoSpin 正常進行、沒有彈窗)當第一張基準,
  // 避免一開始就跳出的彈窗被當成「平常的樣子」吸收進基準。
  if (seed) {
    const g = await toGray(seed);
    if (g) analyzer.push(g, t0);
  }
  while (now() - t0 < maxMs) {
    const tFrame = now();
    let b64;
    try {
      b64 = await grab();
      failures = 0;
    } catch (e) {
      failures += 1;
      if (failures >= 3) return { reason: 'error', frame: last, frames, ms: now() - t0, detail: { error: String(e?.message || e).slice(0, 200) } };
      await sleep(intervalMs);
      continue;
    }
    frames += 1;
    last = b64;
    if (onFrame) { try { onFrame(b64, frames); } catch { /* 即時畫面失敗不影響看守 */ } }
    const g = await toGray(b64);
    if (g) {
      const ev = analyzer.push(g, now());
      if (ev) return { reason: ev.reason, frame: b64, frames, ms: now() - t0, detail: ev.detail };
    }
    const spent = now() - tFrame;
    if (spent < intervalMs) await sleep(intervalMs - spent);
  }
  return { reason: 'heartbeat', frame: last, frames, ms: now() - t0, detail: {} };
}

/** 給 AI 的說明:為什麼這一步提早(或定時)叫醒它。 */
export function watchNote(res) {
  if (!res) return '';
  const sec = Math.round(res.ms / 1000);
  const base = `\n【AutoSpin 看守】上一步你選擇等待,runner 每秒監看畫面 ${sec} 秒(${res.frames} 張)。`;
  switch (res.reason) {
    case 'overlay':
      return `${base}偵測到畫面出現彈窗 / 覆蓋畫面(大片原本靜止的區域突然改變),提早叫醒你 —— 這張就是事件發生當下的畫面。`
        + '若是升級 / 任務 / 活動獎勵,先把畫面上寫的贈送金幣記為非拉霸收入再關閉;若是 BIG WIN / Free Spins 動畫,照腳本等它自己結束;若是斷線彈窗,照腳本重連。';
    case 'still':
      return `${base}畫面已連續數秒完全沒動,AutoSpin 可能已經停止(或遊戲卡住)。請讀 SPIN 鈕狀態與剩餘局數,依腳本決定是否重開 AutoSpin。`;
    case 'error':
      return `${base}監看途中截圖失敗,先回到一般流程。`;
    default:
      return `${base}期間沒有彈窗或停止,這是定時檢查:讀 SPIN 鈕上的剩餘局數、更新累計付費與 memo,AutoSpin 還在跑就繼續 wait。`;
  }
}
