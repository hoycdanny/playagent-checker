import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import type { TaskState } from '../api/status.js';
import type { StepRecord } from '../api/tasks.js';

const NARRATIVE_MODEL_ID = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

/** 固定預生成語言(對齊主市場,Req 6.8)+ 可勾選語言。 */
export const FIXED_NARRATIVE_LANGS = ['zh-Hant', 'en'] as const;
export const OPTIONAL_NARRATIVE_LANGS = ['zh-Hans', 'ja', 'ko'] as const;
export type ReportLang =
  | (typeof FIXED_NARRATIVE_LANGS)[number]
  | (typeof OPTIONAL_NARRATIVE_LANGS)[number];

const LANG_NAME: Record<ReportLang, string> = {
  'zh-Hant': '繁體中文',
  en: 'English',
  'zh-Hans': '简体中文',
  ja: '日本語',
  ko: '한국어',
};

export interface ReportInput {
  s3: S3Client;
  bucket: string;
  bedrock: Pick<BedrockRuntimeClient, 'send'>;
  tenantId: string;
  jobId: string;
  state: TaskState;
  steps: StepRecord[];
  billableSpendUsd: number;
  budgetUsd?: number;
  /** 額外要預生成的語言(勾選)。 */
  extraLangs?: ReportLang[];
}

/** 報告產出物(report.json)。 */
export interface ReportDoc {
  jobId: string;
  state: TaskState;
  stepCount: number;
  /** 花費:閾值與實際兩個數都給(Req 6.4)。 */
  budgetUsd: number | null;
  billableSpendUsd: number;
  steps: StepRecord[];
  /** AI 敘述的多語預生成版本(Req 6.7,做法 A)。 */
  narratives: Partial<Record<ReportLang, string>>;
  /** 已預生成的語言集(Req 6.11)。 */
  availableLanguages: ReportLang[];
  generatedAt: string;
}

async function generateNarrative(
  bedrock: Pick<BedrockRuntimeClient, 'send'>,
  lang: ReportLang,
  ctx: { state: TaskState; steps: StepRecord[]; billableSpendUsd: number },
): Promise<string> {
  const stepsText = ctx.steps
    .map((s) => `- step ${s.index}: ${JSON.stringify(s)}`)
    .join('\n');
  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 600,
    system: `你是測試報告撰寫助手。用「${LANG_NAME[lang]}」撰寫一段簡潔的測試結果敘述(缺陷摘要 / 流程分析),只輸出敘述文字,不要 markdown 圍欄、不要額外前綴。`,
    messages: [
      {
        role: 'user',
        content: `測試終局狀態:${ctx.state}\n花費(美元):${ctx.billableSpendUsd}\n步驟:\n${stepsText}\n\n請以 ${LANG_NAME[lang]} 撰寫 2-4 句的結果敘述。`,
      },
    ],
  };
  const res = await bedrock.send(
    new InvokeModelCommand({
      modelId: NARRATIVE_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(body),
    }),
  );
  const text = new TextDecoder().decode(res.body as Uint8Array);
  const parsed = JSON.parse(text) as { content?: Array<{ type: string; text?: string }> };
  return parsed.content?.find((c) => c.type === 'text')?.text?.trim() ?? '';
}

/**
 * 產生報告(Req 6,做法 A):結構化內容 + AI 敘述於產生時**預生成多語版本**。
 * 固定 zh-Hant + en;extraLangs 勾選的一併生成。讀者切語言時直接讀對應版本,不等待。
 */
export async function generateReport(input: ReportInput): Promise<ReportDoc> {
  const langs: ReportLang[] = [
    ...FIXED_NARRATIVE_LANGS,
    ...(input.extraLangs ?? []).filter(
      (l) => !FIXED_NARRATIVE_LANGS.includes(l as never),
    ),
  ];

  const narratives: Partial<Record<ReportLang, string>> = {};
  // 逐語言預生成(數量少,序列即可;失敗的語言略過但不擋報告)。
  for (const lang of langs) {
    try {
      narratives[lang] = await generateNarrative(input.bedrock, lang, {
        state: input.state,
        steps: input.steps,
        billableSpendUsd: input.billableSpendUsd,
      });
    } catch {
      /* 該語言略過;availableLanguages 只列成功者 */
    }
  }
  const availableLanguages = langs.filter((l) => narratives[l] !== undefined);

  const doc: ReportDoc = {
    jobId: input.jobId,
    state: input.state,
    stepCount: input.steps.length,
    budgetUsd: input.budgetUsd ?? null,
    billableSpendUsd: input.billableSpendUsd,
    steps: input.steps,
    narratives,
    availableLanguages,
    generatedAt: new Date().toISOString(),
  };

  await input.s3.send(
    new PutObjectCommand({
      Bucket: input.bucket,
      Key: `tenants/${input.tenantId}/jobs/${input.jobId}/report.json`,
      Body: JSON.stringify(doc),
      ContentType: 'application/json',
    }),
  );
  return doc;
}
