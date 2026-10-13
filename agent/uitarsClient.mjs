/**
 * UI-TARS-1.5-7B 定位客戶端(SageMaker real-time endpoint)。
 * 移植自 game-ai-qa/src/agents/operator/llm/uitars.ts + uitarsPrompt.ts,適配 explorationRunner 的迴圈。
 *
 * 與 Bedrock decide() 對齊的介面:decideUitars(system, messages, ctx) → { cmd, usage, rawText, trace }
 *   cmd = { action, x, y, x2, y2, text, screen, thinking }  座標在「送出圖的 smart-resize 幀 cw×ch 像素」
 *          —— explorationRunner 已在此空間做落點標記,並自行換算 cw×ch → 裝置像素,故這裡不再正規化。
 *
 * 關鍵決策(忠於參考):
 *   - 單張圖(single-frame):UI-TARS 只看當前這張圖並在其座標幀吐絕對像素;多圖會混淆座標基準。
 *   - 圖已由 runner 預縮到 smart-resize 尺寸(cw×ch),這裡直接送,不再 resize。
 *   - UI-TARS action-space prompt(MOBILE_USE_DOUBAO,移除 open_app);先前動作以文字附在 instruction。
 *   - payload = OpenAI chat-completions 形態(system + user[image_url]),endpoint 內 vLLM 相容。
 */
import { SageMakerRuntimeClient, InvokeEndpointCommand } from '@aws-sdk/client-sagemaker-runtime';
import * as OpenCC from 'opencc-js';

const ENDPOINT = process.env.PA_UITARS_ENDPOINT || '';
const REGION = process.env.PA_DATA_REGION || process.env.AWS_REGION || 'us-west-2';
// 語言:預設繁體中文(Traditional Chinese);設 PA_UITARS_LANG=en 才用英文。
// 講明「Traditional Chinese(繁體中文)」而非只寫 Chinese,先在 prompt 引導。
const LANG = (process.env.PA_UITARS_LANG === 'en') ? 'English' : 'Traditional Chinese (繁體中文)';

// UI-TARS 是簡體語料微調的模型,即使 prompt 要求繁中仍常吐簡體。故對「給人看的文字」
// (thinking / screen)做確定性的簡→繁轉換(OpenCC 純 JS,無原生相依);座標/動作不受影響。
// cn→twp:大陸簡體 → 台灣正體(含常用詞彙轉換,如「屏幕→螢幕」「登录→登入」)。
let _s2t = null;
function toTraditional(text) {
  if (LANG === 'English') return text;
  if (typeof text !== 'string' || text.length === 0) return text;
  try {
    if (!_s2t) _s2t = OpenCC.Converter({ from: 'cn', to: 'twp' });
    return _s2t(text);
  } catch {
    return text; // 轉換失敗不擋流程,回原文
  }
}

let _client = null;
function client() {
  if (!_client) {
    _client = new SageMakerRuntimeClient({ region: REGION, maxAttempts: 2, requestHandler: { requestTimeout: 120_000 } });
  }
  return _client;
}

export function uitarsEnabled() {
  return ENDPOINT.length > 0;
}

/** UI-TARS-1.5 官方 MOBILE_USE_DOUBAO(移除 open_app);{language}/{instruction} 由呼叫端代入。 */
const MOBILE_USE_DOUBAO = `You are a GUI agent. You are given a task and your action history, with screenshots. You need to perform the next action to complete the task.

## Output Format
\`\`\`
Thought: ...
Action: ...
\`\`\`

## Action Space
click(point='<point>x1 y1</point>')
long_press(point='<point>x1 y1</point>')
type(content='') #If you want to submit your input, use "\\n" at the end of \`content\`.
scroll(point='<point>x1 y1</point>', direction='down or up or right or left')
drag(start_point='<point>x1 y1</point>', end_point='<point>x2 y2</point>')
press_home()
press_back()
finished(content='xxx')

## Note
- Use {language} in \`Thought\` part. IMPORTANT: when the language is Traditional Chinese (繁體中文), always write in Traditional Chinese characters only — never use Simplified Chinese (简体) characters.
- Write a small plan and finally summarize your next action (with its target element) in one sentence in \`Thought\` part.

## User Instruction
{instruction}`;

function buildMobilePrompt(instruction, language = 'Traditional Chinese (繁體中文)') {
  return MOBILE_USE_DOUBAO.replace('{language}', language).replace('{instruction}', instruction);
}

export function parseThoughtAction(text) {
  const tMatch = text.match(/Thought:\s*([\s\S]*?)(?=\n\s*Action:|$)/);
  const aMatch = text.match(/Action:\s*([\s\S]+?)(?=\n\s*$|$)/);
  return { thinking: tMatch?.[1]?.trim() ?? '', actionLine: aMatch?.[1]?.trim() ?? '' };
}

