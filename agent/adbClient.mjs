/**
 * ADB 驅動(Redroid 容器 / 任何 adb 可連的 Android):實作 explorationRunner 用到的 AppiumClient 介面,
 * 讓同一個 AI 迴圈不用 Appium 也能跑。全部走 `adb`(execFile,不經主機 shell;每個指令都有逾時)。
 *
 * 和 Appium 版的差異(誠實標註):
 *  - 沒有多點觸控:combo 只做左手的移動、pinch 不支援(回報 unsupported)。
 *  - move / hold 用 `input swipe`(同一點或朝方向拖曳,持續 holdMs)近似。
 *  - 沒有 MediaProjection 錄影(mobile() 不支援 → runner 自動停用整場錄影,改用 screenrecord 即時畫面)。
 *  - type 只送 ASCII 可安全輸入的字元;其他字元回報 unsupported。
 */
import { execFile } from 'node:child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SAFE_PKG = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
const SAFE_TEXT = /^[A-Za-z0-9@._\-+ ]{1,200}$/;

function run(file, args, { timeoutMs = 20_000, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' }, (err, stdout, stderr) => {
      if (err && err.killed) return reject(new Error(`adb 逾時(${timeoutMs}ms):${args.slice(0, 4).join(' ')}`));
      if (err && !stdout?.length) return reject(new Error(`adb 失敗:${args.slice(0, 4).join(' ')}:${String(stderr || err.message).slice(0, 300)}`));
      resolve(binary ? stdout : stdout.toString('utf8'));
    });
  });
}

/** 方向 → 位移(截圖像素)。 */
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

export class AdbClient {
  #serial;
  #adb;
  #w = 0;
  #h = 0;
  /** 最近一次 ensureForeground 查到的狀態(4=前景、3=背景、1=未執行),對齊 Appium queryAppState。 */
  lastAppState = 4;

  constructor(serial, adbPath = 'adb') {
    this.#serial = serial;
    this.#adb = adbPath;
  }

  static async create(serial, { adbPath = 'adb' } = {}) {
    if (!/^[A-Za-z0-9.:_-]{1,64}$/.test(serial)) throw new Error(`adb serial 不合法:${serial}`);
    const c = new AdbClient(serial, adbPath);
    if (serial.includes(':')) await run(adbPath, ['connect', serial], { timeoutMs: 15_000 }).catch(() => '');
    const state = (await c.#raw(['get-state'], 10_000)).trim();
    if (state !== 'device') throw new Error(`adb 裝置狀態:${state || '無回應'}`);
    return c;
  }

  #raw(args, timeoutMs, binary = false) {
    return run(this.#adb, ['-s', this.#serial, ...args], { timeoutMs, binary });
  }
  async #input(args) {
    await this.#raw(['shell', 'input', ...args.map(String)], 30_000);
  }

  async takeScreenshot() {
    const png = await this.#raw(['exec-out', 'screencap', '-p'], 20_000, true);
    if (!png?.length) throw new Error('screencap 回傳空');
    return png.toString('base64');
  }

  async getScreenSize() {
    const out = await this.#raw(['shell', 'wm', 'size'], 10_000);
    const m = /Override size:\s*(\d+)x(\d+)/.exec(out) ?? /Physical size:\s*(\d+)x(\d+)/.exec(out);
    return m ? [Number(m[1]), Number(m[2])] : [1080, 1920];
  }

