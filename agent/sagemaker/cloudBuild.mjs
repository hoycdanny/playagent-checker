#!/usr/bin/env node
/**
 * 雲端 build 協調腳本:用 AWS CodeBuild 在 AWS 內完成「HF 下載 → S3 上傳 → docker build → ECR 推送」,
 * 不佔本機頻寬/磁碟。完成後本機只需跑 deployUitars.mjs 的 SageMaker 建端點步驟(純 API,無頻寬)。
 *
 * 流程:
 *   1. 確保 CodeBuild service role(ECR/S3/logs 權限)
 *   2. 把 agent/sagemaker 目錄打包成 zip 上傳 S3(當 CodeBuild source)
 *   3. 建/更新 CodeBuild project(privileged=true 供 docker build;image aws/codebuild/standard:7.0)
 *   4. StartBuild 並輪詢到完成,串流 log
 *
 * 需求:aws CLI、zip。環境變數:PA_SM_REGION(us-east-2)、PA_SM_BUCKET(foundation bucket)。
 */
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CodeBuildClient, CreateProjectCommand, UpdateProjectCommand, BatchGetProjectsCommand,
  StartBuildCommand, BatchGetBuildsCommand,
} from '@aws-sdk/client-codebuild';
import {
  IAMClient, CreateRoleCommand, PutRolePolicyCommand, GetRoleCommand,
} from '@aws-sdk/client-iam';

const HERE = dirname(fileURLToPath(import.meta.url));
const REGION = process.env.PA_SM_REGION || 'us-east-2';
const BUCKET = process.env.PA_SM_BUCKET || 'playagentdev-foundation-databuckete6b0faa8-r5hkpnrl2c5i';
const IMAGE_REPO = process.env.PA_SM_IMAGE_REPO || 'playagent-vllm-byoc';
const MODEL_ID = 'ByteDance-Seed/UI-TARS-1.5-7B';
const S3_PREFIX = 'sagemaker-models/ui-tars';
const PROJECT = 'playagent-uitars-build';
const ROLE_NAME = 'PlayAgentCodeBuildUitarsRole';
const SRC_KEY = 'codebuild/uitars-src.zip';

const cb = new CodeBuildClient({ region: REGION });
const iam = new IAMClient({ region: REGION });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf-8', ...opts });
}

async function ensureRole(accountId) {
  try {
    const r = await iam.send(new GetRoleCommand({ RoleName: ROLE_NAME }));
    return r.Role.Arn;
  } catch { /* create below */ }
  log('建立 CodeBuild role', ROLE_NAME);
  const trust = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'codebuild.amazonaws.com' }, Action: 'sts:AssumeRole' }] };
  const created = await iam.send(new CreateRoleCommand({ RoleName: ROLE_NAME, AssumeRolePolicyDocument: JSON.stringify(trust) }));
  const policy = {
    Version: '2012-10-17',
    Statement: [
      { Effect: 'Allow', Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'], Resource: '*' },
      { Effect: 'Allow', Action: ['ecr:GetAuthorizationToken'], Resource: '*' },
      { Effect: 'Allow', Action: [
        'ecr:BatchCheckLayerAvailability', 'ecr:CompleteLayerUpload', 'ecr:InitiateLayerUpload',
        'ecr:PutImage', 'ecr:UploadLayerPart', 'ecr:CreateRepository', 'ecr:DescribeRepositories',
        'ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer', 'ecr:PutImageScanningConfiguration',
      ], Resource: '*' },
      { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
        Resource: [`arn:aws:s3:::${BUCKET}`, `arn:aws:s3:::${BUCKET}/*`] },
    ],
  };
  await iam.send(new PutRolePolicyCommand({ RoleName: ROLE_NAME, PolicyName: 'inline', PolicyDocument: JSON.stringify(policy) }));
  log('role 建好,等 IAM 傳播 ~10s…');
  await sleep(12_000);
  return created.Role.Arn;
}

