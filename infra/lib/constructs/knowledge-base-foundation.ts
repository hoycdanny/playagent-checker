import { Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface KnowledgeBaseFoundationProps {
  /** 共用資料桶(知識庫文件放 shared/knowledge-docs/<kbId>/)。 */
  dataBucket: s3.IBucket;
  /** 向量桶命名前綴(runtime 建的向量桶都以此開頭,供 IAM 萬用字元 scope)。 */
  vectorBucketPrefix: string;
  /** embeddings 模型 id(維度需與向量索引一致)。 */
  embeddingModelId: string;
}

/**
 * KnowledgeBaseFoundation —— Bedrock Knowledge Base(S3 Vectors)的**共用基礎**(ADR-0029)。
 *
 * CDK 不預建任何具體 KB(使用者在介面上 runtime 建),只建可共用、可被 runtime KB 引用的:
 * - KB 服務角色:由 bedrock.amazonaws.com assume,需能讀 docs 前綴、對 S3 Vectors 讀寫、呼叫 embeddings。
 *   因向量桶/索引 runtime 才建、名字含 <kbId>,故資源範圍用萬用字元 scope 到本專案命名前綴。
 *
 * 每座 KB 是獨立的 Bedrock KnowledgeBase(Option 2:專長隔離,老虎機/RTP 各一座,檢索互不污染)。
 */
export class KnowledgeBaseFoundation extends Construct {
  readonly serviceRole: iam.Role;
  readonly docsPrefix = 'shared/knowledge-docs/';

  constructor(scope: Construct, id: string, props: KnowledgeBaseFoundationProps) {
    super(scope, id);
    const { account, region } = Stack.of(this);

    // Bedrock KnowledgeBase 建立時要帶一個 roleArn,由 KB 服務 assume。
    this.serviceRole = new iam.Role(this, 'ServiceRole', {
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': account },
          ArnLike: {
            'aws:SourceArn': `arn:aws:bedrock:${region}:${account}:knowledge-base/*`,
          },
        },
      }),
      description: 'Bedrock KB service role (reads docs prefix + S3 Vectors + embeddings)',
    });

    // 讀 docs 前綴的文件(ingestion 來源)。
    this.serviceRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:ListBucket'],
        resources: [props.dataBucket.bucketArn, `${props.dataBucket.bucketArn}/${this.docsPrefix}*`],
        conditions: { StringEquals: { 'aws:ResourceAccount': account } },
      }),
    );

    // 對 runtime 建的 S3 Vectors 向量桶/索引讀寫(scope 到本專案命名前綴)。
    this.serviceRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          's3vectors:GetIndex',
          's3vectors:QueryVectors',
          's3vectors:PutVectors',
          's3vectors:GetVectors',
          's3vectors:DeleteVectors',
          's3vectors:ListVectors',
        ],
        resources: [
          `arn:aws:s3vectors:${region}:${account}:bucket/${props.vectorBucketPrefix}*`,
          `arn:aws:s3vectors:${region}:${account}:bucket/${props.vectorBucketPrefix}*/index/*`,
        ],
      }),
    );

    // 呼叫 embeddings 模型(ingestion 產向量 + 查詢時 embed query)。
    this.serviceRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:aws:bedrock:${region}::foundation-model/${props.embeddingModelId}`,
        ],
      }),
    );
  }
}
