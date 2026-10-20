/**
 * 接管模式(takeover):測試人員自己動手操作被測畫面,AI 退到旁邊。
 *
 *   jobs/<id>/takeover.json          { enabled, by, at }  開關
 *   jobs/<id>/takeover/<id>.json     一筆手動操作(相對座標 0–1)
 *   jobs/<id>/takeover-ack/<id>.json runner 的回執(前端顯示「已在裝置上執行」)
 *   jobs/<id>/takeover-script.json   runner 寫的操作序列(可轉成測試腳本)
 *
 * 為什麼不沿用 operatorCommands 那條通道(見 agent/takeover.mjs 的說明):
 * 那條有 100 則上限、而且每次寫入都要 LIST 整個前綴(O(n)),不適合即時操作。
 * 這裡寫入不 LIST;runner 用 StartAfter 游標讀,所以筆數不設硬上限。
 */
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { tenantPrefix } from './tenantCredentials.js';
import { newCommandId } from './operatorCommands.js';

export class TakeoverValidationError extends Error {}

/** runner(agent/takeover.mjs)支援的操作種類。 */
export const TAKEOVER_KINDS = ['tap', 'drag', 'key', 'type', 'back'] as const;
export type TakeoverKind = (typeof TAKEOVER_KINDS)[number];

/** 單次測試的手動操作筆數上限:純粹防爆(誤觸自動化腳本),正常手動遠達不到。 */
export const MAX_TAKEOVER_ACTIONS = 5000;

export interface TakeoverState {
  enabled: boolean;
  by?: string;
  at?: string;
}

export interface TakeoverAction {
  id: string;
  kind: TakeoverKind;
  point?: { x: number; y: number };
  to?: { x: number; y: number };
  dragMs?: number;
  key?: string;
  repeat?: number;
  holdMs?: number;
  text?: string;
  createdAt: string;
  createdBy?: string;
}

function jobPrefix(tenantId: string, jobId: string): string {
  return `${tenantPrefix(tenantId)}jobs/${jobId}`;
}

async function readJson<T>(s3: S3Client, bucket: string, key: string): Promise<T | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const t = await res.Body?.transformToString();
    return t ? (JSON.parse(t) as T) : null;
  } catch {
    return null;
  }
}

/** 讀接管開關。沒有檔案 = 沒開(預設 AI 自己跑)。 */
export async function readTakeoverState(
  s3: S3Client, bucket: string, tenantId: string, jobId: string,
): Promise<TakeoverState> {
  const doc = await readJson<TakeoverState>(s3, bucket, `${jobPrefix(tenantId, jobId)}/takeover.json`);
  return { enabled: doc?.enabled === true, ...(doc?.by ? { by: doc.by } : {}), ...(doc?.at ? { at: doc.at } : {}) };
}

/** 切換接管開關。 */
export async function writeTakeoverState(
  s3: S3Client, bucket: string, tenantId: string, jobId: string, enabled: boolean, by?: string,
): Promise<TakeoverState> {
  const state: TakeoverState = { enabled, ...(by ? { by } : {}), at: new Date().toISOString() };
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: `${jobPrefix(tenantId, jobId)}/takeover.json`,
    Body: JSON.stringify(state),
    ContentType: 'application/json',
  }));
  return state;
}

/** 0–1 的相對座標。格式不對就拒絕,不要悄悄忽略(座標錯了會點到別的地方)。 */
function parsePoint(v: unknown, name: string): { x: number; y: number } | undefined {
  if (v === undefined || v === null) return undefined;
  const p = v as Record<string, unknown>;
  const x = Number(p['x']);
  const y = Number(p['y']);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
    throw new TakeoverValidationError(`${name} 需為 {x,y},介於 0 到 1`);
  }
  return { x: Math.round(x * 10000) / 10000, y: Math.round(y * 10000) / 10000 };
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

/** 驗證一筆手動操作。回可直接落檔的形狀(不含 id / 時間)。 */
export function validateTakeoverAction(body: unknown): Omit<TakeoverAction, 'id' | 'createdAt' | 'createdBy'> {
  const b = (body ?? {}) as Record<string, unknown>;
  const kind = String(b['kind'] ?? '').toLowerCase() as TakeoverKind;
  if (!(TAKEOVER_KINDS as readonly string[]).includes(kind)) {
    throw new TakeoverValidationError(`kind 必須是 ${TAKEOVER_KINDS.join('/')} 之一`);
  }
  if (kind === 'tap') {
    const point = parsePoint(b['point'], 'point');
    if (!point) throw new TakeoverValidationError('tap 需要 point');
    return { kind, point };
  }
  if (kind === 'drag') {
    const point = parsePoint(b['point'], 'point');
    const to = parsePoint(b['to'], 'to');
    if (!point || !to) throw new TakeoverValidationError('drag 需要 point 與 to');
    if (point.x === to.x && point.y === to.y) throw new TakeoverValidationError('拖曳的起點與終點不能相同');
    return { kind, point, to, dragMs: clampInt(b['dragMs'], 50, 5000, 600) };
  }
  if (kind === 'key') {
    const key = String(b['key'] ?? '').trim().slice(0, 20);
    if (!key) throw new TakeoverValidationError('key 不可為空');
    return {
      kind, key,
      repeat: clampInt(b['repeat'], 1, 20, 1),
      ...(b['holdMs'] === undefined || b['holdMs'] === null ? {} : { holdMs: clampInt(b['holdMs'], 10, 5000, 250) }),
    };
  }
  if (kind === 'type') {
    const raw = b['text'];
    if (typeof raw !== 'string' || raw === '') throw new TakeoverValidationError('type 需要 text');
    return { kind, text: raw.slice(0, 500) };
  }
  return { kind }; // back
}

