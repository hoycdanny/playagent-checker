/** 任務詳情用的小型線條 icon(24 格、currentColor;純裝飾,一律 aria-hidden)。 */
export type InfoIconName =
  | 'target'
  | 'chart'
  | 'book'
  | 'phone'
  | 'phoneL'
  | 'cpu'
  | 'coin'
  | 'hash'
  | 'gamepad'
  | 'eye'
  | 'sparkle'
  | 'cloud'
  | 'package'
  | 'upload'
  | 'plug'
  | 'play'
  | 'clock'
  | 'check'
  | 'x'
  | 'rocket'
  | 'user'
  // 誰決定這一步 / 事件類別
  | 'compass'
  | 'bolt'
  | 'hand'
  | 'db'
  | 'script'
  | 'volume'
  | 'mute'
  | 'term'
  | 'msg'
  | 'tool'
  | 'alert'
  | 'pin'
  | 'route'
  // 介面操作
  | 'list'
  | 'pulse'
  | 'filter'
  | 'search'
  | 'playFill'
  | 'pauseFill'
  | 'first'
  | 'last'
  | 'prev'
  | 'next'
  | 'back'
  | 'send'
  | 'max'
  | 'min'
  | 'chevDown'
  | 'chevUp'
  | 'chevRight'
  | 'live'
  | 'trash';

const PATHS: Record<InfoIconName, string[]> = {
  target: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M12 12h.01'],
  chart: ['M4 3v18h17', 'M8 17v-5M13 17V8M18 17v-9'],
  book: ['M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5v14Z', 'M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5'],
  phone: ['M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z', 'M11 18h2'],
  phoneL: ['M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7Z', 'M18 11v2'],
  cpu: ['M7 7h10v10H7z', 'M10 10h4v4h-4z', 'M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3'],
  coin: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M15 9.5c-.5-1-1.6-1.5-3-1.5-1.7 0-3 .8-3 2s1.3 1.7 3 2 3 .8 3 2-1.3 2-3 2c-1.4 0-2.5-.5-3-1.5', 'M12 6v2M12 16v2'],
  hash: ['M4 9h16M4 15h16M10 3 8 21M16 3l-2 18'],
  gamepad: ['M6 11h4M8 9v4', 'M15 12h.01M18 10h.01', 'M17.3 5H6.7a4 4 0 0 0-3.96 3.43l-.7 5A3 3 0 0 0 5 17c.8 0 1.5-.3 2-.9L8.5 14h7l1.5 2.1c.5.6 1.2.9 2 .9a3 3 0 0 0 2.96-3.57l-.7-5A4 4 0 0 0 17.3 5Z'],
  eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z'],
  sparkle: ['M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z', 'M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z'],
  cloud: ['M17.5 19H8a5 5 0 1 1 .9-9.92A6 6 0 0 1 20 11.5a3.75 3.75 0 0 1-2.5 7.5Z'],
  package: ['M21 8 12 3 3 8v8l9 5 9-5V8Z', 'M3 8l9 5 9-5', 'M12 13v8', 'M7.5 5.5l9 5'],
  upload: ['M12 16V4', 'M7 9l5-5 5 5', 'M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3'],
  plug: ['M9 2v5M15 2v5', 'M6 7h12v4a6 6 0 0 1-12 0V7Z', 'M12 17v5'],
  play: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M10 8.5v7l6-3.5-6-3.5Z'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 7v5l3 2'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  x: ['M6 6l12 12M18 6 6 18'],
  user: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M4 21a8 8 0 0 1 16 0'],
  rocket: ['M5 15c-1.5 1.3-2 4-2 6 2 0 4.7-.5 6-2', 'M9 15l-3-3c1.5-4.5 5-9 12-9 0 7-4.5 10.5-9 12Z', 'M14.5 9.5h.01', 'M6 12H3l2-4h4', 'M12 18v3l4-2v-4'],
  compass: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M15.5 8.5l-2 5-5 2 2-5 5-2Z'],
  bolt: ['M13 2 4 14h7l-1 8 9-12h-7l1-8Z'],
  hand: ['M9 11V5a1.5 1.5 0 0 1 3 0v5', 'M12 10V8.5a1.5 1.5 0 0 1 3 0V11', 'M15 10.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-2.7L4 15.5a1.5 1.5 0 0 1 2.5-1.6L9 16'],
  db: ['M12 8c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3Z', 'M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5', 'M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6'],
  script: ['M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z', 'M14 3v6h6', 'M10 13l-2 2 2 2M14 13l2 2-2 2'],
  volume: ['M11 5 6 9H3v6h3l5 4V5Z', 'M15.5 8.5a5 5 0 0 1 0 7', 'M18.5 6a8.5 8.5 0 0 1 0 12'],
  mute: ['M11 5 6 9H3v6h3l5 4V5Z', 'M22 9l-6 6M16 9l6 6'],
  term: ['M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z', 'M7 9l3 3-3 3M12 15h5'],
  msg: ['M21 12a8 8 0 0 1-11.8 7L4 20l1.1-4.6A8 8 0 1 1 21 12Z'],
  tool: ['M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4 2.5-2.5Z'],
  alert: ['M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z', 'M12 9v4M12 17h.01'],
  pin: ['M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21Z', 'M12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z'],
  route: ['M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z', 'M18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z', 'M6 15V9a4 4 0 0 1 4-4h6M18 9v6a4 4 0 0 1-4 4H8'],
  list: ['M9 6h11M9 12h11M9 18h11', 'M4 6h.01M4 12h.01M4 18h.01'],
  pulse: ['M3 12h4l3-8 4 16 3-8h4'],
  filter: ['M3 5h18l-7 8v6l-4 2v-8L3 5Z'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z', 'm20 20-3.5-3.5'],
  playFill: ['M8 5v14l11-7L8 5Z'],
  pauseFill: ['M7 5h3.5v14H7zM13.5 5H17v14h-3.5z'],
  first: ['M6 5v14', 'M18 6l-8 6 8 6V6Z'],
  last: ['M18 5v14', 'M6 6l8 6-8 6V6Z'],
  prev: ['M15 6l-6 6 6 6'],
  next: ['M9 6l6 6-6 6'],
  back: ['M19 12H5M11 6l-6 6 6 6'],
  send: ['M12 19V5M6 11l6-6 6 6'],
  max: ['M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5'],
  min: ['M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5'],
  chevDown: ['M6 9l6 6 6-6'],
  chevUp: ['M6 15l6-6 6 6'],
  chevRight: ['M9 6l6 6-6 6'],
  live: ['M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z', 'M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4', 'M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14'],
  trash: ['M4 7h16', 'M10 11v6M14 11v6', 'M6 7l1 13h10l1-13', 'M9 7V4h6v3'],
};
/** 實心 icon(播放 / 暫停)。 */
const FILLED = new Set<InfoIconName>(['playFill', 'pauseFill']);

export function InfoIcon({ name, size = 16, className }: { name: InfoIconName; size?: number; className?: string }) {
  const filled = FILLED.has(name);
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-icon={name}
    >
      {PATHS[name].map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}
