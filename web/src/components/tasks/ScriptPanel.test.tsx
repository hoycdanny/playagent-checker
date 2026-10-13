import { describe, expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import { itemState, ScriptPanel } from './ScriptPanel.tsx';
import { toScriptProgress } from '../../api/useJobStream.ts';
import { traceCost, summarizeUsage } from './UsageView.tsx';

const progress = { items: ['進入大廳', '進入第一關', '打到第 3 波'], current: 2, done: 1 };

describe('live script checklist', () => {
  test('item states: done / current while running, stopped after the run ends', () => {
    expect([0, 1, 2].map((i) => itemState(i, progress, true))).toEqual(['done', 'current', 'pending']);
    expect([0, 1, 2].map((i) => itemState(i, progress, false))).toEqual(['done', 'stopped', 'pending']);
    expect([0, 1, 2].map((i) => itemState(i, { ...progress, done: 3, current: 3 }, false))).toEqual(['done', 'done', 'done']);
  });

  test('renders ticks, the current item and the done count; opens by itself', () => {
    const { container } = render(<ScriptPanel lang="zh" live progress={progress} script="1. a\n2. b\n3. c" />);
    expect(screen.getByText('已完成 1/3')).toBeTruthy();
    const items = [...container.querySelectorAll('.dscript__step')];
    expect(items.map((li) => li.className.replace('dscript__step ', ''))).toEqual(['is-done', 'is-current', 'is-pending']);
    expect(items[0]!.querySelector('.dscript__num')!.textContent).toBe('✓');
    expect(items[1]!.textContent).toContain('進行中');
    expect(container.querySelector('#detail-script-body')!.hasAttribute('hidden')).toBe(false);
  });

  test('without live progress it still shows the plain script, collapsed', () => {
    const { container } = render(<ScriptPanel lang="en" script={'1. a\n2. b'} />);
    expect(screen.getByText('2 steps')).toBeTruthy();
    expect(container.querySelector('#detail-script-body')!.hasAttribute('hidden')).toBe(true);
  });

  test('status.json script field is validated', () => {
    expect(toScriptProgress({ items: ['a', 'b'], current: 5, done: 1 })).toEqual({ items: ['a', 'b'], current: 2, done: 1 });
    expect(toScriptProgress({ items: ['a'] })).toBeUndefined();
    expect(toScriptProgress(null)).toBeUndefined();
  });
});

describe('usage cost counts cache tokens and the real model', () => {
  const seats = [{ seat: 'vlm', modelId: 'us.moonshotai.kimi-k3', inputPerM: 3.63, outputPerM: 18.15 }];
  const prices = {
    'us.moonshotai.kimi-k3': { inputPerM: 3.3, outputPerM: 16.5, cacheWritePerM: 4.125, cacheReadPerM: 0.33 },
    'us.anthropic.claude-sonnet-4-5-20250929-v1:0': { inputPerM: 3.3, outputPerM: 16.5, cacheWritePerM: 4.125, cacheReadPerM: 0.33 },
  };

  test('current prices win over the submit-time seat snapshot; cache tokens are priced', () => {
    const c = traceCost({ index: 0, seat: 'vlm', modelId: 'us.moonshotai.kimi-k3', tokens: { input: 0, output: 0, cacheWrite: 1_000_000 } }, seats[0], prices);
    expect(c).toBeCloseTo(4.125, 6);
  });

  test('fallback-model calls are priced with that model', () => {
    const rows = summarizeUsage([
      { index: 0, seat: 'vlm', modelId: 'us.moonshotai.kimi-k3', tokens: { input: 0, output: 0, cacheRead: 1_000_000 } },
      { index: 0, seat: 'vlm', modelId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', tokens: { input: 1_000_000, output: 0 } },
    ], seats, prices);
    expect(rows[0]!.cacheRead).toBe(1_000_000);
    expect(rows[0]!.cost).toBeCloseTo(0.33 + 3.3, 6);
  });

  test('no price table → falls back to the seat snapshot (old behaviour), cache at default ratios', () => {
    const c = traceCost({ index: 0, seat: 'vlm', tokens: { input: 1_000_000, cacheWrite: 1_000_000 } }, { seat: 'vlm', modelId: 'x', inputPerM: 2, outputPerM: 8 });
    expect(c).toBeCloseTo(2 + 2.5, 6);
  });
});
