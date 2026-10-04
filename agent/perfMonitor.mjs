/**
 * Android 真機效能監測(Device Farm Appium endpoint 的 `mobile: shell`,等同 adb shell)。
 *
 * 2026-10-04 實測(Pixel / Android 17,Device Farm 允許 mobile: shell):
 *   - FPS / Frame Time:`dumpsys SurfaceFlinger --timestats`,取被測 App 的 SurfaceView layer 的
 *     totalFrames 與 present2present 直方圖;每次取樣後 -clear,所以每個取樣區間的幀都會被計到
 *     (不是只看取樣瞬間)。Unity/Unreal 用 SurfaceView 繪製,gfxinfo 抓不到,timestats 才準。
 *   - CPU:/proc/<pid>/stat 的 utime+stime 差值 ÷ /proc/uptime 差值 ÷ 核心數(0~100%,同 PerfDog 正規化)。
 *     Appium getPerformanceData('cpuinfo') 對這類 App 會「Unable to parse cpu usage data」→ 舊版顯示 0%。
 *   - 記憶體:dumpsys meminfo <pid> 的 TOTAL PSS 與 Graphics。
 *   - GPU:`dumpsys gpu --gpuwork`(Android 13+ 每 UID GPU active 時間)差值 ÷ 經過時間;
 *     不支援時退回 Qualcomm kgsl gpu_busy_percentage(整機)。
 *   - 溫度:dumpsys battery temperature(電池)+ thermalservice(CPU/GPU/Skin)。
 *   - 耗電:Device Farm 真機全程接 USB 供電,電量 % 不會降;改用 `dumpsys battery unplug` 讓
 *     batterystats 以「未接電」累計,讀取此 App UID 的估算耗電(mAh,Android 依 power profile 模型估算)。
 *     結束時一定 `dumpsys battery reset` 還原。
 *
 * 全部盡力而為:任何一項取不到就不填(報告顯示「未收集」),不得以 0 充數,也不擋測試主流程。
 */

const PKG_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
const round1 = (v) => Math.round(v * 10) / 10;

/** 解析「Xms=N Yms=M」直方圖 → { [ms]: count }(只留非零)。 */
export function parseHistogram(line) {
  const out = {};
  for (const m of String(line || '').matchAll(/(\d+)ms=(\d+)/g)) {
    const n = Number(m[2]);
    if (n > 0) out[m[1]] = (out[m[1]] ?? 0) + n;
  }
  return out;
}

/**
 * 從 timestats dump 找被測 App 的繪製 layer(totalFrames 最多者)。
 * 回 { layer, frames, averageFps, hist } 或 null。
 */
export function parseTimestatsLayer(dump, pkg) {
  const parts = String(dump || '').split(/\n(?=layerName = )/);
  let best = null;
  for (const sec of parts) {
    const name = /^layerName = (.*)$/m.exec(sec)?.[1] ?? '';
    if (!pkg || !name.includes(pkg)) continue;
    const frames = Number(/^totalFrames = (\d+)/m.exec(sec)?.[1] ?? NaN);
    if (!Number.isFinite(frames)) continue;
    const avg = Number(/^averageFPS = ([\d.]+)/m.exec(sec)?.[1] ?? NaN);
    const histLine = /present2present histogram is as below:\s*\n([^\n]*)/.exec(sec)?.[1] ?? '';
    const cand = { layer: name, frames, averageFps: Number.isFinite(avg) ? avg : undefined, hist: parseHistogram(histLine) };
    if (!best || cand.frames > best.frames) best = cand;
  }
  return best;
}

/** /proc/<pid>/stat → { ticks: utime+stime, start }(comm 可能含空白,從最後一個 ')' 之後切)。 */
export function parseProcStat(line) {
  const s = String(line || '');
  const r = s.lastIndexOf(')');
  if (r < 0) return null;
  const f = s.slice(r + 2).trim().split(/\s+/);
  const ut = Number(f[11]), st = Number(f[12]), start = Number(f[19]);
  return Number.isFinite(ut) && Number.isFinite(st) ? { ticks: ut + st, start } : null;
}