/** 從 UI-TARS 各種座標寫法抽單一 (x, y):<point>x y</point> / point='x,y' / start_box='(x,y[,x2,y2])' / 裸 (x,y)。 */
function extractPoint(args) {
  const tag = args.match(/<point>(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)<\/point>/);
  if (tag) return [Math.round(parseFloat(tag[1])), Math.round(parseFloat(tag[2]))];
  const quoted = args.match(/(?:point|start_box|end_box|start_point|end_point)='([^']+)'/);
  if (quoted) {
    const nums = quoted[1].match(/\d+(?:\.\d+)?/g);
    if (nums && nums.length >= 4) {
      return [Math.round((parseFloat(nums[0]) + parseFloat(nums[2])) / 2), Math.round((parseFloat(nums[1]) + parseFloat(nums[3])) / 2)];
    }
    if (nums && nums.length >= 2) return [Math.round(parseFloat(nums[0])), Math.round(parseFloat(nums[1]))];
  }
  const paren = args.match(/\((\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\)/);
  if (paren) return [Math.round(parseFloat(paren[1])), Math.round(parseFloat(paren[2]))];
  return null;
}

function extractAllPoints(args) {
  const out = [];
  const keyed = args.matchAll(/(?:point|start_box|end_box|start_point|end_point)='([^']+)'/g);
  for (const m of keyed) {
    const nums = m[1].match(/\d+(?:\.\d+)?/g);
    if (nums && nums.length >= 4) out.push([Math.round((parseFloat(nums[0]) + parseFloat(nums[2])) / 2), Math.round((parseFloat(nums[1]) + parseFloat(nums[3])) / 2)]);
    else if (nums && nums.length >= 2) out.push([Math.round(parseFloat(nums[0])), Math.round(parseFloat(nums[1]))]);
  }
  if (out.length > 0) return out;
  const re = /<point>(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)<\/point>|\((\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\)/g;
  let m = re.exec(args);
  while (m !== null) {
    if (m[1] !== undefined) out.push([Math.round(parseFloat(m[1])), Math.round(parseFloat(m[2]))]);
    else if (m[3] !== undefined) out.push([Math.round(parseFloat(m[3])), Math.round(parseFloat(m[4]))]);
    m = re.exec(args);
  }
  return out;
}

function extractContent(args) {
  const m = args.match(/content='((?:[^'\\]|\\.)*)'/);
  if (!m) return '';
  return m[1].replace(/\\'/g, "'").replace(/\\n/g, '\n');
}
function extractDirection(args) {
  const m = args.match(/direction='(up|down|left|right)'/);
  return m?.[1] ?? null;
}

/**
 * 把 UI-TARS action 文字轉成 explorationRunner 的 cmd(座標在 cw×ch 像素幀)。
 * UI-TARS scroll 的 direction 是「內容移動方向」,而我們的 swipe 是「手指移動方向」(相反)。
 */
export function parseUitarsToCmd(line, cw, ch, thinking) {
  const clampX = (v) => Math.max(0, Math.min(cw, Math.round(v)));
  const clampY = (v) => Math.max(0, Math.min(ch, Math.round(v)));
  const fn = line.match(/^(\w+)\(([\s\S]*)\)\s*$/);
  if (!fn) return { action: 'wait', thinking: thinking || `無法解析動作:${line}` };
  const name = fn[1];
  const args = fn[2];
  const off = Math.round(ch * 0.2); // scroll 位移量(約 20% 螢幕高)
  switch (name) {
    case 'click': {
      const p = extractPoint(args);
      if (!p) return { action: 'wait', thinking };
      return { action: 'tap', x: clampX(p[0]), y: clampY(p[1]), thinking };
    }
    case 'long_press': {
      const p = extractPoint(args);
      if (!p) return { action: 'wait', thinking };
      return { action: 'tap', x: clampX(p[0]), y: clampY(p[1]), thinking };
    }
    case 'type':
      return { action: 'type', text: extractContent(args), thinking };
    case 'scroll': {
      const p = extractPoint(args);
      const d = extractDirection(args);
      if (!p || !d) return { action: 'wait', thinking };
      const cx = clampX(p[0]);
      const cy = clampY(p[1]);
      // 手指方向與內容方向相反:內容 down → 手指由下往上。
      if (d === 'down') return { action: 'swipe', x: cx, y: clampY(cy + off), x2: cx, y2: clampY(cy - off), thinking };
      if (d === 'up') return { action: 'swipe', x: cx, y: clampY(cy - off), x2: cx, y2: clampY(cy + off), thinking };
      if (d === 'left') return { action: 'swipe', x: clampX(cx - off), y: cy, x2: clampX(cx + off), y2: cy, thinking };
      return { action: 'swipe', x: clampX(cx + off), y: cy, x2: clampX(cx - off), y2: cy, thinking };
    }
    case 'drag': {
      const pts = extractAllPoints(args);
      if (pts.length < 2) return { action: 'wait', thinking };
      return { action: 'swipe', x: clampX(pts[0][0]), y: clampY(pts[0][1]), x2: clampX(pts[1][0]), y2: clampY(pts[1][1]), thinking };
    }
    case 'press_back':
      return { action: 'back', thinking };
    case 'press_home':
      return { action: 'back', thinking }; // runner 無 home 動作,退而用 back
    case 'finished':
      return { action: 'done', thinking: toTraditional(extractContent(args)) || thinking };
    case 'open_app':
      return { action: 'wait', thinking: thinking || 'open_app 不支援(交由執行層)' };
    default:
      return { action: 'wait', thinking: thinking || `未知動作:${name}` };
  }
}

