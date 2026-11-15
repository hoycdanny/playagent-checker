import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { TaskAskPanel } from './TaskAskPanel.tsx';

const apiPost = vi.fn();
vi.mock('../../api/client.ts', () => ({
  apiGet: vi.fn(async () => ({ items: [] })),
  apiPost: (...args: unknown[]) => apiPost(...args),
  apiDelete: vi.fn(),
}));

beforeEach(() => {
  apiPost.mockReset();
  apiPost.mockResolvedValue({ items: [] });
});

describe('TaskAskPanel posts the viewer locale', () => {
  test('ko -> the ask body carries lang "ko"', async () => {
    const { container } = render(<TaskAskPanel jobId="j1" lang="ko" embedded />);
    const chip = container.querySelector('.taskask__chip') as HTMLButtonElement;
    fireEvent.click(chip);
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    const [path, body] = apiPost.mock.calls[0] as [string, { lang: string; question: string }];
    expect(path).toBe('/tasks/j1/ask');
    expect(body.lang).toBe('ko');
    expect(body.question).toBe(chip.textContent);
  });
});
