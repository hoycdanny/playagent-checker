import { apiGet } from '../../api/client.ts';
import { useQuery } from '../../api/useQuery.ts';
import { useI18n } from '../../i18n/I18nProvider.tsx';
import { listSep, loc5, pick5, type L5, type Loc5 } from '../../i18n/locale5.ts';
import { reportLang, tr } from '../report/reportText.ts';
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

/**
 * 操作方案的名稱 / 說明:後端只有 {zh,en}(簡中會看到繁中、日韓看到英文),
 * 這裡依方案 id 補齊五語;後端新增了這裡沒有的方案時退回後端文字。
 */
const SCHEME_TEXT: Record<string, { label: L5; desc: L5 }> = {
  tap: {
    label: ['單點點擊', 'Single Tap', '单点点击', 'シングルタップ', '단일 탭'],
    desc: [
      '主要玩法靠點按鈕(如 SPIN、出牌、選項)',
      'Gameplay is button taps (SPIN, play card, options)',
      '主要玩法靠点按钮(如 SPIN、出牌、选项)',
      '主にボタンをタップして遊ぶ(SPIN、カードを出す、選択肢など)',
      '주로 버튼을 탭해서 플레이(SPIN, 카드 내기, 선택지 등)',
    ],
  },
  hold: {
    label: ['長按 / 蓄力', 'Hold / Charge', '长按 / 蓄力', '長押し / チャージ', '길게 누르기 / 차지'],
    desc: [
      '按住一段時間再放開(蓄力、加速、持續射擊)',
      'Press and hold, then release (charge, boost, auto-fire)',
      '按住一段时间再放开(蓄力、加速、持续射击)',
      'しばらく押してから離す(チャージ、加速、連射)',
      '한동안 누른 뒤 떼기(차지, 가속, 연사)',
    ],
  },
  swipe: {
    label: ['方向滑動', 'Directional Swipe', '方向滑动', '方向スワイプ', '방향 스와이프'],
    desc: [
      '快速朝方向滑(消除交換、跑酷閃避、切水果)',
      'Quick flick (match-3 swap, runner dodge, slicing)',
      '快速朝方向滑(消除交换、跑酷闪避、切水果)',
      '方向へ素早くスワイプ(パズルの入れ替え、ランナーの回避、カット)',
      '방향으로 빠르게 스와이프(퍼즐 교환, 러너 회피, 자르기)',
    ],
  },
  drag: {
    label: ['拖曳放置', 'Drag & Drop', '拖拽放置', 'ドラッグ&ドロップ', '드래그 앤 드롭'],
    desc: [
      '把物件拖到目標位置(放塔、出牌、合成)',
      'Drag an object onto a target (place tower, play card, merge)',
      '把物件拖到目标位置(放塔、出牌、合成)',
      'オブジェクトを目標位置へドラッグ(タワー設置、カードを出す、合成)',
      '오브젝트를 목표 위치로 드래그(타워 배치, 카드 내기, 합성)',
    ],
  },
  joystick_center: {
    label: ['下方中央搖桿', 'Bottom-Center Joystick', '下方中央摇杆', '下部中央ジョイスティック', '하단 중앙 조이스틱'],
    desc: [
      '按住畫面下方拖曳走位(割草、生存類)',
      'Hold and drag at bottom-center to move (survivor-like)',
      '按住画面下方拖拽走位(割草、生存类)',
      '画面下部を押したままドラッグして移動(サバイバー系)',
      '화면 하단을 누른 채 드래그해 이동(서바이버류)',
    ],
  },
  joystick_left: {
    label: ['左側搖桿', 'Left Joystick', '左侧摇杆', '左ジョイスティック', '왼쪽 조이스틱'],
    desc: [
      '左手拇指在左下控制方向',
      'Left thumb controls direction at bottom-left',
      '左手拇指在左下控制方向',
      '左手の親指で左下から方向を操作',
      '왼손 엄지로 왼쪽 아래에서 방향 조작',
    ],
  },
  skill_right: {
    label: ['右側技能鍵', 'Right Skill Buttons', '右侧技能键', '右側スキルボタン', '오른쪽 스킬 버튼'],
    desc: [
      '右手拇指點攻擊 / 技能 / 跳躍',
      'Right thumb taps attack / skills / jump',
      '右手拇指点攻击 / 技能 / 跳跃',
      '右手の親指で攻撃 / スキル / ジャンプをタップ',
      '오른손 엄지로 공격 / 스킬 / 점프 탭',
    ],
  },
  aim_right: {
    label: ['右側拖曳瞄準', 'Right-Side Aim', '右侧拖拽瞄准', '右側ドラッグで照準', '오른쪽 드래그 조준'],
    desc: [
      '右半邊拖曳轉視角 / 瞄準(射擊類)',
      'Drag on right half to look / aim (shooters)',
      '右半边拖拽转视角 / 瞄准(射击类)',
      '画面右半分をドラッグして視点移動 / 照準(シューター)',
      '화면 오른쪽 절반을 드래그해 시점 전환 / 조준(슈팅)',
    ],
  },
  steer: {
    label: ['左右轉向', 'Left / Right Steering', '左右转向', '左右ステアリング', '좌우 조향'],
    desc: [
      '按住左右方向鍵或左右半邊轉向(賽車)',
      'Hold left/right buttons or screen halves to steer (racing)',
      '按住左右方向键或左右半边转向(赛车)',
      '左右のボタンか画面の左右半分を押してハンドル操作(レース)',
      '좌우 버튼이나 화면 좌우 절반을 눌러 조향(레이싱)',
    ],
  },
  pedals: {
    label: ['油門 / 甩尾 / 氮氣', 'Gas / Drift / Nitro', '油门 / 甩尾 / 氮气', 'アクセル / ドリフト / ニトロ', '가속 / 드리프트 / 니트로'],
    desc: [
      '右側按住油門、點擊氮氣或甩尾',
      'Hold gas, tap nitro/drift on the right',
      '右侧按住油门、点击氮气或甩尾',
      '右側でアクセルを押し続け、ニトロやドリフトをタップ',
      '오른쪽에서 가속을 누른 채 니트로나 드리프트를 탭',
    ],
  },
  pinch: {
    label: ['雙指縮放', 'Pinch Zoom', '双指缩放', 'ピンチズーム', '핀치 줌'],
    desc: [
      '兩指縮放地圖 / 場景(策略、模擬)',
      'Two-finger zoom on map / scene (strategy, sim)',
      '两指缩放地图 / 场景(策略、模拟)',
      '2 本指でマップ / シーンを拡大縮小(ストラテジー、シミュレーション)',
      '두 손가락으로 지도 / 장면 확대·축소(전략, 시뮬레이션)',
    ],
  },
  rhythm: {
    label: ['節奏點擊', 'Rhythm Taps', '节奏点击', 'リズムタップ', '리듬 탭'],
    desc: [
      '音符到判定線時點擊 / 長按(音樂節奏)',
      'Tap / hold when notes reach the judge line',
      '音符到判定线时点击 / 长按(音乐节奏)',
      'ノーツが判定ラインに来たらタップ / 長押し(音楽リズム)',
      '노트가 판정선에 닿을 때 탭 / 길게 누르기(음악 리듬)',
    ],
  },
  keyboard: {
    label: ['鍵盤', 'Keyboard', '键盘', 'キーボード', '키보드'],
    desc: [
      '用鍵盤按鍵操作(方向鍵移動、Enter/Z 確認、Esc/X 選單…);可自訂每個鍵的用途',
      'Played with keys (arrows to move, Enter/Z to confirm, Esc/X for menu…); define what each key does',
      '用键盘按键操作(方向键移动、Enter/Z 确认、Esc/X 菜单…);可自定义每个键的用途',
      'キーで操作(矢印キーで移動、Enter/Z で決定、Esc/X でメニュー…)。各キーの用途を定義できます',
      '키로 조작(방향키로 이동, Enter/Z로 확인, Esc/X로 메뉴…). 각 키의 용도를 정의할 수 있습니다',
    ],
  },
  mouse: {
    label: ['滑鼠', 'Mouse', '鼠标', 'マウス', '마우스'],
    desc: [
      '滑鼠左鍵點擊、按住拖曳、滾輪捲動;右鍵可自訂用途',
      'Left-click, drag, scroll wheel; right-click can be given a purpose',
      '鼠标左键点击、按住拖拽、滚轮滚动;右键可自定义用途',
      '左クリック、ドラッグ、ホイールでスクロール。右クリックには用途を設定できます',
      '왼쪽 클릭, 드래그, 휠 스크롤. 오른쪽 클릭에는 용도를 지정할 수 있습니다',
    ],
  },
};

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
  const schemeLabel = (s: SchemeItem | undefined) => {
    if (!s) return '';
    const own = SCHEME_TEXT[s.id];
    return own ? pick5(own.label, lc) : tr(s.label, lang);
  };
  const schemeDesc = (s: SchemeItem) => {
    const own = SCHEME_TEXT[s.id];
    return own ? pick5(own.desc, lc) : tr(s.desc, lang);
  };

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
                {t('apply', lc)}({suggested.map((id) => schemeLabel(allItems.find((i) => i.id === id)) || id).join(listSep(lc))})
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
                  {schemeLabel(s)}
                  {s.fingers === 2 && <span className="ctl__tag">✌</span>}
                  {isSuggested && <span className="ctl__tag ctl__tag--sug">★</span>}
                </span>
                <span className="ctl__desc">{schemeDesc(s)}</span>
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
