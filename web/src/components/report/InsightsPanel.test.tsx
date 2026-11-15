import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { InsightsPanel } from './InsightsPanel.tsx';
import type { InsightsMap, ReportInsights } from './reportTypes.ts';
import { insightsSuffix, pickInsights } from './reportText.ts';

const apiPost = vi.fn();
vi.mock('../../api/client.ts', () => ({
  apiGet: vi.fn(),
  apiPost: (...args: unknown[]) => apiPost(...args),
}));

const ins = (summary: string, lang: ReportInsights['lang']): ReportInsights => ({
  schemaVersion: 1,
  generatedAt: '2026-01-01T00:00:00Z',
  model: 'm',
  lang,
  summary: { zh: summary, en: summary },
  rootCause: { zh: 'rc', en: 'rc' },
  requirements: [],
  recommendations: [],
  notes: {},
});

const noop = () => {};
const view = (lang: 'zh-Hant' | 'en' | 'zh-Hans' | 'ja' | 'ko', insights?: InsightsMap) =>
  render(
    <InsightsPanel jobId="j1" lang={lang} {...(insights ? { insights } : {})} onChange={noop} autoGenerate evidence={[]} onOpenImage={noop} onGoFinding={noop} />,
  );

beforeEach(() => {
  apiPost.mockReset();
  apiPost.mockResolvedValue(ins('fresh', 'ja'));
});

describe('InsightsPanel posts the viewer locale suffix', () => {
  test('ja -> { lang: "ja" }', async () => {
    view('ja');
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenCalledWith('/reports/j1/insights', { lang: 'ja', force: false });
  });

  test('zh-Hant -> { lang: "zh" } (legacy cache name)', async () => {
    view('zh-Hant');
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenCalledWith('/reports/j1/insights', { lang: 'zh', force: false });
  });

  test('the exact locale exists -> no auto-generate', async () => {
    view('ko', { ko: ins('korean', 'ko') });
    expect(screen.getByText('korean')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(apiPost).not.toHaveBeenCalled();
  });

  test('exact locale missing -> shows the zh/en fallback and still generates', async () => {
    view('ja', { en: ins('english fallback', 'en') });
    expect(screen.getByText('english fallback')).toBeTruthy();
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
  });
});

describe('insights lookup helpers', () => {
  test('suffix mapping', () => {
    expect(insightsSuffix('zh-Hant')).toBe('zh');
    expect(insightsSuffix('en')).toBe('en');
    expect(insightsSuffix('zh-Hans')).toBe('zh-Hans');
    expect(insightsSuffix('ja')).toBe('ja');
  });

  test('exact first, then dataLang, then the other legacy one', () => {
    const zh = ins('zh', 'zh');
    const en = ins('en', 'en');
    const ja = ins('ja', 'ja');
    expect(pickInsights({ zh, en, ja }, 'ja')).toBe(ja);
    expect(pickInsights({ zh, en }, 'ja')).toBe(en);
    expect(pickInsights({ zh, en }, 'zh-Hans')).toBe(zh);
    expect(pickInsights({ en }, 'zh-Hant')).toBe(en);
    expect(pickInsights(undefined, 'ko')).toBeUndefined();
  });
});
