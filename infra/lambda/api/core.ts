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
  createApp,
  deleteApp,
  getApp,
  listApps,
  updateApp,
  validateCreateApp,
  validateUpdateApp,
  NotFoundError as AppNotFoundError,
  ValidationError,
  type AppRecord,
} from './apps.js';
import { artifactKey } from './artifacts.js';
import {
  createCase,
  deleteCase,
  getCase,
  listCases,
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
import { GetObjectCommand } from '@aws-sdk/client-s3';
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
  listAppCredentialKeys,
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
import { aggregateEstimatedCost, type RealCost } from './cost.js';
import { readMemoryOverview, memScreenshotKey } from './memoryStructure.js';
import { generateScenarioTemplates } from './scenarioTemplates.js';
import {
  listKnowledgeBases,
  getKnowledgeBase,
  createKnowledgeBase,
  updateKnowledgeBase,
  deleteKnowledgeBase,
  setBedrockCoords,
  validateCreateKb,
  validateUpdateKb,
  ValidationError as KbValidationError,
  NotFoundError as KbNotFoundError,
} from './knowledgeBases.js';
import { genreBuiltinKbId, explorationGoalForGenre, isBuiltinKbId } from './builtinKnowledgeBases.js';
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
  /** 取 AWS 真實成本(Cost Explorer)。選填;未注入或失敗時費用頁只顯示估算成本。 */
  getRealCost?: (opts: { start?: string; end?: string }) => Promise<RealCost>;
  /** 成員管理(admin 專用)。選填;未注入時 /users 路由回 501。 */
  userAdmin?: UserAdmin;
  /** 測試憑證值寫入(Secrets Manager)。選填;未注入時 /secret-refs 僅登記名稱不存值。 */
  secretWriter?: SecretWriter;
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
        const items = await Promise.all(
          records.map((r) => enrichAppIcon(s3, deps.bucket, tenant.tenantId, r)),
        );
        return json(200, { items });
      }

      case 'POST /apps': {
        const input = validateCreateApp(req.body);
        const s3 = await deps.getTenantS3(tenant.tenantId);
        const record = await createApp(s3, deps.bucket, tenant.tenantId, input);
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
        return json(200, { items });
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

      case 'GET /cases': {
        const s3 = await deps.getTenantS3(tenant.tenantId);
        const items = await listCases(s3, deps.bucket, tenant.tenantId);
        return json(200, { items });
      }

      case 'GET /reports': {
        // 報告清單 = 任務清單(前端只顯示已終局者)。
        const s3 = await deps.getTenantS3(tenant.tenantId);
        const items = await listJobs(s3, deps.bucket, tenant.tenantId);
        return json(200, { items });
      }

      case 'GET /models': {
        // 模型目錄(Req 8):可依 seat 過濾。不需租戶 S3。
        // 附上每模型的當前有效單價(input/output 每百萬 token),供前端下拉呈現費用。
        const seat = req.query?.['seat'] as Seat | undefined;
        const base = seat ? modelsForSeat(seat) : CATALOG;
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

      case 'GET /memory': {
        // Memory 導覽關係圖 + 統計(跨測試累積的 App 全景地圖)。app 必填。
        const app = req.query?.['app'];
        if (!app) return json(400, { error: 'app 為必填' });
        const s3 = await deps.getTenantS3(tenant.tenantId);
        const overview = await readMemoryOverview(s3, deps.bucket, tenant.tenantId, app);
        return json(200, overview);
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
        const tasks = await listJobs(s3, deps.bucket, tenant.tenantId);
        const estimated = aggregateEstimatedCost(tasks);

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

        return json(200, { real, estimated });
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
        const record = await createCase(s3, deps.bucket, tenant.tenantId, input);
        return json(201, record);
      }

      case 'POST /cases/draft': {
        const parsed = parseDraftBody(req.body);
        const yaml = await deps.draftCase(parsed.description, parsed.appId, parsed.baseYaml);
        return json(200, { yaml });
      }

      case 'GET /tasks': {
        const s3 = await deps.getTenantS3(tenant.tenantId);
        const items = await listJobs(s3, deps.bucket, tenant.tenantId);
        return json(200, { items });
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
            const keys = await listAppCredentialKeys(deps.secretWriter, tenant.tenantId, appId);
            return json(200, { keys });
          }
          if (req.method === 'PUT') {
            const b = (req.body ?? {}) as { key?: string; value?: string };
            const key = (b.key ?? '').trim();
            if (!key || !isValidCredentialKey(key)) {
              return json(400, { error: 'key 必填,且僅允許字母/數字/_./-(首字為字母或底線)' });
            }
            if (typeof b.value !== 'string' || b.value === '') {
              return json(400, { error: 'value 為必填' });
            }
            const keys = await putAppCredential(deps.secretWriter, tenant.tenantId, appId, key, b.value);
            // 只回 key 名清單,永不回值。
            return json(200, { keys });
          }
          if (req.method === 'DELETE') {
            const key = (req.query?.['key'] ?? '').trim();
            if (!key) return json(400, { error: 'key 為必填' });
            const keys = await deleteAppCredential(deps.secretWriter, tenant.tenantId, appId, key);
            return json(200, { keys });
          }
          return json(405, { error: 'method not allowed' });
        }

        const appGetMatch = req.method === 'GET' && /^\/apps\/([^/]+)$/.exec(req.path);
        if (appGetMatch) {
          const s3 = await deps.getTenantS3(tenant.tenantId);
          const record = await getApp(s3, deps.bucket, tenant.tenantId, appGetMatch[1]!);
          if (!record) return json(404, { error: '找不到 App' });
          const enriched = await enrichAppIcon(s3, deps.bucket, tenant.tenantId, record);
          return json(200, enriched);
        }
        // 動態路由:PUT /apps/{id}(局部更新;修改名稱/平台/識別碼/產物/圖示/備註)
        const appPutMatch = req.method === 'PUT' && /^\/apps\/([^/]+)$/.exec(req.path);
        if (appPutMatch) {
          const patch = validateUpdateApp(req.body);
          const s3 = await deps.getTenantS3(tenant.tenantId);
          const record = await updateApp(
            s3,
            deps.bucket,
            tenant.tenantId,
            appPutMatch[1]!,
            patch,
          );
          const enriched = await enrichAppIcon(s3, deps.bucket, tenant.tenantId, record);
          return json(200, enriched);
        }
        // 動態路由:DELETE /apps/{id}(刪除被測應用)
        const appDelMatch = req.method === 'DELETE' && /^\/apps\/([^/]+)$/.exec(req.path);
        if (appDelMatch) {
          const s3 = await deps.getTenantS3(tenant.tenantId);
          await deleteApp(s3, deps.bucket, tenant.tenantId, appDelMatch[1]!);
          return json(200, { id: appDelMatch[1]! });
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
        // 動態路由:DELETE /knowledge-bases/{id}(連帶拆 Bedrock KB + 向量資源 + 文件)
        const kbDelMatch = req.method === 'DELETE' && /^\/knowledge-bases\/([^/]+)$/.exec(req.path);
        if (kbDelMatch) {
          const kbId = kbDelMatch[1]!;
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
          );
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
          await deleteJob(s3, deps.bucket, tenant.tenantId, jobId);
          return json(200, { jobId });
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
          await deps.userAdmin.setEnabled(username, enable);
          return json(200, { username, enabled: enable });
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
        // 動態路由:GET /tasks/{id}/logs(每步完整互動 log:模型/請求摘要/原始回應/錯誤,供除錯)
        const logsMatch = req.method === 'GET' && /^\/tasks\/([^/]+)\/logs$/.exec(req.path);
        if (logsMatch) {
          const jobId = logsMatch[1]!;
          if (!isValidJobId(jobId)) return json(400, { error: 'jobId 格式不正確' });
          const s3 = await deps.getTenantS3(tenant.tenantId);
          const traces = await readTraces(s3, deps.bucket, tenant.tenantId, jobId);
          return json(200, { items: traces });
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
          return json(200, enriched);
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
    if (err instanceof KbProvisionError) return json(400, { error: err.message });
    if (err instanceof ValidationError) return json(400, { error: err.message });
    if (err instanceof CaseValidationError) return json(400, { error: err.message });
    if (err instanceof TaskValidationError) return json(400, { error: err.message });
    if (err instanceof BadRequestError) return json(400, { error: err.message });
    if (err instanceof SecretRefError) return json(400, { error: err.message });
    if (err instanceof DeviceError) return json(400, { error: err.message });
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
  for (const step of steps) {
    const shot = await sign(step['screenshotKey']);
    if (shot) step['screenshotUrl'] = shot;
    const ann = await sign(step['annotatedKey']);
    if (ann) step['annotatedUrl'] = ann;
  }
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

  const caseOk = await objectExists(
    s3,
    deps.bucket,
    `${tenantPrefix(tenantId)}cases/${input.appId}/${input.caseId}.yaml`,
  );
  if (!caseOk) return json(400, { error: `找不到測試案例: ${input.caseId}` });

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

  // 快照被測 App 的產物版本(供趨勢/flaky 判斷「有無被測變更」,Req 12.2)。
  const appRecord = await readJsonObject<{
    artifactId?: string;
    identifier?: string;
    genre?: string;
    platform?: string;
    defaultKnowledgeBaseIds?: string[];
  }>(
    s3,
    deps.bucket,
    `${tenantPrefix(tenantId)}apps/${input.appId}.json`,
  );

  // 解析知識庫:提交明選 ?? App 預設。寫進 job 快照供執行時讀取注入。
  const selectedKbIds =
    input.knowledgeBaseIds ?? appRecord?.defaultKnowledgeBaseIds ?? [];
  // 依 App 類型(genre)自動掛上對應的「內建類型知識庫」,讓 agent 更懂這款遊戲
  // (探索與測試皆適用)。內建 id 放最前(類型知識優先),與使用者明選項去重。
  const genreKbId = genreBuiltinKbId(appRecord?.genre);
  const resolvedKbIds =
    genreKbId && !selectedKbIds.includes(genreKbId)
      ? [genreKbId, ...selectedKbIds]
      : selectedKbIds;
  const artifactVersion = appRecord?.artifactId ?? input.appId;
  // emulator/裝置後端需要被測產物的完整 S3 key + 案例任務描述(給 VLM 的目標)。
  // package(Android 包名)來自 App identifier,供 OBB 推送與自動啟動遊戲。
  const artifactKey = appRecord?.artifactId
    ? `${tenantPrefix(tenantId)}artifacts/${appRecord.artifactId}/app.apk`
    : undefined;
  const pkg = appRecord?.identifier;
  let caseTask: string | undefined;
  try {
    const caseObj = await s3.send(
      new GetObjectCommand({
        Bucket: deps.bucket,
        Key: `${tenantPrefix(tenantId)}cases/${input.appId}/${input.caseId}.yaml`,
      }),
    );
    const yaml = (await caseObj.Body?.transformToString()) ?? '';
    caseTask = extractCaseTask(yaml);
  } catch {
    /* 無 task 欄位則由下方 fallback 或 runner 預設探索目標 */
  }
  // exploration 任務且案例未指定 task 時,依 App 類型組出「自主探索目標」,
  // 讓探索有語意(走遍該類型關鍵畫面)而非泛用亂逛。
  if (!caseTask && input.category === 'exploration') {
    const goal = explorationGoalForGenre(appRecord?.genre);
    if (goal) caseTask = goal;
  }

  const job = await createJob(
    s3,
    deps.bucket,
    tenantId,
    // 以解析後的知識庫 id(提交明選 ?? App 預設)覆蓋 input,快照進 job.json。
    { ...input, ...(resolvedKbIds.length > 0 ? { knowledgeBaseIds: resolvedKbIds } : {}) },
    artifactVersion,
    {
      ...(artifactKey ? { artifactKey } : {}),
      ...(caseTask ? { caseTask } : {}),
      ...(pkg ? { package: pkg } : {}),
      ...(appRecord?.platform ? { platform: appRecord.platform } : {}),
    },
  );
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
