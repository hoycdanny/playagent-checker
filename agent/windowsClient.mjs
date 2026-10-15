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

export class WindowsClient {
  #proc;
  #pending = new Map();
  #seq = 0;
  #w = 0;
  #h = 0;
  lastAppState = 4;

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

  async launchPackage(exe) {
    await this.#call('launch', { exe: String(exe) });
    await sleep(3000);
    await this.#call('focus', { name: WindowsClient.#name(exe) }).catch(() => false);
  }
  async restartApp(exe) {
    await this.#call('kill', { name: WindowsClient.#name(exe) }).catch(() => false);
    await sleep(1500);
    await this.launchPackage(exe);
  }
  async ensureForeground(exe) {
    if (!exe) return true;
    const name = WindowsClient.#name(exe);
    const running = await this.#call('running', { name }).catch(() => true);
    if (!running) { this.lastAppState = 1; await this.launchPackage(exe).catch(() => {}); return false; }
    const fg = await this.#call('foreground', { name }).catch(() => true);
    this.lastAppState = fg ? 4 : 3;
    if (!fg) await this.#call('focus', { name }).catch(() => false);
    return fg;
  }
  async perfSample() {
    return null;
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
