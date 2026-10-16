/**
 * 記憶腳本(前端):操作的可信度、路徑搜尋、匯出 Appium(WebdriverIO)腳本。
 *
 * 可信度規則與 runner 的 agent/reflex.mjs opTrust 相同(改一邊要改另一邊;memoryScript.test.ts 有對照):
 *   停用 > 人工確認 > 自動(成功 ≥ 2 次且沒有失敗)> 學習中。
 */

/** 可重播的操作(0~1 相對座標)。 */
export interface MemOp {
  a: 'tap' | 'swipe' | 'hold' | 'back' | 'type' | 'key' | 'move';
  x?: number;
  y?: number;
  x2?: number;
  y2?: number;
  ms?: number;
  dir?: string;
  key?: string;
  n?: number;
  text?: string;
  ar?: number;
  v?: string;
  at?: string;
}
export interface OpEdit {
  op?: MemOp;
  verified?: boolean;
  disabled?: boolean;
  updatedAt?: string;
}
export interface SelfOp {
  kind: string;
  target: string;
  hitCount: number;
  missCount: number;
  op?: MemOp;
}
export interface ScriptPage {
  id: string;
  name: string;
  transient?: boolean;
  pHash?: string;
  pHashes?: string[];
  aliases?: Record<string, number>;
  selfOps?: SelfOp[];
}
export interface ScriptEdge {
  fromPageId: string;
  toPageId: string;
  trigger?: { kind?: string; label?: string; target?: string };
  hitCount: number;
  missCount: number;
  manual?: boolean;
  op?: MemOp;
}

export type Trust = 'disabled' | 'verified' | 'auto' | 'learning';
export const MIN_HITS = 2;

export function opTrust(e: { hitCount?: number; missCount?: number; manual?: boolean }, edit?: OpEdit): Trust {
  if (edit?.disabled) return 'disabled';
  if (edit?.verified) return 'verified';
  if (e.manual && edit?.op) return 'verified';
  if ((e.hitCount ?? 0) >= MIN_HITS && (e.missCount ?? 0) === 0) return 'auto';
  return 'learning';
}

/** 路徑識別鍵(與後端 / runner 一致)。同畫面操作:from === to。 */
export function opKey(fromPageId: string, toPageId: string, kind: string, target: string | undefined): string {
  return `${fromPageId}>${toPageId}>${kind}>${(target ?? '').trim()}`;
}
export const edgeOpKey = (e: ScriptEdge) => opKey(e.fromPageId, e.toPageId, e.trigger?.kind ?? '', e.trigger?.target);
export const selfOpKey = (pageId: string, s: SelfOp) => opKey(pageId, pageId, s.kind, s.target);

/** 實際要用的操作:人工修正過的優先。 */
export function effectiveOp(recorded: MemOp | undefined, edit?: OpEdit): MemOp | undefined {
  return edit?.op ?? recorded;
}

const PURCHASE_RE = /\$|usd|twd|ntd|nt\$|hkd|jpy|¥|€|£|購買|购买|儲值|储值|付款|付费|付費|buy|purchase|pay\b|checkout|訂閱|订阅|subscribe/i;
const POPUP_RE = /彈窗|弹窗|公告|popup|pop-up|獎勵|奖励|簽到|签到|daily|活動|活动|news|promo|促銷|促销|reward|notice|dialog|提示|教學|教学|tutorial|升級|升级|level\s*up/i;
const SPIN_RE = /spin|旋轉|旋转|轉動|转动/i;

export interface ScriptStep {
  from: { id: string; name: string; hashes: string[] };
  to: { id: string; name: string; hashes: string[] };
  target: string;
  op: MemOp;
  trust: Trust;
}

const hashesOf = (p: ScriptPage | undefined) => [...new Set([p?.pHash, ...(p?.pHashes ?? [])].filter((h): h is string => Boolean(h)))];

/**
 * 從起點到目標畫面的最短路徑(只走有操作細節、沒被停用、不是付費的路徑;可信的優先)。
 * 起點 = rootPageId;沒有就從任何「沒有人走進來」的畫面開始。找不到回 null。
 */
