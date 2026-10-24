/**
 * Windows 驅動:實作 explorationRunner 用到的 AppiumClient 介面,底層是 winHost.ps1 + WinHelper.cs
 * (SendInput 送滑鼠 / 鍵盤、GDI 截主螢幕)。runner、helper、遊戲都在同一個互動式桌面 session 裡,
 * 截圖直接在本機取得、本機呼叫 Bedrock。
 *
 * 限制(誠實標註):
 *  - 單一滑鼠指標:combo(雙手同時)只做移動部分,pinch 不支援。
 *  - 部分遊戲(Raw Input / 反作弊)會忽略 SendInput 合成事件。
 *  - 截圖用 GDI;獨佔全螢幕的 DirectX 遊戲可能截到黑畫面(視窗 / 無邊框視窗正常)。
 */
import { spawn } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HERE = dirname(fileURLToPath(import.meta.url));
// 標準按鍵名(與 keyNames.mjs / 後端 controlSchemes.ts 一致)→ Windows 虛擬鍵碼。
// 刻意自帶(不 import keyNames.mjs):Windows 主機的套件是另外打包部署的。
const VK = {
  esc: 0x1b, escape: 0x1b, enter: 0x0d, tab: 0x09, backspace: 0x08, space: 0x20,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  shift: 0x10, ctrl: 0x11, alt: 0x12,
  pageup: 0x21, pagedown: 0x22, end: 0x23, home: 0x24, delete: 0x2e,
  ...Object.fromEntries('abcdefghijklmnopqrstuvwxyz'.split('').map((c, i) => [c, 0x41 + i])),
  ...Object.fromEntries('0123456789'.split('').map((d, i) => [d, 0x30 + i])),
};
const VK_ALIAS = { arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right', return: 'enter', control: 'ctrl', pgup: 'pageup', pgdn: 'pagedown', del: 'delete' };
function vkOf(raw) {
  const s = String(raw ?? '').trim().toLowerCase().replace(/^key([a-z])$/, '$1').replace(/^digit([0-9])$/, '$1');
  return VK[VK_ALIAS[s] ?? s];
}

function dirOffset(dir, mag) {
  const d = String(dir ?? 'up').toLowerCase();
  let dx = 0, dy = 0;
  if (d.includes('up')) dy -= mag;
  if (d.includes('down')) dy += mag;
  if (d.includes('left')) dx -= mag;
  if (d.includes('right')) dx += mag;
  if (!dx && !dy) dy = -mag;
  return [dx, dy];
}

/**
 * 音量超過這個峰值就算「有聲音」。
 *
 * 不用 0:安靜時的讀值不保證是精確的 0(混音器底噪、其他程序的極小輸出)。
 * 本機實測靜音是 0.00000、播放 Windows 內建 wav 是 0.13 —— 中間差兩個數量級,
 * 所以門檻取在很低的位置就夠,不必調參。
 */
export const AUDIO_ON_THRESHOLD = 0.002;

/**
 * 解析 WinHelper 的 AudioSample 回傳(JSON 字串)。抽成純函式才驗得到各種壞輸入。
 *
 * @returns {{ok:boolean, peak:number, avg:number, samples:number, device:string, why:string, heard:boolean}|null}
 *   null = 連回應都沒有(指令失敗 / 逾時)
 */
export function parseAudioSample(raw) {
  if (!raw) return null;
  let o;
  try { o = JSON.parse(String(raw)); } catch { return null; }
  // Array.isArray 不能省:typeof [] === 'object',陣列會一路通過下面的欄位讀取,
  // 回一個每個欄位都是 0 的假快照 —— 那會被當成「量到了而且是靜音」。
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const peak = Number(o.peak);
  const avg = Number(o.avg);
  return {
    ok: o.ok === true,
    peak: Number.isFinite(peak) ? peak : 0,
    avg: Number.isFinite(avg) ? avg : 0,
    samples: Number.isFinite(Number(o.samples)) ? Number(o.samples) : 0,
    device: String(o.device ?? ''),
    why: String(o.why ?? ''),
    heard: o.ok === true && Number.isFinite(peak) && peak > AUDIO_ON_THRESHOLD,
  };
}

/**
 * 一次音量取樣 → 與 Android 同一個 schema 的音效快照。
 *
 * 為什麼硬要對齊 Android 的形狀:前端的「音效」分頁(DeviceLogsPanel 的 AudioSnap)
 * 已經會讀 `devlogs/audio/*.json`、會依 `players[].state === 'started'` 亮「♪ 播放中」、
 * 會把 `playbackRaw` 收在可展開的原始資料裡。沿用同一個 schema 就不必為 Windows 再做
 * 一套 UI;代價是 players 這個欄位在 Windows 上只是「有/沒有在出聲」的一筆,
 * 不像 Android 能列出每個播放器。實際的數字放在 peak / avg,並原樣寫進 playbackRaw。
 *
 * @param {number} step
 * @param {ReturnType<typeof parseAudioSample>} s
 */
export function audioSnapshot(step, s, at = Date.now()) {
  if (!s) {
    return { step, at, players: [], outputs: [], playbackRaw: 'audio sample failed (no response)' };
  }
  const raw = s.ok
    ? `peak=${s.peak.toFixed(5)} avg=${s.avg.toFixed(5)} samples=${s.samples} device=${s.device}`
    : `audio unavailable: ${s.why || 'unknown'}`;
  return {
    step,
    at,
    // 有在出聲才給一筆播放器,這樣前端的「♪ 播放中」就只在真的有聲音時亮。
    players: s.heard ? [{ piid: 0, type: 'WASAPI', usage: 'OUTPUT', state: 'started' }] : [],
    outputs: s.ok ? [{ thread: 'default', standby: !s.heard, active: s.heard ? 1 : 0 }] : [],
    peak: s.peak,
    avg: s.avg,
    samples: s.samples,
    ok: s.ok,
    playbackRaw: raw,
  };
}

/**
 * 要不要把聲音的狀況講給模型聽,以及講什麼。
 *
 * 為什麼要進 prompt(Android 那條刻意沒做):音效本身就是被測的東西。「按了技能有沒有
 * 音效」「BGM 有沒有在放」這種檢查項,模型光看畫面得不到答案,只能猜 —— 而猜出來的
 * 「有聽到音效」比不回答更糟。
 *
 * 靜音也要講:「操作了卻沒有聲音」正是要抓的缺陷。
 * 讀不到音量時要明說讀不到,不要讓模型把它當成「靜音」。
 */
export function soundNote(s) {
  if (!s) return '';
  if (!s.ok) return `\n【系統|聲音】這台主機讀不到輸出音量(${s.why || '原因不明'}),所以聲音的有無無法判斷 —— 不要在 obs 裡聲稱聽到或沒聽到音效。`;
  return s.heard
    ? `\n【系統|聲音】主機此刻有聲音輸出(峰值 ${s.peak.toFixed(3)})。`
    : '\n【系統|聲音】主機此刻沒有聲音輸出(靜音)。如果這一步本來應該有音效,這就是一個缺陷。';
}

/**
 * 解析音訊鏈自我檢查的結果。
 *
 * 為什麼需要這個檢查:讀到「有輸出端點」不等於「遊戲的聲音會進到那個端點」。
 * 少了它,一整場 peak=0 有兩種完全不同的解釋 —— 遊戲真的沒出聲(是個發現),
 * 或者音訊鏈根本不通(我們的量測沒有意義)。分不出來的量測不該拿去寫報告。
 *
 * @returns {{chainOk:boolean, peak:number, quiet:number, why:string}}
 */
export function parseAudioSelfTest(raw) {
  if (!raw) return { chainOk: false, peak: 0, quiet: 0, why: 'no-response' };
  let o;
  try { o = JSON.parse(String(raw)); } catch { return { chainOk: false, peak: 0, quiet: 0, why: 'bad-json' }; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { chainOk: false, peak: 0, quiet: 0, why: 'bad-json' };
  if (o.error) return { chainOk: false, peak: 0, quiet: 0, why: String(o.error).slice(0, 160) };
  const during = parseAudioSample(JSON.stringify(o.during ?? null));
  const after = parseAudioSample(JSON.stringify(o.after ?? null));
  if (!during) return { chainOk: false, peak: 0, quiet: 0, why: 'no-measurement' };
  if (!during.ok) return { chainOk: false, peak: 0, quiet: 0, why: during.why || 'sample-failed' };
  return {
    chainOk: during.heard,
    peak: during.peak,
    quiet: after?.peak ?? 0,
    why: during.heard ? '' : 'test-tone-not-heard',
  };
}

/** 不該被當成「遊戲」的系統視窗(學習前景程序時要排除)。 */
const SYSTEM_PROCS = new Set([
  'explorer', 'dwm', 'taskmgr', 'powershell', 'pwsh', 'cmd', 'conhost',
  'applicationframehost', 'searchapp', 'shellexperiencehost', 'textinputhost',
  'node', 'windowsterminal', 'logonui', 'csrss', 'winlogon', 'rdpclip', 'mstsc',
]);

/** 這個前景程序名稱可以被當成「遊戲」嗎(空值與系統視窗都不行)。 */
export function isGameProc(name) {
  const n = String(name ?? '').trim().toLowerCase();
  return !!n && !SYSTEM_PROCS.has(n);
}

/**
 * 「遊戲還好嗎」的決策,抽成純函式才驗得到。
 *
 * 三個輸入都是從 winHost 問來的事實:
 *   alive  追蹤名單裡還活著的程序名(空 = 全部都不在了)
 *   fg     目前前景視窗所屬的程序名(空 = 取不到)
 *   tracked 目前追蹤名單
 *
 * 回傳要做什麼。state 對齊 Appium 的 app state 語意:1 = 沒在跑、3 = 在背景、4 = 在前景。
 */
export function foregroundDecision({ alive, fg, tracked }) {
  if (!alive) return { state: 1, action: 'relaunch', foreground: false };
  const name = String(fg ?? '').trim().toLowerCase();
  if (name && tracked.has(name)) return { state: 4, action: 'none', foreground: true };
  // 前景是個陌生的非系統程序:啟動器剛把棒子交出去。把它學進來,**不要**搶焦點 ——
  // 搶回啟動器等於把剛開起來的遊戲壓到背景。
  if (isGameProc(name)) return { state: 4, action: 'adopt', adopt: name, foreground: true };
  // 前景是系統視窗或取不到:把焦點拉回還活著的那個。
  return { state: 3, action: 'focus', focus: alive, foreground: false };
}

export class WindowsClient {
  #proc;
  #pending = new Map();
  #seq = 0;
  #w = 0;
  #h = 0;
  lastAppState = 4;
  /**
   * 這次測試「算是遊戲」的程序名稱(不含 .exe)。
   *
   * 為什麼是一個集合而不是單一名稱:啟動器型的遊戲(例如新楓之谷走
   * Gamania Games Manager → GGMWebStart.exe → 更新 → 真正的遊戲)真正在跑的是
   * **另一個程序**,我們啟動的那個 exe 交棒後往往就結束了。
   *
   * 只盯著啟動的 exe 會得到兩個都錯的結論:
   *   - 「程序不在了」→ 判定當掉 → 在遊戲上面一直重開啟動器
   *   - 「前景不是它」→ 判定失焦 → 把焦點從遊戲搶走
   * 兩個都會讓測試看起來像遊戲壞了,其實是我們自己在搞。
   */
  #appNames = new Set();

  static async create({ helperDir = HERE } = {}) {
    const c = new WindowsClient();
    await c.#start(helperDir);
    return c;
  }

  #start(helperDir) {
    return new Promise((resolve, reject) => {
      const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(helperDir, 'winHost.ps1')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      this.#proc = p;
      const rl = createInterface({ input: p.stdout });
      let ready = false;
      rl.on('line', (line) => {
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        if (!ready && msg.id === 0) { ready = true; this.#w = msg.result?.width ?? 0; this.#h = msg.result?.height ?? 0; resolve(); return; }
        const cb = this.#pending.get(msg.id);
        if (!cb) return;
        this.#pending.delete(msg.id);
        if (msg.ok) cb.resolve(msg.result); else cb.reject(new Error(`winHost: ${msg.error}`));
      });
      let err = '';
      p.stderr.on('data', (d) => { err += d.toString(); if (err.length > 4000) err = err.slice(-4000); });
      p.on('exit', (code) => {
        for (const cb of this.#pending.values()) cb.reject(new Error(`winHost 結束(${code}):${err.slice(-500)}`));
        this.#pending.clear();
        if (!ready) reject(new Error(`winHost 啟動失敗(${code}):${err.slice(-800)}`));
      });
      setTimeout(() => { if (!ready) reject(new Error(`winHost 啟動逾時:${err.slice(-800)}`)); }, 60_000);
    });
  }

  #call(cmd, args = {}, timeoutMs = 30_000) {
    const id = ++this.#seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.#pending.delete(id); reject(new Error(`winHost ${cmd} 逾時`)); }, timeoutMs);
      this.#pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.#proc.stdin.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
    });
  }

  /** exe 完整路徑 → 程序名稱(不含 .exe)。 */
  static #name(exe) {
    return basename(String(exe || '')).replace(/\.exe$/i, '');
  }

  async takeScreenshot() {
    const b64 = await this.#call('shot', {}, 30_000);
    if (!b64) throw new Error('截圖回傳空');
    return b64;
  }
  async getScreenSize() {
    const s = await this.#call('size');
    return [s.width, s.height];
  }
  async setCoordinateSpace(w, h) {
    this.#w = w || this.#w;
    this.#h = h || this.#h;
    return { shot: [this.#w, this.#h], win: [this.#w, this.#h] };
  }
  deviceInfo() {
    return { model: `Windows ${this.#w}x${this.#h}`, osVersion: undefined };
  }

  async act(cmd) {
    const r = Math.round;
    const W = this.#w || 1920, H = this.#h || 1080;
    switch (cmd.action) {
      case 'tap':
        return this.#call('click', { x: r(cmd.x), y: r(cmd.y) });
      case 'swipe':
        return this.#call('drag', { x: r(cmd.x), y: r(cmd.y), x2: r(cmd.x2 ?? cmd.x), y2: r(cmd.y2 ?? cmd.y), ms: r(cmd.durationMs ?? 500) }, 20_000);
      case 'move':
      case 'kite':
      case 'combo': {
        const cx = Number.isFinite(cmd.x) ? r(cmd.x) : r(W * 0.495);
        const cy = Number.isFinite(cmd.y) ? r(cmd.y) : r(H * 0.821);
        const [dx, dy] = Number.isFinite(cmd.x2) && Number.isFinite(cmd.y2) ? [r(cmd.x2) - cx, r(cmd.y2) - cy] : dirOffset(cmd.dir ?? cmd.direction, r(Math.min(W, H) * 0.22));
        const ms = Math.max(300, Math.min(8000, Number(cmd.holdMs) || 1500));
        await this.#call('drag', { x: cx, y: cy, x2: cx + dx, y2: cy + dy, ms }, ms + 10_000);
        if (cmd.action === 'combo' && Number.isFinite(cmd.tx) && Number.isFinite(cmd.ty)) await this.#call('click', { x: r(cmd.tx), y: r(cmd.ty) });
        return undefined;
      }
      case 'hold': {
        const x = Number.isFinite(cmd.x) ? r(cmd.x) : r(W / 2);
        const y = Number.isFinite(cmd.y) ? r(cmd.y) : r(H / 2);
        const ms = Math.max(100, Math.min(10_000, Number(cmd.holdMs) || 1000));
        return this.#call('drag', { x, y, x2: x, y2: y, ms }, ms + 10_000);
      }
      case 'pinch':
        throw new Error('Windows 單一滑鼠不支援雙指縮放(pinch)');
      case 'type':
        return this.#call('type', { text: String(cmd.text ?? '').slice(0, 500) }, 60_000);
      case 'key': {
        const vk = vkOf(cmd.key);
        if (!vk) throw new Error(`不支援的按鍵:${cmd.key}`);
        return this.#call('key', { vk });
      }
      case 'back':
        return this.#call('key', { vk: VK.esc });
      case 'wait':
        return sleep((Number(cmd.duration) || 3) * 1000);
      case 'launch':
        if (cmd.app) await this.launchPackage(cmd.app);
        return undefined;
      case 'done':
        return undefined;
      default:
        throw new Error(`不支援的動作: ${cmd.action}`);
    }
  }

  /** 目前前景的程序名稱(小寫);取不到或是系統視窗回空字串。 */
  async #foregroundName() {
    const raw = await this.#call('fgname', {}, 10_000).catch(() => '');
    return String(raw ?? '').trim().toLowerCase();
  }

  /**
   * 學習「遊戲實際上是哪個程序」:啟動後盯一下前景,把非系統的前景程序記起來。
   * 啟動器把棒子交給別的程序時,這一步讓我們追蹤得到真正的遊戲。
   */
  async #learnForeground(waitMs = 12_000) {
    const until = Date.now() + waitMs;
    while (Date.now() < until) {
      const n = await this.#foregroundName();
      if (!isGameProc(n)) { await sleep(1500); continue; }
      if (!this.#appNames.has(n)) {
        this.#appNames.add(n);
        console.log(`[windows] 前景程序 ${n} 納入追蹤(目前:${[...this.#appNames].join(', ')})`);
        return n;
      }
      return n; // 已經在追蹤名單裡,不必再等
    }
    return '';
  }

  /** 追蹤名單裡還有活著的程序嗎。 */
  async #anyRunning() {
    for (const name of this.#appNames) {
      if (await this.#call('running', { name }, 10_000).catch(() => false)) return name;
    }
    return '';
  }

  async launchPackage(exe) {
    const name = WindowsClient.#name(exe).toLowerCase();
    this.#appNames.add(name);
    await this.#call('launch', { exe: String(exe) });
    await sleep(3000);
    await this.#call('focus', { name }).catch(() => false);
    // 啟動器可能馬上把前景交給別人(更新程式 / 真正的遊戲),所以這裡學一下。
    await this.#learnForeground(12_000).catch(() => '');
  }
  async restartApp(exe) {
    // 整條鏈都要收掉:只殺啟動器的話,更新程式或遊戲本體會留在那裡,
    // 重開之後畫面上會有兩份,AI 更難判斷。
    for (const name of this.#appNames) {
      await this.#call('kill', { name }).catch(() => false);
    }
    this.#appNames.clear();
    await sleep(1500);
    await this.launchPackage(exe);
  }
  async ensureForeground(exe) {
    if (!exe) return true;
    // 三個事實問完,交給 foregroundDecision 判斷(決策邏輯是純函式,有單獨的測試)。
    const alive = await this.#anyRunning();
    const fg = await this.#foregroundName();
    const d = foregroundDecision({ alive, fg, tracked: this.#appNames });
    this.lastAppState = d.state;
    if (d.action === 'relaunch') { await this.launchPackage(exe).catch(() => {}); return false; }
    if (d.action === 'adopt') {
      this.#appNames.add(d.adopt);
      console.log(`[windows] 前景換成 ${d.adopt},視為遊戲的一部分並納入追蹤`);
    } else if (d.action === 'focus') {
      await this.#call('focus', { name: d.focus }).catch(() => false);
    }
    return d.foreground;
  }
  async perfSample() {
    return null;
  }

  /**
   * 預設輸出端點的音量峰值(0~1)。回 null = 這台機器問不到音量。
   *
   * 為什麼是「取樣一段時間的峰值」而不是讀一次:peak 是瞬時值,而音效的波形會經過零點,
   * 剛好讀在那裡就會把有聲音判成靜音。預設 250ms 夠蓋過一般音效的一個週期。
   *
   * 為什麼不是用 ffmpeg 錄一段來分析:ffmpeg 在 Windows 的音訊輸入走 dshow,不暴露
   * WASAPI loopback,要錄系統播放出去的聲音得先裝虛擬音訊驅動 —— 那是核心模式驅動,
   * 在用完就消失的 stream session 裡裝不了(見 windowsCapture.mjs 的註解)。
   */
  async audioSample(ms = 250) {
    const raw = await this.#call('audio', { ms: Math.max(20, Math.min(4000, Number(ms) || 250)) }, 15_000)
      .catch(() => '');
    return parseAudioSample(raw);
  }

  /**
   * 音訊鏈自我檢查:主機自己播一段正弦波,看音量表會不會動。
   * 只在遊戲啟動前跑 —— 不然這段測試音會疊在遊戲的聲音上。
   */
  async audioSelfTest() {
    const raw = await this.#call('audiotest', {}, 30_000).catch(() => '');
    return parseAudioSelfTest(raw);
  }

  /**
   * 音訊診斷:列出所有輸出端點與程序層級 session,安靜時與播測試音時各量一輪。
   * 回原始 JSON 字串(這份資料是給人看的,不需要解析成決策)。
   *
   * 只在自我檢查失敗時跑。目的是「一次把答案拿齊」—— 不然每試一個猜測就要再開一個
   * GPU session。
   */
  async audioDiagnose() {
    const raw = await this.#call('audiodiag', {}, 60_000).catch((e) => `{"error":${JSON.stringify(String(e?.message || e))}}`);
    return String(raw || '{"error":"no-response"}');
  }
  async shell() {
    throw new Error('Windows 驅動沒有 Android shell');
  }
  async pullFile() {
    throw new Error('Windows 驅動不支援 pullFile');
  }
  async mobile(name) {
    throw new Error(`Windows 驅動不支援 mobile: ${name}`);
  }
  async quit() {
    try { this.#proc?.stdin.write(`${JSON.stringify({ id: ++this.#seq, cmd: 'quit' })}\n`); } catch { /* ignore */ }
    await sleep(300);
    this.#proc?.kill();
  }
}
