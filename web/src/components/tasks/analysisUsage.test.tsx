import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * 數據分析 / Token 用量 —— 原本是「完整日誌」裡的子分頁,現在是任務詳情頁的上層分頁,
 * 所以直接測這兩個面板本身(原本的測試在 DeviceLogsPanel.test.tsx 裡靠點子分頁進去)。
 */
const apiGet = vi.fn();
vi.mock('../../api/client.ts', () => ({ apiGet: (p: string) => apiGet(p) }));
const { LiveAnalysisView } = await import('./LiveAnalysisView.tsx');
const { UsageView } = await import('./UsageView.tsx');

afterEach(() => apiGet.mockReset());

describe('LiveAnalysisView', () => {
  it('pick a metric → shows its live value; selection is remembered per app', async () => {
    localStorage.clear();
    apiGet.mockResolvedValue({
      stepCount: 12,
      final: false,
      at: '',
      metrics: [
        { id: 'spin_count', label: { zh: '轉數', en: 'Spins' }, unit: 'count', group: 'genre', source: 'objective', value: 42, status: 'ok', profile: 'slot' },
        { id: 'fps_avg', label: { zh: '平均 FPS', en: 'Avg FPS' }, unit: '', group: 'performance', source: 'objective', value: null, status: 'not_collected', profile: 'global' },
      ],
    });
    render(<LiveAnalysisView jobId="job-1" isLive={false} appId="app-9" loc="en" />);
    await waitFor(() => expect(screen.getByLabelText('Spins')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Spins'));
    fireEvent.click(screen.getByLabelText('Avg FPS'));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.getByText('Not collected yet')).toBeTruthy();
    expect(JSON.parse(localStorage.getItem('pa.trackedMetrics.app-9')!)).toEqual(['spin_count', 'fps_avg']);
  });
});

describe('UsageView', () => {
  it('tokens and cost per agent from the summary traces', () => {
    const traces = [
      { index: 0, seat: 'vlm', ok: true, tokens: { input: 1000, output: 100 } },
      { index: 0, seat: 'agent', ok: true, tokens: { input: 500, output: 50 } },
      { index: 1, seat: 'vlm', ok: false, tokens: { input: 1000, output: 100 } },
    ];
    const seats = [
      { seat: 'vlm', modelId: 'm-v', inputPerM: 1, outputPerM: 10 },
      { seat: 'agent', modelId: 'm-a', inputPerM: 0.1, outputPerM: 1 },
    ];
    render(<UsageView traces={traces as never} seats={seats} loc="en" />);
    const row = (name: string) => screen.getByRole('rowheader', { name }).closest('tr')!.textContent;
    expect(row('Vision')).toContain('2,000');
    expect(row('Vision')).toContain('Failed 1');
    expect(row('Vision')).toContain('$0.0040');
    expect(row('Decision')).toContain('500');
    expect(row('Total')).toContain('2,500');
  });
});
