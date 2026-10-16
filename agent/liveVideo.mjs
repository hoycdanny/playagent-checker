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
 * @param {(segment:{name:string,buf:Buffer,startedAt:number|null})=>Promise<unknown>} [o.onSegment] 拉回完整 MP4 後的本機證據分析
 */
export function createLiveVideo({ client, put, prefix, size, maxBacklog = 3, preserveBacklog = false, onSegment, log = () => {} }) {
  let timer = null;
  let busy = false;
  let active = false;
  let lastOkAt = 0;
  let uploaded = 0;
  let failures = 0;

  async function tick() {
    if (busy || !active) return;
    busy = true;
    try {
      const done = completedSegments(await client.shell(`ls ${DIR} 2>/dev/null`, 8000));
      if (!done.length) return;
      // 一般即時畫面可丟舊段維持低延遲;盤面證據模式不得丟段,否則無法宣稱逐局完整。
      const drop = !preserveBacklog && done.length > maxBacklog ? done.slice(0, done.length - maxBacklog) : [];
      const send = done.slice(drop.length);
      const sent = [];
      for (const name of send) {
        const b64 = await client.pullFile(`${DIR}/${name}`);
        const buf = Buffer.from(String(b64 || ''), 'base64');
        if (buf.length > 0) {
          await put(`${prefix}/live/${name}`, buf, 'video/mp4');
          if (onSegment) {
            const m = /^s(\d{13})\.mp4$/.exec(name);
            // 證據分析失敗不能中斷即時影片上傳;slot capture 自己會在 manifest 記 analysisFailures。
            await onSegment({ name, buf, startedAt: m ? Number(m[1]) : null }).catch((e) => log(`[live-video] ${name} 證據分析失敗:${String(e?.message || e).slice(0, 200)}`));
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
    } finally {
      busy = false;
    }
  }

  return {
    get uploaded() { return uploaded; },
    /** 最近 8 秒內有成功上傳 → 前端可用影片;否則 runner 應回退截圖輪播。 */
    healthy() { return active && Date.now() - lastOkAt < 8000; },
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
      if (timer) clearInterval(timer);
      for (let i = 0; busy && i < 40; i++) await new Promise((r) => setTimeout(r, 100));
      await client.shell(`rm -rf ${DIR}; pkill -f screenrecord; echo stopped`, 8000).catch(() => {});
    },
  };
}
