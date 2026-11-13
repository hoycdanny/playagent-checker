import { loc5, pick5, type L5, type Loc5 } from '../../i18n/locale5.ts';
import type { CaseKey } from './keysYaml.ts';

export interface KeyOption {
  id: string;
  label: string;
  kind: 'key' | 'mouse';
}

const TEXT = {
  title: ['按鍵用途', 'Key bindings', '按键用途', 'キーの用途', '키 용도'],
  hint: [
    '列出這款遊戲用到的鍵與用途。AI 只會送這裡列出的鍵,並依用途挑鍵(例如「確認 / 推進對話」)。沒列任何鍵 = 不限定按鍵。',
    'List the keys this game uses and what each does. The AI only sends listed keys and picks them by purpose. No keys listed = no restriction.',
    '列出这款游戏用到的键与用途。AI 只会发送这里列出的键,并按用途选键(例如“确认 / 推进对话”)。没列任何键 = 不限定按键。',
    'このゲームで使うキーとその用途を列挙します。AI は列挙されたキーだけを送信し、用途に応じて選びます(例:「決定 / 会話を進める」)。キーを列挙しない場合は制限なしです。',
    '이 게임에서 사용하는 키와 용도를 나열하세요. AI는 나열된 키만 보내며 용도에 따라 키를 고릅니다(예: "확인 / 대화 진행"). 키를 나열하지 않으면 제한이 없습니다.',
  ],
  key: ['按鍵', 'Key', '按键', 'キー', '키'],
  purpose: ['用途', 'Purpose', '用途', '用途', '용도'],
  purposePh: [
    '例:移動、確認 / 推進對話、開選單、按住衝刺',
    'e.g. move, confirm / advance dialog, open menu, hold to dash',
    '例:移动、确认 / 推进对话、开菜单、按住冲刺',
    '例:移動、決定 / 会話を進める、メニューを開く、長押しでダッシュ',
    '예: 이동, 확인 / 대화 진행, 메뉴 열기, 길게 눌러 달리기',
  ],
  add: ['+ 新增按鍵', '+ Add key', '+ 新增按键', '+ キーを追加', '+ 키 추가'],
  remove: ['移除', 'Remove', '移除', '削除', '제거'],
  presets: ['帶入常用:', 'Quick fill:', '带入常用:', 'よく使う設定:', '자주 쓰는 설정:'],
  groupKeys: ['鍵盤', 'Keyboard', '键盘', 'キーボード', '키보드'],
  groupMouse: ['滑鼠', 'Mouse', '鼠标', 'マウス', '마우스'],
  dup: [
    '重複的鍵只會採用第一個',
    'Duplicate keys: only the first is used',
    '重复的键只会采用第一个',
    '重複したキーは最初のものだけが使われます',
    '중복된 키는 첫 번째만 사용됩니다',
  ],
} satisfies Record<string, L5>;

/** 後端 KEY_LABELS 裡帶中文的鍵名;其餘鍵名(Enter、Esc、A…)本身就是英文,照後端顯示。 */
const KEY_TEXT: Record<string, L5> = {
  up: ['↑ 上', '↑ Up', '↑ 上', '↑ 上', '↑ 위'],
  down: ['↓ 下', '↓ Down', '↓ 下', '↓ 下', '↓ 아래'],
  left: ['← 左', '← Left', '← 左', '← 左', '← 왼쪽'],
  right: ['→ 右', '→ Right', '→ 右', '→ 右', '→ 오른쪽'],
  space: ['Space 空白鍵', 'Space', 'Space 空格键', 'Space スペースキー', 'Space 스페이스바'],
  mouse_left: ['滑鼠左鍵', 'Left mouse button', '鼠标左键', 'マウス左ボタン', '마우스 왼쪽 버튼'],
  mouse_right: ['滑鼠右鍵', 'Right mouse button', '鼠标右键', 'マウス右ボタン', '마우스 오른쪽 버튼'],
  wheel: ['滑鼠滾輪', 'Mouse wheel', '鼠标滚轮', 'マウスホイール', '마우스 휠'],
};

interface PresetKey {
  key: string;
  purpose: L5;
}

interface Preset {
  id: string;
  label: L5;
  kind: 'key' | 'mouse';
  keys: PresetKey[];
}

const SPRINT: L5 = ['按住衝刺', 'Hold to dash', '按住冲刺', '長押しでダッシュ', '길게 눌러 달리기'];
const MENU: L5 = ['開選單 / 返回', 'Open menu / back', '开菜单 / 返回', 'メニューを開く / 戻る', '메뉴 열기 / 뒤로'];

