import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

export interface SchedulingStackProps extends StackProps {
  /** 引擎 Lambda(分派器直接 Invoke 的目標)。 */
  engineFn: lambda.IFunction;
}

/**
 * SchedulingStack —— 兩層排程的分派層(Req 3.8)。
 * SQS 分派佇列 + 分派器 Lambda。分派器是佇列消費者,放行方式是**直接非同步 Invoke
 * 引擎 Lambda**,而非把引擎掛在 SQS ESM 之後 —— 保留引擎不受 15 分鐘 ESM 壓縮的擴充路徑。
 */
export class SchedulingStack extends Stack {
  readonly dispatchQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: SchedulingStackProps) {
    super(scope, id, props);

    // 死信佇列:數次處理失敗的訊息移入,避免無限重試。
    const dlq = new sqs.Queue(this, 'DispatchDLQ', {
      retentionPeriod: Duration.days(14),
    });

    this.dispatchQueue = new sqs.Queue(this, 'DispatchQueue', {
      visibilityTimeout: Duration.seconds(60),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
    });

    const dispatcherFn = new NodejsFunction(this, 'DispatcherFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(currentDir, '..', 'lambda', 'dispatcher', 'index.ts'),
      handler: 'handler',
      timeout: Duration.seconds(30),
      memorySize: 128,
      environment: {
        ENGINE_FN_ARN: props.engineFn.functionArn,
      },
      bundling: {
        format: OutputFormat.ESM,
        target: 'node22',
      },
    });

    // 分派器消費分派佇列(佇列→分派器是 ESM;分派器→引擎是直接 Invoke)。
    dispatcherFn.addEventSource(
      new SqsEventSource(this.dispatchQueue, { batchSize: 1 }),
    );

    // 分派器可非同步 Invoke 引擎。
    props.engineFn.grantInvoke(dispatcherFn);
  }
}
