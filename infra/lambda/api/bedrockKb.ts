import {
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Bedrock Knowledge Base(S3 Vectors)管理面(ADR-0029/0030,Stage B)。
 *
 * 每座 KB = 一整座獨立的 Bedrock KnowledgeBase(專長隔離,檢索互不污染)。
 * runtime 建立動作序:CreateVectorBucket → CreateIndex(1024 維,Bedrock metadata key 標 non-filterable)
 * → CreateKnowledgeBase(S3_VECTORS 儲存)→ CreateDataSource(指向 docs 前綴)。
 *
 * SDK 惰性載入 + 優雅降級:若 SDK/服務不可用,拋可讀錯誤,不讓整個 API crash。
 * 文件放共用資料桶的 shared/knowledge-docs/<kbId>/ 前綴(與知識庫 registry 同租戶外命名空間)。
 */

const REGION = process.env.AWS_REGION ?? 'us-west-2';
const KB_SERVICE_ROLE_ARN = process.env.KB_SERVICE_ROLE_ARN ?? '';
const KB_VECTOR_BUCKET_PREFIX = process.env.KB_VECTOR_BUCKET_PREFIX ?? 'playagent-kb-';
const KB_EMBEDDING_MODEL_ID = process.env.KB_EMBEDDING_MODEL_ID ?? 'amazon.titan-embed-text-v2:0';
/** Titan embed v2 維度。 */
const EMBED_DIM = 1024;
const DOCS_PREFIX = 'shared/knowledge-docs/';

export class KbProvisionError extends Error {}

/** runtime 建 KB 後回傳的座標(存進 registry)。 */
export interface CreatedBedrockKb {
  bedrockKbId: string;
  bedrockKbArn: string;
  dataSourceId: string;
  vectorBucketName: string;
  vectorBucketArn: string;
  indexName: string;
  indexArn: string;
  docsPrefix: string;
}

export function docsPrefixFor(kbId: string): string {
  return `${DOCS_PREFIX}${kbId}/`;
}

/** KB 功能是否已配置(CDK 服務角色 ARN 有值)。 */
export function isKbConfigured(): boolean {
  return KB_SERVICE_ROLE_ARN.length > 0;
}

interface SdkClients {
  agent: import('@aws-sdk/client-bedrock-agent').BedrockAgentClient;
  vectors: import('@aws-sdk/client-s3vectors').S3VectorsClient;
}

/** 惰性載入管理面 SDK(bundle 不因未用而變大;缺套件時給可讀錯誤)。 */
async function loadClients(): Promise<SdkClients> {
  try {
    const { BedrockAgentClient } = await import('@aws-sdk/client-bedrock-agent');
    const { S3VectorsClient } = await import('@aws-sdk/client-s3vectors');
    return {
      agent: new BedrockAgentClient({ region: REGION }),
      vectors: new S3VectorsClient({ region: REGION }),
    };
  } catch (err) {
    throw new KbProvisionError(`Bedrock KB SDK 未就緒:${String(err)}`);
  }
}

const ARN_ACCOUNT_RE = /^arn:aws:iam::(\d+):/;
function accountFromRoleArn(): string {
  const m = ARN_ACCOUNT_RE.exec(KB_SERVICE_ROLE_ARN);
  return m?.[1] ?? '';
}

/**
 * 建立一整座 Bedrock KB(S3 Vectors)。回傳座標供 registry 記錄。
 * 注意:此動作建真實雲資源、有按量成本。
 */
export async function provisionBedrockKb(bucket: string, kbId: string): Promise<CreatedBedrockKb> {
  if (!isKbConfigured()) throw new KbProvisionError('KB 服務角色未配置(KB_SERVICE_ROLE_ARN 空)');
  const { agent, vectors } = await loadClients();
  const account = accountFromRoleArn();
  const vectorBucketName = `${KB_VECTOR_BUCKET_PREFIX}${kbId}`.toLowerCase();
  const indexName = 'kb-index';

  const {
    CreateVectorBucketCommand,
    CreateIndexCommand,
  } = await import('@aws-sdk/client-s3vectors');
  const {
    CreateKnowledgeBaseCommand,
    CreateDataSourceCommand,
  } = await import('@aws-sdk/client-bedrock-agent');

  // 「已存在」視為成功(冪等):先前 provision 因 Lambda timeout 中斷,常留下已建好的向量桶/索引;
  // 重跑時不該因 ConflictException 卡死,而應重用既有資源繼續往下建 KB。
  const isAlreadyExists = (err: unknown): boolean => {
    const name = (err as { name?: string })?.name ?? '';
    const msg = (err as { message?: string })?.message ?? '';
    return /Conflict|AlreadyExists|already exists/i.test(name) || /already exists|Conflict/i.test(msg);
  };

  // 1) 向量桶(已存在則重用)
  try {
    await vectors.send(new CreateVectorBucketCommand({ vectorBucketName }));
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
  }
  const vectorBucketArn = `arn:aws:s3vectors:${REGION}:${account}:bucket/${vectorBucketName}`;

  // 2) 索引(維度對齊 embeddings;Bedrock 大 metadata key 標 non-filterable,否則 ingestion 撞 2048 bytes 限)
  //    已存在則重用。
  try {
    await vectors.send(
      new CreateIndexCommand({
        vectorBucketName,
        indexName,
        dataType: 'float32',
        dimension: EMBED_DIM,
        distanceMetric: 'cosine',
        metadataConfiguration: {
          nonFilterableMetadataKeys: ['AMAZON_BEDROCK_TEXT', 'AMAZON_BEDROCK_METADATA'],
        },
      }),
    );
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
  }
  const indexArn = `${vectorBucketArn}/index/${indexName}`;

  // 3) KnowledgeBase(S3_VECTORS 儲存;只給 indexArn,不給 indexName —— 兩者互斥)
  const embeddingModelArn = `arn:aws:bedrock:${REGION}::foundation-model/${KB_EMBEDDING_MODEL_ID}`;
  const kbRes = await agent.send(
    new CreateKnowledgeBaseCommand({
      name: `playagent-kb-${kbId}`,
      roleArn: KB_SERVICE_ROLE_ARN,
      knowledgeBaseConfiguration: {
        type: 'VECTOR',
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn,
          embeddingModelConfiguration: {
            bedrockEmbeddingModelConfiguration: { dimensions: EMBED_DIM },
          },
        },
      },
      storageConfiguration: {
        type: 'S3_VECTORS',
        s3VectorsConfiguration: { vectorBucketArn, indexArn },
      },
      tags: { project: 'playagent-checker' },
    }),
  );
  const bedrockKbId = kbRes.knowledgeBase?.knowledgeBaseId ?? '';
  const bedrockKbArn = kbRes.knowledgeBase?.knowledgeBaseArn ?? '';
  if (!bedrockKbId) throw new KbProvisionError('CreateKnowledgeBase 未回傳 knowledgeBaseId');

  // 4) DataSource 指向 docs 前綴
  const dsRes = await agent.send(
    new CreateDataSourceCommand({
      knowledgeBaseId: bedrockKbId,
      name: `playagent-ds-${kbId}`,
      dataSourceConfiguration: {
        type: 'S3',
        s3Configuration: {
          bucketArn: `arn:aws:s3:::${bucket}`,
          inclusionPrefixes: [docsPrefixFor(kbId)],
        },
      },
    }),
  );
  const dataSourceId = dsRes.dataSource?.dataSourceId ?? '';

  return {
    bedrockKbId,
    bedrockKbArn,
    dataSourceId,
    vectorBucketName,
    vectorBucketArn,
    indexName,
    indexArn,
    docsPrefix: docsPrefixFor(kbId),
  };
}

