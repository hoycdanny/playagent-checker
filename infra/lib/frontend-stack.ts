import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { StaticSite } from './constructs/static-site.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

export interface FrontendStackProps extends StackProps {
  /** 前端建置產物目錄;預設指向 web/dist。 */
  readonly assetPath?: string;
}

/**
 * FrontendStack —— 前端靜態託管(S3 私有 + CloudFront OAC)。
 * 與後端 stack 分離,前端可獨立迭代與佈署。
 */
export class FrontendStack extends Stack {
  readonly site: StaticSite;

  constructor(scope: Construct, id: string, props: FrontendStackProps = {}) {
    super(scope, id, props);

    const assetPath =
      props.assetPath ??
      path.resolve(currentDir, '..', '..', 'web', 'dist');

    this.site = new StaticSite(this, 'Site', { assetPath });
  }
}
