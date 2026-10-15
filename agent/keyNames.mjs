/**
 * 鍵盤 / 滑鼠按鍵的「標準名稱」與別名正規化(web runner、Windows runner 共用)。
 * 後端 infra/lambda/api/controlSchemes.ts 有同一份清單(infra/test/control-keys.test.ts 檢查兩邊一致)。
 *
 * 標準名稱一律小寫:方向鍵 up/down/left/right、enter、space、escape、tab、shift、ctrl、alt、
 * backspace、delete、home、end、pageup、pagedown、a~z、0~9,以及滑鼠 mouse_left / mouse_right / wheel。
 * 刻意不開放 F1~F12(F5 重整、F12 開發者工具會破壞測試環境)與組合鍵。
 */

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');
const DIGITS = '0123456789'.split('');

/** 所有可用的按鍵(鍵盤)。 */
export const KEY_IDS = [
  'up', 'down', 'left', 'right',
  'enter', 'space', 'escape', 'tab', 'shift', 'ctrl', 'alt',
  'backspace', 'delete', 'home', 'end', 'pageup', 'pagedown',
  ...LETTERS, ...DIGITS,
];
/** 滑鼠按鍵(可在按鍵對應裡標用途;實際用 tap / swipe 操作)。 */
export const MOUSE_IDS = ['mouse_left', 'mouse_right', 'wheel'];

const ALIASES = {
  arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right',
  '↑': 'up', '↓': 'down', '←': 'left', '→': 'right',
  '上': 'up', '下': 'down', '左': 'left', '右': 'right',
  return: 'enter', '確認': 'enter',
  spacebar: 'space', ' ': 'space', '空白': 'space', '空白鍵': 'space', '空格': 'space', '空格键': 'space',
  esc: 'escape',
  control: 'ctrl', ctl: 'ctrl', option: 'alt',
  pgup: 'pageup', pgdn: 'pagedown', page_up: 'pageup', page_down: 'pagedown', 'page up': 'pageup', 'page down': 'pagedown',
  del: 'delete', bksp: 'backspace',
  lmb: 'mouse_left', leftclick: 'mouse_left', 'left click': 'mouse_left', '左鍵': 'mouse_left', '滑鼠左鍵': 'mouse_left',
  rmb: 'mouse_right', rightclick: 'mouse_right', 'right click': 'mouse_right', '右鍵': 'mouse_right', '滑鼠右鍵': 'mouse_right',
  scroll: 'wheel', mousewheel: 'wheel', '滾輪': 'wheel', '滑鼠滾輪': 'wheel',
};

/** 任意寫法(ArrowUp / ↑ / PgDn / KeyZ / Digit1 / Shift…)→ 標準名稱;不認得回 null。 */
export function normalizeKey(raw) {
  let s = String(raw ?? '');
  if (s === ' ') return 'space';
  s = s.trim().toLowerCase();
  if (!s) return null;
  // 先查完整別名(「右鍵」「空白鍵」),再去掉結尾的「鍵」(「Z 鍵」→ z)。
  if (ALIASES[s]) return ALIASES[s];
  s = s.replace(/\s*鍵$/, '');
  if (ALIASES[s]) return ALIASES[s];
  const m = /^(?:key)([a-z])$/.exec(s) || /^(?:digit|numpad)([0-9])$/.exec(s);
  if (m) return m[1];
  if (MOUSE_IDS.includes(s) || KEY_IDS.includes(s)) return s;
  const compact = s.replace(/[\s_-]+/g, '');
  if (ALIASES[compact]) return ALIASES[compact];
  if (KEY_IDS.includes(compact)) return compact;
  return null;
}