/** 從 runner 的內部 messages 找出最後一張圖(當前畫面)的 base64 與其 media_type。 */
function lastImage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const imgs = (m.content || []).filter((c) => c.type === 'image' && c.source?.data);
    if (imgs.length > 0) return imgs[imgs.length - 1].source;
  }
  return null;
}

/**
 * UI-TARS 決策。與 decide() 同介面。
 * @param instruction 任務目標(TASK)
 * @param messages    runner 的內部 messages(取最後一張圖 + 先前 assistant 動作歷史)
 * @param cw,ch       送出圖的 smart-resize 尺寸(== 模型座標基準)
 */
export async function decideUitars(instruction, messages, cw, ch) {
  const baseTrace = { modelId: 'uitars-1.5-7b', channel: 'sagemaker', request: { endpoint: ENDPOINT, imageCount: 1 } };
  const src = lastImage(messages);
  if (!src) {
    return { cmd: { action: 'wait', thinking: '無畫面可定位' }, usage: null, rawText: '', trace: { ...baseTrace, ok: false, error: { name: 'NoImage', message: 'no image in messages' } } };
  }
  // 先前動作歷史(最近 3 個 assistant 動作),讓單幀模型知道已做過什麼。
  const priorActions = [];
  for (const m of messages) {
    if (m.role === 'assistant') {
      const t = (m.content || []).map((c) => (c.type === 'text' ? c.text : '')).join(' ').trim();
      if (t) priorActions.push(t.slice(0, 160));
    }
  }
  const instr = priorActions.length > 0
    ? `${instruction}\n\nPrevious actions taken:\n${priorActions.slice(-3).map((a, i) => `${i + 1}. ${a}`).join('\n')}`
    : instruction;
  const sysPrompt = buildMobilePrompt(instr, LANG);
  const mediaType = src.media_type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  const payload = {
    messages: [
      { role: 'system', content: sysPrompt },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:${mediaType};base64,${src.data}` } }] },
    ],
    max_tokens: 1024,
    temperature: 0,
  };

  let res;
  try {
    res = await client().send(new InvokeEndpointCommand({
      EndpointName: ENDPOINT, ContentType: 'application/json', Accept: 'application/json', Body: JSON.stringify(payload),
    }));
  } catch (err) {
    const name = err?.name ? String(err.name) : 'Error';
    const message = err?.message ? String(err.message) : String(err);
    return { cmd: { action: 'wait', thinking: `UI-TARS 呼叫失敗:${message}` }, usage: null, rawText: '', trace: { ...baseTrace, ok: false, error: { name, message } } };
  }

  const bodyText = new TextDecoder().decode(res.Body);
  let parsed;
  try { parsed = JSON.parse(bodyText); }
  catch { return { cmd: { action: 'wait', thinking: 'UI-TARS 回應非 JSON' }, usage: null, rawText: bodyText.slice(0, 500), trace: { ...baseTrace, ok: false, error: { name: 'BadResponse', message: bodyText.slice(0, 200) } } }; }

  const text = parsed.generated_text ?? parsed.choices?.[0]?.message?.content ?? '';
  const usage = parsed.usage ? { input: parsed.usage.prompt_tokens, output: parsed.usage.completion_tokens } : null;
  if (typeof text !== 'string' || text.length === 0) {
    return { cmd: { action: 'wait', thinking: 'UI-TARS 回應缺 text' }, usage, rawText: bodyText.slice(0, 500), trace: { ...baseTrace, ok: false, error: { name: 'EmptyText', message: 'missing generated_text/choices' } } };
  }

  const { thinking, actionLine } = parseThoughtAction(text);
  // thinking 給人看:簡→繁轉換(UI-TARS 慣吐簡體)。座標由 actionLine 解析,不受影響。
  const cmd = parseUitarsToCmd(actionLine, cw, ch, toTraditional(thinking));
  return { cmd, usage, rawText: text, trace: { ...baseTrace, ok: true, rawResponse: text, tokens: usage } };
}
