import { apiGet } from '../../api/client.ts';
import { useQuery } from '../../api/useQuery.ts';
import { useI18n } from '../../i18n/I18nProvider.tsx';
import { reportLang, type RLang } from '../report/reportText.ts';
import { ControlGlyph } from './ControlGlyph.tsx';
import './ControlSchemePicker.css';

interface L10n {
  zh: string;
  en: string;
}
interface SchemeItem {
  id: string;
  label: L10n;
  desc: L10n;
  fingers: 1 | 2;
  zone: string;
  actions: string[];
}
export interface ControlCatalog {
  items: SchemeItem[];
  genreDefaults: Record<string, string[]>;
}

const TEXT = {
  title: { zh: '遊戲操作行為', en: 'Game Controls' },
  hint: {
    zh: '勾選這款遊戲「怎麼操作」。AI 會依此選手勢(點擊 / 搖桿 / 長按 / 雙指),不在範圍內的手勢會被攔下,避免用錯操作撞牆。',
    en: 'Tick how this game is played. The AI picks gestures accordingly (tap / joystick / hold / two-finger); gestures outside the selection are blocked.',
  },
  preview: { zh: '操作預覽', en: 'Preview' },
  suggested: { zh: '類型建議', en: 'Suggested for genre' },
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
}: {
  /** undefined = 未指定(用類型建議)。 */
  value: string[] | undefined;
  onChange: (ids: string[] | undefined) => void;
  genre?: string | undefined;
}) {
  const { locale } = useI18n();
  const lang = reportLang(locale);
  const { data, error } = useQuery<ControlCatalog>('control-schemes', () => apiGet<ControlCatalog>('/control-schemes'));
  const items = data?.items ?? [];
  const suggested = genre ? data?.genreDefaults[genre] ?? [] : [];
  const effective = value ?? suggested;
  const order = (ids: string[]) => items.map((i) => i.id).filter((id) => ids.includes(id));

  function toggle(id: string, on: boolean) {
    const base = new Set(value ?? suggested);
    if (on) base.add(id);
    else base.delete(id);
    onChange(order([...base]));
  }

  const gestures = new Set(items.filter((i) => effective.includes(i.id)).flatMap((i) => i.actions));
  if (hasCombo(effective)) gestures.add('combo');
  const allowed = ['tap', 'swipe', 'back', 'type', 'wait', ...[...gestures].sort()];
  const multiTouch = gestures.has('combo') || gestures.has('pinch');

  return (
    <fieldset className="ctl">
      <legend className="ctl__legend">{t('title', lang)}</legend>
      <p className="ctl__hint">{t('hint', lang)}</p>
      {error && <p className="ctl__error" role="alert">{t('loadError', lang)}</p>}

      <div className="ctl__top">
        <div className="ctl__preview">
          <ControlGlyph ids={effective} size={200} title={`${t('preview', lang)}: ${effective.join(', ') || '—'}`} />
          <span className="ctl__preview-label">
            {t('preview', lang)}
            {value === undefined && suggested.length > 0 && <em> · {t('suggested', lang)}</em>}
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
                {t('apply', lang)}({suggested.map((id) => items.find((i) => i.id === id)?.label[lang] ?? id).join('、')})
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
                <ControlGlyph ids={[s.id]} size={112} />
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
    </fieldset>
  );
}
