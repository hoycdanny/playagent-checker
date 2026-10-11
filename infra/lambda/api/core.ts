import type { S3Client } from '@aws-sdk/client-s3';
import {
  tenantFromClaims,
  isAdmin,
  UnauthorizedError,
  ForbiddenError,
  type TenantContext,
} from './tenant.js';
import type { UserAdmin, CreateMemberInput } from './users.js';
import { tenantPrefix } from './tenantCredentials.js';
import {
  ARTIFACT_KINDS,
  createUploadUrl,
  createDownloadUrl,
  type ArtifactKind,
} from './artifacts.js';
import {
  activateAppBuild,
  addAppBuild,
  createApp,
  deleteApp,
  getApp,
  listApps,
  removeAppBuild,
  updateApp,
  validateAddBuild,
  validateCreateApp,
  validateUpdateApp,
  withBuilds,
  NotFoundError as AppNotFoundError,
  ValidationError,
  type AppBuild,
  type AppRecord,
} from './apps.js';
import { artifactKey, deleteArtifactPrefix } from './artifacts.js';
import { APP_ID_RE, AppRunningError, purgeApp } from './appPurge.js';
import {
  activateCaseVersion,
  CASE_VERSION_RE,
  createCase,
  deleteCase,
  ensureCaseVersion,
  getCase,
  getCaseVersion,
  listCases,
  listCasesDetailed,
  listCaseVersions,
  updateCase,
  validateCaseInput,
  ValidationError as CaseValidationError,
  NotFoundError as CaseNotFoundError,
} from './cases.js';
import {
  createJob,
  deleteJob,
  listJobs,
  readJobDetail,
  readReport,
  readTraces,
  validateSubmit,
  writeCancelFlag,
  isValidJobId,
  liveFrameKey,
  localityOf,
  ValidationError as TaskValidationError,
  type Backend,
} from './tasks.js';
import { writeStatus, readStatus } from './status.js';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { listMediaSegments, readAudioLevels, withRecordingUrls } from './liveMedia.js';
import { DEVICE_LOG_KINDS, readDeviceLogs, type DeviceLogKind } from './deviceLogs.js';
import { generateInsights } from './report/insights.js';
import { CATALOG, modelsForSeat, type Seat } from './modelCatalog.js';
import { isPriceable, resolvePrice } from './pricing.js';
import {
  readKnowledge,
  writeKnowledge,
  clearMemory,
  type Locality as MemLocality,
} from './knowledge.js';
import {
  listSecretRefs,
  putSecretRef,
  deleteSecretRef,
  SecretRefError,
} from './secretRefStore.js';
import { tenantSecretPrefix } from './secretRefs.js';
import type { SecretWriter } from './secretValueStore.js';
import {
  buildVersionReport,
  looksLikeToken,
  startUpdate,
  UpdateError,
  type SystemUpdatePorts,
} from './systemUpdate.js';
import {
  getUitarsStatus,
  setUitars,
  uitarsAvailable,
  UitarsSwitchError,
  type UitarsPorts,
} from './uitarsSwitch.js';
import {
  listAppCredentials,
  putAppCredential,
  deleteAppCredential,
  isValidCredentialKey,
} from './appCredentialsStore.js';
import {
  registerDevice,
  listDevices,
  deleteDevice,
  DeviceError,
  type Hasher,
} from './devices.js';
import { readCaseTrend } from './trends.js';
import { aggregateEstimatedCost, buildDailyCost, DEVICE_FARM_USD_PER_MIN, type DeviceSessionUsage, type RealCost } from './cost.js';
import { parseCase, runStats, type CaseOverviewItem } from './caseOverview.js';
import type { TaskListItem } from './tasks.js';
import {
  addHint,
  applyEdit,
  deleteHint,
  HintNotFoundError,
  HintValidationError,
  isTransientScreenName,
  listHints,
  parseEditOp,
  updateHint,
} from './memoryHints.js';
import {
  CommandValidationError,
  listCommands,
  newCommandId,
  validateCommandBody,
  writeCommand,
  type OperatorCommand,
} from './operatorCommands.js';
import { readMemoryOverview, memScreenshotKey } from './memoryStructure.js';
import { generateScenarioTemplates } from './scenarioTemplates.js';
import {
  listKnowledgeBases,
  getKnowledgeBase,
  createKnowledgeBase,
  updateKnowledgeBase,
  deleteKnowledgeBase,
  cloneKnowledgeBase,
  setBedrockCoords,
  validateCreateKb,
  validateUpdateKb,
  ValidationError as KbValidationError,
  NotFoundError as KbNotFoundError,
} from './knowledgeBases.js';
import { genreBuiltinKbId, explorationGoalForGenre, isBuiltinKbId } from './builtinKnowledgeBases.js';
import { buildStructuredReport, type EngineJob, type EngineKb } from './report/engine.js';
import { addKbRefs, getKbUsage, removeKbRefs, syncAppKbRefs, tenantUsageMap } from './kbRefs.js';
import { defaultControlsForGenre, describeControlCatalog, parseCaseControls, reconcileControlsWithText } from './controlSchemes.js';
import { AskValidationError, askTask, cleanQuestion, clearAskHistory, readAskHistory } from './taskAsk.js';
import { describeProfile } from './report/profiles.js';
import type { ReportInsights, StructuredReport } from './report/types.js';
import {
  provisionBedrockKb,
  teardownBedrockKb,
  presignDocUpload,
  listDocs,
  deleteDoc,
  startIngestion,
  getIngestionStatus,
  isKbConfigured,
  KbProvisionError,
} from './bedrockKb.js';

