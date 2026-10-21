import { useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider.tsx';

/**
 * 執行環境(送出任務頁):列出全部選項,依 App 平台與建置進度停用不適用的。
 * 「長時」= Device Farm 真機 + 每 140 分鐘自動換新連線接續(maxSegments ≠ 1)。
 */
export type RuntimeId =
  | 'web'
  | 'devicefarm-android'
  | 'devicefarm-android-long'
  | 'devicefarm-ios'
  | 'devicefarm-ios-long'
  | 'emulator-android'
  | 'simulator-ios'
  | 'windows'
  | 'linux';

export interface Runtime {
  id: RuntimeId;
  /** 送給 API 的 backend。 */
  backend: string;
  /** 適用的 App 平台。 */
  platform: 'web' | 'android' | 'ios' | 'windows' | 'linux';
  long: boolean;
  /** 已可端到端執行;false = 建置中(顯示但不能選)。 */
  available: boolean;
}

export const RUNTIMES: Runtime[] = [
  { id: 'web', backend: 'web', platform: 'web', long: false, available: true },
  { id: 'devicefarm-android', backend: 'devicefarm', platform: 'android', long: false, available: true },
  { id: 'devicefarm-android-long', backend: 'devicefarm', platform: 'android', long: true, available: true },
  // Android 容器:Graviton EC2 + Redroid(開源),沒有 150 分鐘限制,短時與長時同一個選項(另選最長時數)。
  { id: 'emulator-android', backend: 'emulator', platform: 'android', long: false, available: true },
  { id: 'devicefarm-ios', backend: 'devicefarm', platform: 'ios', long: false, available: true },
  { id: 'devicefarm-ios-long', backend: 'devicefarm', platform: 'ios', long: true, available: true },
  { id: 'simulator-ios', backend: 'ios-simulator', platform: 'ios', long: false, available: false },
  // Windows:Amazon GameLift Streams(NVIDIA GPU);沒有人連線的 session 最長 60 分鐘。
  { id: 'windows', backend: 'windows', platform: 'windows', long: false, available: true },
  { id: 'linux', backend: 'linux', platform: 'linux', long: false, available: false },
];

/** [繁中, English, 简中, 日本語, 한국어] */
type L5 = readonly [string, string, string, string, string];
const LABEL: Record<RuntimeId, L5> = {
  web: ['Web 瀏覽器', 'Web browser', 'Web 浏览器', 'Web ブラウザ', '웹 브라우저'],
  'devicefarm-android': ['Android(Device Farm 真機)', 'Android (Device Farm real device)', 'Android(Device Farm 真机)', 'Android(Device Farm 実機)', 'Android(Device Farm 실기기)'],
  'devicefarm-android-long': ['Android(Device Farm 真機・長時)', 'Android (Device Farm real device, long run)', 'Android(Device Farm 真机・长时)', 'Android(Device Farm 実機・長時間)', 'Android(Device Farm 실기기・장시간)'],
  'emulator-android': ['Android(模擬器・Redroid 容器)', 'Android (emulator, Redroid container)', 'Android(模拟器・Redroid 容器)', 'Android(エミュレータ・Redroid コンテナ)', 'Android(에뮬레이터・Redroid 컨테이너)'],
  'devicefarm-ios': ['iOS(Device Farm 真機)', 'iOS (Device Farm real device)', 'iOS(Device Farm 真机)', 'iOS(Device Farm 実機)', 'iOS(Device Farm 실기기)'],
  'devicefarm-ios-long': ['iOS(Device Farm 真機・長時)', 'iOS (Device Farm real device, long run)', 'iOS(Device Farm 真机・长时)', 'iOS(Device Farm 実機・長時間)', 'iOS(Device Farm 실기기・장시간)'],
  'simulator-ios': ['iOS(模擬器)', 'iOS (simulator)', 'iOS(模拟器)', 'iOS(シミュレータ)', 'iOS(시뮬레이터)'],
  windows: ['Windows(GPU 主機・GameLift Streams)', 'Windows (GPU host, GameLift Streams)', 'Windows(GPU 主机・GameLift Streams)', 'Windows(GPU ホスト・GameLift Streams)', 'Windows(GPU 호스트・GameLift Streams)'],
  linux: ['Linux(GPU 主機)', 'Linux (GPU host)', 'Linux(GPU 主机)', 'Linux(GPU ホスト)', 'Linux(GPU 호스트)'],
};
/**
 * 每個執行環境的「適用情境」與「限制」。
 * 這些不是行銷文案:都是實測得到的硬限制(AWS 配額、模擬器相容性、驅動能力),
 * 在送出任務前就講清楚,避免跑完才發現環境做不到。
 */
const DETAIL: Record<RuntimeId, { use: L5; limit: L5 }> = {
  web: {
    use: [
      '網頁 / H5 遊戲,用無頭 Chromium 執行,啟動最快。',
      'Web / H5 games on headless Chromium. Fastest to start.',
      '网页 / H5 游戏,用无头 Chromium 执行,启动最快。',
      'Web / H5 ゲーム。ヘッドレス Chromium で実行し、起動が最速です。',
      '웹 / H5 게임. 헤드리스 Chromium으로 실행되어 가장 빠르게 시작합니다.',
    ],
    limit: [
      '只測瀏覽器內的內容;沒有真機的 FPS / 溫度 / 耗電與音效資料。',
      'Browser content only; no device FPS, temperature, battery or audio data.',
      '只测浏览器内的内容;没有真机的 FPS / 温度 / 耗电与音效数据。',
      'ブラウザ内の内容のみ。実機の FPS・温度・消費電力・音声データはありません。',
      '브라우저 내용만 측정합니다. 실기기 FPS·온도·배터리·사운드 데이터는 없습니다.',
    ],
  },
  'devicefarm-android': {
    use: [
      'Android 真機。遊戲會擋模擬器、需要真實 GMS 或真實行動網路時選這個。',
      'Real Android device. Use it when the game blocks emulators or needs real GMS / mobile network.',
      'Android 真机。游戏会挡模拟器、需要真实 GMS 或真实移动网络时选这个。',
      'Android 実機。エミュレータを弾くゲームや、実際の GMS・モバイル回線が必要な場合に選びます。',
      'Android 실기기. 게임이 에뮬레이터를 차단하거나 실제 GMS·모바일 네트워크가 필요할 때 선택합니다.',
    ],
    limit: [
      '單次連線最長 150 分鐘(AWS 固定上限,不可調整);機型依當下可用真機。',
      'One session lasts at most 150 minutes (a fixed AWS limit); the model depends on device availability.',
      '单次连接最长 150 分钟(AWS 固定上限,不可调整);机型依当下可用真机。',
      '1 セッション最大 150 分(AWS の固定上限、変更不可)。機種はその時点で空いている実機によります。',
      '세션당 최대 150분(AWS 고정 한도, 변경 불가). 기기는 그때 사용 가능한 실기기에 따릅니다.',
    ],
  },
  'devicefarm-android-long': {
    use: [
      '需要超過 150 分鐘的 Android 真機測試(長時掛機、RTP 統計)。',
      'Android real-device runs longer than 150 minutes (idle farming, RTP statistics).',
      '需要超过 150 分钟的 Android 真机测试(长时挂机、RTP 统计)。',
      '150 分を超える Android 実機テスト(長時間の放置、RTP 統計)。',
      '150분을 넘는 Android 실기기 테스트(장시간 방치, RTP 통계).',
    ],
    limit: [
      '每 140 分鐘換一條新連線接續,換線時遊戲會重新啟動一次(進度要能從頭回到測試點)。',
      'A new session starts every 140 minutes, which restarts the game (the run must be able to return to the test point).',
      '每 140 分钟换一条新连接接续,换线时游戏会重新启动一次(进度要能从头回到测试点)。',
      '140 分ごとに新しいセッションへ切り替わり、その際ゲームが再起動します(テスト地点まで戻れる必要があります)。',
      '140분마다 새 세션으로 이어지며 그때 게임이 재시작됩니다(테스트 지점까지 다시 도달할 수 있어야 합니다).',
    ],
  },
  'emulator-android': {
    use: [
      'Android 長時測試與大量平行執行。沒有 150 分鐘限制,可選 1~72 小時,成本低於真機。',
      'Long Android runs and high parallelism. No 150-minute cap, 1–72 hours, cheaper than real devices.',
      'Android 长时测试与大量并行执行。没有 150 分钟限制,可选 1~72 小时,成本低于真机。',
      'Android の長時間テストと大量並列実行。150 分の制限がなく 1〜72 時間、実機より低コストです。',
      'Android 장시간 테스트와 대규모 병렬 실행. 150분 제한이 없고 1~72시간, 실기기보다 저렴합니다.',
    ],
    limit: [
      '容器模擬器:有反模擬器檢查的遊戲會被擋(遊戲會自己關閉),這類請改用真機。沒有錄影與音效判斷,不支援雙指縮放。',
      'Container emulator: games with anti-emulator checks will shut themselves down — use a real device for those. No video recording or audio checks, and no pinch gestures.',
      '容器模拟器:有反模拟器检查的游戏会被挡(游戏会自己关闭),这类请改用真机。没有录屏与音效判断,不支持双指缩放。',
      'コンテナ型エミュレータ:エミュレータ検知のあるゲームは自ら終了します(その場合は実機へ)。録画と音声判定はなく、ピンチ操作も非対応です。',
      '컨테이너 에뮬레이터: 에뮬레이터 탐지가 있는 게임은 스스로 종료됩니다(그런 경우 실기기 사용). 녹화·사운드 판정이 없고 핀치 제스처도 지원하지 않습니다.',
    ],
  },
  'devicefarm-ios': {
    use: [
      'iOS 真機(目前 iOS 只有真機可用)。',
      'Real iOS device (the only iOS option available).',
      'iOS 真机(目前 iOS 只有真机可用)。',
      'iOS 実機(現在 iOS は実機のみ利用できます)。',
      'iOS 실기기(현재 iOS는 실기기만 사용할 수 있습니다).',
    ],
    limit: [
      '單次連線最長 150 分鐘(AWS 固定上限);需要可安裝的 .ipa;沒有錄影聲音。',
      'One session lasts at most 150 minutes (a fixed AWS limit); needs an installable .ipa; recordings have no audio.',
      '单次连接最长 150 分钟(AWS 固定上限);需要可安装的 .ipa;没有录音。',
      '1 セッション最大 150 分(AWS の固定上限)。インストール可能な .ipa が必要で、録画に音声は入りません。',
      '세션당 최대 150분(AWS 고정 한도). 설치 가능한 .ipa가 필요하며 녹화에 소리가 없습니다.',
    ],
  },
  'devicefarm-ios-long': {
    use: [
      '需要超過 150 分鐘的 iOS 真機測試。',
      'iOS real-device runs longer than 150 minutes.',
      '需要超过 150 分钟的 iOS 真机测试。',
      '150 分を超える iOS 実機テスト。',
      '150분을 넘는 iOS 실기기 테스트.',
    ],
    limit: [
      '每 140 分鐘換一條新連線接續,換線時遊戲會重新啟動一次。',
      'A new session starts every 140 minutes, which restarts the game.',
      '每 140 分钟换一条新连接接续,换线时游戏会重新启动一次。',
      '140 分ごとに新しいセッションへ切り替わり、その際ゲームが再起動します。',
      '140분마다 새 세션으로 이어지며 그때 게임이 재시작됩니다.',
    ],
  },
  'simulator-ios': {
    use: [
      '(尚未建置)iOS 模擬器。',
      '(not built yet) iOS simulator.',
      '(尚未建置)iOS 模拟器。',
      '(未構築)iOS シミュレータ。',
      '(미구축) iOS 시뮬레이터.',
    ],
    limit: [
      '不建議:EC2 Mac 一配置就最少計費 24 小時,而且模擬器不能安裝 .ipa,需要遊戲團隊另外提供 Simulator build。iOS 請用真機。',
      'Not recommended: an EC2 Mac is billed for a minimum of 24 hours, and the simulator cannot install an .ipa — it needs a separate simulator build. Use a real device for iOS.',
      '不建议:EC2 Mac 一配置就最少计费 24 小时,而且模拟器不能安装 .ipa,需要游戏团队另外提供 Simulator build。iOS 请用真机。',
      '非推奨:EC2 Mac は確保すると最低 24 時間課金され、シミュレータは .ipa をインストールできません(別途 Simulator ビルドが必要)。iOS は実機を使ってください。',
      '권장하지 않음: EC2 Mac은 확보 시 최소 24시간 과금되고, 시뮬레이터는 .ipa를 설치할 수 없어 별도 Simulator 빌드가 필요합니다. iOS는 실기기를 사용하세요.',
    ],
  },
  windows: {
    use: [
      'Windows PC 遊戲(.exe 安裝檔或免安裝 .zip),在 NVIDIA GPU 主機上以原生解析度渲染。適合單場 1 小時內的功能驗證。',
      'Windows PC games (.exe installer or portable .zip) rendered on an NVIDIA GPU host. Good for feature checks within one hour.',
      'Windows PC 游戏(.exe 安装包或免安装 .zip),在 NVIDIA GPU 主机上以原生分辨率渲染。适合单场 1 小时内的功能验证。',
      'Windows PC ゲーム(.exe インストーラーまたはポータブル .zip)を NVIDIA GPU ホストでネイティブ解像度で描画します。1 時間以内の機能確認に適します。',
      'Windows PC 게임(.exe 설치 파일 또는 포터블 .zip)을 NVIDIA GPU 호스트에서 기본 해상도로 렌더링합니다. 1시간 이내 기능 검증에 적합합니다.',
    ],
    limit: [
      '單次最長 60 分鐘(AWS 上限,無人連線觀看時)。解析度總像素最多 1920×1080,直式最多 1080×1920,做不到 1080×4096。首次啟動約 10~15 分鐘。獨佔全螢幕的 DirectX 遊戲可能截到黑畫面,且有反作弊的遊戲可能忽略合成滑鼠事件。',
      'At most 60 minutes per run (an AWS limit when no viewer is connected). Total pixels cap at 1920×1080, so portrait tops out at 1080×1920 and 1080×4096 is impossible. First start takes 10–15 minutes. Exclusive full-screen DirectX games may capture black, and anti-cheat games may ignore synthetic mouse events.',
      '单次最长 60 分钟(AWS 上限,无人连线观看时)。分辨率总像素最多 1920×1080,竖屏最多 1080×1920,做不到 1080×4096。首次启动约 10~15 分钟。独占全屏的 DirectX 游戏可能截到黑屏,且有反作弊的游戏可能忽略合成鼠标事件。',
      '1 回最大 60 分(視聴者が接続していない場合の AWS 上限)。総ピクセル数は最大 1920×1080 のため、縦は 1080×1920 まで、1080×4096 は不可能です。初回起動は 10〜15 分。排他フルスクリーンの DirectX ゲームは黒画面になることがあり、アンチチートのあるゲームは合成マウス入力を無視する場合があります。',
      '1회 최대 60분(시청자 미연결 시 AWS 한도). 총 픽셀은 최대 1920×1080이므로 세로는 1080×1920까지이며 1080×4096은 불가능합니다. 첫 시작은 10~15분. 전체 화면 독점 DirectX 게임은 검은 화면으로 캡처될 수 있고, 안티치트 게임은 합성 마우스 입력을 무시할 수 있습니다.',
    ],
  },
  linux: {
    use: [
      '(尚未建置)Linux 原生遊戲。',
      '(not built yet) Native Linux games.',
      '(尚未建置)Linux 原生游戏。',
      '(未構築)Linux ネイティブゲーム。',
      '(미구축) Linux 네이티브 게임.',
    ],
    limit: [
      '尚未建置。Linux 版的手機 / 博弈遊戲很少,目前優先度最低。',
      'Not built yet. Few mobile / casino titles ship a Linux build, so this is the lowest priority.',
      '尚未建置。Linux 版的手机 / 博弈游戏很少,目前优先度最低。',
      '未構築。Linux 版のモバイル / カジノゲームはほとんどなく、優先度は最も低いです。',
      '미구축. Linux 버전 모바일 / 카지노 게임이 거의 없어 우선순위가 가장 낮습니다.',
    ],
  },
};

const T = {
  building: ['建置中', 'in development', '建置中', '開発中', '개발 중'],
  use: ['適用情境', 'Best for', '适用情境', '適した用途', '적합한 용도'],
  limit: ['限制', 'Limits', '限制', '制限', '제한'],
  otherPlatform: ['不適用此應用', 'not for this app', '不适用此应用', 'このアプリには使えません', '이 앱에는 사용 불가'],
  hint: ['依應用平台列出可用的環境;「長時」每 140 分鐘自動換新連線接續。', 'Options follow the app platform; “long run” opens a new session every 140 minutes.', '按应用平台列出可用的环境;「长时」每 140 分钟自动换新连接接续。', 'アプリのプラットフォームに合う環境を表示。「長時間」は 140 分ごとに新しいセッションへ切り替えます。', '앱 플랫폼에 맞는 환경을 표시합니다. "장시간"은 140분마다 새 세션으로 이어 갑니다.'],
} as const satisfies Record<string, L5>;
const LOC_IDX: Record<string, number> = { 'zh-Hant': 0, en: 1, 'zh-Hans': 2, ja: 3, ko: 4 };

/** 自管主機(Android 容器 / Windows)的最長執行時數選項。 */
export const HOUR_OPTIONS = [2, 6, 12, 24, 48, 72] as const;
const HT = {
  label: ['最長執行時間', 'Maximum run time', '最长执行时间', '最大実行時間', '최대 실행 시간'],
  hint: ['時間到主機自動關閉並保留結果;測試提早完成會立刻結束,不會多算。', 'The host shuts down at the limit and keeps the results; finishing early ends the run right away.', '时间到主机自动关闭并保留结果;测试提早完成会立刻结束,不会多算。', '上限で自動終了し結果は保存されます。早く終われば即終了します。', '한도에 도달하면 자동 종료되고 결과는 보존됩니다. 일찍 끝나면 바로 종료됩니다.'],
  hours: ['{n} 小時', '{n} h', '{n} 小时', '{n} 時間', '{n}시간'],
} as const satisfies Record<string, L5>;

/** Windows(GameLift Streams):沒有人連線的 session 最長 60 分鐘(AWS 上限)。 */
export const WINDOWS_HOUR_OPTIONS = [1] as const;
const WHT = {
  hint: ['Windows 主機(GameLift Streams)在沒有人連線觀看時,單次最長 60 分鐘(AWS 上限);時間到自動結束並保留結果。', 'Windows hosts (GameLift Streams) run up to 60 minutes per session when no viewer is connected (AWS limit); results are kept.', 'Windows 主机(GameLift Streams)在没有人连线观看时,单次最长 60 分钟(AWS 上限);时间到自动结束并保留结果。', 'Windows ホスト(GameLift Streams)は視聴者が接続していない場合 1 回最大 60 分です(AWS の上限)。結果は保存されます。', 'Windows 호스트(GameLift Streams)는 시청자가 연결되지 않으면 1회 최대 60분입니다(AWS 한도). 결과는 보존됩니다.'],
} as const satisfies Record<string, L5>;

/** 最長執行時數(Android 容器 / Windows 才顯示)。 */
export function HoursSelect({ value, onChange, labelClass, hintClass, backend }: { value: number; onChange: (h: number) => void; labelClass: string; hintClass: string; backend?: string }) {
  const { locale } = useI18n();
  const li = LOC_IDX[locale] ?? 1;
  const isWin = backend === 'windows';
  const options: readonly number[] = isWin ? WINDOWS_HOUR_OPTIONS : HOUR_OPTIONS;
  const shown = options.includes(value) ? value : options[0]!;
  // 順序是 標題 → 控制項 → 說明,與同一列的其他欄位一致;
  // 說明擺在控制項之前的話,行數不同的說明會把各欄的下拉推到不同高度。
  return (
    <>
      <span className={labelClass}>{HT.label[li]}</span>
      <select value={shown} onChange={(e) => onChange(Number(e.target.value))}>
        {options.map((h) => <option key={h} value={h}>{(HT.hours[li] ?? HT.hours[1]).replace('{n}', String(h))}</option>)}
      </select>
      <span className={hintClass}>{isWin ? WHT.hint[li] : HT.hint[li]}</span>
    </>
  );
}

/** 依後端把最長時數壓到可用範圍(Windows 只有 1 小時)。 */
export function effectiveHours(backend: string, hours: number): number {
  return backend === 'windows' ? 1 : hours;
}

// ── 畫面解析度(Windows 啟動時輸入)──────────────────────────────
/** GameLift Streams 單一 session 總像素上限(1920×1080)。 */
export const MAX_PIXELS = 2_073_600;
export interface Display { width: number; height: number }
export const DISPLAY_PRESETS: readonly Display[] = [
  { width: 1920, height: 1080 },
  { width: 1080, height: 1920 },
  { width: 1600, height: 900 },
  { width: 1280, height: 720 },
  { width: 720, height: 1280 },
  { width: 1366, height: 768 },
];
const DT = {
  label: ['畫面解析度', 'Screen resolution', '画面分辨率', '画面解像度', '화면 해상도'],
  hint: ['遊戲視窗的虛擬螢幕大小。寬高需為偶數,總像素最多 1920×1080(可直式 1080×1920)。', 'Virtual monitor size. Width and height must be even; at most 1920×1080 pixels in total (portrait 1080×1920 is fine).', '游戏窗口的虚拟屏幕大小。宽高需为偶数,总像素最多 1920×1080(可竖屏 1080×1920)。', '仮想モニターのサイズ。幅・高さは偶数、総ピクセル数は最大 1920×1080(縦 1080×1920 も可)。', '가상 모니터 크기. 너비·높이는 짝수, 총 픽셀은 최대 1920×1080(세로 1080×1920 가능).'],
  custom: ['自訂', 'Custom', '自定义', 'カスタム', '사용자 지정'],
  landscape: ['橫式', 'landscape', '横屏', '横', '가로'],
  portrait: ['直式', 'portrait', '竖屏', '縦', '세로'],
  width: ['寬', 'Width', '宽', '幅', '너비'],
  height: ['高', 'Height', '高', '高さ', '높이'],
  errEven: ['寬高需為 320~4096 的偶數', 'Width and height must be even numbers from 320 to 4096', '宽高需为 320~4096 的偶数', '幅・高さは 320〜4096 の偶数にしてください', '너비·높이는 320~4096 사이의 짝수여야 합니다'],
  errPixels: ['總像素超過 1920×1080(2,073,600)', 'Total pixels exceed 1920×1080 (2,073,600)', '总像素超过 1920×1080(2,073,600)', '総ピクセル数が 1920×1080(2,073,600)を超えています', '총 픽셀이 1920×1080(2,073,600)을 초과합니다'],
} as const satisfies Record<string, L5>;

/** 解析度錯誤訊息(合法回 null)。 */
export function displayError(d: Display, locale: string): string | null {
  const li = LOC_IDX[locale] ?? 1;
  const ok = (n: number) => Number.isInteger(n) && n >= 320 && n <= 4096 && n % 2 === 0;
  if (!ok(d.width) || !ok(d.height)) return DT.errEven[li] ?? DT.errEven[1];
  if (d.width * d.height > MAX_PIXELS) return DT.errPixels[li] ?? DT.errPixels[1];
  return null;
}

export function DisplaySelect({ value, onChange, labelClass, hintClass }: { value: Display; onChange: (d: Display) => void; labelClass: string; hintClass: string }) {
  const { locale } = useI18n();
  const li = LOC_IDX[locale] ?? 1;
  const presetIdx = DISPLAY_PRESETS.findIndex((p) => p.width === value.width && p.height === value.height);
  const [custom, setCustom] = useState(presetIdx < 0);
  const err = displayError(value, locale);
  const orient = (d: Display) => (d.width >= d.height ? DT.landscape[li] : DT.portrait[li]);
  return (
    <>
      <span className={labelClass}>{DT.label[li]}</span>
      <select
        value={custom ? 'custom' : String(presetIdx)}
        onChange={(e) => {
          if (e.target.value === 'custom') { setCustom(true); return; }
          setCustom(false);
          const p = DISPLAY_PRESETS[Number(e.target.value)];
          if (p) onChange(p);
        }}
      >
        {DISPLAY_PRESETS.map((p, i) => <option key={i} value={i}>{p.width}×{p.height}({orient(p)})</option>)}
        <option value="custom">{DT.custom[li]}</option>
      </select>
      {custom && (
        <span style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
          <input type="number" min={320} max={4096} step={2} aria-label={DT.width[li]} value={value.width}
            onChange={(e) => onChange({ ...value, width: Number(e.target.value) })} style={{ width: 96 }} />
          <span aria-hidden="true">×</span>
          <input type="number" min={320} max={4096} step={2} aria-label={DT.height[li]} value={value.height}
            onChange={(e) => onChange({ ...value, height: Number(e.target.value) })} style={{ width: 96 }} />
        </span>
      )}
      <span className={hintClass}>{DT.hint[li]}</span>
      {err && <span className={hintClass} role="alert" style={{ color: 'var(--danger, #c0392b)' }}>{err}</span>}
    </>
  );
}

export const runtimeById = (id: string): Runtime | undefined => RUNTIMES.find((r) => r.id === id);

/** App 平台的預設執行環境(第一個可用且平台相符的)。 */
export function defaultRuntime(platform: string | undefined): Runtime {
  const p = platform === 'web' || !platform ? 'web' : platform;
  return RUNTIMES.find((r) => r.platform === p && r.available) ?? RUNTIMES[0]!;
}

/**
 * 執行環境下拉。
 *
 * 只有下拉本身 —— 「適用情境 / 限制」那兩段長文字由 RuntimeDetail 另外畫。
 * 兩者分開是因為它們需要的寬度差一個量級:下拉跟隔壁的機型態、裝置一樣是一欄就夠,
 * 長文字塞進同一欄會被擠成細長一條,還會把同一列的其他欄位往下推。
 */
export function RuntimeSelect({ platform, value, onChange }: {
  /** 已選 App 的平台;未選 App 時不限平台。 */
  platform?: string;
  value: RuntimeId;
  onChange: (r: Runtime) => void;
}) {
  const { locale } = useI18n();
  const li = LOC_IDX[locale] ?? 1;
  return (
    <select value={value} onChange={(e) => { const r = runtimeById(e.target.value); if (r) onChange(r); }}>
      {RUNTIMES.map((r) => {
        const wrongPlatform = !!platform && r.platform !== platform;
        const suffix = !r.available ? `(${T.building[li]})` : wrongPlatform ? `(${T.otherPlatform[li]})` : '';
        return (
          <option key={r.id} value={r.id} disabled={!r.available || wrongPlatform}>
            {LABEL[r.id][li]}{suffix}
          </option>
        );
      })}
    </select>
  );
}

/**
 * 所選執行環境的適用情境與硬限制:在送出之前就看得到,不要等跑完才發現做不到。
 * 放在欄位列底下橫跨整排,長句子才讀得順。
 */
export function RuntimeDetail({ value, className, hintClass }: { value: RuntimeId; className?: string; hintClass: string }) {
  const { locale } = useI18n();
  const li = LOC_IDX[locale] ?? 1;
  const selected = runtimeById(value);
  if (!selected) return null;
  return (
    <div className={className}>
      <span className={hintClass}>{T.hint[li]}</span>
      <span className={hintClass}>
        <strong>{T.use[li]}</strong>:{DETAIL[selected.id].use[li]}
      </span>
      <span className={hintClass}>
        <strong>{T.limit[li]}</strong>:{DETAIL[selected.id].limit[li]}
      </span>
    </div>
  );
}
