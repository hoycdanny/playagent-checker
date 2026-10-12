/**
 * XAPK / split-APK 合併工具(Device Farm runner 用)。
 *
 * AWS Device Farm 只接受單一 APK。流程不是「合併出非空檔案就上傳」,而是:
 *   APKEditor merge → ZIP/manifest/aapt 驗證 → zipalign → 測試 key 簽章 → apksigner verify → aapt 再驗證。
 * 任一步失敗就在 runner 本地回報,不把已知壞檔上傳後只得到模糊的
 * ANDROID_APP_AAPT_DEBUG_BADGING_FAILED。
 *
 * 注意:split APK 合併會重建 APK,無法保留商店原簽章。此產物只供隔離的測試裝置安裝;
 * 若遊戲使用簽章綁定的 OAuth / Play Integrity,應改用開發團隊提供的原始簽章 universal APK。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APKEDITOR_JAR = process.env.PA_APKEDITOR || '/opt/apkeditor/APKEditor.jar';
const AAPT = process.env.PA_AAPT || 'aapt';
const ZIPALIGN = process.env.PA_ZIPALIGN || 'zipalign';
const APKSIGNER = process.env.PA_APKSIGNER || 'apksigner';
const KEYSTORE = process.env.PA_APK_KEYSTORE || '/opt/playagent/android-debug.keystore';
const KEY_ALIAS = process.env.PA_APK_KEY_ALIAS || 'androiddebugkey';
const KEY_PASS = process.env.PA_APK_KEYSTORE_PASS || 'android';
const MAX_OUTPUT = 64 * 1024 * 1024;

function remove(path) {
  if (!path) return;
  try { unlinkSync(path); } catch { /* ignore */ }
}

function errorOutput(err) {
  const stderr = err?.stderr ? String(err.stderr) : '';
  const stdout = err?.stdout ? String(err.stdout) : '';
  return (stderr || stdout || String(err?.message || err)).replace(/\s+/g, ' ').trim().slice(-1400);
}

/** 執行外部工具並保留 stdout;失敗時錯誤包含工具輸出。測試可注入 run。 */
function checked(run, command, args, label, options = {}) {
  try {
    return String(run(command, args, {
      maxBuffer: MAX_OUTPUT,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    }) ?? '');
  } catch (err) {
    throw new Error(`${label}失敗:${errorOutput(err)}`);
  }
}

function zipEntries(filePath, run = execFileSync) {
  const listing = checked(run, 'unzip', ['-l', filePath], '讀取 APK/ZIP 目錄');
  return listing
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\d+\s/.test(l))
    .map((l) => l.split(/\s+/).slice(3).join(' '))
    .filter(Boolean);
}

function hasZipMagic(filePath) {
  try {
    const fd = readFileSync(filePath, { flag: 'r' });
    return fd.length >= 4 && fd[0] === 0x50 && fd[1] === 0x4b && fd[2] === 0x03 && fd[3] === 0x04;
  } catch {
    return false;
  }
}

/** XAPK/APKM/ZIP-of-APKs 偵測;單一 APK(root manifest + dex)絕不誤合併。 */
export function detectXapk(filePath) {
  if (!hasZipMagic(filePath)) return { isXapk: false, apkEntries: [] };
  try {
    const entries = zipEntries(filePath);
    const apkEntries = entries.filter((name) => /\.apk$/i.test(name));
    const standalone = entries.some((n) => n === 'AndroidManifest.xml')
      && entries.some((n) => /^classes\d*\.dex$/.test(n));
    if (standalone) return { isXapk: false, apkEntries: [] };
    return { isXapk: apkEntries.length >= 1, apkEntries };
  } catch {
    // 偵測階段保留舊行為:讀不到目錄時當一般 APK;正式上傳前 Device Farm 仍會驗證。
    return { isXapk: false, apkEntries: [] };
  }
}

/** 可直接上傳的單一標準 APK(root manifest + classes*.dex)。 */
export function isStandaloneApk(filePath) {
  if (!hasZipMagic(filePath)) return false;
  try {
    const entries = zipEntries(filePath);
    return entries.includes('AndroidManifest.xml') && entries.some((n) => /^classes\d*\.dex$/.test(n));
  } catch {
    return false;
  }
}

