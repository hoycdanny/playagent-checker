import { apiGet } from '../../api/client.ts';
import { useQuery } from '../../api/useQuery.ts';
import { useI18n } from '../../i18n/I18nProvider.tsx';
import { reportLang, type RLang } from '../report/reportText.ts';
import { ControlGlyph } from './ControlGlyph.tsx';
import { KeyMapEditor, type KeyOption } from './KeyMapEditor.tsx';
import type { CaseKey } from './keysYaml.ts';
import './ControlSchemePicker.css';

interface L10n {
  zh: string;
  en: string;
}
type ControlPlatform = 'mobile' | 'web' | 'windows';
interface SchemeItem {
  id: string;
  label: L10n;
  desc: L10n;
  fingers: 1 | 2;
  zone: string;
  actions: string[];
  /** 適用平台;舊後端沒帶 = 只適用手機。 */
  platforms?: ControlPlatform[];
}
export interface ControlCatalog {
  items: SchemeItem[];
  genreDefaults: Record<string, string[]>;
  platformDefaults?: Partial<Record<ControlPlatform, string[]>>;
  keyOptions?: KeyOption[];
}

const TEXT = {
  title: { zh: '遊戲操作行為', en: 'Game Controls' },
  hint: {
    zh: '勾選這款遊戲「怎麼操作」。AI 會依此選手勢(點擊 / 搖桿 / 長按 / 雙指),不在範圍內的手勢會被攔下,避免用錯操作撞牆。',
    en: 'Tick how this game is played. The AI picks gestures accordingly (tap / joystick / hold / two-finger); gestures outside the selection are blocked.',
  },
  hintPc: {
    zh: '勾選這款遊戲「怎麼操作」:鍵盤、滑鼠或兩者。勾鍵盤 / 滑鼠後可以定義每個鍵的用途,AI 會照用途按鍵,不在範圍內的操作會被攔下。',
    en: 'Tick how this game is played: keyboard, mouse or both. Then define what each key does; the AI presses keys by purpose and anything outside the selection is blocked.',
  },
  preview: { zh: '操作預覽', en: 'Preview' },
  suggested: { zh: '類型建議', en: 'Suggested for genre' },
  suggestedPc: { zh: '平台建議', en: 'Suggested for platform' },
  apply: { zh: '套用建議', en: 'Apply suggestion' },
  clear: { zh: '清除', en: 'Clear' },
  none: {
    zh: '未指定:執行時依 App 類型的建議操作;若類型沒有建議則不限定手勢。',
    en: 'Not set: the app genre suggestion is used at run time; no restriction if the genre has none.',
  },
  noneExplicit: {
    zh: '已全部取消:不限定手勢(AI 自由選擇動作)。',
    en: 'All cleared: no gesture restriction (AI chooses freely).',
  },
  combo: { zh: '雙指同時操作(左手移動 + 右手按鍵)', en: 'Two-finger combo (left move + right buttons)' },
  multi: { zh: '多點觸控', en: 'Multi-touch' },
  allowed: { zh: 'AI 可用動作', en: 'Allowed AI actions' },
  loadError: { zh: '無法載入操作行為清單', en: 'Failed to load control list' },
} satisfies Record<string, L10n>;

const t = (k: keyof typeof TEXT, lang: RLang) => TEXT[k][lang];

/** App 平台 → 方案平台(與後端 platformKind 一致)。 */
function platformKind(platform: string | undefined): ControlPlatform | undefined {
  if (platform === 'web') return 'web';
  if (platform === 'windows') return 'windows';
  if (platform === 'android' || platform === 'ios') return 'mobile';
  return undefined;
}

/** 與後端 buildControlsProtocol 一致:左手(搖桿/轉向)+ 右手(技能/瞄準/踏板)→ 雙指 combo。 */
function hasCombo(ids: string[]): boolean {
  const left = ids.some((i) => i === 'joystick_left' || i === 'joystick_center' || i === 'steer');
  const right = ids.some((i) => i === 'skill_right' || i === 'aim_right' || i === 'pedals');
  return left && right;
}

