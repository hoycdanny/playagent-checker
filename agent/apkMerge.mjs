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
import { readFileSync, existsSync, statSync, statfsSync, unlinkSync } from 'node:fs';
import { tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';

const APKEDITOR_JAR = process.env.PA_APKEDITOR || '/opt/apkeditor/APKEditor.jar';
const AAPT = process.env.PA_AAPT || 'aapt';
const ZIPALIGN = process.env.PA_ZIPALIGN || 'zipalign';
const APKSIGNER = process.env.PA_APKSIGNER || 'apksigner';
const KEYSTORE = process.env.PA_APK_KEYSTORE || '/opt/playagent/android-debug.keystore';
const KEY_ALIAS = process.env.PA_APK_KEY_ALIAS || 'androiddebugkey';
const KEY_PASS = process.env.PA_APK_KEYSTORE_PASS || 'android';
const MAX_OUTPUT = 64 * 1024 * 1024;

// ───────────── JVM 記憶體:依容器大小設定 heap,不吃 JVM 預設的 1/4 ─────────────

/** Java heap 佔容器記憶體的比例。剩下的給 Node runner、JVM 非 heap 區與作業系統。 */
const JAVA_HEAP_PERCENT = 60;
/** 合併 / 對齊 / 簽章期間同時存在的檔案份數(原檔 + unsigned + aligned + signed),再留一份餘裕。 */
const DISK_COPIES = 5;
const OOM_RE = /OutOfMemoryError|Java heap space|GC overhead limit exceeded|Terminating due to java\.lang\.OutOfMemoryError/i;

/** 容器可用記憶體(MB):cgroup v2 → v1 → 機器總記憶體(Fargate 的 microVM = task 大小)。 */
export function containerMemoryMB(read = readFileSync) {
  for (const file of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const v = String(read(file, 'utf8')).trim();
      if (!/^\d+$/.test(v)) continue;
      const mb = Number(v) / 1024 / 1024;
      if (mb > 0 && mb < 1024 * 1024) return Math.floor(mb); // 「無上限」是一個極大值,略過
    } catch { /* 不在容器內 */ }
  }
  return Math.floor(totalmem() / 1024 / 1024);
}

/**
 * 給 APKEditor / apksigner 的 JVM 參數。JVM 預設最大 heap = 容器記憶體 1/4(2 GB 容器只有 ~512 MB),
 * 合併數百 MB 的 XAPK 會 OutOfMemoryError。改為容器的 60%,OOM 時立刻結束並印出明確訊息(不會半死不活)。
 * PA_JAVA_OPTS 可整組覆寫(例如 `-Xmx6g`)。
 */
export function javaOptions(env = process.env) {
  const custom = String(env.PA_JAVA_OPTS ?? '').trim();
  if (custom) return custom.split(/\s+/);
  return [`-XX:MaxRAMPercentage=${JAVA_HEAP_PERCENT}`, '-XX:+ExitOnOutOfMemoryError'];
}

/** 依 JVM 參數估算 heap 上限(MB),供日誌與錯誤訊息。 */
export function javaHeapMB(memMB, opts = javaOptions()) {
  const xmx = opts.map((o) => /^-Xmx(\d+)([kKmMgG]?)$/.exec(o)).find(Boolean);
  if (xmx) {
    const n = Number(xmx[1]);
    const unit = xmx[2].toLowerCase();
    return Math.floor(unit === 'g' ? n * 1024 : unit === 'k' ? n / 1024 : unit === 'm' ? n : n / 1024 / 1024);
  }
  const pct = opts.map((o) => /^-XX:MaxRAMPercentage=([\d.]+)$/.exec(o)).find(Boolean);
  return Math.floor(memMB * (pct ? Number(pct[1]) : 25) / 100);
}

function isOutOfMemory(err) {
  return err?.signal === 'SIGKILL' || err?.status === 137 || err?.status === 3 || OOM_RE.test(errorOutput(err));
}

/** 暫存目錄剩餘空間(MB);平台不支援時回 null。 */
function freeDiskMB(dir) {
  try {
    const s = statfsSync(dir);
    return Math.floor((Number(s.bavail) * Number(s.bsize)) / 1024 / 1024);
  } catch {
    return null;
  }
}