/** APK 內原生 ABI 集合。 */
export function detectApkAbis(apkPath) {
  const abis = new Set();
  try {
    const listing = execFileSync('unzip', ['-l', apkPath], { maxBuffer: 32 * 1024 * 1024 }).toString();
    for (const m of listing.matchAll(/\blib\/([a-z0-9_-]+)\//gi)) abis.add(m[1]);
  } catch { /* empty */ }
  return abis;
}

/** APKEditor info / aapt badging 輸出 → package id。 */
export function parseApkPackageInfo(out) {
  const text = String(out ?? '');
  const patterns = [
    /^Package\s+name\s*=\s*["']?([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)/im,
    /\bpackage:\s+name=['"]([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)['"]/i,
    /\bpackage\s*[:=]\s*["']?([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)/i,
    /["']package["']\s*:\s*["']([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)/i,
  ];
  for (const p of patterns) {
    const m = p.exec(text);
    if (m?.[1]) return m[1];
  }
  return undefined;
}

/**
 * 套件名偵測。APKEditor 1.4.x 的 -t 只接受 text/json/xml;`-t manifest` 是無效參數。
 * 用 `info -package -t text`,再以 aapt badging 保底。
 */
export function detectApkPackage(apkPath, run = execFileSync) {
  const attempts = [
    ['java', ['-jar', APKEDITOR_JAR, 'info', '-i', apkPath, '-package', '-t', 'text']],
    [AAPT, ['dump', 'badging', apkPath]],
  ];
  for (const [command, args] of attempts) {
    if (command === 'java' && run === execFileSync && !apkMergeAvailable()) continue;
    try {
      const value = parseApkPackageInfo(run(command, args, { maxBuffer: 32 * 1024 * 1024 }).toString());
      if (value) return value;
    } catch { /* next */ }
  }
  return undefined;
}

export function isThirtyTwoBitOnly(apkPath) {
  const abis = detectApkAbis(apkPath);
  if (abis.size === 0) return false;
  const has64 = abis.has('arm64-v8a') || abis.has('x86_64');
  const has32 = abis.has('armeabi-v7a') || abis.has('armeabi') || abis.has('x86');
  return has32 && !has64;
}

export function apkMergeAvailable() {
  if (!existsSync(APKEDITOR_JAR)) return false;
  try {
    execFileSync('java', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * 本地執行 Device Farm 上傳前等價檢查。簽章不是 aapt 解析成功的前提;
 * 所以先驗證 unsigned merge,可以精確區分「合併壞掉」與「簽章壞掉」。
 */
export function validateApkForDeviceFarm(apkPath, run = execFileSync) {
  if (!hasZipMagic(apkPath)) throw new Error('APK 驗證失敗:不是 ZIP/APK 檔');
  checked(run, 'unzip', ['-tqq', apkPath], 'APK ZIP 完整性驗證');
  let badging;
  try {
    badging = checked(run, AAPT, ['dump', 'badging', apkPath], 'aapt dump badging');
  } catch (err) {
    throw new Error(`${err.message}。合併產物的 AndroidManifest/resources 無法被 aapt 解析;簽章無法修復此類錯誤。`);
  }
  const packageName = parseApkPackageInfo(badging);
  if (!packageName) throw new Error(`aapt dump badging 未回傳 package name:${badging.slice(0, 500)}`);
  return { packageName, badging };
}

/**
 * 對已合併 APK 做 align + 測試簽章 + 驗證。輸入檔會被清理;成功只保留並回傳 signed APK。
 * run/validate 可注入,供單元測試驗證命令順序而不需真的 Android SDK。
 */
export function finalizeMergedApk(unsignedPath, options = {}) {
  const run = options.run ?? execFileSync;
  const validate = options.validate ?? ((p) => validateApkForDeviceFarm(p, run));
  const aligned = `${unsignedPath}.aligned.apk`;
  const signed = `${unsignedPath}.signed.apk`;
  try {
    const before = validate(unsignedPath); // bad merge 在簽名前就攔下
    checked(run, ZIPALIGN, ['-f', '-p', '4', unsignedPath, aligned], 'zipalign');
    checked(run, ZIPALIGN, ['-c', '-p', '4', aligned], 'zipalign 驗證');
    checked(run, APKSIGNER, [
      'sign', '--ks', KEYSTORE, '--ks-key-alias', KEY_ALIAS,
      '--ks-pass', `pass:${KEY_PASS}`, '--key-pass', `pass:${KEY_PASS}`,
      '--out', signed, aligned,
    ], 'apksigner 簽章');
    checked(run, APKSIGNER, ['verify', '--verbose', '--print-certs', signed], 'apksigner 驗證');
    const after = validate(signed);
    if (before.packageName !== after.packageName) {
      throw new Error(`簽章後 package name 改變:${before.packageName} → ${after.packageName}`);
    }
    remove(unsignedPath);
    remove(aligned);
    return { path: signed, packageName: after.packageName };
  } catch (err) {
    remove(unsignedPath);
    remove(aligned);
    remove(signed);
    throw err;
  }
}

/** APKEditor merge → aapt 驗證 → align/sign/verify,回 signed universal APK 路徑。 */
export function mergeXapkToApk(xapkPath, options = {}) {
  if (!apkMergeAvailable() && !options.run) {
    throw new Error('APKEditor/Java 不可用,無法合併 XAPK。請確認 runner 映像已安裝 Java 與 APKEditor.jar。');
  }
  const run = options.run ?? execFileSync;
  const unsigned = join(tmpdir(), `pa-merged-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.apk`);
  try {
    checked(run, 'java', ['-jar', APKEDITOR_JAR, 'm', '-i', xapkPath, '-o', unsigned, '-f'], 'XAPK 合併(APKEditor)');
    if (!existsSync(unsigned) || statSync(unsigned).size === 0) throw new Error('XAPK 合併後未產生 APK 檔');
    return finalizeMergedApk(unsigned, { run, ...(options.validate ? { validate: options.validate } : {}) }).path;
  } catch (err) {
    remove(unsigned);
    throw err;
  }
}