/** 寫一筆手動操作。id 是時間可排序的,runner 用 StartAfter 依序讀。 */
export async function writeTakeoverAction(
  s3: S3Client, bucket: string, tenantId: string, jobId: string,
  action: Omit<TakeoverAction, 'id' | 'createdAt' | 'createdBy'>, by?: string,
): Promise<TakeoverAction> {
  const doc: TakeoverAction = {
    id: newCommandId(),
    ...action,
    createdAt: new Date().toISOString(),
    ...(by ? { createdBy: by } : {}),
  };
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: `${jobPrefix(tenantId, jobId)}/takeover/${doc.id}.json`,
    Body: JSON.stringify(doc),
    ContentType: 'application/json',
    IfNoneMatch: '*',
  }));
  return doc;
}

export interface TakeoverScriptAction {
  seq: number;
  kind: string;
  screen?: string;
  url?: string;
  point?: { x: number; y: number };
  to?: { x: number; y: number };
  dragMs?: number;
  key?: string;
  repeat?: number;
  text?: string;
  at?: string;
  ok?: boolean;
}

export interface TakeoverScript {
  jobId: string;
  startUrl?: string;
  platform?: string;
  actions: TakeoverScriptAction[];
  generatedAt?: string;
}

/** 讀 runner 寫的手動操作序列(供「轉成測試腳本」)。沒有回 null。 */
export async function readTakeoverScript(
  s3: S3Client, bucket: string, tenantId: string, jobId: string,
): Promise<TakeoverScript | null> {
  return readJson<TakeoverScript>(s3, bucket, `${jobPrefix(tenantId, jobId)}/takeover-script.json`);
}

/**
 * 操作序列 → 測試案例 YAML(【AI 學習 B】)。
 *
 * 刻意產生「人看得懂、可編輯」的 YAML,而不是一串座標:座標會因版面改動而失效,
 * 所以同時寫出畫面名與操作語意,讓測試人員能把它改成以元件描述為主的腳本。
 * 打字內容若是 ${key} 佔位符會原樣保留 —— 絕不把憑證真值寫進案例。
 */
export function takeoverScriptToYaml(script: TakeoverScript, name: string): string {
  const esc = (s: string) => String(s).replace(/"/g, '\\"');
  const lines: string[] = [];
  lines.push(`name: "${esc(name)}"`);
  if (script.startUrl) lines.push(`url: "${esc(script.startUrl)}"`);
  lines.push('task: |');
  lines.push('  依下列步驟操作(由測試人員實機示範錄製):');
  let n = 1;
  for (const a of script.actions) {
    const where = a.screen ? `在「${a.screen}」` : '';
    if (a.kind === 'tap' && a.point) {
      lines.push(`  ${n++}. ${where}點擊畫面位置 (${pct(a.point.x)}, ${pct(a.point.y)})`);
    } else if (a.kind === 'drag' && a.point && a.to) {
      lines.push(`  ${n++}. ${where}從 (${pct(a.point.x)}, ${pct(a.point.y)}) 拖曳到 (${pct(a.to.x)}, ${pct(a.to.y)})`);
    } else if (a.kind === 'key' && a.key) {
      lines.push(`  ${n++}. ${where}按下按鍵 ${a.key}${a.repeat && a.repeat > 1 ? ` ${a.repeat} 次` : ''}`);
    } else if (a.kind === 'type' && a.text) {
      lines.push(`  ${n++}. ${where}輸入「${esc(a.text)}」`);
    } else if (a.kind === 'back') {
      lines.push(`  ${n++}. ${where}返回上一頁`);
    }
  }
  if (n === 1) lines.push('  (沒有錄到任何操作)');
  lines.push('');
  lines.push('# 這份腳本是從「接管模式」的實機操作錄下來的。座標是畫面百分比,版面改動後可能失效;');
  lines.push('# 建議把步驟改寫成以元件描述為主(例如「點擊『登入』按鈕」),會更耐改版。');
  return `${lines.join('\n')}\n`;
}

function pct(v: number): string {
  return `${Math.round(v * 1000) / 10}%`;
}
