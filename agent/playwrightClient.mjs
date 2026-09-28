/**
 * Playwright 瀏覽器 client(Web 後端用)—— 介面對齊 appiumClient.mjs 的 AppiumClient,
 * 讓 web runner 能沿用與 Device Farm runner 相同的「screenshot → VLM decide → act」迴圈。
 *
 * 對應關係:
 *   takeScreenshot()  → page.screenshot({ type:'png' })(視埠截圖,像素 == CSS 視埠像素)
 *   act(tap)          → page.mouse.click(x, y)
 *   act(swipe)        → mouse.move → down → move → up(拖曳/捲動)
 *   act(type)         → keyboard.type(帶 Enter 送出)
 *   act(back)         → page.goBack()
 *   act(launch/goto)  → page.goto(url)
 *   getScreenSize()   → 視埠寬高
 *
 * 座標空間:web 的截圖像素 == 視埠 CSS 像素 == mouse.click 座標,三者一致,
 * 故 setCoordinateSpace/#toWindow 為恆等(保留同介面以相容 runner 呼叫)。
 */
import { chromium } from 'playwright';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
        if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 40) {
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

  async quit() {
    try { await this.#context?.close(); } catch { /* ignore */ }
    try { await this.#browser?.close(); } catch { /* ignore */ }
  }
}
