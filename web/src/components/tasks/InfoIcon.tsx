/** 任務詳情用的小型線條 icon(24 格、currentColor;純裝飾,一律 aria-hidden)。 */
export type InfoIconName =
  | 'target'
  | 'book'
  | 'phone'
  | 'cpu'
  | 'coin'
  | 'hash'
  | 'gamepad'
  | 'eye'
  | 'sparkle';

const PATHS: Record<InfoIconName, string[]> = {
  target: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M12 12h.01'],
  book: ['M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5v14Z', 'M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5'],
  phone: ['M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z', 'M11 18h2'],
  cpu: ['M7 7h10v10H7z', 'M10 10h4v4h-4z', 'M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3'],
  coin: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M15 9.5c-.5-1-1.6-1.5-3-1.5-1.7 0-3 .8-3 2s1.3 1.7 3 2 3 .8 3 2-1.3 2-3 2c-1.4 0-2.5-.5-3-1.5', 'M12 6v2M12 16v2'],
  hash: ['M4 9h16M4 15h16M10 3 8 21M16 3l-2 18'],
  gamepad: ['M6 11h4M8 9v4', 'M15 12h.01M18 10h.01', 'M17.3 5H6.7a4 4 0 0 0-3.96 3.43l-.7 5A3 3 0 0 0 5 17c.8 0 1.5-.3 2-.9L8.5 14h7l1.5 2.1c.5.6 1.2.9 2 .9a3 3 0 0 0 2.96-3.57l-.7-5A4 4 0 0 0 17.3 5Z'],
  eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z'],
  sparkle: ['M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z', 'M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z'],
};

export function InfoIcon({ name, size = 16, className }: { name: InfoIconName; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name].map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}
