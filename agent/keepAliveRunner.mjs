/**
 * 保活 runner(ECS Fargate)—— 讓 Windows 測試可以跑超過一小時。
 *
 * engine 以 SignalRequest='NO_CLIENT_CONNECTION' 開 GameLift Streams session,沒有任何
 * client 連進來。這種 session 一定在 ConnectionTimeoutSeconds(上限 3600 秒,AWS 強制)
 * 之內被收掉,而 SessionLengthSeconds 可以到 24 小時 —— 差別只在「有沒有 client 連著」。
 * 這支 task 就是那個 client:engine 開完 session 之後立刻 RunTask 起它,它連上去掛著,
 * session 結束時自己退出。
 *
 * 為什麼是一個瀏覽器:SignalRequest 必須由 AWS Web SDK 的 generateSignalRequest() 產生,
 * 自己組標準 WebRTC offer 會被 API 拒絕,而那個 SDK 需要 DOM。詳見
 * docs/design/windows-long-run.md。
 *
 * 它還負責 deadline 租約:只要 session 真的是 CONNECTED,就把 lease.json 的 deadline
 * 往後推,主機上的 runner 讀它決定什麼時候收尾寫報告。保活連不上或中途死掉時租約停止
 * 更新,runner 就退回原本的一小時行為 —— 兩種失敗都是安全的(見 glsKeepAlive.mjs 的
 * leaseDeadlineMs)。
 *
 * 環境變數(engine 以 containerOverrides 注入):
 *   PA_SG            stream group id
 *   PA_SESSION_ARN   要保活的 session ARN
 *   PA_BUCKET        資料桶
 *   PA_PREFIX        tenants/<t>/jobs/<jobId>
 *   PA_DATA_REGION   資料/GameLift 區域
 *   PA_SESSION_END_MS  session 硬性結束時刻(毫秒時戳);缺省 = 只用重連窗口算租約
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { GameLiftStreamsClient, GetStreamSessionCommand } from '@aws-sdk/client-gameliftstreams';
import { createKeepAlive, pageHtml, leaseDeadlineMs, FINAL_STATES } from './glsKeepAlive.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SG = process.env.PA_SG ?? '';
const SESSION_ARN = process.env.PA_SESSION_ARN ?? '';
const BUCKET = process.env.PA_BUCKET ?? '';
const PREFIX = (process.env.PA_PREFIX ?? '').replace(/\/+$/, '');
const REGION = process.env.PA_DATA_REGION ?? process.env.AWS_REGION ?? 'us-west-2';
const SESSION_END_MS = Number(process.env.PA_SESSION_END_MS ?? 0);
// SDK 在建置時下載並放在映像裡(見 Dockerfile.keepalive);路徑可覆寫以便本機驗證。
const SDK_JS = process.env.PA_SDK_JS ?? join(HERE, 'gameliftstreams.js');
/** 租約更新間隔。比重連窗口(3600 秒)短得多,掉幾次也不影響。 */
const LEASE_EVERY_MS = 30_000;

const log = (...m) => console.log(new Date().toISOString(), ...m);

if (!SG || !SESSION_ARN) {
  log('[keepalive] 缺 PA_SG 或 PA_SESSION_ARN,無事可做');
  process.exit(1);
}

const gl = new GameLiftStreamsClient({ region: REGION });
const s3 = BUCKET && PREFIX ? new S3Client({ region: REGION }) : null;

/**
 * 開一個已載入保活頁面與 SDK 的瀏覽器頁面。
 *
 * 注意順序:addInitScript 搭 setContent **不會**把腳本帶進頁面(實測
 * window.gameliftstreams 不存在)。必須先 setContent 再 addScriptTag。
 */
let browser = null;
async function openPage() {
  browser ??= await chromium.launch({
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log('[keepalive] 頁面錯誤', String(e).slice(0, 200)));
  await page.setContent(pageHtml());
  await page.addScriptTag({ content: readFileSync(SDK_JS, 'utf8') });
  if (!(await page.evaluate(() => window.paKeepAlive.sdkReady()))) {
    throw new Error(`Web SDK 注入失敗(${SDK_JS})`);
  }
  return { page, close: async () => { await ctx.close(); } };
}

/**
 * 租約迴圈。
 *
 * 刻意自己查 session 狀態而不是問保活模組「連上了沒」:GameLift 回 CONNECTED 才代表
 * ConnectionTimeoutSeconds 的倒數真的停了,那正是租約要擔保的事。每 30 秒多一次
 * GetStreamSession,相較於一個 GPU session 的成本可以忽略。
 */
async function leaseLoop() {
  if (!s3) { log('[keepalive] 沒有 PA_BUCKET/PA_PREFIX,不寫 deadline 租約'); return; }
  const key = `${PREFIX}/lease.json`;
  for (;;) {
    let status = '';
    try {
      const g = await gl.send(new GetStreamSessionCommand({
        Identifier: SG, StreamSessionIdentifier: SESSION_ARN,
      }));
      status = g.Status ?? '';
    } catch (e) {
      log('[keepalive] 租約:查 session 失敗', String(e?.message || e).slice(0, 160));
    }
    if (FINAL_STATES.has(status)) { log('[keepalive] 租約:session', status, '收工'); return; }
    if (status === 'CONNECTED') {
      const deadlineMs = leaseDeadlineMs({ nowMs: Date.now(), sessionEndMs: SESSION_END_MS });
      try {
        await s3.send(new PutObjectCommand({
          Bucket: BUCKET,
          Key: key,
          ContentType: 'application/json',
          Body: JSON.stringify({
            deadlineMs,
            deadlineAt: new Date(deadlineMs).toISOString(),
            updatedAt: new Date().toISOString(),
            source: 'keepalive',
          }),
        }));
      } catch (e) {
        // 寫不進去不是致命的:runner 會沿用上一份租約,最糟是退回一小時。
        log('[keepalive] 租約:寫入失敗', String(e?.message || e).slice(0, 160));
      }
    }
    await new Promise((r) => setTimeout(r, LEASE_EVERY_MS));
  }
}

log(`[keepalive] 開始(group=${SG} session=${SESSION_ARN.split('/').pop()} region=${REGION})`);
const ka = createKeepAlive({
  streamGroupId: SG,
  sessionArn: SESSION_ARN,
  region: REGION,
  browser: openPage,
  log: (m) => log(m),
});

// 容器被收掉時好好地關連線;不關的話 session 要等重連窗口過完才會發現沒人了。
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log(`[keepalive] 收到 ${sig},停止`);
    ka.stop().catch(() => {}).finally(() => process.exit(0));
  });
}

// 兩條迴圈各自以 session 終態收工;都結束才退出。
await Promise.all([
  ka.run({ pollMs: 20_000 }),
  leaseLoop(),
]);
try { await browser?.close(); } catch { /* 可能已關 */ }
log('[keepalive] 結束');