const PRESETS: Preset[] = [
  {
    id: 'rpg',
    label: ['方向鍵 + Z/X(RPG)', 'Arrows + Z/X (RPG)', '方向键 + Z/X(RPG)', '矢印キー + Z/X(RPG)', '방향키 + Z/X(RPG)'],
    kind: 'key',
    keys: [
      { key: 'up', purpose: ['往上移動 / 選單上移', 'Move up / menu up', '往上移动 / 菜单上移', '上へ移動 / メニューを上へ', '위로 이동 / 메뉴 위로'] },
      { key: 'down', purpose: ['往下移動 / 選單下移', 'Move down / menu down', '往下移动 / 菜单下移', '下へ移動 / メニューを下へ', '아래로 이동 / 메뉴 아래로'] },
      { key: 'left', purpose: ['往左移動', 'Move left', '往左移动', '左へ移動', '왼쪽으로 이동'] },
      { key: 'right', purpose: ['往右移動', 'Move right', '往右移动', '右へ移動', '오른쪽으로 이동'] },
      { key: 'enter', purpose: ['確認 / 推進對話', 'Confirm / advance dialog', '确认 / 推进对话', '決定 / 会話を進める', '확인 / 대화 진행'] },
      { key: 'z', purpose: ['確認 / 調查互動', 'Confirm / investigate', '确认 / 调查互动', '決定 / 調べる', '확인 / 조사'] },
      { key: 'x', purpose: ['取消 / 開選單', 'Cancel / open menu', '取消 / 开菜单', 'キャンセル / メニューを開く', '취소 / 메뉴 열기'] },
      { key: 'escape', purpose: MENU },
      { key: 'shift', purpose: SPRINT },
    ],
  },
  {
    id: 'wasd',
    label: ['WASD + 空白鍵(動作)', 'WASD + Space (action)', 'WASD + 空格键(动作)', 'WASD + スペース(アクション)', 'WASD + 스페이스(액션)'],
    kind: 'key',
    keys: [
      { key: 'w', purpose: ['前進 / 往上', 'Forward / up', '前进 / 往上', '前進 / 上', '앞으로 / 위'] },
      { key: 'a', purpose: ['往左', 'Left', '往左', '左', '왼쪽'] },
      { key: 's', purpose: ['後退 / 往下', 'Back / down', '后退 / 往下', '後退 / 下', '뒤로 / 아래'] },
      { key: 'd', purpose: ['往右', 'Right', '往右', '右', '오른쪽'] },
      { key: 'space', purpose: ['跳躍', 'Jump', '跳跃', 'ジャンプ', '점프'] },
      { key: 'shift', purpose: SPRINT },
      { key: 'e', purpose: ['互動 / 撿取', 'Interact / pick up', '互动 / 拾取', '操作 / 拾う', '상호작용 / 줍기'] },
      { key: 'escape', purpose: ['暫停選單', 'Pause menu', '暂停菜单', 'ポーズメニュー', '일시정지 메뉴'] },
    ],
  },
  {
    id: 'mouse',
    label: ['滑鼠三鍵', 'Mouse buttons', '鼠标三键', 'マウスボタン', '마우스 버튼'],
    kind: 'mouse',
    keys: [
      { key: 'mouse_left', purpose: ['點擊 / 選取 / 移動到該處', 'Click / select / move there', '点击 / 选取 / 移动到该处', 'クリック / 選択 / その場所へ移動', '클릭 / 선택 / 해당 위치로 이동'] },
      { key: 'mouse_right', purpose: ['取消 / 右鍵選單', 'Cancel / context menu', '取消 / 右键菜单', 'キャンセル / コンテキストメニュー', '취소 / 오른쪽 클릭 메뉴'] },
      { key: 'wheel', purpose: ['捲動頁面 / 縮放', 'Scroll / zoom', '滚动页面 / 缩放', 'スクロール / ズーム', '스크롤 / 확대·축소'] },
    ],
  },
];

/**
 * 按鍵對應編輯器:每列 = 按鍵下拉 + 用途輸入。
 * 只顯示勾選的方案相關的鍵(勾鍵盤 → 鍵盤鍵;勾滑鼠 → 滑鼠鍵)。
 */
