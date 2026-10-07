import { z } from 'zod';
import { SafeId } from './job.js';

/**
 * Artifact 結構。沿用既有 S3 契約(前端、報告引擎已經在讀這些路徑),只新增 crashes/ 與 metrics/:
 *   tenants/<t>/jobs/<jobId>/
 *     screenshots/<step>.png     每步截圖(既有)
 *     audio/rec-<n>.mp4          整場錄影(含聲音,RecordingPlayer 讀;既有)
 *     videos/failure-<id>-{before,after}.mp4   FAILURE_ONLY 模式的失敗片段(新)
 *     devlogs/logcat|audio/...   裝置 log(既有)
 *     logs/<name>                其他 log(Windows Event Log、Xcode 系統 log…;新)
 *     crashes/<id>/...           crash dump / tombstone / ANR trace(新)
 *     metrics/<seq>.json         每 5~10 秒的效能取樣(新)
 *     report.json                runner 報告(既有;報告引擎據此產生結構化報告)
 * 全部用資料桶的預設加密(SSE),Worker 用 IAM Role 寫入,不放 Access Key。
 */
export const ArtifactKindSchema = z.enum(['screenshot', 'recording', 'failure_video', 'device_log', 'log', 'crash', 'metrics', 'report']);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

const DIR: Record<ArtifactKind, string> = {
  screenshot: 'screenshots',
  recording: 'audio',
  failure_video: 'videos',
  device_log: 'devlogs',
  log: 'logs',
  crash: 'crashes',
  metrics: 'metrics',
  report: '',
};

const SAFE_NAME = /^[A-Za-z0-9_.-]{1,120}(\/[A-Za-z0-9_.-]{1,120}){0,3}$/;

export function artifactKey(tenantId: string, jobId: string, kind: ArtifactKind, name: string): string {
  SafeId.parse(tenantId);
  SafeId.parse(jobId);
  if (!SAFE_NAME.test(name) || name.includes('..')) throw new Error(`artifact 名稱不合法:${name}`);
  const dir = DIR[kind];
  return `tenants/${tenantId}/jobs/${jobId}/${dir ? `${dir}/` : ''}${name}`;
}

export const ArtifactSchema = z.object({
  kind: ArtifactKindSchema,
  key: z.string(),
  contentType: z.string(),
  bytes: z.number().int().min(0),
  createdAt: z.string(),
  /** 對應的測試步驟(截圖 / 失敗片段)。 */
  step: z.number().int().min(0).optional(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

/** 失敗證據:失敗前至少 10 個動作 + 截圖 / 錄影 / log / 指標 / AI 推理摘要。 */
export const FailureEvidenceSchema = z.object({
  failureId: z.string(),
  at: z.string(),
  reason: z.string(),
  classification: z.enum(['GAME_FAILURE', 'ENVIRONMENT', 'AI_TEST_FAILURE', 'NEEDS_TRIAGE']),
  actionHistory: z.array(z.object({ step: z.number(), action: z.string(), at: z.string(), ok: z.boolean() })).min(0),
  artifacts: z.array(ArtifactSchema),
  aiReasoning: z.string().max(4000).optional(),
  systemState: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});
export type FailureEvidence = z.infer<typeof FailureEvidenceSchema>;

/** 失敗前保留的動作數量下限。 */
export const FAILURE_ACTION_HISTORY = 10;
