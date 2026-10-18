import { spawn } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSlotBoardTracker } from './slotBoardTracker.mjs';

/**
 * Fu Xing Gao Zhao 3 第一版盤面擷取設定。
 * ROI 是標準化座標,由既有 1280×720 真機截圖量得:五軸轉輪約 x=19%..82%、y=25%..81%。
 * 只用於轉動/停輪判斷與盤面裁切;完整 context 仍保留整張畫面(HUD / WIN / STOP / 彈窗)。
 */
export const FU_XING_CAPTURE_PROFILE = Object.freeze({
  machineId: 'fu-xing-gao-zhao-3',
  appVersion: '4.6.8',
  roi: Object.freeze({ x: 0.19, y: 0.25, w: 0.63, h: 0.56 }),
  fps: 10,
  gridW: 64,
  gridH: 36,
});

function runFfmpeg(args, input, { timeoutMs = 20_000, maxBytes = 128 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    let bytes = 0;
    let done = false;
    const timer = setTimeout(() => { if (!done) child.kill(); }, timeoutMs);
    child.stdout.on('data', (b) => {
      bytes += b.length;
      if (bytes > maxBytes) { child.kill(); return; }
      out.push(b);
    });
    child.stderr.on('data', (b) => err.push(b));
    child.on('error', (e) => { done = true; clearTimeout(timer); reject(e); });
    child.on('close', (code, signal) => {
      done = true; clearTimeout(timer);
      if (code !== 0 || bytes > maxBytes) {
        reject(new Error(`ffmpeg ${signal || code}: ${Buffer.concat(err).toString('utf8').slice(0, 300) || (bytes > maxBytes ? 'output too large' : '')}`));
      } else resolve(Buffer.concat(out));
    });
    if (input) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    } else child.stdin.end();
  });
}

/** MP4 的 moov atom 常在檔尾,ffmpeg 需要 seek；stdin pipe 會報 partial file,故以短效暫存檔解碼。 */
async function withTempMp4(mp4, fn) {
  const file = join(tmpdir(), `pa-slot-${process.pid}-${randomUUID()}.mp4`);
  await writeFile(file, mp4);
  try { return await fn(file); }
  finally { await unlink(file).catch(() => {}); }
}

function roiFilter(roi, tail = '') {
  const crop = `crop=iw*${roi.w}:ih*${roi.h}:iw*${roi.x}:ih*${roi.y}`;
  return tail ? `${crop},${tail}` : crop;
}

/** 從 MP4 取固定 FPS 的盤面 RGB 網格,同時計算灰階 motion 與藍色 feature-game 比例。 */
export async function decodeBoardFrames(mp4, opts = {}) {
  const p = { ...FU_XING_CAPTURE_PROFILE, ...opts, roi: { ...FU_XING_CAPTURE_PROFILE.roi, ...(opts.roi ?? {}) } };
  if (!Buffer.isBuffer(mp4) || mp4.length === 0) throw new TypeError('mp4 must be a non-empty Buffer');
  if (!(p.fps > 0 && p.gridW > 0 && p.gridH > 0)) throw new RangeError('fps/grid dimensions must be positive');
  const vf = `fps=${p.fps},${roiFilter(p.roi, `scale=${p.gridW}:${p.gridH}:flags=area,format=rgb24`)}`;
  // threads:預設 ffmpeg 會吃滿所有核心。runner 是單執行緒 Node,在小容器上被解碼搶走 CPU
  // 之後連截圖與模型呼叫都會變慢(實測每步從 15.7 秒變 30 秒)。固定 1 條執行緒。
  const threads = Math.max(1, Number(p.threads) || 1);
  const raw = await withTempMp4(mp4, (file) => runFfmpeg(['-threads', String(threads), '-i', file, '-an', '-vf', vf, '-f', 'rawvideo', 'pipe:1'], null));
  const pixels = p.gridW * p.gridH;
  const n = pixels * 3;
  const frames = [];
  for (let offset = 0, i = 0; offset + n <= raw.length; offset += n, i++) {
    const gray = new Uint8Array(pixels);
    let blue = 0;
    for (let px = 0; px < pixels; px++) {
      const r = raw[offset + px * 3];
      const g = raw[offset + px * 3 + 1];
      const b = raw[offset + px * 3 + 2];
      gray[px] = Math.round(r * 0.299 + g * 0.587 + b * 0.114);
      // Fu Xing feature game 的轉輪底色是深藍;一般盤面底色偏米黃。只把明顯藍像素納入。
      if (b > 65 && b > r * 1.15 && b > g * 1.08) blue++;
    }
    frames.push({ gray, blueFraction: rounded(blue / pixels), offsetMs: Math.round((i * 1000) / p.fps) });
  }
  return frames;
}

