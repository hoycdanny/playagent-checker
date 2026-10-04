import { describe, expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BootTimeline, fmtDur } from './BootTimeline.tsx';

const T0 = '2026-10-04T10:00:00.000Z';
const at = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString();

describe('BootTimeline', () => {
  test('fmtDur', () => {
    expect(fmtDur(0)).toBe('0:00');
    expect(fmtDur(65_000)).toBe('1:05');
    expect(fmtDur(3_725_000)).toBe('1:02:05');
    expect(fmtDur(-1)).toBe('—');
  });

  test('finished run: startup time, test time and per-stage durations', () => {
    render(
      <BootTimeline
        state="pass"
        lang="zh"
        backend="devicefarm"
        createdAt={T0}
        updatedAt={at(600)}
        boot={{ phase: 'run', at: { download: at(30), upload: at(60), device: at(90), connect: at(250), run: at(270) } }}
      />,
    );
    expect(screen.getByText('啟動耗時').nextSibling?.textContent).toBe('4:30');
    expect(screen.getByText('測試耗時').nextSibling?.textContent).toBe('5:30');
    expect(screen.getByText('總計 10:00')).toBeTruthy();
    // 配置真機 90→250 = 2:40
    expect(screen.getByText('2:40')).toBeTruthy();
  });

  test('failed while booting shows failure on the current stage', () => {
    render(
      <BootTimeline
        state="error"
        lang="en"
        backend="devicefarm"
        createdAt={T0}
        updatedAt={at(200)}
        boot={{ phase: 'device', deviceStatus: 'PREPARING', at: { download: at(30), upload: at(60), device: at(90) } }}
      />,
    );
    expect(screen.getByText('Startup failed').nextSibling?.textContent).toBe('3:20');
    expect(screen.getByText('Preparing device')).toBeTruthy();
    expect(screen.queryByText('Test time')).toBeNull();
  });
});
