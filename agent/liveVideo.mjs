/**
 * 真機即時影片串流(取代每秒不到 1 張的截圖輪播)。
 *
 * 2026-10-05 Device Farm 實測(Pixel 11 Pro XL / Android 17):
 *   - takeScreenshot 一張 0.5–2.1 秒(彩色遊戲畫面約 3MB PNG)→ 截圖輪播頂多 ~0.5–1 fps。
 *   - 背景 `screenrecord --time-limit 2` 迴圈:每段 2 秒(段間約 0.4 秒空檔),540×1200、
 *     約 30–120 fps、每段 ~350KB;`pullFile` 一段 0.3–0.6 秒;可與 MediaProjection 錄影並存。
 *
 * 流程:裝置端 nohup 迴圈把影片切成 2 秒 mp4(檔名 = 裝置毫秒時間)→ runner 每秒列目錄,
 * 把「已錄完」的段落(最新那段還在寫,略過)拉回並上傳 `${prefix}/live/s<ms>.mp4`,
 * 再刪掉裝置上的檔。前端依序播放這些段落(延遲約 3–5 秒)。
 * 段落也同時構成整場測試的影片紀錄。
 */
const DIR = '/data/local/tmp/pa_live';
const NAME_RE = /^s\d{13}\.mp4$/;

/** 分段檔名裡的裝置毫秒時間;認不出來就回 0(當成很舊,不會誤判成「很新」)。 */
export function segTime(name) {
  const m = /^s(\d{13})\.mp4$/.exec(String(name ?? ''));
  return m ? Number(m[1]) : 0;
}

/** 依裝置螢幕比例算 screenrecord 尺寸(寬 540,高取偶數)。 */
export function recordSize(w, h) {
  const W = 540;
  const H = Math.max(2, Math.round((W * (h || 1920)) / (w || 1080) / 2) * 2);
  return `${W}x${H}`;
}

/** `ls` 輸出 → 已錄完的段落(排除最新、可能仍在寫入的那一段),舊 → 新。 */
export function completedSegments(lsOut) {
  const names = String(lsOut ?? '')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => NAME_RE.test(s))
    .sort();
  return names.slice(0, -1);
}

/**
 * @param {object} o
 * @param {{ shell(cmd:string, timeoutMs?:number):Promise<unknown>, pullFile(p:string):Promise<string> }} o.client
 * @param {(key:string, body:Buffer, type:string)=>Promise<unknown>} o.put
 * @param {string} o.prefix   jobs/<id> 前綴
 * @param {string} o.size     screenrecord --size
 * @param {number} [o.maxBacklog] 積壓過多時只送最新幾段(維持低延遲)
 * @param {boolean} [o.preserveBacklog] 證據模式:不得丟段(盤面完整率優先)
 * @param {number} [o.staleMs] 證據模式的落後上限:超過就還是要丟舊段(見 tick 的註解)
 * @param {(segment:{name:string,buf:Buffer,startedAt:number|null})=>Promise<unknown>} [o.onSegment] 拉回完整 MP4 後的本機證據分析
 */
