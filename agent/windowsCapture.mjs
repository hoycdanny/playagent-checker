/**
 * Windows 主機的即時影片(GameLift Streams 的 Windows 執行環境)。
 *
 * 為什麼不是沿用 liveVideo.mjs
 * ──────────────────────────
 * liveVideo.mjs 靠 adb:在裝置上跑 `screenrecord` 迴圈,再 `ls` / `pullFile` 把分段拉回來。
 * Windows 主機上 runner 與遊戲在同一台機器、同一個桌面 session,沒有 adb 也不需要「拉回」——
 * ffmpeg 直接把分段寫在本機磁碟,看到檔案就上傳。少了一整層往返。
 *
 * 分段命名刻意與 liveVideo 完全相同(`s<13位毫秒>.mp4`,放在 `${prefix}/live/`),
 * 所以 API 的 listMediaSegments 與前端的 LiveScreen / LivePlayer 一行都不用改。
 *
 * 擷取方式的取捨
 * ────────────
 * ddagrab(Desktop Duplication,ffmpeg 6+)是 GPU 路徑,比舊的 gdigrab 省 CPU 也不容易掉格;
 * 主機有 NVIDIA L4,所以優先用 ddagrab + NVENC。但這些都可能因為驅動、ffmpeg 版本或
 * session 沒有真實顯示器而失敗,所以排成一條退路鏈,逐個試到能跑為止。
 *
 * 全部失敗時「不擋測試」:即時畫面本來就還有 2fps 截圖那條路(explorationRunner 的 liveTick),
 * 影片只是把它變順。為了錄影而讓整個任務失敗是本末倒置。
 *
 * 聲音不在這裡
 * ──────────
 * ffmpeg 在 Windows 的輸入裝置走 dshow,不暴露 WASAPI loopback —— 要錄系統播放的聲音得先裝
 * 虛擬音訊驅動(virtual-audio-capturer / VB-CABLE 之類),那是核心模式驅動,在用完就消失的
 * stream session 裡裝不了。所以這個模組只有畫面,沒有聲音;音效要另外用 WASAPI 寫。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** ffmpeg 寫出的暫存分段檔名(序號遞增)。 */
const LOCAL_RE = /^seg(\d{6})\.mp4$/;
/** 每段長度(秒)。與 Android 那條一致,前端的接續播放邏輯是照這個節奏調的。 */
export const SEGMENT_SEC = 2;

/**
 * 擷取指令的退路鏈。逐個試,第一個能持續產出分段的就用。
 *
 * 每一條都有明確的理由存在,不是亂試:
 *   1. ddagrab → NVENC:全程留在 GPU,最省 CPU(CPU 要留給 AI 迴圈與遊戲本身)
 *   2. ddagrab → libx264:Desktop Duplication 可用但 NVENC 不可用(驅動 / 授權 / 編碼器被佔用)
 *   3. gdigrab → libx264:連 Desktop Duplication 都失敗時的最後一條(最耗 CPU,但相容性最好)
 *
 * @param {string} out  分段輸出樣板的目錄
 * @param {number} fps
 */
export function captureCommands(out, fps = 30) {
  // H.264 要求寬高都是偶數,而桌面解析度不保證。本機實測 1512x949 直接讓 ffmpeg 失敗:
  // 「height not divisible by 2 (1512x949)」。所以每一條都要先把尺寸切成偶數。
  const even = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
  const seg = [
    '-f', 'segment',
    '-segment_time', String(SEGMENT_SEC),
    '-segment_format', 'mp4',
    // 每段時間戳歸零:每個 mp4 都能獨立播放(前端是一段一段餵給 <video> 的)。
    '-reset_timestamps', '1',
    join(out, 'seg%06d.mp4'),
  ];
  const common = ['-hide_banner', '-loglevel', 'warning', '-y'];
  return [
    {
      // 硬體編碼:省 CPU(CPU 要留給 AI 迴圈與遊戲)。指令形狀與下面那條相同,
      // 差別只在編碼器,所以能不能用完全取決於主機的 NVIDIA 驅動有沒有開 NVENC。
      // 本機(Tesla T4)實測回「Driver does not support the required nvenc API」而退到下一條;
      // GameLift 主機是 L4-6Q,可能可用,所以還是放第一個試。
      //
      // 註:原本想用 `hwmap=derive_device=cuda` 全程留在 GPU,但本機實測失敗
      // (`Failed to created derived device context: -40`)—— 多張顯示介面卡時,
      // ddagrab 抓到的輸出不一定屬於那張 NVIDIA,衍生 CUDA 裝置就會失敗。改走 hwdownload。
      label: 'ddagrab+nvenc',
      args: [...common,
        '-f', 'lavfi', '-i', `ddagrab=output_idx=0:framerate=${fps}`,
        '-vf', `hwdownload,format=bgra,${even}`,
        '-c:v', 'h264_nvenc', '-b:v', '2500k', '-g', String(fps * 2),
        ...seg],
    },
    {
      // 本機實測可用(exit 0,產出真的分段)。Desktop Duplication 可用但 NVENC 不可用時走這條。
      label: 'ddagrab+x264',
      args: [...common,
        '-f', 'lavfi', '-i', `ddagrab=output_idx=0:framerate=${fps}`,
        '-vf', `hwdownload,format=bgra,${even}`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '2500k', '-pix_fmt', 'yuv420p', '-g', String(fps * 2),
        ...seg],
    },
    {
      // 最後一條:連 Desktop Duplication 都不可用時(最耗 CPU,但相容性最好)。
      label: 'gdigrab+x264',
      args: [...common,
        '-f', 'gdigrab', '-framerate', String(fps), '-draw_mouse', '1', '-i', 'desktop',
        '-vf', even,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '2500k', '-pix_fmt', 'yuv420p', '-g', String(fps * 2),
        ...seg],
    },
  ];
}

