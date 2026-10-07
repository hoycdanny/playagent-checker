import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { AndroidEmulatorWorker } from '../src/worker/android/AndroidEmulatorWorker.js';
import { WindowsWorker, type WindowsHostAgent } from '../src/worker/windows/WindowsWorker.js';
import { EnvironmentError, PlatformNotReadyError, type ArtifactSink } from '../src/worker/GameWorker.js';
import { runCommand, CommandArgError, type CommandResult, type CommandRunner } from '../src/worker/commandRunner.js';
import type { Artifact } from '../src/domain/artifact.js';

/** 最小 PNG 標頭(只要 IHDR 寬高)。 */
function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
const ok = (stdout: string | Buffer = ''): CommandResult => ({ code: 0, stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout), stderr: '', timedOut: false });

function fakeAdb(handler: (args: string[]) => CommandResult | undefined) {
  const calls: Array<{ file: string; args: string[]; timeoutMs: number }> = [];
  const runner: CommandRunner = async (file, args, opts) => {
    calls.push({ file, args: [...args], timeoutMs: opts.timeoutMs });
    return handler([...args].slice(2)) ?? ok();
  };
  return { runner, calls };
}
const sink = (): ArtifactSink & { put: ArtifactSink['put']; items: Artifact[] } => {
  const items: Artifact[] = [];
  return {
    items,
    async put(kind, name, body, contentType) {
      const a: Artifact = { kind, key: `k/${name}`, contentType, bytes: body.length, createdAt: 'now' };
      items.push(a);
      return a;
    },
  };
};

function android(handler: (args: string[]) => CommandResult | undefined) {
  const { runner, calls } = fakeAdb(handler);
  const spawned: Array<{ file: string; args: readonly string[] }> = [];
  const s = sink();
  const worker = new AndroidEmulatorWorker({
    avdName: 'pa_api34', sink: s, runner, sleep: async () => undefined,
    spawn: (file, args) => { spawned.push({ file, args }); return { pid: 1, kill: () => true }; },
  });
  return { worker, calls, spawned, sink: s };
}

