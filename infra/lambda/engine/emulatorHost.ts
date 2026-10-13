import {
  EC2Client,
  RunInstancesCommand,
  TerminateInstancesCommand,
  DescribeInstancesCommand,
  type _InstanceType,
} from '@aws-sdk/client-ec2';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AcquireSpec } from './deviceProvider.js';
import type { HostControl, ProvisionedKind } from './provisionedProvider.js';
import { costTagsAsEc2 } from './costTags.js';

/**
 * EmulatorHost —— 真實 EC2 + Redroid 主機控制面(參考 game-ai-qa 真機驗證配置)。
 *
 * 關鍵配置(實測得出,不可臆改):
 * - AMI 必須官方 Ubuntu(有 linux-modules-extra 提供 binder_linux;Amazon Linux 無 binder → boot 失敗)。
 * - 機型按 ABI:arm64-v8a→m7g.xlarge、x86_64→m6i.xlarge(16GB;Redroid 6GB+宿主+遊戲需 ~10-11GB)。
 * - 根卷 30GB(Ubuntu 預設 8GB 會被 docker+Redroid+APK 擠爆 → install 失敗)。
 * - guest 架構必須等於宿主架構(Redroid 是容器非 QEMU),故 ABI 連帶選 AMI 與機型。
 * - 主機自驅動:userdata 讀 tag → 扮租戶角色 → Redroid → 裝 APK → runner 迴圈 → 寫 status → 自我終結。
 *
 * 環境參數由 CDK 經 env 注入(execution-stack)。
 */

const REGION = process.env.AWS_REGION ?? 'us-west-2';
const BUCKET = process.env.DATA_BUCKET ?? '';
const TENANT_ROLE_ARN = process.env.TENANT_ROLE_ARN ?? '';
const HOST_PROFILE_ARN = process.env.EMULATOR_HOST_PROFILE_ARN ?? '';
const AMI_ARM64 = process.env.EMULATOR_AMI_ARM64 ?? '';
const AMI_X86 = process.env.EMULATOR_AMI_X86 ?? '';
const SUBNET_ID = process.env.DEVICE_SUBNET_ID ?? '';
const SG_ID = process.env.EMULATOR_HOST_SG_ID ?? '';

export const HOST_LIFECYCLE_TAG = 'hostLifecycle';
export const HOST_LIFECYCLE_PER_JOB = 'per-job';

/** ABI → 機型候選(首選 + 容量不足回落,皆同架構 16GB)。 */
const INSTANCE_TYPES: Record<string, string[]> = {
  'arm64-v8a': ['m7g.xlarge', 'm6g.xlarge', 'm7gd.xlarge'],
  x86_64: ['m6i.xlarge', 'm6a.xlarge', 'm5.xlarge'],
};
const DEFAULT_ABI = 'arm64-v8a';
const ROOT_VOLUME_GB = 40;

const ec2 = new EC2Client({ region: REGION });

/** 讀 userdata 腳本(bundle 時以 asset 隨附;讀取失敗則報錯,不靜默)。 */
function loadUserData(): string {
  const path = fileURLToPath(new URL('./emulator-userdata.sh', import.meta.url));
  return readFileSync(path, 'utf8');
}

function amiForAbi(abi: string): string {
  const ami = abi === 'x86_64' ? AMI_X86 : AMI_ARM64;
  if (!ami) throw new Error(`emulator: abi=${abi} 無對應 Ubuntu AMI(CDK 未注入 EMULATOR_AMI_*)`);
  return ami;
}

const CAPACITY_ERRORS = ['InsufficientInstanceCapacity', 'InsufficientHostCapacity', 'Unsupported'];
function isCapacityError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return typeof name === 'string' && CAPACITY_ERRORS.includes(name);
}

export interface EmulatorAcquireSpec extends AcquireSpec {
  abi?: string;
  vlmModel?: string;
  /** 決策 / 輔助 Agent 模型(三個 Agent 協作)。 */
  agentModel?: string;
  subagentModel?: string;
  maxSteps?: number;
  /** 主機保險回收時間(分鐘);長時測試依需要調大。 */
  ttlMinutes?: number;
  budgetUsd?: number;
}

