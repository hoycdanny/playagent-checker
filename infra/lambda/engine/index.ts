import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { STSClient } from '@aws-sdk/client-sts';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { appCredentialsSecretName } from '../api/appCredentialsStore.js';
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
import { readNavigationSummary } from '../api/memoryStructure.js';
import { retrieveFromKb } from '../api/bedrockKb.js';
import { applyExclude, mergeProfiles } from '../api/report/profiles.js';
import { mergeSpecs, specFromKb } from '../api/report/reportSpec.js';
import { buildControlsProtocol, sanitizeControls } from '../api/controlSchemes.js';
import {
  defaultSeatSelection,
  resolveExecutionConfig,
  PricingError,
  type SeatSelection,
  type ExecutionConfigSnapshot,
} from './costGuard.js';

const REGION = process.env.AWS_REGION ?? 'us-west-2';
const BUCKET = process.env.DATA_BUCKET ?? '';
const TENANT_ROLE_ARN = process.env.TENANT_ROLE_ARN ?? '';

const sts = new STSClient({ region: REGION });
// 共用知識庫(shared/*)用引擎自身角色讀取(唯讀),不經租戶隔離角色。
const sharedS3 = new S3Client({ region: REGION });
// App 憑證:engine 只讀 secret 以「列出 key 名」注入 context(值不進 context/log,見 readAppCredentialKeys)。
const secretsClient = new SecretsManagerClient({ region: REGION });

/**
 * 讀某 App 憑證表,分成兩類供 context 注入:
 *   - maskedKeys:visible=false 的 key 名(只給名稱,值不外流;AI 在 type 用 ${key},runner 才替換)。
 *   - visible:visible=true 的 {key,value}(值會注入 context,讓 AI 在下拉/清單「點對」正確項目,
 *     例如伺服器名稱=daily-aws;這類點選操作無法用遮蔽佔位完成)。
 * 相容舊式純字串 entry → 視為遮蔽。取不到回空。
 */