/**
 * 拆掉整座 KB(連帶清向量索引/桶 + docs 文件)。容忍「部分已刪」重跑:每步各自 try。
 */
export async function teardownBedrockKb(
  s3: S3Client,
  bucket: string,
  kbId: string,
  coords: {
    bedrockKbId?: string;
    dataSourceId?: string;
    vectorBucketName?: string;
    indexName?: string;
  },
): Promise<void> {
  const { agent, vectors } = await loadClients();
  const {
    DeleteKnowledgeBaseCommand,
    DeleteDataSourceCommand,
  } = await import('@aws-sdk/client-bedrock-agent');
  const { DeleteIndexCommand, DeleteVectorBucketCommand } = await import('@aws-sdk/client-s3vectors');

  // DataSource(先於 KB;KB 刪除通常會連帶,但顯式刪較乾淨)
  if (coords.bedrockKbId && coords.dataSourceId) {
    try {
      await agent.send(
        new DeleteDataSourceCommand({
          knowledgeBaseId: coords.bedrockKbId,
          dataSourceId: coords.dataSourceId,
        }),
      );
    } catch { /* 容忍已刪 */ }
  }
  if (coords.bedrockKbId) {
    try {
      await agent.send(new DeleteKnowledgeBaseCommand({ knowledgeBaseId: coords.bedrockKbId }));
    } catch { /* 容忍已刪 */ }
  }
  if (coords.vectorBucketName && coords.indexName) {
    try {
      await vectors.send(
        new DeleteIndexCommand({ vectorBucketName: coords.vectorBucketName, indexName: coords.indexName }),
      );
    } catch { /* 容忍已刪 */ }
  }
  if (coords.vectorBucketName) {
    try {
      await vectors.send(new DeleteVectorBucketCommand({ vectorBucketName: coords.vectorBucketName }));
    } catch { /* 容忍已刪 */ }
  }
  // 清 docs 文件
  await deleteAllDocs(s3, bucket, kbId);
}

/** 發 presigned PUT URL 讓瀏覽器直傳文件到 docs 前綴。 */
export async function presignDocUpload(
  s3: S3Client,
  bucket: string,
  kbId: string,
  filename: string,
): Promise<{ url: string; key: string }> {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
  const key = `${docsPrefixFor(kbId)}${safe}`;
  const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: 900,
  });
  return { url, key };
}