export class EmulatorHostControl implements HostControl {
  async provisionHost(
    spec: EmulatorAcquireSpec,
    _kind: ProvisionedKind,
  ): Promise<{ instanceId: string; endpoint: string }> {
    if (!SUBNET_ID || !SG_ID || !HOST_PROFILE_ARN) {
      throw new Error(
        'emulator 主機環境未配置(需 DEVICE_SUBNET_ID / EMULATOR_HOST_SG_ID / EMULATOR_HOST_PROFILE_ARN)',
      );
    }
    const abi = spec.abi ?? DEFAULT_ABI;
    const amiId = amiForAbi(abi);
    const candidates = INSTANCE_TYPES[abi] ?? INSTANCE_TYPES[DEFAULT_ABI]!;
    const userData = Buffer.from(loadUserData()).toString('base64');

    // 防重複起機:先按 jobId tag 找已起的主機(durable 重試複用)。
    const existing = await this.findExisting(spec.jobId);
    if (existing) return { instanceId: existing, endpoint: `ec2:${existing}` };

    const errors: string[] = [];
    for (const instanceType of candidates) {
      try {
        const res = await ec2.send(
          new RunInstancesCommand({
            ImageId: amiId,
            InstanceType: instanceType as _InstanceType,
            MinCount: 1,
            MaxCount: 1,
            SubnetId: SUBNET_ID,
            SecurityGroupIds: [SG_ID],
            UserData: userData,
            ClientToken: `${spec.jobId}-${instanceType}`,
            // userdata 的 TTL `shutdown -h` 與結束時都要「終止」實例(不是停止),EBS 不殘留計費。
            InstanceInitiatedShutdownBehavior: 'terminate',
            IamInstanceProfile: { Arn: HOST_PROFILE_ARN },
            BlockDeviceMappings: [
              {
                DeviceName: '/dev/sda1',
                Ebs: { VolumeSize: ROOT_VOLUME_GB, VolumeType: 'gp3', DeleteOnTermination: true },
              },
            ],
            TagSpecifications: [
              {
                ResourceType: 'instance',
                Tags: [
                  { Key: 'Name', Value: `playagent-emu-${spec.jobId}` },
                  { Key: HOST_LIFECYCLE_TAG, Value: HOST_LIFECYCLE_PER_JOB },
                  { Key: 'playagent:jobId', Value: spec.jobId },
                  { Key: 'playagent:tenantId', Value: spec.tenantId },
                  { Key: 'playagent:bucket', Value: BUCKET },
                  { Key: 'playagent:tenantRole', Value: TENANT_ROLE_ARN },
                  { Key: 'playagent:vlmModel', Value: spec.vlmModel ?? '' },
                  { Key: 'playagent:agentModel', Value: spec.agentModel ?? '' },
                  { Key: 'playagent:subagentModel', Value: spec.subagentModel ?? '' },
                  { Key: 'playagent:maxSteps', Value: spec.maxSteps ? String(spec.maxSteps) : '' },
                  { Key: 'playagent:ttlMinutes', Value: String(spec.ttlMinutes ?? 720) },
                  { Key: 'playagent:budget', Value: String(spec.budgetUsd ?? 1) },
                  // 成本分攤標籤(project/stage/component + 部署者帶入):讓執行期 EC2 也能在
                  // Cost Explorer 依同一組標籤歸屬。與上方保留標籤合併(重複鍵以上方為準罕見)。
                  ...costTagsAsEc2(),
                ],
              },
              {
                // EBS 根磁碟同步貼標,否則 EBS 成本無法依標籤歸屬。
                ResourceType: 'volume',
                Tags: [
                  { Key: 'Name', Value: `playagent-emu-${spec.jobId}` },
                  { Key: HOST_LIFECYCLE_TAG, Value: HOST_LIFECYCLE_PER_JOB },
                  { Key: 'playagent:jobId', Value: spec.jobId },
                  ...costTagsAsEc2(),
                ],
              },
            ],
          }),
        );
        const instanceId = res.Instances?.[0]?.InstanceId;
        if (!instanceId) throw new Error('RunInstances 未回傳 instanceId');
        return { instanceId, endpoint: `ec2:${instanceId}` };
      } catch (err) {
        if (!isCapacityError(err)) throw err;
        errors.push(`${instanceType}:${(err as Error).name}`);
      }
    }
    throw new Error(`emulator: 全部候選機型無容量(${errors.join('; ')})`);
  }

  private async findExisting(jobId: string): Promise<string | null> {
    const res = await ec2.send(
      new DescribeInstancesCommand({
        Filters: [
          { Name: 'tag:playagent:jobId', Values: [jobId] },
          { Name: 'instance-state-name', Values: ['pending', 'running'] },
        ],
      }),
    );
    return res.Reservations?.flatMap((r) => r.Instances ?? [])[0]?.InstanceId ?? null;
  }

  async terminateHost(instanceId: string): Promise<void> {
    try {
      await ec2.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'InvalidInstanceID.NotFound' || name === 'InvalidInstanceID.Malformed') return;
      throw err;
    }
  }

  async isTerminated(instanceId: string): Promise<boolean> {
    try {
      const res = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
      const state = res.Reservations?.[0]?.Instances?.[0]?.State?.Name ?? 'unknown';
      return state === 'terminated' || state === 'shutting-down';
    } catch (err) {
      // 實例 aging out → NotFound 視為已終結。
      if ((err as { name?: string }).name === 'InvalidInstanceID.NotFound') return true;
      throw err;
    }
  }
}