export function ControlSchemePicker({
  value,
  onChange,
  genre,
  platform,
  keys,
  onKeysChange,
}: {
  /** undefined = 未指定(用類型 / 平台建議)。 */
  value: string[] | undefined;
  onChange: (ids: string[] | undefined) => void;
  genre?: string | undefined;
  /** App 平台(android / ios / web / windows);決定顯示哪些方案與建議。 */
  platform?: string | undefined;
  /** 按鍵對應(YAML keys:)。 */
  keys?: CaseKey[];
  onKeysChange?: (keys: CaseKey[]) => void;
}) {
  const { locale } = useI18n();
  const lang = reportLang(locale);
  const { data, error } = useQuery<ControlCatalog>('control-schemes', () => apiGet<ControlCatalog>('/control-schemes'));
  const kind = platformKind(platform);
  const pc = kind === 'web' || kind === 'windows';
  const allItems = data?.items ?? [];
  // 依 App 平台篩選(網頁不顯示搖桿 / 雙指;手機不顯示鍵盤 / 滑鼠);已勾的方案一律保留顯示,才取消得掉。
  const items = allItems.filter(
    (i) => !kind || (i.platforms ?? ['mobile']).includes(kind) || (value ?? []).includes(i.id),
  );
  const platformSuggested = kind ? data?.platformDefaults?.[kind] : undefined;
  const suggested = platformSuggested ?? (genre ? data?.genreDefaults[genre] ?? [] : []);
  const effective = value ?? suggested;
  const order = (ids: string[]) => allItems.map((i) => i.id).filter((id) => ids.includes(id));

  function toggle(id: string, on: boolean) {
    const base = new Set(value ?? suggested);
    if (on) base.add(id);
    else base.delete(id);
    onChange(order([...base]));
  }

  const keyOptions = data?.keyOptions ?? [];
  const keyList = keys ?? [];
  const keyboardKeys = keyList.filter((k) => keyOptions.find((o) => o.id === k.key)?.kind === 'key');
  const gestures = new Set(items.filter((i) => effective.includes(i.id)).flatMap((i) => i.actions));
  if (hasCombo(effective)) gestures.add('combo');
  if (keyboardKeys.length) gestures.add('key');
  const allowed = ['tap', 'swipe', 'back', 'type', 'wait', ...[...gestures].sort()];
  const multiTouch = gestures.has('combo') || gestures.has('pinch');
  const wantKeyboard = effective.includes('keyboard');
  const wantMouse = effective.includes('mouse');
  const showKeys = Boolean(onKeysChange) && keyOptions.length > 0 && (wantKeyboard || wantMouse || keyList.length > 0);

  return (
    <fieldset className="ctl">
      <legend className="ctl__legend">{t('title', lang)}</legend>
      <p className="ctl__hint">{t(pc ? 'hintPc' : 'hint', lang)}</p>
      {error && <p className="ctl__error" role="alert">{t('loadError', lang)}</p>}

      <div className="ctl__top">
        <div className="ctl__preview">
          <ControlGlyph
            ids={effective}
            size={200}
            frame={pc ? 'screen' : 'phone'}
            title={`${t('preview', lang)}: ${effective.join(', ') || '—'}`}
          />
          <span className="ctl__preview-label">
            {t('preview', lang)}
            {value === undefined && suggested.length > 0 && <em> · {t(platformSuggested ? 'suggestedPc' : 'suggested', lang)}</em>}
          </span>
        </div>
        <div className="ctl__summary">
          {effective.length === 0 ? (
            <p className="ctl__muted">{value === undefined ? t('none', lang) : t('noneExplicit', lang)}</p>
          ) : (
            <>
              <p className="ctl__allowed">
                <span>{t('allowed', lang)}:</span>
                {allowed.map((a) => (
                  <code key={a}>{a}</code>
                ))}
              </p>
              {hasCombo(effective) && <p className="ctl__badge">✌ {t('combo', lang)}</p>}
              {!hasCombo(effective) && multiTouch && <p className="ctl__badge">✌ {t('multi', lang)}</p>}
            </>
          )}
          <div className="ctl__btns">
            {suggested.length > 0 && (
              <button type="button" className="ctl__btn" onClick={() => onChange(order(suggested))}>
                {t('apply', lang)}({suggested.map((id) => allItems.find((i) => i.id === id)?.label[lang] ?? id).join('、')})
              </button>
            )}
            {value !== undefined && (
              <button type="button" className="ctl__btn ctl__btn--ghost" onClick={() => onChange(undefined)}>
                {t('clear', lang)}
              </button>
            )}
          </div>
        </div>
      </div>

      <ul className="ctl__grid">
        {items.map((s) => {
          const on = effective.includes(s.id);
          const isSuggested = suggested.includes(s.id);
          return (
            <li key={s.id}>
              <label className={`ctl__card${on ? ' is-on' : ''}${value === undefined && on ? ' is-suggested' : ''}`}>
                <input
                  type="checkbox"
                  className="visually-hidden"
                  checked={on}
                  onChange={(e) => toggle(s.id, e.target.checked)}
                />
                <ControlGlyph ids={[s.id]} size={112} frame={pc ? 'screen' : 'phone'} />
                <span className="ctl__name">
                  {s.label[lang]}
                  {s.fingers === 2 && <span className="ctl__tag">✌</span>}
                  {isSuggested && <span className="ctl__tag ctl__tag--sug">★</span>}
                </span>
                <span className="ctl__desc">{s.desc[lang]}</span>
                <span className="ctl__check" aria-hidden="true">{on ? '✓' : ''}</span>
              </label>
            </li>
          );
        })}
      </ul>

      {showKeys && onKeysChange && (
        <KeyMapEditor
          value={keyList}
          onChange={onKeysChange}
          options={keyOptions}
          keyboard={wantKeyboard || keyboardKeys.length > 0}
          mouse={wantMouse}
          lang={lang}
        />
      )}
    </fieldset>
  );
}