/**
 * 合併前預檢:暫存空間不夠就在合併前以白話失敗(不要合到一半才因磁碟滿而崩潰)。
 * 回傳資源摘要,寫進 runner 日誌,事後一眼看出當時的容器大小與 heap 上限。
 */
export function mergePreflight(xapkPath, deps = {}) {
  const memMB = deps.memMB ?? containerMemoryMB();
  const opts = deps.javaOptions ?? javaOptions();
  const heapMB = javaHeapMB(memMB, opts);
  const sizeMB = Math.ceil((deps.sizeBytes ?? statSync(xapkPath).size) / 1024 / 1024);
  const diskMB = deps.diskMB !== undefined ? deps.diskMB : freeDiskMB(tmpdir());
  const needDiskMB = sizeMB * DISK_COPIES;
  if (diskMB !== null && diskMB < needDiskMB) {
    throw new Error(
      `XAPK 合併前檢查失敗:暫存空間只剩 ${diskMB}MB,合併 ${sizeMB}MB 的 XAPK 需要約 ${needDiskMB}MB。` +
      '請提高 runner 暫存空間(infra/lib/execution-stack.ts 的 EXPLORATION_RUNNER_STORAGE_GIB)。',
    );
  }
  return { memMB, heapMB, sizeMB, diskMB, opts };
}

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
    ['java', [...javaOptions(), '-jar', APKEDITOR_JAR, 'info', '-i', apkPath, '-package', '-t', 'text']],
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
  // apksigner 也是 Java 工具:同樣給它依容器大小的 heap。
  const javaEnv = { env: { ...process.env, JAVA_TOOL_OPTIONS: javaOptions().join(' ') } };
  try {
    const before = validate(unsignedPath); // bad merge 在簽名前就攔下
    checked(run, ZIPALIGN, ['-f', '-p', '4', unsignedPath, aligned], 'zipalign');
    checked(run, ZIPALIGN, ['-c', '-p', '4', aligned], 'zipalign 驗證');
    checked(run, APKSIGNER, [
      'sign', '--ks', KEYSTORE, '--ks-key-alias', KEY_ALIAS,
      '--ks-pass', `pass:${KEY_PASS}`, '--key-pass', `pass:${KEY_PASS}`,
      '--out', signed, aligned,
    ], 'apksigner 簽章', javaEnv);
    checked(run, APKSIGNER, ['verify', '--verbose', '--print-certs', signed], 'apksigner 驗證', javaEnv);
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
  const log = options.log ?? console.log;
  const res = mergePreflight(xapkPath, options.preflight);
  log(`XAPK 合併資源:容器記憶體 ${res.memMB}MB、Java heap 上限約 ${res.heapMB}MB、XAPK ${res.sizeMB}MB` +
    (res.diskMB !== null ? `、暫存空間剩 ${res.diskMB}MB` : ''));
  const unsigned = join(tmpdir(), `pa-merged-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.apk`);
  try {
    try {
      run('java', [...res.opts, '-jar', APKEDITOR_JAR, 'm', '-i', xapkPath, '-o', unsigned, '-f'], {
        maxBuffer: MAX_OUTPUT,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      if (isOutOfMemory(err)) {
        throw new Error(
          `XAPK 合併記憶體不足(APKEditor/Java):容器 ${res.memMB}MB、heap 上限約 ${res.heapMB}MB,` +
          `不足以合併 ${res.sizeMB}MB 的 XAPK。請提高 runner 記憶體(infra/lib/execution-stack.ts 的 ` +
          `EXPLORATION_RUNNER_MEMORY_MIB)後重新部署,或以 PA_JAVA_OPTS 調整 heap。原始訊息:${errorOutput(err).slice(-300)}`,
        );
      }
      throw new Error(`XAPK 合併(APKEditor)失敗:${errorOutput(err)}`);
    }
    if (!existsSync(unsigned) || statSync(unsigned).size === 0) throw new Error('XAPK 合併後未產生 APK 檔');
    return finalizeMergedApk(unsigned, { run, ...(options.validate ? { validate: options.validate } : {}) }).path;
  } catch (err) {
    remove(unsigned);
    throw err;
  }
}
