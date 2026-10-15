import type { RLang } from '../report/reportText.ts';
import type { CaseKey } from './keysYaml.ts';

export interface KeyOption {
  id: string;
  label: string;
  kind: 'key' | 'mouse';
}

interface L10n {
  zh: string;
  en: string;
}

const TEXT = {
  title: { zh: '按鍵用途', en: 'Key bindings' },
  hint: {
    zh: '列出這款遊戲用到的鍵與用途。AI 只會送這裡列出的鍵,並依用途挑鍵(例如「確認 / 推進對話」)。沒列任何鍵 = 不限定按鍵。',
    en: 'List the keys this game uses and what each does. The AI only sends listed keys and picks them by purpose. No keys listed = no restriction.',
  },
  key: { zh: '按鍵', en: 'Key' },
  purpose: { zh: '用途', en: 'Purpose' },
  purposePh: { zh: '例:移動、確認 / 推進對話、開選單、按住衝刺', en: 'e.g. move, confirm / advance dialog, open menu, hold to dash' },
  add: { zh: '+ 新增按鍵', en: '+ Add key' },
  remove: { zh: '移除', en: 'Remove' },
  presets: { zh: '帶入常用:', en: 'Quick fill:' },
  groupKeys: { zh: '鍵盤', en: 'Keyboard' },
  groupMouse: { zh: '滑鼠', en: 'Mouse' },
  dup: { zh: '重複的鍵只會採用第一個', en: 'Duplicate keys: only the first is used' },
} satisfies Record<string, L10n>;

interface Preset {
  id: string;
  label: L10n;
  kind: 'key' | 'mouse';
  keys: CaseKey[];
}

const PRESETS: Preset[] = [
  {
    id: 'rpg',
    label: { zh: '方向鍵 + Z/X(RPG)', en: 'Arrows + Z/X (RPG)' },
    kind: 'key',
    keys: [
      { key: 'up', purpose: '往上移動 / 選單上移' },
      { key: 'down', purpose: '往下移動 / 選單下移' },
      { key: 'left', purpose: '往左移動' },
      { key: 'right', purpose: '往右移動' },
      { key: 'enter', purpose: '確認 / 推進對話' },
      { key: 'z', purpose: '確認 / 調查互動' },
      { key: 'x', purpose: '取消 / 開選單' },
      { key: 'escape', purpose: '開選單 / 返回' },
      { key: 'shift', purpose: '按住衝刺' },
    ],
  },
  {
    id: 'wasd',
    label: { zh: 'WASD + 空白鍵(動作)', en: 'WASD + Space (action)' },
    kind: 'key',
    keys: [
      { key: 'w', purpose: '前進 / 往上' },
      { key: 'a', purpose: '往左' },
      { key: 's', purpose: '後退 / 往下' },
      { key: 'd', purpose: '往右' },
      { key: 'space', purpose: '跳躍' },
      { key: 'shift', purpose: '按住衝刺' },
      { key: 'e', purpose: '互動 / 撿取' },
      { key: 'escape', purpose: '暫停選單' },
    ],
  },
  {
    id: 'mouse',
    label: { zh: '滑鼠三鍵', en: 'Mouse buttons' },
    kind: 'mouse',
    keys: [
      { key: 'mouse_left', purpose: '點擊 / 選取 / 移動到該處' },
      { key: 'mouse_right', purpose: '取消 / 右鍵選單' },
      { key: 'wheel', purpose: '捲動頁面 / 縮放' },
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
  lang,
}: {
  value: CaseKey[];
  onChange: (keys: CaseKey[]) => void;
  options: KeyOption[];
  keyboard: boolean;
  mouse: boolean;
  lang: RLang;
}) {
  const t = (k: keyof typeof TEXT) => TEXT[k][lang];
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
  const applyPreset = (p: Preset) => onChange([...value, ...p.keys.filter((k) => !used.has(k.key))]);

  const keyGroup = shown.filter((o) => o.kind === 'key');
  const mouseGroup = shown.filter((o) => o.kind === 'mouse');
  const labelOf = (id: string) => options.find((o) => o.id === id)?.label ?? id;

  return (
    <div className="kmap">
      <div className="kmap__head">
        <span className="kmap__title">⌨ {t('title')}</span>
        <span className="kmap__presets">
          {t('presets')}
          {PRESETS.filter((p) => (p.kind === 'key' ? keyboard : mouse)).map((p) => (
            <button key={p.id} type="button" className="ctl__btn" onClick={() => applyPreset(p)}>
              {p.label[lang]}
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
                          {o.label}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {mouseGroup.length > 0 && (
                    <optgroup label={t('groupMouse')}>
                      {mouseGroup.map((o) => (
                        <option key={o.id} value={o.id} disabled={taken(o.id)}>
                          {o.label}
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
