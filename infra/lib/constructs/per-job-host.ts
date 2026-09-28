import { Duration } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export type HostKind = 'emulator' | 'windows';

export interface PerJobHostProps {
  vpc: ec2.IVpc;
  kind: HostKind;
}

/**
 * PerJobHost —— 每任務起停的專屬裝置主機(Req 4.3)。
 *
 * - `emulator`:普通 EC2(Graviton/Intel 視 APK ABI)跑 Docker Redroid(Android-in-Docker,
 *   需核心 binder 模組 + 特權容器,故無法純無伺服器化)。
 * - `windows`:Windows EC2 + Appium/WinAppDriver,需互動式登入桌面(AutoLogon + reboot)。
 *
 * 本 construct 提供:主機 IAM 角色、安全群組、以及 userdata 範本引用。實際主機由
 * Lifecycle 於每個 job 動態 RunInstances 起(帶 hostLifecycle=per-job tag),終態即銷毀。
 *
 * 註:此環境無 Docker daemon、且開真 EC2 會計費,故「主機真的起來跑 Redroid/Appium」
 *     這段端到端無法在此驗證;此處落地的是 IaC 骨架與權限,可 synth、可 assertions。
 */
export class PerJobHost extends Construct {
  readonly hostRole: iam.Role;
  readonly securityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: PerJobHostProps) {
    super(scope, id);

    this.hostRole = new iam.Role(this, 'HostRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: `Per-job ${props.kind} device host role`,
      managedPolicies: [
        // 允許 SSM 管理(運維連線、送指令)。
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    this.securityGroup = new ec2.SecurityGroup(this, 'HostSg', {
      vpc: props.vpc,
      description: `Per-job ${props.kind} host SG (no public inbound; engine connects from within VPC)`,
      allowAllOutbound: true,
    });

    if (props.kind === 'emulator') {
      // 容器內引擎經 VPC 連 ADB(5555)。僅允許 VPC 內來源。
      this.securityGroup.addIngressRule(
        ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
        ec2.Port.tcp(5555),
        'ADB from engine within VPC',
      );
    } else {
      // Windows Appium server(4725)僅允許 VPC 內來源。
      this.securityGroup.addIngressRule(
        ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
        ec2.Port.tcp(4725),
        'Appium from engine within VPC',
      );
    }
  }

  /** 每任務主機的租約 TTL 上限(供 Lifecycle 逾時回收參考)。 */
  static readonly MAX_LEASE = Duration.hours(2);
}
