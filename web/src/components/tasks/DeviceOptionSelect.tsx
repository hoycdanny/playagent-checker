import { useI18n } from '../../i18n/I18nProvider.tsx';
import { loc5, pick5, type L5 } from '../../i18n/locale5.ts';

/**
 * 送出任務時的裝置條件:OS 版本、機型(手機/平板)、模擬器螢幕。
 *
 * 清單必須與後端 infra/lambda/api/deviceOptions.ts 一致 —— 這裡多寫一個版本,
 * 使用者選得到但送出時會被擋;少寫一個,則是明明支援卻選不到。
 */

/** 模擬器可選的 Android 版本(對齊後端 REDROID_ANDROID_VERSIONS)。 */
export const ANDROID_VERSIONS = ['15', '14', '13', '12', '11', '10', '9', '8.1'] as const;

/** 模擬器螢幕預設(對齊後端 EMULATOR_SCREENS)。平板版面是靠解析度做出來的。 */
export const EMULATOR_SCREENS = [
  { id: 'phone', width: 1080, height: 1920 },
  { id: 'phone-tall', width: 1080, height: 2400 },
  { id: 'tablet', width: 1600, height: 2560 },
  { id: 'tablet-land', width: 2560, height: 1600 },
] as const;

export type FormFactor = 'PHONE' | 'TABLET' | 'ANY';

const T = {
  androidVersion: ['Android 版本', 'Android version', 'Android 版本', 'Android バージョン', 'Android 버전'] as L5,
  androidHint: [
    '容器會跑這個版本的 Android。要測版本相容性就逐一換版本跑。',
    'The container runs this Android version. Switch versions to test compatibility.',
    '容器会跑这个版本的 Android。要测版本兼容性就逐一换版本跑。',
    'コンテナはこの Android バージョンで動作します。互換性テストはバージョンを変えて実行します。',
    '컨테이너가 이 Android 버전으로 실행됩니다. 호환성 테스트는 버전을 바꿔가며 실행하세요.',
  ] as L5,
  screen: ['螢幕尺寸', 'Screen size', '屏幕尺寸', '画面サイズ', '화면 크기'] as L5,
  screenHint: [
    '模擬器沒有真正的機型,畫面尺寸決定 App 走手機版面還是平板版面。',
    'The emulator has no real form factor — the screen size decides whether the app uses its phone or tablet layout.',
    '模拟器没有真正的机型,画面尺寸决定 App 走手机版面还是平板版面。',
    'エミュレータに実際の機種はなく、画面サイズがアプリのスマホ/タブレットレイアウトを決めます。',
    '에뮬레이터에는 실제 기기 종류가 없으며, 화면 크기가 앱의 폰/태블릿 레이아웃을 결정합니다.',
  ] as L5,
  phone: ['手機', 'Phone', '手机', 'スマートフォン', '폰'] as L5,
  phoneTall: ['手機(長螢幕)', 'Phone (tall)', '手机(长屏幕)', 'スマホ(縦長)', '폰(긴 화면)'] as L5,
  tablet: ['平板', 'Tablet', '平板', 'タブレット', '태블릿'] as L5,
  tabletLand: ['平板(橫向)', 'Tablet (landscape)', '平板(横向)', 'タブレット(横)', '태블릿(가로)'] as L5,
  formFactor: ['機型', 'Device type', '机型', '機種', '기기 종류'] as L5,
  formFactorHint: [
    '真機池同時有手機與平板。選「不限」會挑到最先可用的那一台。',
    'The device pool has both phones and tablets. "Any" picks whichever is free first.',
    '真机池同时有手机与平板。选「不限」会挑到最先可用的那一台。',
    '実機プールにはスマホとタブレットの両方があります。「指定なし」は最初に空いた端末を使います。',
    '실제 기기 풀에는 폰과 태블릿이 모두 있습니다. "제한 없음"은 가장 먼저 사용 가능한 기기를 선택합니다.',
  ] as L5,
  any: ['不限', 'Any', '不限', '指定なし', '제한 없음'] as L5,
  matched: [
    '符合「{kind}」的有 {n} 台。可指定其中一台,或留「自動派發」由系統挑第一台可用的。',
    '{n} {kind} device(s) match. Pick one, or leave it on auto-assign to use the first available.',
    '符合「{kind}」的有 {n} 台。可指定其中一台,或留「自动派发」由系统挑第一台可用的。',
    '「{kind}」に一致する端末は {n} 台です。指定するか、自動割り当てのままにできます。',
    '"{kind}" 조건에 맞는 기기가 {n}대 있습니다. 직접 지정하거나 자동 배정으로 두세요.',
  ] as L5,
  noneMatch: [
    '目前沒有符合這個機型態的可用機器。請改選其他機型態,或稍後再試(真機可用性隨時變化)。',
    'No available devices match this device type right now. Try another type or retry later — availability changes constantly.',
    '目前没有符合这个机型态的可用机器。请改选其他机型态,或稍后再试(真机可用性随时变化)。',
    '現在この機種に一致する利用可能な端末がありません。別の機種を選ぶか、後で再試行してください。',
    '현재 이 기기 종류에 맞는 사용 가능한 기기가 없습니다. 다른 종류를 선택하거나 나중에 다시 시도하세요.',
  ] as L5,
} as const;

