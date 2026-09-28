#!/usr/bin/env node
/**
 * PlayAgent 本地代理(Req 13)。
 * 主動撥出 WSS 連雲端;收到雲端指令 → 在本地裝置執行 → 回傳新畫面。
 * 決策全在雲端,本代理不含測試邏輯。
 *
 * 骨架說明:Capturer(畫面擷取)與 Actuator(動作執行)為插槽介面,
 * 依來源(desktop/browser/emulator)提供實作。此處提供介面與連線/往返骨架;
 * 原生擷取/注入實作需在有裝置的環境接入(見 README)。
 */
import WebSocket from 'ws';

const WS = process.env.PLAYAGENT_WS ?? '';
const TOKEN = process.env.PLAYAGENT_TOKEN ?? '';
const TENANT_ID = process.env.PLAYAGENT_TENANT_ID ?? '';
const DEVICE_ID = process.env.PLAYAGENT_DEVICE_ID ?? '';
const source = argValue('--source') ?? 'desktop';

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** 畫面擷取插槽:回傳 PNG buffer。 */
class Capturer {
  constructor(kind) {
    this.kind = kind;
  }
  async capture() {
    // TODO(平台實作):
    // - desktop: 用 OS 截圖 API(如 macOS screencapture / nut.js)
    // - browser: 用 CDP Page.captureScreenshot
    // - emulator: 用 adb exec-out screencap -p
    throw new Error(`Capturer(${this.kind}) 尚未在此環境實作`);
  }
}

/** 動作執行插槽:在本地裝置執行點擊/輸入。 */
class Actuator {
  constructor(kind) {
    this.kind = kind;
  }
  async tap(_x, _y) {
    throw new Error(`Actuator(${this.kind}) 尚未在此環境實作`);
  }
  async type(_text) {
    throw new Error(`Actuator(${this.kind}) 尚未在此環境實作`);
  }
}

function connect() {
  if (!WS || !TOKEN || !TENANT_ID || !DEVICE_ID) {
    console.error(
      '請設定 PLAYAGENT_WS / PLAYAGENT_TOKEN / PLAYAGENT_TENANT_ID / PLAYAGENT_DEVICE_ID',
    );
    process.exit(1);
  }
  const capturer = new Capturer(source);
  const actuator = new Actuator(source);

  // 主動撥出(不需本地入站埠,Req 13.1):帶 tenantId + deviceId + 裝置 token。
  // token 同時放在 token= 以觸發 WS authorizer(identitySource=token),
  // authorizer 據 deviceId/tenantId 走裝置驗證路徑。
  const qs = new URLSearchParams({
    tenantId: TENANT_ID,
    deviceId: DEVICE_ID,
    deviceToken: TOKEN,
    token: TOKEN,
  }).toString();
  const ws = new WebSocket(`${WS}?${qs}`);

  ws.on('open', () => {
    console.log(`[agent] 已連上雲端,來源=${source}`);
    // 註冊為 attached 裝置(伺服器據登入身分綁租戶,Req 13.8)
    ws.send(JSON.stringify({ action: 'registerDevice', source }));
  });

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    // 雲端下達的指令:capture / tap / type / done
    try {
      if (msg.command === 'capture') {
        const png = await capturer.capture();
        ws.send(JSON.stringify({ event: 'frame', jobId: msg.jobId, size: png.length }));
        // 實務上會把 png 經 presigned PUT 直傳 S3(位元組不經 WS)
      } else if (msg.command === 'tap') {
        await actuator.tap(msg.x, msg.y);
        ws.send(JSON.stringify({ event: 'acted', jobId: msg.jobId }));
      } else if (msg.command === 'type') {
        await actuator.type(msg.text);
        ws.send(JSON.stringify({ event: 'acted', jobId: msg.jobId }));
      } else if (msg.command === 'done') {
        console.log(`[agent] 任務 ${msg.jobId} 完成:${msg.state}`);
      }
    } catch (err) {
      // 裝置失聯 / 執行失敗 → 通報雲端(雲端據此落 error,Req 13.6)
      ws.send(
        JSON.stringify({ event: 'deviceError', jobId: msg.jobId, message: String(err) }),
      );
    }
  });

  ws.on('close', () => {
    console.log('[agent] 連線中斷,3 秒後重連…');
    setTimeout(connect, 3000);
  });
  ws.on('error', (e) => {
    console.error('[agent] 連線錯誤', e.message);
    ws.close();
  });
}

connect();
