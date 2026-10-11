/**
 * 遊戲操作行為(控制方案)目錄。
 *
 * 目的:Device Farm 透過 Appium 操作時,AI 不知道「這款遊戲該怎麼操作」就會撞牆
 * (例:賽車用拉霸機的單點點擊、射擊遊戲不會左手搖桿 + 右手技能同時按)。
 * 建立測試腳本時由使用者勾選操作行為(依 App 類型預選建議),寫進案例 YAML 的
 * `controls:` 欄位;提交時快照進 job,engine 組成 context.json 的 `controls` 協議,
 * runner 據此:
 *   1. 在 system prompt 注入權威的「操作方式」段落(必須遵守);
 *   2. 只開放對應的手勢動作(move/hold/combo/pinch),不允許的動作會被攔下並回饋給 AI;
 *   3. 以方案決定搖桿預設位置(下方中央 / 左下)與是否啟用「戰鬥強制走位」。
 *
 * 基礎動作 tap/swipe/back/type/wait/launch/done 永遠可用(選單、彈窗都需要點擊)。
 */

export const CONTROL_IDS = [
  'tap',
  'hold',
  'swipe',
  'drag',
  'joystick_center',
  'joystick_left',
  'skill_right',
  'aim_right',
  'steer',
  'pedals',
  'pinch',
  'rhythm',
] as const;
export type ControlId = (typeof CONTROL_IDS)[number];

/** runner 的手勢動作(基礎動作之外,依方案開放)。 */
export type GestureAction = 'move' | 'hold' | 'combo' | 'pinch';
export const BASE_ACTIONS = ['tap', 'swipe', 'back', 'type', 'wait', 'launch', 'done'] as const;

interface L10n {
  zh: string;
  en: string;
}

export interface ControlScheme {
  id: ControlId;
  label: L10n;
  desc: L10n;
  /** 需要的手指數(2 = 多點觸控)。 */
  fingers: 1 | 2;
  /** 螢幕上的操作區域(圖示與 prompt 用)。 */
  zone: 'any' | 'center' | 'bottom_center' | 'left' | 'right' | 'lanes';
  /** 開放的手勢動作。 */
  actions: GestureAction[];
  /** 給 AI 的操作指示(zh,注入 prompt)。 */
  prompt: string;
}

const L = (zh: string, en: string): L10n => ({ zh, en });

