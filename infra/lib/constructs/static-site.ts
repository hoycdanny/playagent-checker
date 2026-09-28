import * as path from 'node:path';
import * as fs from 'node:fs';
import { CfnOutput, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';

export interface StaticSiteProps {
  /**
   * 前端建置產物目錄(vite build 輸出)。若不存在則不佈署內容,
   * 只建立 S3 + CloudFront(方便先驗基礎設施再接前端)。
   */
  readonly assetPath?: string;
}

/**
 * StaticSite —— 無伺服器靜態前端託管:私有 S3 桶 + CloudFront(OAC 私有 origin)。
 *
 * 設計要點(對齊 Req 1.5 / 15.3):
 * - S3 桶「封鎖所有公開存取」,只有 CloudFront 經 OAC 能讀 → 不是公開端點,
 *   不會被帳號安全掃描判為 world-accessible。
 * - SPA 路由:403/404 皆回退 index.html(前端自行路由)。
 * - 佈署經 BucketDeployment 並在部署時對 CloudFront 做失效(僅變更檔)。
 */
export class StaticSite extends Construct {
  readonly bucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: StaticSiteProps = {}) {
    super(scope, id);

    // 私有桶:封鎖所有公開存取、強制 SSL、僅 CloudFront OAC 可讀。
    // RemovalPolicy.DESTROY 可接受 —— 前端資產可由 CI 隨時重佈,非有狀態資料。
    this.bucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      publicReadAccess: false,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        // OAC 私有 origin:CloudFront 以 Origin Access Control 讀取私有桶。
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
      },
      // SPA 前端路由:S3 對未知 key 回 403(私有桶),回退 index.html。
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: Duration.minutes(5),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: Duration.minutes(5),
        },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
    });

    // 有建置產物才佈署內容;部署時對整個 distribution 做失效。
    // 註:資產本身以內容雜湊命名(vite),長快取命中;index.html 短快取。
    const resolvedAsset = props.assetPath
      ? path.resolve(props.assetPath)
      : undefined;
    if (resolvedAsset && fs.existsSync(resolvedAsset)) {
      new s3deploy.BucketDeployment(this, 'DeploySite', {
        sources: [s3deploy.Source.asset(resolvedAsset)],
        destinationBucket: this.bucket,
        distribution: this.distribution,
        distributionPaths: ['/*'],
        prune: true,
      });
    }

    new CfnOutput(this, 'SiteUrl', {
      value: `https://${this.distribution.distributionDomainName}`,
      description: '前端 CloudFront URL',
    });
    new CfnOutput(this, 'SiteBucketName', {
      value: this.bucket.bucketName,
      description: '前端資產 S3 桶',
    });
  }
}