/**
 * 已經寫完的分段(排除序號最大的那一個 —— ffmpeg 還在寫它)。
 * 回傳 [{ name, index }],舊 → 新。
 */
export function completedLocal(names) {
  const segs = (names ?? [])
    .map((n) => ({ name: String(n), m: LOCAL_RE.exec(String(n)) }))
    .filter((x) => x.m)
    .map((x) => ({ name: x.name, index: Number(x.m[1]) }))
    .sort((a, b) => a.index - b.index);
  return segs.slice(0, -1);
}

/**
 * 毫秒時間 → S3 檔名(與 liveVideo.mjs 的 segTime 解析格式相同)。
 *
 * 為什麼不能用「開始時間 + 序號 × 段長」推算
 * ──────────────────────────────────────
 * 本機實測(ddagrab,9.3 秒):只產出 2 段,不是預期的 5 段。原因是 Desktop Duplication
 * 在畫面沒有變化時不交付影格,而 `-segment_time` 是按**媒體時間**切的,不是牆鐘時間。
 * 靜止畫面下 9 秒牆鐘只累積約 4 秒媒體時間。
 *
 * 試過兩條路都不行:
 *   - 加 `fps=30` 濾鏡:沒用。fps 濾鏡依輸入 PTS 補格,而 ddagrab 的 PTS 本身就不含
 *     那段「沒有影格」的真實時間,補不回來。
 *   - `-strftime 1` 搭 `%s`:Windows 直接失敗(`Failed to open segment ''`)——
 *     MSVC 的 strftime 不支援 %s。
 *
 * 所以時間戳由上傳端給(見 tick 的 nextTs):以「觀察到這一段寫完」的牆鐘時間為準,
 * 並保證單調遞增。前端只靠檔名排序播放,這樣就夠,而且與 Android 那條的延遲特性一致。
 */
export function segmentName(tsMs) {
  return `s${String(Math.round(tsMs)).padStart(13, '0')}.mp4`;
}

/**
 * 下一段的時間戳:不早於上一段 + 段長(保證單調遞增、檔名排序不會亂),
 * 也不超前「現在減一個段長」(段落內容是剛剛錄完的,不是未來)。
 */
export function nextStamp(lastTs, now = Date.now()) {
  return Math.max(lastTs + SEGMENT_SEC * 1000, now - SEGMENT_SEC * 1000);
}

/**
 * @param {object} o
 * @param {string} o.ffmpeg  ffmpeg.exe 路徑(套件內;缺少就不啟用)
 * @param {(key:string, body:Buffer, type:string)=>Promise<unknown>} o.put
 * @param {string} o.prefix  jobs/<id> 前綴
 * @param {number} [o.fps]
 * @param {number} [o.maxBacklog] 積壓超過這個段數就丟最舊的(維持低延遲)
 * @param {(m:string)=>void} [o.log]
 */