export function findScriptPath(
  pages: Record<string, ScriptPage>,
  edges: ScriptEdge[],
  opEdits: Record<string, OpEdit>,
  targetPageId: string,
  rootPageId?: string | null,
): ScriptStep[] | null {
  const usable = edges
    .map((e) => {
      const edit = opEdits[edgeOpKey(e)];
      const trust = opTrust(e, edit);
      const op = effectiveOp(e.op, edit);
      return { e, op, trust };
    })
    .filter((x) => x.op && x.trust !== 'disabled' && x.op.a === x.e.trigger?.kind && !PURCHASE_RE.test(x.e.trigger?.target ?? ''));
  const starts = rootPageId && pages[rootPageId]
    ? [rootPageId]
    : Object.keys(pages).filter((id) => !edges.some((e) => e.toPageId === id));
  if (starts.includes(targetPageId)) return [];
  // BFS(可信的邊先展開,同樣長度時優先走可信的)。
  const rank = (t: Trust) => (t === 'verified' ? 0 : t === 'auto' ? 1 : 2);
  const prev = new Map<string, (typeof usable)[number]>();
  const seen = new Set(starts);
  let frontier = [...starts];
  while (frontier.length && !seen.has(targetPageId)) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const x of usable.filter((u) => u.e.fromPageId === id).sort((a, b) => rank(a.trust) - rank(b.trust) || b.e.hitCount - a.e.hitCount)) {
        if (seen.has(x.e.toPageId)) continue;
        seen.add(x.e.toPageId);
        prev.set(x.e.toPageId, x);
        next.push(x.e.toPageId);
      }
    }
    frontier = next;
  }
  if (!seen.has(targetPageId)) return null;
  const path: ScriptStep[] = [];
  for (let cur = targetPageId; prev.has(cur);) {
    const x = prev.get(cur)!;
    const from = pages[x.e.fromPageId];
    const to = pages[x.e.toPageId];
    path.unshift({
      from: { id: x.e.fromPageId, name: from?.name ?? x.e.fromPageId, hashes: hashesOf(from) },
      to: { id: x.e.toPageId, name: to?.name ?? x.e.toPageId, hashes: hashesOf(to) },
      target: x.e.trigger?.target ?? '',
      op: x.op!,
      trust: x.trust,
    });
    cur = x.e.fromPageId;
  }
  return path;
}

/** 已知彈窗的關閉方式(腳本執行中遇到就照做)。 */
export function popupHandlers(pages: Record<string, ScriptPage>, edges: ScriptEdge[], opEdits: Record<string, OpEdit>) {
  return edges
    .filter((e) => {
      const p = pages[e.fromPageId];
      return p && !p.transient && (POPUP_RE.test(p.name) || Object.keys(p.aliases ?? {}).some((n) => POPUP_RE.test(n)));
    })
    .map((e) => ({ e, edit: opEdits[edgeOpKey(e)] }))
    .map(({ e, edit }) => ({ e, op: effectiveOp(e.op, edit), trust: opTrust(e, edit) }))
    .filter((x) => x.op && x.op.a === x.e.trigger?.kind && (x.trust === 'verified' || x.trust === 'auto') && !PURCHASE_RE.test(x.e.trigger?.target ?? ''))
    .map((x) => ({ page: { id: x.e.fromPageId, name: pages[x.e.fromPageId]!.name, hashes: hashesOf(pages[x.e.fromPageId]) }, target: x.e.trigger?.target ?? '', op: x.op! }));
}

/** 目標畫面上的 SPIN 操作(匯出腳本的 --spins 用)。 */
export function spinOpOf(page: ScriptPage | undefined, opEdits: Record<string, OpEdit>) {
  if (!page) return null;
  for (const s of page.selfOps ?? []) {
    if (!SPIN_RE.test(s.target) || /auto|free|免費|免费/i.test(s.target)) continue;
    const edit = opEdits[selfOpKey(page.id, s)];
    const op = effectiveOp(s.op, edit);
    if (op && opTrust(s, edit) !== 'disabled') return { target: s.target, op };
  }
  return null;
}