export function createLiveVideo({ client, put, prefix, size, maxBacklog = 3, preserveBacklog = false, staleMs = 20_000, onSegment, maxFailures = 10, log = () => {} }) {
  let timer = null;
  let busy = false;
  let active = false;
  let dead = false;
  let lastOkAt = 0;
  let uploaded = 0;
  let failures = 0;
  let dropped = 0;
  let gaps = 0;

  async function tick() {
    if (busy || !active) return;
    busy = true;
    try {
      const done = completedSegments(await client.shell(`ls ${DIR} 2>/dev/null`, 8000));
      if (!done.length) return;
      // 一般即時畫面可丟舊段維持低延遲;盤面證據模式不得丟段,否則無法宣稱逐局完整。
      //
      // 但「不得丟段」有個上限。裝置每 ~2.4 秒產一段全解析度影片,拉回 + 上傳 + 解碼的總成本
      // 一旦超過這個節奏,積壓就只會單向變大 —— job-mvdyyr1j 實測影片落後從 5 秒一路長到 87 秒,
      // 停輪判定拿到的畫面全是過期的,每局都判「盤面沒有轉動」,SPIN 迴圈整段失效。
      // 一個落後 87 秒的量測沒有任何價值,所以落後超過 staleMs 就還是丟舊段:
      // 寧可在證據裡留一個「有被記下來」的缺口,也不要讓整個量測爛掉。
      const nowMs = Date.now();
      const behindMs = nowMs - segTime(done[done.length - 1]);
      const trim = preserveBacklog && behindMs > staleMs && done.length > maxBacklog;
      const drop = (!preserveBacklog || trim) && done.length > maxBacklog ? done.slice(0, done.length - maxBacklog) : [];
      if (trim && drop.length) {
        gaps++;
        dropped += drop.length;
        log(`[live-video] 積壓落後 ${Math.round(behindMs / 100) / 10}s,丟掉最舊的 ${drop.length} 段以追上即時(證據累計缺口 ${dropped} 段 / ${gaps} 處)`);
      }
      const send = done.slice(drop.length);
      const sent = [];
      for (const name of send) {
        const b64 = await client.pullFile(`${DIR}/${name}`);
        const buf = Buffer.from(String(b64 || ''), 'base64');
        if (buf.length > 0) {
          await put(`${prefix}/live/${name}`, buf, 'video/mp4');
          if (onSegment) {
            // 證據分析失敗不能中斷即時影片上傳;slot capture 自己會在 manifest 記 analysisFailures。
            // Promise.resolve 包起來:消費端忘了回 Promise 也不能把整條上傳迴圈打掛。
            await Promise.resolve(onSegment({ name, buf, startedAt: segTime(name) || null }))
              .catch((e) => log(`[live-video] ${name} 證據分析失敗:${String(e?.message || e).slice(0, 200)}`));
          }
          uploaded++;
          lastOkAt = Date.now();
        }
        sent.push(name);
      }
      const rm = [...drop, ...sent].map((n) => `${DIR}/${n}`).join(' ');
      if (rm) await client.shell(`rm -f ${rm}`, 8000);
      failures = 0;
    } catch (e) {
      failures++;
      if (failures === 3) log(`[live-video] 連續失敗:${String(e?.message || e).slice(0, 200)}`);
      // 壞掉就要真的停。每秒重試一次失敗的 `ls`/`pullFile` 會把 Appium 連線(一次只跑一條指令)
      // 佔住,整個決策迴圈都被拖慢;裝置端的 screenrecord 迴圈也會一直產生永遠不會被刪的分段。
      // job-mvd8vsfb 實測:每步 15.7s → 63.8s,而且 2 小時只跑完 38/50 局。
      if (failures >= maxFailures && !dead) {
        dead = true;
        log(`[live-video] 連續失敗 ${failures} 次,停用即時影片(改用截圖輪播):${String(e?.message || e).slice(0, 200)}`);
        void shutdown();
      }
    } finally {
      busy = false;
    }
  }

  /** 停掉計時器與裝置端迴圈(circuit breaker 與 stop() 共用;不等 busy,因為可能從 tick 內呼叫)。 */
  async function shutdown() {
    active = false;
    if (timer) clearInterval(timer);
    timer = null;
    await client.shell(`rm -rf ${DIR}; pkill -f screenrecord; echo stopped`, 8000).catch(() => {});
  }

  return {
    get uploaded() { return uploaded; },
    /** 為了追上即時而丟掉的段數 / 缺口處數(報告要誠實說證據有缺口)。 */
    get gapStats() { return { dropped, gaps }; },
    /** circuit breaker 跳掉了(連續失敗太多次)→ 呼叫端不該再期待影片。 */
    get dead() { return dead; },
    /** 最近 8 秒內有成功上傳 → 前端可用影片;否則 runner 應回退截圖輪播。 */
    healthy() { return active && !dead && Date.now() - lastOkAt < 8000; },
    async start() {
      // 不指定 --size:screenrecord 每段開始時依「目前螢幕方向」決定寬高(橫向遊戲就錄成橫的)。
      // 指定固定尺寸的話,橫向畫面會被縮成直式框裡的一條。每段 2 秒,轉向後下一段即自動更正。
      // size 只在裝置不支援原生解析度編碼時當備援。
      const rec = (extra) => `screenrecord ${extra}--bit-rate 1500000 --time-limit 2 ${DIR}/s$(date +%s%3N).mp4`;
      // 資料夾被刪(stop() 收尾)或出現 stop 檔都會結束迴圈。
      const loop = `while [ -d ${DIR} ] && [ ! -f ${DIR}/stop ]; do ${rec('')} || ${rec(`--size ${size} `)}; done`;
      const out = await client.shell(`rm -rf ${DIR}; mkdir -p ${DIR}; nohup sh -c '${loop}' >/dev/null 2>&1 & echo started`, 10000);
      if (!/started/.test(String(out))) throw new Error(`screenrecord 迴圈啟動失敗:${String(out).slice(0, 200)}`);
      active = true;
      timer = setInterval(() => { void tick(); }, 1000);
      if (timer.unref) timer.unref();
      log(`[live-video] 已啟動(${size})`);
    },
    async stop() {
      active = false;
      if (timer) { clearInterval(timer); timer = null; }
      for (let i = 0; busy && i < 40; i++) await new Promise((r) => setTimeout(r, 100));
      await shutdown();
    },
  };
}
