/**
 * 三個 Agent 協作中的「決策 Agent」與「輔助 Agent」(視覺 Agent 仍在 explorationRunner 的 decide())。
 *
 *   決策 Agent(agent seat,只看文字):定每一步的目標、追蹤測試腳本進度、卡住時換策略、判斷完成 / 建議失敗。
 *   視覺 Agent(vlm seat,唯一看截圖):描述畫面、照目標給動作與座標;畫面跟目標不符時先處理眼前畫面。
 *   輔助 Agent(subagent seat,只看文字、最便宜):判斷上一步有沒有生效、整理畫面上的數值、
 *                                              整理歷史摘要、核對「完成」宣告。
 *
 * 每一步的時序:
 *   1. 截圖 → 視覺 Agent:描述畫面、列出「可操作元件清單」(編號 + 座標)、讀出數字,並給一個建議動作。
 *   2. 決策 Agent:看描述 + 元件清單 + 腳本進度 + 歷史,選「做什麼動作、操作哪個編號的元件」。
 *      座標一律取自元件清單(決策 Agent 看不到圖,不自己給座標)。
 *   3. runner 執行。
 *   4. 輔助 Agent(背景,在等畫面穩定的時間裡):用下一步的畫面描述判斷這一步有沒有生效、整理數值。
 * 決策 Agent 根據「這一步」的畫面做決定,不會晚一步。
 *
 * 設計原則(所有遊戲類型通用,不寫死任何單一遊戲):
 *   - 操作方式(搖桿/長按/雙指…)以測試腳本勾選的操作行為為準;目標只描述「要做什麼、對哪個元件」,不給座標。
 *   - 持續性玩法(自動旋轉、戰鬥走位、賽車、節奏、放置、過場)可以用同一個目標維持多步。
 *   - 任何一個呼叫失敗 / 逾時 / 回應無法解析 → 回 null,runner 退回只用視覺 Agent(測試不中斷)。
 *   - 判定失敗、提早結束的權限仍在 runner 的規則;決策 Agent 只能「建議失敗」(記在步驟裡)。
 */

const DECIDE_MAX_TOKENS = 500;
const REVIEW_MAX_TOKENS = 500;
const DONE_MAX_TOKENS = 250;
const SUMMARY_EVERY = 10;
const HISTORY_KEEP = 8;
const CALL_TIMEOUT_MS = 20_000;

