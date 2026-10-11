/**
 * 遊戲錄影(含聲音)— 整場連續錄一段,測試結束後上傳供回放。
 *
 * 為什麼不再分段(2026-10-05 job-muv1zsvi-0qbt8v 實測):
 *   之前每 20 秒停止 → 重開一段 MediaProjection 錄影。每次重開,Appium Settings 會開一個系統畫面
 *   要錄影權限,遊戲因此失去焦點並自動暫停(割草遊戲跳出「第1章」暫停面板),搖桿走位也被吃掉。
 *   面板出現的時間與每段錄音重開時間逐一吻合(7/7)。
 * 現在的做法:
 *   - 遊戲啟動「之前」開始錄(權限畫面只出現一次,那時遊戲還沒在跑)。
 *   - 一路錄到測試結束才停止;停止時由 Appium 主機直接把檔案用 S3 預簽 POST 上傳
 *     (`stopMediaProjectionRecording` 的 remotePath/formFields,檔案不經 WebDriver base64)。
 *   - 上傳後 runner 下載回來用 ffmpeg 算每 0.1 秒音量,寫 `${prefix}/audio/levels.json`
 *     (前端據此畫波形、標出每一步有沒有音效)。
 *   - 錄影若因 maxDurationSec 自動結束,看門狗會收下這段並開下一段(那一刻遊戲會被暫停一次)。
 * 代價:測試進行中沒有聲音(即時畫面無聲),結束後才有含聲音的完整錄影。
 */
import { execFile } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 跑 ffmpeg 取每 0.1 秒的 RMS(dB);失敗回 null。 */
export function analyzeLevels(file, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    execFile(
      'ffmpeg',
      ['-hide_banner', '-nostats', '-i', file, '-vn', '-ac', '1', '-ar', '44100',
        '-af', 'asetnsamples=n=4410:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
        '-f', 'null', '-'],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) { resolve(null); return; }
        resolve(parseRmsLines(String(stdout)));
      },
    );
  });
}

/** 解析 ametadata 輸出:每個 `lavfi.astats.Overall.RMS_level=<dB>` 一筆(-inf → -120)。 */
export function parseRmsLines(text) {
  const out = [];
  for (const m of text.matchAll(/lavfi\.astats\.Overall\.RMS_level=(-?inf|-?[\d.]+)/g)) {
    const v = m[1].includes('inf') ? -120 : Number(m[1]);
    out.push(Number.isFinite(v) ? Math.round(Math.max(-120, v) * 10) / 10 : -120);
  }
  return out;
}

/** 錄影段檔名(audio/ 底下)。 */
export const recordingName = (idx) => `rec-${idx}.mp4`;

/**
 * @param {object} o
 * @param {{ mobile(name:string, args?:object):Promise<unknown> }} o.client
 * @param {(key:string, body:Buffer|string, type:string)=>Promise<unknown>} o.put 上傳到 S3
 * @param {(key:string)=>Promise<{url:string, fields:Record<string,string>}>} o.presignPost 預簽 POST(給 Appium 主機直傳)
 * @param {(key:string)=>Promise<Buffer>} [o.download] 從 S3 讀回(算音量;整份進記憶體,只適合小檔/測試)
 * @param {(key:string, file:string)=>Promise<number>} [o.downloadTo] 從 S3 串流存到本機檔,回傳位元組數(正式環境用)
 * @param {string} o.prefix 任務前綴(jobs/<id>)
 * @param {number} [o.maxSec] 單段最長秒數(超過自動結束,看門狗接著開下一段)
 * @param {number} [o.watchMs] 看門狗間隔
 * @param {(fn:Function, ms:number)=>any} [o.setIntervalFn] 測試注入
 * @param {(file:string, timeoutMs:number)=>Promise<number[]|null>} [o.analyze] 測試注入
 * @param {number} [o.startIndex] 段號起點(長時模式換新連線後接續,不覆蓋前一段的 rec-N.mp4)
 * @param {Array<object>} [o.initialChunks] 前面連線已收下的段(levels.json 保留)
 */
