import { describe, expect, test } from 'vitest';
import { backendIcon, isLongDeviceFarm } from './TaskIcon.tsx';

const t = (k: string) =>
  ({ 'backend.devicefarm': 'DF', 'backend.emulator': 'EMU', 'backend.devicefarmLong': 'DF long {n}', 'backend.devicefarmLongUnlimited': 'DF long ∞' })[k] ?? k;

describe('backendIcon', () => {
  test('Device Farm long runs get their own icon and say how many segments', () => {
    expect(backendIcon('devicefarm', 3, t)).toEqual({ value: 'devicefarm-long', label: 'DF long 3' });
    expect(backendIcon('devicefarm', 0, t)).toEqual({ value: 'devicefarm-long', label: 'DF long ∞' });
  });
  test('single-segment Device Farm and other backends keep the normal icon', () => {
    expect(backendIcon('devicefarm', undefined, t)).toEqual({ value: 'devicefarm', label: 'DF' });
    expect(backendIcon('devicefarm', 1, t)).toEqual({ value: 'devicefarm', label: 'DF' });
    expect(backendIcon('emulator', 3, t)).toEqual({ value: 'emulator', label: 'EMU' });
    expect(isLongDeviceFarm('emulator', 0)).toBe(false);
  });
});
