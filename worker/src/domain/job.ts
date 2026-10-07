import { z } from 'zod';
import { DisplaySchema, isSupportedResolution } from './display.js';
import { GameTypeSchema, PlatformSchema } from './platform.js';

/** 安全 id(jobId / tenantId / appId…):只收英數、- 和 _,避免進 S3 key / 指令參數時被注入。 */
export const SafeId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);

/** 被測產物種類;每個平台只接受自己的種類。 */
export const BuildKindSchema = z.enum(['apk', 'xapk', 'ios-sim-app', 'win-exe', 'win-zip', 'linux-tar', 'linux-appimage']);
export type BuildKind = z.infer<typeof BuildKindSchema>;

const BUILD_KINDS_BY_PLATFORM = {
  android: ['apk', 'xapk'],
  // iOS Simulator 只能跑「Simulator 架構」的 .app(Xcode 用 iphonesimulator SDK 編譯),
  // 不能裝 App Store / Ad Hoc 的 .ipa(那是給實機的 arm64 iphoneos 二進位)。
  ios: ['ios-sim-app'],
  windows: ['win-exe', 'win-zip'],
  linux: ['linux-tar', 'linux-appimage'],
} as const;

export const RecordingSchema = z.object({
  mode: z.enum(['FULL', 'FAILURE_ONLY', 'OFF']).default('FULL'),
  /** FAILURE_ONLY 的 rolling buffer 長度(秒)。 */
  rollingSeconds: z.union([z.literal(30), z.literal(60), z.literal(120)]).default(60),
  audio: z.boolean().default(true),
});

export const RetryPolicySchema = z.object({
  action: z.number().int().min(0).max(5).default(3),
  app: z.number().int().min(0).max(3).default(2),
  worker: z.number().int().min(0).max(2).default(1),
});

export const AiConfigSchema = z.object({
  vlmModel: z.string().min(1).max(200),
  agentModel: z.string().max(200).optional(),
  subagentModel: z.string().max(200).optional(),
});

export const JobConfigSchema = z
  .object({
    jobId: SafeId,
    tenantId: SafeId,
    appId: SafeId,
    projectId: SafeId.optional(),
    caseId: SafeId.optional(),
    platform: PlatformSchema,
    gameType: GameTypeSchema.default('other'),
    build: z.object({
      kind: BuildKindSchema,
      /** 資料桶內的 S3 key(Worker 用 IAM Role 讀;不接受任意 URL)。 */
      artifactKey: z.string().regex(/^tenants\/[A-Za-z0-9_-]+\/artifacts\/[A-Za-z0-9/_.-]+$/),
      /** Android package / iOS bundle id / Windows exe 相對路徑 / Linux 執行檔相對路徑。 */
      entry: z.string().regex(/^[A-Za-z0-9_./ -]{1,200}$/).refine((s) => !s.includes('..'), '不可包含 ..'),
      version: z.string().max(60).optional(),
    }),
    display: DisplaySchema,
    /** 測試時長(分鐘):1 小時 ~ 72 小時。 */
    durationMinutes: z.number().int().min(1).max(72 * 60),
    /** 整體逾時(分鐘),必須 ≥ durationMinutes。 */
    timeoutMinutes: z.number().int().min(1).max(73 * 60),
    environmentVariables: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/), z.string().max(1000)).default({}),
    testCases: z.array(z.string().min(1).max(4000)).min(1).max(50),
    ai: AiConfigSchema,
    recording: RecordingSchema.default({ mode: 'FULL', rollingSeconds: 60, audio: true }),
    retry: RetryPolicySchema.default({ action: 3, app: 2, worker: 1 }),
    /** 是否允許排到 Spot(iOS / EC2 Mac 沒有 Spot,會被拒絕)。 */
    allowSpot: z.boolean().default(true),
    maxSteps: z.number().int().min(1).optional(),
    budgetUsd: z.number().positive().optional(),
  })
  .superRefine((j, ctx) => {
    if (!(BUILD_KINDS_BY_PLATFORM[j.platform] as readonly string[]).includes(j.build.kind)) {
      ctx.addIssue({ code: 'custom', path: ['build', 'kind'], message: `${j.platform} 不接受 ${j.build.kind}(可用:${BUILD_KINDS_BY_PLATFORM[j.platform].join(', ')})` });
    }
    if (j.timeoutMinutes < j.durationMinutes) {
      ctx.addIssue({ code: 'custom', path: ['timeoutMinutes'], message: 'timeoutMinutes 必須 ≥ durationMinutes' });
    }
    if ((j.platform === 'windows' || j.platform === 'linux') && !isSupportedResolution(j.display.width, j.display.height)) {
      ctx.addIssue({ code: 'custom', path: ['display'], message: `${j.display.width}×${j.display.height} 不在支援的解析度清單` });
    }
  })
  // EC2 Mac 跑在 Dedicated Host 上,沒有 Spot:iOS 一律視為 On-Demand。
  .transform((j) => (j.platform === 'ios' ? { ...j, allowSpot: false } : j));

export type JobConfig = z.output<typeof JobConfigSchema>;

export function parseJobConfig(raw: unknown): { ok: true; job: JobConfig } | { ok: false; errors: string[] } {
  const r = JobConfigSchema.safeParse(raw);
  if (r.success) return { ok: true, job: r.data };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}
