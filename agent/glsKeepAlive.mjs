/**
 * GameLift Streams session 保活。
 *
 * 問題:engine 以 SignalRequest='NO_CLIENT_CONNECTION' 開 session,沒有 client 連進來,
 * 而 ConnectionTimeoutSeconds(等 client 連線/重連的窗口)上限是 AWS 強制的 3600 秒。
 * 所以無人連線的 session 一定在一小時內被收掉。但 SessionLengthSeconds 可以到 24 小時 ——
 * 差別只在「有沒有 client 連著」。這支程式就是那個 client。
 *
 * 為什麼要瀏覽器
 * ────────────
 * SignalRequest 必須由 AWS Web SDK 的 generateSignalRequest() 產生。自己用標準 WebRTC 組
 * {type:"offer",sdp:...} 會被 API 直接拒絕:
 *   'SignalRequest' value is not a valid WebSDK signal request
 * 而那個 SDK 需要 videoElement / audioElement,也就是需要 DOM。
 * (這個結論是實際打 API 才確定的,花了一個 GPU session;見 docs/design/windows-long-run.md。)
 *
 * 分工
 * ───
 * 瀏覽器只負責 WebRTC 與 SDK;呼叫 GameLift API 的事留在 Node 這邊 ——
 * AWS 憑證不該進到瀏覽器環境。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GameLiftStreamsClient, GetStreamSessionCommand, CreateStreamSessionConnectionCommand,
} from '@aws-sdk/client-gameliftstreams';

const HERE = dirname(fileURLToPath(import.meta.url));

/** session 可以接受 client 連線的狀態。 */
const CONNECTABLE = new Set(['ACTIVE', 'PENDING_CLIENT_RECONNECTION']);
/** 已經沒救的狀態:不要再重試。 */
export const FINAL_STATES = new Set(['TERMINATED', 'TERMINATING', 'ERROR']);
/** 連線被視為斷掉的 WebRTC 狀態。 */
const DEAD_RTC = new Set(['disconnected', 'failed', 'closed']);

/** 重連退避:5s、10s、20s…上限 60s。 */
export function retryDelayMs(attempt) {
  return Math.min(60_000, 5_000 * 2 ** Math.max(0, attempt - 1));
}

/**
 * 依 session 狀態決定下一步。抽成純函式才驗得到各種狀態組合。
 *
 * @param {string} sessionStatus GetStreamSession 回的 Status
 * @param {string} rtcState      瀏覽器端最後一次回報的 connectionState
 * @returns {{action:'connect'|'wait'|'hold'|'stop', why:string}}
 */
export function decide(sessionStatus, rtcState) {
  const s = String(sessionStatus ?? '');
  const r = String(rtcState ?? '');
  if (FINAL_STATES.has(s)) return { action: 'stop', why: `session ${s}` };
  // 已經是 CONNECTED 而且瀏覽器那端也還活著 → 什麼都不用做。
  if (s === 'CONNECTED' && r && !DEAD_RTC.has(r)) return { action: 'hold', why: `connected(${r})` };
  // CONNECTED 但 WebRTC 已經斷了:GLS 還沒反應過來,等它轉成 PENDING_CLIENT_RECONNECTION。
  if (s === 'CONNECTED') return { action: 'wait', why: `session connected but rtc=${r || 'unknown'}` };
  if (CONNECTABLE.has(s)) return { action: 'connect', why: `session ${s}` };
  // ACTIVATING 之類:還沒到可以連的時候。
  return { action: 'wait', why: `session ${s}` };
}

/**
 * @param {object} o
 * @param {string} o.streamGroupId
 * @param {string} o.sessionArn
 * @param {string} [o.region]
 * @param {() => Promise<{ page: any, close: () => Promise<void> }>} o.browser
 *   開一個已載入保活頁面與 SDK 的頁面。注入方式由呼叫端決定(本機驗證與
 *   Fargate 映像的來源不同),這個模組不綁 Playwright 的安裝位置。
 * @param {(m:string)=>void} [o.log]
 */