export function createMediaRecorder({
  client, put, presignPost, download, downloadTo, prefix, maxSec = 9000, watchMs = 30_000, log = () => {},
  setIntervalFn = setInterval, clearIntervalFn = clearInterval, analyze = analyzeLevels,
  startIndex = 0, initialChunks = [],
}) {
  /** 把 S3 上的錄影存到本機檔案,回傳位元組數。優先用串流(downloadTo),沒有才退回整份讀進記憶體。 */
  const downloadToFile = async (key, file) => {
    if (downloadTo) return downloadTo(key, file);
    const b = await download(key);
    await writeFile(file, b);
    return b.length;
  };
  const doc = { schemaVersion: 2, dt: 0.1, chunks: [...initialChunks] }; // chunks: { name, t, dur, rms[] }
  let state = 'none';
  let idx = startIndex;
  let seg = null; // 進行中的段 { name, startedAt }
  let watch = null;
  let busy = Promise.resolve();
  let stopped = false;
  let maxUsed = maxSec;

  const writeDoc = () =>
    put(`${prefix}/audio/levels.json`, JSON.stringify({ ...doc, state, updatedAt: new Date().toISOString() }), 'application/json').catch(() => {});

  async function startSegment() {
    const name = recordingName(idx++);
    const args = { resolution: '720x480', maxDurationSec: maxUsed, priority: 'low', filename: name };
    let started;
    try {
      started = await client.mobile('startMediaProjectionRecording', args);
    } catch (e) {
      // 部分版本不接受太長的 maxDurationSec:退回預設 15 分鐘(之後看門狗每 15 分鐘接一段)。
      if (maxUsed > 900) {
        log(`[record] maxDurationSec=${maxUsed} 被拒,改用 900:${String(e?.message || e).slice(0, 160)}`);
        maxUsed = 900;
        started = await client.mobile('startMediaProjectionRecording', { ...args, maxDurationSec: 900 });
      } else throw e;
    }
    if (started === false) {
      // 有殘留錄影在跑:先停掉丟棄再開。
      await client.mobile('stopMediaProjectionRecording').catch(() => {});
      started = await client.mobile('startMediaProjectionRecording', args);
    }
    seg = { name, startedAt: Date.now() };
    state = 'recording';
    await writeDoc();
    log(`[record] 開始錄影 ${name}(最長 ${maxUsed} 秒)`);
  }

  /** 停止目前這段 → 上傳 → 算音量 → 寫 levels.json。autoEnded = 已因長度上限自己結束。 */
  async function finishSegment(autoEnded = false) {
    if (!seg) return;
    const { name, startedAt } = seg;
    seg = null;
    const key = `${prefix}/audio/${name}`;
    const stopAt = Date.now();
    let buf = null;
    try {
      const post = await presignPost(key);
      await client.mobile('stopMediaProjectionRecording', {
        remotePath: post.url, method: 'POST', fileFieldName: 'file', formFields: post.fields, uploadTimeout: 600_000,
      });
    } catch (e) {
      // 直傳失敗:同一段錄影可再呼叫 stop(不帶 remotePath)以 base64 取回,由 runner 自己上傳。
      log(`[record] 直傳 S3 失敗,改用 base64 取回:${String(e?.message || e).slice(0, 200)}`);
      try {
        const b64 = await client.mobile('stopMediaProjectionRecording');
        buf = Buffer.from(String(b64 || ''), 'base64');
        if (buf.length) await put(key, buf, 'video/mp4');
        else buf = null;
      } catch (e2) {
        log(`[record] 取回錄影失敗:${String(e2?.message || e2).slice(0, 200)}`);
        return;
      }
      if (!buf) return;
    }
    // 讀回算音量(波形 / 每步有無音效)。
    // 2026-10-11(job-mv36ywqa):兩小時的錄影 2.48 GB,舊版整個讀進記憶體 → 2 GB 的容器被系統砍掉,
    // 報告與最終狀態都沒寫出(任務停在「執行中」)。改成直接串流寫到暫存檔,記憶體用量與檔案大小無關。
    let rms = [];
    let bytes = buf?.length ?? 0;
    const tmp = join(tmpdir(), `pa-rec-${stopAt}.mp4`);
    try {
      if (buf) await writeFile(tmp, buf);
      else bytes = await downloadToFile(key, tmp);
      buf = null; // base64 取回的那份也不再留在記憶體
      rms = (await analyze(tmp, 300_000)) ?? [];
    } catch (e) {
      log(`[record] 音量分析失敗(錄影仍保留):${String(e?.message || e).slice(0, 200)}`);
    } finally {
      await unlink(tmp).catch(() => {});
    }
    const dur = rms.length ? rms.length * doc.dt : Math.max(0, (stopAt - startedAt) / 1000);
    // 對時:正常停止 → 結束時間 = stop 呼叫當下,往回推長度;自己結束的段 → 用開始時間。
    const t = Math.round(autoEnded ? startedAt : stopAt - dur * 1000);
    doc.chunks.push({ name, t, dur: Math.round(dur * 10) / 10, rms, bytes });
    await writeDoc();
    log(`[record] ${name} 已上傳(${Math.round(bytes / 1024 / 1024)} MB,${Math.round(dur)} 秒)`);
  }

  /** 看門狗:錄影因長度上限自己結束 → 收下這段並開下一段。 */
  async function check() {
    if (stopped || !seg) return;
    let running = true;
    try { running = (await client.mobile('isMediaProjectionRecordingRunning')) !== false; } catch { return; }
    if (running || stopped) return;
    log('[record] 錄影已達長度上限,收下這段並開始下一段');
    await finishSegment(true);
    if (!stopped) await startSegment().catch((e) => log(`[record] 重開失敗:${String(e?.message || e).slice(0, 200)}`));
  }
  const serial = (fn) => { busy = busy.then(fn, fn); return busy; };

  return {
    get state() { return state; },
    get chunks() { return doc.chunks; },
    /** 下一段的段號(換新連線時給新的 recorder 接續)。 */
    get nextIndex() { return idx; },
    /** 遊戲啟動前呼叫(權限畫面只會在這時出現一次)。失敗不影響測試。 */
    async start() {
      try {
        await startSegment();
        watch = setIntervalFn(() => { void serial(check); }, watchMs);
        return true;
      } catch (e) {
        state = 'unavailable';
        await writeDoc();
        log(`[record] 此裝置無法錄影(含聲音):${String(e?.message || e).slice(0, 200)}`);
        return false;
      }
    },
    /** 測試結束時呼叫(必須在 quit session 之前)。 */
    async stop() {
      stopped = true;
      if (watch) clearIntervalFn(watch);
      await serial(() => finishSegment(false));
      if (state === 'recording') {
        state = doc.chunks.length ? 'on' : 'unavailable';
        await writeDoc();
      }
    },
  };
}