export const CONTROL_SCHEMES: ControlScheme[] = [
  {
    id: 'tap',
    label: L('單點點擊', 'Single Tap'),
    desc: L('主要玩法靠點按鈕(如 SPIN、出牌、選項)', 'Gameplay is button taps (SPIN, play card, options)'),
    fingers: 1,
    zone: 'any',
    actions: [],
    prompt: '主要玩法是「單點點擊按鈕」。用 tap 對準按鈕正中心;不需要搖桿、不需要按住或多指。',
  },
  {
    id: 'hold',
    label: L('長按 / 蓄力', 'Hold / Charge'),
    desc: L('按住一段時間再放開(蓄力、加速、持續射擊)', 'Press and hold, then release (charge, boost, auto-fire)'),
    fingers: 1,
    zone: 'any',
    actions: ['hold'],
    prompt: '需要「長按」:用 hold 動作(x,y=按住位置,holdMs=按住毫秒,建議 600~3000)。蓄力越久效果越強時,依畫面提示決定 holdMs。',
  },
  {
    id: 'swipe',
    label: L('方向滑動', 'Directional Swipe'),
    desc: L('快速朝方向滑(消除交換、跑酷閃避、切水果)', 'Quick flick (match-3 swap, runner dodge, slicing)'),
    fingers: 1,
    zone: 'center',
    actions: [],
    prompt: '玩法靠「快速滑動」:用 swipe(x,y 起點 → x2,y2 終點,durationMs 建議 150~300 表示快速一劃)。消除類:從要移動的方塊中心滑到相鄰方塊。',
  },
  {
    id: 'drag',
    label: L('拖曳放置', 'Drag & Drop'),
    desc: L('把物件拖到目標位置(放塔、出牌、合成)', 'Drag an object onto a target (place tower, play card, merge)'),
    fingers: 1,
    zone: 'any',
    actions: [],
    prompt: '需要「拖曳放置」:用 swipe 並給較長的 durationMs(600~1200),x,y=被拖物件中心,x2,y2=放置目標中心。',
  },
  {
    id: 'joystick_center',
    label: L('下方中央搖桿', 'Bottom-Center Joystick'),
    desc: L('按住畫面下方拖曳走位(割草、生存類)', 'Hold and drag at bottom-center to move (survivor-like)'),
    fingers: 1,
    zone: 'bottom_center',
    actions: ['move'],
    prompt: '移動靠「下方中央的虛擬搖桿」:戰鬥中移動只能用 move(dir 方向 + holdMs 按住 1500~3000),不要用 tap 移動。x,y 省略時 runner 自動以下方中央為搖桿中心。',
  },
  {
    id: 'joystick_left',
    label: L('左側搖桿', 'Left Joystick'),
    desc: L('左手拇指在左下控制方向', 'Left thumb controls direction at bottom-left'),
    fingers: 1,
    zone: 'left',
    actions: ['move'],
    prompt: '移動靠「左下角的虛擬搖桿」:用 move(dir 方向 + holdMs)。若看得到搖桿圓圈,用 x,y 指定其中心;省略時 runner 以左下區域(約寬 18%、高 72%)為中心。不要用 tap 移動角色。',
  },
  {
    id: 'skill_right',
    label: L('右側技能鍵', 'Right Skill Buttons'),
    desc: L('右手拇指點攻擊 / 技能 / 跳躍', 'Right thumb taps attack / skills / jump'),
    fingers: 1,
    zone: 'right',
    actions: [],
    prompt: '攻擊/技能/跳躍按鈕在「右下角」:用 tap 點對應按鈕(大圓鍵通常是普攻,周圍小鍵是技能,灰色/有冷卻數字的暫時不能用)。',
  },
  {
    id: 'aim_right',
    label: L('右側拖曳瞄準', 'Right-Side Aim'),
    desc: L('右半邊拖曳轉視角 / 瞄準(射擊類)', 'Drag on right half to look / aim (shooters)'),
    fingers: 1,
    zone: 'right',
    actions: [],
    prompt: '視角/瞄準靠「在右半邊空白處拖曳」:用 swipe(起點在右半邊空白區,位移小、durationMs 300~600)微調準心,對準敵人後再點開火鍵。',
  },
  {
    id: 'steer',
    label: L('左右轉向', 'Left / Right Steering'),
    desc: L('按住左右方向鍵或左右半邊轉向(賽車)', 'Hold left/right buttons or screen halves to steer (racing)'),
    fingers: 1,
    zone: 'left',
    actions: ['hold'],
    prompt: '轉向靠「按住左/右方向鍵」(常見在左下兩顆箭頭;若沒有箭頭,則按住畫面左半邊=左轉、右半邊=右轉):用 hold(x,y=方向鍵或半邊中心,holdMs 300~1200 依彎道大小)。不要用 tap 轉向,點一下幾乎沒有效果。',
  },
  {
    id: 'pedals',
    label: L('油門 / 甩尾 / 氮氣', 'Gas / Drift / Nitro'),
    desc: L('右側按住油門、點擊氮氣或甩尾', 'Hold gas, tap nitro/drift on the right'),
    fingers: 1,
    zone: 'right',
    actions: ['hold'],
    prompt: '右側是油門/煞車/甩尾/氮氣鍵:油門與甩尾用 hold 按住,氮氣(N2O/火焰圖示)用 tap。若遊戲自動加速則不需按油門。',
  },
  {
    id: 'pinch',
    label: L('雙指縮放', 'Pinch Zoom'),
    desc: L('兩指縮放地圖 / 場景(策略、模擬)', 'Two-finger zoom on map / scene (strategy, sim)'),
    fingers: 2,
    zone: 'center',
    actions: ['pinch'],
    prompt: '地圖可「雙指縮放」:用 pinch(x,y=縮放中心,scale="out" 放大 / "in" 縮小)。平移地圖用 swipe。',
  },
  {
    id: 'rhythm',
    label: L('節奏點擊', 'Rhythm Taps'),
    desc: L('音符到判定線時點擊 / 長按(音樂節奏)', 'Tap / hold when notes reach the judge line'),
    fingers: 1,
    zone: 'lanes',
    actions: ['hold'],
    prompt: '節奏遊戲:音符落到判定線時 tap 該軌道,長條音符用 hold(holdMs 依長條長度)。截圖有延遲,請預估音符到達位置。',
  },
];