/** 從 MP4 指定時間抽完整 context JPEG 或轉輪 board WebP。 */
export async function extractEvidenceFrame(mp4, offsetMs, { roi = null, format = 'jpeg', quality = 3 } = {}) {
  if (!Buffer.isBuffer(mp4) || mp4.length === 0) throw new TypeError('mp4 must be a non-empty Buffer');
  const ext = format === 'webp' ? 'webp' : 'mjpeg';
  return withTempMp4(mp4, async (file) => {
    const args = ['-ss', String(Math.max(0, offsetMs) / 1000), '-i', file, '-an', '-frames:v', '1'];
    if (roi) args.push('-vf', roiFilter(roi));
    if (format === 'jpeg') args.push('-q:v', String(quality));
    args.push('-f', ext, 'pipe:1');
    return runFfmpeg(args, null, { maxBytes: 12 * 1024 * 1024 });
  });
}

function segmentStart(name) {
  const m = /^s(\d{13})\.mp4$/.exec(String(name));
  return m ? Number(m[1]) : null;
}
const rounded = (n, places = 3) => Number(n.toFixed(places));

/**
 * 影片盤面證據收集器。
 * - onSegment 由 liveVideo 在「拉回裝置端 MP4 後、刪檔前」依序呼叫。
 * - 10 FPS 只在本機比對灰階 ROI;每次 busy→stable 才抽一張 board.webp + context.jpg 上傳。
 * - manifest 每次事件立即覆寫,即使 runner 後來中斷,已抓到的盤面仍可追溯。
 */