async function readAppCredentialInfo(
  tenantId: string,
  appId: string,
): Promise<{ maskedKeys: string[]; visible: Array<{ key: string; value: string }> }> {
  const empty = { maskedKeys: [] as string[], visible: [] as Array<{ key: string; value: string }> };
  if (!appId) return empty;
  try {
    const res = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: appCredentialsSecretName(tenantId, appId) }),
    );
    if (typeof res.SecretString !== 'string' || res.SecretString === '') return empty;
    const parsed = JSON.parse(res.SecretString);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;
    const maskedKeys: string[] = [];
    const visible: Array<{ key: string; value: string }> = [];
    for (const [k, raw] of Object.entries(parsed)) {
      if (raw && typeof raw === 'object' && (raw as { visible?: unknown }).visible === true) {
        const v = (raw as { value?: unknown }).value;
        visible.push({ key: k, value: typeof v === 'string' ? v : String(v ?? '') });
      } else {
        maskedKeys.push(k); // 純字串或 visible!==true 一律遮蔽
      }
    }
    maskedKeys.sort();
    visible.sort((a, b) => a.key.localeCompare(b.key));
    return { maskedKeys, visible };
  } catch {
    return empty;
  }
}

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
  genres: string[];
  controls?: { ids: string[]; source: 'case' | 'genre' };
  maxHours?: number;
  display?: { width: number; height: number };
  scripted?: boolean;
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
      genres?: string[];
      controls?: { ids?: unknown; source?: string };
      maxHours?: number;
      display?: { width?: unknown; height?: unknown };
      scripted?: boolean;
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
      genres: Array.isArray(job.genres) ? job.genres.filter((g): g is string => typeof g === 'string') : [],
      ...(job.controls
        ? { controls: { ids: sanitizeControls(job.controls.ids), source: job.controls.source === 'case' ? ('case' as const) : ('genre' as const) } }
        : {}),
      ...(typeof job.maxHours === 'number' && job.maxHours > 0 ? { maxHours: job.maxHours } : {}),
      ...(job.display && Number.isInteger(job.display.width) && Number.isInteger(job.display.height)
        ? { display: { width: job.display.width as number, height: job.display.height as number } }
        : {}),
      ...(job.scripted === true ? { scripted: true } : {}),
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
  genres: string[] = [],
  controlsSnap?: { ids: string[]; source: 'case' | 'genre' },
  scripted = false,
): Promise<void> {
  if (!appId) return;
  const [knowledge, memory, kbMarkdown, kbReference, credInfo] = await Promise.all([
    readKnowledge(s3, bucket, tenantId, appId),
    readMemory(s3, bucket, tenantId, appId, locality),
    // 共用知識庫 Markdown(提交時選的,可多選)—— 走 sharedS3(跨租戶),失敗不擋執行。
    composeKnowledgeBases(sharedS3, bucket, knowledgeBaseIds).catch(() => ''),
    // Bedrock KB 檢索(Stage B):以任務目標為 query,對每座已接文件的 KB 撈 top-K 片段。
    retrieveReference(bucket, knowledgeBaseIds, caseTask).catch(() => ''),
    // App 憑證:遮蔽 key(只名稱)+ 可見憑證(連值,供 AI 在下拉/清單點對)。
    readAppCredentialInfo(tenantId, appId).catch(() => ({ maskedKeys: [], visible: [] })),
  ]);
  // 導覽圖(跨測試累積的畫面流程):已知畫面 + 已驗證/常失敗的操作路徑,引導 agent 少走冤枉路。
  // 屬統計觀察(Memory),優先序低於知識,畫面仍以截圖為準。
  const navSummary = await readNavigationSummary(s3, bucket, tenantId, appId).catch(() => '');
  const memoryWithNav = [memory.trim(), navSummary.trim() ? `## 畫面導覽圖(先前測試累積)\n${navSummary.trim()}` : '']
    .filter(Boolean)
    .join('\n\n');
  let context = composeContext(knowledge, memoryWithNav);
  // 注入順序/優先序:手寫 App 知識 > 知識庫 Markdown > KB 檢索片段 > 記憶。
  if (kbMarkdown.trim()) {
    const kbBlock = `# KNOWLEDGE BASES (selected reusable knowledge)\n${kbMarkdown.trim()}`;
    context = context.trim() ? `${context}\n\n${kbBlock}` : kbBlock;
  }
  if (kbReference.trim()) {
    const refBlock = `# KNOWLEDGE BASE REFERENCES (retrieved for this task — lower priority than authored knowledge)\n${kbReference.trim()}`;
    context = context.trim() ? `${context}\n\n${refBlock}` : refBlock;
  }
  // 可用測試資料:兩類。
  //   (A) 遮蔽:只列 key 名,值受保護。AI 在 type 的 text 用 ${key},runner 在輸入到裝置那一刻替換。
  //   (B) 可見:連值列出(如伺服器名稱=daily-aws),供 AI 在下拉/清單「點對」正確項目;若要打字仍可用 ${key}。
  if (credInfo.maskedKeys.length > 0 || credInfo.visible.length > 0) {
    const lines: string[] = ['# 可用測試資料 / AVAILABLE TEST CREDENTIALS'];
    if (credInfo.visible.length > 0) {
      lines.push(
        `可直接使用的資料(用來在畫面/下拉清單中「選對」正確項目):` +
          credInfo.visible.map((c) => `${c.key}=${c.value}`).join('、') +
          `。遇到需要選擇伺服器/區域等選單時,依這些值挑選對應項目;若某欄位是用打字輸入,可在 type 的 text 用 \${key}(如 \${${credInfo.visible[0]!.key}})。`,
      );
    }
    if (credInfo.maskedKeys.length > 0) {
      lines.push(
        `受保護的資料(僅列名稱,值不顯示):${credInfo.maskedKeys.map((k) => `\${${k}}`).join('、')}。` +
          `當畫面需要輸入帳號、密碼等資訊時,請在 type 動作的 text 直接寫對應的 \${key}(如 \${${credInfo.maskedKeys[0]}});` +
          `系統會在真正輸入到裝置的那一刻替換成真實值。切勿自行猜測或明寫帳密,也不要把 \${key} 當成畫面上的字面文字。`,
      );
    }
    const credBlock = lines.join('\n');
    context = context.trim() ? `${context}\n\n${credBlock}` : credBlock;
  }
  // 證據協議(由類型知識庫 + KB 報告規格決定):runner 依此要求 AI 每步回報
  // 模組/機制標註與畫面觀測值,報告引擎再用程式計算指標(數字不由 LLM 決定)。
  const evidence = await buildEvidenceProtocol(genres, knowledgeBaseIds).catch(() => null);
  // 操作行為(控制方案):runner 據此注入操作說明、限定手勢、決定搖桿預設位置。
  const controls = controlsSnap ? buildControlsProtocol(sanitizeControls(controlsSnap.ids), controlsSnap.source) : null;
  // scripted 也要能傳到 runner,即使沒有任何知識/證據/操作段落也要寫出 context.json。
  if (!context.trim() && !evidence && !controls && !scripted) return;
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
        // 只記 key 名(不含遮蔽值),供審計「本次告訴 AI 有哪些可用憑證」。
        // 可見憑證只記 key 名(值雖進了 context 供點對,但審計檔不另存值)。
        credentialKeys: [...credInfo.maskedKeys, ...credInfo.visible.map((c) => c.key)].sort(),
        knowledgeBaseIds,
        context,
        ...(evidence ? { evidence } : {}),
        ...(controls ? { controls } : {}),
        ...(scripted ? { scripted: true } : {}),
        assembledAt: new Date().toISOString(),
      }),
      ContentType: 'application/json',
    }),
  );
}

