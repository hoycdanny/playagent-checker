import { apiGet } from '../../api/client.ts';
import { useQuery } from '../../api/useQuery.ts';
import { useI18n } from '../../i18n/I18nProvider.tsx';
import { loc5, pick5, type L5, type Loc5 } from '../../i18n/locale5.ts';
import { reportLang } from '../report/reportText.ts';
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
  title: ['遊戲操作行為', 'Game Controls', '游戏操作行为', 'ゲームの操作方法', '게임 조작 방식'],
  hint: [
    '勾選這款遊戲「怎麼操作」。AI 會依此選手勢(點擊 / 搖桿 / 長按 / 雙指),不在範圍內的手勢會被攔下,避免用錯操作撞牆。',
    'Tick how this game is played. The AI picks gestures accordingly (tap / joystick / hold / two-finger); gestures outside the selection are blocked.',
    '勾选这款游戏“怎么操作”。AI 会据此选手势(点击 / 摇杆 / 长按 / 双指),不在范围内的手势会被拦下,避免用错操作碰壁。',
    'このゲームの操作方法を選択します。AI はそれに沿ってジェスチャー(タップ / ジョイスティック / 長押し / 2 本指)を選び、範囲外のジェスチャーはブロックされます。',
    '이 게임의 조작 방식을 선택하세요. AI가 그에 맞춰 제스처(탭 / 조이스틱 / 길게 누르기 / 두 손가락)를 고르며, 선택 범위 밖의 제스처는 차단됩니다.',
  ],
  hintPc: [
    '勾選這款遊戲「怎麼操作」:鍵盤、滑鼠或兩者。勾鍵盤 / 滑鼠後可以定義每個鍵的用途,AI 會照用途按鍵,不在範圍內的操作會被攔下。',
    'Tick how this game is played: keyboard, mouse or both. Then define what each key does; the AI presses keys by purpose and anything outside the selection is blocked.',
    '勾选这款游戏“怎么操作”:键盘、鼠标或两者。勾选键盘 / 鼠标后可以定义每个键的用途,AI 会按用途按键,不在范围内的操作会被拦下。',
    'このゲームの操作方法(キーボード、マウス、または両方)を選択します。各キーの用途を定義でき、AI は用途に従ってキーを押し、範囲外の操作はブロックされます。',
    '이 게임의 조작 방식(키보드, 마우스 또는 둘 다)을 선택하세요. 각 키의 용도를 정의할 수 있고, AI는 용도에 따라 키를 누르며 범위 밖의 조작은 차단됩니다.',
  ],
  preview: ['操作預覽', 'Preview', '操作预览', '操作プレビュー', '조작 미리보기'],
  suggested: ['類型建議', 'Suggested for genre', '类型建议', 'ジャンル別の推奨', '장르별 추천'],
  suggestedPc: ['平台建議', 'Suggested for platform', '平台建议', 'プラットフォーム別の推奨', '플랫폼별 추천'],
  apply: ['套用建議', 'Apply suggestion', '应用建议', '推奨を適用', '추천 적용'],
  clear: ['清除', 'Clear', '清除', 'クリア', '지우기'],
  none: [
    '未指定:執行時依 App 類型的建議操作;若類型沒有建議則不限定手勢。',
    'Not set: the app genre suggestion is used at run time; no restriction if the genre has none.',
    '未指定:运行时按 App 类型的建议操作;若类型没有建议则不限定手势。',
    '未指定:実行時にアプリのジャンルの推奨操作を使用します。推奨がなければジェスチャーは制限されません。',
    '미지정: 실행 시 앱 장르의 추천 조작을 사용하며, 추천이 없으면 제스처를 제한하지 않습니다.',
  ],
  noneExplicit: [
    '已全部取消:不限定手勢(AI 自由選擇動作)。',
    'All cleared: no gesture restriction (AI chooses freely).',
    '已全部取消:不限定手势(AI 自由选择动作)。',
    'すべて解除:ジェスチャーを制限しません(AI が自由に選択)。',
    '모두 해제됨: 제스처를 제한하지 않습니다(AI가 자유롭게 선택).',
  ],
  combo: [
    '雙指同時操作(左手移動 + 右手按鍵)',
    'Two-finger combo (left move + right buttons)',
    '双指同时操作(左手移动 + 右手按键)',
    '2 本指の同時操作(左手で移動 + 右手でボタン)',
    '두 손가락 동시 조작(왼손 이동 + 오른손 버튼)',
  ],
  multi: ['多點觸控', 'Multi-touch', '多点触控', 'マルチタッチ', '멀티터치'],
  allowed: ['AI 可用動作', 'Allowed AI actions', 'AI 可用动作', 'AI が使える操作', 'AI 사용 가능 동작'],
  loadError: ['無法載入操作行為清單', 'Failed to load control list', '无法加载操作行为列表', '操作方法の一覧を読み込めませんでした', '조작 방식 목록을 불러오지 못했습니다'],
} satisfies Record<string, L5>;
const t = (k: keyof typeof TEXT, lc: Loc5) => pick5(TEXT[k], lc);

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
  const lc = loc5(locale);
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
      <legend className="ctl__legend">{t('title', lc)}</legend>
      <p className="ctl__hint">{t(pc ? 'hintPc' : 'hint', lc)}</p>
      {error && <p className="ctl__error" role="alert">{t('loadError', lc)}</p>}

      <div className="ctl__top">
        <div className="ctl__preview">
          <ControlGlyph
            ids={effective}
            size={200}
            frame={pc ? 'screen' : 'phone'}
            title={`${t('preview', lc)}: ${effective.join(', ') || '—'}`}
          />
          <span className="ctl__preview-label">
            {t('preview', lc)}
            {value === undefined && suggested.length > 0 && <em> · {t(platformSuggested ? 'suggestedPc' : 'suggested', lc)}</em>}
          </span>
        </div>
        <div className="ctl__summary">
          {effective.length === 0 ? (
            <p className="ctl__muted">{value === undefined ? t('none', lc) : t('noneExplicit', lc)}</p>
          ) : (
            <>
              <p className="ctl__allowed">
                <span>{t('allowed', lc)}:</span>
                {allowed.map((a) => (
                  <code key={a}>{a}</code>
                ))}
              </p>
              {hasCombo(effective) && <p className="ctl__badge">✌ {t('combo', lc)}</p>}
              {!hasCombo(effective) && multiTouch && <p className="ctl__badge">✌ {t('multi', lc)}</p>}
            </>
          )}
          <div className="ctl__btns">
            {suggested.length > 0 && (
              <button type="button" className="ctl__btn" onClick={() => onChange(order(suggested))}>
                {t('apply', lc)}({suggested.map((id) => allItems.find((i) => i.id === id)?.label[lang] ?? id).join('、')})
              </button>
            )}
            {value !== undefined && (
              <button type="button" className="ctl__btn ctl__btn--ghost" onClick={() => onChange(undefined)}>
                {t('clear', lc)}
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
          locale={locale}
        />
      )}
    </fieldset>
  );
}