const safeName = (s: string) => s.replace(/[^\w\u4e00-\u9fff-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'screen';
export const exportFileName = (appId: string, pageName: string) => `playagent-${safeName(appId)}-${safeName(pageName)}.mjs`;

/**
 * 產生可在本機執行的 WebdriverIO(Appium)腳本:照記憶走到目標畫面,途中遇到已知彈窗就關掉;
 * 每一步先用畫面指紋確認在對的畫面才點(認不出就停下來並說明卡在哪)。
 */
export function generateAppiumScript(opts: {
  appId: string;
  appName?: string;
  steps: ScriptStep[];
  target: { id: string; name: string; hashes: string[] };
  handlers: ReturnType<typeof popupHandlers>;
  spin: ReturnType<typeof spinOpOf>;
  generatedAt?: string;
}): string {
  const data = {
    appId: opts.appId,
    appName: opts.appName ?? opts.appId,
    target: opts.target,
    steps: opts.steps.map((s) => ({ from: s.from, to: s.to, target: s.target, op: s.op })),
    handlers: opts.handlers,
    spin: opts.spin,
  };
  const route = [opts.steps[0]?.from.name, ...opts.steps.map((s) => s.to.name)].filter(Boolean).join(' → ') || opts.target.name;
  return `#!/usr/bin/env node
/**
 * PlayAgent Checker — 記憶腳本匯出(Appium / WebdriverIO)
 * App:${data.appName}
 * 路徑:${route}
 * 產生時間:${opts.generatedAt ?? new Date().toISOString()}
 *
 * 安裝(一次):npm i webdriverio@9 sharp@0.33
 * 執行:先啟動 Appium server(appium,需 UiAutomator2 driver)並連好 Android 裝置 / 模擬器,然後
 *   node ${exportFileName(opts.appId, opts.target.name)} --udid <裝置序號> [--package <遊戲包名>] [--activity <啟動 Activity>]
 *        [--server http://127.0.0.1:4723] [--spins 100] [--timeout 60]
 * 帳密:操作裡的 \${key} 會讀環境變數 PA_<key>(例:\${password} → PA_password),腳本不含任何真實帳密。
 * 座標是相對比例(0~1),換解析度也能用;長寬比差很多(例如有黑邊)時位置可能偏掉。
 * 每一步都先比對畫面指紋確認在對的畫面才點;認不出畫面會停下來,告訴你卡在哪一步。
 */
import { remote } from 'webdriverio';
import sharp from 'sharp';

const DATA = ${JSON.stringify(data, null, 2)};

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
const server = new URL(args.server || 'http://127.0.0.1:4723');
const TIMEOUT_MS = (Number(args.timeout) || 60) * 1000;
// 本機用 sharp 算指紋,與雲端 ImageMagick 的結果有些微差異,所以門檻比雲端寬。
const MATCH = Number(args.match) || 70;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) { let x = parseInt(a[i], 16) ^ parseInt(b[i], 16); while (x) { d += x & 1; x >>= 1; } }
  return d;
}
async function fingerprint() {
  const b64 = await driver.takeScreenshot();
  const { data } = await sharp(Buffer.from(b64, 'base64')).resize(32, 32, { fit: 'fill' }).grayscale().raw().toBuffer({ resolveWithObject: true });
  const mean = data.reduce((s, v) => s + v, 0) / data.length;
  let hex = '';
  for (let i = 0; i < data.length; i += 4) {
    let n = 0;
    for (let k = 0; k < 4; k++) n = (n << 1) | (data[i + k] >= mean ? 1 : 0);
    hex += n.toString(16);
  }
  return hex;
}
const distTo = (fp, page) => Math.min(Infinity, ...page.hashes.map((h) => hamming(fp, h)));

function resolveText(text) {
  return String(text).replace(/\\$\\{([^}]+)\\}/g, (_, k) => {
    const v = process.env[\`PA_\${k}\`];
    if (v === undefined) throw new Error(\`缺少環境變數 PA_\${k}\`);
    return v;
  });
}
async function perform(op, label) {
  const { width, height } = await driver.getWindowSize();
  const px = (v, span) => Math.round(v * span);
  const finger = () => driver.action('pointer', { parameters: { pointerType: 'touch' } });
  console.log(\`  → \${op.a} \${label}\`);
  switch (op.a) {
    case 'tap':
      await finger().move({ x: px(op.x, width), y: px(op.y, height) }).down().pause(80).up().perform(); break;
    case 'hold':
      await finger().move({ x: px(op.x, width), y: px(op.y, height) }).down().pause(op.ms ?? 1000).up().perform(); break;
    case 'swipe':
      await finger().move({ x: px(op.x, width), y: px(op.y, height) }).down().pause(60)
        .move({ x: px(op.x2, width), y: px(op.y2, height), duration: op.ms ?? 300 }).up().perform(); break;
    case 'back':
      await driver.back(); break;
    case 'type':
      await driver.keys(resolveText(op.text).split('')); break;
    default:
      console.warn(\`  (略過不支援的動作 \${op.a})\`);
  }
}
/** 等到出現 page(途中遇到已知彈窗就照記憶關掉)。 */
async function waitFor(page, why) {
  // 沒有指紋的畫面(舊資料)無法比對,等一下就照做。
  if (!page.hashes.length) { await sleep(2000); return; }
  const t0 = Date.now();
  while (Date.now() - t0 < TIMEOUT_MS) {
    const fp = await fingerprint();
    const d = distTo(fp, page);
    if (d <= MATCH) return;
    const popup = DATA.handlers
      .map((h) => ({ h, d: distTo(fp, h.page) }))
      .filter((x) => x.d <= MATCH && x.d < d && x.h.page.id !== page.id)
      .sort((a, b) => a.d - b.d)[0];
    if (popup) { console.log(\`  出現「\${popup.h.page.name}」,照記憶關掉\`); await perform(popup.h.op, popup.h.target); await sleep(1500); continue; }
    await sleep(700);
  }
  throw new Error(\`\${why}:\${TIMEOUT_MS / 1000} 秒內沒有看到「\${page.name}」(畫面可能改版或出現未知彈窗)\`);
}

const driver = await remote({
  hostname: server.hostname,
  port: Number(server.port) || 4723,
  path: server.pathname === '/' ? '/' : server.pathname,
  logLevel: 'warn',
  capabilities: {
    platformName: 'Android',
    'appium:automationName': 'UiAutomator2',
    ...(args.udid ? { 'appium:udid': args.udid } : {}),
    ...(args.package ? { 'appium:appPackage': args.package } : {}),
    ...(args.activity ? { 'appium:appActivity': args.activity } : {}),
    'appium:noReset': true,
    'appium:newCommandTimeout': 600,
  },
});

try {
  const t0 = Date.now();
  for (const [i, s] of DATA.steps.entries()) {
    console.log(\`[\${i + 1}/\${DATA.steps.length}] 「\${s.from.name}」\`);
    await waitFor(s.from, \`第 \${i + 1} 步\`);
    await perform(s.op, s.target);
    await sleep(800);
  }
  await waitFor(DATA.target, '最後一步');
  console.log(\`已到「\${DATA.target.name}」(\${((Date.now() - t0) / 1000).toFixed(1)} 秒)\`);
  const spins = Number(args.spins) || 0;
  if (spins > 0) {
    if (!DATA.spin) throw new Error('這個畫面沒有記錄到 SPIN 操作,無法 --spins');
    for (let k = 1; k <= spins; k++) {
      await perform(DATA.spin.op, \`\${DATA.spin.target} 第 \${k}/\${spins} 局\`);
      // 等盤面停下:連續兩張指紋幾乎不變(最多 20 秒)。本機腳本不讀數字,RTP 請在平台上跑。
      let last = null, stable = 0;
      for (const t1 = Date.now(); Date.now() - t1 < 20000 && stable < 2;) {
        await sleep(700);
        const fp = await fingerprint();
        stable = last && hamming(last, fp) <= 8 ? stable + 1 : 0;
        last = fp;
      }
    }
  }
} finally {
  await driver.deleteSession().catch(() => {});
}
`;
}
