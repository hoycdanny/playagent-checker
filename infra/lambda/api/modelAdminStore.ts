/**
 * 模型管理設定的持久化(admin 專用):哪些模型要出現在哪個下拉。
 *
 * 存於 shared/model-admin.json(跨租戶的全域管理設定,沿用 shared/* 由 API Lambda 自身角色存取)。
 * 寫入時連同「掃描當下的模型中繼資料」一起快照(顯示名/channel/座標系/能力),這樣 GET /models
 * 不必每次重新掃 Bedrock 控制面(慢且有節流),只讀這份設定即可組出下拉清單。
 */
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { Channel, CoordSystem } from './modelCatalog.js';

/** 四個下拉(座位):agent=控制遊戲、vlm=分析畫面、subagent=子代理、draft=產生測試腳本。 */
export type ModelSeat = 'agent' | 'vlm' | 'subagent' | 'draft';
export const MODEL_SEATS: ModelSeat[] = ['agent', 'vlm', 'subagent', 'draft'];

export interface ModelAdminEntry {
  modelId: string;
  displayName: string;
  provider: string;
  channel: Channel;
  coordSystem: CoordSystem;
  image: boolean;
  text: boolean;
  /** 這個模型被勾選出現在哪些下拉。 */
  seats: ModelSeat[];
  /** 在哪些下拉被標為「推薦」(金勾勾);必為 seats 的子集。 */
  recommended?: ModelSeat[];
}

export interface ModelAdminConfig {
  updatedAt: string;
  updatedBy: string;
  entries: ModelAdminEntry[];
}

export interface ModelAdminStore {
  readConfig(): Promise<ModelAdminConfig | null>;
  writeConfig(cfg: ModelAdminConfig): Promise<void>;
}

const CONFIG_KEY = 'shared/model-admin.json';

export function makeModelAdminStore(s3: S3Client, bucket: string): ModelAdminStore {
  return {
    async readConfig() {
      try {
        const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: CONFIG_KEY }));
        const v = JSON.parse((await r.Body?.transformToString()) ?? 'null') as ModelAdminConfig | null;
        if (!v || !Array.isArray(v.entries)) return null;
        return v;
      } catch {
        return null;
      }
    },
    async writeConfig(cfg) {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: CONFIG_KEY,
          Body: JSON.stringify(cfg),
          ContentType: 'application/json',
        }),
      );
    },
  };
}

/** 合法化一組座位選擇:只保留合法座位,且 vlm 需要看圖、其餘需要文字輸出。 */
export function validSeatsFor(image: boolean, text: boolean, seats: unknown): ModelSeat[] {
  if (!Array.isArray(seats)) return [];
  const set = new Set<ModelSeat>();
  for (const s of seats) {
    if (s === 'vlm' && image) set.add('vlm');
    else if ((s === 'agent' || s === 'subagent' || s === 'draft') && text) set.add(s);
  }
  return [...set];
}
