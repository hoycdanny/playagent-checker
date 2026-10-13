import { afterEach, describe, expect, test } from 'vitest';
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error agent mjs declaration is intentionally local to the runner
const mod = await import('../../agent/apkMerge.mjs');

const made: string[] = [];
function temp(name: string, bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1])) {
  const p = join(tmpdir(), `pa-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
  writeFileSync(p, bytes); made.push(p); return p;
}
afterEach(() => { for (const p of made.splice(0)) rmSync(p, { force: true }); });

/** 假 Android tools:zipalign / apksigner sign 會複製輸入到輸出,其餘成功。 */
function signingRunner(calls: Array<{ command: string; args: string[] }>) {
  return (command: string, args: string[]) => {
    calls.push({ command, args: [...args] });
    if (command === 'zipalign' && args[0] === '-f') copyFileSync(args[3]!, args[4]!);
    if (command === 'apksigner' && args[0] === 'sign') {
      const out = args[args.indexOf('--out') + 1]!;
      copyFileSync(args.at(-1)!, out);
    }
    return Buffer.from('ok');
  };
}

describe('APK package detection', () => {
  test('parses APKEditor 1.4.9 text and aapt badging formats', () => {
    expect(mod.parseApkPackageInfo('Package name=com.igs.goldenhoyeah\nVersion code=1')).toBe('com.igs.goldenhoyeah');
    expect(mod.parseApkPackageInfo("package: name='com.acme.game' versionCode='1'" )).toBe('com.acme.game');
    expect(mod.parseApkPackageInfo('package="com.old.format"')).toBe('com.old.format');
    expect(mod.parseApkPackageInfo('no package')).toBeUndefined();
  });

  test('uses valid info -package -t text (never -t manifest)', () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const run = (command: string, args: string[]) => {
      calls.push({ command, args });
      return Buffer.from('Package name=com.igs.goldenhoyeah');
    };
    expect(mod.detectApkPackage('/x/app.apk', run)).toBe('com.igs.goldenhoyeah');
    expect(calls[0]!.command).toBe('java');
    expect(calls[0]!.args).toContain('-package');
    expect(calls[0]!.args.slice(-2)).toEqual(['-t', 'text']);
    expect(calls[0]!.args).not.toContain('manifest');
  });
});

describe('merged APK validation and signing', () => {
  test('aapt badging failure is reported before signing', () => {
    const apk = temp('bad.apk');
    const run = (command: string) => {
      if (command === 'unzip') return Buffer.from('No errors detected');
      const e = Object.assign(new Error('badging'), { stderr: Buffer.from('ERROR: dump failed because resources.arsc is invalid') });
      throw e;
    };
    expect(() => mod.validateApkForDeviceFarm(apk, run)).toThrow(/aapt dump badging.*resources\.arsc.*簽章無法修復/);
  });

  test('validates → aligns → signs → verifies → validates again', () => {
    const unsigned = temp('merged.apk', Buffer.from('unsigned-apk'));
    const calls: Array<{ command: string; args: string[] }> = [];
    let validations = 0;
    const result = mod.finalizeMergedApk(unsigned, {
      run: signingRunner(calls),
      validate: (p: string) => { validations++; expect(existsSync(p)).toBe(true); return { packageName: 'com.igs.goldenhoyeah', badging: 'ok' }; },
    });
    made.push(result.path);
    expect(validations).toBe(2);
    expect(existsSync(unsigned)).toBe(false);
    expect(existsSync(result.path)).toBe(true);
    expect(result.packageName).toBe('com.igs.goldenhoyeah');
    expect(calls.map((c) => `${c.command} ${c.args[0]}`)).toEqual([
      'zipalign -f', 'zipalign -c', 'apksigner sign', 'apksigner verify',
    ]);
    const sign = calls.find((c) => c.command === 'apksigner' && c.args[0] === 'sign')!;
    expect(sign.args).toContain('/opt/playagent/android-debug.keystore');
    expect(sign.args).toContain('androiddebugkey');
  });

  test('failed pre-validation removes the unsigned merge', () => {
    const unsigned = temp('bad-merge.apk', Buffer.from('bad'));
    expect(() => mod.finalizeMergedApk(unsigned, { run: signingRunner([]), validate: () => { throw new Error('bad manifest'); } })).toThrow('bad manifest');
    expect(existsSync(unsigned)).toBe(false);
  });
});

describe('XAPK merge memory (APKEditor JVM)', () => {
  const MB = 1024 * 1024;

  test('JVM heap follows the container size instead of the 25% default', () => {
    const opts = mod.javaOptions({});
    expect(opts).toContain('-XX:MaxRAMPercentage=60');
    expect(opts).toContain('-XX:+ExitOnOutOfMemoryError');
    // 舊配置 2 GB 容器:預設 heap 只有 ~512 MB;新配置 8 GB:~4.9 GB。
    expect(mod.javaHeapMB(2048, ['-XX:MaxRAMPercentage=25'])).toBe(512);
    expect(mod.javaHeapMB(8192, opts)).toBe(4915);
  });

  test('PA_JAVA_OPTS overrides the heap settings', () => {
    const opts = mod.javaOptions({ PA_JAVA_OPTS: '-Xmx6g -XX:+ExitOnOutOfMemoryError' });
    expect(opts).toEqual(['-Xmx6g', '-XX:+ExitOnOutOfMemoryError']);
    expect(mod.javaHeapMB(8192, opts)).toBe(6144);
  });

  test('reads the cgroup memory limit and ignores "unlimited"', () => {
    const v2 = (f: string) => { if (f === '/sys/fs/cgroup/memory.max') return `${8192 * MB}\n`; throw new Error('missing'); };
    expect(mod.containerMemoryMB(v2)).toBe(8192);
    const v1 = (f: string) => {
      if (f === '/sys/fs/cgroup/memory.max') return 'max\n';
      if (f === '/sys/fs/cgroup/memory/memory.limit_in_bytes') return `${2048 * MB}`;
      throw new Error('missing');
    };
    expect(mod.containerMemoryMB(v1)).toBe(2048);
  });

  test('APKEditor gets the heap options before -jar', () => {
    const xapk = temp('game.xapk');
    const calls: Array<{ command: string; args: string[] }> = [];
    const run = (command: string, args: string[]) => {
      calls.push({ command, args: [...args] });
      if (command === 'java') writeFileSync(args[args.indexOf('-o') + 1]!, 'merged-apk');
      return signingRunner([])(command, args);
    };
    const out = mod.mergeXapkToApk(xapk, {
      run,
      log: () => {},
      validate: () => ({ packageName: 'com.acme.slot', badging: 'ok' }),
      preflight: { memMB: 8192, diskMB: 100_000, sizeBytes: 434 * MB, javaOptions: mod.javaOptions({}) },
    });
    made.push(out);
    const java = calls.find((c) => c.command === 'java')!;
    expect(java.args.slice(0, 3)).toEqual(['-XX:MaxRAMPercentage=60', '-XX:+ExitOnOutOfMemoryError', '-jar']);
    expect(java.args).toContain('m');
  });

  test('Java OutOfMemoryError becomes a clear, actionable error (not a silent exit 1)', () => {
    const xapk = temp('big.xapk');
    const run = (command: string) => {
      if (command !== 'java') return Buffer.from('ok');
      throw Object.assign(new Error('Command failed'), {
        status: 3,
        stderr: Buffer.from('Terminating due to java.lang.OutOfMemoryError: Java heap space'),
      });
    };
    const opts = ['-XX:MaxRAMPercentage=25'];
    expect(() => mod.mergeXapkToApk(xapk, {
      run, log: () => {},
      preflight: { memMB: 2048, diskMB: 100_000, sizeBytes: 434 * MB, javaOptions: opts },
    })).toThrow(/記憶體不足.*容器 2048MB.*heap 上限約 512MB.*434MB.*EXPLORATION_RUNNER_MEMORY_MIB/);
  });

  test('container kill (SIGKILL) is also reported as out of memory', () => {
    const xapk = temp('killed.xapk');
    const run = () => { throw Object.assign(new Error('killed'), { signal: 'SIGKILL' }); };
    expect(() => mod.mergeXapkToApk(xapk, {
      run, log: () => {},
      preflight: { memMB: 2048, diskMB: 100_000, sizeBytes: 434 * MB, javaOptions: ['-XX:MaxRAMPercentage=25'] },
    })).toThrow(/記憶體不足/);
  });

  test('not enough temp disk fails before merging', () => {
    const xapk = temp('huge.xapk');
    const calls: string[] = [];
    const run = (command: string) => { calls.push(command); return Buffer.from('ok'); };
    expect(() => mod.mergeXapkToApk(xapk, {
      run, log: () => {},
      preflight: { memMB: 8192, diskMB: 1000, sizeBytes: 434 * MB, javaOptions: mod.javaOptions({}) },
    })).toThrow(/暫存空間只剩 1000MB.*需要約 2170MB/);
    expect(calls).not.toContain('java');
  });
});

describe('runner image has pinned XAPK toolchain', () => {
  test('pins APKEditor checksum and Android validation/signing tools', () => {
    const docker = readFileSync(join(__dirname, '..', '..', 'agent', 'Dockerfile.exploration'), 'utf8');
    expect(docker).toContain('APKEDITOR_VERSION=1.4.9');
    expect(docker).toContain('a9cd40df818845456be6d696de6110c89edf4b0a0580cb83438ed6b25a366e67');
    expect(docker).toContain('aapt=1:10.0.0+r36-10');
    expect(docker).toContain('apksigner=31.0.2-1');
    expect(docker).toContain('zipalign=1:10.0.0+r36-1');
    expect(docker).toContain('keytool -genkeypair');
  });
});
