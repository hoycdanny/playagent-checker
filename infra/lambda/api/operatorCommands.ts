/**
 * 測試中的「測試人員即時指令」:前端聊天室送出 → 寫 jobs/<id>/commands/<cmdId>.json,
 * runner 下一步輪詢取用並注入 AI(最高優先),回寫 jobs/<id>/commands-ack/<cmdId>.json:
 *   received(已送進 AI,第 N 步)→ applied(AI 當步的回應與動作)。
 * runner 角色不能刪檔,所以狀態以 ack 檔表示,指令檔本身不修改。
 */
import { randomBytes } from 'node:crypto';
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { tenantPrefix } from './tenantCredentials.js';

export class CommandValidationError extends Error {}

export const MAX_COMMAND_LEN = 500;
export const MAX_COMMANDS_PER_JOB = 100;

export interface OperatorCommand {
  id: string;
  text: string;
  createdAt: string;
  createdBy?: string;
  /** 送出時的畫面(前端最新一步的畫面名),供記憶綁定。 */
  screen?: string;
  /** 勾選「記住」時建立的應用記憶 id。 */
  hintId?: string;
  /** 測試人員在即時畫面上點選的位置(相對比例 0–1);runner 直接點這裡。有 to 時是拖曳起點。 */
  point?: { x: number; y: number };
  /** 拖曳終點(相對比例 0–1):從 point 按住拖到這裡放開(遊戲的拖放、瞄準、滑動解鎖等)。 */
  to?: { x: number; y: number };
  /** 拖曳耗時(毫秒),取測試人員實際拖的時間。 */
  dragMs?: number;
}

export interface CommandAck {
  status: 'received' | 'applied';
  step?: number;
  /** AI 當步的回應(thinking)與動作。 */
  reply?: string;
  action?: string;
  screen?: string;
  at?: string;
}

export type CommandView = OperatorCommand & { ack?: CommandAck };

function jobPrefix(tenantId: string, jobId: string): string {
  return `${tenantPrefix(tenantId)}jobs/${jobId}`;
}

/** 依時間可排序的指令 id(cmd-<13 位 base36 毫秒><4 hex>)。 */
export function newCommandId(now = Date.now()): string {
  return `cmd-${now.toString(36).padStart(10, '0')}${randomBytes(2).toString('hex')}`;
}

/** 只點畫面、沒打字時的預設文字(與 agent/operatorMemory.mjs POINT_ONLY_TEXT 一致)。 */
export const POINT_ONLY_TEXT = '點這個位置';
/** 只拖曳、沒打字時的預設文字(與 agent/operatorMemory.mjs DRAG_ONLY_TEXT 一致)。 */
export const DRAG_ONLY_TEXT = '照這條路徑拖曳';
/** 拖曳耗時範圍(毫秒);沒給時用預設值。 */
export const DRAG_MS_MIN = 100;
export const DRAG_MS_MAX = 5000;
export const DRAG_MS_DEFAULT = 600;

export function validateCommandBody(body: unknown): {
  text: string;
  remember: boolean;
  screen?: string;
  point?: { x: number; y: number };
  to?: { x: number; y: number };
  dragMs?: number;
  /** 只點/拖了畫面、沒有打字(text 為預設值)。 */
  pointOnly?: boolean;
} {
  const b = (body ?? {}) as Record<string, unknown>;
  const point = parsePoint(b['point'], 'point');
  const to = parsePoint(b['to'], 'to');
  if (to && !point) throw new CommandValidationError('拖曳需要起點 point 與終點 to');
  if (to && point && to.x === point.x && to.y === point.y) throw new CommandValidationError('拖曳的起點與終點不能相同');
  const dragMs = to ? parseDragMs(b['dragMs']) : undefined;
  const raw = b['text'];
  if (raw !== undefined && typeof raw !== 'string') throw new CommandValidationError('text 必須是文字');
  let text = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!text && !point) throw new CommandValidationError('指令不可為空');
  const pointOnly = !text && !!point;
  if (pointOnly) text = to ? DRAG_ONLY_TEXT : POINT_ONLY_TEXT;
  if (text.length > MAX_COMMAND_LEN) throw new CommandValidationError(`指令最多 ${MAX_COMMAND_LEN} 字`);
  const screen = typeof b['screen'] === 'string' ? b['screen'].trim().slice(0, 80) : '';
  return {
    text,
    remember: b['remember'] !== false,
    ...(screen ? { screen } : {}),
    ...(point ? { point } : {}),
    ...(to ? { to, dragMs } : {}),
    ...(pointOnly ? { pointOnly: true } : {}),
  };
}