/**
 * thermalservice「Temperature{mValue=.., mType=.., mName=..}」→ 各類型最高值(0=CPU 1=GPU 2=電池 3=Skin)。
 * 優先用「Current temperatures from HAL」(即時讀值);「Cached temperatures」只在溫度狀態變化時才更新,
 * 實測整段測試都停在同一個值,只在沒有 HAL 段落時才退用。
 */
export function parseThermal(text) {
  const t = String(text || '');
  const hal = /Current temperatures from HAL:?([\s\S]*?)(?:\n\S[^\n]*(?:temperatures|Cooling|Thermal)|$)/i.exec(t)?.[1];
  const src = hal && /Temperature\{/.test(hal) ? hal : t;
  const max = {};
  for (const m of src.matchAll(/mValue=(-?[\d.]+), mType=(-?\d+), mName=([^,}]+)/g)) {
    const v = Number(m[1]); const t = Number(m[2]);
    if (!Number.isFinite(v) || v <= 0 || v >= 130) continue;
    if (max[t] === undefined || v > max[t]) max[t] = v;
  }
  return max;
}

/** 依標記切段:輸出中以「@@KEY」開頭的行開始一段(同行其餘文字也算進該段)。 */
export function splitSections(out) {
  const map = {};
  let key = null;
  for (const line of String(out || '').split('\n')) {
    const m = /^@@(\w+)\s*(.*)$/.exec(line);
    if (m) { key = m[1]; map[key] = m[2] ? `${m[2]}\n` : ''; continue; }
    if (key) map[key] += `${line}\n`;
  }
  return map;
}

/** batterystats 文字 → { capacityMah?, appMah? }。 */
function parseBatteryStats(text) {
  const cap = Number(/Estimated battery capacity:\s*([\d.]+)/.exec(text || '')?.[1] ?? NaN);
  const mah = Number(/UID u0a\d+:\s*([\d.]+)/.exec(text || '')?.[1] ?? NaN);
  return {
    ...(Number.isFinite(cap) && cap > 0 ? { capacityMah: cap } : {}),
    ...(Number.isFinite(mah) && mah >= 0 ? { appMah: mah } : {}),
  };
}

const BATTERYSTATS_CMD = 'dumpsys batterystats 2>/dev/null | grep -E "Estimated battery capacity|UID u0a$(( ${U:-10000} - 10000 )):"';

export class PerfMonitor {
  #client;
  #pkg;
  #cores = 1;
  #clk = 100;
  #prevCpu = null; // { ticks, start, up }
  #prevGpu = null; // { active, up }
  #prevFpsUp = null;
  #unplugged = false;
  #busy = false;
  #samples = 0;
  enabled = false;
  batteryCapacityMah;
  batteryMah;

  constructor(client, pkg) {
    this.#client = client;
    // 套件名會拼進 shell 指令:只接受合法 Android 套件名,杜絕指令注入。
    this.#pkg = PKG_RE.test(pkg || '') ? pkg : '';
  }

  async #sh(cmd, timeout = 20000) {
    // 一律以 `; true` 收尾:grep 無結果會讓 exit code ≠ 0,Appium 會把它當錯誤丟出。
    return String(await this.#client.shell(`${cmd}; true`, timeout));
  }