const BY_ID = new Map(CONTROL_SCHEMES.map((s) => [s.id, s]));

export function isControlId(v: unknown): v is ControlId {
  return typeof v === 'string' && BY_ID.has(v as ControlId);
}

/** 依 App 類型的建議操作行為(建立腳本時預選;案例沒寫 controls 時的後備)。 */
export const GENRE_DEFAULT_CONTROLS: Record<string, ControlId[]> = {
  action: ['joystick_left', 'skill_right'],
  adventure: ['joystick_left', 'tap'],
  action_adventure: ['joystick_left', 'skill_right'],
  rpg: ['joystick_left', 'skill_right', 'tap'],
  mmorpg: ['joystick_left', 'skill_right', 'tap'],
  strategy: ['tap', 'drag', 'pinch'],
  simulation: ['tap', 'drag', 'pinch'],
  shooter: ['joystick_left', 'aim_right', 'skill_right'],
  fighting: ['joystick_left', 'skill_right'],
  platformer: ['joystick_left', 'skill_right'],
  puzzle: ['tap', 'swipe', 'drag'],
  racing: ['steer', 'pedals'],
  sports: ['joystick_left', 'skill_right'],
  card: ['tap', 'drag'],
  board: ['tap', 'drag'],
  rhythm: ['rhythm'],
  survival: ['joystick_left', 'skill_right', 'tap'],
  survivor: ['joystick_center'],
  roguelike: ['joystick_left', 'skill_right'],
  battle_royale: ['joystick_left', 'aim_right', 'skill_right'],
  sandbox: ['joystick_left', 'aim_right', 'tap'],
  idle: ['tap'],
  tower_defense: ['tap', 'drag'],
  moba: ['joystick_left', 'skill_right'],
  slot: ['tap', 'hold'],
  casino: ['tap', 'drag'],
  bingo: ['tap'],
  casual: ['tap', 'swipe'],
  hyper_casual: ['tap', 'hold', 'swipe'],
  educational: ['tap', 'drag'],
};

export function defaultControlsForGenre(genre: string | undefined): ControlId[] {
  return genre ? [...(GENRE_DEFAULT_CONTROLS[genre] ?? [])] : [];
}

/** 清理輸入(去重、只留合法 id、保持目錄順序)。 */
export function sanitizeControls(raw: unknown): ControlId[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,\s]+/) : [];
  const set = new Set(list.map((v) => String(v).trim()).filter(isControlId));
  return CONTROL_IDS.filter((id) => set.has(id));
}

/**
 * 從案例 YAML 讀頂層 `controls:`。支援:
 *   controls: [tap, hold]
 *   controls: tap, hold
 *   controls:
 *     - tap
 *     - hold
 * 沒寫 → undefined(由類型建議後備);寫了空陣列 → [](明確不限定,走舊行為)。
 */
export function parseCaseControls(yaml: string): ControlId[] | undefined {
  const lines = yaml.split(/\r?\n/);
  const idx = lines.findIndex((l) => /^controls:/.test(l));
  if (idx < 0) return undefined;
  const inline = lines[idx]!.replace(/^controls:/, '').replace(/#.*$/, '').trim();
  if (inline) return sanitizeControls(inline.replace(/^\[|\]$/g, '').split(','));
  const items: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const m = /^\s+-\s*([A-Za-z_]+)/.exec(lines[i]!);
    if (m) items.push(m[1]!);
    else if (lines[i]!.trim() !== '') break;
  }
  return sanitizeControls(items);
}

/**
 * 案例內文明確要求「長按」,但 `controls:` 沒勾長按 → 自動補上 hold。
 * 2026-10-11:RTP 案例內文寫「長按 SPIN 約 1.5 秒(hold)」,但某次編修把 controls 改成只剩 [tap],
 * runner 依規定拒絕 hold,AI 開不了 AutoSpin,三個任務都只能一局一局點、跑不完。
 * 兩者矛盾時以內文為準(只補不減:不會因為內文沒提就拿掉使用者勾的方案)。回傳 added = 是否有補。
 */
