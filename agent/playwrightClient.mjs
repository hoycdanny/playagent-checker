/**
 * Playwright 瀏覽器 client(Web 後端用)—— 介面對齊 appiumClient.mjs 的 AppiumClient,
 * 讓 web runner 能沿用與 Device Farm runner 相同的「screenshot → VLM decide → act」迴圈。
 *
 * 對應關係:
 *   takeScreenshot()  → page.screenshot({ type:'png' })(視埠截圖,像素 == CSS 視埠像素)
 *   act(tap)          → page.mouse.click(x, y)
 *   act(swipe)        → mouse.move → down → move → up(拖曳/捲動)
 *   act(type)         → keyboard.type(帶 Enter 送出)
 *   act(key)          → keyboard.down → 按住 KEY_HOLD_MS → up(方向鍵 / WASD / Enter…;只開放遊戲常用鍵,可 repeat 連按)
 *   act(back)         → page.goBack()
 *   act(launch/goto)  → page.goto(url)
 *   getScreenSize()   → 視埠寬高
 *
 * 座標空間:web 的截圖像素 == 視埠 CSS 像素 == mouse.click 座標,三者一致,
 * 故 setCoordinateSpace/#toWindow 為恆等(保留同介面以相容 runner 呼叫)。
 */
import { chromium } from 'playwright';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 按鍵按住時間(毫秒)與連按間隔。要大於雲端容器裡遊戲的一幀(低 fps 時 100–200 ms),
 * 否則以「每幀讀一次按鍵狀態」的引擎(RPG Maker、許多 canvas 遊戲)會漏掉按鍵。
 * 可用 PA_KEY_HOLD_MS 調整;模型也可在單步給 holdMs(長按衝刺等)。
 */
const KEY_HOLD_MS = Math.max(50, Math.min(1000, Number(process.env.PA_KEY_HOLD_MS) || 250));
const KEY_GAP_MS = 150;

/**
 * 模型可用的按鍵名 → Playwright 的鍵名。
 * 只開放遊戲常用的鍵,避免模型亂送組合鍵(如 F5 重整、Ctrl+W 關頁)把測試環境弄壞。
 */
const KEYS = {
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  enter: 'Enter', escape: 'Escape', esc: 'Escape', space: 'Space', tab: 'Tab',
  backspace: 'Backspace', delete: 'Delete', home: 'Home', end: 'End',
  pageup: 'PageUp', pagedown: 'PageDown',
  w: 'KeyW', a: 'KeyA', s: 'KeyS', d: 'KeyD',
  q: 'KeyQ', e: 'KeyE', r: 'KeyR', f: 'KeyF', z: 'KeyZ', x: 'KeyX', c: 'KeyC',
  '1': 'Digit1', '2': 'Digit2', '3': 'Digit3', '4': 'Digit4', '5': 'Digit5',
};

export class PlaywrightClient {
  #browser;
  #context;
  #page;
  #w;
  #h;

  constructor(browser, context, page, viewport) {
    this.#browser = browser;
    this.#context = context;
    this.#page = page;
    this.#w = viewport.width;
    this.#h = viewport.height;
  }

