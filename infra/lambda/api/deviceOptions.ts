/**
 * 送出任務時可選的裝置條件:OS 版本、機型(手機/平板)、模擬器螢幕。
 *
 * 為什麼集中在這裡:同一組規則要給三個地方用 —— API 驗證(tasks.ts)、
 * 前端選單(web 也引用同一份清單)、以及 emulator 主機的 userdata。
 * 散在各處一定會不一致,而不一致的後果是「選了但沒生效」這種最難發現的故障。
 */

export class DeviceOptionError extends Error {}

/**
 * 模擬器(Redroid 容器)可選的 Android 版本 → Docker image tag。
 *
 * **刻意用白名單而不是讓使用者自填**:tag 不存在時主機會在 docker pull 卡住然後逾時,
 * 使用者只會看到「開機逾時」,完全看不出是版本打錯。白名單讓它在送出任務時就被擋下。
 *
 * 這些是 redroid/redroid 在 Docker Hub 上長期提供的主線 tag。
 * 新增版本前請先確認該 tag 真的存在 —— 這裡寫了但 registry 沒有,等於把失敗延後到執行時。
 */
export const REDROID_ANDROID_VERSIONS = [
  { version: '15', tag: '15.0.0-latest', label: 'Android 15' },
  { version: '14', tag: '14.0.0-latest', label: 'Android 14' },
  { version: '13', tag: '13.0.0-latest', label: 'Android 13' },
  { version: '12', tag: '12.0.0-latest', label: 'Android 12' },
  { version: '11', tag: '11.0.0-latest', label: 'Android 11' },
  { version: '10', tag: '10.0.0-latest', label: 'Android 10' },
  { version: '9', tag: '9.0.0-latest', label: 'Android 9' },
  // 註:8.1 的 tag 是 8.1.0-latest,不是 8.1.0.0 —— 版本與 tag 之間沒有通用公式。
  // 這就是為什麼完整 tag 由這裡解析後寫進 job.json,而不是讓 userdata 自己組字串
  // (組字串的版本對 8.1 會拉到不存在的映像,主機只會回報「開機逾時」)。
  { version: '8.1', tag: '8.1.0-latest', label: 'Android 8.1' },
] as const;

/** 完整容器映像名(job.json 存這個,userdata 直接用)。 */
export function redroidImage(version: string | undefined): string | null {
  const tag = redroidTag(version);
  return tag ? `redroid/redroid:${tag}` : null;
}

/** userdata 的防呆:映像名的合法形狀(只接受 redroid 官方 repo)。 */
export const REDROID_IMAGE_RE = /^redroid\/redroid:[0-9]+(\.[0-9]+)*-latest$/;

/** 沒有明選時用的 Android 版本(維持原本硬編碼的行為,升級不改變既有任務)。 */
export const DEFAULT_ANDROID_VERSION = '15';

export type AndroidVersion = (typeof REDROID_ANDROID_VERSIONS)[number]['version'];

/** Android 版本 → Redroid image tag;不認識的版本回 null(呼叫端必須明確處理)。 */
export function redroidTag(version: string | undefined): string | null {
  const hit = REDROID_ANDROID_VERSIONS.find((v) => v.version === String(version ?? ''));
  return hit ? hit.tag : null;
}

/**
 * 驗證 androidVersion。只有模擬器後端有意義 —— Device Farm 的 OS 由挑中的真機決定,
 * 不是我們能指定的,硬帶會讓使用者以為自己選了卻完全沒作用。
 */
export function parseAndroidVersion(raw: unknown, backend: string): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (backend !== 'emulator') return undefined;
  const v = String(raw);
  if (!redroidTag(v)) {
    throw new DeviceOptionError(
      `不支援的 Android 版本:${v}。可選:${REDROID_ANDROID_VERSIONS.map((x) => x.version).join(' / ')}`,
    );
  }
  return v;
}

/** 機型。ANY = 不限(手機或平板都可以,挑到哪台算哪台)。 */
export const FORM_FACTORS = ['PHONE', 'TABLET', 'ANY'] as const;
export type FormFactor = (typeof FORM_FACTORS)[number];

/**
 * 驗證 formFactor(只有 Device Farm 有意義:真機池裡確實同時有手機與平板)。
 * 模擬器的「平板」是靠解析度做出來的,不是靠機型欄位 —— 見 EMULATOR_SCREENS。
 */
export function parseFormFactor(raw: unknown, backend: string): FormFactor | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (backend !== 'devicefarm') return undefined;
  const v = String(raw).toUpperCase();
  if (!(FORM_FACTORS as readonly string[]).includes(v)) {
    throw new DeviceOptionError(`formFactor 必須是 ${FORM_FACTORS.join(' / ')} 之一`);
  }
  return v as FormFactor;
}

/**
 * Device Farm 的 ListDevices 機型過濾值。
 * ANY → 不加這個 filter(讓手機與平板都進清單);未指定 → 沿用原本只看手機的行為。
 */
export function formFactorFilterValues(ff: string | undefined): string[] | null {
  const v = String(ff ?? '').toUpperCase();
  if (v === 'ANY') return null;
  if (v === 'TABLET') return ['TABLET'];
  // 包含「沒指定」與「不認識的值」:退回只挑手機,也就是這個功能之前的行為。
  // 不丟錯是刻意的 —— 這是執行路徑上的邊界函式,寧可用保守的預設值跑完,
  // 也不要因為一個陌生字串讓整個任務失敗(格式把關在 parseFormFactor,送出時就擋掉了)。
  return ['PHONE'];
}

/**
 * 模擬器的螢幕預設值。Redroid 的「平板」就是給它平板的解析度 ——
 * 容器裡沒有真正的機型概念,畫面尺寸決定了 App 走手機版面還是平板版面。
 */
export const EMULATOR_SCREENS = [
  { id: 'phone', width: 1080, height: 1920, label: '手機 1080×1920' },
  { id: 'phone-tall', width: 1080, height: 2400, label: '手機(長螢幕) 1080×2400' },
  { id: 'tablet', width: 1600, height: 2560, label: '平板 1600×2560' },
  { id: 'tablet-land', width: 2560, height: 1600, label: '平板(橫向) 2560×1600' },
] as const;

/** 沒有明選時的模擬器螢幕(與 emulator-userdata.sh 的預設值一致)。 */
export const DEFAULT_EMULATOR_SCREEN = { width: 1080, height: 1920 };
