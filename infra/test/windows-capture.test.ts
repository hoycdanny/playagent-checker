import { describe, expect, test } from 'vitest';
// @ts-expect-error 無 .d.ts 的 .mjs 匯入
const wc = await import('../../agent/windowsCapture.mjs');

/**
 * Windows 主機的即時影片。
 *
 * 這個模組的價值在於「不必改 API 與前端」:分段命名必須和 Android 那條
 * (agent/liveVideo.mjs)完全一致,API 的 listMediaSegments 與前端的播放器才認得。
 * 命名一旦漂掉,症狀是前端安靜地播不出東西 —— 不會跳錯,所以用測試釘住。
 */

describe('分段命名與 Android 那條一致', () => {
  test('s + 13 位毫秒 + .mp4,與 liveVideo.segTime 解得出來的格式相同', async () => {
    const lv = await import('../../agent/liveVideo.mjs');
    const name = wc.segmentName(1792725358153);
    expect(name).toBe('s1792725358153.mp4');
    // 真正的契約:Android 那邊負責解析的函式要認得 Windows 這邊產生的檔名。
    expect(lv.segTime(name)).toBe(1792725358153);
  });
});

/**
 * 時間戳不能用「開始時間 + 序號 × 段長」推算。
 * 本機實測 ddagrab 9.3 秒只產出 2 段(不是 5 段)—— 畫面沒變化就不交付影格,
 * 而 -segment_time 是按媒體時間切的。依序號推算會讓檔名時間與真實時間愈差愈遠。
 */
describe('時間戳:單調遞增,且不超前現在', () => {
  test('至少比上一段晚一個段長(檔名排序不能亂)', () => {
    const now = 1792725400000;
    // 上一段很新 → 這一段只能比它晚 2 秒,不能回頭用「現在」。
    expect(wc.nextStamp(now, now)).toBe(now + 2000);
  });

  test('追不上時以現在為準,不會一直累積在過去', () => {
    const now = 1792725400000;
    // 上一段很舊(例如剛啟動或積壓被丟掉)→ 跳到接近現在,而不是從很久以前慢慢加。
    expect(wc.nextStamp(now - 600_000, now)).toBe(now - 2000);
  });

  test('連續取 5 段都嚴格遞增', () => {
    let last = 0;
    const out: number[] = [];
    for (let i = 0; i < 5; i++) { last = wc.nextStamp(last, 1792725400000); out.push(last); }
    for (let i = 1; i < out.length; i++) expect(out[i]!).toBeGreaterThan(out[i - 1]!);
    // 檔名排序必須與時間順序一致(前端就是照檔名排序播的)。
    const names = out.map((t) => wc.segmentName(t));
    expect([...names].sort()).toEqual(names);
  });
});

describe('只上傳寫完的分段', () => {
  test('排除序號最大的那一個(ffmpeg 還在寫它)', () => {
    const got = wc.completedLocal(['seg000000.mp4', 'seg000001.mp4', 'seg000002.mp4']);
    expect(got.map((s: { name: string }) => s.name)).toEqual(['seg000000.mp4', 'seg000001.mp4']);
  });

  test('只有一個檔案時什麼都不送(那一個正在寫)', () => {
    expect(wc.completedLocal(['seg000000.mp4'])).toEqual([]);
  });

  test('忽略不相干的檔案,並照序號排序而非字串排序', () => {
    const got = wc.completedLocal(['seg000010.mp4', 'seg000002.mp4', 'notes.txt', 'seg000001.mp4']);
    expect(got.map((s: { index: number }) => s.index)).toEqual([1, 2]);
  });

  test('空目錄不會炸', () => {
    expect(wc.completedLocal([])).toEqual([]);
    expect(wc.completedLocal(undefined)).toEqual([]);
  });
});

describe('擷取方式的退路鏈', () => {
  const cmds = wc.captureCommands('C:\\tmp\\cap', 30) as Array<{ label: string; args: string[] }>;

  test('三條,由省 CPU 到相容性優先', () => {
    expect(cmds.map((c) => c.label)).toEqual(['ddagrab+nvenc', 'ddagrab+x264', 'gdigrab+x264']);
  });

  test('每一條都是 2 秒分段 mp4,且時間戳歸零(前端一段一段獨立播)', () => {
    for (const c of cmds) {
      expect(c.args).toContain('-segment_time');
      expect(c.args[c.args.indexOf('-segment_time') + 1]).toBe('2');
      expect(c.args).toContain('-reset_timestamps');
      expect(c.args[c.args.indexOf('-reset_timestamps') + 1]).toBe('1');
      expect(c.args.at(-1)).toContain('seg%06d.mp4');
    }
  });

  test('每一條都把尺寸切成偶數(H.264 的硬要求)', () => {
    // 本機實測:桌面是 1512x949 時,少了這段 ffmpeg 直接失敗
    // 「height not divisible by 2 (1512x949)」。任何奇數尺寸的顯示器都會中。
    for (const c of cmds) {
      expect(c.args.join(' ')).toContain('scale=trunc(iw/2)*2:trunc(ih/2)*2');
    }
  });

  test('前兩條差別只在編碼器:NVENC 不可用就退到 x264,擷取方式不變', () => {
    const [nv, sw] = [cmds[0]!, cmds[1]!];
    expect(nv.args).toContain('h264_nvenc');
    expect(sw.args).toContain('libx264');
    // 都走 ddagrab + hwdownload。原本第一條想用 hwmap=derive_device=cuda 全程留在 GPU,
    // 但本機實測在多張顯示介面卡時失敗(Failed to created derived device context: -40),
    // 所以兩條的擷取與下載方式刻意保持相同 —— 只有編碼器不同,失敗原因才單一可判。
    for (const c of [nv, sw]) {
      expect(c.args.join(' ')).toContain('ddagrab');
      expect(c.args.join(' ')).toContain('hwdownload,format=bgra');
    }
    expect(nv.args.join(' ')).not.toContain('hwmap=derive_device=cuda');
  });

  test('最後一條不碰 Desktop Duplication,只用 GDI', () => {
    const gdi = cmds[2]!;
    expect(gdi.args).toContain('gdigrab');
    expect(gdi.args.join(' ')).not.toContain('ddagrab');
  });

  test('輸出走指定目錄(不是當前工作目錄 —— runner 的工作目錄是 runner 自己那包)', () => {
    for (const c of cmds) expect(c.args.at(-1)!.startsWith('C:\\tmp\\cap')).toBe(true);
  });
});

describe('沒有 ffmpeg 時不擋測試', () => {
  test('start() 回 false 而不是丟錯(影片是加分,不是必要)', async () => {
    const cap = wc.createWindowsCapture({ ffmpeg: 'C:\\does\\not\\exist\\ffmpeg.exe', put: async () => {}, prefix: 'p' });
    await expect(cap.start()).resolves.toBe(false);
    expect(cap.healthy()).toBe(false);
  });

  test('空路徑也一樣(host.ps1 沒設 PA_FFMPEG 時就是空字串)', async () => {
    const cap = wc.createWindowsCapture({ ffmpeg: '', put: async () => {}, prefix: 'p' });
    await expect(cap.start()).resolves.toBe(false);
  });
});
