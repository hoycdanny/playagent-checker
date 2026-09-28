#!/usr/bin/env node
/**
 * 雲端 build exploration runner 映像(用既有 CodeBuild role)。把 agent/ 目錄(所有 .mjs +
 * Dockerfile.exploration + exploration-runner.package.json + buildspec.runner.yml)打包上 S3,
 * 用 CodeBuild build + push 到 ECR playagent-exploration-runner:latest。不佔本機頻寬/磁碟。
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CodeBuildClient, CreateProjectCommand, UpdateProjectCommand, BatchGetProjectsCommand,
  StartBuildCommand, BatchGetBuildsCommand,
} from '@aws-sdk/client-codebuild';
import { IAMClient, GetRoleCommand } from '@aws-sdk/client-iam';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = join(HERE, '..');           // agent/
const REGION = process.env.PA_SM_REGION || 'us-east-2';
const BUCKET = process.env.PA_SM_BUCKET || 'playagentdev-foundation-databuckete6b0faa8-r5hkpnrl2c5i';
const IMAGE_REPO = 'playagent-exploration-runner';
const PROJECT = 'playagent-runner-build';
const ROLE_NAME = 'PlayAgentCodeBuildUitarsRole';
const SRC_KEY = 'codebuild/runner-src.zip';

const cb = new CodeBuildClient({ region: REGION });
const iam = new IAMClient({ region: REGION });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf-8', ...opts });

async function main() {
  const roleArn = (await iam.send(new GetRoleCommand({ RoleName: ROLE_NAME }))).Role.Arn;

  // 打包 agent/ 需要的檔(buildspec 放最上層當 CodeBuild source root)。
  const zip = '/tmp/runner-src.zip';
  sh('rm', ['-f', zip]);
  // buildspec.runner.yml 要在 zip 根,改名 buildspec.yml。
  sh('cp', [join(HERE, 'buildspec.runner.yml'), join(AGENT_DIR, 'buildspec.yml')]);
  sh('bash', ['-c', `cd "${AGENT_DIR}" && zip -q "${zip}" *.mjs Dockerfile.exploration exploration-runner.package.json buildspec.yml`]);
  sh('rm', ['-f', join(AGENT_DIR, 'buildspec.yml')]);
  sh('aws', ['s3', 'cp', zip, `s3://${BUCKET}/${SRC_KEY}`, '--region', REGION, '--only-show-errors']);
  log('runner source zip 上傳 → s3://' + `${BUCKET}/${SRC_KEY}`);

  const source = { type: 'S3', location: `${BUCKET}/${SRC_KEY}`, buildspec: 'buildspec.yml' };
  const environment = {
    type: 'LINUX_CONTAINER', image: 'aws/codebuild/standard:7.0',
    computeType: 'BUILD_GENERAL1_MEDIUM', privilegedMode: true,
    environmentVariables: [
      { name: 'AWS_REGION', value: REGION },
      { name: 'IMAGE_REPO', value: IMAGE_REPO },
    ],
  };
  const artifacts = { type: 'NO_ARTIFACTS' };
  const existing = await cb.send(new BatchGetProjectsCommand({ names: [PROJECT] }));
  if (existing.projects && existing.projects.length > 0) {
    await cb.send(new UpdateProjectCommand({ name: PROJECT, source, environment, artifacts, serviceRole: roleArn, timeoutInMinutes: 60 }));
    log('更新 project', PROJECT);
  } else {
    await cb.send(new CreateProjectCommand({ name: PROJECT, source, environment, artifacts, serviceRole: roleArn, timeoutInMinutes: 60 }));
    log('建立 project', PROJECT);
  }

  const start = await cb.send(new StartBuildCommand({ projectName: PROJECT }));
  const id = start.build.id;
  log('runner build 啟動', id);
  let lastPhase = '';
  while (true) {
    await sleep(20_000);
    const info = await cb.send(new BatchGetBuildsCommand({ ids: [id] }));
    const b = info.builds?.[0];
    if (!b) continue;
    if (b.currentPhase !== lastPhase) { log('phase:', b.currentPhase, b.buildStatus); lastPhase = b.currentPhase; }
    if (b.buildComplete) {
      log('runner build 完成,status =', b.buildStatus);
      if (b.buildStatus !== 'SUCCEEDED') {
        const failed = (b.phases || []).filter((p) => p.phaseStatus && p.phaseStatus !== 'SUCCEEDED');
        log('失敗:', JSON.stringify(failed.map((p) => ({ phase: p.phaseType, status: p.phaseStatus, ctx: p.contexts }))));
        process.exitCode = 1;
      } else {
        log('✅ exploration runner 映像已推 ECR playagent-exploration-runner:latest');
      }
      return;
    }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
