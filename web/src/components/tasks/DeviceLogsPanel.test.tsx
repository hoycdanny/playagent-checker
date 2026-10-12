import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const apiGet = vi.fn();
vi.mock('../../api/client.ts', () => ({ apiGet: (p: string) => apiGet(p) }));
const { DeviceLogsPanel, parseLogcat, sourceFilter } = await import('./DeviceLogsPanel.tsx');
const { I18nProvider } = await import('../../i18n/I18nProvider.tsx');
localStorage.clear();

afterEach(() => apiGet.mockReset());

describe('parseLogcat', () => {
  it('parses -v epoch lines and the header pid', () => {
    const r = parseLogcat('# step=3 at=1 pid=12345\n1791193340.500  12345 12350 I Unity   : hello: world\njunk\n');
    expect(r.pid).toBe(12345);
    expect(r.lines).toEqual([{ t: 1791193340500, pid: 12345, tid: 12350, level: 'I', tag: 'Unity', msg: 'hello: world', raw: '1791193340.500  12345 12350 I Unity   : hello: world' }]);
  });
});

describe('sourceFilter', () => {
  const L = (tag: string, msg = 'x') => ({ t: 0, pid: 1, tid: 1, level: 'I', tag, msg, raw: `${tag}: ${msg}` });
  it('presets and single tag', () => {
    const lines = [L('Unity'), L('IL2CPP'), L('AudioTrack'), L('OkHttp'), L('AndroidRuntime', 'FATAL EXCEPTION: main'), L('ActivityManager', 'ANR in com.x'), L('Game')];
    const pick = (s: string) => lines.filter(sourceFilter(s)).map((l) => l.tag);
    expect(pick('unity')).toEqual(['Unity', 'IL2CPP']);
    expect(pick('audio')).toEqual(['AudioTrack']);
    expect(pick('net')).toEqual(['OkHttp']);
    expect(pick('crash')).toEqual(['AndroidRuntime', 'ActivityManager']);
    expect(pick('tag:Game')).toEqual(['Game']);
    expect(pick('')).toHaveLength(lines.length);
  });

  it('source dropdown narrows the log; clicking a tag filters to it', async () => {
    apiGet.mockResolvedValue({
      items: [{ name: '000000.txt', text: '# step=0 at=1 pid=1\n1791193340.500  1 2 I Unity: u1\n1791193341.000  1 2 I Net: n1\n1791193342.000  1 2 I Unity: u2\n' }],
      more: false,
    });
    render(<I18nProvider><DeviceLogsPanel jobId="job-1" isLive={false} /></I18nProvider>);
    await waitFor(() => expect(screen.getByRole('log')).toBeTruthy());
    const msgs = () => [...screen.getByRole('log').querySelectorAll('.devlogs__msg')].map((e) => e.textContent);
    expect(msgs()).toHaveLength(3);
    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: 'unity' } });
    expect(msgs()).toEqual(['u2', 'u1']);
    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: '' } });
    fireEvent.click(screen.getAllByText('Net')[0]!);
    expect(msgs()).toEqual(['n1']);
  });
});

describe('DeviceLogsPanel', () => {
  it('is open by default, newest line first, plain-language level filter', async () => {
    apiGet.mockResolvedValue({
      items: [{ name: '000000.txt', text: '# step=0 at=1 pid=1\n1791193340.500  1 2 I Game: info line\n1791193341.000  1 2 E Game: boom\n' }],
      more: false,
    });
    render(<I18nProvider><DeviceLogsPanel jobId="job-1" isLive={false} /></I18nProvider>);
    await waitFor(() => expect(screen.getByRole('log')).toBeTruthy());
    expect(apiGet.mock.calls[0]![0]).toBe('/tasks/job-1/device-logs?kind=logcat');
    const msgs = [...screen.getByRole('log').querySelectorAll('.devlogs__msg')].map((e) => e.textContent);
    expect(msgs).toEqual(['boom', 'info line']);

    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'E' } });
    expect(screen.queryByText('info line')).toBeNull();
    expect(screen.getByText('boom')).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Errors only' })).toBeTruthy();
  });

  it('AI agent tabs show each seat newest first; non-device tasks only get agent tabs', async () => {
    const all = [
      { index: 1, seat: 'vlm', modelId: 'm', ok: true, rawResponse: 'first' },
      { index: 2, seat: 'vlm', modelId: 'm', ok: true, rawResponse: 'second' },
      { index: 2, seat: 'agent', modelId: 'm', ok: true, rawResponse: 'agent-only' },
    ];
    apiGet.mockImplementation(async (p: string) => {
      if (!p.includes('/logs?')) return { items: [], more: false };
      const seat = new URLSearchParams(p.split('?')[1]).get('seat');
      return { items: seat ? all.filter((t) => t.seat === seat) : all };
    });
    render(<I18nProvider><DeviceLogsPanel jobId="job-1" isLive={false} device={false} /></I18nProvider>);
    expect(screen.queryByRole('tab', { name: 'Device' })).toBeNull();
    await waitFor(() => expect(screen.getByText('second')).toBeTruthy());
    const texts = [...document.querySelectorAll('.detail__log .detail__log-pre')].map((e) => e.textContent);
    expect(texts).toEqual(['second', 'first']);
    expect(screen.queryByText('agent-only')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Decision' }));
    await waitFor(() => expect(screen.getByText('agent-only')).toBeTruthy());
    expect(apiGet.mock.calls.some((c) => String(c[0]).includes('seat=agent'))).toBe(true);
  });

  it('sound playback tab marks steps where a player is started', async () => {
    apiGet.mockResolvedValue({
      items: [{ name: '000000.json', data: { step: 4, at: 1791193340500, pid: 7, players: [{ piid: 1, pid: 7, type: 'AudioTrack', usage: 'GAME', state: 'started' }], outputs: [{ thread: '0x1', standby: false }] } }],
      more: false,
    });
    render(<I18nProvider><DeviceLogsPanel jobId="job-1" isLive={false} /></I18nProvider>);
    fireEvent.click(screen.getByRole('tab', { name: 'Sound' }));
    await waitFor(() => expect(screen.getByText('#4')).toBeTruthy());
    expect(screen.getByText(/Playing 1/)).toBeTruthy();
    expect(screen.getByText('AudioTrack · GAME · started')).toBeTruthy();
  });
});