export function createWindowsCapture({ ffmpeg, put, prefix, fps = 30, maxBacklog = 3, dir, log = () => {} }) {
  const workDir = dir ?? join(tmpdir(), `pa_cap_${process.pid}`);
  let proc = null;
  let timer = null;
  let active = false;
  let busy = false;
  let uploaded = 0;
  let lastOkAt = 0;
  let lastTs = 0;
  let label = '';
  let stderrTail = '';

  const clean = () => {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* 清不掉不影響 */ }
  };

  async function tick() {
    if (busy || !active) return;
    busy = true;
    try {
      const done = completedLocal(existsSync(workDir) ? readdirSync(workDir) : []);
      if (!done.length) return;
      // 落後太多就丟最舊的:即時畫面的價值在「即時」,一段落後 30 秒的畫面不如直接跳過。
      const drop = done.length > maxBacklog ? done.slice(0, done.length - maxBacklog) : [];
      for (const s of drop) {
        try { unlinkSync(join(workDir, s.name)); } catch { /* 已經不在就算了 */ }
      }
      if (drop.length) log(`[win-capture] 積壓 ${done.length} 段,丟掉最舊的 ${drop.length} 段以追上即時`);
      for (const s of done.slice(drop.length)) {
        const path = join(workDir, s.name);
        let buf;
        try {
          if (statSync(path).size === 0) continue;
          buf = readFileSync(path);
        } catch { continue; }
        lastTs = nextStamp(lastTs);
        await put(`${prefix}/live/${segmentName(lastTs)}`, buf, 'video/mp4');
        uploaded++;
        lastOkAt = Date.now();
        try { unlinkSync(path); } catch { /* 下一輪會再試 */ }
      }
    } catch (e) {
      log(`[win-capture] 上傳分段失敗:${String(e?.message || e).slice(0, 200)}`);
    } finally {
      busy = false;
    }
  }

  /** 試一條指令:啟動 ffmpeg,等到真的產出第一個分段才算成功。 */
  function attempt(cmd) {
    return new Promise((resolve) => {
      clean();
      mkdirSync(workDir, { recursive: true });
      const p = spawn(ffmpeg, cmd.args, { windowsHide: true });
      let settled = false;
      let tail = '';
      p.stderr?.on('data', (d) => { tail = (tail + String(d)).slice(-1500); });
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(giveUp);
        if (!ok) { try { p.kill(); } catch { /* 已經死了 */ } }
        stderrTail = tail;
        resolve(ok ? p : null);
      };
      p.on('error', () => finish(false));
      p.on('exit', () => finish(false));
      // 「成功」的判準是真的有分段檔出現,不是「程序還活著」——
      // ddagrab 失敗時 ffmpeg 可能活著但一格都產不出來。
      const poll = setInterval(() => {
        const n = existsSync(workDir) ? readdirSync(workDir).filter((f) => LOCAL_RE.test(f)).length : 0;
        if (n > 0) finish(true);
      }, 500);
      // 一段 2 秒,給它 20 秒足夠寬鬆(含 ffmpeg 啟動與第一段寫完)。
      const giveUp = setTimeout(() => finish(false), 20_000);
    });
  }

  return {
    get uploaded() { return uploaded; },
    get mode() { return label; },
    /** 近 8 秒內有成功上傳 = 健康(與 liveVideo 同樣的判準,explorationRunner 據此決定要不要補截圖)。 */
    healthy() { return active && Date.now() - lastOkAt < 8000; },

    /** 依序試擷取方式;成功回 true。失敗不丟錯(影片是加分,不是必要)。 */
    async start() {
      if (!ffmpeg || !existsSync(ffmpeg)) {
        log('[win-capture] 套件內沒有 ffmpeg.exe,即時影片停用(仍有截圖串流)');
        return false;
      }
      for (const cmd of captureCommands(workDir, fps)) {
        log(`[win-capture] 嘗試 ${cmd.label}`);
        const p = await attempt(cmd);
        if (p) {
          proc = p;
          label = cmd.label;
          lastTs = Date.now() - SEGMENT_SEC * 1000;
          active = true;
          lastOkAt = Date.now();
          // ffmpeg 不會自己停,它被 stop() 殺掉。exit 只在異常時才會到。
          proc.on('exit', (code) => {
            if (active) log(`[win-capture] ffmpeg 意外結束 code=${code};${stderrTail.slice(-400)}`);
            active = false;
          });
          timer = setInterval(() => { void tick(); }, 1000);
          if (timer.unref) timer.unref();
          log(`[win-capture] 即時影片已啟動(${label},${fps}fps,每段 ${SEGMENT_SEC}s)`);
          return true;
        }
        log(`[win-capture] ${cmd.label} 不可用:${stderrTail.slice(-300) || '(沒有產出分段)'}`);
      }
      log('[win-capture] 三種擷取方式都不可用,即時影片停用(仍有截圖串流)');
      return false;
    },

    /** 停擷取並把最後幾段收完(測試結束後這些段落就是整場錄影)。 */
    async stop() {
      active = false;
      if (timer) clearInterval(timer);
      timer = null;
      if (proc) {
        // 先好好結束,讓 ffmpeg 把最後一段寫完(直接 kill 會留下壞檔)。
        try { proc.stdin?.write('q'); } catch { /* 管線可能已關 */ }
        await new Promise((r) => {
          const t = setTimeout(() => { try { proc.kill(); } catch { /* 已死 */ } r(undefined); }, 5000);
          proc.on('exit', () => { clearTimeout(t); r(undefined); });
        });
        proc = null;
      }
      // 收尾這一次要連「最新那段」一起送(ffmpeg 已結束,沒有還在寫的檔)。
      try {
        const names = existsSync(workDir) ? readdirSync(workDir).filter((f) => LOCAL_RE.test(f)).sort() : [];
        for (const name of names) {
          const path = join(workDir, name);
          try {
            if (statSync(path).size === 0) continue;
            lastTs = nextStamp(lastTs);
            await put(`${prefix}/live/${segmentName(lastTs)}`, readFileSync(path), 'video/mp4');
            uploaded++;
          } catch { /* 單段失敗不影響其他段 */ }
        }
      } catch (e) {
        log(`[win-capture] 收尾上傳失敗:${String(e?.message || e).slice(0, 200)}`);
      }
      clean();
      log(`[win-capture] 已停止,總共上傳 ${uploaded} 段`);
    },
  };
}
