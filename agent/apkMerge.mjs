/**
 * XAPK / split-APK 合併工具(Device Farm runner 用)。
 *
 * 背景:很多遊戲(尤其大型 MMORPG,如楓之谷 M)在商店/第三方站(ApkPure 等)以 XAPK 格式散布。
 * XAPK 本質是一個 ZIP,裡面裝了「base APK + 多個 split APK(依 CPU 架構/螢幕密度分包)+ manifest.json + icon」。
 * AWS Device Farm 只接受「單一 APK」(它會對上傳檔跑 aapt debug badging;丟 XAPK 會回
 * ANDROID_APP_AAPT_DEBUG_BADGING_FAILED)。因此上傳前必須把 split 合併成一個 universal APK。
 *
 * 合併工具用 APKEditor.jar(容器內以 `java -jar` 執行):
 *   java -jar APKEditor.jar m -i <in.xapk|dir> -o <out.apk>
 * bundletool 不適用(它需要原始 .aab,而我們手上只有已拆好的 split APK)。
 *
 * 全部走本地暫存檔 + execFileSync;偵測/合併失敗都拋出明確錯誤(讓上層寫進任務狀態,便於使用者理解)。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** APKEditor.jar 在容器內的路徑(Dockerfile 會放這)。可用 PA_APKEDITOR 覆寫。 */
const APKEDITOR_JAR = process.env.PA_APKEDITOR || '/opt/apkeditor/APKEditor.jar';

/**
 * 判斷一個本地檔案是否為「需要合併的 XAPK / split bundle」。
 * 判準:檔案是 ZIP(magic PK\x03\x04),且用 `unzip -l` 列出的內容包含「至少一個 .apk 項目」。
 *   - 單一標準 APK 本身也是 ZIP,但裡面是 classes.dex/res 等,不會有 .apk 項目 → 回 false。
 *   - XAPK/APKM/ZIP-of-apks 裡面有 base.apk + config.*.apk → 回 true。
 * 回 { isXapk, apkEntries } —— apkEntries 為 zip 內 .apk 檔名清單(除錯用)。
 */
export function detectXapk(filePath) {
  try {
    const fd = readFileSync(filePath, { flag: 'r' });
    // 讀前 4 bytes 確認是 ZIP。
    if (fd.length < 4 || fd[0] !== 0x50 || fd[1] !== 0x4b || fd[2] !== 0x03 || fd[3] !== 0x04) {
      return { isXapk: false, apkEntries: [] };
    }
  } catch {
    return { isXapk: false, apkEntries: [] };
  }
  try {
    // `unzip -l`(僅列目錄,不解壓)取得項目清單。逐一取「每列最後一欄=項目路徑」,
    // 避免用整列做 regex(檔名含空白時 split.pop() 才是真正路徑,也不會被 unzip 表頭/摘要列誤傷)。
    const listing = execFileSync('unzip', ['-l', filePath], { maxBuffer: 32 * 1024 * 1024 }).toString();
    const entries = listing
      .split('\n')
      .map((l) => l.trim())
      // 只取「以數字開頭(size 欄)」的資料列,排除 "Archive:"、表頭、---- 分隔線、總計摘要列。
      .filter((l) => /^\d+\s/.test(l))
      .map((l) => l.split(/\s+/).slice(3).join(' '))
      .filter(Boolean);
    const apkEntries = entries.filter((name) => /\.apk$/i.test(name));

    // 關鍵防呆:真正的 XAPK 外層 ZIP 內「不含」root 的 AndroidManifest.xml / classes.dex
    //(那些在內層 base.apk 裡)。若外層自身就長得像單一 APK(有 root manifest+dex),
    // 即使誤判出 .apk 項目也一律視為「非 XAPK」,絕不對已是合法 APK 的檔做合併而弄壞它。
    const looksLikeStandaloneApk = entries.some((n) => n === 'AndroidManifest.xml')
      && entries.some((n) => /^classes\d*\.dex$/.test(n));
    if (looksLikeStandaloneApk) return { isXapk: false, apkEntries: [] };

    return { isXapk: apkEntries.length >= 1, apkEntries };
  } catch {
    // 沒有 unzip 或列表失敗:保守當成非 XAPK(讓原流程照舊,不硬擋)。
    return { isXapk: false, apkEntries: [] };
  }
}