/** 從模型文字裡抓第一個 JSON 物件(容忍 ```json 圍欄與前後說明);失敗回 null。 */
export function parseJsonObject(text) {
  const s = String(text ?? '').replace(/```(?:json)?/gi, '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

/** 測試腳本 → 編號步驟(支援「1.」「1、」「1)」「- 」;沒有編號則整段一步)。 */
export function scriptSteps(task) {
  const lines = String(task ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const re = /^(?:\d+\s*[.、)\]]|[-•*])\s*/;
  if (lines.filter((l) => re.test(l)).length >= 2) {
    const out = [];
    for (const l of lines) {
      if (re.test(l)) out.push(l.replace(re, ''));
      else if (out.length) out[out.length - 1] += ` ${l}`;
    }
    return out;
  }
  return lines.length ? [lines.join(' ')] : [];
}

const clip = (v, n) => {
  const s = typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};
const str = (v, n = 200) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

/** 數值狀態正規化:只留 key=snake_case、值為數字或短字串;最多 20 個。 */
export function normalizeFacts(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) {
    const key = String(k).trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
    if (!key) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
    else if (typeof v === 'string' && v.trim()) {
      const n = Number(v.replace(/[,\s]/g, ''));
      out[key] = Number.isFinite(n) && /^[-+]?[\d,.\s]+$/.test(v.trim()) ? n : v.trim().slice(0, 60);
    } else if (typeof v === 'boolean') out[key] = v;
    if (Object.keys(out).length >= 20) break;
  }
  return out;
}

const EFFECTS = new Set(['ok', 'no_effect', 'unexpected', 'unknown']);

/** 兩份數值裡「兩邊都有、且數字不同」的 key(進度、讀取比例這類與動作無關的略過)。 */
export function changedFacts(prev, next) {
  const skip = /loading|progress|percent|timer|time_left|countdown/;
  return Object.keys(next).filter((k) => !skip.test(k)
    && typeof prev?.[k] === 'number' && typeof next[k] === 'number' && prev[k] !== next[k]);
}

const DECIDE_SYSTEM = `你是遊戲自動化測試的「決策 Agent」。你看不到畫面;「視覺 Agent」剛看完這一步的截圖,給你畫面描述和「可操作元件清單」(每個元件有編號)。
你的工作:決定這一步要做什麼動作、操作哪個元件,並追蹤測試腳本的進度。

規則(適用所有遊戲類型):
1. 依測試腳本的順序推進;已完成的步驟不要重做。記錄目前在第幾步(scriptStep,從 1 開始)。
2. 畫面上有彈窗、公告、教學提示、獎勵領取時,先處理它再回到腳本;教學有手指或箭頭時照它指的做。動畫還在播放時先 wait,播完再點。
3. 載入、過場、開場動畫:wait。
4. 持續性的玩法(自動旋轉、戰鬥走位、跑酷、賽車、節奏、放置)照遊戲需要持續操作或 wait 觀察,不必每步換做法。
5. 上一步沒有效果時(畫面沒變、輔助 Agent 判斷 no_effect):同一個做法失敗 2 次就換(換元件、等動畫播完、back、換方向、換區域),不要一直重複。
6. 只能用「可用動作」清單裡的動作,並配合這款遊戲的操作方式。
7. 要點的東西一定要用元件清單裡的編號(element);清單裡沒有你要的元件時,採用視覺 Agent 的建議動作(action 填 "vision")。
8. 視覺 Agent 也會給一個建議動作;合理就可以採用,但你要依腳本進度與歷史判斷,不必照單全收。
9. 不進行真實付費、不輸入真實個人資料。
10. 腳本要求的事全部完成且畫面有證據時才用 done;明顯完全無法繼續(例如必要的登入服務不存在)時 suggestFail=true 並說明 —— 只是建議,不會直接結束測試。
11. 測試人員的即時指令最優先。
12. expect 寫「幾秒後還看得到的結果」(例如餘額或次數改變、出現結算、進入某個畫面、彈窗消失),不要寫短暫的動畫(例如「轉輪開始轉動」),因為下一張截圖是幾秒後才拍的。

動作欄位:
- tap / hold:element(hold 另給 holdMs)
- swipe:element 起點 + toElement 終點,或 element + dir;可給 durationMs(快滑 150~300、拖曳 600~1200)
- move(搖桿):dir(up/down/left/right/upleft/upright/downleft/downright)+ holdMs;清單有搖桿時 element 填搖桿
- combo(邊移動邊按):dir + holdMs + tapElement(右手要點的按鈕)+ taps
- type:text(先 tap 輸入框);wait:duration(秒);back;launch(重開遊戲);done
- vision:採用視覺 Agent 的建議動作

只輸出 JSON:
{"action":"tap","element":1,"toElement":null,"tapElement":null,"dir":"","holdMs":null,"durationMs":null,"duration":null,"text":"","taps":null,"goal":"這一步要做的事(30 字內)","expect":"做完後畫面應該出現什麼(30 字內)","scriptStep":1,"strategy":"為什麼這樣做 / 換了什麼方法(40 字內)","suggestFail":false,"reason":""}`;

/** 視覺 Agent 要額外回報的欄位(附加在視覺 Agent 的系統提示後面)。 */
export const VISION_ELEMENTS_NOTE = `

【給決策 Agent 的畫面資訊|每步必填】除了你原本的欄位(其中 "screen" 畫面名稱一樣每步必填,記憶地圖靠它記錄流程),同一個 JSON 另外加:
"seen":"一句話描述畫面,開頭先寫畫面種類再接冒號(例:「大廳:中央有機台清單…」),再寫有沒有彈窗/動畫、看得到的重要數字";
"elements":[{"id":1,"label":"元件上的文字或簡稱","x":<像素>,"y":<像素>,"kind":"button|close|tab|item|input|joystick|area"}]
—— 列出畫面上所有可以操作的元件(最多 12 個,重要的先列;座標是元件正中心,規則同 x/y)。決策 Agent 會依這份清單決定操作哪一個;你原本的 action 是給它的建議。`;

/**
 * 視覺模型漏給 screen 時,從 seen 推出畫面名(取第一個冒號/逗號前的片段,如「登入畫面:中央有 PLAY…」→「登入畫面」)。
 * 2026-10-10:Kimi K3 在團隊模式前 18 步都沒給 screen,runner 補成「畫面 N」佔位名,
 * 記憶地圖丟掉佔位畫面 → 登入/大廳/選機台整段消失,圖從轉軸畫面開始。推不出來回空字串。
 */
export function screenFromSeen(seen) {
  const s = String(seen ?? '').trim();
  if (!s) return '';
  const head = s.split(/[::,,。;;\n]/)[0].trim();
  if (!head || head.length > 24) return '';
  return head;
}

const ACTIONS_NEED_ELEMENT = new Set(['tap', 'hold', 'swipe']);
const DIR_RE = /^(up|down|left|right|upleft|upright|downleft|downright)$/;

/** 視覺 Agent 的元件清單正規化(座標夾在畫面內,最多 15 個)。 */
export function normalizeElements(raw, cw, ch) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const [k, e] of raw.entries()) {
    if (!e || typeof e !== 'object') continue;
    const x = Number(e.x);
    const y = Number(e.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const id = Number.isFinite(Number(e.id)) ? Number(e.id) : k + 1;
    out.push({
      id,
      label: str(e.label, 40) || `#${id}`,
      x: Math.max(0, Math.min(cw, Math.round(x))),
      y: Math.max(0, Math.min(ch, Math.round(y))),
      ...(str(e.kind, 12) ? { kind: str(e.kind, 12) } : {}),
    });
    if (out.length >= 15) break;
  }
  return out;
}

