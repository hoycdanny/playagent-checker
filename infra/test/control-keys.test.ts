import { describe, expect, test } from 'vitest';
import {
  KEY_IDS,
  MOUSE_IDS,
  buildControlsProtocol,
  defaultControlsFor,
  describeControlCatalog,
  normalizeKey,
  parseCaseKeys,
  reconcileControlsWithText,
  sanitizeKeys,
} from '../lambda/api/controlSchemes.js';
import * as agentKeys from '../../agent/keyNames.mjs';

describe('key names (TS ↔ agent/keyNames.mjs parity)', () => {
  test('same key and mouse lists', () => {
    expect(agentKeys.KEY_IDS).toEqual(KEY_IDS);
    expect(agentKeys.MOUSE_IDS).toEqual(MOUSE_IDS);
  });
  const samples = [
    'ArrowUp', '↑', 'up', 'UP', 'Enter', 'return', ' ', 'Space', '空白鍵', 'Esc', 'Escape',
    'PgDn', 'Page Down', 'page_up', 'KeyZ', 'z', 'Digit1', 'Numpad7', 'Shift', 'Control', 'ctrl',
    '右鍵', 'RMB', 'mouse_left', '滾輪', 'F5', 'F12', 'ctrl+w', '', 'nonsense',
  ];
  test.each(samples)('normalizeKey(%j) agrees', (s) => {
    expect(agentKeys.normalizeKey(s)).toBe(normalizeKey(s));
  });
  test('aliases resolve; F-keys and combos are rejected', () => {
    expect(normalizeKey('ArrowLeft')).toBe('left');
    expect(normalizeKey('空白鍵')).toBe('space');
    expect(normalizeKey('KeyX')).toBe('x');
    expect(normalizeKey('PgUp')).toBe('pageup');
    expect(normalizeKey('右鍵')).toBe('mouse_right');
    expect(normalizeKey('右')).toBe('right');
    expect(normalizeKey('Z 鍵')).toBe('z');
    expect(normalizeKey(' ')).toBe('space');
    expect(normalizeKey('F5')).toBeNull();
    expect(normalizeKey('ctrl+w')).toBeNull();
  });
});

describe('parseCaseKeys', () => {
  const yaml = [
    'name: Silver Thread 開場',
    'controls: [keyboard, mouse]',
    'keys:',
    '  - up: 往上移動',
    '  - Enter: 確認 / 推進對話',
    '  - "z": "確認: 調查"',
    '  - F5: 重新整理',
    '  - ArrowUp: 重複的上',
    '  - mouse_right: 取消',
    'task: |',
    '  按 Enter 開始遊戲,按住 Shift 衝刺',
  ].join('\n');

  test('reads the block, normalizes names, drops unknown and duplicate keys', () => {
    expect(parseCaseKeys(yaml)).toEqual([
      { key: 'up', purpose: '往上移動' },
      { key: 'enter', purpose: '確認 / 推進對話' },
      { key: 'z', purpose: '確認: 調查' },
      { key: 'mouse_right', purpose: '取消' },
    ]);
  });
  test('no keys block → undefined', () => {
    expect(parseCaseKeys('name: x\ntask: y')).toBeUndefined();
  });
  test('sanitizeKeys trims purposes and caps length', () => {
    expect(sanitizeKeys([{ key: 'Space', purpose: '  跳躍\n二段跳 ' }])).toEqual([{ key: 'space', purpose: '跳躍 二段跳' }]);
    expect(sanitizeKeys([{ key: 'a', purpose: 'x'.repeat(100) }])[0]!.purpose).toHaveLength(60);
    expect(sanitizeKeys('nope')).toEqual([]);
  });
  test('keys block text does not trigger the long-press reconcile', () => {
    const withHold = 'name: x\ncontrols: [keyboard]\nkeys:\n  - shift: 按住衝刺\ntask: 走到門口';
    expect(reconcileControlsWithText(withHold, ['keyboard']).added).toEqual([]);
    // 內文本身要求長按時仍會補 hold。
    expect(reconcileControlsWithText(`${withHold}\n  長按 A 鍵`, ['keyboard']).added).toEqual(['hold']);
  });
});

describe('keyboard / mouse protocol', () => {
  test('keyboard scheme opens the key action and lists purposes', () => {
    const p = buildControlsProtocol(['keyboard', 'mouse'], 'case', [
      { key: 'enter', purpose: '確認' },
      { key: 'mouse_right', purpose: '取消' },
    ])!;
    expect(p.allowedActions).toContain('key');
    expect(p.keys).toHaveLength(2);
    expect(p.prompt).toContain('【按鍵對應');
    expect(p.prompt).toContain('enter(Enter):確認');
    expect(p.prompt).toContain('【滑鼠按鍵用途】');
    expect(p.prompt).toContain('"button":"right"');
  });
  test('keys alone open the key action even without the keyboard scheme', () => {
    const p = buildControlsProtocol(['mouse'], 'case', [{ key: 'space', purpose: '跳' }])!;
    expect(p.allowedActions).toContain('key');
  });
  test('mouse only → no key action', () => {
    expect(buildControlsProtocol(['mouse'], 'case')!.allowedActions).not.toContain('key');
  });
});

describe('platform defaults and catalog', () => {
  test('web / windows default to keyboard + mouse; mobile uses the genre', () => {
    expect(defaultControlsFor('rpg', 'web')).toEqual(['keyboard', 'mouse']);
    expect(defaultControlsFor('rpg', 'windows')).toEqual(['keyboard', 'mouse']);
    expect(defaultControlsFor('rpg', 'android')).toEqual(['joystick_left', 'skill_right', 'tap']);
    expect(defaultControlsFor(undefined, undefined)).toEqual([]);
  });
  test('catalog exposes platforms and key options', () => {
    const c = describeControlCatalog();
    const byId = new Map(c.items.map((i) => [i.id, i]));
    expect(byId.get('keyboard')!.platforms).toEqual(['web', 'windows']);
    expect(byId.get('joystick_left')!.platforms).toEqual(['mobile']);
    expect(byId.get('tap')!.platforms).toContain('web');
    expect(c.keyOptions.find((o) => o.id === 'mouse_right')!.kind).toBe('mouse');
    expect(c.keyOptions.filter((o) => o.kind === 'key')).toHaveLength(KEY_IDS.length);
  });
});
