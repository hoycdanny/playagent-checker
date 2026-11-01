import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/**
 * TenantDataBucket —— 系統的資料真相源(Req 3.6)。
 * 佈局:tenants/<tenantId>/... (apps / jobs / runs / artifacts ...)。
 *
 * - `RemovalPolicy.RETAIN` + 封鎖公開存取:有狀態資料,destroy 不連帶刪除。
 * - EventBridge 通知先開啟(階段 6 即時串流會用到 S3 事件),此處預留。
 */
export class TenantDataBucket extends Construct {
  readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.bucket = new s3.Bucket(this, 'Bucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      eventBridgeEnabled: true, // 階段 6 即時推送用
      removalPolicy: RemovalPolicy.RETAIN,
      // 清掉中斷的 multipart 上傳。桶裡最大的寫入是 Android 容器快照(實測 857 MB)與
      // APK/錄影,都走 multipart;上傳中斷留下的分段「不會」出現在物件清單裡,卻照樣計費,
      // 所以是一筆看不見的費用。7 天足夠涵蓋任何一次正常上傳的重試。
      lifecycleRules: [{ abortIncompleteMultipartUploadAfter: Duration.days(7) }],
      // 瀏覽器 presigned PUT 直傳需要 CORS(Req 2.1/2.4):否則前端跨來源上傳被瀏覽器擋。
      // dev 從簡用 *;正式環境可收斂為 CloudFront 網域。
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 3000,
        },
      ],
    });
  }
}
