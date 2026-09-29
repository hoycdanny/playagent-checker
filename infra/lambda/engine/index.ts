import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { STSClient } from '@aws-sdk/client-sts';
import { readCaseTarget as resolveWebTarget } from './webRunner.js';
import { type ReportLang } from './report.js';
import { writeStatus } from '../api/status.js';

import { assumeTenantS3 } from '../api/tenantCredentials.js';
import {
  readKnowledge,
  readMemory,
  composeContext,
  type Locality,
} from '../api/knowledge.js';
import { composeKnowledgeBases, getKnowledgeBase } from '../api/knowledgeBases.js';
import { retrieveFromKb } from '../api/bedrockKb.js';
import {
  defaultSeatSelection,
  resolveExecutionConfig,
  PricingError,
  type SeatSelection,
  type ExecutionConfigSnapshot,
} from './costGuard.js';

const REGION = process.env.AWS_REGION ?? 'us-east-2';
const BUCKET = process.env.DATA_BUCKET ?? '';
const TENANT_ROLE_ARN = process.env.TENANT_ROLE_ARN ?? '';

const sts = new STSClient({ region: REGION });
// 共用知識庫(shared/*)用引擎自身角色讀取(唯讀),不經租戶隔離角色。
const sharedS3 = new S3Client({ region: REGION });

/**
 * 生命週期 Lambda 直接 Invoke 的事件(非 SQS ESM,Req 3.8)。
 */
export interface EngineEvent {
  tenantId: string;
  jobId: string;
  backend: string;
  /** 額外要預生成敘述的語言(zh-Hant+en 固定,此處為勾選的 ja/ko/zh-Hans)。 */
  reportLangs?: ReportLang[];
  /** 各 Seat 選定模型(未指定則用預設);成本護欄據此解析單價並 Fail Closed。 */
  seats?: Partial<SeatSelection>;
  /** 使用者於提交時選的 VLM 模型(判畫面座標用);覆寫 seats.vlm。 */
  vlmModel?: string;
  /** 本次執行的 Budget 上限(美元);未指定或 <=0 代表「無上限」。 */
  budgetUsd?: number;
  /** 步數上限;未指定或 <=0 代表「無上限」(runner 跑到 done/卡死/取消才停)。 */
  maxSteps?: number;
}

// 預設「無上限」:不再預設 $1 保守值(過去導致任務被提早異常終止)。
// null 代表不設預算閘口;使用者若要控管成本,於提交時明確帶入 budgetUsd。
const DEFAULT_BUDGET_USD: number | null = null;

function jobPrefix(tenantId: string, jobId: string): string {
  return `tenants/${tenantId}/jobs/${jobId}/`;
}

/** 把執行配置快照固化到 S3(審計:當時各 Seat 用了什麼模型、單價多少,Req 7.5)。 */
async function writeConfigSnapshot(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  jobId: string,
  snapshot: ExecutionConfigSnapshot,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: `${jobPrefix(tenantId, jobId)}config.json`,
      Body: JSON.stringify(snapshot),
      ContentType: 'application/json',
    }),
  );
}