async function ensureProject(roleArn) {
  const source = { type: 'S3', location: `${BUCKET}/${SRC_KEY}`, buildspec: 'buildspec.yml' };
  const environment = {
    type: 'LINUX_CONTAINER',
    image: 'aws/codebuild/standard:7.0',
    computeType: 'BUILD_GENERAL1_LARGE', // 8 vCPU / 15GB;足夠 pull 大 base image + build
    privilegedMode: true,                 // docker build 需要
    environmentVariables: [
      { name: 'AWS_REGION', value: REGION },
      { name: 'IMAGE_REPO', value: IMAGE_REPO },
      { name: 'MODEL_ID', value: MODEL_ID },
      { name: 'S3_BUCKET', value: BUCKET },
      { name: 'S3_PREFIX', value: S3_PREFIX },
    ],
  };
  const artifacts = { type: 'NO_ARTIFACTS' };
  const timeoutInMinutes = 120;
  const existing = await cb.send(new BatchGetProjectsCommand({ names: [PROJECT] }));
  if (existing.projects && existing.projects.length > 0) {
    log('更新既有 CodeBuild project', PROJECT);
    await cb.send(new UpdateProjectCommand({ name: PROJECT, source, environment, artifacts, serviceRole: roleArn, timeoutInMinutes }));
  } else {
    log('建立 CodeBuild project', PROJECT);
    await cb.send(new CreateProjectCommand({ name: PROJECT, source, environment, artifacts, serviceRole: roleArn, timeoutInMinutes }));
  }
}

async function uploadSource() {
  const zip = '/tmp/uitars-src.zip';
  sh('rm', ['-f', zip]);
  // 只打包 build 需要的檔(Dockerfile.vllm / vllm_server.py / serve.sh / buildspec.yml)。
  sh('zip', ['-j', zip, 'Dockerfile.vllm', 'vllm_server.py', 'serve.sh', 'buildspec.yml'], { cwd: HERE });
  sh('aws', ['s3', 'cp', zip, `s3://${BUCKET}/${SRC_KEY}`, '--region', REGION, '--only-show-errors']);
  log('source zip 上傳完成 → s3://' + `${BUCKET}/${SRC_KEY}`);
}

async function runBuild() {
  const start = await cb.send(new StartBuildCommand({ projectName: PROJECT }));
  const id = start.build.id;
  log('build 啟動', id, '(輪詢中,雲端 build 通常 15–40 分)…');
  let lastPhase = '';
  while (true) {
    await sleep(20_000);
    const info = await cb.send(new BatchGetBuildsCommand({ ids: [id] }));
    const b = info.builds?.[0];
    if (!b) continue;
    if (b.currentPhase !== lastPhase) { log('phase:', b.currentPhase, b.buildStatus); lastPhase = b.currentPhase; }
    if (b.buildComplete) {
      log('build 完成,status =', b.buildStatus);
      if (b.buildStatus !== 'SUCCEEDED') {
        const failed = (b.phases || []).filter((p) => p.phaseStatus && p.phaseStatus !== 'SUCCEEDED');
        log('失敗 phase:', JSON.stringify(failed.map((p) => ({ phase: p.phaseType, status: p.phaseStatus, ctx: p.contexts })), null, 2));
        process.exitCode = 1;
      } else {
        log('✅ 雲端 build 成功:映像已推 ECR、模型已在 S3。');
        log('下一步:node deployUitars.mjs(帶 PA_SKIP_DOWNLOAD=1 PA_SKIP_UPLOAD=1 PA_SKIP_BUILD=1)建 SageMaker 端點。');
      }
      return b.buildStatus;
    }
  }
}

async function main() {
  const accountId = sh('aws', ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text']).trim();
  const roleArn = await ensureRole(accountId);
  await uploadSource();
  await ensureProject(roleArn);
  await runBuild();
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