/**
 * 決策 → 可執行的動作(座標取自元件清單)。回 null = 無法執行(退回視覺 Agent 的建議)。
 * @param {object} d 決策 Agent 的 JSON
 * @param {Array<{id:number,label:string,x:number,y:number,kind?:string}>} elements
 * @param {{cw:number, ch:number}} dims
 */
export function decisionToCommand(d, elements, { cw, ch }) {
  const action = str(d?.action, 12).toLowerCase();
  if (!action || action === 'vision') return null;
  const byId = (id) => (id == null || id === '' ? undefined : elements.find((e) => e.id === Number(id)));
  const el = byId(d.element);
  if (ACTIONS_NEED_ELEMENT.has(action) && !el) return null;
  const dir = DIR_RE.test(str(d.dir, 12).toLowerCase()) ? str(d.dir, 12).toLowerCase() : '';
  const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : undefined);
  const cmd = { action, ...(el ? { target: el.label } : {}) };
  switch (action) {
    case 'tap':
      Object.assign(cmd, { x: el.x, y: el.y });
      break;
    case 'hold':
      Object.assign(cmd, { x: el.x, y: el.y, ...(num(d.holdMs) ? { holdMs: num(d.holdMs) } : {}) });
      break;
    case 'swipe': {
      const to = byId(d.toElement);
      let x2;
      let y2;
      if (to) { x2 = to.x; y2 = to.y; } else if (dir) {
        const mag = Math.round(Math.min(cw, ch) * 0.25);
        x2 = el.x + (dir.includes('left') ? -mag : dir.includes('right') ? mag : 0);
        y2 = el.y + (dir.includes('up') ? -mag : dir.includes('down') ? mag : 0);
      } else return null;
      Object.assign(cmd, {
        x: el.x, y: el.y,
        x2: Math.max(0, Math.min(cw, x2)), y2: Math.max(0, Math.min(ch, y2)),
        ...(num(d.durationMs) ? { durationMs: num(d.durationMs) } : {}),
      });
      break;
    }
    case 'move':
      if (!dir) return null;
      Object.assign(cmd, { dir, ...(el ? { x: el.x, y: el.y } : {}), ...(num(d.holdMs) ? { holdMs: num(d.holdMs) } : {}) });
      break;
    case 'combo': {
      const tapEl = byId(d.tapElement);
      Object.assign(cmd, {
        ...(dir ? { dir } : {}),
        ...(el ? { x: el.x, y: el.y } : {}),
        ...(tapEl ? { tx: tapEl.x, ty: tapEl.y } : {}),
        ...(num(d.holdMs) ? { holdMs: num(d.holdMs) } : {}),
        ...(num(d.taps) ? { taps: num(d.taps) } : {}),
      });
      break;
    }
    case 'pinch':
      Object.assign(cmd, { ...(el ? { x: el.x, y: el.y } : {}), scale: str(d.scale, 4) === 'in' ? 'in' : 'out' });
      break;
    case 'type':
      if (!str(d.text, 200)) return null;
      cmd.text = str(d.text, 200);
      break;
    case 'wait':
      cmd.duration = Math.max(1, Math.min(10, num(d.duration) ?? 3));
      break;
    case 'back':
    case 'launch':
    case 'done':
      break;
    default:
      return null;
  }
  return cmd;
}

