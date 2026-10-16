#!/usr/bin/env node
/**
 * 雲端 build web 探索 runner 映像(用既有 CodeBuild role)。把 agent/ 目錄(所有 .mjs +
 * Dockerfile.web + web-runner.package.json + buildspec.web.yml)打包上 S3,
 * 用 CodeBuild build + push 到 ECR playagent-web-runner:latest。不佔本機頻寬/磁碟。
 *
 * 用法:AWS_REGION=us-west-2 node cloudBuildWebRunner.mjs
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CodeBuildClient, CreateProjectCommand, UpdateProjectCommand, BatchGetProjectsCommand,
  StartBuildCommand, BatchGetBuildsCommand,
} from '@aws-sdk/client-codebuild';
import { packSource } from './packSource.mjs';
import { resolveImageBuildRoleArn } from './imageBuildRole.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = join(HERE, '..');           // agent/
const REGION = process.env.PA_SM_REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-west-2';
// 來源 zip 的暫存桶:手動建置用 PA_SM_BUCKET;自更新器(updater-stack)環境沒有它,
// 退回用資料桶 PA_DATA_BUCKET(更新器角色對它有讀寫權限),否則任何 agent/ 變更的自更新都會卡在這。
const BUCKET = (process.env.PA_SM_BUCKET || process.env.PA_DATA_BUCKET || '').trim();
if (!BUCKET) throw new Error('PA_SM_BUCKET or PA_DATA_BUCKET is required');
const IMAGE_REPO = 'playagent-web-runner';
const PROJECT = 'playagent-web-runner-build';
const SRC_KEY = 'codebuild/web-runner-src.zip';

const cb = new CodeBuildClient({ region: REGION });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf-8', ...opts });

async function main() {
  const roleArn = await resolveImageBuildRoleArn(REGION);
  log('build 角色', roleArn);

  // 打包 agent/ 需要的檔(buildspec 放最上層當 CodeBuild source root)。
  // buildspec.web.yml 放 zip 根並改名 buildspec.yml(跨平台打包,Windows 無 zip/bash 也可)。
  const zip = packSource({
    agentDir: AGENT_DIR,
    buildspecPath: join(HERE, 'buildspec.web.yml'),
    extraFiles: ['Dockerfile.web', 'web-runner.package.json'],
    zipName: 'web-runner-src.zip',
  });
  sh('aws', ['s3', 'cp', zip, `s3://${BUCKET}/${SRC_KEY}`, '--region', REGION, '--only-show-errors']);
  log('web runner source zip 上傳 → s3://' + `${BUCKET}/${SRC_KEY}`);

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
  log('web runner build 啟動', id);
  let lastPhase = '';
  while (true) {
    await sleep(20_000);
    const info = await cb.send(new BatchGetBuildsCommand({ ids: [id] }));
    const b = info.builds?.[0];
    if (!b) continue;
    if (b.currentPhase !== lastPhase) { log('phase:', b.currentPhase, b.buildStatus); lastPhase = b.currentPhase; }
    if (b.buildComplete) {
      log('web runner build 完成,status =', b.buildStatus);
      if (b.buildStatus !== 'SUCCEEDED') {
        const failed = (b.phases || []).filter((p) => p.phaseStatus && p.phaseStatus !== 'SUCCEEDED');
        log('失敗:', JSON.stringify(failed.map((p) => ({ phase: p.phaseType, status: p.phaseStatus, ctx: p.contexts }))));
        process.exitCode = 1;
      } else {
        log('✅ web runner 映像已推 ECR playagent-web-runner:latest');
      }
      return;
    }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