export interface KbDoc {
  key: string;
  name: string;
  size?: number;
}

/** 列出某 KB 的文件。 */
export async function listDocs(s3: S3Client, bucket: string, kbId: string): Promise<KbDoc[]> {
  const prefix = docsPrefixFor(kbId);
  const list = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
  return (list.Contents ?? [])
    .filter((o) => typeof o.Key === 'string' && o.Key !== prefix)
    .map((o) => ({
      key: o.Key!,
      name: o.Key!.slice(prefix.length),
      ...(typeof o.Size === 'number' ? { size: o.Size } : {}),
    }));
}

/** 刪單一文件(key 必須落在該 KB 的 docs 前綴內)。 */
export async function deleteDoc(
  s3: S3Client,
  bucket: string,
  kbId: string,
  key: string,
): Promise<void> {
  if (!key.startsWith(docsPrefixFor(kbId))) {
    throw new KbProvisionError('文件 key 不屬於此知識庫');
  }
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

async function deleteAllDocs(s3: S3Client, bucket: string, kbId: string): Promise<void> {
  const docs = await listDocs(s3, bucket, kbId).catch(() => [] as KbDoc[]);
  await Promise.all(
    docs.map((d) => s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: d.key })).catch(() => {})),
  );
}

/** 觸發 ingestion(切塊/embedding/寫索引)。回傳 ingestion job id。 */
export async function startIngestion(bedrockKbId: string, dataSourceId: string): Promise<string> {
  const { agent } = await loadClients();
  const { StartIngestionJobCommand } = await import('@aws-sdk/client-bedrock-agent');
  const res = await agent.send(
    new StartIngestionJobCommand({ knowledgeBaseId: bedrockKbId, dataSourceId }),
  );
  return res.ingestionJob?.ingestionJobId ?? '';
}

export interface IngestionStatus {
  status: string;
  updatedAt?: string;
  documentsAdded?: number;
  documentsFailed?: number;
  failureReasons?: string[];
}

/** 查最近一次 ingestion 狀態。 */
export async function getIngestionStatus(
  bedrockKbId: string,
  dataSourceId: string,
): Promise<IngestionStatus | null> {
  const { agent } = await loadClients();
  const { ListIngestionJobsCommand, GetIngestionJobCommand } = await import(
    '@aws-sdk/client-bedrock-agent'
  );
  const list = await agent.send(
    new ListIngestionJobsCommand({
      knowledgeBaseId: bedrockKbId,
      dataSourceId,
      sortBy: { attribute: 'STARTED_AT', order: 'DESCENDING' },
      maxResults: 1,
    }),
  );
  const latest = list.ingestionJobSummaries?.[0];
  if (!latest?.ingestionJobId) return null;
  const detail = await agent.send(
    new GetIngestionJobCommand({
      knowledgeBaseId: bedrockKbId,
      dataSourceId,
      ingestionJobId: latest.ingestionJobId,
    }),
  );
  const job = detail.ingestionJob;
  const stats = job?.statistics;
  return {
    status: job?.status ?? 'UNKNOWN',
    ...(job?.updatedAt ? { updatedAt: new Date(job.updatedAt).toISOString() } : {}),
    ...(stats?.numberOfDocumentsScanned != null
      ? { documentsAdded: stats.numberOfNewDocumentsIndexed ?? 0 }
      : {}),
    ...(stats?.numberOfDocumentsFailed != null
      ? { documentsFailed: stats.numberOfDocumentsFailed }
      : {}),
    ...(job?.failureReasons && job.failureReasons.length > 0
      ? { failureReasons: job.failureReasons }
      : {}),
  };
}

/**
 * 對一座 Bedrock KB 發 Retrieve,用 query 撈 top-K 相關片段(執行時檢索,per-run)。
 * 回傳片段文字陣列;失敗或無結果回空陣列(不擋執行)。
 * 用 bedrock-agent-runtime(檢索面),與管理面 SDK 分開惰性載入。
 */
export async function retrieveFromKb(
  bedrockKbId: string,
  query: string,
  topK = 5,
): Promise<string[]> {
  if (!bedrockKbId || !query.trim()) return [];
  try {
    const { BedrockAgentRuntimeClient, RetrieveCommand } = await import(
      '@aws-sdk/client-bedrock-agent-runtime'
    );
    const client = new BedrockAgentRuntimeClient({ region: REGION });
    const res = await client.send(
      new RetrieveCommand({
        knowledgeBaseId: bedrockKbId,
        retrievalQuery: { text: query.slice(0, 1000) },
        retrievalConfiguration: {
          vectorSearchConfiguration: { numberOfResults: topK },
        },
      }),
    );
    return (res.retrievalResults ?? [])
      .map((r) => r.content?.text?.trim())
      .filter((t): t is string => Boolean(t));
  } catch {
    return [];
  }
}