const REVIEW_SYSTEM = `你是遊戲自動化測試的「輔助 Agent」。你看不到畫面,只讀「視覺 Agent」對畫面的文字描述。
重要:現在的截圖是在動作送出「幾秒之後」才拍的。轉輪轉動、過場、按鈕閃光這類短暫動畫多半已經播完,看不到是正常的。
判斷要看「結果」:數字有變(餘額、分數、次數、計數器、關卡…)、出現新的結果或新畫面、彈窗已關閉,就是有效。
「像素比對沒變化」不可靠:同一個版面的畫面(老虎機轉軸、棋盤、選單)結果不同時像素也常常很像,只能當參考,不能單獨據此判 no_effect。
工作:
1. 判斷「上一步的動作」有沒有達到預期:effect = ok(有結果)| no_effect(描述與數字都顯示完全沒變)| unexpected(跑到別的畫面 / 出現意外彈窗)| unknown(資訊不足)。
2. 從描述中整理畫面上看得到的數值狀態 facts(例如餘額、分數、金幣、等級、血量、關卡、波次、剩餘次數、倒數時間、投注),key 用英文 snake_case,值用數字;看不到就不要寫,不要猜。
3. 跟「上一次的數值」比對,找出不合理的地方 issues(例如數字突然大幅改變卻沒有對應的事件、同一個值前後矛盾、讀數格式怪異),用一句話說明;沒有就給空陣列。
只輸出 JSON:{"effect":"ok|no_effect|unexpected|unknown","note":"一句話說明判斷依據(40 字內)","facts":{},"issues":[]}`;

const DONE_SYSTEM = `你是遊戲自動化測試的「輔助 Agent」,負責核對「測試完成」的宣告是否有證據。
看測試腳本、目前進度、最近步驟與最後的畫面描述:腳本要求的每一件事都有對應的畫面證據才算完成。
載入中、過場、只完成一部分、只是「看起來差不多」都不算完成。
只輸出 JSON:{"ok":true|false,"missing":"還缺什麼(沒有就空字串,40 字內)"}`;

const SUMMARY_SYSTEM = `你是遊戲自動化測試的「輔助 Agent」。把以下步驟紀錄整理成 5 行以內的進度摘要(做過什麼、走到哪、遇過哪些阻礙、哪些方法無效),給決策 Agent 參考。只輸出摘要文字。`;

/**
 * @param {object} o
 * @param {{send(cmd:any):Promise<any>}} o.bedrock
 * @param {new (input:any)=>any} o.ConverseCommand
 * @param {string} o.agentModel 決策 Agent 模型(空 = 不啟用決策)
 * @param {string} o.subagentModel 輔助 Agent 模型(空 = 不啟用輔助)
 * @param {string} o.task 測試腳本原文
 * @param {string} [o.controlsPrompt] 操作方式段落(engine 組好的)
 * @param {string} [o.knowledge] 遊戲類型知識(會截短)
 * @param {(key:string, body:string, type:string)=>Promise<unknown>} o.put
 * @param {string} o.prefix 任務前綴(jobs/<id>)
 */