export function KeyMapEditor({
  value,
  onChange,
  options,
  keyboard,
  mouse,
  locale,
}: {
  value: CaseKey[];
  onChange: (keys: CaseKey[]) => void;
  options: KeyOption[];
  keyboard: boolean;
  mouse: boolean;
  locale: string;
}) {
  const lc: Loc5 = loc5(locale);
  const t = (k: keyof typeof TEXT) => pick5(TEXT[k], lc);
  const shown = options.filter((o) => (o.kind === 'key' ? keyboard : mouse));
  const used = new Set(value.map((k) => k.key));
  const firstFree = shown.find((o) => !used.has(o.id))?.id;
  const counts = new Map<string, number>();
  for (const k of value) counts.set(k.key, (counts.get(k.key) ?? 0) + 1);
  const hasDup = [...counts.values()].some((n) => n > 1);

  const update = (i: number, patch: Partial<CaseKey>) => onChange(value.map((k, j) => (j === i ? { ...k, ...patch } : k)));
  const remove = (i: number) => onChange(value.filter((_, j) => j !== i));
  const add = () => {
    if (firstFree) onChange([...value, { key: firstFree, purpose: '' }]);
  };
  const applyPreset = (p: Preset) =>
    onChange([...value, ...p.keys.filter((k) => !used.has(k.key)).map((k) => ({ key: k.key, purpose: pick5(k.purpose, lc) }))]);

  const keyGroup = shown.filter((o) => o.kind === 'key');
  const mouseGroup = shown.filter((o) => o.kind === 'mouse');
  // 後端的按鍵名稱只有繁中(例如「↑ 上」「滑鼠左鍵」),有中文的鍵在這裡補五語。
  const keyLabel = (o: KeyOption) => {
    const own = KEY_TEXT[o.id];
    return own ? pick5(own, lc) : o.label;
  };
  const labelOf = (id: string) => {
    const o = options.find((x) => x.id === id);
    return o ? keyLabel(o) : id;
  };

  return (
    <div className="kmap">
      <div className="kmap__head">
        <span className="kmap__title">⌨ {t('title')}</span>
        <span className="kmap__presets">
          {t('presets')}
          {PRESETS.filter((p) => (p.kind === 'key' ? keyboard : mouse)).map((p) => (
            <button key={p.id} type="button" className="ctl__btn" onClick={() => applyPreset(p)}>
              {pick5(p.label, lc)}
            </button>
          ))}
        </span>
      </div>
      <p className="ctl__hint">{t('hint')}</p>
      {value.length > 0 && (
        <ul className="kmap__rows">
          {value.map((k, i) => {
            // 已被別列用掉的鍵在這列的下拉中停用(但保留本列目前的鍵)。
            const taken = (id: string) => id !== k.key && used.has(id);
            const known = options.some((o) => o.id === k.key);
            return (
              <li key={i} className={`kmap__row${(counts.get(k.key) ?? 0) > 1 ? ' is-dup' : ''}`}>
                <select
                  className="kmap__key"
                  aria-label={`${t('key')} ${i + 1}`}
                  value={k.key}
                  onChange={(e) => update(i, { key: e.target.value })}
                >
                  {!known && <option value={k.key}>{k.key}</option>}
                  {keyGroup.length > 0 && (
                    <optgroup label={t('groupKeys')}>
                      {keyGroup.map((o) => (
                        <option key={o.id} value={o.id} disabled={taken(o.id)}>
                          {keyLabel(o)}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {mouseGroup.length > 0 && (
                    <optgroup label={t('groupMouse')}>
                      {mouseGroup.map((o) => (
                        <option key={o.id} value={o.id} disabled={taken(o.id)}>
                          {keyLabel(o)}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {/* 目前的鍵不在顯示範圍(例如取消勾滑鼠後仍留著右鍵)也要能看到 */}
                  {known && !shown.some((o) => o.id === k.key) && <option value={k.key}>{labelOf(k.key)}</option>}
                </select>
                <input
                  className="kmap__purpose"
                  aria-label={`${t('purpose')}:${labelOf(k.key)}`}
                  placeholder={t('purposePh')}
                  maxLength={60}
                  value={k.purpose}
                  onChange={(e) => update(i, { purpose: e.target.value })}
                />
                <button
                  type="button"
                  className="kmap__remove"
                  aria-label={`${t('remove')} ${labelOf(k.key)}`}
                  onClick={() => remove(i)}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {hasDup && <p className="ctl__error">{t('dup')}</p>}
      <div>
        <button type="button" className="ctl__btn ctl__btn--ghost" onClick={add} disabled={!firstFree}>
          {t('add')}
        </button>
      </div>
    </div>
  );
}
