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

export function validateCommandBody(body: unknown): { text: string; remember: boolean; screen?: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const raw = b['text'];
  if (typeof raw !== 'string') throw new CommandValidationError('text 必填');
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) throw new CommandValidationError('指令不可為空');
  if (text.length > MAX_COMMAND_LEN) throw new CommandValidationError(`指令最多 ${MAX_COMMAND_LEN} 字`);
  const screen = typeof b['screen'] === 'string' ? b['screen'].trim().slice(0, 80) : '';
  return { text, remember: b['remember'] !== false, ...(screen ? { screen } : {}) };
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