export function createSlotVideoCapture({
  put,
  prefix,
  profile = FU_XING_CAPTURE_PROFILE,
  tracker = createSlotBoardTracker({ enterDelta: 9, exitDelta: 2.5, enterFrames: 2, stableFrames: 4, minBusyMs: 300, refractoryMs: 250 }),
  decode = decodeBoardFrames,
  extract = extractEvidenceFrame,
  now = Date.now,
  log = () => {},
}) {
  if (typeof put !== 'function') throw new TypeError('put is required');
  const doc = {
    schemaVersion: 1,
    machineId: profile.machineId,
    appVersion: profile.appVersion,
    capture: { fps: profile.fps, roi: profile.roi, grid: [profile.gridW, profile.gridH], source: 'android-screenrecord' },
    spins: [],
    gaps: [],
    segments: [],
    startedAt: new Date(now()).toISOString(),
    updatedAt: new Date(now()).toISOString(),
  };
  const buffers = new Map();
  let lastSegment = null;
  let currentSession = 1;
  let failures = 0;
  let serial = Promise.resolve();
  const modes = [{ at: -Infinity, active: false, kind: 'unknown', reason: 'initial' }];
  let frameMode = false;
  const modeAt = (t) => {
    for (let i = modes.length - 1; i >= 0; i--) if (modes[i].at <= t) return modes[i];
    return modes[0];
  };

  async function writeManifest(state = 'capturing') {
    doc.updatedAt = new Date(now()).toISOString();
    doc.state = state;
    doc.summary = summary();
    await put(`${prefix}/spins/manifest.json`, JSON.stringify(doc), 'application/json');
  }

  function summary() {
    return {
      detectedSpins: doc.spins.length,
      paidSpins: doc.spins.filter((s) => s.kind === 'paid').length,
      freeSpins: doc.spins.filter((s) => s.kind === 'free').length,
      unknownSpins: doc.spins.filter((s) => s.kind !== 'paid' && s.kind !== 'free').length,
      capturedBoards: doc.spins.filter((s) => s.status === 'captured').length,
      captureFailures: doc.spins.filter((s) => s.status !== 'captured').length,
      segmentCount: doc.segments.length,
      gapCount: doc.gaps.length,
      gapMs: doc.gaps.reduce((a, g) => a + g.ms, 0),
      analysisFailures: failures,
    };
  }

  async function processSegment({ name, buf, startedAt = segmentStart(name), session = currentSession }) {
    if (!Buffer.isBuffer(buf) || !buf.length) return;
    const frames = await decode(buf, profile);
    const durationMs = frames.length ? Math.round((frames[frames.length - 1].offsetMs ?? 0) + 1000 / profile.fps) : 0;
    const start = Number.isFinite(startedAt) ? startedAt : now();
    if (lastSegment && start > lastSegment.startedAt + lastSegment.durationMs + 250) {
      doc.gaps.push({ after: lastSegment.name, before: name, from: lastSegment.startedAt + lastSegment.durationMs, to: start, ms: start - (lastSegment.startedAt + lastSegment.durationMs) });
    }
    doc.segments.push({ name, session, startedAt: start, durationMs, frameCount: frames.length, bytes: buf.length });
    lastSegment = { name, startedAt: start, durationMs };
    buffers.set(name, buf);
    while (buffers.size > 4) buffers.delete(buffers.keys().next().value);

    for (const f of frames) {
      const mode = modeAt(start + f.offsetMs);
      const active = mode.active;
      if (!active) {
        if (frameMode) tracker.reset({ keepSequence: true });
        frameMode = false;
        continue;
      }
      if (!frameMode) tracker.reset({ keepSequence: true });
      frameMode = true;
      // 藍底盤面是 Fu Xing feature/free game 的強視覺訊號,可修正 VLM 看到畫面前那幾局的延遲分類。
      const visualKind = typeof f.blueFraction === 'number' && f.blueFraction >= 0.22 ? 'free' : mode.kind;
      const payload = { segment: name, offsetMs: f.offsetMs, session, kind: visualKind, blueFraction: f.blueFraction, modeReason: mode.reason };
      const ev = tracker.push({ gray: f.gray, t: start + f.offsetMs, frame: payload });
      if (!ev || ev.type !== 'stable_board') continue;
      const source = buffers.get(ev.frame?.segment);
      const seq = ev.sequence;
      const base = `${prefix}/spins/${String(seq).padStart(6, '0')}`;
      const record = {
        sequence: seq,
        session: ev.frame?.session ?? session,
        kind: ev.frame?.kind ?? 'unknown',
        blueFraction: ev.frame?.blueFraction,
        modeReason: ev.frame?.modeReason,
        startedAt: ev.startedAt,
        capturedAt: ev.capturedAt,
        sourceSegment: ev.frame?.segment ?? name,
        sourceOffsetMs: ev.frame?.offsetMs ?? 0,
        busyMs: ev.busyMs,
        stableMs: ev.stableMs,
        confidence: ev.confidence,
        boardKey: `${base}/board.webp`,
        contextKey: `${base}/context.jpg`,
        status: 'captured',
        metrics: ev.metrics,
      };
      try {
        if (!source) throw new Error('source segment was pruned before stable frame extraction');
        const [board, context] = await Promise.all([
          extract(source, record.sourceOffsetMs, { roi: profile.roi, format: 'webp' }),
          extract(source, record.sourceOffsetMs, { format: 'jpeg', quality: 3 }),
        ]);
        if (!board.length || !context.length) throw new Error('empty extracted evidence frame');
        await Promise.all([
          put(record.boardKey, board, 'image/webp'),
          put(record.contextKey, context, 'image/jpeg'),
        ]);
      } catch (e) {
        record.status = 'capture_failed';
        record.error = String(e?.message || e).slice(0, 240);
        failures++;
        log(`[slot-capture] #${seq} 抽幀失敗:${record.error}`);
      }
      doc.spins.push(record);
      await writeManifest();
      log(`[slot-capture] #${seq} ${record.status} confidence=${rounded(record.confidence)}`);
    }
    await writeManifest();
  }

  return {
    setSession(n) { if (Number.isInteger(n) && n > 0) currentSession = n; },
    /** runner 依「已選 AutoSpin / 畫面計數 / Free Spin」標記擷取區間;非擷取區的頁面翻動不算 Spin。 */
    setActive(active, reason = '', at = now(), kind = 'unknown') {
      const value = Boolean(active);
      const normalizedKind = value && (kind === 'paid' || kind === 'free') ? kind : 'unknown';
      const last = modes[modes.length - 1];
      if (last.active === value && last.kind === normalizedKind) return;
      modes.push({ at, active: value, kind: normalizedKind, reason: String(reason).slice(0, 120) });
      doc.modes = modes.filter((m) => Number.isFinite(m.at));
      log(`[slot-capture] ${value ? '開始' : '暫停'}盤面追蹤:${reason}`);
    },
    onSegment(seg) {
      serial = serial.then(() => processSegment(seg), () => processSegment(seg)).catch((e) => {
        failures++;
        log(`[slot-capture] segment ${seg?.name ?? '?'} 分析失敗:${String(e?.message || e).slice(0, 240)}`);
      });
      return serial;
    },
    summary,
    get manifest() { return doc; },
    async stop() {
      await serial;
      doc.finishedAt = new Date(now()).toISOString();
      await writeManifest('complete').catch(() => {});
      return summary();
    },
  };
}