export function createKeepAlive({ streamGroupId, sessionArn, region = 'us-west-2', browser, log = () => {} }) {
  const gl = new GameLiftStreamsClient({ region });
  let page = null;
  let closeBrowser = null;
  let stopped = false;
  let attempt = 0;
  let connects = 0;
  let connectedAt = 0;

  const status = async () => {
    const g = await gl.send(new GetStreamSessionCommand({
      Identifier: streamGroupId, StreamSessionIdentifier: sessionArn,
    }));
    return { status: g.Status ?? '', reason: g.StatusReason ?? '' };
  };

  const rtcState = async () => {
    if (!page) return '';
    try { return String(await page.evaluate(() => window.paKeepAlive.lastState())); } catch { return ''; }
  };

  async function ensurePage() {
    if (page) return;
    const b = await browser();
    page = b.page;
    closeBrowser = b.close;
    await initPage();
  }

  /**
   * 建立(或重建)SDK 物件。
   *
   * init() 的回傳值一定要檢查。不檢查的話 gls 會留在 null,接著 offer() 丟
   * 「尚未 init()」—— 那是個誤導的訊息,真正的原因(例如「SDK 未載入」)就被吞掉了。
   * 實際踩過:連續七次重試都報「尚未 init()」,真正的原因只出現在第一次。
   */
  async function initPage() {
    const err = await page.evaluate(() => window.paKeepAlive.init());
    if (err) throw new Error(`頁面初始化失敗:${err}`);
  }

  /** 連一次(或重連一次)。 */
  async function connectOnce() {
    await ensurePage();
    // 重連前先收掉舊的 peer,再 init 一個新的 —— 不收的話舊 peer 會留著,
    // SDK 的狀態回報會混在一起,分不出是哪一條連線斷的。
    await page.evaluate(() => window.paKeepAlive.close());
    await initPage();
    const signalRequest = await page.evaluate(() => window.paKeepAlive.offer());
    if (!signalRequest || typeof signalRequest !== 'string') throw new Error('generateSignalRequest 沒有回傳字串');
    const r = await gl.send(new CreateStreamSessionConnectionCommand({
      Identifier: streamGroupId, StreamSessionIdentifier: sessionArn, SignalRequest: signalRequest,
    }));
    if (!r.SignalResponse) throw new Error('CreateStreamSessionConnection 沒有回傳 SignalResponse');
    await page.evaluate((res) => window.paKeepAlive.answer(res), r.SignalResponse);
    connects++;
    connectedAt = Date.now();
    log(`[keepalive] 已連線(第 ${connects} 次)`);
  }

  return {
    get connects() { return connects; },
    get upSec() { return connectedAt ? Math.round((Date.now() - connectedAt) / 1000) : 0; },

    /**
     * 一直維持連線直到 session 結束或被 stop()。
     * 不丟錯:保活掛掉只代表回到原本的一小時上限,不該讓整個任務失敗。
     */
    async run({ pollMs = 15_000 } = {}) {
      while (!stopped) {
        let st = { status: '', reason: '' };
        try {
          st = await status();
        } catch (e) {
          log(`[keepalive] 查詢 session 失敗:${String(e?.message || e).slice(0, 160)}`);
          await new Promise((r) => setTimeout(r, pollMs));
          continue;
        }
        const d = decide(st.status, await rtcState());
        if (d.action === 'stop') { log(`[keepalive] 結束:${d.why} ${st.reason}`); break; }
        if (d.action === 'connect') {
          attempt++;
          try {
            await connectOnce();
            attempt = 0;
          } catch (e) {
            const wait = retryDelayMs(attempt);
            log(`[keepalive] 連線失敗(第 ${attempt} 次,等 ${Math.round(wait / 1000)}s):${String(e?.message || e).slice(0, 200)}`);
            await new Promise((r) => setTimeout(r, wait));
            continue;
          }
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
      await this.stop();
    },

    async stop() {
      stopped = true;
      try { if (page) await page.evaluate(() => window.paKeepAlive.close()); } catch { /* 頁面可能已關 */ }
      try { if (closeBrowser) await closeBrowser(); } catch { /* 瀏覽器可能已關 */ }
      page = null;
      closeBrowser = null;
      log(`[keepalive] 已停止(共連線 ${connects} 次)`);
    },
  };
}

/** 保活頁面的內容(映像裡與這支程式同一個資料夾)。 */
export function pageHtml() {
  return readFileSync(join(HERE, 'glsKeepAlivePage.html'), 'utf8');
}

// 租約的純邏輯放在 deadlineLease.mjs:runner 端(Windows 主機,相依另外打包)也要用同一組
// 數字,而它不能把 AWS SDK 一起拖進去。這裡轉出來讓既有的匯入點不必改。
export { RECONNECT_WINDOW_SEC, WRAP_UP_SEC, leaseDeadlineMs, nextDeadline } from './deadlineLease.mjs';