const SCREEN_LABEL: Record<string, keyof typeof T> = {
  phone: 'phone', 'phone-tall': 'phoneTall', tablet: 'tablet', 'tablet-land': 'tabletLand',
};

/**
 * 機型態過濾後的提示:直接講「符合條件的有幾台」。
 * 數量為 0 時要明確說出來 —— 否則使用者只看到一個空清單,不知道是沒機器還是功能壞了。
 */
export function deviceFilterHint(ff: FormFactor, count: number, locale: string): string {
  const L = loc5(locale);
  if (count === 0) return pick5(T.noneMatch, L);
  const kind = pick5(ff === 'TABLET' ? T.tablet : ff === 'ANY' ? T.any : T.phone, L);
  return pick5(T.matched, L).replace('{n}', String(count)).replace('{kind}', kind);
}

/** 模擬器:Android 版本。 */
export function AndroidVersionSelect({ value, onChange, labelClass, hintClass }: {
  value: string;
  onChange: (v: string) => void;
  labelClass?: string;
  hintClass?: string;
}) {
  const { locale } = useI18n();
  const L = loc5(locale);
  return (
    <>
      <span className={labelClass}>{pick5(T.androidVersion, L)}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {ANDROID_VERSIONS.map((v) => (
          <option key={v} value={v}>{`Android ${v}`}</option>
        ))}
      </select>
      <span className={hintClass}>{pick5(T.androidHint, L)}</span>
    </>
  );
}

/** 模擬器:螢幕尺寸(= 手機或平板版面)。 */
export function EmulatorScreenSelect({ value, onChange, labelClass, hintClass }: {
  value: { width: number; height: number };
  onChange: (v: { width: number; height: number }) => void;
  labelClass?: string;
  hintClass?: string;
}) {
  const { locale } = useI18n();
  const L = loc5(locale);
  const current = EMULATOR_SCREENS.find((s) => s.width === value.width && s.height === value.height)?.id ?? 'phone';
  return (
    <>
      <span className={labelClass}>{pick5(T.screen, L)}</span>
      <select
        value={current}
        onChange={(e) => {
          const s = EMULATOR_SCREENS.find((x) => x.id === e.target.value);
          if (s) onChange({ width: s.width, height: s.height });
        }}
      >
        {EMULATOR_SCREENS.map((s) => (
          <option key={s.id} value={s.id}>
            {`${pick5(T[SCREEN_LABEL[s.id]!], L)} ${s.width}×${s.height}`}
          </option>
        ))}
      </select>
      <span className={hintClass}>{pick5(T.screenHint, L)}</span>
    </>
  );
}

/** Device Farm:機型(手機 / 平板 / 不限)。 */
export function FormFactorSelect({ value, onChange, labelClass, hintClass }: {
  value: FormFactor;
  onChange: (v: FormFactor) => void;
  labelClass?: string;
  hintClass?: string;
}) {
  const { locale } = useI18n();
  const L = loc5(locale);
  return (
    <>
      <span className={labelClass}>{pick5(T.formFactor, L)}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as FormFactor)}>
        <option value="PHONE">{pick5(T.phone, L)}</option>
        <option value="TABLET">{pick5(T.tablet, L)}</option>
        <option value="ANY">{pick5(T.any, L)}</option>
      </select>
      <span className={hintClass}>{pick5(T.formFactorHint, L)}</span>
    </>
  );
}