/** 與承載層(Lambda/本地)解耦的請求形狀。 */
export interface ApiRequest {
  method: string;
  path: string;
  /** 已由 authorizer 驗證的 JWT claims(不可信任請求主體自述值)。 */
  claims: unknown;
  /** 已解析的 JSON 請求主體(POST/PUT);GET 為 null。 */
  body?: unknown;
  /** query string 參數。 */
  query?: Record<string, string | undefined>;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

/** 依賴注入:讓核心可用 fake 測試,不綁死 AWS SDK。 */
export interface ApiDeps {
  getTenantS3: (tenantId: string) => Promise<S3Client>;
  /** 共用命名空間(shared/*)的 S3 client,跨租戶共用資源用(如知識庫),不經租戶隔離角色。 */
  sharedS3: S3Client;
  bucket: string;
  /** AI 草擬/編修案例 YAML(baseYaml 有值時為「範本感知編修」)。 */
  draftCase: (description: string, appId: string, baseYaml?: string) => Promise<string>;
  /** 把任務送入分派佇列(注入以利測試)。 */
  enqueueJob: (msg: {
    tenantId: string;
    jobId: string;
    backend: Backend;
    vlmModel?: string;
    /** 各角色模型選擇(agent=控制遊戲、vlm=分析畫面、subagent=子代理);引擎據此解析單價並 Fail Closed。 */
    seats?: { agent?: string; vlm?: string; subagent?: string };
    /** 步數上限(未設=無上限)。 */
    maxSteps?: number;
    /** 預算上限(美元;未設=無上限)。 */
    budgetUsd?: number;
  }) => Promise<void>;
  /** 裝置 token 雜湊/產生(注入以利測試)。 */
  hasher: Hasher;
  /** 列出 Device Farm 真機池(可用手機;唯讀)。選填,未注入時 GET /devices/cloud 回空清單。 */
  listCloudDevices?: () => Promise<CloudDevice[]>;
  /** 列出執行基礎設施現況(容器 / EC2 主機 / GameLift Streams)。選填;未注入時 GET /devices/infra 回空資料。 */
  listRuntimeInfra?: () => Promise<RuntimeInfra>;
  /** 用 LLM 判讀測試項目表的結構(欄位對應);未注入時 POST /cases/parse-sheet 回 501。 */
  parseSheet?: (grid: string[][]) => Promise<unknown>;
  /** 取 AWS 真實成本(Cost Explorer)。選填;未注入或失敗時費用頁只顯示估算成本。 */
  getRealCost?: (opts: { start?: string; end?: string }) => Promise<RealCost>;
  /** 列出 Device Farm remote access session 的實際計量分鐘(費用頁依任務歸屬)。選填。 */
  listDeviceSessions?: () => Promise<DeviceSessionUsage[]>;
  /** 成員管理(admin 專用)。選填;未注入時 /users 路由回 501。 */
  userAdmin?: UserAdmin;
  /** 測試憑證值寫入(Secrets Manager)。選填;未注入時 /secret-refs 僅登記名稱不存值。 */
  secretWriter?: SecretWriter;
  /** 系統更新(admin 專用)。選填;未注入時 /system/* 回 501。 */
  systemUpdate?: { ports: SystemUpdatePorts; repo: string };
  /**
   * UI-TARS 開關(admin 專用,系統管理頁)。選填;未注入時 /system/uitars 回 501,
   * 且 UI-TARS 一律視為關閉(模型清單不列、提交被拒)。
   */
  uitars?: { ports: UitarsPorts; endpointName: string; instanceType: string };
  /** 任務 AI 問答用的 Bedrock client(測試注入;未注入時 taskAsk 自建)。 */
  askBedrock?: Pick<import('@aws-sdk/client-bedrock-runtime').BedrockRuntimeClient, 'send'>;
}

/** Device Farm 真機池的精簡呈現(供裝置管理頁顯示 + 提交任務時挑機)。 */
export interface CloudDevice {
  /** 裝置 ARN(提交任務時當 deviceArn 明確指定要跑哪台)。 */
  arn?: string;
  name: string;
  os: string;
  arch: string;
  manufacturer: string;
  formFactor: string;
  availability?: string;
  /** 螢幕解析度(如 "1080x2340")。 */
  resolution?: string;
  /** 記憶體(位元組)。 */
  memoryBytes?: number;
  /** CPU 描述(如 "Qualcomm Snapdragon ... 2.84 GHz")。 */
  cpu?: string;
}

/**
 * 執行基礎設施現況(裝置管理頁的「容器 / 主機 / 串流」三區)。
 *
 * 這是**平台層**資料,不是租戶資料:ECS task、EC2 instance、GameLift stream group
 * 都是整個帳號共用的執行資源(和 /devices/cloud 一樣不經租戶隔離角色)。
 * 任何一段讀取失敗就把該段標進 errors,前端顯示「無法讀取」而不是假裝 0。
 */
export interface RuntimeInfra {
  /** Fargate 容器(Device Farm 控制器 / Web runner / Redroid 容器)。 */
  containers: {
    taskArn: string;
    cluster: string;
    status: string;
    cpu?: string;
    memory?: string;
    startedAt?: string;
  }[];
  /** 每任務 EC2 主機(Graviton + Redroid)。 */
  hosts: {
    instanceId: string;
    instanceType: string;
    state: string;
    az?: string;
    launchedAt?: string;
    jobId?: string;
  }[];
  /** GameLift Streams(Windows GPU 串流)容量與進行中的 session。 */
  streams: {
    groupId: string;
    status?: string;
    locations: {
      location: string;
      alwaysOn?: number;
      onDemand?: number;
      allocated?: number;
      idle?: number;
      status?: string;
    }[];
    activeSessions?: number;
  } | null;
  errors?: string[];
}

function json(status: number, body: unknown): ApiResponse {
  return { status, body };
}

/**
 * API 核心:純 Request→Response,claims 已由 authorizer 驗證。
 * 租戶身分只從 claims 推導(Req 1.2/1.3),身分推不出即 401(Req 1.4)。
 */
export async function handleRequest(
  req: ApiRequest,
  deps: ApiDeps,
): Promise<ApiResponse> {
  let tenant: TenantContext;
  try {
    tenant = tenantFromClaims(req.claims);
  } catch (err) {
    if (err instanceof UnauthorizedError) return json(401, { error: err.message });
    throw err;
  }

  const route = `${req.method} ${req.path}`;

  try {
    switch (route) {
      case 'GET /me':
        return json(200, {
          tenantId: tenant.tenantId,
          email: tenant.email,
          isAdmin: isAdmin(req.claims),
        });

      // ── 系統更新(admin 專用)────────────────────────────────────────
      // 這些路由最終會觸發 CodeBuild 以 CDK 重新部署整個平台,blast radius 是整個帳號,
      // 所以一律 requireAdmin,並且每次觸發都寫審計紀錄(誰、何時、哪個版本)。
      case 'GET /system/version': {
        requireAdmin(req.claims);
        if (!deps.systemUpdate) return json(501, { error: '系統更新未設定' });
        const report = await buildVersionReport(deps.systemUpdate.ports, deps.systemUpdate.repo);
        return json(200, report);
      }

      case 'GET /system/history': {
        requireAdmin(req.claims);
        if (!deps.systemUpdate) return json(501, { error: '系統更新未設定' });
        const items = await deps.systemUpdate.ports.readHistory();
        return json(200, { items });
      }

      case 'POST /system/update': {
        requireAdmin(req.claims);
        if (!deps.systemUpdate) return json(501, { error: '系統更新未設定' });
        const body = (req.body ?? {}) as Record<string, unknown>;
        const ref = typeof body.ref === 'string' ? body.ref.trim() : '';
        if (!ref) throw new BadRequestError('ref 為必填(要部署的 tag / 分支 / commit sha)');
        try {
          const started = await startUpdate(deps.systemUpdate.ports, deps.systemUpdate.repo, {
            ref,
            by: tenant.email ?? tenant.tenantId,
            ...(body.runTests === false ? { runTests: false } : {}),
            ...(body.force === true ? { force: true } : {}),
          });
          return json(202, started);
        } catch (err) {
          if (err instanceof UpdateError) return json(409, { error: err.message });
          throw err;
        }
      }

      case 'PUT /system/github-token': {
        requireAdmin(req.claims);
        if (!deps.systemUpdate) return json(501, { error: '系統更新未設定' });
        const body = (req.body ?? {}) as Record<string, unknown>;
        const token = typeof body.token === 'string' ? body.token.trim() : '';
        // 只回「已設定」,永不回傳或記錄 token 本身。
        if (!looksLikeToken(token)) throw new BadRequestError('token 格式不正確(至少 20 個字元,只含英數與 - _)');
        await deps.systemUpdate.ports.writeToken(token);
        return json(200, { tokenConfigured: true });
      }

      // UI-TARS 開關:開啟會建 SageMaker GPU endpoint(按小時計費),所以只有 admin 能動。
      case 'GET /system/uitars': {
        requireAdmin(req.claims);
        if (!deps.uitars) return json(501, { error: 'UI-TARS 開關未設定' });
        return json(200, await getUitarsStatus(deps.uitars.ports, deps.uitars));
      }

      case 'PUT /system/uitars': {
        requireAdmin(req.claims);
        if (!deps.uitars) return json(501, { error: 'UI-TARS 開關未設定' });
        const body = (req.body ?? {}) as Record<string, unknown>;
        if (typeof body.enabled !== 'boolean') throw new BadRequestError('enabled 必須是 true 或 false');
        try {
          const status = await setUitars(deps.uitars.ports, deps.uitars, body.enabled, tenant.email ?? tenant.tenantId);
          return json(200, status);
        } catch (err) {
          if (err instanceof UitarsSwitchError) return json(409, { error: err.message });
          throw err;
        }
      }

      case 'GET /users': {
        // 成員管理(admin 專用):列出本 user pool 使用者。
        requireAdmin(req.claims);
        if (!deps.userAdmin) return json(501, { error: '成員管理未設定' });
        const items = await deps.userAdmin.listMembers();
        return json(200, { items });
      }

      case 'POST /users': {
        // 成員管理(admin 專用):新增使用者(email/密碼/租戶;可選設為 admin)。
        requireAdmin(req.claims);
        if (!deps.userAdmin) return json(501, { error: '成員管理未設定' });
        const input = validateCreateMember(req.body);
        const member = await deps.userAdmin.createMember(input);
        return json(201, member);
      }

      case 'GET /apps': {
        const s3 = await deps.getTenantS3(tenant.tenantId);
        const records = await listApps(s3, deps.bucket, tenant.tenantId);
        // 為有圖示的 App 附上限時 presigned GET URL(小截圖直顯,位元組不經 Lambda)。
        // withBuilds:只有舊 artifactId 沒有 builds[] 的 App,讀取時補成「一個版本」,
        // 前端就能一致地處理版本清單(不改寫 S3)。
        const items = await Promise.all(
          records.map((r) => enrichAppIcon(s3, deps.bucket, tenant.tenantId, withBuilds(r))),
        );
        return json(200, { items });
      }

      case 'POST /apps': {
        const input = validateCreateApp(req.body);
        const s3 = await deps.getTenantS3(tenant.tenantId);
        const record = await createApp(s3, deps.bucket, tenant.tenantId, input);
        // 知識庫引用索引(刪除防呆);失敗不擋建立。
        await addKbRefs(deps.sharedS3, deps.bucket, record.defaultKnowledgeBaseIds, { type: 'app', tenantId: tenant.tenantId, appId: record.id }).catch(() => {});
        const enriched = await enrichAppIcon(s3, deps.bucket, tenant.tenantId, record);
        return json(201, enriched);
      }

      case 'POST /uploads': {
        const parsed = parseUploadBody(req.body);
        const s3 = await deps.getTenantS3(tenant.tenantId);
        const { url, key } = await createUploadUrl(
          s3,
          deps.bucket,
          tenant.tenantId,
          parsed.artifactId,
          parsed.kind,
        );
        return json(200, { url, key, artifactId: parsed.artifactId });
      }

      case 'GET /knowledge-bases': {
        // 共用知識庫(跨租戶):所有登入使用者共用同一批。走 sharedS3,不隔租戶。
        const items = await listKnowledgeBases(deps.sharedS3, deps.bucket);
        // 附上「目前租戶」的使用數(App 預設 + 任務),供列表顯示「使用中」與刪除前提示。
        // 掃描失敗不擋列表(只是看不到使用數)。
        const s3 = await deps.getTenantS3(tenant.tenantId);
        const usage = await tenantUsageMap(s3, deps.bucket, tenant.tenantId).catch(() => null);
        const withUsage = usage
          ? items.map((k) => ({ ...k, usage: usage.get(k.id) ?? { apps: 0, jobs: 0 } }))
          : items;
        // globalTemplate:所有類型都會套用的通用規則/門檻(知識庫頁規格編輯器可逐項停用/覆寫)。
        return json(200, { items: withUsage, globalTemplate: describeProfile('global') });
      }

      case 'POST /knowledge-bases': {
        const input = validateCreateKb(req.body);
        const record = await createKnowledgeBase(deps.sharedS3, deps.bucket, input);
        // 若請求要求接文件檢索(PDF/文件),runtime 建整座 Bedrock KB(有雲資源與成本)。
        const wantRetrieval = (req.body as { enableRetrieval?: boolean })?.enableRetrieval === true;
        if (wantRetrieval && isKbConfigured()) {
          try {
            const coords = await provisionBedrockKb(deps.bucket, record.id);
            const withCoords = await setBedrockCoords(deps.sharedS3, deps.bucket, record.id, {
              bedrockKbId: coords.bedrockKbId,
              bedrockKbArn: coords.bedrockKbArn,
              dataSourceId: coords.dataSourceId,
              vectorBucketName: coords.vectorBucketName,
              indexName: coords.indexName,
              docsPrefix: coords.docsPrefix,
            });
            return json(201, withCoords);
          } catch (err) {
            // 建 Bedrock KB 失敗:保留已建的 Markdown 記錄,回帶警告(前端可提示重試接文件)。
            return json(201, {
              ...record,
              provisionError: err instanceof Error ? err.message : String(err),
            });
          }
        }
        return json(201, record);
      }

      case 'GET /control-schemes': {
        // 遊戲操作行為目錄(建立測試腳本時的圖像化勾選;依類型預選建議)。
        return json(200, describeControlCatalog());
      }

      case 'GET /cases/overview': {
        // 案例總覽:解析後的案例設定 + 執行統計(次數/通過率/最近結果/費用,含真機分鐘)。
        const s3 = await deps.getTenantS3(tenant.tenantId);
        const [cases, { items: jobs }, sessions] = await Promise.all([
          listCasesDetailed(s3, deps.bucket, tenant.tenantId),
          listJobs(s3, deps.bucket, tenant.tenantId),
          deps.listDeviceSessions ? deps.listDeviceSessions().catch(() => null) : Promise.resolve(null),
        ]);
        const minutes = new Map<string, number>();
        for (const s of sessions ?? []) if (s.jobId) minutes.set(s.jobId, (minutes.get(s.jobId) ?? 0) + s.meteredMinutes);
        const costOf = (t: TaskListItem) =>
          (typeof t.billableSpendUsd === 'number' ? t.billableSpendUsd : 0) + (minutes.get(t.jobId) ?? 0) * DEVICE_FARM_USD_PER_MIN;
        const byCase = new Map<string, TaskListItem[]>();
        for (const j of jobs) {
          const k = `${j.appId}/${j.caseId}`;
          byCase.set(k, [...(byCase.get(k) ?? []), j]);
        }
        const items: CaseOverviewItem[] = cases.map((c) => ({
          id: c.id,
          app: c.app,
          name: c.name,
          ...(c.version ? { version: c.version } : {}),
          ...(c.updatedAt ? { updatedAt: c.updatedAt } : {}),
          versionCount: c.versionCount,
          parsed: parseCase(c.yaml),
          stats: runStats(byCase.get(`${c.app}/${c.id}`) ?? [], c.version, costOf),
        }));
        items.sort((a, b) => (b.stats.last?.createdAt ?? b.updatedAt ?? '').localeCompare(a.stats.last?.createdAt ?? a.updatedAt ?? ''));
        return json(200, { items, deviceDataAvailable: sessions !== null });
      }

      case 'GET /cases': {
        // ?app= 只回該 App 的案例(工作區用;不帶則回全租戶)。
        const s3 = await deps.getTenantS3(tenant.tenantId);
        const all = await listCases(s3, deps.bucket, tenant.tenantId);
        const app = req.query?.['app'];
        return json(200, { items: app ? all.filter((c) => c.app === app) : all });
      }

      case 'GET /reports': {
        // 報告清單 = 任務清單(前端只顯示已終局者)。?app= 只回該 App。
        const s3 = await deps.getTenantS3(tenant.tenantId);
        const { items } = await listJobs(s3, deps.bucket, tenant.tenantId);
        const app = req.query?.['app'];
        return json(200, { items: app ? items.filter((x) => x.appId === app) : items });
      }

      case 'GET /models': {
        // 模型目錄(Req 8):可依 seat 過濾。不需租戶 S3。
        // 附上每模型的當前有效單價(input/output 每百萬 token),供前端下拉呈現費用。
        const seat = req.query?.['seat'] as Seat | undefined;
        const all = seat ? modelsForSeat(seat) : CATALOG;
        // UI-TARS 只有在系統管理頁開啟(endpoint InService)時才列出;關閉時選了也不能用。
        const hasUitars = all.some((m) => m.modelId === 'uitars');
        const uitarsOn = hasUitars && deps.uitars ? await uitarsAvailable(deps.uitars.ports) : false;
        const base = uitarsOn ? all : all.filter((m) => m.modelId !== 'uitars');
        const items = base.map((m) => {
          try {
            const p = resolvePrice(m.modelId);
            return {
              ...m,
              pricing: {
                inputPerM: p.inputPerM,
                outputPerM: p.outputPerM,
                ...(p.estimated ? { estimated: true } : {}),
              },
            };
          } catch {
            return m; // 查無價(理論上不會,啟動斷言保證)——原樣回,前端不顯示價
          }
        });
        return json(200, { items });
      }

      case 'GET /knowledge': {
        const app = req.query?.['app'];
        if (!app) return json(400, { error: 'app 為必填' });
        const s3 = await deps.getTenantS3(tenant.tenantId);
        const content = await readKnowledge(s3, deps.bucket, tenant.tenantId, app);
        return json(200, { app, content });
      }

      case 'PUT /knowledge': {
        const b = (req.body ?? {}) as { app?: string; content?: string };
        if (!b.app) return json(400, { error: 'app 為必填' });
        const s3 = await deps.getTenantS3(tenant.tenantId);
        await writeKnowledge(s3, deps.bucket, tenant.tenantId, b.app, b.content ?? '');
        return json(200, { app: b.app });
      }

      case 'POST /memory/clear': {
        const b = (req.body ?? {}) as { app?: string; locality?: string };
        if (!b.app) return json(400, { error: 'app 為必填' });
        const locality: MemLocality = b.locality === 'attached' ? 'attached' : 'cloud';
        const s3 = await deps.getTenantS3(tenant.tenantId);
        const removed = await clearMemory(s3, deps.bucket, tenant.tenantId, b.app, locality);
        return json(200, { app: b.app, locality, removed });
      }

      case 'GET /secret-refs': {
        // 只回引用名稱/標籤,永不回機密值(Req 14.4)。
        const s3 = await deps.getTenantS3(tenant.tenantId);
        const items = await listSecretRefs(s3, deps.bucket, tenant.tenantId);
        return json(200, { items });
      }

      case 'PUT /secret-refs': {
        // 前端傳短鍵(如 TEST_USERNAME)+ 值 + 標籤;後端組出完整機密名(含租戶前綴),
        // 值寫進 Secrets Manager(不落 S3、不回傳),名稱登記進 secret-refs.json。
        // 相容既有用法:也接受已含前綴的完整 name。
        const b = (req.body ?? {}) as { name?: string; key?: string; value?: string; label?: string };
        const prefix = tenantSecretPrefix(tenant.tenantId);
        const rawKey = (b.key ?? b.name ?? '').trim();
        if (!rawKey) return json(400, { error: 'key(或 name)為必填' });
        // 短鍵只允許安全字元(避免注入到機密名);已含前綴則原樣沿用。
        const fullName = rawKey.startsWith(prefix) ? rawKey : `${prefix}${rawKey}`;
        const shortKey = fullName.slice(prefix.length);
        if (!/^[A-Za-z0-9_.-]+$/.test(shortKey)) {
          return json(400, { error: 'key 僅允許英數與 _ . -' });
        }
        // 有帶 value 才寫值(需 secretWriter);沒帶 value 則只更新登記(相容舊行為)。
        if (b.value !== undefined && b.value !== '') {
          if (!deps.secretWriter) return json(501, { error: '未啟用機密值寫入' });
          await deps.secretWriter.putSecretValue(fullName, b.value);
        }
        const s3 = await deps.getTenantS3(tenant.tenantId);
        const entry = await putSecretRef(s3, deps.bucket, tenant.tenantId, {
          name: fullName,
          ...(b.label ? { label: b.label } : {}),
        });
        // 只回名稱/標籤,永不回值(Req 14.4)。
        return json(200, entry);
      }

      case 'DELETE /secret-refs': {
        // 支援短鍵或完整 name;同時刪 Secrets Manager 值與登記。
        const prefix = tenantSecretPrefix(tenant.tenantId);
        const raw = req.query?.['name'] ?? req.query?.['key'];
        if (!raw) return json(400, { error: 'name(或 key)為必填' });
        const fullName = raw.startsWith(prefix) ? raw : `${prefix}${raw}`;
        if (deps.secretWriter) {
          await deps.secretWriter.deleteSecret(fullName).catch(() => {
            /* 刪值失敗不擋登記移除;runner 端缺值會保留佔位並警告 */
          });
        }
        const s3 = await deps.getTenantS3(tenant.tenantId);
        await deleteSecretRef(s3, deps.bucket, tenant.tenantId, fullName);
        return json(200, { name: fullName });
      }

      case 'GET /devices': {
        const s3 = await deps.getTenantS3(tenant.tenantId);
        const items = await listDevices(s3, deps.bucket, tenant.tenantId);
        return json(200, { items });
      }

      case 'GET /devices/cloud': {
        // Device Farm 真機池(唯讀;跨租戶共用的雲端資源,不經租戶 S3)。未注入 lister 則回空清單。
        const items = deps.listCloudDevices ? await deps.listCloudDevices() : [];
        return json(200, { items });
      }

      case 'GET /devices/infra': {
        // 容器(ECS)/ 主機(EC2)/ 串流(GameLift Streams)現況。與 /devices/cloud 同性質:
        // 平台共用資源的唯讀快照,不經租戶 S3。未注入 lister 則回空資料。
        const infra: RuntimeInfra = deps.listRuntimeInfra
          ? await deps.listRuntimeInfra()
          : { containers: [], hosts: [], streams: null, errors: ['未啟用'] };
        return json(200, infra);
      }

      case 'GET /memory': {
        // Memory 導覽關係圖 + 統計(跨測試累積的 App 全景地圖)。app 必填。
        const app = req.query?.['app'];
        if (!app) return json(400, { error: 'app 為必填' });
        const s3 = await deps.getTenantS3(tenant.tenantId);
        const overview = await readMemoryOverview(s3, deps.bucket, tenant.tenantId, app);
        return json(200, overview);
      }

      case 'GET /memory/hints': {
        // 應用記憶(使用者教 AI 的經驗)。
        const app = req.query?.['app'];
        if (!app) return json(400, { error: 'app 為必填' });
        const s3 = await deps.getTenantS3(tenant.tenantId);
        return json(200, { items: await listHints(s3, deps.bucket, tenant.tenantId, app) });
      }

      case 'POST /memory/hints': {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const app = typeof b['app'] === 'string' ? b['app'] : '';
        if (!app) return json(400, { error: 'app 為必填' });
        const s3 = await deps.getTenantS3(tenant.tenantId);
        const hint = await addHint(s3, deps.bucket, tenant.tenantId, app, {
          text: b['text'],
          ...(b['screen'] !== undefined ? { screen: b['screen'] } : {}),
          ...(b['pageId'] !== undefined ? { pageId: b['pageId'] } : {}),
          source: 'manual',
          ...(tenant.email ? { createdBy: tenant.email } : {}),
        });
        return json(201, hint);
      }

      case 'POST /memory/edit': {
        // 記憶地圖手動編修:改名 / 刪畫面 / 刪路徑(與還原)。存成覆寫層,不會被下一次執行洗掉。
        const b = (req.body ?? {}) as Record<string, unknown>;
        const app = typeof b['app'] === 'string' ? b['app'] : '';
        if (!app) return json(400, { error: 'app 為必填' });
        const s3 = await deps.getTenantS3(tenant.tenantId);
        const edits = await applyEdit(s3, deps.bucket, tenant.tenantId, app, parseEditOp(b));
        return json(200, edits);
      }

      case 'GET /memory/screenshot': {
        // 某 Page 截圖的 presigned GET URL(前端關係圖/樣片本用)。
        const app = req.query?.['app'];
        const page = req.query?.['page'];
        if (!app || !page) return json(400, { error: 'app 與 page 為必填' });
        const s3 = await deps.getTenantS3(tenant.tenantId);
        const url = await createDownloadUrl(s3, deps.bucket, memScreenshotKey(tenant.tenantId, app, page));
        return json(200, { url });
      }

      case 'GET /memory/templates': {
        // 由記憶地圖可達路徑生成「測試場景範本」(步驟 4)。app 必填。
        // 無地圖/未探索則回空陣列(前端顯示「先跑一次探索」)。
        const app = req.query?.['app'];
        if (!app) return json(400, { error: 'app 為必填' });
        const s3 = await deps.getTenantS3(tenant.tenantId);
        const { structure } = await readMemoryOverview(s3, deps.bucket, tenant.tenantId, app);
        const templates = generateScenarioTemplates(structure);
        return json(200, { app, items: templates });
      }

      case 'GET /trends': {
        // 案例趨勢與 flaky 分診(Req 12)。app + case 必填。
        const app = req.query?.['app'];
        const caseId = req.query?.['case'];
        if (!app || !caseId) return json(400, { error: 'app 與 case 為必填' });
        const s3 = await deps.getTenantS3(tenant.tenantId);
        const trend = await readCaseTrend(s3, deps.bucket, tenant.tenantId, app, caseId);
        return json(200, trend);
      }

      case 'GET /cost': {
        // 費用分析(方案 C):AWS 真實成本(Cost Explorer)+ 系統內任務估算成本對照。
        // 估算成本:由本租戶任務清單彙整(依應用/模型/月)。
        const s3 = await deps.getTenantS3(tenant.tenantId);
        const [{ items: tasks }, sessions] = await Promise.all([
          listJobs(s3, deps.bucket, tenant.tenantId),
          // Device Farm 實際計量分鐘(依 session 名稱 pa-<jobId>- 歸屬到任務);取不到則裝置費用不計並標示。
          deps.listDeviceSessions
            ? deps.listDeviceSessions().catch((err) => { console.warn('[cost] device sessions', err); return null; })
            : Promise.resolve(null),
        ]);
        const estimated = aggregateEstimatedCost(tasks);
        const rawDays = Number(req.query?.['days']);
        const daily = buildDailyCost(tasks, sessions, {
          days: Number.isFinite(rawDays) && rawDays > 0 ? rawDays : 30,
          includeUnattributed: isAdmin(req.claims),
        });

        // 真實成本:呼叫 Cost Explorer(可能未啟用/無權限/未注入)——失敗時回 available:false,
        // 附說明,前端只呈現估算成本並提示如何啟用。
        const from = req.query?.['from'];
        const to = req.query?.['to'];
        let real: RealCost;
        if (deps.getRealCost) {
          try {
            real = await deps.getRealCost({
              ...(from ? { start: from } : {}),
              ...(to ? { end: to } : {}),
            });
          } catch (err) {
            real = {
              available: false,
              start: from ?? '',
              end: to ?? '',
              currency: 'USD',
              totalUsd: 0,
              byService: [],
              byComponent: [],
              byMonth: [],
              note: err instanceof Error ? err.message : String(err),
            };
          }
        } else {
          real = {
            available: false,
            start: from ?? '',
            end: to ?? '',
            currency: 'USD',
            totalUsd: 0,
            byService: [],
            byComponent: [],
            byMonth: [],
            note: 'Cost Explorer 未設定',
          };
        }

        return json(200, { real, estimated, daily });
      }

      case 'POST /devices/register': {
        const b = (req.body ?? {}) as { label?: string };
        const s3 = await deps.getTenantS3(tenant.tenantId);
        const { device, token } = await registerDevice(
          s3,
          deps.bucket,
          tenant.tenantId,
          { ...(b.label ? { label: b.label } : {}) },
          deps.hasher,
        );
        // token 明文只在此回傳一次(之後任何 API 都不回傳)。
        return json(201, { device, token });
      }

      case 'DELETE /devices': {
        const deviceId = req.query?.['deviceId'];
        if (!deviceId) return json(400, { error: 'deviceId 為必填' });
        const s3 = await deps.getTenantS3(tenant.tenantId);
        await deleteDevice(s3, deps.bucket, tenant.tenantId, deviceId);
        return json(200, { deviceId });
      }

      case 'POST /cases': {
        const input = validateCaseInput(req.body);
        const s3 = await deps.getTenantS3(tenant.tenantId);
        const record = await createCase(s3, deps.bucket, tenant.tenantId, input, tenant.email ?? undefined);
        return json(201, record);
      }

      case 'POST /cases/parse-sheet': {
        // 讀懂格式不固定的測試項目表:只判結構(表頭列 / 資料起始列 / 欄位對應),
        // 不讓模型重寫內容 —— 展開與逐格修正都在前端做。
        if (!deps.parseSheet) return json(501, { error: '未啟用表格判讀' });
        const b = (req.body ?? {}) as { grid?: unknown };
        const grid = Array.isArray(b.grid)
          ? b.grid.map((r) => (Array.isArray(r) ? r.map((c) => (c === null || c === undefined ? '' : String(c))) : []))
          : null;
        if (!grid || grid.length === 0) return json(400, { error: 'grid 為必填(二維字串陣列)' });
        try {
          return json(200, await deps.parseSheet(grid));
        } catch (err) {
          return json(502, { error: err instanceof Error ? err.message : String(err) });
        }
      }

      case 'POST /cases/draft': {
        const parsed = parseDraftBody(req.body);
        const yaml = await deps.draftCase(parsed.description, parsed.appId, parsed.baseYaml);
        return json(200, { yaml });
      }

      case 'GET /tasks': {
        const s3 = await deps.getTenantS3(tenant.tenantId);
        // 分頁:預設只回最新 30 筆(前端漸進載更多),避免對全部任務各讀 4 個 S3 檔的 N+1 展開。
        // ?limit=<n> 覆寫(上限 200);limit 非正數/非法 → 回全部(相容既有全量需求)。
        const limitRaw = req.query?.['limit'];
        const parsed = limitRaw === undefined ? 30 : Number(limitRaw);
        const limit =
          Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : undefined;
        // ?app= 只回該 App 的任務(工作區用)。篩選必須在截斷「之前」做,
        // 否則先取最新 30 筆再篩,冷門 App 會看起來沒有任務。
        const app = req.query?.['app'];
        if (app) {
          const { items: all } = await listJobs(s3, deps.bucket, tenant.tenantId);
          const mine = all.filter((x) => x.appId === app);
          return json(200, { items: limit ? mine.slice(0, limit) : mine, total: mine.length });
        }
        const { items, total } = await listJobs(s3, deps.bucket, tenant.tenantId, {
          ...(limit ? { limit } : {}),
        });
        return json(200, { items, total });
      }

      case 'POST /tasks': {
        return await handleSubmitTask(req, deps, tenant.tenantId);
      }

      default: {
        // 動態路由:GET /apps/{id}(單一 App 詳情,含圖示 URL)
        // 動態路由:App 憑證表(key-value 存 Secrets Manager;值永不回傳,只回 key 名)。
        //   GET    /apps/{id}/credentials        → { keys: [...] }
        //   PUT    /apps/{id}/credentials        body { key, value } 設/更新一個 key
        //   DELETE /apps/{id}/credentials?key=…  刪一個 key
        const credMatch = /^\/apps\/([^/]+)\/credentials$/.exec(req.path);
        if (credMatch) {
          const appId = credMatch[1]!;
          if (!deps.secretWriter) return json(501, { error: '未啟用機密值寫入' });
          if (req.method === 'GET') {
            const items = await listAppCredentials(deps.secretWriter, tenant.tenantId, appId);
            // 只回 {key, visible},永不回值。
            return json(200, { items });
          }
          if (req.method === 'PUT') {
            const b = (req.body ?? {}) as { key?: string; value?: string; visible?: boolean };
            const key = (b.key ?? '').trim();
            if (!key || !isValidCredentialKey(key)) {
              return json(400, { error: 'key 必填,且不可含空白 / 大括號 / $(可用中文)' });
            }
            if (typeof b.value !== 'string' || b.value === '') {
              return json(400, { error: 'value 為必填' });
            }
            const items = await putAppCredential(
              deps.secretWriter, tenant.tenantId, appId, key, b.value, b.visible === true,
            );
            return json(200, { items });
          }
          if (req.method === 'DELETE') {
            const key = (req.query?.['key'] ?? '').trim();
            if (!key) return json(400, { error: 'key 為必填' });
            const items = await deleteAppCredential(deps.secretWriter, tenant.tenantId, appId, key);
            return json(200, { items });
          }
          return json(405, { error: 'method not allowed' });
        }

        // 動態路由:App 版本管理(同一個 App 可保留多個 APK/IPA/EXE 版本)。
        //   POST   /apps/{id}/builds                        新增一版並設為使用中
        //   POST   /apps/{id}/builds/{artifactId}/activate   切換使用中版本
        //   DELETE /apps/{id}/builds/{artifactId}            從清單移除(安裝檔另判是否可刪)
        // 歷史任務的 job.json.artifactVersion 就是這裡的 artifactId,所以舊報告仍指得到
        // 它當時測的那一版;刪版本只影響「之後還能不能再測這一版」。
        const buildsMatch = req.method === 'POST' && /^\/apps\/([^/]+)\/builds$/.exec(req.path);
        if (buildsMatch) {
          const appId = buildsMatch[1]!;
          if (!APP_ID_RE.test(appId)) return json(400, { error: 'appId 格式不正確' });
          const input = validateAddBuild(req.body);
          const s3 = await deps.getTenantS3(tenant.tenantId);
          const record = await addAppBuild(s3, deps.bucket, tenant.tenantId, appId, {
            ...input,
            ...(tenant.email ? { uploadedBy: tenant.email } : {}),
          });
          const enriched = await enrichAppIcon(s3, deps.bucket, tenant.tenantId, withBuilds(record));
          return json(201, enriched);
        }
        const buildActivate = req.method === 'POST' && /^\/apps\/([^/]+)\/builds\/([^/]+)\/activate$/.exec(req.path);
        if (buildActivate) {
          const appId = buildActivate[1]!;
          if (!APP_ID_RE.test(appId)) return json(400, { error: 'appId 格式不正確' });
          const s3 = await deps.getTenantS3(tenant.tenantId);
          const record = await activateAppBuild(s3, deps.bucket, tenant.tenantId, appId, decodeURIComponent(buildActivate[2]!));
          const enriched = await enrichAppIcon(s3, deps.bucket, tenant.tenantId, withBuilds(record));
          return json(200, enriched);
        }
        const buildDelete = req.method === 'DELETE' && /^\/apps\/([^/]+)\/builds\/([^/]+)$/.exec(req.path);
        if (buildDelete) {
          const appId = buildDelete[1]!;
          if (!APP_ID_RE.test(appId)) return json(400, { error: 'appId 格式不正確' });
          const artId = decodeURIComponent(buildDelete[2]!);
          const s3 = await deps.getTenantS3(tenant.tenantId);
          const record = await removeAppBuild(s3, deps.bucket, tenant.tenantId, appId, artId);
          // 安裝檔實體:只有「沒有任何 App 的版本清單還留著它」才刪,否則留在 S3。
          // 歷史任務指向它不影響刪除 —— 報告看的是當時的執行結果,不需要重新安裝。
          const apps = await listApps(s3, deps.bucket, tenant.tenantId);
          const stillUsed = apps.some(
            (a) => a.artifactId === artId || (a.builds ?? []).some((b) => b.artifactId === artId),
          );
          if (!stillUsed) {
            await deleteArtifactPrefix(s3, deps.bucket, tenant.tenantId, artId).catch(() => {});
          }
          const enriched = await enrichAppIcon(s3, deps.bucket, tenant.tenantId, withBuilds(record));
          return json(200, { ...enriched, artifactDeleted: !stillUsed });
        }

        const appGetMatch = req.method === 'GET' && /^\/apps\/([^/]+)$/.exec(req.path);
        if (appGetMatch) {
          const s3 = await deps.getTenantS3(tenant.tenantId);
          const record = await getApp(s3, deps.bucket, tenant.tenantId, appGetMatch[1]!);
          if (!record) return json(404, { error: '找不到 App' });
          const enriched = await enrichAppIcon(s3, deps.bucket, tenant.tenantId, withBuilds(record));
          return json(200, enriched);
        }
        // 動態路由:PUT /apps/{id}(局部更新;修改名稱/平台/識別碼/產物/圖示/備註)
        const appPutMatch = req.method === 'PUT' && /^\/apps\/([^/]+)$/.exec(req.path);
        if (appPutMatch) {
          const patch = validateUpdateApp(req.body);
          const s3 = await deps.getTenantS3(tenant.tenantId);
          const before = await getApp(s3, deps.bucket, tenant.tenantId, appPutMatch[1]!);
          const record = await updateApp(
            s3,
            deps.bucket,
            tenant.tenantId,
            appPutMatch[1]!,
            patch,
          );
          await syncAppKbRefs(deps.sharedS3, deps.bucket, tenant.tenantId, record.id, before?.defaultKnowledgeBaseIds, record.defaultKnowledgeBaseIds).catch(() => {});
          const enriched = await enrichAppIcon(s3, deps.bucket, tenant.tenantId, withBuilds(record));
          return json(200, enriched);
        }
        // 動態路由:DELETE /apps/{id}(刪除被測應用)
        const appDelMatch = req.method === 'DELETE' && /^\/apps\/([^/]+)$/.exec(req.path);
        if (appDelMatch) {
          // 刪工作區 = 連帶刪除底下所有資料(任務/報告、測試情境與版本、記憶、知識、安裝檔、帳密)。
          // 資料多時一次做不完 → 回 202 + done:false,前端再呼叫一次接著刪(App 紀錄最後才刪)。
          const appId = appDelMatch[1]!;
          if (!APP_ID_RE.test(appId)) return json(400, { error: 'appId 格式不正確' });
          const s3 = await deps.getTenantS3(tenant.tenantId);
          const apps = await listApps(s3, deps.bucket, tenant.tenantId);
          const app = apps.find((a) => a.id === appId) ?? null;
          try {
            const result = await purgeApp(
              {
                s3,
                sharedS3: deps.sharedS3,
                bucket: deps.bucket,
                tenantId: tenant.tenantId,
                ...(deps.secretWriter ? { secretWriter: deps.secretWriter } : {}),
                otherApps: apps.filter((a) => a.id !== appId),
                deleteAppRecord: () => deleteApp(s3, deps.bucket, tenant.tenantId, appId),
              },
              appId,
              app,
            );
            return json(result.done ? 200 : 202, { id: appId, ...result });
          } catch (err) {
            if (err instanceof AppRunningError) {
              return json(409, { error: err.message, code: 'APP_HAS_RUNNING_JOBS', running: err.running });
            }
            throw err;
          }
        }
        // 動態路由:GET /knowledge-bases/{id}(讀單一知識庫)
        const kbGetMatch = req.method === 'GET' && /^\/knowledge-bases\/([^/]+)$/.exec(req.path);
        if (kbGetMatch) {
          const record = await getKnowledgeBase(deps.sharedS3, deps.bucket, kbGetMatch[1]!);
          if (!record) return json(404, { error: '找不到知識庫' });
          return json(200, record);
        }
        // 動態路由:PUT /knowledge-bases/{id}(編輯名稱/描述/類別/Markdown)
        const kbPutMatch = req.method === 'PUT' && /^\/knowledge-bases\/([^/]+)$/.exec(req.path);
        if (kbPutMatch) {
          const patch = validateUpdateKb(req.body);
          const record = await updateKnowledgeBase(deps.sharedS3, deps.bucket, kbPutMatch[1]!, patch);
          return json(200, record);
        }
        // 動態路由:GET /knowledge-bases/{id}/usage(誰在用這座知識庫:App 預設 / 測試任務)
        const kbUsageMatch = req.method === 'GET' && /^\/knowledge-bases\/([^/]+)\/usage$/.exec(req.path);
        if (kbUsageMatch) {
          const s3 = await deps.getTenantS3(tenant.tenantId);
          const usage = await getKbUsage(deps.sharedS3, s3, deps.bucket, tenant.tenantId, kbUsageMatch[1]!);
          return json(200, usage);
        }
        // 動態路由:POST /knowledge-bases/{id}/clone(以樣板或既有 KB 為基礎建立自己的知識庫)
        const kbCloneMatch = req.method === 'POST' && /^\/knowledge-bases\/([^/]+)\/clone$/.exec(req.path);
        if (kbCloneMatch) {
          const name = (req.body as { name?: unknown } | null)?.name;
          const record = await cloneKnowledgeBase(deps.sharedS3, deps.bucket, kbCloneMatch[1]!, {
            ...(typeof name === 'string' ? { name } : {}),
          });
          return json(201, record);
        }
        // 動態路由:DELETE /knowledge-bases/{id}(連帶拆 Bedrock KB + 向量資源 + 文件)
        const kbDelMatch = req.method === 'DELETE' && /^\/knowledge-bases\/([^/]+)$/.exec(req.path);
        if (kbDelMatch) {
          const kbId = kbDelMatch[1]!;
          if (isBuiltinKbId(kbId)) return json(400, { error: '內建知識庫為唯讀,不可刪除' });
          // 刪除防呆:仍被 App(預設知識庫)或測試任務引用 → 禁止刪除,回傳引用清單,建議改用封存。
          // 已刪掉的知識庫會讓既有任務重跑與報告規格失去來源,故一律擋下(不提供強制刪除)。
          const tenantS3 = await deps.getTenantS3(tenant.tenantId);
          const usage = await getKbUsage(deps.sharedS3, tenantS3, deps.bucket, tenant.tenantId, kbId);
          if (usage.total > 0) {
            return json(409, {
              error: `知識庫仍被使用中(App ${usage.apps.length + usage.otherTenants.apps} 個、測試任務 ${usage.jobs.length + usage.otherTenants.jobs} 筆),不可刪除;可改為封存。`,
              code: 'KB_IN_USE',
              usage,
            });
          }
          const rec = await getKnowledgeBase(deps.sharedS3, deps.bucket, kbId);
          // 若已接 Bedrock KB,先拆雲資源(容忍部分已刪);失敗不擋刪 registry。
          if (rec?.bedrockKbId && isKbConfigured()) {
            try {
              await teardownBedrockKb(deps.sharedS3, deps.bucket, kbId, {
                ...(rec.bedrockKbId ? { bedrockKbId: rec.bedrockKbId } : {}),
                ...(rec.dataSourceId ? { dataSourceId: rec.dataSourceId } : {}),
                ...(rec.vectorBucketName ? { vectorBucketName: rec.vectorBucketName } : {}),
                ...(rec.indexName ? { indexName: rec.indexName } : {}),
              });
            } catch {
              /* 容忍拆除失敗,仍移除 registry(殘骸由人工/重跑清理) */
            }
          }
          await deleteKnowledgeBase(deps.sharedS3, deps.bucket, kbId);
          return json(200, { id: kbId });
        }
        // 動態路由:POST /knowledge-bases/{id}/provision(把既有 Markdown KB 升級為接文件檢索)
        const kbProvisionMatch =
          req.method === 'POST' && /^\/knowledge-bases\/([^/]+)\/provision$/.exec(req.path);
        if (kbProvisionMatch) {
          const kbId = kbProvisionMatch[1]!;
          if (isBuiltinKbId(kbId)) return json(400, { error: '內建知識庫不可修改' });
          const rec = await getKnowledgeBase(deps.sharedS3, deps.bucket, kbId);
          if (!rec) return json(404, { error: '找不到知識庫' });
          if (rec.bedrockKbId) return json(200, rec); // 已接檢索,冪等回傳
          if (!isKbConfigured()) {
            return json(400, { error: '文件檢索功能未配置(KB 服務角色未設定)' });
          }
          try {
            const coords = await provisionBedrockKb(deps.bucket, kbId);
            const withCoords = await setBedrockCoords(deps.sharedS3, deps.bucket, kbId, {
              bedrockKbId: coords.bedrockKbId,
              bedrockKbArn: coords.bedrockKbArn,
              dataSourceId: coords.dataSourceId,
              vectorBucketName: coords.vectorBucketName,
              indexName: coords.indexName,
              docsPrefix: coords.docsPrefix,
            });
            return json(200, withCoords);
          } catch (err) {
            return json(500, {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        // 動態路由:GET /knowledge-bases/{id}/docs(列文件)
        const kbDocsListMatch =
          req.method === 'GET' && /^\/knowledge-bases\/([^/]+)\/docs$/.exec(req.path);
        if (kbDocsListMatch) {
          const items = await listDocs(deps.sharedS3, deps.bucket, kbDocsListMatch[1]!);
          return json(200, { items });
        }
        // 動態路由:POST /knowledge-bases/{id}/docs/presign(發直傳 URL)
        const kbPresignMatch =
          req.method === 'POST' && /^\/knowledge-bases\/([^/]+)\/docs\/presign$/.exec(req.path);
        if (kbPresignMatch) {
          const b = (req.body ?? {}) as { filename?: string };
          if (!b.filename) return json(400, { error: 'filename 為必填' });
          const { url, key } = await presignDocUpload(
            deps.sharedS3,
            deps.bucket,
            kbPresignMatch[1]!,
            b.filename,
          );
          return json(200, { url, key });
        }
        // 動態路由:DELETE /knowledge-bases/{id}/docs?key=...(刪單一文件)
        const kbDocDelMatch =
          req.method === 'DELETE' && /^\/knowledge-bases\/([^/]+)\/docs$/.exec(req.path);
        if (kbDocDelMatch) {
          const key = req.query?.['key'];
          if (!key) return json(400, { error: 'key 為必填' });
          await deleteDoc(deps.sharedS3, deps.bucket, kbDocDelMatch[1]!, key);
          return json(200, { key });
        }
        // 動態路由:POST /knowledge-bases/{id}/sync(觸發 ingestion)
        const kbSyncMatch =
          req.method === 'POST' && /^\/knowledge-bases\/([^/]+)\/sync$/.exec(req.path);
        if (kbSyncMatch) {
          const rec = await getKnowledgeBase(deps.sharedS3, deps.bucket, kbSyncMatch[1]!);
          if (!rec) return json(404, { error: '找不到知識庫' });
          if (!rec.bedrockKbId || !rec.dataSourceId) {
            return json(400, { error: '此知識庫尚未接文件檢索(無 Bedrock KB)' });
          }
          const ingestionJobId = await startIngestion(rec.bedrockKbId, rec.dataSourceId);
          return json(200, { ingestionJobId });
        }
        // 動態路由:GET /knowledge-bases/{id}/ingestion(查同步狀態)
        const kbIngestMatch =
          req.method === 'GET' && /^\/knowledge-bases\/([^/]+)\/ingestion$/.exec(req.path);
        if (kbIngestMatch) {
          const rec = await getKnowledgeBase(deps.sharedS3, deps.bucket, kbIngestMatch[1]!);
          if (!rec) return json(404, { error: '找不到知識庫' });
          if (!rec.bedrockKbId || !rec.dataSourceId) return json(200, { status: null });
          const status = await getIngestionStatus(rec.bedrockKbId, rec.dataSourceId);
          return json(200, status ?? { status: null });
        }
        // 動態路由:GET /cases/{app}/{id}(讀單一案例 YAML 供編輯)
        const caseGetMatch = req.method === 'GET' && /^\/cases\/([^/]+)\/([^/]+)$/.exec(req.path);
        if (caseGetMatch) {
          const s3 = await deps.getTenantS3(tenant.tenantId);
          const detail = await getCase(
            s3,
            deps.bucket,
            tenant.tenantId,
            caseGetMatch[1]!,
            caseGetMatch[2]!,
          );
          if (!detail) return json(404, { error: '找不到測試案例' });
          return json(200, detail);
        }
        // 動態路由:PUT /cases/{app}/{id}(編輯案例名稱 / YAML)
        const casePutMatch = req.method === 'PUT' && /^\/cases\/([^/]+)\/([^/]+)$/.exec(req.path);
        if (casePutMatch) {
          const b = (req.body ?? {}) as { name?: string; yaml?: string };
          const s3 = await deps.getTenantS3(tenant.tenantId);
          const detail = await updateCase(
            s3,
            deps.bucket,
            tenant.tenantId,
            casePutMatch[1]!,
            casePutMatch[2]!,
            {
              ...(typeof b.name === 'string' ? { name: b.name } : {}),
              ...(typeof b.yaml === 'string' ? { yaml: b.yaml } : {}),
            },
            tenant.email ?? undefined,
          );
          return json(200, detail);
        }
        // 動態路由:GET /cases/{app}/{id}/versions(版本清單,新到舊;舊案例自動補建基準版本)
        const caseVersionsMatch = req.method === 'GET' && /^\/cases\/([^/]+)\/([^/]+)\/versions$/.exec(req.path);
        if (caseVersionsMatch) {
          const s3 = await deps.getTenantS3(tenant.tenantId);
          const res = await listCaseVersions(s3, deps.bucket, tenant.tenantId, caseVersionsMatch[1]!, caseVersionsMatch[2]!);
          return json(200, res);
        }
        // 動態路由:GET /cases/{app}/{id}/versions/{version}(讀單一不可變版本,含 YAML)
        const caseVersionGet = req.method === 'GET' && /^\/cases\/([^/]+)\/([^/]+)\/versions\/([^/]+)$/.exec(req.path);
        if (caseVersionGet) {
          if (!CASE_VERSION_RE.test(caseVersionGet[3]!)) return json(400, { error: '版本號格式不正確' });
          const s3 = await deps.getTenantS3(tenant.tenantId);
          const v = await getCaseVersion(s3, deps.bucket, tenant.tenantId, caseVersionGet[1]!, caseVersionGet[2]!, caseVersionGet[3]!);
          if (!v) return json(404, { error: '找不到案例版本' });
          return json(200, v);
        }
        // 動態路由:POST /cases/{app}/{id}/versions/{version}/activate(切換使用中的版本)
        const caseVersionActivate = req.method === 'POST' && /^\/cases\/([^/]+)\/([^/]+)\/versions\/([^/]+)\/activate$/.exec(req.path);
        if (caseVersionActivate) {
          if (!CASE_VERSION_RE.test(caseVersionActivate[3]!)) return json(400, { error: '版本號格式不正確' });
          const s3 = await deps.getTenantS3(tenant.tenantId);
          const detail = await activateCaseVersion(s3, deps.bucket, tenant.tenantId, caseVersionActivate[1]!, caseVersionActivate[2]!, caseVersionActivate[3]!);
          return json(200, detail);
        }
        // 動態路由:DELETE /cases/{app}/{id}(刪除案例)
        const caseDelMatch = req.method === 'DELETE' && /^\/cases\/([^/]+)\/([^/]+)$/.exec(req.path);
        if (caseDelMatch) {
          const s3 = await deps.getTenantS3(tenant.tenantId);
          await deleteCase(
            s3,
            deps.bucket,
            tenant.tenantId,
            caseDelMatch[1]!,
            caseDelMatch[2]!,
          );
          return json(200, { app: caseDelMatch[1]!, id: caseDelMatch[2]! });
        }
        // 動態路由:DELETE /tasks/{jobId}(刪除整個任務資料夾,含報告 —— 刪報告=刪任務)
        const taskDelMatch = req.method === 'DELETE' && /^\/tasks\/([^/]+)$/.exec(req.path);
        if (taskDelMatch) {
          const jobId = taskDelMatch[1]!;
          if (!isValidJobId(jobId)) return json(400, { error: 'jobId 格式不正確' });
          const s3 = await deps.getTenantS3(tenant.tenantId);
          // 刪前先記下引用的知識庫,刪後解除引用(任務不在了就不再擋知識庫刪除)。
          const jobRec = await readJsonObject<{ knowledgeBaseIds?: string[] }>(
            s3, deps.bucket, `${tenantPrefix(tenant.tenantId)}jobs/${jobId}/job.json`,
          ).catch(() => null);
          await deleteJob(s3, deps.bucket, tenant.tenantId, jobId);
          await removeKbRefs(deps.sharedS3, deps.bucket, jobRec?.knowledgeBaseIds, { type: 'job', tenantId: tenant.tenantId, jobId }).catch(() => {});
          return json(200, { jobId });
        }
        // 動態路由:GET|POST /tasks/{id}/commands(測試人員即時指令;runner 下一步注入 AI)
        const commandsMatch = /^\/tasks\/([^/]+)\/commands$/.exec(req.path);
        if (commandsMatch && (req.method === 'GET' || req.method === 'POST')) {
          const jobId = commandsMatch[1]!;
          if (!isValidJobId(jobId)) return json(400, { error: 'jobId 格式不正確' });
          const s3 = await deps.getTenantS3(tenant.tenantId);
          if (req.method === 'GET') {
            return json(200, { items: await listCommands(s3, deps.bucket, tenant.tenantId, jobId) });
          }
          const input = validateCommandBody(req.body);
          const status = (await readStatus(s3, deps.bucket, tenant.tenantId, jobId))?.status;
          if (!status) return json(404, { error: '找不到任務' });
          if (['pass', 'fail', 'error', 'cancelled', 'budget_exceeded', 'dead'].includes(status.state)) {
            return json(409, { error: '測試已結束,無法再下指令' });
          }
          const jobRec = await readJsonObject<{ appId?: string }>(s3, deps.bucket, `${tenantPrefix(tenant.tenantId)}jobs/${jobId}/job.json`);
          const id = newCommandId();
          // 勾「記住」:同時寫進這個應用的記憶,下次測試 AI 一開始就知道。
          let hintId: string | undefined;
          // 只點了畫面沒打字 → 一次性的點擊,不寫進記憶(沒有可教的內容)。
          if (input.remember && jobRec?.appId && !input.pointOnly) {
            // 載入/過場畫面不當記憶範圍(指令通常是針對「接下來那個畫面」),改存成全應用通用。
            const memScreen = input.screen && !isTransientScreenName(input.screen) ? input.screen : undefined;
            // 有點畫面位置:把大約位置一起記下,下次 AI 知道那個按鈕在哪。
            const pos = input.point ? `(位置約在畫面左起 ${Math.round(input.point.x * 100)}%、上起 ${Math.round(input.point.y * 100)}%)` : '';
            const hint = await addHint(s3, deps.bucket, tenant.tenantId, jobRec.appId, {
              text: `${input.text}${pos}`,
              ...(memScreen ? { screen: memScreen } : {}),
              source: 'operator',
              jobId,
              ...(typeof status.steps === 'number' ? { step: status.steps } : {}),
              ...(tenant.email ? { createdBy: tenant.email } : {}),
            });
            hintId = hint.id;
          }
          const cmd: OperatorCommand = {
            id,
            text: input.text,
            createdAt: new Date().toISOString(),
            ...(tenant.email ? { createdBy: tenant.email } : {}),
            ...(input.screen ? { screen: input.screen } : {}),
            ...(hintId ? { hintId } : {}),
            ...(input.point ? { point: input.point } : {}),
          };
          await writeCommand(s3, deps.bucket, tenant.tenantId, jobId, cmd);
          return json(201, cmd);
        }
        // 動態路由:PUT|DELETE /memory/hints/{id}(編修/刪除應用記憶;?app= 或 body.app)
        const hintMatch = /^\/memory\/hints\/([^/]+)$/.exec(req.path);
        if (hintMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
          const body = (req.body ?? {}) as Record<string, unknown>;
          const app = (typeof body['app'] === 'string' ? body['app'] : undefined) ?? req.query?.['app'];
          if (!app) return json(400, { error: 'app 為必填' });
          const s3 = await deps.getTenantS3(tenant.tenantId);
          if (req.method === 'DELETE') {
            await deleteHint(s3, deps.bucket, tenant.tenantId, app, hintMatch[1]!);
            return json(200, { id: hintMatch[1] });
          }
          const hint = await updateHint(s3, deps.bucket, tenant.tenantId, app, hintMatch[1]!, {
            ...(body['text'] !== undefined ? { text: body['text'] } : {}),
            ...(body['enabled'] !== undefined ? { enabled: body['enabled'] } : {}),
            ...(body['screen'] !== undefined ? { screen: body['screen'] } : {}),
            ...(body['pageId'] !== undefined ? { pageId: body['pageId'] } : {}),
          });
          return json(200, hint);
        }
        // 動態路由:POST /tasks/{id}/cancel
        const cancelMatch = req.method === 'POST' && /^\/tasks\/([^/]+)\/cancel$/.exec(req.path);
        if (cancelMatch) {
          return await handleCancelTask(deps, tenant.tenantId, cancelMatch[1]!);
        }
        // 動態路由:POST /users/{username}/(disable|enable)(admin 專用:停用/啟用成員)。
        const memberToggle =
          req.method === 'POST' && /^\/users\/([^/]+)\/(disable|enable)$/.exec(req.path);
        if (memberToggle) {
          requireAdmin(req.claims);
          if (!deps.userAdmin) return json(501, { error: '成員管理未設定' });
          const username = decodeURIComponent(memberToggle[1]!);
          const enable = memberToggle[2] === 'enable';
          // 自己停用自己 = 立刻把自己鎖在門外,而且沒有別人能幫你開(可能只有一個管理員)。
          if (!enable && isSelf(req.claims, username)) {
            return json(400, { error: '不能停用自己的帳號' });
          }
          await deps.userAdmin.setEnabled(username, enable);
          return json(200, { username, enabled: enable });
        }
        // 動態路由:成員的其他管理動作(全部 admin 專用)。
        //   POST   /users/{u}/password  { password }   重設密碼
        //   POST   /users/{u}/admin     { admin }      設/取消管理員
        //   PUT    /users/{u}           { tenantId }   改租戶
        //   DELETE /users/{u}                          永久刪除
        const memberPassword = req.method === 'POST' && /^\/users\/([^/]+)\/password$/.exec(req.path);
        if (memberPassword) {
          requireAdmin(req.claims);
          if (!deps.userAdmin) return json(501, { error: '成員管理未設定' });
          const b = (req.body ?? {}) as { password?: unknown };
          const password = typeof b.password === 'string' ? b.password : '';
          if (password.length < 8) return json(400, { error: '密碼至少 8 碼' });
          await deps.userAdmin.resetPassword(decodeURIComponent(memberPassword[1]!), password);
          return json(200, { username: decodeURIComponent(memberPassword[1]!) });
        }
        const memberAdmin = req.method === 'POST' && /^\/users\/([^/]+)\/admin$/.exec(req.path);
        if (memberAdmin) {
          requireAdmin(req.claims);
          if (!deps.userAdmin) return json(501, { error: '成員管理未設定' });
          const username = decodeURIComponent(memberAdmin[1]!);
          const b = (req.body ?? {}) as { admin?: unknown };
          const admin = b.admin === true;
          // 自己取消自己的管理員 = 之後連這頁都進不來。
          if (!admin && isSelf(req.claims, username)) {
            return json(400, { error: '不能取消自己的管理員權限' });
          }
          await deps.userAdmin.setAdmin(username, admin);
          return json(200, { username, admin });
        }
        const memberUpdate = req.method === 'PUT' && /^\/users\/([^/]+)$/.exec(req.path);
        if (memberUpdate) {
          requireAdmin(req.claims);
          if (!deps.userAdmin) return json(501, { error: '成員管理未設定' });
          const b = (req.body ?? {}) as { tenantId?: unknown };
          const tenantId = typeof b.tenantId === 'string' ? b.tenantId.trim() : '';
          if (!TENANT_ID_RE.test(tenantId)) {
            return json(400, { error: 'tenantId 僅允許英數與 - _,長度 2~64' });
          }
          await deps.userAdmin.setTenant(decodeURIComponent(memberUpdate[1]!), tenantId);
          return json(200, { username: decodeURIComponent(memberUpdate[1]!), tenantId });
        }
        const memberDelete = req.method === 'DELETE' && /^\/users\/([^/]+)$/.exec(req.path);
        if (memberDelete) {
          requireAdmin(req.claims);
          if (!deps.userAdmin) return json(501, { error: '成員管理未設定' });
          const username = decodeURIComponent(memberDelete[1]!);
          if (isSelf(req.claims, username)) return json(400, { error: '不能刪除自己的帳號' });
          await deps.userAdmin.deleteMember(username);
          return json(200, { username, deleted: true });
        }
        // 動態路由:GET /system/update/{buildId}(進度)與 .../log(建置輸出)。
        const buildLog = req.method === 'GET' && /^\/system\/update\/([^/]+)\/log$/.exec(req.path);
        if (buildLog) {
          requireAdmin(req.claims);
          if (!deps.systemUpdate) return json(501, { error: '系統更新未設定' });
          const build = await deps.systemUpdate.ports.getBuild(decodeURIComponent(buildLog[1]!));
          if (!build) return json(404, { error: '找不到這次更新' });
          if (!build.logGroup || !build.logStream) return json(200, { lines: [], status: build.status });
          const next = req.query?.['next'];
          const page = await deps.systemUpdate.ports.readLog(build.logGroup, build.logStream, next);
          return json(200, { ...page, status: build.status });
        }
        const buildStatus = req.method === 'GET' && /^\/system\/update\/([^/]+)$/.exec(req.path);
        if (buildStatus) {
          requireAdmin(req.claims);
          if (!deps.systemUpdate) return json(501, { error: '系統更新未設定' });
          const build = await deps.systemUpdate.ports.getBuild(decodeURIComponent(buildStatus[1]!));
          if (!build) return json(404, { error: '找不到這次更新' });
          return json(200, build);
        }
        // 動態路由:GET /tasks/{id}/live-frame(即時畫面最新幀的短效 presigned URL)。
        // runner 持續覆寫同一個 live key;前端在任務執行中以 ~3-5fps 輪詢此路由換 <img>。
        // 幀不存在(任務剛起/非即時後端)時簽出的 URL 會 404,前端自行回退顯示。
        const liveMatch = req.method === 'GET' && /^\/tasks\/([^/]+)\/live-frame$/.exec(req.path);
        if (liveMatch) {
          const jobId = liveMatch[1]!;
          if (!isValidJobId(jobId)) return json(400, { error: 'jobId 格式不正確' });
          const s3 = await deps.getTenantS3(tenant.tenantId);
          const url = await createDownloadUrl(s3, deps.bucket, liveFrameKey(tenant.tenantId, jobId));
          return json(200, { url });
        }
        // 動態路由:GET /tasks/{id}/audio-levels(遊戲音效音量時間軸,供執行軌跡標出每步有無音效)
        const levelsMatch = req.method === 'GET' && /^\/tasks\/([^/]+)\/audio-levels$/.exec(req.path);
        if (levelsMatch) {
          const jobId = levelsMatch[1]!;
          if (!isValidJobId(jobId)) return json(400, { error: 'jobId 格式不正確' });
          const s3 = await deps.getTenantS3(tenant.tenantId);
          const levels = await readAudioLevels(s3, deps.bucket, tenant.tenantId, jobId);
          // 附上每段含聲音錄影的下載 URL(任務頁回放用)。
          return json(200, await withRecordingUrls(s3, deps.bucket, tenant.tenantId, jobId, levels));
        }
        // 動態路由:GET /tasks/{id}/device-logs?kind=logcat|audio&after=<檔名>(真機 log,任務詳情頁展開時讀)
        // 動態路由:/tasks/{id}/ask —— 任務 AI 問答(依這次任務的步驟 / 裝置 log / 知識庫 / 報告回答)。
        //   GET 讀對話、POST { question, lang } 發問、DELETE 清空對話。
        const askMatch = /^\/tasks\/([^/]+)\/ask$/.exec(req.path);
        if (askMatch && (req.method === 'GET' || req.method === 'POST' || req.method === 'DELETE')) {
          const jobId = askMatch[1]!;
          if (!isValidJobId(jobId)) return json(400, { error: 'jobId 格式不正確' });
          const s3 = await deps.getTenantS3(tenant.tenantId);
          if (req.method === 'GET') return json(200, { items: await readAskHistory(s3, deps.bucket, tenant.tenantId, jobId) });
          if (req.method === 'DELETE') {
            await clearAskHistory(s3, deps.bucket, tenant.tenantId, jobId);
            return json(200, { items: [] });
          }
          const body = (req.body ?? {}) as { question?: unknown; lang?: unknown };
          const question = cleanQuestion(body.question);
          try {
            return json(200, await askTask(s3, deps.bucket, tenant.tenantId, jobId, question, body.lang === 'en' ? 'en' : 'zh', deps.askBedrock ? { bedrock: deps.askBedrock } : {}));
          } catch (err) {
            if (err instanceof AskValidationError) throw err;
            console.warn('[ask] failed', err);
            return json(502, { error: `AI 問答失敗:${err instanceof Error ? err.message : String(err)}` });
          }
        }
        const devLogMatch = req.method === 'GET' && /^\/tasks\/([^/]+)\/device-logs$/.exec(req.path);
        if (devLogMatch) {
          const jobId = devLogMatch[1]!;
          if (!isValidJobId(jobId)) return json(400, { error: 'jobId 格式不正確' });
          const kind = req.query?.['kind'] ?? 'logcat';
          if (!(DEVICE_LOG_KINDS as readonly string[]).includes(kind)) return json(400, { error: `kind 必須是 ${DEVICE_LOG_KINDS.join('/')} 之一` });
          const s3 = await deps.getTenantS3(tenant.tenantId);
          const after = req.query?.['after'];
          const limit = Number(req.query?.['limit']);
          return json(200, await readDeviceLogs(s3, deps.bucket, tenant.tenantId, jobId, kind as DeviceLogKind, {
            ...(after ? { after } : {}),
            ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
          }));
        }
        // 動態路由:GET /tasks/{id}/live-video|live-audio?after=<檔名>(即時影片 / 含音效段落,依序播放)
        const mediaMatch = req.method === 'GET' && /^\/tasks\/([^/]+)\/live-(video|audio)$/.exec(req.path);
        if (mediaMatch) {
          const jobId = mediaMatch[1]!;
          if (!isValidJobId(jobId)) return json(400, { error: 'jobId 格式不正確' });
          const s3 = await deps.getTenantS3(tenant.tenantId);
          const after = req.query?.['after'];
          const res = await listMediaSegments(s3, deps.bucket, tenant.tenantId, jobId, mediaMatch[2] === 'audio' ? 'audio' : 'live', {
            ...(after ? { after } : {}),
            latest: mediaMatch[2] === 'audio' ? 1 : 2,
          });
          return json(200, res);
        }
        // 動態路由:GET /tasks/{id}/logs(每步完整互動 log:模型/請求摘要/原始回應/錯誤,供除錯)
        const logsMatch = req.method === 'GET' && /^\/tasks\/([^/]+)\/logs$/.exec(req.path);
        if (logsMatch) {
          const jobId = logsMatch[1]!;
          if (!isValidJobId(jobId)) return json(400, { error: 'jobId 格式不正確' });
          const s3 = await deps.getTenantS3(tenant.tenantId);
          // ?seat=vlm|agent|subagent 只讀一個 Agent;?limit=N 最新 N 筆;?summary=1 只回 token/成敗(用量分頁)。
          const seatQ = req.query?.['seat'];
          const limitQ = Number(req.query?.['limit']);
          const traces = await readTraces(s3, deps.bucket, tenant.tenantId, jobId, {
            ...(seatQ === 'vlm' || seatQ === 'agent' || seatQ === 'subagent' ? { seat: seatQ } : {}),
            ...(Number.isFinite(limitQ) && limitQ > 0 ? { limit: Math.min(limitQ, 500) } : {}),
            ...(req.query?.['summary'] === '1' ? { summary: true } : {}),
          });
          return json(200, { items: traces });
        }
        // 動態路由:GET /tasks/{id}/live-metrics(即時指標:用目前已有的步驟跑一次報告引擎,只回指標)
        // 執行中也能算(與報告同一套指標定義與計算);結束後若有 report.json 則用它(含效能等完整資料)。
        const liveMetricsMatch = req.method === 'GET' && /^\/tasks\/([^/]+)\/live-metrics$/.exec(req.path);
        if (liveMetricsMatch) {
          const jobId = liveMetricsMatch[1]!;
          if (!isValidJobId(jobId)) return json(400, { error: 'jobId 格式不正確' });
          const s3 = await deps.getTenantS3(tenant.tenantId);
          const finished = await readReport(s3, deps.bucket, tenant.tenantId, jobId).catch(() => null);
          let raw: Record<string, unknown>;
          if (finished && typeof finished === 'object') {
            raw = finished as Record<string, unknown>;
          } else {
            const detail = await readJobDetail(s3, deps.bucket, tenant.tenantId, jobId);
            if (!detail) return json(404, { error: '找不到任務' });
            raw = {
              jobId,
              state: detail.state,
              steps: detail.steps,
              ...(detail.job?.caseTask ? { task: detail.job.caseTask } : {}),
              ...(detail.updatedAt ? { generatedAt: detail.updatedAt } : {}),
            };
          }
          const structured = await buildReportForJob(deps, s3, tenant.tenantId, jobId, raw, { sign: false });
          const stepCount = Array.isArray(raw['steps']) ? (raw['steps'] as unknown[]).length : 0;
          return json(200, {
            metrics: structured.metrics,
            counts: structured.counts,
            stepCount,
            final: Boolean(finished),
            at: new Date().toISOString(),
          });
        }
        // 動態路由:GET /tasks/{id}(詳情 + steps,供重連補讀 Req 5.4)
        const detailMatch = req.method === 'GET' && /^\/tasks\/([^/]+)$/.exec(req.path);
        if (detailMatch) {
          const jobId = detailMatch[1]!;
          if (!isValidJobId(jobId)) return json(400, { error: 'jobId 格式不正確' });
          const s3 = await deps.getTenantS3(tenant.tenantId);
          const detail = await readJobDetail(s3, deps.bucket, tenant.tenantId, jobId);
          if (!detail) return json(404, { error: '找不到任務' });
          // 為每步截圖(devicefarm/emulator runner 落的 screenshotKey/annotatedKey)附上限時
          // presigned GET URL,讓任務詳情頁能即時圖文並茂顯示(位元組不經 Lambda)。
          await enrichStepScreenshots(s3, deps.bucket, detail.steps as Record<string, unknown>[]);
          return json(200, detail);
        }
        // 動態路由:GET /reports/{id}(報告產出物,Req 6)
        const reportMatch = req.method === 'GET' && /^\/reports\/([^/]+)$/.exec(req.path);
        if (reportMatch) {
          const jobId = reportMatch[1]!;
          if (!isValidJobId(jobId)) return json(400, { error: 'jobId 格式不正確' });
          const s3 = await deps.getTenantS3(tenant.tenantId);
          const report = await readReport(s3, deps.bucket, tenant.tenantId, jobId);
          if (!report) return json(404, { error: '找不到報告' });
          // emulator 報告含 steps/navGraph 與截圖 S3 key —— 為每個截圖附上限時 presigned
          // GET URL,讓前端能直接顯示遊戲畫面/標註圖(位元組不經 Lambda)。
          const enriched = await enrichReportScreenshots(s3, deps.bucket, report);
          // 結構化報告(GenreProfile + Metric + Evidence + Finding + 規則引擎)—— 讀取時計算,
          // 舊報告也適用新版 profile。失敗不擋原始報告(前端回退舊版呈現)。
          if (typeof enriched === 'object' && enriched !== null) {
            try {
              const [structured, insZh, insEn] = await Promise.all([
                buildReportForJob(deps, s3, tenant.tenantId, jobId, enriched as Record<string, unknown>),
                readJsonObject<ReportInsights>(s3, deps.bucket, insightsKey(tenant.tenantId, jobId, 'zh')).catch(() => null),
                readJsonObject<ReportInsights>(s3, deps.bucket, insightsKey(tenant.tenantId, jobId, 'en')).catch(() => null),
              ]);
              (enriched as Record<string, unknown>)['structured'] = structured;
              if (insZh || insEn) {
                (enriched as Record<string, unknown>)['insights'] = { ...(insZh ? { zh: insZh } : {}), ...(insEn ? { en: insEn } : {}) };
              }
            } catch (err) {
              console.warn('[report] structured build failed', err);
            }
          }
          return json(200, enriched);
        }
        // 動態路由:POST /reports/{id}/insights(AI 洞察:需求矩陣 + 根因 + 修正建議;快取到 S3)
        const insightsMatch = req.method === 'POST' && /^\/reports\/([^/]+)\/insights$/.exec(req.path);
        if (insightsMatch) {
          const jobId = insightsMatch[1]!;
          if (!isValidJobId(jobId)) return json(400, { error: 'jobId 格式不正確' });
          const s3 = await deps.getTenantS3(tenant.tenantId);
          const body = (req.body ?? {}) as { force?: unknown; lang?: unknown };
          const force = body.force === true;
          const lang: 'zh' | 'en' = body.lang === 'en' ? 'en' : 'zh';
          const key = insightsKey(tenant.tenantId, jobId, lang);
          if (!force) {
            const cached = await readJsonObject<ReportInsights>(s3, deps.bucket, key).catch(() => null);
            if (cached) return json(200, cached);
          }
          const report = await readReport(s3, deps.bucket, tenant.tenantId, jobId);
          if (!report || typeof report !== 'object') return json(404, { error: '找不到報告' });
          const structured = await buildReportForJob(deps, s3, tenant.tenantId, jobId, report as Record<string, unknown>, { sign: false });
          let insights: ReportInsights;
          try {
            insights = await generateInsights(structured, lang);
          } catch (err) {
            console.warn('[report] insights failed', err);
            return json(502, { error: `AI 洞察產生失敗:${err instanceof Error ? err.message : String(err)}` });
          }
          await s3.send(new PutObjectCommand({ Bucket: deps.bucket, Key: key, Body: JSON.stringify(insights), ContentType: 'application/json' }));
          return json(200, insights);
        }
        return json(404, { error: `未知路由: ${route}` });
      }
    }
  } catch (err) {
    if (err instanceof ForbiddenError) return json(403, { error: err.message });
    if (err instanceof AppNotFoundError) return json(404, { error: err.message });
    if (err instanceof CaseNotFoundError) return json(404, { error: err.message });
    if (err instanceof KbNotFoundError) return json(404, { error: err.message });
    if (err instanceof KbValidationError) return json(400, { error: err.message });
    if (err instanceof HintValidationError) return json(400, { error: err.message });
    if (err instanceof HintNotFoundError) return json(404, { error: err.message });
    if (err instanceof CommandValidationError) return json(400, { error: err.message });
    if (err instanceof KbProvisionError) return json(400, { error: err.message });
    if (err instanceof ValidationError) return json(400, { error: err.message });
    if (err instanceof CaseValidationError) return json(400, { error: err.message });
    if (err instanceof TaskValidationError) return json(400, { error: err.message });
    if (err instanceof BadRequestError) return json(400, { error: err.message });
    if (err instanceof SecretRefError) return json(400, { error: err.message });
    if (err instanceof DeviceError) return json(400, { error: err.message });
    if (err instanceof AskValidationError) return json(err.message === '找不到任務' ? 404 : 400, { error: err.message });
    throw err;
  }
}

class BadRequestError extends Error {}

/**
 * 從案例 YAML 取出 task 內容,支援兩種寫法:
 *  1) 行內:`task: 走到大廳並點開始`
 *  2) YAML 區塊純量:`task: |`(或 `>`) 後接縮排多行 —— 取到縮排結束為止,還原多行文字。
 *
 * 舊版用 /task:\s*(.+)/ 只抓第一行,對 `task: |` 只會抓到 "|",導致多行任務(含登入帳密/步驟)
 * 整段遺失。此函式正確處理區塊純量。回傳去除共同縮排後的多行字串;無 task 則回 undefined。
 */
export function extractCaseTask(yaml: string): string | undefined {
  const lines = yaml.split(/\r?\n/);
  const headIdx = lines.findIndex((l) => /^task:\s*/.test(l));
  if (headIdx < 0) return undefined;
  const head = lines[headIdx]!;
  const afterColon = head.replace(/^task:\s*/, '');
  const trimmed = afterColon.trim();

  // 行內寫法(非區塊指示符):直接用該行內容。
  if (trimmed && trimmed !== '|' && trimmed !== '>' && !/^[|>][+-]?\d*$/.test(trimmed)) {
    return trimmed;
  }

  // 區塊純量:收集後續「比 task: 更深縮排」的行,直到縮排回到同層或更淺(遇到下一個 key)。
  const body: string[] = [];
  for (let i = headIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') { body.push(''); continue; } // 保留空行
    const indent = line.length - line.trimStart().length;
    if (indent === 0) break; // 回到頂層 key,區塊結束
    body.push(line);
  }
  // 去尾端空行
  while (body.length && body[body.length - 1] === '') body.pop();
  if (body.length === 0) return undefined;
  // 去共同縮排(以第一行非空的縮排為基準)。
  const first = body.find((l) => l.trim() !== '') ?? '';
  const baseIndent = first.length - first.trimStart().length;
  const dedented = body.map((l) => (l.length >= baseIndent ? l.slice(baseIndent) : l.trimStart()));
  const text = dedented.join('\n').trim();
  return text || undefined;
}

/** 要求呼叫者為 admin(JWT cognito:groups 含 admins);否則丟 ForbiddenError → 403。 */
function requireAdmin(claims: unknown): void {
  if (!isAdmin(claims)) throw new ForbiddenError('需要管理員權限');
}

/** 租戶 id 允許的格式(用在改租戶;S3 前綴的一段,不能有斜線或空白)。 */
const TENANT_ID_RE = /^[A-Za-z0-9_-]{2,64}$/;

/**
 * 這個動作的對象是不是「操作者自己」。
 * 成員 username 就是 email(建立時以 email 當 username),所以比對 email;
 * 另外也比對 cognito:username,避免 pool 設定改成非 email username 時誤判。
 */
function isSelf(claims: unknown, username: string): boolean {
  const c = (claims ?? {}) as Record<string, unknown>;
  const target = username.trim().toLowerCase();
  const email = String(c['email'] ?? '').trim().toLowerCase();
  const name = String(c['cognito:username'] ?? '').trim().toLowerCase();
  return target !== '' && (target === email || target === name);
}

/** 驗證新增成員輸入。email/password/tenantId 必填;密碼長度 >= 8(對齊 pool 政策)。 */
function validateCreateMember(body: unknown): CreateMemberInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const email = typeof b['email'] === 'string' ? b['email'].trim() : '';
  const password = typeof b['password'] === 'string' ? b['password'] : '';
  const tenantId = typeof b['tenantId'] === 'string' ? b['tenantId'].trim() : '';
  if (!email || !/.+@.+\..+/.test(email)) throw new BadRequestError('email 格式不正確');
  if (password.length < 8) throw new BadRequestError('密碼至少 8 碼');
  if (!tenantId) throw new BadRequestError('tenantId 為必填');
  return { email, password, tenantId, admin: b['admin'] === true };
}

/**
 * 為有圖示的 App 附上限時 presigned GET URL(前端小截圖直顯,位元組不經 Lambda)。
 * 無 iconArtifactId 則原樣回傳;簽名失敗(如物件尚未上傳完成)不阻斷,略過 iconUrl。
 */
async function enrichAppIcon(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  record: AppRecord,
): Promise<AppRecord & { iconUrl?: string }> {
  if (!record.iconArtifactId) return record;
  try {
    const key = artifactKey(tenantId, record.iconArtifactId, 'png');
    const url = await createDownloadUrl(s3, bucket, key);
    return { ...record, iconUrl: url };
  } catch {
    return record;
  }
}

/**
 * 為 emulator 報告的每個截圖 S3 key 附上 presigned GET URL,讓前端能直接顯示。
 * 非 emulator 報告(無 steps/navGraph)原樣回傳。截圖 key 欄位:steps[].screenshotKey /
 * steps[].annotatedKey / navGraph.nodes[].screenshotKey。
 */
/**
 * 為一組 step 物件的截圖 S3 key 附上 presigned GET URL(就地改寫)。
 * 供任務詳情(即時軌跡)與報告共用。key 欄位:screenshotKey / annotatedKey。
 */
async function enrichStepScreenshots(
  s3: S3Client,
  bucket: string,
  steps: Record<string, unknown>[],
): Promise<void> {
  const sign = async (key: unknown): Promise<string | undefined> =>
    typeof key === 'string' && key ? createDownloadUrl(s3, bucket, key) : undefined;
  // 平行簽名(原本序列 for...of,長任務數百步時會逐步拖慢回應;Promise.all 讓簽名時間
  // 只跟最慢的一次簽名有關,不會隨步數線性增長)。單一簽名失敗不應讓整批都掛掉,
  // 用 allSettled 容錯,失敗的那張圖就是沒有 URL(前端已處理缺圖的情況)。
  await Promise.all(
    steps.map(async (step) => {
      const [shotResult, annResult] = await Promise.allSettled([
        sign(step['screenshotKey']),
        sign(step['annotatedKey']),
      ]);
      if (shotResult.status === 'fulfilled' && shotResult.value) step['screenshotUrl'] = shotResult.value;
      if (annResult.status === 'fulfilled' && annResult.value) step['annotatedUrl'] = annResult.value;
    }),
  );
}

async function enrichReportScreenshots(
  s3: S3Client,
  bucket: string,
  report: unknown,
): Promise<unknown> {
  if (typeof report !== 'object' || report === null) return report;
  const r = report as Record<string, unknown>;
  const steps = Array.isArray(r['steps']) ? (r['steps'] as Record<string, unknown>[]) : null;
  if (!steps) return report; // 非 emulator 結構化報告,原樣回

  await enrichStepScreenshots(s3, bucket, steps);
  const sign = async (key: unknown): Promise<string | undefined> =>
    typeof key === 'string' && key ? createDownloadUrl(s3, bucket, key) : undefined;
  const nav = r['navGraph'] as { nodes?: Record<string, unknown>[] } | undefined;
  if (nav?.nodes) {
    for (const node of nav.nodes) {
      const shot = await sign(node['screenshotKey']);
      if (shot) node['screenshotUrl'] = shot;
    }
  }
  return report;
}

/**
 * 組結構化報告:job 快照(類型/模型/裝置)+ App + 案例 + 本次掛的知識庫(報告規格)。
 * 任何一份缺失都退化(舊任務可能沒有 genres 快照,就退回讀 App 目前的類型)。
 * 證據截圖與缺陷截圖附 presigned URL。
 */
async function buildReportForJob(
  deps: ApiDeps,
  s3: S3Client,
  tenantId: string,
  jobId: string,
  raw: Record<string, unknown>,
  opts: { sign?: boolean } = {},
): Promise<StructuredReport> {
  const job = await readJsonObject<EngineJob & { appId?: string; knowledgeBaseIds?: string[]; kbSnapshot?: EngineKb[]; caseVersion?: string; caseName?: string }>(
    s3,
    deps.bucket,
    `${tenantPrefix(tenantId)}jobs/${jobId}/job.json`,
  );
  const [app, testCase, kbs] = await Promise.all([
    job?.appId ? getApp(s3, deps.bucket, tenantId, job.appId).catch(() => null) : Promise.resolve(null),
    // 有版本號就讀「執行當時」的不可變版本(案例之後改過也不影響舊報告);舊任務退回讀目前的案例。
    job?.appId && job.caseId && job.caseId !== 'exploration'
      ? (job.caseVersion
          ? getCaseVersion(s3, deps.bucket, tenantId, job.appId, job.caseId, job.caseVersion)
              .then((v) => (v ? { id: v.caseId, name: v.name, yaml: v.yaml, version: v.version } : null))
              .catch(() => null)
          : getCase(s3, deps.bucket, tenantId, job.appId, job.caseId).catch(() => null))
      : Promise.resolve(null),
    // 優先用提交時的知識庫快照(自建 KB 之後被修改/封存也不影響舊報告);
    // 內建樣板以程式碼為真相源(快照只記 id/版本);舊任務無快照則讀目前的知識庫。
    Promise.all(
      job?.kbSnapshot?.length
        ? job.kbSnapshot.map((s) =>
            s.builtin ? getKnowledgeBase(deps.sharedS3, deps.bucket, s.id).catch(() => null) : Promise.resolve(s),
          )
        : (job?.knowledgeBaseIds ?? []).map((id) => getKnowledgeBase(deps.sharedS3, deps.bucket, id).catch(() => null)),
    ),
  ]);
  const structured = buildStructuredReport({
    raw,
    job: job ?? null,
    app: app ?? null,
    testCase: testCase ?? null,
    kbs: kbs.filter((k): k is NonNullable<typeof k> => k !== null),
  });
  const sign = async (key: string | undefined): Promise<string | undefined> => {
    if (!key) return undefined;
    try { return await createDownloadUrl(s3, deps.bucket, key); } catch { return undefined; }
  };
  const withUrls = async <T extends { screenshotKey?: string; annotatedKey?: string }>(o: T) => {
    const [shot, ann] = await Promise.all([sign(o.screenshotKey), sign(o.annotatedKey)]);
    const out = o as T & { screenshotUrl?: string; annotatedUrl?: string };
    if (shot) out.screenshotUrl = shot;
    if (ann) out.annotatedUrl = ann;
  };
  if (opts.sign !== false) {
    await Promise.all([...structured.evidence, ...structured.findings, ...structured.aiFailures].map(withUrls));
  }
  return structured;
}

/** AI 洞察快取位置(與 report.json 同一 job 前綴)。 */
function insightsKey(tenantId: string, jobId: string, lang: 'zh' | 'en'): string {
  return `${tenantPrefix(tenantId)}jobs/${jobId}/insights-${lang}.json`;
}

/** 讀 S3 JSON 物件(不存在回 null)。 */
async function readJsonObject<T>(
  s3: S3Client,
  bucket: string,
  key: string,
): Promise<T | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const text = await res.Body?.transformToString();
    return text ? (JSON.parse(text) as T) : null;
  } catch (err) {
    if (err instanceof Error && (err.name === 'NoSuchKey' || err.name === 'NotFound')) {
      return null;
    }
    throw err;
  }
}

/** S3 物件是否存在。 */
async function objectExists(
  s3: S3Client,
  bucket: string,
  key: string,
): Promise<boolean> {
  try {
    await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    if (err instanceof Error && (err.name === 'NoSuchKey' || err.name === 'NotFound')) {
      return false;
    }
    throw err;
  }
}

/**
 * 提交任務(Req 2.2 / 3):提交前校驗(App、案例存在)於任何執行花費前;
 * 建 job.json + 初始 running 狀態;送入分派佇列。
 */
async function handleSubmitTask(
  req: ApiRequest,
  deps: ApiDeps,
  tenantId: string,
): Promise<ApiResponse> {
  const input = validateSubmit(req.body);
  const s3 = await deps.getTenantS3(tenantId);

  // 提交前存在性校驗(花費前失敗)
  const appOk = await objectExists(
    s3,
    deps.bucket,
    `${tenantPrefix(tenantId)}apps/${input.appId}.json`,
  );
  if (!appOk) return json(400, { error: `找不到 App: ${input.appId}` });

  // 案例版本:明指版本就用該版本;否則用「目前使用中」的版本(舊案例自動補建基準版本)。
  // 任務以該版本的不可變內容執行,job 記下版本號,之後案例再怎麼改都能溯源。
  let caseVersion: string | null = null;
  if (input.caseVersion) {
    caseVersion = input.caseVersion;
  } else {
    const head = await getCase(s3, deps.bucket, tenantId, input.appId, input.caseId);
    if (!head) return json(400, { error: `找不到測試案例: ${input.caseId}` });
    caseVersion = await ensureCaseVersion(s3, deps.bucket, tenantId, input.appId, input.caseId, head);
  }
  const caseRecord = caseVersion
    ? await getCaseVersion(s3, deps.bucket, tenantId, input.appId, input.caseId, caseVersion)
    : null;
  if (!caseRecord) {
    return json(400, { error: input.caseVersion ? `找不到案例版本: ${input.caseVersion}` : `找不到測試案例: ${input.caseId}` });
  }

  // 三角色模型校驗(Req 8/7):若使用者指定,各模型必須在對應 seat 的 Catalog 且可定價
  // (Fail Closed),否則在任何執行花費前拒絕。未指定則引擎用預設。
  const seatChecks: Array<[Seat, string | undefined, string]> = [
    ['vlm', input.vlmModel, 'VLM(分析畫面)'],
    ['agent', input.agentModel, 'Agent(控制遊戲)'],
    ['subagent', input.subagentModel, 'Subagent(子代理)'],
  ];
  for (const [seat, modelId, label] of seatChecks) {
    if (!modelId) continue;
    const allowed = modelsForSeat(seat);
    if (!allowed.find((m) => m.modelId === modelId)) {
      return json(400, { error: `${label} 模型不在可選清單: ${modelId}` });
    }
    if (!isPriceable(modelId)) {
      return json(400, { error: `${label} 模型查無單價(Fail Closed): ${modelId}` });
    }
  }
  // UI-TARS 關閉時拒絕(否則 runner 會打一個不存在的 endpoint,每一步都只能等待)。
  if (input.vlmModel === 'uitars' && !(deps.uitars && (await uitarsAvailable(deps.uitars.ports)))) {
    return json(400, { error: 'UI-TARS 目前是關閉的(管理員可在「系統管理」開啟),請改選其他 VLM 模型' });
  }

  // 快照被測 App 的產物版本(供趨勢/flaky 判斷「有無被測變更」,Req 12.2)。
  const appRecord = await readJsonObject<{
    artifactId?: string;
    builds?: AppBuild[];
    version?: string;
    identifier?: string;
    genre?: string;
    secondaryGenres?: string[];
    platform?: string;
    defaultKnowledgeBaseIds?: string[];
  }>(
    s3,
    deps.bucket,
    `${tenantPrefix(tenantId)}apps/${input.appId}.json`,
  );

  // 類型快照(主類型 + 次要類型):報告引擎據此合併 GenreProfile;後續改 App 類型不影響舊報告。
  const genres = [appRecord?.genre, ...(appRecord?.secondaryGenres ?? [])].filter(
    (g, i, arr): g is string => typeof g === 'string' && g !== '' && arr.indexOf(g) === i,
  );

  // 解析知識庫:提交明選 ?? App 預設。寫進 job 快照供執行時讀取注入。
  const selectedKbIds =
    input.knowledgeBaseIds ?? appRecord?.defaultKnowledgeBaseIds ?? [];
  // 依 App 類型(主+次要)自動掛上對應的「內建類型知識庫」,讓 agent 更懂這款遊戲,
  // 也讓報告引擎套用對應的類型報告規格。內建 id 放最前(類型知識優先),與使用者明選項去重。
  // 讀所選知識庫:若某座是「由內建樣板 clone 出來的自建版本」,代表使用者要用自己的版本取代該樣板,
  // 就不再自動掛原樣板(避免同一份類型知識重複注入、或樣板規則蓋過客製)。
  const selectedRecords = (
    await Promise.all(selectedKbIds.map((id) => getKnowledgeBase(deps.sharedS3, deps.bucket, id).catch(() => null)))
  ).filter((k): k is NonNullable<typeof k> => k !== null);
  const replacedBuiltins = new Set(
    selectedRecords.map((k) => k.clonedFrom?.id).filter((id): id is string => Boolean(id && isBuiltinKbId(id))),
  );
  const genreKbIds = genres
    .map((g) => genreBuiltinKbId(g))
    .filter((id): id is string => id !== null && !selectedKbIds.includes(id) && !replacedBuiltins.has(id));
  const resolvedKbIds = [...genreKbIds, ...selectedKbIds];
  // 知識庫快照(名稱/版本/修訂/Markdown/報告規格):報告依「執行當時」的知識庫計算,
  // 之後修改或封存知識庫不會改寫舊報告的判定。
  const kbSnapshot = (
    await Promise.all(resolvedKbIds.map((id) => getKnowledgeBase(deps.sharedS3, deps.bucket, id).catch(() => null)))
  )
    .filter((k): k is NonNullable<typeof k> => k !== null)
    .map((k) => ({
      id: k.id,
      name: k.name,
      ...(k.genre ? { genre: k.genre } : {}),
      ...(k.version ? { version: k.version } : {}),
      ...(typeof k.revision === 'number' ? { revision: k.revision } : {}),
      ...(k.builtin ? { builtin: true } : {}),
      // 內建樣板內容以程式碼為準(可由 id+version 重建),不必存 Markdown;自建則完整快照。
      ...(!k.builtin ? { markdown: k.markdown ?? '', ...(k.reportSpec ? { reportSpec: k.reportSpec } : {}) } : {}),
    }));
  // 選版本:提交時明選 buildId > App 目前使用中的版本。版本清單見 apps.ts 的 builds[]。
  // 舊 App 沒有 builds[](只有 artifactId),視為「一個版本」。
  const builds: AppBuild[] = appRecord?.builds?.length
    ? appRecord.builds
    : appRecord?.artifactId
      ? [{
        artifactId: appRecord.artifactId,
        label: appRecord.version ?? '',
        kind: appRecord.platform === 'ios' ? 'ipa' : appRecord.platform === 'windows' ? 'exe' : 'apk',
        uploadedAt: '',
      }]
      : [];
  const chosenBuild =
    (input.buildId ? builds.find((b) => b.artifactId === input.buildId) : undefined)
    ?? builds.find((b) => b.artifactId === appRecord?.artifactId);
  const chosenArtifactId = chosenBuild?.artifactId ?? appRecord?.artifactId;
  // artifactVersion 就是產物 id:趨勢分析(trends.ts)以它分組做版本間回歸比較。
  const artifactVersion = chosenArtifactId ?? input.appId;
  // emulator/裝置後端需要被測產物的完整 S3 key + 案例任務描述(給 VLM 的目標)。
  // package(Android 包名)來自 App identifier,供 OBB 推送與自動啟動遊戲。
  // 檔名依版本的 kind 決定(先前一律硬編 app.apk,iOS 的 app.ipa 永遠選不到)。
  // Windows 遊戲可能是 game.exe 或 game.zip:給資料夾,由主機挑檔(host.ps1)。
  const jobArtifactKey = chosenArtifactId
    ? appRecord?.platform === 'windows'
      ? `${tenantPrefix(tenantId)}artifacts/${chosenArtifactId}/`
      : artifactKey(
        tenantId,
        chosenArtifactId,
        chosenBuild?.kind ?? (appRecord?.platform === 'ios' ? 'ipa' : 'apk'),
      )
    : undefined;
  const pkg = appRecord?.identifier;
  // 任務目標取自「本次使用的版本」內容(不是 head,避免提交瞬間被改)。
  const caseYamlText = caseRecord.yaml;
  let caseTask: string | undefined = extractCaseTask(caseYamlText);
  // exploration 任務且案例未指定 task 時,依 App 類型組出「自主探索目標」,
  // 讓探索有語意(走遍該類型關鍵畫面)而非泛用亂逛。
  if (!caseTask && input.category === 'exploration') {
    const goal = explorationGoalForGenre(appRecord?.genre);
    if (goal) caseTask = goal;
  }

  // 操作行為(控制方案):案例 YAML `controls:` 優先;沒寫則用 App 類型的建議(寫了空清單 = 不限定)。
  const caseControls = caseYamlText ? parseCaseControls(caseYamlText) : undefined;
  // 案例內文要求長按、controls 卻沒勾 → 補上 hold(以內文為準,避免 AI 被規定擋住做不到腳本要求的事)。
  const controlIds = reconcileControlsWithText(caseYamlText ?? '', caseControls ?? defaultControlsForGenre(appRecord?.genre)).ids;
  const controls = controlIds.length > 0 ? { ids: controlIds, source: caseControls ? ('case' as const) : ('genre' as const) } : undefined;

  const job = await createJob(
    s3,
    deps.bucket,
    tenantId,
    // 以解析後的知識庫 id(提交明選 ?? App 預設)覆蓋 input,快照進 job.json。
    { ...input, ...(resolvedKbIds.length > 0 ? { knowledgeBaseIds: resolvedKbIds } : {}) },
    artifactVersion,
    {
      ...(jobArtifactKey ? { artifactKey: jobArtifactKey } : {}),
      ...(chosenBuild?.label ? { artifactLabel: chosenBuild.label } : {}),
      ...(caseTask ? { caseTask } : {}),
      ...(pkg ? { package: pkg } : {}),
      ...(appRecord?.platform ? { platform: appRecord.platform } : {}),
      ...(genres.length > 0 ? { genres } : {}),
      ...(kbSnapshot.length > 0 ? { kbSnapshot } : {}),
      ...(controls ? { controls } : {}),
      caseVersion: caseRecord.version,
      caseName: caseRecord.name,
    },
  );
  // 知識庫引用索引(刪除防呆);失敗不擋提交。
  await addKbRefs(deps.sharedS3, deps.bucket, job.knowledgeBaseIds, { type: 'job', tenantId, jobId: job.jobId }).catch(() => {});
  await writeStatus(s3, deps.bucket, tenantId, {
    jobId: job.jobId,
    state: 'running',
    updatedAt: new Date().toISOString(),
  });
  // seats:把使用者選的各角色模型傳給引擎(引擎會覆寫預設並解析單價 Fail Closed)。
  const seats: { agent?: string; vlm?: string; subagent?: string } = {
    ...(input.vlmModel ? { vlm: input.vlmModel } : {}),
    ...(input.agentModel ? { agent: input.agentModel } : {}),
    ...(input.subagentModel ? { subagent: input.subagentModel } : {}),
  };
  await deps.enqueueJob({
    tenantId,
    jobId: job.jobId,
    backend: input.backend,
    ...(input.vlmModel ? { vlmModel: input.vlmModel } : {}),
    ...(Object.keys(seats).length > 0 ? { seats } : {}),
    ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
    ...(input.budgetUsd !== undefined ? { budgetUsd: input.budgetUsd } : {}),
  });

  return json(201, { jobId: job.jobId, locality: localityOf(input.backend) });
}

/**
 * 取消任務(Req 3.3):協作式取消 —— 寫 cancel.json 旗標,並把 status 落 cancelled
 * (若尚未終態)。真正的停止由執行端輪詢旗標優雅完成。
 */
async function handleCancelTask(
  deps: ApiDeps,
  tenantId: string,
  jobId: string,
): Promise<ApiResponse> {
  if (!isValidJobId(jobId)) return json(400, { error: 'jobId 格式不正確' });
  const s3 = await deps.getTenantS3(tenantId);
  const existing = await readStatus(s3, deps.bucket, tenantId, jobId);
  if (!existing) return json(404, { error: '找不到任務' });

  await writeCancelFlag(s3, deps.bucket, tenantId, jobId);
  // 只有在仍 running 時落 cancelled;若已有真實終態,終態吸收會保留它(Req 3.4)
  const finalState = await writeStatus(s3, deps.bucket, tenantId, {
    jobId,
    state: 'cancelled',
    updatedAt: new Date().toISOString(),
  });
  return json(200, { jobId, state: finalState });
}

function parseDraftBody(
  body: unknown,
): { description: string; appId: string; baseYaml?: string } {
  if (typeof body !== 'object' || body === null) {
    throw new BadRequestError('請求主體必須是物件');
  }
  const b = body as Record<string, unknown>;
  const description = b['description'];
  const appId = b['appId'];
  const baseYaml = b['baseYaml'];
  const hasBase = typeof baseYaml === 'string' && baseYaml.trim() !== '';
  // 編修模式(有 baseYaml)可不帶 description(視為潤飾);純產生模式 description 必填。
  if (!hasBase && (typeof description !== 'string' || description.trim() === '')) {
    throw new BadRequestError('description 為必填');
  }
  return {
    description: typeof description === 'string' ? description.trim() : '',
    appId: typeof appId === 'string' ? appId : '',
    ...(hasBase ? { baseYaml: (baseYaml as string).trim() } : {}),
  };
}

function parseUploadBody(body: unknown): { artifactId: string; kind: ArtifactKind } {
  if (typeof body !== 'object' || body === null) {
    throw new BadRequestError('請求主體必須是物件');
  }
  const b = body as Record<string, unknown>;
  const kind = b['kind'];
  if (typeof kind !== 'string' || !ARTIFACT_KINDS.includes(kind as ArtifactKind)) {
    throw new BadRequestError(`kind 必須是 ${ARTIFACT_KINDS.join('/')} 之一`);
  }
  // artifactId 由客戶端提供或伺服器生成;此處生成以避免碰撞。
  const artifactId =
    typeof b['artifactId'] === 'string' && b['artifactId'].length > 0
      ? b['artifactId']
      : `art-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return { artifactId, kind: kind as ArtifactKind };
}
