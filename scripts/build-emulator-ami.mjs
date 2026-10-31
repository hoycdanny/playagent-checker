#!/usr/bin/env node
/**
 * 建「預裝好的 emulator 主機 AMI」,並把 AMI id 寫進 SSM 讓 engine 下次起機器時用。
 *
 * 為什麼要它:每個 emulator 任務的前置作業實測 138 秒,其中 apt 裝套件 80 秒、
 * docker pull Redroid 16 秒,而真正被測的 APK 下載加安裝只佔 10 秒。把固定的那部分
 * 預先裝進 AMI,每次任務省約 1.5 分鐘的 EC2 時間(見 docs/design/emulator-snapshot.md)。
 *
 * 流程:公用 Ubuntu AMI 起一台機器 → 跑 scripts/emulator-ami-userdata.sh → 它自己 poweroff
 *       → CreateImage → 等 available → 寫 SSM 參數 → 終止建置機。
 *
 * 設計上刻意「可退回」:engine 讀不到 SSM 參數就用公用 AMI。所以 AMI 壞掉時
 * 只要刪掉那個參數,行為立刻回到原本的樣子,不必重新部署。
 *
 * 用法:
 *   node scripts/build-emulator-ami.mjs --region us-west-2 --stack PlayAgentDev-Execution
 *   node scripts/build-emulator-ami.mjs --arch x86          # 預設 arm64
 *   node scripts/build-emulator-ami.mjs --keep-on-failure   # 失敗時保留機器供查問題
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const o = { region: process.env.AWS_REGION || 'us-west-2', stack: 'PlayAgentDev-Execution', arch: 'arm64', keepOnFailure: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--region') o.region = argv[++i];
    else if (a === '--stack') o.stack = argv[++i];
    else if (a === '--arch') o.arch = argv[++i];
    else if (a === '--keep-on-failure') o.keepOnFailure = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`不認得的參數:${a}`);
  }
  if (!['arm64', 'x86'].includes(o.arch)) throw new Error(`--arch 只能是 arm64 或 x86(給的是 ${o.arch})`);
  return o;
}

const log = (...m) => console.log(new Date().toISOString().slice(11, 19), ...m);

function aws(args, { json = true } = {}) {
  const out = execFileSync('aws', args, { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
  return json ? JSON.parse(out || 'null') : out.trim();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 從 engine Lambda 的環境變數讀網路與 AMI 設定。
 *
 * 為什麼讀 Lambda 而不是 CloudFormation outputs:這些值(subnet / SG / instance profile /
 * 公用 AMI id)CDK 都已經注入 engine 了,從那裡讀保證與實際起機器時用的是同一組。
 * 另外抄一份參數進這支腳本,遲早會與部署漂移。
 */
function readEngineEnv(region, stack) {
  const res = aws(['cloudformation', 'describe-stack-resources', '--stack-name', stack, '--region', region,
    '--query', "StackResources[?ResourceType=='AWS::Lambda::Function'].[LogicalResourceId,PhysicalResourceId]",
    '--output', 'json']);
  const fn = (res ?? []).find(([lid]) => /EngineFn/i.test(lid));
  if (!fn) throw new Error(`在 stack ${stack} 找不到 EngineFn(有 ${(res ?? []).map((r) => r[0]).join(', ') || '(無 Lambda)'})`);
  const cfg = aws(['lambda', 'get-function-configuration', '--function-name', fn[1], '--region', region,
    '--query', 'Environment.Variables', '--output', 'json']);
  return cfg ?? {};
}