describe('analysis + usage tabs', () => {
  it('tab order: device, sound, vision, decision, helper, analysis, usage', () => {
    apiGet.mockResolvedValue({ items: [], more: false });
    render(<I18nProvider><DeviceLogsPanel jobId="job-1" isLive={false} /></I18nProvider>);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Device', 'Sound', 'Vision', 'Decision', 'Helper', 'Analysis', 'Usage']);
  });

  it('analysis: pick a metric → shows its live value; selection is remembered per app', async () => {
    localStorage.clear();
    apiGet.mockImplementation(async (p: string) => p.endsWith('/live-metrics')
      ? { stepCount: 12, final: false, at: '', metrics: [
        { id: 'spin_count', label: { zh: '轉數', en: 'Spins' }, unit: 'count', group: 'genre', source: 'objective', value: 42, status: 'ok', profile: 'slot' },
        { id: 'fps_avg', label: { zh: '平均 FPS', en: 'Avg FPS' }, unit: '', group: 'performance', source: 'objective', value: null, status: 'not_collected', profile: 'global' },
      ] }
      : { items: [], more: false });
    render(<I18nProvider><DeviceLogsPanel jobId="job-1" isLive={false} appId="app-9" /></I18nProvider>);
    fireEvent.click(screen.getByRole('tab', { name: 'Analysis' }));
    await waitFor(() => expect(screen.getByLabelText('Spins')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Spins'));
    fireEvent.click(screen.getByLabelText('Avg FPS'));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.getByText('Not collected yet')).toBeTruthy();
    expect(JSON.parse(localStorage.getItem('pa.trackedMetrics.app-9')!)).toEqual(['spin_count', 'fps_avg']);
  });

  it('usage: tokens and cost per agent from the summary traces', async () => {
    apiGet.mockImplementation(async (p: string) => p.includes('summary=1')
      ? { items: [
        { index: 0, seat: 'vlm', ok: true, tokens: { input: 1000, output: 100 } },
        { index: 0, seat: 'agent', ok: true, tokens: { input: 500, output: 50 } },
        { index: 1, seat: 'vlm', ok: false, tokens: { input: 1000, output: 100 } },
      ] }
      : { items: [], more: false });
    const seats = [
      { seat: 'vlm', modelId: 'm-v', inputPerM: 1, outputPerM: 10 },
      { seat: 'agent', modelId: 'm-a', inputPerM: 0.1, outputPerM: 1 },
    ];
    render(<I18nProvider><DeviceLogsPanel jobId="job-1" isLive={false} seats={seats} /></I18nProvider>);
    fireEvent.click(screen.getByRole('tab', { name: 'Usage' }));
    await waitFor(() => expect(screen.getByText('Total')).toBeTruthy());
    const row = (name: string) => screen.getByRole('rowheader', { name }).closest('tr')!.textContent;
    expect(row('Vision')).toContain('2,000');
    expect(row('Vision')).toContain('Failed 1');
    expect(row('Vision')).toContain('$0.0040');
    expect(row('Decision')).toContain('500');
    expect(row('Total')).toContain('2,500');
  });
});