describe('AndroidEmulatorWorker', () => {
  const happy = (args: string[]): CommandResult | undefined => {
    const a = args.join(' ');
    if (a === 'shell getprop sys.boot_completed') return ok('1\n');
    if (a === 'exec-out screencap -p') return ok(png(1080, 2400));
    if (a.startsWith('install ')) return ok('Performing Streamed Install\nSuccess\n');
    if (a.startsWith('shell cmd package resolve-activity')) return ok('priority=0\ncom.acme.slot/.MainActivity\n');
    if (a === 'get-state') return ok('device\n');
    if (a === 'shell pidof com.acme.slot') return ok('4321\n');
    return undefined;
  };

  test('boots the emulator headless, sets resolution, verifies framebuffer, installs and launches — no shell, every call has a timeout', async () => {
    const { worker, calls, spawned } = android(happy);
    await worker.initialize();
    expect(spawned[0]!.args).toEqual(expect.arrayContaining(['-avd', 'pa_api34', '-no-window', '-gpu', 'swiftshader_indirect', '-port', '5554']));
    const { framebuffer } = await worker.prepareEnvironment({ display: { width: 1080, height: 2400, orientation: 'portrait', refreshRate: 60 } });
    expect(framebuffer).toEqual({ width: 1080, height: 2400 });
    const dir = await mkdtemp(join(tmpdir(), 'pa-'));
    const apk = join(dir, 'game.apk');
    await writeFile(apk, 'x');
    await worker.installGame({ localPath: apk, entry: 'com.acme.slot' });
    await worker.startGame();
    expect(worker.state).toBe('RUNNING');
    expect(calls.every((c) => c.file === 'adb' && c.args[0] === '-s' && c.args[1] === 'emulator-5554' && c.timeoutMs > 0)).toBe(true);
    expect(calls.map((c) => c.args.slice(2).join(' '))).toContain('shell wm size 1080x2400');
    expect(calls.map((c) => c.args.slice(2).join(' '))).toContain('shell am start -W -n com.acme.slot/.MainActivity');
  });

  test('framebuffer mismatch → EnvironmentError (job becomes ENVIRONMENT_ERROR, AI test never starts)', async () => {
    const { worker } = android((a) => (a.join(' ') === 'exec-out screencap -p' ? ok(png(720, 1280)) : happy(a)));
    await worker.initialize();
    await expect(worker.prepareEnvironment({ display: { width: 1080, height: 2400, orientation: 'portrait', refreshRate: 60 } })).rejects.toBeInstanceOf(EnvironmentError);
    expect(worker.state).toBe('FAILED');
  });

  test('install failure is an environment error; split APK directories use install-multiple', async () => {
    const { worker } = android((a) => (a[0] === 'install' ? ok('Failure [INSTALL_FAILED_NO_MATCHING_ABIS]') : happy(a)));
    await worker.initialize();
    await worker.prepareEnvironment({ display: { width: 1080, height: 2400, orientation: 'portrait', refreshRate: 60 } });
    const dir = await mkdtemp(join(tmpdir(), 'pa-'));
    await writeFile(join(dir, 'g.apk'), 'x');
    await expect(worker.installGame({ localPath: join(dir, 'g.apk'), entry: 'com.acme.slot' })).rejects.toBeInstanceOf(EnvironmentError);

    const b = android((a) => (a[0] === 'install-multiple' ? ok('Success') : happy(a)));
    await b.worker.initialize();
    await b.worker.prepareEnvironment({ display: { width: 1080, height: 2400, orientation: 'portrait', refreshRate: 60 } });
    const split = join(dir, 'split');
    await mkdir(split);
    await writeFile(join(split, 'base.apk'), 'x');
    await writeFile(join(split, 'config.arm64_v8a.apk'), 'x');
    await b.worker.installGame({ localPath: split, entry: 'com.acme.slot' });
    expect(b.calls.find((c) => c.args[2] === 'install-multiple')!.args.slice(-2)).toEqual([join(split, 'base.apk'), join(split, 'config.arm64_v8a.apk')]);
  });

  test('actions map to adb input; unsafe text and multi-key hotkeys are unsupported, not executed', async () => {
    const { worker, calls } = android(happy);
    expect(await worker.executeAction({ action: 'tap', x: 540.4, y: 3600 })).toMatchObject({ ok: true });
    await worker.executeAction({ action: 'longPress', x: 10, y: 20, durationMs: 1500 });
    await worker.executeAction({ action: 'swipe', x: 1, y: 2, x2: 3, y2: 4, durationMs: 300 });
    expect(await worker.executeAction({ action: 'keyboard', text: 'hi; reboot' })).toMatchObject({ ok: false, error: 'unsupported' });
    expect(await worker.executeAction({ action: 'hotkey', keys: ['ctrl', 'c'] })).toMatchObject({ ok: false, error: 'unsupported' });
    await worker.executeAction({ action: 'keyboard', text: 'guest user' });
    const sent = calls.map((c) => c.args.slice(2).join(' '));
    expect(sent).toEqual(expect.arrayContaining(['shell input tap 540 3600', 'shell input swipe 10 20 10 20 1500', 'shell input swipe 1 2 3 4 300', 'shell input text guest%suser']));
    expect(sent.some((s) => s.includes('reboot'))).toBe(false);
  });

  test('health: game process gone or ANR in events log is reported, not auto-restarted', async () => {
    const { worker } = android((a) => {
      const s = a.join(' ');
      if (s === 'shell pidof com.acme.slot') return ok('');
      if (s.startsWith('logcat -d -b events')) return ok('1791000000.000  1000  1000 I am_anr  : [0,4321,com.acme.slot,0,Input dispatching timed out]\n');
      return happy(a);
    });
    await worker.initialize();
    await worker.prepareEnvironment({ display: { width: 1080, height: 2400, orientation: 'portrait', refreshRate: 60 } });
    const dir = await mkdtemp(join(tmpdir(), 'pa-'));
    await writeFile(join(dir, 'g.apk'), 'x');
    await worker.installGame({ localPath: join(dir, 'g.apk'), entry: 'com.acme.slot' });
    await worker.startGame();
    const h = await worker.checkHealth();
    expect(h.problems).toEqual(expect.arrayContaining(['anr', 'game_crashed']));
    expect(h.detail).toContain('am_anr');
    expect(worker.state).toBe('RUNNING');
  });

  test('recording: segments are pulled and named rec-<n>.mp4 for the existing player', async () => {
    const { worker, sink: s } = android((a) => {
      const c = a.join(' ');
      if (c === 'shell ls /sdcard/pa_rec') return ok('seg_1.mp4\nseg_0.mp4\n.on\n');
      if (c.startsWith('exec-out cat /sdcard/pa_rec/')) return ok(Buffer.from('mp4'));
      return happy(a);
    });
    await worker.initialize();
    await worker.startRecording();
    const arts = await worker.stopRecording();
    expect(arts.map((x) => x.key)).toEqual(['k/rec-0.mp4', 'k/rec-1.mp4']);
    expect(s.items.every((x) => x.kind === 'recording')).toBe(true);
  });

  test('rejects unsafe AVD names and package names', async () => {
    expect(() => new AndroidEmulatorWorker({ avdName: 'x; rm -rf /', sink: sink() })).toThrow();
    const { worker } = android(happy);
    await worker.initialize();
    await worker.prepareEnvironment({ display: { width: 1080, height: 2400, orientation: 'portrait', refreshRate: 60 } });
    await expect(worker.installGame({ localPath: 'x', entry: 'com.acme;reboot' })).rejects.toThrow();
  });
});