/**
 * 判斷本地檔案是否為「可直接上傳的單一標準 APK」——ZIP 內含 root `AndroidManifest.xml`
 * 與 `classes*.dex`。用來在合併意外失敗時做保底:若原檔本就是合法 APK,直接沿用不阻斷任務。
 */
export function isStandaloneApk(filePath) {
  try {
    const fd = readFileSync(filePath, { flag: 'r' });
    if (fd.length < 4 || fd[0] !== 0x50 || fd[1] !== 0x4b || fd[2] !== 0x03 || fd[3] !== 0x04) return false;
  } catch {
    return false;
  }
  try {
    const listing = execFileSync('unzip', ['-l', filePath], { maxBuffer: 32 * 1024 * 1024 }).toString();
    const entries = listing
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^\d+\s/.test(l))
      .map((l) => l.split(/\s+/).slice(3).join(' '))
      .filter(Boolean);
    return entries.some((n) => n === 'AndroidManifest.xml') && entries.some((n) => /^classes\d*\.dex$/.test(n));
  } catch {
    return false;
  }
}

/**
 * 讀一個 APK(單一 APK)內含的原生庫 ABI 集合(掃 `lib/<abi>/` 目錄)。
 * 回 Set<string>,例如 {'arm64-v8a','armeabi-v7a'};無原生庫回空 Set(純 Java app,任何裝置都能裝)。
 */
export function detectApkAbis(apkPath) {
  const abis = new Set();
  try {
    const listing = execFileSync('unzip', ['-l', apkPath], { maxBuffer: 32 * 1024 * 1024 }).toString();
    for (const m of listing.matchAll(/\blib\/([a-z0-9_-]+)\//gi)) {
      abis.add(m[1]);
    }
  } catch { /* 列表失敗回空集合 */ }
  return abis;
}

/**
 * 判斷「這個 APK 是否為 32-bit-only」——只有 armeabi-v7a(或其他 32bit ABI),沒有任何 64bit(arm64-v8a/x86_64)。
 * 純 Java(無 lib)不算 32-bit-only(回 false,因為任何裝置都能裝)。
 * 這種 app 在「64-bit-only」的新裝置上會 INSTALL_FAILED_NO_MATCHING_ABIS,需選支援 32bit 的裝置。
 */
export function isThirtyTwoBitOnly(apkPath) {
  const abis = detectApkAbis(apkPath);
  if (abis.size === 0) return false; // 無原生庫,不挑架構
  const has64 = abis.has('arm64-v8a') || abis.has('x86_64');
  const has32 = abis.has('armeabi-v7a') || abis.has('armeabi') || abis.has('x86');
  return has32 && !has64;
}

/** APKEditor 是否可用(容器建置時已放 jar + 裝 java);缺任一則不可用。 */
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
 * 把 XAPK / split bundle 合併成單一 universal APK,回新檔路徑。
 * 失敗拋出明確錯誤(含 APKEditor 輸出摘要)。
 * @param xapkPath 本地 XAPK 檔路徑
 */
export function mergeXapkToApk(xapkPath) {
  if (!apkMergeAvailable()) {
    throw new Error(
      'APKEditor/Java 不可用,無法合併 XAPK。請確認 runner 映像已安裝 java 並放置 APKEditor.jar。',
    );
  }
  const out = join(tmpdir(), `pa-merged-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.apk`);
  try {
    // m = merge;-i 輸入(XAPK/zip/dir)、-o 輸出單一 APK。-f 覆寫既有輸出。
    execFileSync('java', ['-jar', APKEDITOR_JAR, 'm', '-i', xapkPath, '-o', out, '-f'], {
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const stderr = err?.stderr ? String(err.stderr) : '';
    const stdout = err?.stdout ? String(err.stdout) : '';
    const detail = (stderr || stdout || String(err?.message || err)).slice(-800);
    throw new Error(`XAPK 合併失敗(APKEditor):${detail}`);
  }
  if (!existsSync(out) || statSync(out).size === 0) {
    throw new Error('XAPK 合併後未產生有效的 APK 檔');
  }
  return out;
}
