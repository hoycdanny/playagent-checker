import { describe, test, expect } from 'vitest';
import { resolveStatus, isTerminal, TERMINAL_STATES } from '../lambda/api/status.js';

describe('終態吸收不變式(Req 3.7)', () => {
  test('無現值時接受任何 next', () => {
    expect(resolveStatus(null, 'running')).toBe('running');
    expect(resolveStatus(null, 'pass')).toBe('pass');
  });

  test('running 可轉為任何終態', () => {
    expect(resolveStatus('running', 'pass')).toBe('pass');
    expect(resolveStatus('running', 'fail')).toBe('fail');
    expect(resolveStatus('running', 'cancelled')).toBe('cancelled');
    expect(resolveStatus('running', 'dead')).toBe('dead');
  });

  test('一旦終態,永不被 running 覆蓋', () => {
    expect(resolveStatus('pass', 'running')).toBe('pass');
    expect(resolveStatus('fail', 'running')).toBe('fail');
    expect(resolveStatus('cancelled', 'running')).toBe('cancelled');
  });

  test('cancelled 為終態,吸收後續寫入', () => {
    expect(resolveStatus('cancelled', 'pass')).toBe('cancelled');
    expect(resolveStatus('cancelled', 'fail')).toBe('cancelled');
    expect(resolveStatus('cancelled', 'running')).toBe('cancelled');
  });

  test('任一終態先到即為準,不被其他終態覆蓋(先到吸收)', () => {
    expect(resolveStatus('pass', 'fail')).toBe('pass');
    expect(resolveStatus('fail', 'error')).toBe('fail');
    expect(resolveStatus('error', 'dead')).toBe('error');
  });

  test('取消不覆蓋引擎已跑出的真實結果(Req 3.4)', () => {
    // 引擎先寫 pass/fail(真實結果),cancelled 後到不覆蓋 —— 否則報告與狀態矛盾
    expect(resolveStatus('fail', 'cancelled')).toBe('fail');
    expect(resolveStatus('pass', 'cancelled')).toBe('pass');
  });

  test('running 被取消時落 cancelled(Req 3.3)', () => {
    expect(resolveStatus('running', 'cancelled')).toBe('cancelled');
  });

  test('isTerminal 正確分類', () => {
    expect(isTerminal('running')).toBe(false);
    for (const s of TERMINAL_STATES) {
      expect(isTerminal(s)).toBe(true);
    }
  });
});