  /**
   * 啟動 headless Chromium 並開頁。
   * @param options { width, height, url, userAgent, mobile }
   */
  static async create(options = {}) {
    const width = options.width ?? 1280;
    const height = options.height ?? 800;
    const browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', // 容器 /dev/shm 常太小,避免 Chromium 崩潰
        '--disable-gpu',
        // 即時串流:headless 分頁常被視為「背景」而停止 compositor 重繪,導致 CDP screencast
        // 只送第一幀就停。關閉背景節流,讓畫面持續產幀(遊戲動畫才會串流出來)。
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
      ],
    });
    const context = await browser.newContext({
      viewport: { width, height },
      ...(options.userAgent ? { userAgent: options.userAgent } : {}),
      ...(options.mobile ? { isMobile: true, hasTouch: true } : {}),
      ignoreHTTPSErrors: true,
      locale: 'zh-TW',
    });
    const page = await context.newPage();
    if (options.url) {
      // domcontentloaded 即返回(遊戲/SPA 常長時間 networkidle 不會觸發);再給緩衝載入。
      await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
      await sleep(2500);
    }
    return new PlaywrightClient(browser, context, page, { width, height });
  }

  /** 目前頁面 URL(供 trace/報告呈現)。 */
  currentUrl() {
    try { return this.#page.url(); } catch { return ''; }
  }

  /** 截圖 → base64 PNG(視埠)。 */
  async takeScreenshot() {
    const buf = await this.#page.screenshot({ type: 'png' });
    return Buffer.from(buf).toString('base64');
  }

  /** 視埠尺寸 [w,h]。 */
  async getScreenSize() {
    return [this.#w, this.#h];
  }

  /** web 截圖像素 == 點擊座標,不需換算;保留同介面。 */
  async setCoordinateSpace(shotW, shotH) {
    return { shot: [shotW, shotH], win: [this.#w, this.#h] };
  }

  /**
   * 執行 VLM 決策動作。cmd 形態與 Device Farm runner 一致:
   * { action:'tap|swipe|type|back|wait|launch|done', x,y,x2,y2,text,url }
   * 座標為「裝置/視埠像素」(runner 已從 smart-resize 空間換算回視埠像素)。
   */
  async act(cmd) {
    switch (cmd.action) {
      case 'tap': {
        await this.#page.mouse.click(Math.round(cmd.x), Math.round(cmd.y));
        break;
      }
      case 'swipe': {
        // 拖曳/捲動:按住起點移到終點放開。網頁捲動用滑鼠拖曳未必生效,
        // 故對「近似垂直的長距滑動」改用 wheel 捲動(更符合網頁語意)。
        const x1 = Math.round(cmd.x), y1 = Math.round(cmd.y);
        const x2 = Math.round(cmd.x2 ?? cmd.x), y2 = Math.round(cmd.y2 ?? cmd.y);
        const dx = x2 - x1, dy = y2 - y1;
        if (cmd.drag) {
          // 測試人員指定的拖曳:一定是真的按住拖(不改成 wheel),並照實際拖的時間移動。
          const dur = Math.max(100, Math.min(5000, Number(cmd.durationMs) || 600));
          const steps = Math.max(10, Math.min(120, Math.round(dur / 16)));
          const wait = (ms) => new Promise((r) => setTimeout(r, ms));
          await this.#page.mouse.move(x1, y1);
          await this.#page.mouse.down();
          if (cmd.pressMs > 0) await wait(Math.min(2000, cmd.pressMs));
          // 依時鐘排程每一小步(固定 sleep 會累積計時誤差,實測 700ms 的拖曳變成 1.1 秒)。
          const tMove = Date.now();
          for (let k = 1; k <= steps; k++) {
            await this.#page.mouse.move(x1 + (dx * k) / steps, y1 + (dy * k) / steps);
            const lag = tMove + (dur * k) / steps - Date.now();
            if (lag > 0) await wait(lag);
          }
          if (cmd.endHoldMs > 0) await wait(Math.min(2000, cmd.endHoldMs));
          await this.#page.mouse.up();
        } else if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 40) {
          // 手指往上滑 = 內容往上 = 頁面往下捲(wheel deltaY 正值)。方向與手指相反。
          await this.#page.mouse.move(x1, y1);
          await this.#page.mouse.wheel(0, -dy);
        } else {
          await this.#page.mouse.move(x1, y1);
          await this.#page.mouse.down();
          await this.#page.mouse.move(x2, y2, { steps: 10 });
          await this.#page.mouse.up();
        }
        break;
      }
      case 'type': {
        // 先確保有 focus(多數情況上一步 tap 已 focus 輸入框);輸入文字,結尾送 Enter。
        await this.#page.keyboard.type(String(cmd.text ?? ''), { delay: 20 });
        await this.#page.keyboard.press('Enter').catch(() => {});
        break;
      }
      case 'key': {
        // 鍵盤按鍵:很多網頁遊戲(2048、射擊、平台跳躍)只監聽 keydown,滑鼠與拖曳完全沒反應。
        // 可按 n 次(repeat),用於連續移動。
        //
        // 必須「按住一小段時間」再放開,不能用 keyboard.press():press 會在同一瞬間送出
        // keydown + keyup。RPG Maker 等引擎是「每一幀讀一次按鍵狀態」,雲端容器沒有 GPU、
        // 遊戲只跑 ~5–10 fps(一幀 100–200 ms),按下與放開都落在兩幀之間 → 遊戲完全沒看到。
        // 實測(job-mv97uocw-hdzi6d 的 Silver Thread,遊戲迴圈壓到 ~7 fps):
        //   press() 連按 5 次標題畫面都沒反應;按住 250 ms 再放,第 1 次就進入遊戲。
        // 人用實體鍵盤時自然會按住約 100 ms,所以人按 Enter 可以玩、AI 按卻「沒反應」。
        const name = KEYS[String(cmd.key ?? '').toLowerCase()];
        if (!name) throw new Error(`不支援的按鍵:${cmd.key}`);
        const times = Math.max(1, Math.min(20, Number(cmd.repeat) || 1));
        const holdMs = Number.isFinite(Number(cmd.holdMs)) && Number(cmd.holdMs) > 0
          ? Math.max(50, Math.min(3000, Math.round(Number(cmd.holdMs))))
          : KEY_HOLD_MS;
        for (let i = 0; i < times; i++) {
          await this.#page.keyboard.down(name);
          await sleep(holdMs);
          await this.#page.keyboard.up(name);
          if (i < times - 1) await sleep(KEY_GAP_MS);
        }
        break;
      }
      case 'back': {
        await this.#page.goBack({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
        break;
      }
      case 'launch': {
        if (cmd.url || cmd.app) {
          await this.#page.goto(cmd.url ?? cmd.app, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
        }
        break;
      }
      case 'wait': {
        await sleep(((cmd.duration ?? 3)) * 1000);
        break;
      }
      case 'done':
        break;
      default:
        throw new Error(`不支援的動作: ${cmd.action}`);
    }
  }

  /**
   * 啟動 CDP screencast:瀏覽器每渲染一幀就回呼一張 JPEG(base64)。用於「即時畫面」串流。
   * 每幀都要 ack(screencastFrameAck)否則 Chromium 會停止送幀。
   * @param onFrame (b64Jpeg:string) => void  每幀回呼(呼叫端負責節流/上傳,勿阻塞)
   * @param options { everyNthFrame, quality, maxWidth, maxHeight }
   * @returns stop() 停止 screencast
   */
  async startScreencast(onFrame, options = {}) {
    const quality = options.quality ?? 55;
    const everyNth = Math.max(1, options.everyNthFrame ?? 1);
    let cdp;
    try {
      cdp = await this.#context.newCDPSession(this.#page);
    } catch (err) {
      // CDP 不可用(理論上 Chromium 一定有);回傳 no-op 停止函式,不影響主流程。
      return async () => {};
    }
    // 強制分頁為「active」生命週期,避免 headless 被當背景而停止重繪(screencast 只送一幀就停)。
    try { await cdp.send('Page.enable'); } catch { /* ignore */ }
    try { await cdp.send('Page.setWebLifecycleState', { state: 'active' }); } catch { /* ignore */ }
    let frameNo = 0;
    cdp.on('Page.screencastFrame', async (evt) => {
      // 先 ack 讓下一幀能來(即使我們這幀略過)。
      try { await cdp.send('Page.screencastFrameAck', { sessionId: evt.sessionId }); } catch { /* ignore */ }
      frameNo++;
      if (frameNo % everyNth !== 0) return; // 抽幀降頻
      try { onFrame(evt.data); } catch { /* 呼叫端錯誤不影響串流 */ }
    });
    try {
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality,
        ...(options.maxWidth ? { maxWidth: options.maxWidth } : {}),
        ...(options.maxHeight ? { maxHeight: options.maxHeight } : {}),
        everyNthFrame: 1,
      });
    } catch {
      try { await cdp.detach(); } catch { /* ignore */ }
      return async () => {};
    }
    return async () => {
      try { await cdp.send('Page.stopScreencast'); } catch { /* ignore */ }
      try { await cdp.detach(); } catch { /* ignore */ }
    };
  }

  async quit() {
    try { await this.#context?.close(); } catch { /* ignore */ }
    try { await this.#browser?.close(); } catch { /* ignore */ }
  }
}