  /** 檢查 shell 可用並開啟 timestats / 模擬未接電。不可用回 false(退回 Appium getPerformanceData)。 */
  async start() {
    if (!this.#pkg) return false;
    try {
      const s = splitSections(await this.#sh('echo @@OK; nproc; getconf CLK_TCK'));
      if (s.OK === undefined) return false;
      const [cores, clk] = s.OK.trim().split(/\s+/).map(Number);
      if (cores > 0) this.#cores = cores;
      if (clk > 0) this.#clk = clk;
      await this.#sh('dumpsys SurfaceFlinger --timestats -enable -clear; dumpsys battery unplug; dumpsys batterystats --reset');
      this.#unplugged = true;
      this.enabled = true;
      return true;
    } catch (e) {
      console.warn('[perf] mobile: shell 不可用,退回 getPerformanceData:', e?.message || e);
      return false;
    }
  }

  /** 冷啟動並量測啟動時間(am start -W 的 TotalTime = 啟動到第一幀)。失敗回 null(呼叫端改用 activateApp)。 */
  async launch() {
    if (!this.enabled) return null;
    try {
      const at = new Date().toISOString();
      const out = await this.#sh(`am start -W -n "$(cmd package resolve-activity --brief ${this.#pkg} | tail -n 1)"`, 60000);
      if (!/Status: ok/.test(out)) return null;
      const total = Number(/TotalTime: (\d+)/.exec(out)?.[1] ?? NaN);
      const state = /LaunchState: (\w+)/.exec(out)?.[1];
      return { at, ...(Number.isFinite(total) ? { totalTimeMs: total } : {}), ...(state ? { state } : {}) };
    } catch { return null; }
  }

  /** 一次取樣(單一 shell 往返)。忙碌中(上一個還沒回)直接略過,回 null。 */
  async sample() {
    if (!this.enabled || this.#busy) return null;
    this.#busy = true;
    try {
      const p = this.#pkg;
      const withBattery = this.#samples % 10 === 0;
      const cmd = [
        `P=$(pidof ${p} | cut -d' ' -f1)`,
        'U=$(stat -c %u /proc/$P 2>/dev/null)',
        'echo "@@PID $P $U"',
        'echo @@UP; cat /proc/uptime',
        'echo @@STAT; cat /proc/$P/stat 2>/dev/null',
        'echo @@MEM; dumpsys meminfo $P 2>/dev/null | grep -E "TOTAL PSS|Graphics:"',
        'echo @@BAT; dumpsys battery | grep -E "^  (level|temperature):"',
        'echo @@THERM; dumpsys thermalservice 2>/dev/null | grep -E "Temperature\\{|temperatures"',
        'echo @@GPU; dumpsys gpu --gpuwork 2>/dev/null | grep -E "^[0-9]+ ${U:-x} "',
        'echo @@KGSL; cat /sys/class/kgsl/kgsl-3d0/gpu_busy_percentage 2>/dev/null',
        // 只保留被測 App 的 layer 段落(整份 dump 每個 layer 數 KB)。
        `echo @@FPS; dumpsys SurfaceFlinger --timestats -dump 2>/dev/null | awk '/^layerName = /{k=index($0,"${p}")>0} k'`,
        'dumpsys SurfaceFlinger --timestats -clear >/dev/null 2>&1',
        ...(withBattery ? [`echo @@BS; ${BATTERYSTATS_CMD}`] : []),
      ].join('; ');
      const out = await this.#sh(cmd, 30000);
      this.#samples++;
      return this.#parse(splitSections(out));
    } catch (e) {
      console.warn('[perf] 取樣失敗', e?.message || e);
      return null;
    } finally {
      this.#busy = false;
    }
  }

  #parse(s) {
    const perf = {};
    const up = Number((s.UP || '').trim().split(/\s+/)[0]);
    // CPU(第一次取樣只建基準;程序重啟(starttime 變)也重建基準)
    const st = parseProcStat((s.STAT || '').trim());
    if (st && Number.isFinite(up)) {
      const prev = this.#prevCpu;
      if (prev && prev.start === st.start && up > prev.up) {
        const pct = ((st.ticks - prev.ticks) / this.#clk / (up - prev.up) / this.#cores) * 100;
        if (pct >= 0 && pct <= 100) perf.cpuPct = round1(pct);
      }
      this.#prevCpu = { ...st, up };
    } else {
      this.#prevCpu = null;
    }
    // 記憶體
    const pss = Number(/TOTAL PSS:\s+(\d+)/.exec(s.MEM || '')?.[1] ?? NaN);
    if (Number.isFinite(pss) && pss > 0) perf.memMB = round1(pss / 1024);
    const gfx = Number(/Graphics:\s+(\d+)/.exec(s.MEM || '')?.[1] ?? NaN);
    if (Number.isFinite(gfx) && gfx > 0) perf.gfxMemMB = round1(gfx / 1024);
    // 溫度
    const bt = Number(/temperature:\s*(-?\d+)/.exec(s.BAT || '')?.[1] ?? NaN);
    if (Number.isFinite(bt) && bt > 0) perf.batteryTempC = round1(bt / 10);
    const th = parseThermal(s.THERM);
    if (th[0] !== undefined) perf.cpuTempC = round1(th[0]);
    if (th[1] !== undefined) perf.gpuTempC = round1(th[1]);
    if (th[3] !== undefined) perf.skinTempC = round1(th[3]);
    if (perf.batteryTempC === undefined && th[2] !== undefined) perf.batteryTempC = round1(th[2]);
    // GPU(此 App UID 的 GPU active 時間占比)
    let active = 0, seen = false;
    for (const m of (s.GPU || '').matchAll(/^\d+ \d+ (\d+) (\d+)/gm)) { active += Number(m[1]); seen = true; }
    if (seen && Number.isFinite(up)) {
      const prev = this.#prevGpu;
      if (prev && up > prev.up && active >= prev.active) {
        const pct = ((active - prev.active) / 1e9 / (up - prev.up)) * 100;
        if (pct >= 0 && pct <= 100) perf.gpuPct = round1(pct);
      }
      this.#prevGpu = { active, up };
    } else {
      const k = Number(/(\d+)/.exec(s.KGSL || '')?.[1] ?? NaN);
      if (Number.isFinite(k) && k >= 0 && k <= 100) perf.gpuPct = k;
    }
    // FPS(區間 = 上次 clear 到這次 dump)
    const layer = parseTimestatsLayer(s.FPS, this.#pkg);
    if (layer && Number.isFinite(up)) {
      const span = this.#prevFpsUp !== null && up > this.#prevFpsUp ? up - this.#prevFpsUp : null;
      if (span && span >= 1) {
        const fps = layer.frames / span;
        if (fps >= 0 && fps <= 240) {
          perf.fps = round1(fps);
          perf.frames = layer.frames;
          perf.fpsSpanS = round1(span);
          if (Object.keys(layer.hist).length) perf.frameHist = layer.hist;
        }
      }
    }
    if (Number.isFinite(up)) this.#prevFpsUp = up;
    // 耗電(自 reset 起累計 mAh)
    if (s.BS !== undefined) {
      const b = parseBatteryStats(s.BS);
      if (b.capacityMah) this.batteryCapacityMah = b.capacityMah;
      if (b.appMah !== undefined) { this.batteryMah = b.appMah; perf.batteryMah = Math.round(b.appMah * 1000) / 1000; }
    }
    return Object.keys(perf).length ? perf : null;
  }

  /** 收尾:讀最終耗電、關 timestats、還原電池狀態(一定要還原)。 */
  async stop() {
    if (!this.enabled) return;
    try {
      const out = await this.#sh(`U=$(stat -c %u /proc/$(pidof ${this.#pkg} | cut -d' ' -f1) 2>/dev/null); echo @@BS; ${BATTERYSTATS_CMD}`, 30000);
      const b = parseBatteryStats(splitSections(out).BS);
      if (b.appMah !== undefined && b.appMah >= (this.batteryMah ?? 0)) this.batteryMah = b.appMah;
      if (b.capacityMah) this.batteryCapacityMah = b.capacityMah;
    } catch { /* 盡力 */ }
    try {
      await this.#sh(`dumpsys SurfaceFlinger --timestats -disable${this.#unplugged ? '; dumpsys battery reset' : ''}`);
      this.#unplugged = false;
    } catch { /* 盡力 */ }
  }

  /** 寫進 report.json 的效能中繼資料。 */
  meta(launch) {
    return {
      source: 'adb',
      cores: this.#cores,
      ...(launch ? { launch } : {}),
      ...(this.batteryCapacityMah ? { batteryCapacityMah: this.batteryCapacityMah } : {}),
      ...(this.batteryMah !== undefined ? { batteryMah: Math.round(this.batteryMah * 1000) / 1000 } : {}),
    };
  }
}