export function createAgentTeam({
  bedrock, ConverseCommand, agentModel, subagentModel, task, controlsPrompt = '', knowledge = '',
  put, prefix, log = () => {}, timeoutMs = CALL_TIMEOUT_MS,
}) {
  const steps = scriptSteps(task);
  const tokens = { agent: { input: 0, output: 0 }, subagent: { input: 0, output: 0 } };
  const noSampling = new Set();
  const history = []; // { i, screen, action, goal, effect }
  let summary = '';
  let plan = null; // 最近一次決策(目標 / 預期 / 實際動作)
  let lastReview = null; // 輔助 Agent 最近一次判斷
  let facts = {};
  let scriptStep = 1;
  let failStreak = { agent: 0, subagent: 0 };
  const knowledgeBrief = String(knowledge || '').slice(0, 2500);

  const enabled = { agent: Boolean(agentModel), subagent: Boolean(subagentModel) };

  async function call(seat, system, user, maxTokens, traceIndex, traceTag) {
    const modelId = seat === 'agent' ? agentModel : subagentModel;
    if (!modelId || failStreak[seat] >= 5) return null;
    const t0 = Date.now();
    const send = (withSampling) => bedrock.send(new ConverseCommand({
      modelId,
      system: [{ text: system }],
      messages: [{ role: 'user', content: [{ text: user }] }],
      inferenceConfig: withSampling ? { maxTokens, temperature: 0.2, topP: 0.9 } : { maxTokens },
    }));
    const withTimeout = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(`逾時 ${timeoutMs}ms`), { name: 'Timeout' })), timeoutMs))]);
    let rawText = '';
    let usage = null;
    let error = null;
    try {
      let res;
      if (noSampling.has(modelId)) res = await withTimeout(send(false));
      else {
        try { res = await withTimeout(send(true)); }
        catch (e) {
          if (!/temperature|top_?p/i.test(String(e?.message || ''))) throw e;
          noSampling.add(modelId);
          res = await withTimeout(send(false));
        }
      }
      rawText = res?.output?.message?.content?.map((c) => c.text).filter(Boolean).join('\n') ?? '';
      if (res?.usage) {
        usage = { input: res.usage.inputTokens ?? 0, output: res.usage.outputTokens ?? 0 };
        tokens[seat].input += usage.input;
        tokens[seat].output += usage.output;
      }
      failStreak[seat] = 0;
    } catch (e) {
      error = { name: String(e?.name || 'Error'), message: String(e?.message || e).slice(0, 500) };
      failStreak[seat]++;
      log(`[${seat}] 呼叫失敗(${failStreak[seat]}):${error.message}`);
    }
    // 每個 Agent 每一步一筆互動紀錄(任務詳情頁「日誌檢視」)。不等上傳完成(決策在關鍵路徑上)。
    void put(`${prefix}/traces/${traceIndex}-${traceTag}.json`, JSON.stringify({
      index: traceIndex,
      seat,
      modelId,
      channel: 'bedrock-converse',
      ok: !error,
      request: { turnText: user.slice(0, 6000), imageCount: 0, messageTurns: 1, systemChars: system.length },
      rawResponse: rawText,
      ...(usage ? { tokens: usage } : {}),
      ...(error ? { error } : {}),
      ms: Date.now() - t0,
      at: new Date(t0).toISOString(),
    }), 'application/json').catch(() => {});
    if (error) return null;
    return parseJsonObject(rawText) ?? (traceTag === 'summary' ? { text: rawText } : null);
  }

  const historyText = () => history.slice(-HISTORY_KEEP)
    .map((h) => `#${h.i} [${h.screen || '?'}] ${h.action}${h.goal ? ` · 目標:${h.goal}` : ''}${h.effect ? ` · 效果:${h.effect}` : ''}`)
    .join('\n') || '(尚無)';
  const factsText = () => (Object.keys(facts).length ? JSON.stringify(facts) : '(尚無)');
  const scriptText = () => (steps.length ? steps.map((s, k) => `${k + 1}. ${s}`).join('\n') : String(task || '').slice(0, 2000));

  return {
    enabled,
    get plan() { return plan; },
    get facts() { return facts; },
    get scriptStep() { return scriptStep; },
    get scriptTotal() { return steps.length; },
    tokens,

    /**
     * 決策 Agent:看視覺 Agent 這一步的畫面描述與元件清單,決定這一步的動作。
     * 回 { decision, cmd } —— cmd 為可執行動作(座標取自元件清單);cmd=null 代表採用視覺 Agent 的建議。
     * 整個回 null = 決策 Agent 不可用(呼叫失敗 / 逾時 / 回應無法解析),runner 退回視覺 Agent 的建議。
     * @param {object} c
     * @param {number} c.index 這一步
     * @param {{screen?:string, seen?:string, thinking?:string, obs?:any}} c.observation 視覺 Agent 的描述
     * @param {Array<{id:number,label:string,x:number,y:number,kind?:string}>} c.elements 可操作元件
     * @param {{action?:string, target?:string, dir?:string}} c.suggestion 視覺 Agent 的建議動作
     * @param {boolean|undefined} c.screenChanged 截圖相對上一步有沒有可見變化
     * @param {string[]} c.allowedActions 可用動作
     * @param {{cw:number, ch:number}} c.dims 截圖尺寸(元件座標空間)
     * @param {string[]} [c.operator] 測試人員的即時指令
     * @param {string} [c.runnerNote] runner 的狀態提示
     */
    async decideAction({ index, observation, elements, suggestion, screenChanged, allowedActions, dims, operator = [], runnerNote = '' }) {
      if (!enabled.agent) return null;
      const elText = elements.length
        ? elements.map((e) => `[${e.id}] ${e.label}${e.kind ? `(${e.kind})` : ''}`).join('\n')
        : '(視覺 Agent 沒有列出元件)';
      const sug = suggestion?.action ? `${suggestion.action}${suggestion.target ? ` → ${suggestion.target}` : ''}${suggestion.dir ? ` dir=${suggestion.dir}` : ''}` : '—';
      const user = [
        `【測試腳本】\n${scriptText()}`,
        `【目前進度】腳本第 ${scriptStep} / ${Math.max(1, steps.length)} 步`,
        plan ? `【上一步】動作:${plan.actionText || '—'};目標:${plan.goal}(預期:${plan.expect || '—'})` : '',
        `【像素比對】這張截圖跟上一步${screenChanged === false ? '幾乎沒有變化' : screenChanged === true ? '有可見變化' : '無法比對'}`,
        lastReview ? `【輔助 Agent 判斷(較早一步)】效果:${lastReview.effect}${lastReview.note ? `(${lastReview.note})` : ''}${lastReview.issues?.length ? `;疑點:${lastReview.issues.join(';')}` : ''}` : '',
        `【視覺 Agent 看到的畫面】${str(observation?.screen, 60) || '?'}:${clip(observation?.seen || observation?.thinking, 500)}${observation?.obs ? `\n畫面數值:${clip(observation.obs, 300)}` : ''}`,
        `【可操作元件】\n${elText}`,
        `【視覺 Agent 的建議動作】${sug}`,
        `【可用動作】${allowedActions?.length ? allowedActions.join(' / ') : 'tap / swipe / back / type / wait / launch / done'}`,
        `【畫面數值(累計)】${factsText()}`,
        summary ? `【進度摘要】\n${summary}` : '',
        `【最近步驟】\n${historyText()}`,
        operator.length ? `【測試人員即時指令(最優先)】\n${operator.map((t) => `- ${t}`).join('\n')}` : '',
        runnerNote ? `【系統狀態】${runnerNote}` : '',
        controlsPrompt ? `【這款遊戲的操作方式】\n${controlsPrompt}` : '',
        knowledgeBrief ? `【遊戲類型背景知識(參考)】\n${knowledgeBrief}` : '',
      ].filter(Boolean).join('\n\n');
      const r = await call('agent', DECIDE_SYSTEM, user, DECIDE_MAX_TOKENS, index, 'agent');
      if (!r || !str(r.action, 12)) return null;
      let cmd = decisionToCommand(r, elements, dims);
      if (cmd && allowedActions?.length && !allowedActions.includes(cmd.action)) cmd = null;
      const n = Number(r.scriptStep);
      if (Number.isFinite(n) && n >= 1) scriptStep = Math.min(Math.round(n), Math.max(1, steps.length));
      const goal = str(r.goal, 160) || (cmd?.target ? `${cmd.action} ${cmd.target}` : '');
      plan = {
        forStep: index,
        goal,
        expect: str(r.expect, 120),
        scriptStep,
        strategy: str(r.strategy, 160),
        suggestFail: r.suggestFail === true,
        reason: str(r.reason, 200),
        actionText: cmd ? `${cmd.action}${cmd.target ? ` → ${cmd.target}` : ''}${cmd.dir ? ` dir=${cmd.dir}` : ''}` : `採用視覺建議:${sug}`,
      };
      return { decision: plan, cmd };
    },

    /**
     * 輔助 Agent:用第 index 步的畫面描述,判斷上一步動作有沒有生效、整理數值。
     * @param {object} c
     * @param {number} c.index 目前這一步(其畫面描述 = 上一步動作的結果)
     * @param {string} c.prevAction 上一步實際送出的動作
     * @param {{goal?:string, expect?:string}|null} c.prevPlan 上一步的目標
     * @param {{screen?:string, thinking?:string, obs?:any}} c.observation 這一步視覺 Agent 的描述
     * @param {boolean|undefined} c.screenChanged 截圖相對上一步有沒有可見變化(像素比對)
     */
    async review({ index, prevAction, prevPlan, observation, screenChanged }) {
      if (!enabled.subagent) return null;
      const user = [
        `【上一步的目標】${prevPlan?.goal || '(沒有目標,視覺 Agent 自行決定)'}`,
        `【上一步的預期】${prevPlan?.expect || '—'}`,
        `【上一步實際動作】${prevAction || '—'}`,
        `【像素比對】截圖${screenChanged === false ? '幾乎沒有變化' : screenChanged === true ? '有可見變化' : '無法比對'}`,
        `【現在的畫面(視覺 Agent 描述)】${str(observation?.screen, 60) || '?'}:${clip(observation?.thinking, 500)}`,
        observation?.obs ? `【視覺 Agent 回報的數值】${clip(observation.obs, 400)}` : '',
        `【上一次的數值】${factsText()}`,
      ].filter(Boolean).join('\n');
      const r = await call('subagent', REVIEW_SYSTEM, user, REVIEW_MAX_TOKENS, index, 'subagent');
      if (!r) return null;
      let effect = EFFECTS.has(r.effect) ? r.effect : 'unknown';
      const newFacts = normalizeFacts(r.facts);
      const prevFacts = facts;
      // 確定性檢查:畫面上的數字有變,就不是「沒有反應」(模型常被「預期的動畫沒看到」或像素比對誤導)。
      const current = { ...normalizeFacts(observation?.obs), ...newFacts };
      const changed = changedFacts(prevFacts, current);
      let note = str(r.note, 160);
      if (effect === 'no_effect' && changed.length) {
        effect = 'ok';
        note = `數值有變化(${changed.slice(0, 3).join('、')})`;
      }
      facts = { ...facts, ...current };
      const issues = Array.isArray(r.issues) ? r.issues.map((x) => str(x, 160)).filter(Boolean).slice(0, 5) : [];
      lastReview = { effect, note, issues };
      return { effect, note, facts: newFacts, prevFacts, issues };
    },

    /** 記錄這一步(給歷史 / 摘要用)。 */
    record({ index, screen, action, effect }) {
      history.push({ i: index, screen: str(screen, 40), action: str(action, 60), goal: plan?.forStep === index ? plan.goal : '', effect: effect || '' });
      if (history.length > 60) history.splice(0, history.length - 60);
    },

    /** 輔助 Agent:每 SUMMARY_EVERY 步整理一次進度摘要(長測試不會越跑越亂)。 */
    async maybeSummarize(index) {
      if (!enabled.subagent || index === 0 || index % SUMMARY_EVERY !== 0) return;
      const recent = history.slice(-SUMMARY_EVERY * 2)
        .map((h) => `#${h.i} [${h.screen}] ${h.action}${h.goal ? ` 目標:${h.goal}` : ''}${h.effect ? ` 效果:${h.effect}` : ''}`).join('\n');
      const user = `【測試腳本】\n${scriptText()}\n\n【先前摘要】\n${summary || '(無)'}\n\n【最近步驟】\n${recent}\n\n【畫面數值】${factsText()}`;
      const r = await call('subagent', SUMMARY_SYSTEM, user, 400, index, 'summary');
      const text = str(r?.text ?? r?.summary, 800);
      if (text) summary = text;
    },

    /**
     * 輔助 Agent:核對「完成」宣告。回 { ok, missing } 或 null(無法核對 → 交給 runner 原本規則)。
     * @param {object} c
     * @param {number} c.index
     * @param {{screen?:string, thinking?:string, obs?:any}} c.observation
     */
    async verifyDone({ index, observation }) {
      if (!enabled.subagent) return null;
      const user = [
        `【測試腳本】\n${scriptText()}`,
        `【目前進度】腳本第 ${scriptStep} / ${Math.max(1, steps.length)} 步`,
        summary ? `【進度摘要】\n${summary}` : '',
        `【最近步驟】\n${historyText()}`,
        `【畫面數值】${factsText()}`,
        `【視覺 Agent 宣告完成時的畫面】${str(observation?.screen, 60) || '?'}:${clip(observation?.thinking, 500)}`,
      ].filter(Boolean).join('\n\n');
      const r = await call('subagent', DONE_SYSTEM, user, DONE_MAX_TOKENS, index, 'subagent-done');
      if (!r || typeof r.ok !== 'boolean') return null;
      return { ok: r.ok, missing: str(r.missing, 160) };
    },
  };
}