/** 畫面點選位置:相對比例 0–1(左上為 0,0)。格式不對 → 拒絕,而不是悄悄忽略。 */
function parsePoint(v: unknown, name: 'point' | 'to'): { x: number; y: number } | undefined {
  if (v === undefined || v === null) return undefined;
  const p = v as Record<string, unknown>;
  const x = Number(p['x']);
  const y = Number(p['y']);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
    throw new CommandValidationError(`${name} 需為 {x,y},介於 0 到 1`);
  }
  return { x: Math.round(x * 10000) / 10000, y: Math.round(y * 10000) / 10000 };
}

/** 拖曳耗時:沒給 → 預設;有給但不是數字 → 拒絕;超出範圍 → 夾到範圍內。 */
function parseDragMs(v: unknown): number {
  if (v === undefined || v === null) return DRAG_MS_DEFAULT;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new CommandValidationError('dragMs 必須是毫秒數');
  return Math.max(DRAG_MS_MIN, Math.min(DRAG_MS_MAX, Math.round(n)));
}

async function listKeys(s3: S3Client, bucket: string, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ...(token ? { ContinuationToken: token } : {}) }));
    for (const o of res.Contents ?? []) if (o.Key) keys.push(o.Key);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
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

export async function writeCommand(s3: S3Client, bucket: string, tenantId: string, jobId: string, cmd: OperatorCommand): Promise<void> {
  const existing = await listKeys(s3, bucket, `${jobPrefix(tenantId, jobId)}/commands/`);
  if (existing.length >= MAX_COMMANDS_PER_JOB) throw new CommandValidationError(`單次測試最多 ${MAX_COMMANDS_PER_JOB} 則指令`);
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: `${jobPrefix(tenantId, jobId)}/commands/${cmd.id}.json`,
    Body: JSON.stringify(cmd),
    ContentType: 'application/json',
    IfNoneMatch: '*',
  }));
}

/** 指令 + 回執(舊 → 新)。 */
export async function listCommands(s3: S3Client, bucket: string, tenantId: string, jobId: string): Promise<CommandView[]> {
  const base = jobPrefix(tenantId, jobId);
  const [cmdKeys, ackKeys] = await Promise.all([listKeys(s3, bucket, `${base}/commands/`), listKeys(s3, bucket, `${base}/commands-ack/`)]);
  const idOf = (k: string) => k.slice(k.lastIndexOf('/') + 1).replace(/\.json$/, '');
  const ackSet = new Set(ackKeys.map(idOf));
  const ids = cmdKeys.map(idOf).filter((id) => /^cmd-[a-z0-9]{6,32}$/.test(id)).sort();
  const items = await Promise.all(
    ids.map(async (id) => {
      const [cmd, ack] = await Promise.all([
        readJson<OperatorCommand>(s3, bucket, `${base}/commands/${id}.json`),
        ackSet.has(id) ? readJson<CommandAck>(s3, bucket, `${base}/commands-ack/${id}.json`) : Promise.resolve(null),
      ]);
      return cmd ? { ...cmd, id, ...(ack ? { ack } : {}) } : null;
    }),
  );
  return items.filter((x): x is CommandView => x !== null);
}
