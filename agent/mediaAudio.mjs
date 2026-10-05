/**
 * 遊戲音效錄製(MediaProjection,含畫面 + 聲音)與音量時間軸。
 *
 * 2026-10-05 Device Farm 實測(Pixel 11 Pro XL / Android 17):
 *   - `mobile: startMediaProjectionRecording` 可用,錄到的 AAC 音軌有真實遊戲聲音
 *     (大廳 BGM mean -19 dB / max -3 dB);遊戲還在載入、沒出聲時是 -91 dB(全靜音)。
 *   - start 約 3.7–4.1 秒、stop 約 1.5–2.6 秒(回傳整段 base64)→ 段與段之間約 5–6 秒空檔。
 *   - 錄影檔要停止後才拿得到(mp4 的 moov 在檔尾),所以「含音效」畫面必然延遲約一段長度。
 *
 * 做法:每 chunkSec 秒一段,停止 → 上傳 `${prefix}/audio/a<開始ms>.mp4` → 用 ffmpeg 算每 0.1 秒
 * RMS 音量,累積寫進 `${prefix}/audio/levels.json`(前端據此標出每一步有沒有音效)。
 */
import { execFile } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 跑 ffmpeg 取每 0.1 秒的 RMS(dB);失敗回 null。 */
export function analyzeLevels(file, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    execFile(
      'ffmpeg',
      ['-hide_banner', '-nostats', '-i', file, '-vn', '-ac', '1', '-ar', '44100',
        '-af', 'asetnsamples=n=4410:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
        '-f', 'null', '-'],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
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

/**
 * @param {object} o
 * @param {{ mobile(name:string, args?:object):Promise<unknown> }} o.client
 * @param {(key:string, body:Buffer|string, type:string)=>Promise<unknown>} o.put
 * @param {string} o.prefix
 */
export function createMediaAudio({ client, put, prefix, chunkSec = 20, log = () => {} }) {
  let active = false;
  let loopPromise = null;
  let failures = 0;
  const doc = { schemaVersion: 1, dt: 0.1, chunks: [] }; // chunks: { name, t, dur, rms[] }
  let state = 'starting';

  async function oneChunk() {
    const started = await client.mobile('startMediaProjectionRecording', {
      resolution: '720x480',
      maxDurationSec: chunkSec + 60,
      priority: 'low', // 降低對遊戲效能(FPS)的影響
    });
    if (started === false) {
      // 有殘留錄影在跑:先停掉丟棄。
      await client.mobile('stopMediaProjectionRecording').catch(() => {});
      return false;
    }
    const until = Date.now() + chunkSec * 1000;
    while (active && Date.now() < until) await sleep(250);
    const stopAt = Date.now();
    const b64 = await client.mobile('stopMediaProjectionRecording');
    const buf = Buffer.from(String(b64 || ''), 'base64');
    if (!buf.length) return false;

    const tmp = join(tmpdir(), `pa-audio-${stopAt}.mp4`);
    await writeFile(tmp, buf);
    const rms = (await analyzeLevels(tmp)) ?? [];
    await unlink(tmp).catch(() => {});
    const dur = rms.length ? rms.length * doc.dt : chunkSec;
    // 錄影實際開始 ≈ 停止時間 − 段長(start 呼叫本身要好幾秒,用它當開始時間會偏)。
    const t = Math.round(stopAt - dur * 1000);
    const name = `a${String(t).padStart(13, '0')}.mp4`;
    await put(`${prefix}/audio/${name}`, buf, 'video/mp4');
    doc.chunks.push({ name, t, dur: Math.round(dur * 10) / 10, rms });
    await put(`${prefix}/audio/levels.json`, JSON.stringify({ ...doc, state: 'on', updatedAt: new Date().toISOString() }), 'application/json');
    return true;
  }

  async function loop() {
    while (active) {
      try {
        const ok = await oneChunk();
        if (ok) { failures = 0; state = 'on'; } else failures++;
      } catch (e) {
        failures++;
        log(`[audio] 錄音段失敗(${failures}):${String(e?.message || e).slice(0, 200)}`);
        await sleep(3000);
      }
      if (failures >= 3 && doc.chunks.length === 0) {
        state = 'unavailable';
        log('[audio] 此裝置無法錄製音效,停用');
        await put(`${prefix}/audio/levels.json`, JSON.stringify({ ...doc, state, updatedAt: new Date().toISOString() }), 'application/json').catch(() => {});
        active = false;
      } else if (failures >= 6) {
        state = 'stopped';
        active = false;
      }
    }
  }

  return {
    get state() { return state; },
    start() {
      if (active) return;
      active = true;
      loopPromise = loop();
      log(`[audio] 已啟動(每段 ${chunkSec} 秒)`);
    },
    async stop() {
      active = false;
      // 讓進行中的那段收尾上傳(最多等 30 秒),避免最後一段聲音遺失。
      if (loopPromise) await Promise.race([loopPromise, sleep(30_000)]);
      await client.mobile('stopMediaProjectionRecording').catch(() => {});
    },
  };
}
