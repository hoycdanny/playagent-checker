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