/** 讀 job.json 取得 appId 與 locality(供組裝 Knowledge/Memory 上下文)。 */
async function readJobMeta(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  jobId: string,
): Promise<{
  appId: string;
  locality: Locality;
  abi?: string;
  knowledgeBaseIds: string[];
  caseTask: string;
  artifactKey?: string;
  package?: string;
  platform?: string;
  deviceArn?: string;
  deviceModel?: string;
  osVersion?: string;
} | null> {
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: `${jobPrefix(tenantId, jobId)}job.json` }),
    );
    const text = (await res.Body?.transformToString()) ?? '';
    if (!text) return null;
    const job = JSON.parse(text) as {
      appId?: string;
      locality?: string;
      abi?: string;
      knowledgeBaseIds?: string[];
      caseTask?: string;
      artifactKey?: string;
      package?: string;
      platform?: string;
      deviceArn?: string;
      deviceModel?: string;
      osVersion?: string;
    };
    return {
      appId: job.appId ?? '',
      locality: job.locality === 'attached' ? 'attached' : 'cloud',
      ...(job.abi ? { abi: job.abi } : {}),
      knowledgeBaseIds: Array.isArray(job.knowledgeBaseIds) ? job.knowledgeBaseIds : [],
      caseTask: typeof job.caseTask === 'string' ? job.caseTask : '',
      ...(job.artifactKey ? { artifactKey: job.artifactKey } : {}),
      ...(job.package ? { package: job.package } : {}),
      ...(job.platform ? { platform: job.platform } : {}),
      ...(job.deviceArn ? { deviceArn: job.deviceArn } : {}),
      ...(job.deviceModel ? { deviceModel: job.deviceModel } : {}),
      ...(job.osVersion ? { osVersion: job.osVersion } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * 組裝並固化 Agent 上下文(Req 9):Knowledge(權威手寫事實)+ Memory(統計觀察,
 * 按 (App, Locality) 隔離)。衝突時 Knowledge 優先(composeContext 標示)。
 * 寫成 context.json 供審計「本次注入了什麼」;無內容則不寫。
 */
async function assembleAgentContext(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  jobId: string,
  appId: string,
  locality: Locality,
  knowledgeBaseIds: string[],
  caseTask: string,
): Promise<void> {
  if (!appId) return;
  const [knowledge, memory, kbMarkdown, kbReference] = await Promise.all([
    readKnowledge(s3, bucket, tenantId, appId),
    readMemory(s3, bucket, tenantId, appId, locality),
    // 共用知識庫 Markdown(提交時選的,可多選)—— 走 sharedS3(跨租戶),失敗不擋執行。
    composeKnowledgeBases(sharedS3, bucket, knowledgeBaseIds).catch(() => ''),
    // Bedrock KB 檢索(Stage B):以任務目標為 query,對每座已接文件的 KB 撈 top-K 片段。
    retrieveReference(bucket, knowledgeBaseIds, caseTask).catch(() => ''),
  ]);
  let context = composeContext(knowledge, memory);
  // 注入順序/優先序:手寫 App 知識 > 知識庫 Markdown > KB 檢索片段 > 記憶。
  if (kbMarkdown.trim()) {
    const kbBlock = `# KNOWLEDGE BASES (selected reusable knowledge)\n${kbMarkdown.trim()}`;
    context = context.trim() ? `${context}\n\n${kbBlock}` : kbBlock;
  }
  if (kbReference.trim()) {
    const refBlock = `# KNOWLEDGE BASE REFERENCES (retrieved for this task — lower priority than authored knowledge)\n${kbReference.trim()}`;
    context = context.trim() ? `${context}\n\n${refBlock}` : refBlock;
  }
  if (!context.trim()) return;
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: `${jobPrefix(tenantId, jobId)}context.json`,
      Body: JSON.stringify({
        appId,
        locality,
        hasKnowledge: knowledge.trim().length > 0,
        hasMemory: memory.trim().length > 0,
        hasKnowledgeBases: kbMarkdown.trim().length > 0,
        hasKbReferences: kbReference.trim().length > 0,
        knowledgeBaseIds,
        context,
        assembledAt: new Date().toISOString(),
      }),
      ContentType: 'application/json',
    }),
  );
}

/**
 * 對選定知識庫中「已接 Bedrock KB(有 bedrockKbId)」的每一座,用任務目標檢索 top-K 片段,
 * 合併成一個帶來源標註的參考區塊。純 Markdown 知識庫(無 bedrockKbId)不在此處理(走 composeKnowledgeBases)。
 */
async function retrieveReference(
  bucket: string,
  knowledgeBaseIds: string[],
  caseTask: string,
): Promise<string> {
  if (knowledgeBaseIds.length === 0 || !caseTask.trim()) return '';
  const recs = await Promise.all(
    knowledgeBaseIds.map((id) => getKnowledgeBase(sharedS3, bucket, id).catch(() => null)),
  );
  const blocks: string[] = [];
  for (const rec of recs) {
    if (!rec?.bedrockKbId) continue;
    const snippets = await retrieveFromKb(rec.bedrockKbId, caseTask).catch(() => []);
    if (snippets.length > 0) {
      blocks.push(`## ${rec.name}\n${snippets.map((s) => `- ${s}`).join('\n')}`);
    }
  }
  return blocks.join('\n\n');
}