/**
 * 證據協議:合併類型 profile(GLOBAL + genres)與 KB 報告規格,輸出 runner 需要的
 * 模組/機制/觀測欄位清單(只含 id/簡短標籤/提示,控制 prompt 長度)。
 */
async function buildEvidenceProtocol(
  genres: string[],
  knowledgeBaseIds: string[],
): Promise<{
  profiles: string[];
  modules: Array<{ id: string; label: string }>;
  mechanics: Array<{ id: string; label: string }>;
  observe: Array<{ key: string; hint: string; type: string }>;
}> {
  const kbs = (await Promise.all(knowledgeBaseIds.map((id) => getKnowledgeBase(sharedS3, BUCKET, id).catch(() => null))))
    .filter((k): k is NonNullable<typeof k> => k !== null);
  // 與報告引擎一致:類別型知識庫綁定的類型也帶入 profile;再套用知識庫的停用清單。
  const allGenres = [...new Set([...genres, ...kbs.map((k) => k.genre).filter((g): g is string => Boolean(g))])];
  const spec = mergeSpecs(kbs.map((k) => specFromKb(k)));
  const merged = applyExclude(mergeProfiles(allGenres), spec.exclude);
  const modules = [...merged.modules, ...spec.modules.filter((m) => !merged.modules.some((x) => x.id === m.id))];
  // 知識庫自訂觀測欄位放前面(針對這款遊戲,比通用欄位重要;後面會截到 8 個)。
  const observe = [...spec.observe, ...merged.observe.filter((o) => !spec.observe.some((x) => x.key === o.key))];
  return {
    profiles: merged.sources.map((s) => `${s.id}-v${s.version}`),
    modules: modules.map((m) => ({ id: m.id, label: m.label.zh })),
    mechanics: merged.mechanics.map((m) => ({ id: m.id, label: m.label.zh })),
    observe: observe.slice(0, 8).map((o) => ({ key: o.key, hint: o.hint, type: o.type })),
  };
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

  // 生效的 VLM 定位模型(解析後的 seat,非只有使用者明選)。未明選時預設 seat(如 UI-TARS)也要
  // 傳到 runner,否則 runner 只會用它自己的內建預設(通用 VLM),預設精準定位形同虛設。
  const resolvedVlmModel =
    snapshot.seats.find((s) => s.seat === 'vlm')?.modelId ?? event.vlmModel;
  const seatModel = (seat: 'agent' | 'subagent'): string | undefined =>
    snapshot.seats.find((s) => s.seat === seat)?.modelId;

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
        meta.genres,
        meta.controls,
        meta.scripted === true,
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
        ...(resolvedVlmModel ? { vlmModel: resolvedVlmModel } : {}),
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
          ...(resolvedVlmModel ? { vlmModel: resolvedVlmModel } : {}),
          ...(seatModel('agent') ? { agentModel: seatModel('agent')! } : {}),
          ...(seatModel('subagent') ? { subagentModel: seatModel('subagent')! } : {}),
          ...(event.maxSteps && event.maxSteps > 0 ? { maxSteps: event.maxSteps } : {}),
          // 主機保險回收:任務最長時數 + 15 分鐘收尾(沒設 = 12 小時)。
          ttlMinutes: meta?.maxHours ? meta.maxHours * 60 + 15 : 720,
          budgetUsd,
        },
        'emulator',
      );
      // 記錄已起主機(供審計/回收追蹤);狀態維持 running,主機終態會覆蓋。
      await writeStatus(s3, BUCKET, event.tenantId, {
        jobId: event.jobId,
        state: 'running',
        message: `Android 容器主機已啟動(${instanceId}),準備 Redroid 中`,
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
          ...(resolvedVlmModel ? { vlmModel: resolvedVlmModel } : {}),
          // 三個 Agent 協作:決策(agent seat)與輔助(subagent seat)模型也交給 runner。
          ...(seatModel('agent') ? { agentModel: seatModel('agent')! } : {}),
          ...(seatModel('subagent') ? { subagentModel: seatModel('subagent')! } : {}),
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
    } else if (event.backend === 'windows') {
      // Windows:Amazon GameLift Streams(GPU 主機)。engine 只開一個沒有人連線的 stream session,
      // 主機上的 host.ps1 下載遊戲 + 跑 AI runner(本機直呼 Bedrock),終態由 runner 寫回。
      const meta = await readJobMeta(s3, BUCKET, event.tenantId, event.jobId);
      if (!meta?.artifactKey) {
        await writeStatus(s3, BUCKET, event.tenantId, {
          jobId: event.jobId,
          state: 'error',
          message: 'Windows 測試需要先在應用頁上傳遊戲(.exe 安裝檔或 .zip)',
          updatedAt: new Date().toISOString(),
        });
      } else {
        const { startWindowsRun } = await import('./windowsHost.js');
        const run = await startWindowsRun(
          {
            tenantId: event.tenantId,
            jobId: event.jobId,
            appId: meta.appId,
            bucket: BUCKET,
            prefix: `tenants/${event.tenantId}/jobs/${event.jobId}`,
            artifactKey: meta.artifactKey,
            ...(meta.package ? { package: meta.package } : {}),
            ...(resolvedVlmModel ? { vlmModel: resolvedVlmModel } : {}),
            ...(seatModel('agent') ? { agentModel: seatModel('agent')! } : {}),
            ...(seatModel('subagent') ? { subagentModel: seatModel('subagent')! } : {}),
            ...(event.maxSteps && event.maxSteps > 0 ? { maxSteps: event.maxSteps } : {}),
            ...(meta.display ? { display: meta.display } : {}),
            maxMinutes: (meta.maxHours ?? 1) * 60,
          },
          process.env.AWS_REGION ?? 'us-west-2',
        );
        await writeStatus(s3, BUCKET, event.tenantId, {
          jobId: event.jobId,
          state: 'running',
          message: `Windows GPU 主機(GameLift Streams)啟動中,解析度 ${run.display.width}x${run.display.height},最長 ${run.minutes} 分鐘`,
          updatedAt: new Date().toISOString(),
        });
      }
    } else {
      // attached 仍為後續接入。
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
