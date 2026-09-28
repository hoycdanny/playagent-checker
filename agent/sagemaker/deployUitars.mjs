#!/usr/bin/env node
/**
 * 部署 UI-TARS-1.5-7B 到 SageMaker real-time endpoint(us-east-2, ml.g6e.xlarge)。
 * 移植自 game-ai-qa 的 vllm 部署流程,精簡成單一自足腳本(不背 CLI 框架)。
 *
 * 流程:HF 下載模型 → S3 上傳(未壓縮字首)→ 確認 ECR vLLM 映像 → CreateModel/EndpointConfig/Endpoint
 *      → 等 InService → 印出 endpoint 名。失敗逆序回滾(刪 Creating endpoint / config / model)。
 *
 * 前置:
 *   - hf CLI(~/.local/bin/hf 或 PATH 內的 huggingface-cli)
 *   - docker(build vLLM 映像;或先手動跑 build_vllm.sh)
 *   - AWS 憑證(us-east-2)
 *
 * 環境變數:
 *   PA_SM_ROLE_ARN    SageMaker 執行角色(預設 ArtSmokerSageMakerRole 的 arn,見下)
 *   PA_SM_BUCKET      staging 權重的 S3 bucket(預設用 foundation data bucket)
 *   PA_SM_REGION      預設 us-east-2
 *   PA_SM_INSTANCE    預設 ml.g6e.xlarge
 *   PA_SM_IMAGE_REPO  預設 playagent-vllm-byoc
 *   PA_SKIP_DOWNLOAD  =1 時跳過 HF 下載(權重已在 S3)
 *   PA_SKIP_BUILD     =1 時跳過 docker build(映像已在 ECR)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SageMakerClient, CreateModelCommand, CreateEndpointConfigCommand, CreateEndpointCommand,
  DescribeEndpointCommand, DeleteEndpointCommand, DeleteEndpointConfigCommand, DeleteModelCommand,
} from '@aws-sdk/client-sagemaker';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REGION = process.env.PA_SM_REGION || 'us-east-2';
const INSTANCE = process.env.PA_SM_INSTANCE || 'ml.g6e.xlarge';
const IMAGE_REPO = process.env.PA_SM_IMAGE_REPO || 'playagent-vllm-byoc';
const MODEL_ID = 'ByteDance-Seed/UI-TARS-1.5-7B';
const PRESET = 'ui-tars';
const MAX_MODEL_LEN = '32768';
const DTYPE = 'bfloat16';
const MODEL_TYPE = 'multimodal';
const SERVED_NAME = 'default';
const ROLE_ARN = process.env.PA_SM_ROLE_ARN || 'arn:aws:iam::137068253259:role/ArtSmokerSageMakerRole';
const BUCKET = process.env.PA_SM_BUCKET || 'playagentdev-foundation-databuckete6b0faa8-r5hkpnrl2c5i';
const S3_PREFIX = `sagemaker-models/${PRESET}`;
const LOCAL_DIR = join(HERE, `.models/${PRESET}`);
const HF_BIN = existsSync(`${process.env.HOME}/.local/bin/hf`) ? `${process.env.HOME}/.local/bin/hf` : 'hf';

const sm = new SageMakerClient({ region: REGION });
const sts = new STSClient({ region: REGION });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function sh(cmd, args, opts = {}) {
  log('$', cmd, args.join(' '));
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} 失敗(exit ${r.status})`);
}

async function ecrImageExists(accountId) {
  try {
    execFileSync('aws', ['ecr', 'describe-images', '--repository-name', IMAGE_REPO,
      '--image-ids', 'imageTag=latest', '--region', REGION], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

async function main() {
  const accountId = (await sts.send(new GetCallerIdentityCommand({}))).Account;
  if (!accountId) throw new Error('取不到 AWS account id(檢查憑證)');
  const image = `${accountId}.dkr.ecr.${REGION}.amazonaws.com/${IMAGE_REPO}:latest`;

  // Step 1: HF 下載
  if (process.env.PA_SKIP_DOWNLOAD === '1') {
    log('跳過 HF 下載(PA_SKIP_DOWNLOAD=1)');
  } else {
    log(`HF 下載 ${MODEL_ID} → ${LOCAL_DIR}`);
    sh(HF_BIN, ['download', MODEL_ID, '--local-dir', LOCAL_DIR]);
  }

  // Step 2: S3 上傳(未壓縮字首)
  const s3Uri = `s3://${BUCKET}/${S3_PREFIX}/`;
  if (process.env.PA_SKIP_DOWNLOAD === '1' && process.env.PA_SKIP_UPLOAD === '1') {
    log('跳過 S3 上傳(PA_SKIP_UPLOAD=1)');
  } else {
    log(`S3 上傳 → ${s3Uri}`);
    sh('aws', ['s3', 'sync', LOCAL_DIR, s3Uri, '--region', REGION, '--only-show-errors']);
  }

  // Step 3: ECR 映像
  if (process.env.PA_SKIP_BUILD === '1') {
    log('跳過 docker build(PA_SKIP_BUILD=1)');
  } else if (await ecrImageExists(accountId)) {
    log(`ECR 已有 ${image},複用`);
  } else {
    log('build + push vLLM BYOC 映像…');
    sh('bash', [join(HERE, 'build_vllm.sh')], { env: { ...process.env, AWS_REGION: REGION, IMAGE_REPO } });
  }

  // Step 4: SageMaker 資源
  const stamp = ts();
  const modelName = `${PRESET}-model-${stamp}`;
  const configName = `${PRESET}-config-${stamp}`;
  const endpointName = `${PRESET}-${stamp}`;
  log('endpoint 名(先記下,萬一中途失敗可據此清理遺留資源):', endpointName);

  const created = { models: [], configs: [], endpoints: [] };
  try {
    await sm.send(new CreateModelCommand({
      ModelName: modelName,
      PrimaryContainer: {
        Image: image,
        // 未壓縮 S3 字首必須用 ModelDataSource(ModelDataUrl 只吃 *.tar.gz 單檔)。
        ModelDataSource: { S3DataSource: { S3Uri: s3Uri, S3DataType: 'S3Prefix', CompressionType: 'None' } },
        Environment: {
          MODEL_ID, SERVED_MODEL_NAME: SERVED_NAME,
          MAX_MODEL_LEN, DTYPE, MODEL_TYPE,
          SAGEMAKER_BIND_TO_PORT: '8080',
          VLLM_WORKER_MULTIPROC_METHOD: 'spawn',
        },
      },
      ExecutionRoleArn: ROLE_ARN,
    }));
    created.models.push(modelName);
    log('CreateModel OK', modelName);

    await sm.send(new CreateEndpointConfigCommand({
      EndpointConfigName: configName,
      ProductionVariants: [{
        VariantName: 'AllTraffic', ModelName: modelName,
        InitialInstanceCount: 1, InstanceType: INSTANCE,
        ContainerStartupHealthCheckTimeoutInSeconds: 1800,
        ModelDataDownloadTimeoutInSeconds: 1800,
      }],
    }));
    created.configs.push(configName);
    log('CreateEndpointConfig OK', configName);

    await sm.send(new CreateEndpointCommand({ EndpointName: endpointName, EndpointConfigName: configName }));
    created.endpoints.push(endpointName);
    log('CreateEndpoint OK,等待 InService(7B 冷啟通常 8–15 分鐘)…');

    const start = Date.now();
    const TIMEOUT = 30 * 60_000;
    while (true) {
      if (Date.now() - start > TIMEOUT) throw new Error(`等 InService 超時(${TIMEOUT / 60000} 分)`);
      const resp = await sm.send(new DescribeEndpointCommand({ EndpointName: endpointName }));
      log('endpoint status:', resp.EndpointStatus);
      if (resp.EndpointStatus === 'InService') break;
      if (resp.EndpointStatus === 'Failed') throw new Error(`endpoint Failed: ${resp.FailureReason ?? '未知'}`);
      await sleep(30_000);
    }

    log('✅ InService! endpoint 名:', endpointName);
    console.log(`\nENDPOINT_NAME=${endpointName}`);
  } catch (err) {
    log('部署失敗,回滾…', err.message);
    for (const name of created.endpoints) {
      try {
        const st = (await sm.send(new DescribeEndpointCommand({ EndpointName: name }))).EndpointStatus;
        if (st === 'Creating') { await sm.send(new DeleteEndpointCommand({ EndpointName: name })); log('已刪 Creating endpoint', name); }
        else log('保留 endpoint 供診斷(非 Creating)', name, st);
      } catch (e) { log('回滾 endpoint 失敗', name, e.message); }
    }
    for (const name of created.configs) { try { await sm.send(new DeleteEndpointConfigCommand({ EndpointConfigName: name })); } catch (e) { log('回滾 config 失敗', name, e.message); } }
    for (const name of created.models) { try { await sm.send(new DeleteModelCommand({ ModelName: name })); } catch (e) { log('回滾 model 失敗', name, e.message); } }
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
