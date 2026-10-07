import { stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { Action, ActionResult } from '../../domain/action.js';
import type { Artifact } from '../../domain/artifact.js';
import type { Size } from '../../domain/coordinates.js';
import type { Health, MetricSample } from '../../domain/metrics.js';
import { createWorkerStateMachine, type WorkerState } from '../../domain/stateMachine.js';
import { runCommand, spawnBackground, type CommandResult, type CommandRunner } from '../commandRunner.js';
import {
  EnvironmentError,
  pngSize,
  type ArtifactSink,
  type BuildInput,
  type EnvironmentConfig,
  type GameWorker,
  type Screenshot,
} from '../GameWorker.js';

/**
 * Android Worker:EC2 C8i(x86_64,nested virtualization 開 KVM)+ Android Emulator + ADB。
 *
 * 限制(誠實標註):
 *  - C8i 沒有 GPU,Emulator 用 swiftshader_indirect(CPU 軟體繪圖);重 3D 遊戲 FPS 會偏低。
 *  - x86_64 系統映像跑 ARM-only 遊戲要靠映像內建的 ARM 轉譯(Android 11+),少數遊戲不相容。
 *  - 有反模擬器檢查的遊戲(例如先前 Redroid 遇到的 50019999)在 Emulator 上同樣可能被擋,這類遊戲仍需 Device Farm 真機。
 *  - `adb shell input text` 只能可靠輸入 ASCII;中文等需要 ADB Keyboard IME(這裡回 unsupported)。
 *  - screenrecord 單段最長 180 秒且不含聲音;這裡在裝置上連續分段錄,聲音由主機端擷取(另一個模組)。
 */
export interface AndroidWorkerOptions {
  avdName: string;
  /** emulator 序號,例:emulator-5554(對應 -port 5554)。 */
  serial?: string;
  adbPath?: string;
  emulatorPath?: string;
  /** 'swiftshader_indirect'(無 GPU,預設)或 'host'(有 GPU 的機型)。 */
  gpuMode?: 'swiftshader_indirect' | 'host';
  bootTimeoutMs?: number;
  sink: ArtifactSink;
  runner?: CommandRunner;
  spawn?: (file: string, args: readonly string[]) => Pick<ChildProcess, 'kill' | 'pid'>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

const PKG_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
/** adb shell 會把參數再交給裝置端 shell:文字只收安全字元。 */
const SAFE_TEXT = /^[A-Za-z0-9@._\- ]{1,200}$/;
const KEYCODES: Record<string, number> = {
  enter: 66, esc: 111, tab: 61, backspace: 67, delete: 112, space: 62,
  up: 19, down: 20, left: 21, right: 22, home: 3, pageup: 92, pagedown: 93,
};
const REC_DIR = '/sdcard/pa_rec';

export class AndroidEmulatorWorker implements GameWorker {
  readonly platform = 'android' as const;
  readonly #sm = createWorkerStateMachine();
  readonly #o: Required<Omit<AndroidWorkerOptions, 'sink' | 'runner' | 'spawn' | 'sleep' | 'now'>>;
  readonly #sink: ArtifactSink;
  readonly #run: CommandRunner;
  readonly #spawn: NonNullable<AndroidWorkerOptions['spawn']>;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => Date;
  #emulator: Pick<ChildProcess, 'kill' | 'pid'> | null = null;
  #pkg: string | null = null;
  #gameStarted = false;
  #healthSince: number;
  #recording = false;

  constructor(o: AndroidWorkerOptions) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(o.avdName)) throw new Error(`avdName 不合法:${o.avdName}`);
    this.#o = {
      avdName: o.avdName,
      serial: o.serial ?? 'emulator-5554',
      adbPath: o.adbPath ?? 'adb',
      emulatorPath: o.emulatorPath ?? 'emulator',
      gpuMode: o.gpuMode ?? 'swiftshader_indirect',
      bootTimeoutMs: o.bootTimeoutMs ?? 6 * 60_000,
    };
    if (!/^emulator-\d{4,5}$/.test(this.#o.serial)) throw new Error(`serial 不合法:${this.#o.serial}`);
    this.#sink = o.sink;
    this.#run = o.runner ?? runCommand;
    this.#spawn = o.spawn ?? ((f, a) => spawnBackground(f, a));
    this.#sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#now = o.now ?? (() => new Date());
    this.#healthSince = this.#now().getTime();
  }

  get state(): WorkerState {
    return this.#sm.state;
  }

  // ───────── 生命週期 ─────────

  async initialize(): Promise<void> {
    this.#sm.transition('BOOTING');
    try {
      await this.#boot();
      this.#sm.transition('READY');
    } catch (e) {
      this.#sm.transition('FAILED', String(e));
      throw e;
    }
  }

  async #boot(): Promise<void> {
    const port = this.#o.serial.split('-')[1]!;
    this.#emulator = this.#spawn(this.#o.emulatorPath, [
      '-avd', this.#o.avdName, '-port', port,
      '-no-window', '-no-boot-anim', '-no-snapshot-save',
      '-gpu', this.#o.gpuMode, '-accel', 'on',
    ]);
    const deadline = this.#now().getTime() + this.#o.bootTimeoutMs;
    await this.#adb(['wait-for-device'], this.#o.bootTimeoutMs, 'Emulator 沒有出現在 adb');
    while (this.#now().getTime() < deadline) {
      const r = await this.#adbRaw(['shell', 'getprop', 'sys.boot_completed'], 15_000);
      if (r.stdout.toString().trim() === '1') return;
      await this.#sleep(3_000);
    }
    throw new EnvironmentError(`Emulator 在 ${Math.round(this.#o.bootTimeoutMs / 1000)} 秒內沒有開機完成`);
  }

  async prepareEnvironment(config: EnvironmentConfig): Promise<{ framebuffer: Size }> {
    this.#sm.transition('PREPARING');
    const { width, height } = config.display;
    // Android 的自然方向是直向:wm size 一律用「短邊 x 長邊」,遊戲自己決定要不要轉橫向。
    const w = Math.min(width, height);
    const h = Math.max(width, height);
    await this.#adb(['shell', 'wm', 'size', `${w}x${h}`], 15_000, '設定解析度失敗');
    const shot = await this.screenshot();
    const got = [Math.min(shot.size.width, shot.size.height), Math.max(shot.size.width, shot.size.height)];
    if (got[0] !== w || got[1] !== h) {
      this.#sm.transition('FAILED', 'framebuffer mismatch');
      throw new EnvironmentError(`實際畫面 ${shot.size.width}×${shot.size.height} 和設定 ${w}×${h} 不符`);
    }
    return { framebuffer: shot.size };
  }

  async installGame(build: BuildInput): Promise<void> {
    if (!PKG_RE.test(build.entry)) throw new Error(`Android package 名稱不合法:${build.entry}`);
    this.#sm.transition('INSTALLING');
    const info = await stat(build.localPath);
    let r: CommandResult;
    if (info.isDirectory()) {
      // split APK(XAPK 解開後的目錄):install-multiple 一次裝。
      const apks = (await readdir(build.localPath)).filter((f) => f.endsWith('.apk')).sort().map((f) => join(build.localPath, f));
      if (!apks.length) throw new EnvironmentError('split APK 目錄裡沒有 .apk');
      r = await this.#adbRaw(['install-multiple', '-r', '-g', '-t', ...apks], 15 * 60_000);
    } else {
      r = await this.#adbRaw(['install', '-r', '-g', '-t', build.localPath], 15 * 60_000);
    }
    const out = `${r.stdout.toString()}\n${r.stderr}`;
    if (r.timedOut || !/Success/.test(out)) {
      this.#sm.transition('FAILED', 'install failed');
      throw new EnvironmentError('APK 安裝失敗', out.slice(-2000));
    }
    this.#pkg = build.entry;
  }

  async startGame(): Promise<void> {
    const pkg = this.#requirePkg();
    const r = await this.#adbRaw(['shell', 'cmd', 'package', 'resolve-activity', '--brief', '-c', 'android.intent.category.LAUNCHER', '-a', 'android.intent.action.MAIN', pkg], 15_000);
    const activity = r.stdout.toString().trim().split('\n').pop()?.trim() ?? '';
    if (/^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/.test(activity)) {
      await this.#adb(['shell', 'am', 'start', '-W', '-n', activity], 60_000, '啟動遊戲失敗');
    } else {
      await this.#adb(['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'], 30_000, '啟動遊戲失敗');
    }
    this.#gameStarted = true;
    if (this.#sm.state !== 'RUNNING') this.#sm.transition('RUNNING');
  }

  async stopGame(): Promise<void> {
    const pkg = this.#requirePkg();
    await this.#adb(['shell', 'am', 'force-stop', pkg], 15_000, '關閉遊戲失敗');
    this.#gameStarted = false;
  }

  async restartGame(): Promise<void> {
    if (this.#sm.state === 'RUNNING') this.#sm.transition('RECOVERING', 'restartGame');
    await this.stopGame();
    await this.startGame();
  }

  async restartEnvironment(): Promise<void> {
    if (this.#sm.state !== 'RECOVERING') this.#sm.transition('RECOVERING', 'restartEnvironment');
    await this.#killEmulator();
    await this.#boot();
    if (this.#pkg) await this.startGame();
  }

  beginCollecting(): void {
    this.#sm.transition('COLLECTING_ARTIFACTS');
  }

  finish(outcome: 'completed' | 'failed'): void {
    this.#sm.transition(outcome === 'completed' ? 'COMPLETED' : 'FAILED');
  }

  async cleanup(): Promise<void> {
    if (this.#recording) await this.stopRecording().catch(() => []);
    await this.#killEmulator();
    if (this.#sm.state !== 'TERMINATED') this.#sm.transition('TERMINATED');
  }

  async #killEmulator(): Promise<void> {
    await this.#adbRaw(['emu', 'kill'], 20_000).catch(() => null);
    this.#emulator?.kill('SIGKILL');
    this.#emulator = null;
  }

  // ───────── 操作 ─────────

  async executeAction(a: Action): Promise<ActionResult> {
    const t0 = this.#now().getTime();
    const done = (ok: boolean, extra: Partial<ActionResult> = {}): ActionResult => ({ ok, action: a.action, durationMs: this.#now().getTime() - t0, ...extra });
    const n = (v: number) => String(Math.round(v));
    try {
      switch (a.action) {
        case 'tap':
          await this.#input(['tap', n(a.x), n(a.y)]);
          return done(true, { devicePoint: { x: a.x, y: a.y } });
        case 'doubleTap':
          await this.#input(['tap', n(a.x), n(a.y)]);
          await this.#sleep(80);
          await this.#input(['tap', n(a.x), n(a.y)]);
          return done(true, { devicePoint: { x: a.x, y: a.y } });
        case 'longPress':
          await this.#input(['swipe', n(a.x), n(a.y), n(a.x), n(a.y), String(a.durationMs)]);
          return done(true, { devicePoint: { x: a.x, y: a.y } });
        case 'swipe':
        case 'drag':
          await this.#input(['swipe', n(a.x), n(a.y), n(a.x2), n(a.y2), String(a.durationMs)]);
          return done(true, { devicePoint: { x: a.x, y: a.y }, devicePoint2: { x: a.x2, y: a.y2 } });
        case 'keyboard':
          if (!SAFE_TEXT.test(a.text)) return done(false, { error: 'unsupported', message: 'adb input text 只支援英數與 @._- 空白;其他文字需要安裝 ADB Keyboard 輸入法' });
          await this.#input(['text', a.text.replace(/ /g, '%s')]);
          return done(true);
        case 'hotkey': {
          if (a.keys.length !== 1) return done(false, { error: 'unsupported', message: 'Android 只支援單一按鍵' });
          const code = KEYCODES[a.keys[0]!];
          if (code === undefined) return done(false, { error: 'unsupported', message: `不支援的按鍵:${a.keys[0]}` });
          await this.#input(['keyevent', String(code)]);
          return done(true);
        }
        case 'back':
          await this.#input(['keyevent', '4']);
          return done(true);
        case 'wait':
          await this.#sleep(a.durationMs);
          return done(true);
        case 'screenshot':
        case 'terminateTest':
          return done(true);
        case 'restartApp':
          await this.restartGame();
          return done(true);
        case 'restartDevice':
          await this.restartEnvironment();
          return done(true);
      }
    } catch (e) {
      return done(false, { error: 'device_error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  async screenshot(): Promise<Screenshot> {
    const r = await this.#adbRaw(['exec-out', 'screencap', '-p'], 20_000);
    const size = pngSize(r.stdout);
    if (r.timedOut || !size) throw new EnvironmentError('截圖失敗', r.stderr.slice(-500));
    return { png: r.stdout, size, at: this.#now().toISOString() };
  }

  // ───────── 錄影(裝置端連續分段;單段上限 180 秒)─────────

  async startRecording(): Promise<void> {
    if (this.#recording) return;
    await this.#adb(['shell', 'rm', '-rf', REC_DIR], 15_000, '清錄影目錄失敗');
    await this.#adb(['shell', 'mkdir', '-p', REC_DIR], 15_000, '建錄影目錄失敗');
    await this.#adb(['shell', 'touch', `${REC_DIR}/.on`], 15_000, '開始錄影失敗');
    // 固定腳本(不含任何外部輸入):旗標檔存在就一段接一段錄。
    const loop = `i=0; while [ -f ${REC_DIR}/.on ]; do screenrecord --time-limit 170 ${REC_DIR}/seg_$i.mp4; i=$((i+1)); done`;
    await this.#adb(['shell', `nohup sh -c '${loop}' >/dev/null 2>&1 &`], 15_000, '開始錄影失敗');
    this.#recording = true;
  }

  async stopRecording(): Promise<Artifact[]> {
    if (!this.#recording) return [];
    this.#recording = false;
    await this.#adbRaw(['shell', 'rm', '-f', `${REC_DIR}/.on`], 15_000);
    await this.#adbRaw(['shell', 'pkill', '-INT', 'screenrecord'], 15_000);
    await this.#sleep(2_000); // 等最後一段寫完 moov
    const ls = await this.#adbRaw(['shell', 'ls', REC_DIR], 15_000);
    const files = ls.stdout.toString().split(/\s+/).filter((f) => /^seg_\d+\.mp4$/.test(f))
      .sort((x, y) => Number(x.slice(4, -4)) - Number(y.slice(4, -4)));
    const out: Artifact[] = [];
    for (const f of files) {
      const r = await this.#adbRaw(['exec-out', 'cat', `${REC_DIR}/${f}`], 5 * 60_000);
      // 檔名 rec-<n>.mp4:和既有錄影播放器(audio/rec-N.mp4)同一套命名。
      if (r.stdout.length) out.push(await this.#sink.put('recording', `rec-${f.slice(4, -4)}.mp4`, r.stdout, 'video/mp4'));
    }
    return out;
  }

  // ───────── 指標 / 健康 / log ─────────

  async getMetrics(): Promise<MetricSample> {
    const timestamp = this.#now().toISOString();
    const state = (await this.#adbRaw(['get-state'], 10_000)).stdout.toString().trim();
    const sample: MetricSample = { timestamp, adbState: state === 'device' || state === 'offline' || state === 'unauthorized' ? state : 'unknown' };
    if (!this.#pkg || sample.adbState !== 'device') return sample;
    const mem = (await this.#adbRaw(['shell', 'dumpsys', 'meminfo', this.#pkg], 20_000)).stdout.toString();
    const pss = /TOTAL PSS:\s*(\d+)/.exec(mem) ?? /^\s*TOTAL\s+(\d+)/m.exec(mem);
    if (pss) sample.processMemMb = Math.round(Number(pss[1]) / 1024);
    const cpu = (await this.#adbRaw(['shell', 'dumpsys', 'cpuinfo'], 20_000)).stdout.toString();
    const line = cpu.split('\n').find((l) => l.includes(this.#pkg!));
    const pct = line ? /([\d.]+)%/.exec(line) : null;
    if (pct) sample.processCpuPct = Number(pct[1]);
    return sample;
  }

  async checkHealth(): Promise<Health> {
    const timestamp = this.#now().toISOString();
    const problems: Health['problems'] = [];
    const state = (await this.#adbRaw(['get-state'], 10_000)).stdout.toString().trim();
    const reachable = state === 'device';
    if (!reachable) problems.push(this.#emulator ? 'device_disconnected' : 'device_crashed');
    let booted = false;
    let gameRunning = false;
    let detail = '';
    if (reachable) {
      booted = (await this.#adbRaw(['shell', 'getprop', 'sys.boot_completed'], 10_000)).stdout.toString().trim() === '1';
      if (!booted) problems.push('not_booted');
      if (this.#pkg) {
        gameRunning = (await this.#adbRaw(['shell', 'pidof', this.#pkg], 10_000)).stdout.toString().trim() !== '';
        // events buffer 的 am_crash / am_anr(只看上次檢查之後)。
        const since = (this.#healthSince / 1000).toFixed(3);
        this.#healthSince = this.#now().getTime();
        const ev = (await this.#adbRaw(['logcat', '-d', '-b', 'events', '-v', 'epoch', '-T', since], 20_000)).stdout.toString();
        const mine = ev.split('\n').filter((l) => l.includes(this.#pkg!));
        const anr = mine.filter((l) => l.includes('am_anr'));
        const crash = mine.filter((l) => l.includes('am_crash'));
        if (anr.length) problems.push('anr');
        if (crash.length || (this.#gameStarted && !gameRunning)) problems.push('game_crashed');
        detail = [...anr, ...crash].slice(0, 5).join('\n');
      }
    }
    return { timestamp, deviceReachable: reachable, deviceBooted: booted, gameRunning, problems, ...(detail ? { detail } : {}) };
  }

  async collectLogs(): Promise<Artifact[]> {
    const stamp = this.#now().toISOString().replace(/[:.]/g, '-');
    const out: Artifact[] = [];
    const logcat = await this.#adbRaw(['logcat', '-d', '-v', 'threadtime'], 60_000);
    if (logcat.stdout.length) out.push(await this.#sink.put('device_log', `logcat/${stamp}.txt`, logcat.stdout, 'text/plain; charset=utf-8'));
    const crash = await this.#adbRaw(['logcat', '-d', '-b', 'crash', '-v', 'threadtime'], 30_000);
    if (crash.stdout.length) out.push(await this.#sink.put('crash', `logcat-crash-${stamp}.txt`, crash.stdout, 'text/plain; charset=utf-8'));
    return out;
  }

  // ───────── 內部 ─────────

  #requirePkg(): string {
    if (!this.#pkg) throw new Error('尚未安裝遊戲');
    return this.#pkg;
  }
  async #input(args: string[]): Promise<void> {
    await this.#adb(['shell', 'input', ...args], 15_000, '輸入事件失敗');
  }
  #adbRaw(args: string[], timeoutMs: number): Promise<CommandResult> {
    return this.#run(this.#o.adbPath, ['-s', this.#o.serial, ...args], { timeoutMs });
  }
  async #adb(args: string[], timeoutMs: number, what: string): Promise<CommandResult> {
    const r = await this.#adbRaw(args, timeoutMs);
    if (r.timedOut) throw new EnvironmentError(`${what}(逾時)`);
    if (r.code !== 0) throw new EnvironmentError(what, r.stderr.slice(-1000));
    return r;
  }
}