const HOLD_TEXT_RE = /長按|长按|按住|holdMs|\bhold\b|long[\s-]?press/i;
export function reconcileControlsWithText(yaml: string, ids: ControlId[]): { ids: ControlId[]; added: ControlId[] } {
  const body = yaml.split(/\r?\n/).filter((l) => !/^controls:/.test(l) && !/^\s+-\s*[A-Za-z_]+\s*$/.test(l)).join('\n');
  const added: ControlId[] = [];
  if (ids.length > 0 && !ids.includes('hold') && HOLD_TEXT_RE.test(body)) added.push('hold');
  return { ids: [...ids, ...added], added };
}

export interface ControlsProtocol {
  ids: ControlId[];
  source: 'case' | 'genre';
  /** runner 允許的動作(基礎 + 方案開放的手勢)。 */
  allowedActions: string[];
  /** 搖桿預設中心(截圖比例);無搖桿方案時不帶。 */
  joystick?: { x: number; y: number };
  /** 是否啟用「戰鬥強制走位」(割草類下方中央搖桿)。 */
  battleMove: boolean;
  /** 需要雙指(多點觸控)。 */
  multiTouch: boolean;
  /** 注入 prompt 的權威段落。 */
  prompt: string;
}

/** 組成 runner 用的控制協議;ids 為空 → null(runner 維持舊行為)。 */
export function buildControlsProtocol(ids: ControlId[], source: 'case' | 'genre'): ControlsProtocol | null {
  if (ids.length === 0) return null;
  const schemes = ids.map((id) => BY_ID.get(id)!).filter(Boolean);
  const gestures = new Set<GestureAction>(schemes.flatMap((s) => s.actions));
  const has = (id: ControlId) => ids.includes(id);
  const leftFinger = has('joystick_left') || has('joystick_center') || has('steer');
  const rightFinger = has('skill_right') || has('aim_right') || has('pedals');
  // 左手(搖桿/轉向)+ 右手(技能/瞄準/油門)同時 → 開放 combo 雙指動作。
  if (leftFinger && rightFinger) gestures.add('combo');
  const allowedActions = [...BASE_ACTIONS, ...[...gestures].sort()];
  const joystick = has('joystick_left') ? { x: 0.18, y: 0.72 } : has('joystick_center') ? { x: 0.495, y: 0.821 } : undefined;

  const lines: string[] = [];
  lines.push('【本遊戲的操作方式|測試腳本指定|必須遵守】');
  schemes.forEach((s, i) => lines.push(`${i + 1}. ${s.label.zh}:${s.prompt}`));
  if (gestures.has('combo')) {
    lines.push(
      '【雙指同時操作】需要「左手移動/轉向 + 右手按技能/開火/氮氣」同時進行時,用 combo 動作:' +
        'x,y=左手位置(搖桿中心或方向鍵),dir=搖桿方向(轉向鍵按住則省略 dir),holdMs=左手按住毫秒(800~3000),' +
        'tx,ty=右手要點的按鈕中心,taps=按住期間右手點擊次數(1~5)。邊走邊打、邊轉彎邊開氮氣都用 combo。',
    );
  }
  lines.push(
    `可用動作只有:${allowedActions.join(' / ')}。選單、彈窗、設定頁一律用 tap;` +
      '不在清單內的動作會被系統拒絕且浪費一步。',
  );
  if (!has('joystick_center') && !has('joystick_left')) lines.push('這款遊戲沒有虛擬搖桿,不要用 move。');
  return {
    ids,
    source,
    allowedActions,
    ...(joystick ? { joystick } : {}),
    battleMove: has('joystick_center'),
    multiTouch: gestures.has('combo') || gestures.has('pinch'),
    prompt: lines.join('\n'),
  };
}

/** 前端用的目錄(標籤、說明、區域、建議類型)。 */
export function describeControlCatalog(): {
  items: Array<Omit<ControlScheme, 'prompt'>>;
  genreDefaults: Record<string, ControlId[]>;
} {
  return {
    items: CONTROL_SCHEMES.map(({ prompt: _p, ...rest }) => rest),
    genreDefaults: GENRE_DEFAULT_CONTROLS,
  };
}