  /** adb 的 input 座標 = screencap 截圖座標(同一個旋轉後空間),不需換算。 */
  async setCoordinateSpace(w, h) {
    this.#w = w || 0;
    this.#h = h || 0;
    return { shot: [this.#w, this.#h], win: [this.#w, this.#h] };
  }

  deviceInfo() {
    return { model: 'Redroid (Android in container)', osVersion: undefined };
  }

  async act(cmd) {
    const r = Math.round;
    const W = this.#w || 1080, H = this.#h || 1920;
    switch (cmd.action) {
      case 'tap':
        return this.#input(['tap', r(cmd.x), r(cmd.y)]);
      case 'swipe':
        return this.#input(['swipe', r(cmd.x), r(cmd.y), r(cmd.x2 ?? cmd.x), r(cmd.y2 ?? cmd.y), r(cmd.durationMs ?? 500)]);
      case 'move':
      case 'kite': {
        const cx = Number.isFinite(cmd.x) ? r(cmd.x) : r(W * 0.495);
        const cy = Number.isFinite(cmd.y) ? r(cmd.y) : r(H * 0.821);
        const mag = r(Math.min(W, H) * 0.22);
        const [dx, dy] = Number.isFinite(cmd.x2) && Number.isFinite(cmd.y2) ? [r(cmd.x2) - cx, r(cmd.y2) - cy] : dirOffset(cmd.dir ?? cmd.direction, mag);
        const holdMs = Math.max(300, Math.min(8000, Number(cmd.holdMs) || 1500));
        return this.#input(['swipe', cx, cy, cx + dx, cy + dy, holdMs]);
      }
      case 'hold': {
        const x = Number.isFinite(cmd.x) ? r(cmd.x) : r(W / 2);
        const y = Number.isFinite(cmd.y) ? r(cmd.y) : r(H / 2);
        const ms = Math.max(100, Math.min(10_000, Number(cmd.holdMs) || 1000));
        return this.#input(['swipe', x, y, x, y, ms]);
      }
      case 'combo': {
        // 沒有多點觸控:只做左手(搖桿)部分,右手按鈕在動作後補點一次。
        const cx = Number.isFinite(cmd.x) ? r(cmd.x) : r(W * 0.18);
        const cy = Number.isFinite(cmd.y) ? r(cmd.y) : r(H * 0.72);
        const [dx, dy] = dirOffset(cmd.dir, r(Math.min(W, H) * 0.12));
        await this.#input(['swipe', cx, cy, cx + dx, cy + dy, Math.max(300, Math.min(8000, Number(cmd.holdMs) || 1500))]);
        if (Number.isFinite(cmd.tx) && Number.isFinite(cmd.ty)) await this.#input(['tap', r(cmd.tx), r(cmd.ty)]);
        return undefined;
      }
      case 'pinch':
        throw new Error('adb 不支援雙指縮放(pinch)');
      case 'type': {
        const text = String(cmd.text ?? '');
        if (!SAFE_TEXT.test(text)) throw new Error('adb input text 只支援英數與 @._-+ 空白');
        return this.#input(['text', text.replace(/ /g, '%s')]);
      }
      case 'back':
        return this.#input(['keyevent', 4]);
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

  async launchPackage(pkg) {
    if (!SAFE_PKG.test(pkg)) throw new Error(`package 名稱不合法:${pkg}`);
    const out = await this.#raw(['shell', 'cmd', 'package', 'resolve-activity', '--brief', '-c', 'android.intent.category.LAUNCHER', '-a', 'android.intent.action.MAIN', pkg], 15_000).catch(() => '');
    const act = out.trim().split('\n').pop()?.trim() ?? '';
    if (/^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/.test(act)) await this.#raw(['shell', 'am', 'start', '-n', act], 30_000);
    else await this.#raw(['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'], 30_000);
  }

  async restartApp(pkg) {
    if (!SAFE_PKG.test(pkg)) throw new Error(`package 名稱不合法:${pkg}`);
    await this.#raw(['shell', 'am', 'force-stop', pkg], 15_000).catch(() => '');
    await sleep(1000);
    await this.launchPackage(pkg);
  }

  /** 遊戲不在前景就拉回;回傳「原本是否在前景」。 */
  async ensureForeground(pkg) {
    if (!pkg || !SAFE_PKG.test(pkg)) return true;
    const pid = (await this.#raw(['shell', 'pidof', pkg], 10_000).catch(() => '')).trim();
    if (!pid) {
      this.lastAppState = 1;
    } else {
      const focus = await this.#raw(['shell', 'dumpsys', 'window'], 15_000).catch(() => '');
      const line = focus.split('\n').find((l) => /mCurrentFocus|mFocusedApp/.test(l)) ?? '';
      this.lastAppState = line.includes(pkg) ? 4 : 3;
    }
    if (this.lastAppState === 4) return true;
    await this.launchPackage(pkg).catch(() => {});
    return false;
  }

  async perfSample() {
    return null;
  }

  /** 對齊 Appium `mobile: shell`:命令交給裝置端 sh 執行(呼叫端負責不拼入未驗證輸入)。 */
  async shell(command, timeoutMs = 20_000) {
    return this.#raw(['shell', String(command)], timeoutMs);
  }

  async pullFile(path) {
    const buf = await this.#raw(['exec-out', 'cat', String(path)], 60_000, true);
    return buf.toString('base64');
  }

  /** Appium 的 mobile: 擴充(MediaProjection 錄影等)在 adb 下不存在。 */
  async mobile(name) {
    throw new Error(`adb 不支援 mobile: ${name}`);
  }

  async quit() {
    /* adb 不需要關 session */
  }
}