/**
 * 引擎進入點(階段 5:先承載 Web 後端)。
 * 流程:取租戶 S3 → 依 backend 執行 → 寫終態 status。
 * 終態吸收保證:若期間被取消(cancel.json → status cancelled),此處寫 pass/fail
 * 會被 resolveStatus 依規則處理(running→結果;已 cancelled 則保留 cancelled)。
 */
export async function handler(event: EngineEvent): Promise<void> {
  const s3: S3Client = await assumeTenantS3(
    { sts, roleArn: TENANT_ROLE_ARN, region: REGION },
    event.tenantId,
  );

  // 成本護欄(Req 7):執行前解析各 Seat 生效模型的單價並固化快照。
  // Fail Closed —— 任一 Seat 模型查不到價,在任何執行花費前落 error,絕不以 $0 起跑。
  const budgetUsd = event.budgetUsd ?? DEFAULT_BUDGET_USD;
  let snapshot: ExecutionConfigSnapshot;
  try {
    const defaults = defaultSeatSelection();
    const selection: SeatSelection = {
      agent: event.seats?.agent ?? defaults.agent,
      // 使用者選的 vlmModel 優先(判畫面座標的 VLM Seat)。
      vlm: event.vlmModel ?? event.seats?.vlm ?? defaults.vlm,
      subagent: event.seats?.subagent ?? defaults.subagent,
    };
    snapshot = resolveExecutionConfig(selection, budgetUsd);
    await writeConfigSnapshot(s3, BUCKET, event.tenantId, event.jobId, snapshot);
  } catch (err) {
    if (err instanceof PricingError) {
      await writeStatus(s3, BUCKET, event.tenantId, {
        jobId: event.jobId,
        state: 'error',
        message: `成本護欄拒絕執行(Fail Closed):${err.message}`,
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    throw err;
  }

  // 組裝 Knowledge/Memory 上下文(Req 9),固化供審計。失敗不擋執行。
  try {
    const meta = await readJobMeta(s3, BUCKET, event.tenantId, event.jobId);
    if (meta) {
      await assembleAgentContext(
        s3,
        BUCKET,
        event.tenantId,
        event.jobId,
        meta.appId,
        meta.locality,
        meta.knowledgeBaseIds,
        meta.caseTask,
      );
    }
  } catch (ctxErr) {
    console.error('上下文組裝失敗(不影響執行)', ctxErr);
  }

  try {
    if (event.backend === 'web') {
      // 真實瀏覽器測試:engine 只起 Fargate task(headless Chromium),task 內的 webExplorationRunner
      // 跑 screenshot→VLM→click 迴圈並即時寫 S3(截圖/step/trace/report/終態)。engine 不 block。
      // 起始網址:case YAML 的 url: > App 測試網址(job.package/identifier)> 佔位(readCaseTarget 解析)。
      const { url, task } = await resolveWebTarget(s3, BUCKET, event.tenantId, event.jobId);
      const meta = await readJobMeta(s3, BUCKET, event.tenantId, event.jobId);
      const { startWebRun } = await import('./webHost.js');
      await startWebRun({
        tenantId: event.tenantId,
        jobId: event.jobId,
        appId: meta?.appId ?? event.jobId,
        bucket: BUCKET,
        prefix: `tenants/${event.tenantId}/jobs/${event.jobId}`,
        url,
        ...(event.vlmModel ? { vlmModel: event.vlmModel } : {}),
        ...(task ? { caseTask: task } : {}),
        ...(event.maxSteps && event.maxSteps > 0 ? { maxSteps: event.maxSteps } : {}),
      });
      await writeStatus(s3, BUCKET, event.tenantId, {
        jobId: event.jobId,
        state: 'running',
        message: `網頁探索 task 已啟動(${url})`,
        updatedAt: new Date().toISOString(),
      });
    } else if (event.backend === 'emulator') {
      // 雲端 Redroid 模擬器(主機自驅動):引擎只起 EC2 主機,主機 userdata 自己
      // 裝 Redroid + 裝 APK + 跑截圖/VLM/input 迴圈 + 寫終態 status + 自我終結。
      // 引擎不 block —— 起完主機即返回,任務維持 running,終態由主機寫入(終態吸收保證正確)。
      const meta = await readJobMeta(s3, BUCKET, event.tenantId, event.jobId);
      const { EmulatorHostControl } = await import('./emulatorHost.js');
      const host = new EmulatorHostControl();
      const { instanceId } = await host.provisionHost(
        {
          tenantId: event.tenantId,
          jobId: event.jobId,
          ...(meta?.abi ? { abi: meta.abi } : {}),
          ...(event.vlmModel ? { vlmModel: event.vlmModel } : {}),
          budgetUsd,
        },
        'emulator',
      );
      // 記錄已起主機(供審計/回收追蹤);狀態維持 running,主機終態會覆蓋。
      await writeStatus(s3, BUCKET, event.tenantId, {
        jobId: event.jobId,
        state: 'running',
        message: `emulator 主機已啟動(${instanceId}),裝置準備中`,
        updatedAt: new Date().toISOString(),
      });
    } else if (event.backend === 'devicefarm') {
      // Device Farm 真機:engine 只起 Fargate task,task 內的 runner 自行讀 APK、上傳
      // Device Farm、開 Remote Access session 並跑 Appium 探索迴圈(不 block,終態由 runner
      // 寫回)。真機有真實網路/GMS,可通過遊戲伺服器對模擬器環境的檢查(解決 Redroid 的 50019999)。
      const meta = await readJobMeta(s3, BUCKET, event.tenantId, event.jobId);
      if (!meta?.artifactKey) {
        await writeStatus(s3, BUCKET, event.tenantId, {
          jobId: event.jobId,
          state: 'error',
          message: 'Device Farm 需要被測產物(APK/IPA),但 job 無 artifactKey',
          updatedAt: new Date().toISOString(),
        });
      } else {
        const { startDeviceFarmRun } = await import('./deviceFarmHost.js');
        const platform = meta.platform === 'ios' ? 'ios' : 'android';
        // engine 只起 Fargate task(不 block);讀 APK/上傳 Device Farm/開真機 session 等重活
        // 都在 task 內的 runner 做(engine 512MB/5 分撐不住數百 MB APK)。終態由 runner 寫回。
        await startDeviceFarmRun({
          tenantId: event.tenantId,
          jobId: event.jobId,
          appId: meta.appId,
          bucket: BUCKET,
          prefix: `tenants/${event.tenantId}/jobs/${event.jobId}`,
          artifactKey: meta.artifactKey,
          ...(meta.package ? { package: meta.package } : {}),
          platform,
          ...(event.vlmModel ? { vlmModel: event.vlmModel } : {}),
          ...(meta.caseTask ? { caseTask: meta.caseTask } : {}),
          ...(event.maxSteps && event.maxSteps > 0 ? { maxSteps: event.maxSteps } : {}),
          // 使用者提交時明選的裝置:deviceArn 直接指定實體真機(runner 短路挑此台);
          // deviceModel 僅顯示用;osVersion(若無明選 ARN)收斂 OS 區間讓挑機更貼近所選版本。
          ...(meta.deviceArn ? { deviceArn: meta.deviceArn } : {}),
          ...(meta.deviceModel ? { deviceModel: meta.deviceModel } : {}),
          ...(() => {
            if (meta.deviceArn) return {}; // 已指定裝置就不必再靠 OS 區間挑
            const v = meta.osVersion ? parseFloat(meta.osVersion) : NaN;
            return Number.isFinite(v) ? { maxOsVersion: v, minOsVersion: v } : {};
          })(),
        });
        await writeStatus(s3, BUCKET, event.tenantId, {
          jobId: event.jobId,
          state: 'running',
          message: 'Device Farm 探索 task 已啟動(上傳 APK 並開真機中)',
          updatedAt: new Date().toISOString(),
        });
      }
    } else {
      // windows / attached 仍為後續接入。
      await writeStatus(s3, BUCKET, event.tenantId, {
        jobId: event.jobId,
        state: 'error',
        message: `backend ${event.backend} 尚未支援`,
        updatedAt: new Date().toISOString(),
      });
    }
  } catch (err) {
    await writeStatus(s3, BUCKET, event.tenantId, {
      jobId: event.jobId,
      state: 'error',
      message: err instanceof Error ? err.message : String(err),
      updatedAt: new Date().toISOString(),
    });
  }
}