async function waitFor(label, check, { timeoutMs, everyMs = 15_000 }) {
  const until = Date.now() + timeoutMs;
  let last = '';
  for (;;) {
    const v = await check();
    if (v.done) return v;
    if (v.state !== last) { log(`  ${label}: ${v.state}`); last = v.state; }
    if (Date.now() > until) throw new Error(`${label} 逾時(最後狀態 ${v.state})`);
    await sleep(everyMs);
  }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    const src = readFileSync(new URL(import.meta.url), 'utf-8');
    console.log(src.slice(src.indexOf('/**') + 3, src.indexOf('*/')).replace(/^ \* ?/gm, '').trim());
    return;
  }
  log(`region=${o.region} stack=${o.stack} arch=${o.arch}`);

  const env = readEngineEnv(o.region, o.stack);
  const baseAmi = o.arch === 'x86' ? env.EMULATOR_AMI_X86 : env.EMULATOR_AMI_ARM64;
  const profile = env.EMULATOR_HOST_PROFILE_ARN;
  const sg = env.EMULATOR_HOST_SG_ID;
  // 跨 AZ 候選:m7g 在單一 AZ 可能容量不足(實測 us-west-2a 就不夠)。
  // DEVICE_SUBNET_ID 只有一個,所以把 VPC 的 public subnet 清單也拿來當回落。
  const subnets = [...new Set([env.DEVICE_SUBNET_ID, ...String(env.WEB_ECS_SUBNETS ?? '').split(',')].filter(Boolean))];
  const missing = Object.entries({ baseAmi, profile, sg }).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length || subnets.length === 0) throw new Error(`engine 環境缺少:${[...missing, ...(subnets.length ? [] : ['subnets'])].join(', ')}`);
  log(`base AMI=${baseAmi}  subnets=${subnets.join(',')}`);

  const types = o.arch === 'x86' ? ['m6i.xlarge', 'm6a.xlarge', 'm5.xlarge'] : ['m7g.xlarge', 'm6g.xlarge', 'm7gd.xlarge'];
  const userData = join(HERE, 'emulator-ami-userdata.sh');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
  const name = `playagent-emulator-${o.arch}-${stamp}`;

  // 起建置機。shutdown behavior 必須是 stop(不是 terminate)—— 預裝腳本結尾 poweroff,
  // 我們要的是「停下來讓它可以 CreateImage」,不是消失。
  let iid = '';
  const errors = [];
  outer:
  for (const subnet of subnets) {
    for (const type of types) {
      try {
        log(`起建置機 ${type} @ ${subnet}`);
        iid = aws(['ec2', 'run-instances', '--region', o.region,
          '--image-id', baseAmi, '--instance-type', type,
          '--subnet-id', subnet, '--security-group-ids', sg,
          '--iam-instance-profile', `Arn=${profile}`,
          '--instance-initiated-shutdown-behavior', 'stop',
          '--block-device-mappings', 'DeviceName=/dev/sda1,Ebs={VolumeSize=40,VolumeType=gp3,DeleteOnTermination=true}',
          '--tag-specifications', `ResourceType=instance,Tags=[{Key=Name,Value=${name}-builder},{Key=project,Value=playagent-checker},{Key=hostLifecycle,Value=per-job}]`,
          '--user-data', `fileb://${userData}`,
          '--query', 'Instances[0].InstanceId', '--output', 'text'], { json: false });
        break outer;
      } catch (e) {
        const msg = String(e.stderr || e.message).slice(0, 200);
        errors.push(`${type}@${subnet}: ${msg}`);
        log(`  起不來,換下一個:${msg.split('\n')[0]}`);
      }
    }
  }
  if (!iid) throw new Error(`所有機型/子網都起不來:\n${errors.join('\n')}`);
  log(`建置機 ${iid}`);

  const terminate = () => {
    try { aws(['ec2', 'terminate-instances', '--instance-ids', iid, '--region', o.region, '--output', 'text'], { json: false }); log(`已終止建置機 ${iid}`); }
    catch (e) { log(`終止建置機失敗(請手動處理 ${iid}):${String(e.message).slice(0, 160)}`); }
  };

  try {
    // 預裝腳本做完會 poweroff → 實例進入 stopped。這是「預裝完成」的訊號。
    await waitFor('預裝', async () => {
      const s = aws(['ec2', 'describe-instances', '--instance-ids', iid, '--region', o.region,
        '--query', 'Reservations[0].Instances[0].State.Name', '--output', 'text'], { json: false });
      if (s === 'stopped') return { done: true, state: s };
      if (['terminated', 'shutting-down'].includes(s)) throw new Error(`建置機意外結束(${s});預裝腳本可能失敗`);
      return { done: false, state: s };
    }, { timeoutMs: 30 * 60_000, everyMs: 20_000 });
    log('預裝完成(實例已停止)');

    const amiId = aws(['ec2', 'create-image', '--instance-id', iid, '--region', o.region,
      '--name', name, '--description', `PlayAgent emulator host prebaked (${o.arch})`,
      '--tag-specifications', `ResourceType=image,Tags=[{Key=Name,Value=${name}},{Key=project,Value=playagent-checker}]`,
      '--query', 'ImageId', '--output', 'text'], { json: false });
    log(`CreateImage → ${amiId}`);

    await waitFor('AMI', async () => {
      const s = aws(['ec2', 'describe-images', '--image-ids', amiId, '--region', o.region,
        '--query', 'Images[0].State', '--output', 'text'], { json: false });
      if (s === 'available') return { done: true, state: s };
      if (s === 'failed') throw new Error('AMI 建置失敗(state=failed)');
      return { done: false, state: s };
    }, { timeoutMs: 45 * 60_000, everyMs: 30_000 });
    log('AMI available');

    // 寫 SSM:engine 下次起機器就會用它。stackName 去掉 -Execution 後綴以對齊既有慣例
    // (/playagent/<stackPrefix>/...),與 deployed-version 等參數同一層。
    const prefix = `/playagent/${o.stack.replace(/-Execution$/, '')}`;
    const param = `${prefix}/emulator-ami-${o.arch}`;
    aws(['ssm', 'put-parameter', '--name', param, '--value', amiId, '--type', 'String', '--overwrite',
      '--region', o.region, '--output', 'text'], { json: false });
    log(`已寫入 SSM ${param} = ${amiId}`);

    terminate();
    console.log('');
    console.log(`完成。AMI = ${amiId}`);
    console.log(`下次 emulator 任務會自動用它(engine 讀 ${param})。`);
    console.log('要回到原本的公用 AMI:');
    console.log(`  aws ssm delete-parameter --name ${param} --region ${o.region}`);
  } catch (e) {
    if (o.keepOnFailure) log(`失敗,依 --keep-on-failure 保留建置機 ${iid} 供查問題`);
    else terminate();
    throw e;
  }
}

main().catch((e) => { console.error(`\n失敗:${e.message}`); process.exitCode = 1; });
