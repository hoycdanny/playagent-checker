/**
 * Appium 裝置 client(移植自 game-ai-qa src/device/appiumClient.ts,改 Node ESM)。
 *
 * 跑在 Fargate task 容器內,透過 webdriverio 連 Device Farm 的 remoteDriverEndpoint,
 * 驅動真實 Android/iOS 裝置。提供與 emulator runner 對等的能力:
 *   - takeScreenshot() → base64 PNG(給 VLM 看)
 *   - act(cmd) → tap/swipe/type/back/launch(VLM 決策的執行)
 *   - getScreenSize() → [w,h]
 * 內建:tap 三層 fallback、presigned endpoint 過期自動重連、60s idle keep-alive。
 */
import { attach, remote } from 'webdriverio';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connectionOptions(url) {
  const parsed = new URL(url);
  return {
    path: parsed.pathname + parsed.search,
    hostname: parsed.hostname,
    port: Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80),
    protocol: parsed.protocol === 'https:' ? 'https' : 'http',
    logLevel: 'silent',
    connectionRetryTimeout: 180_000,
    connectionRetryCount: 5,
  };
}

function errorDetail(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
function isInvalidPresignedUrl(error) {
  return /invalid pre-signed url/i.test(errorDetail(error));
}

export class AppiumClient {
  #driver;
  #url;
  #capabilities;
  #refreshEndpoint;
  #keepAliveTimer = null;
  #refreshPromise = null;
  #endpointGeneration = 0;
  // 座標空間換算:VLM 給的是「截圖像素座標」;Appium W3C pointer 動作吃的是
  // 「WebDriver 邏輯視窗座標」(getWindowSize)。橫向遊戲下兩者常不同(截圖 2404x1080,
  // 視窗可能回直向基準 1080x2404),不換算會讓 x 超出視窗寬被裁掉 → 點擊完全落空。
  #shotW = 0;
  #shotH = 0;
  #winW = 0;
  #winH = 0;

  constructor(driver, url, capabilities, refreshEndpoint) {
    this.#driver = driver;
    this.#url = url;
    this.#capabilities = capabilities;
    this.#refreshEndpoint = refreshEndpoint;
  }

  /**
   * 設定座標換算基準。shot = 當前截圖像素尺寸(VLM 座標空間);
   * 會查一次 getWindowSize 當作 tap 目標空間。之後 tap/swipe 自動把截圖座標縮放到視窗座標。
   */
  async setCoordinateSpace(shotW, shotH) {
    this.#shotW = shotW || 0;
    this.#shotH = shotH || 0;
    try {
      const { width, height } = await this.#withEndpointRecovery(() => this.#driver.getWindowSize());
      this.#winW = width;
      this.#winH = height;
    } catch {
      this.#winW = 0;
      this.#winH = 0;
    }
    return { shot: [this.#shotW, this.#shotH], win: [this.#winW, this.#winH] };
  }

  /** 把截圖像素座標換算成 WebDriver 視窗座標(基準未設或相同則原值)。 */
  #toWindow(x, y) {
    if (!this.#shotW || !this.#shotH || !this.#winW || !this.#winH) return [x, y];
    if (this.#shotW === this.#winW && this.#shotH === this.#winH) return [x, y];
    const sx = (x * this.#winW) / this.#shotW;
    const sy = (y * this.#winH) / this.#shotH;
    return [Math.round(sx), Math.round(sy)];
  }

  get sessionId() { return this.#driver.sessionId; }

  /**
   * 建立並連上 Appium server(Device Farm remoteDriverEndpoint)。
   * @param url Appium WebDriver URL
   * @param options { platform:'android'|'ios', autoLaunch=false, enableKeepAlive=true, refreshEndpoint }
   */
  static async create(url, options = {}) {
    const {
      enableKeepAlive = true,
      autoLaunch = false,
      platform = 'android',
      refreshEndpoint,
    } = options;
    const isIOS = platform === 'ios';
    // Device Farm capabilities:iOS=XCUITest / Android=UiAutomator2;autoLaunch:false 讓裝置停在
    // 桌面,由呼叫方顯式 launchPackage(避免 Appium 建 session 時自己裝+啟動撞穿 180s 超時)。
    const capabilities = {
      platformName: isIOS ? 'iOS' : 'Android',
      'appium:automationName': isIOS ? 'XCUITest' : 'UiAutomator2',
      'appium:newCommandTimeout': 300,
      'appium:noReset': true,
      ...(isIOS ? {} : { 'appium:autoGrantPermissions': false }),
      ...(!autoLaunch ? { 'appium:autoLaunch': false } : {}),
    };

    let driver;
    try {
      driver = await remote({ ...connectionOptions(url), capabilities });
    } catch (err) {
      throw new Error(`Appium 連接失敗: ${errorDetail(err)}`);
    }
    const client = new AppiumClient(driver, url, capabilities, refreshEndpoint);
    if (enableKeepAlive) client.#startKeepAlive();
    return client;
  }

  /** 截圖 → base64 PNG。 */
  async takeScreenshot() {
    const base64 = await this.#withEndpointRecovery(() => this.#driver.takeScreenshot());
    if (!base64 || base64.length === 0) throw new Error('takeScreenshot 回傳空');
    return base64;
  }

  /** 裝置螢幕尺寸 [w,h](VLM 座標空間)。 */
  async getScreenSize() {
    const { width, height } = await this.#withEndpointRecovery(() => this.#driver.getWindowSize());
    return [width, height];
  }

  /**
   * 從 Appium session 回傳的 capabilities 讀機型/製造商/OS(供顯示「執行裝置」)。
   * UiAutomator2 通常回 deviceModel/deviceManufacturer/platformVersion。取不到就回 undefined。
   */
  deviceInfo() {
    const caps = this.#driver?.capabilities || {};
    const model = caps.deviceModel || caps.deviceName || caps['appium:deviceName'];
    const maker = caps.deviceManufacturer || caps['appium:deviceManufacturer'];
    const osVer = caps.platformVersion || caps['appium:platformVersion'];
    const label = [maker, model].filter(Boolean).join(' ').trim() || undefined;
    return { model: label, osVersion: osVer || undefined };
  }

  /**
   * 執行 VLM 決策動作。cmd 形態對齊 emulator runner:
   * { action:'tap|swipe|type|back|wait|launch|done', x,y,x2,y2,text,app }
   */
  async act(cmd) {
    await this.#withEndpointRecovery(() => this.#actOnce(cmd));
  }

  async #actOnce(cmd) {
    switch (cmd.action) {
      case 'tap': {
        const [tx, ty] = this.#toWindow(Math.round(cmd.x), Math.round(cmd.y));
        await this.#tapWithFallback(tx, ty);
        break;
      }
      case 'swipe': {
        const [sx, sy] = this.#toWindow(Math.round(cmd.x), Math.round(cmd.y));
        const [ex, ey] = this.#toWindow(Math.round(cmd.x2 ?? cmd.x), Math.round(cmd.y2 ?? cmd.y));
        await this.#swipe(sx, sy, ex, ey, cmd.durationMs ?? 500);
        break;
      }
      // move:虛擬搖桿「持續移動」手勢。割草/動作遊戲(如倖存者/Vampire-Survivors-like)
      // 的走位不是「從 A 滑到 B 放開」,而是「在搖桿上按住不放、朝某方向壓住、維持數秒」。
      // 語意:從起點(x,y;預設畫面中心=搖桿中心)按住 → 朝 dir/角度方向壓到偏移點 → 保持 holdMs → 放開。
      // dir 支援 up/down/left/right/upleft/upright/downleft/downright,或用 x2,y2 指定終點方向。
      case 'move': {
        const cx = Number.isFinite(cmd.x) ? Math.round(cmd.x) : Math.round((this.#shotW ?? 0) / 2);
        const cy = Number.isFinite(cmd.y) ? Math.round(cmd.y) : Math.round((this.#shotH ?? 0) / 2);
        // 位移量:預設為畫面較短邊的 22%(搖桿壓到底約略距離);可用 magnitude 覆寫(截圖像素)。
        const shortSide = Math.min(this.#shotW || 1080, this.#shotH || 2340);
        const mag = Number.isFinite(cmd.magnitude) ? Math.round(cmd.magnitude) : Math.round(shortSide * 0.22);
        let dx = 0, dy = 0;
        if (Number.isFinite(cmd.x2) && Number.isFinite(cmd.y2)) {
          dx = Math.round(cmd.x2) - cx; dy = Math.round(cmd.y2) - cy;
        } else {
          const dir = String(cmd.dir ?? cmd.direction ?? 'up').toLowerCase();
          if (dir.includes('up')) dy -= mag;
          if (dir.includes('down')) dy += mag;
          if (dir.includes('left')) dx -= mag;
          if (dir.includes('right')) dx += mag;
          if (dx === 0 && dy === 0) dy = -mag; // 預設往上
        }
        const [sx, sy] = this.#toWindow(cx, cy);
        const [ex, ey] = this.#toWindow(cx + dx, cy + dy);
        // holdMs:按住維持的時間(角色實際行走的秒數),預設 1500ms,夾在 300–8000ms。
        const holdMs = Math.max(300, Math.min(8000, Number.isFinite(cmd.holdMs) ? cmd.holdMs : (Number.isFinite(cmd.durationSec) ? cmd.durationSec * 1000 : 1500)));
        await this.#holdMove(sx, sy, ex, ey, holdMs);
        break;
      }
      case 'type':
        await this.#typeText(cmd.text ?? '');
        break;
      case 'back':
        await this.#driver.execute('mobile: pressKey', { keycode: 4 });
        break;
      case 'wait':
        await sleep((cmd.duration ?? 3) * 1000);
        break;
      case 'launch':
        if (cmd.app) await this.launchPackage(cmd.app);
        break;
      case 'done':
        break;
      default:
        throw new Error(`不支援的動作: ${cmd.action}`);
    }
  }

  /** 按包名啟動 app(activateApp 自動解析 launcher)。 */
  async launchPackage(pkg) {
    await this.#withEndpointRecovery(async () => {
      try {
        await this.#driver.activateApp(pkg);
        return;
      } catch {
        await this.#driver.execute('mobile: activateApp', { appId: pkg });
      }
    });
  }

  /**
   * 確保 app 在前景;若掉到背景/桌面(例如 AI 誤按 back 退出遊戲)就重新拉回前景。
   * 回 true 表示「本來就在前景」,false 表示「做了重新啟動」(呼叫端可據此多等一下載入)。
   * queryAppState:4=前景執行中,3=背景,其它=未執行/不在前景。
   */
  async ensureForeground(pkg) {
    if (!pkg) return true;
    return this.#withEndpointRecovery(async () => {
      let state = 4;
      try {
        state = await this.#driver.queryAppState(pkg);
      } catch {
        try { state = await this.#driver.execute('mobile: queryAppState', { appId: pkg }); } catch { state = 4; }
      }
      if (state === 4) return true; // 已在前景
      try { await this.#driver.activateApp(pkg); }
      catch { try { await this.#driver.execute('mobile: activateApp', { appId: pkg }); } catch { /* 盡力 */ } }
      return false;
    });
  }

  /**
   * tap 三層 fallback。順序刻意把 W3C pointer(真 ACTION_DOWN/UP MotionEvent)放第一:
   * Unity/Cocos 等自繪引擎的遊戲(如 Golden HoYeah)只讀原生觸控事件,會忽略
   * UiAutomator2 的 `mobile: clickGesture`(無障礙式點擊)——clickGesture 會「成功」回傳但
   * 遊戲的 PLAY 鈕毫無反應。故先用 pointer 動作(帶 ~120ms 按壓),再退回 clickGesture / touchAction。
   */
  async #tapWithFallback(x, y) {
    try {
      await this.#driver.action('pointer', { parameters: { pointerType: 'touch' } })
        .move({ x, y, duration: 0 }).down({ button: 0 }).pause(120).up({ button: 0 }).perform();
      // 釋放 W3C action 佇列,避免殘留狀態影響下一次。
      await this.#driver.releaseActions().catch(() => {});
      return;
    } catch { /* try next */ }
    try {
      await this.#driver.execute('mobile: clickGesture', { x, y });
      return;
    } catch { /* try next */ }
    await this.#driver.touchAction([{ action: 'tap', x, y }]);
  }

  async #swipe(x1, y1, x2, y2, durationMs) {
    await this.#driver.action('pointer', { parameters: { pointerType: 'touch' } })
      .move({ x: x1, y: y1, duration: 0 }).down({ button: 0 })
      .move({ x: x2, y: y2, duration: durationMs }).up({ button: 0 }).perform();
  }

  /**
   * 虛擬搖桿「持續移動」:按住起點 → 快速壓到方向偏移點(當作把搖桿推到底)→ 保持 holdMs
   * 讓角色持續朝該方向行走 → 放開。與 #swipe 的差別是「到位後停住不放」,對應割草/動作遊戲
   * 的持續走位。用 W3C pointer 的多段 move + pause,pause 期間手指維持按下、座標不動。
   */
  async #holdMove(x1, y1, x2, y2, holdMs) {
    await this.#driver.action('pointer', { parameters: { pointerType: 'touch' } })
      .move({ x: x1, y: y1, duration: 0 }).down({ button: 0 })
      .move({ x: x2, y: y2, duration: 180 })  // 180ms 把搖桿推到方向底
      .pause(holdMs)                            // 維持按住,角色持續行走
      .up({ button: 0 }).perform();
    await this.#driver.releaseActions().catch(() => {});
  }

  async #typeText(text) {
    try {
      const active = await this.#driver.getActiveElement();
      if (active && typeof active.setValue === 'function') {
        await active.setValue(text);
        await this.#hideKeyboard();
        return;
      }
    } catch { /* fall through */ }
    await this.#driver.keys(text.split(''));
    await this.#hideKeyboard();
  }

  /** 收起軟鍵盤:輸入後鍵盤常遮住畫面下半的按鈕(Log in/Register/Create/OK),不收起會卡死。
   *  先試 Appium hideKeyboard,失敗再送 Android 返回鍵(收鍵盤不離開頁面)。 */
  async #hideKeyboard() {
    try { await this.#driver.hideKeyboard(); return; } catch { /* try back */ }
    try { await this.#driver.pressKeyCode(4); } catch { /* ignore */ } // 4 = Android BACK
  }

  /** Device Farm endpoint 失效時重新取得 URL 並 attach 回原 session(每次最多重試一次)。 */
  async #withEndpointRecovery(operation) {
    const generation = this.#endpointGeneration;
    try {
      return await operation();
    } catch (error) {
      if (!this.#refreshEndpoint || !isInvalidPresignedUrl(error)) throw error;
      if (generation === this.#endpointGeneration) await this.#refreshDriverEndpoint();
      return operation();
    }
  }

  async #refreshDriverEndpoint() {
    if (this.#refreshPromise) return this.#refreshPromise;
    const refreshEndpoint = this.#refreshEndpoint;
    if (!refreshEndpoint) throw new Error('endpoint 失效且無刷新函式');
    this.#refreshPromise = (async () => {
      const sessionId = this.#driver.sessionId;
      const newUrl = await refreshEndpoint();
      this.#driver = await attach({ ...connectionOptions(newUrl), sessionId, capabilities: this.#capabilities });
      this.#url = newUrl;
      this.#endpointGeneration += 1;
    })();
    try { await this.#refreshPromise; } finally { this.#refreshPromise = null; }
  }

  #startKeepAlive() {
    // Device Farm ~5 分 idle timeout:每 60s 送一個輕量截圖保活。unref 避免拖住程序結束。
    this.#keepAliveTimer = setInterval(async () => {
      try { await this.#withEndpointRecovery(() => this.#driver.takeScreenshot()); } catch { /* 忽略 */ }
    }, 60_000);
    if (this.#keepAliveTimer.unref) this.#keepAliveTimer.unref();
  }

  #stopKeepAlive() {
    if (this.#keepAliveTimer !== null) { clearInterval(this.#keepAliveTimer); this.#keepAliveTimer = null; }
  }

  async quit() {
    this.#stopKeepAlive();
    try { await this.#withEndpointRecovery(() => this.#driver.deleteSession()); } catch { /* 忽略 */ }
  }
}
