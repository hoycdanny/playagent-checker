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

/** 按住時長夾在 200–8000ms。 */
function clampHold(v, dflt) {
  const n = Number(v);
  return Math.max(200, Math.min(8000, Number.isFinite(n) ? Math.round(n) : dflt));
}

/** 方向字串 → 位移(截圖像素);無方向 = 原地按住。 */
function dirOffset(dir, mag) {
  const d = String(dir ?? '').toLowerCase();
  let dx = 0, dy = 0;
  if (d.includes('up')) dy -= mag;
  if (d.includes('down')) dy += mag;
  if (d.includes('left')) dx -= mag;
  if (d.includes('right')) dx += mag;
  return [dx, dy];
}

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
      // move:虛擬搖桿「持續移動」手勢。割草/動作遊戲
      // 的走位不是「從 A 滑到 B 放開」,而是「在搖桿上按住不放、朝某方向壓住、維持數秒」。
      // 語意(2026-10-01 真人錄屏驗證修正):錄屏逐帧比對確認這是標準「連續拖拽式」虛擬
      // 搖桿——手指全程按住不放,搖桿白球即時跟隨手指目前位置偏移,角色朝偏移方向持續走;
      // 放開手指白球才彈回中心。之前兩次誤判(先以為要 tap/quickSwipe,後又以為要
      // hold+pause)都是錯的方向。真正的問題在執行細節:原 #holdMove 用 down→move→pause→up,
      // pause 期間完全不送任何觸控事件,可能被遊戲判定成「沒有新輸入」等同放開。修法:
      // 按住期間持續對終點送 move(維持手指在終點位置的狀態,不靠 pause 的靜默),讓觸控
      // 事件流不中斷,貼近真人手指按住不放的實際行為。
      // dir 支援 up/down/left/right/upleft/upright/downleft/downright,或用 x2,y2 指定終點方向。
      case 'move': {
        // 虛擬搖桿通常在畫面「下方中央」,不是正中心。
        // 2026-10-02 用 Device Farm 原始截圖(1080x2404)逐像素掃描量出搖桿圓心實際位置
        // 是 (535, 1975),換算比例為寬度 49.5%、高度 82.1%(原本用目測估的 84% 偏差約
        // 50px,足以讓觸控完全落在搖桿熱區之外、角色完全不移動——這才是真正的根因,
        // 不是手勢時間參數的問題)。模型可用 x,y 明確指定搖桿中心;省略時用此精確比例預設。
        const cx = Number.isFinite(cmd.x) ? Math.round(cmd.x) : Math.round((this.#shotW ?? 0) * 0.495);
        const cy = Number.isFinite(cmd.y) ? Math.round(cmd.y) : Math.round((this.#shotH ?? 0) * 0.821);
        // 位移量:預設為畫面較短邊的 22%(單次滑動距離);可用 magnitude 覆寫(截圖像素)。
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
      // kite:runner 內部用的「繞圈走位」(割草類戰鬥自動走位,不開放給 AI)。
      // 按住搖桿中心 → 推到圓周 → 沿圓周持續轉動 holdMs → 放開;角色會繞大圈遛怪、持續撿經驗。
      case 'kite': {
        const cx = Number.isFinite(cmd.x) ? Math.round(cmd.x) : Math.round((this.#shotW ?? 0) * 0.495);
        const cy = Number.isFinite(cmd.y) ? Math.round(cmd.y) : Math.round((this.#shotH ?? 0) * 0.821);
        const r = Math.round(Math.min(this.#shotW || 1080, this.#shotH || 2340) * 0.18);
        const holdMs = clampHold(cmd.holdMs, 6000);
        const segs = 12;
        const dirSign = cmd.clockwise ? 1 : -1;
        const a0 = Number.isFinite(cmd.start) ? cmd.start : 0;
        const pt = (a) => this.#toWindow(Math.round(cx + r * Math.cos(a)), Math.round(cy + r * Math.sin(a)));
        const [sx, sy] = this.#toWindow(cx, cy);
        let chain = this.#driver.action('pointer', { parameters: { pointerType: 'touch' } })
          .move({ x: sx, y: sy, duration: 0 }).down({ button: 0 });
        const [fx, fy] = pt(a0);
        chain = chain.move({ x: fx, y: fy, duration: 150 });
        // 繞 1 圈(2π)分 segs 段;每段移動耗時 = holdMs/segs(手指一直按著,事件流不中斷)。
        for (let k = 1; k <= segs; k++) {
          const [px, py] = pt(a0 + dirSign * (2 * Math.PI * k) / segs);
          chain = chain.move({ x: px, y: py, duration: Math.round(holdMs / segs) });
        }
        await chain.up({ button: 0 }).perform();
        await this.#driver.releaseActions().catch(() => {});
        break;
      }
      // hold:單指長按(蓄力、賽車轉向/油門、節奏長音符)。
      case 'hold': {
        const [hx, hy] = this.#toWindow(
          Number.isFinite(cmd.x) ? Math.round(cmd.x) : Math.round((this.#shotW ?? 0) / 2),
          Number.isFinite(cmd.y) ? Math.round(cmd.y) : Math.round((this.#shotH ?? 0) / 2),
        );
        const holdMs = clampHold(cmd.holdMs, 1000);
        await this.#driver.action('pointer', { parameters: { pointerType: 'touch' } })
          .move({ x: hx, y: hy, duration: 0 }).down({ button: 0 }).pause(holdMs).up({ button: 0 }).perform();
        await this.#driver.releaseActions().catch(() => {});
        break;
      }
      // combo:雙指同時操作 —— 左手按住(搖桿朝 dir 拖曳,或原地按住方向鍵)holdMs,
      // 期間右手在 (tx,ty) 點 taps 次(邊走邊打 / 邊轉彎邊開氮氣)。W3C 多 pointer 同步執行。
      case 'combo': {
        const holdMs = clampHold(cmd.holdMs, 1500);
        const cx = Number.isFinite(cmd.x) ? Math.round(cmd.x) : Math.round((this.#shotW ?? 0) * 0.18);
        const cy = Number.isFinite(cmd.y) ? Math.round(cmd.y) : Math.round((this.#shotH ?? 0) * 0.72);
        const [dx, dy] = dirOffset(cmd.dir, Math.round(Math.min(this.#shotW || 1080, this.#shotH || 2340) * 0.12));
        const [sx, sy] = this.#toWindow(cx, cy);
        const [ex, ey] = this.#toWindow(cx + dx, cy + dy);
        const tx0 = Number.isFinite(cmd.tx) ? Math.round(cmd.tx) : Math.round((this.#shotW ?? 0) * 0.85);
        const ty0 = Number.isFinite(cmd.ty) ? Math.round(cmd.ty) : Math.round((this.#shotH ?? 0) * 0.75);
        const [tx, ty] = this.#toWindow(tx0, ty0);
        const taps = Math.max(1, Math.min(5, Math.round(Number(cmd.taps) || 1)));
        await this.#multiTouchCombo({ sx, sy, ex, ey, tx, ty, holdMs, taps });
        break;
      }
      // pinch:雙指縮放(out=兩指張開放大,in=兩指合攏縮小)。
      case 'pinch': {
        const cx = Number.isFinite(cmd.x) ? Math.round(cmd.x) : Math.round((this.#shotW ?? 0) / 2);
        const cy = Number.isFinite(cmd.y) ? Math.round(cmd.y) : Math.round((this.#shotH ?? 0) / 2);
        const short = Math.min(this.#shotW || 1080, this.#shotH || 2340);
        const near = Math.round(short * 0.06), far = Math.round(short * 0.28);
        const out = String(cmd.scale ?? 'out').toLowerCase() !== 'in';
        const [from, to] = out ? [near, far] : [far, near];
        const p = (d) => [this.#toWindow(cx - d, cy - d), this.#toWindow(cx + d, cy + d)];
        const [[a1x, a1y], [b1x, b1y]] = p(from);
        const [[a2x, a2y], [b2x, b2y]] = p(to);
        const f1 = this.#driver.action('pointer', { id: 'finger1', parameters: { pointerType: 'touch' } })
          .move({ x: a1x, y: a1y, duration: 0 }).down({ button: 0 }).pause(50).move({ x: a2x, y: a2y, duration: 500 }).up({ button: 0 });
        const f2 = this.#driver.action('pointer', { id: 'finger2', parameters: { pointerType: 'touch' } })
          .move({ x: b1x, y: b1y, duration: 0 }).down({ button: 0 }).pause(50).move({ x: b2x, y: b2y, duration: 500 }).up({ button: 0 });
        await this.#driver.actions([f1, f2]);
        await this.#driver.releaseActions().catch(() => {});
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

  /** 關閉並重新開啟 app(卡在載入/登入回調時脫困用)。 */
  async restartApp(pkg) {
    await this.#withEndpointRecovery(async () => {
      try { await this.#driver.terminateApp(pkg); }
      catch { try { await this.#driver.execute('mobile: terminateApp', { appId: pkg }); } catch { /* 盡力 */ } }
    });
    await sleep(2000);
    await this.launchPackage(pkg);
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
  /** 最近一次 ensureForeground 查到的 queryAppState(1=未執行→疑似閃退;2/3=背景→跳到其他 App)。 */
  lastAppState = 4;

  async ensureForeground(pkg) {
    if (!pkg) return true;
    return this.#withEndpointRecovery(async () => {
      let state = 4;
      try {
        state = await this.#driver.queryAppState(pkg);
      } catch {
        try { state = await this.#driver.execute('mobile: queryAppState', { appId: pkg }); } catch { state = 4; }
      }
      this.lastAppState = typeof state === 'number' ? state : 4;
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
   * 虛擬搖桿「持續移動」:按住起點 → 拖到方向偏移點 → 停留 holdMs → 放開。
   *
   * 背景(除錯記錄,2026-10-01~10-02):之前排查方向完全錯了——先誤判成要用單次
   * tap/swipe,又誤判成 pause 期間要補 move tick 維持事件流,改了好幾輪手勢時間參數
   * (pause、tick 間隔、down 後延遲)都沒用,角色依然完全不移動一個像素。
   * 真正的根因不是手勢寫法,是座標:原本 cy 用目測比例估成畫面高度 84%,但用 Device
   * Farm 原始截圖逐像素掃描量出搖桿圓心其實在 82.1%——約 50px 的偏差,但足以讓整個
   * 觸控完全落在搖桿熱區之外(遊戲判定「沒有按在搖桿上」,所以無論手勢多精緻都沒反應)。
   * 用隔離的 raw test script(繞過 playagent-checker 全部邏輯、純粹單點觸控 down→move
   * (150ms)→pause(holdMs)→up)配合修正後座標重新驗證,角色才真正移動。手勢本身不需要
   * 複雜的 tick 補償,簡單的 down→move→pause→up 就夠。
   */
  async #holdMove(x1, y1, x2, y2, holdMs) {
    await this.#driver.action('pointer', { parameters: { pointerType: 'touch' } })
      .move({ x: x1, y: y1, duration: 0 }).down({ button: 0 })
      .move({ x: x2, y: y2, duration: 150 }) // 150ms 把搖桿壓到方向底(模擬手指滑過去)
      .pause(holdMs) // 按住不放,維持在終點位置,讓角色持續朝該方向走 holdMs
      .up({ button: 0 }).perform();
    await this.#driver.releaseActions().catch(() => {});
  }

  /**
   * 雙指同步:finger1 按住(可拖向搖桿方向)維持 holdMs;finger2 在按住期間平均點 taps 次。
   * 兩條 pointer 時間軸以 W3C actions 同時執行(Android UiAutomator2 支援多點觸控)。
   * 多 pointer 失敗時退回「先按住移動、再點右手鍵」的序列操作,至少兩個動作都有送到。
   */
  async #multiTouchCombo({ sx, sy, ex, ey, tx, ty, holdMs, taps }) {
    const lead = 150;
    const press = 80;
    const gap = Math.max(60, Math.floor((holdMs - lead - taps * press) / taps));
    const f1 = this.#driver.action('pointer', { id: 'finger1', parameters: { pointerType: 'touch' } })
      .move({ x: sx, y: sy, duration: 0 }).down({ button: 0 })
      .move({ x: ex, y: ey, duration: lead })
      .pause(holdMs)
      .up({ button: 0 });
    let f2 = this.#driver.action('pointer', { id: 'finger2', parameters: { pointerType: 'touch' } })
      .pause(lead + 50);
    for (let k = 0; k < taps; k++) {
      f2 = f2.move({ x: tx, y: ty, duration: 0 }).down({ button: 0 }).pause(press).up({ button: 0 });
      if (k < taps - 1) f2 = f2.pause(gap);
    }
    try {
      await this.#driver.actions([f1, f2]);
    } catch {
      await this.#holdMove(sx, sy, ex, ey, holdMs);
      for (let k = 0; k < taps; k++) await this.#tapWithFallback(tx, ty);
    }
    await this.#driver.releaseActions().catch(() => {});
  }

  async #typeText(text) {
    // 優先用 UiAutomator2 的 `mobile: type`(底層文字注入,不觸發畫面輸入法互動,避免軟鍵盤遮住按鈕致卡死)。
    try {
      await this.#driver.execute('mobile: type', { text });
      await this.#hideKeyboard();
      return;
    } catch { /* fall through to element setValue */ }
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
   *  用 UiAutomator2 的 mobile: pressKey 送 Android BACK(實測比 webdriverio hideKeyboard 可靠),多重 fallback。 */
  async #hideKeyboard() {
    try { await this.#driver.execute('mobile: pressKey', { keycode: 4 }); return; } catch { /* try next */ }
    try { await this.#driver.hideKeyboard(); return; } catch { /* try next */ }
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

  /**
   * 效能取樣(Android UiAutomator2 `mobile: getPerformanceData`):回 { cpuPct?, memMB? }。
   * cpuinfo → user+kernel %;memoryinfo → totalPss(KB)換算 MB。取不到(iOS/驅動不支援)回 null,
   * 報告會標示「未收集」而非 0。盡力而為,不擋主流程。
   */
  async perfSample(pkg) {
    if (!pkg || this.#capabilities?.platformName === 'iOS') return null;
    const read = async (dataType) => {
      try {
        return await this.#driver.execute('mobile: getPerformanceData', { packageName: pkg, dataType });
      } catch {
        try { return await this.#driver.getPerformanceData(pkg, dataType, 5); } catch { return null; }
      }
    };
    // 回傳格式為 [[欄位名...], [值...]](值為字串)。
    const zip = (rows) => {
      if (!Array.isArray(rows) || rows.length < 2 || !Array.isArray(rows[0])) return null;
      const out = {};
      rows[0].forEach((k, i) => { const v = Number(rows[1]?.[i]); if (Number.isFinite(v)) out[String(k)] = v; });
      return out;
    };
    const out = {};
    const cpu = zip(await read('cpuinfo'));
    if (cpu && (cpu.user !== undefined || cpu.kernel !== undefined)) out.cpuPct = Math.round(((cpu.user ?? 0) + (cpu.kernel ?? 0)) * 10) / 10;
    const mem = zip(await read('memoryinfo'));
    if (mem && mem.totalPss !== undefined) out.memMB = Math.round((mem.totalPss / 1024) * 10) / 10;
    return Object.keys(out).length ? out : null;
  }

  /**
   * Android `mobile: shell`(= adb shell,Device Farm 端點允許)。command 為完整 shell 指令字串。
   * 呼叫端負責不把未驗證的輸入拼進指令(見 perfMonitor 的套件名白名單)。
   */
  async shell(command, timeoutMs = 20000) {
    if (this.#capabilities?.platformName === 'iOS') throw new Error('iOS 不支援 mobile: shell');
    return this.#withEndpointRecovery(() => this.#driver.execute('mobile: shell', { command, args: [], timeout: timeoutMs }));
  }

  async quit() {
    this.#stopKeepAlive();
    try { await this.#withEndpointRecovery(() => this.#driver.deleteSession()); } catch { /* 忽略 */ }
  }
}