describe('WindowsWorker', () => {
  test('without the host helper every OS call fails honestly with PlatformNotReadyError', async () => {
    const w = new WindowsWorker();
    await expect(w.initialize()).rejects.toBeInstanceOf(PlatformNotReadyError);
    expect(w.state).toBe('FAILED');
  });

  test('1080×4096: the real framebuffer must match, otherwise ENVIRONMENT_ERROR', async () => {
    const agent = (fb: { width: number; height: number }) => ({
      health: async () => ({ timestamp: 't', deviceReachable: true, deviceBooted: true, gameRunning: false, problems: [] }),
      createDisplay: async () => fb,
    }) as unknown as WindowsHostAgent;
    const good = new WindowsWorker(agent({ width: 1080, height: 4096 }));
    await good.initialize();
    expect((await good.prepareEnvironment({ display: { width: 1080, height: 4096, orientation: 'portrait', refreshRate: 60 } })).framebuffer).toEqual({ width: 1080, height: 4096 });
    const bad = new WindowsWorker(agent({ width: 1920, height: 1080 }));
    await bad.initialize();
    await expect(bad.prepareEnvironment({ display: { width: 1080, height: 4096, orientation: 'portrait', refreshRate: 60 } })).rejects.toBeInstanceOf(EnvironmentError);
  });
});

describe('commandRunner', () => {
  test('runs without a shell, enforces timeout, rejects unsafe args', async () => {
    const r = await runCommand(process.execPath, ['-e', 'process.stdout.write("a b; echo injected")'], { timeoutMs: 10_000 });
    expect(r.code).toBe(0);
    expect(r.stdout.toString()).toBe('a b; echo injected');
    const slow = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 300 });
    expect(slow.timedOut).toBe(true);
    expect(() => runCommand('adb', ['shell', 'input\ntext'], { timeoutMs: 1000 })).toThrow(CommandArgError);
    expect(() => runCommand('adb', [], { timeoutMs: 0 })).toThrow(CommandArgError);
  });
});
