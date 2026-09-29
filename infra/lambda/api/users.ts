import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminAddUserToGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';

/** 成員管理列表的一列(不含機密,只回可顯示欄位)。 */
export interface MemberRecord {
  username: string;
  email: string | null;
  tenantId: string | null;
  enabled: boolean;
  status: string | null;
  createdAt: string | null;
}

export interface CreateMemberInput {
  email: string;
  password: string;
  tenantId: string;
  /** 是否加入 admins 群組(建立管理員)。 */
  admin?: boolean;
}

/** 成員管理(admin 專用):對 Cognito user pool 的使用者管理。注入以利測試。 */
export interface UserAdmin {
  listMembers(): Promise<MemberRecord[]>;
  createMember(input: CreateMemberInput): Promise<MemberRecord>;
  setEnabled(username: string, enabled: boolean): Promise<void>;
}

/** admin 群組名(與 CDK / tenant.ts ADMIN_GROUP 一致)。 */
const ADMIN_GROUP = 'admins';

function attr(
  attrs: { Name?: string; Value?: string }[] | undefined,
  name: string,
): string | null {
  const a = attrs?.find((x) => x.Name === name);
  return a?.Value ?? null;
}

/**
 * 以 Cognito SDK 實作 UserAdmin。所有動作 scope 到單一 user pool(IAM 亦限縮到本 pool)。
 * 建立成員:AdminCreateUser(SUPPRESS 不寄信)→ AdminSetUserPassword(permanent 免改密碼)
 * →(選)AdminAddUserToGroup(admins)。email 即 username。
 */
export function makeUserAdmin(
  client: CognitoIdentityProviderClient,
  userPoolId: string,
): UserAdmin {
  return {
    async listMembers() {
      const members: MemberRecord[] = [];
      let paginationToken: string | undefined;
      do {
        const res = await client.send(
          new ListUsersCommand({
            UserPoolId: userPoolId,
            Limit: 60,
            ...(paginationToken ? { PaginationToken: paginationToken } : {}),
          }),
        );
        for (const u of res.Users ?? []) {
          members.push({
            username: u.Username ?? '',
            email: attr(u.Attributes, 'email'),
            tenantId: attr(u.Attributes, 'custom:tenantId'),
            enabled: u.Enabled !== false,
            status: u.UserStatus ?? null,
            createdAt: u.UserCreateDate ? u.UserCreateDate.toISOString() : null,
          });
        }
        paginationToken = res.PaginationToken;
      } while (paginationToken);
      return members.sort((a, b) => (a.email ?? '').localeCompare(b.email ?? ''));
    },

    async createMember(input) {
      await client.send(
        new AdminCreateUserCommand({
          UserPoolId: userPoolId,
          Username: input.email,
          MessageAction: 'SUPPRESS',
          UserAttributes: [
            { Name: 'email', Value: input.email },
            { Name: 'email_verified', Value: 'true' },
            { Name: 'custom:tenantId', Value: input.tenantId },
          ],
        }),
      );
      await client.send(
        new AdminSetUserPasswordCommand({
          UserPoolId: userPoolId,
          Username: input.email,
          Password: input.password,
          Permanent: true,
        }),
      );
      if (input.admin) {
        await client.send(
          new AdminAddUserToGroupCommand({
            UserPoolId: userPoolId,
            Username: input.email,
            GroupName: ADMIN_GROUP,
          }),
        );
      }
      return {
        username: input.email,
        email: input.email,
        tenantId: input.tenantId,
        enabled: true,
        status: 'CONFIRMED',
        createdAt: new Date().toISOString(),
      };
    },

    async setEnabled(username, enabled) {
      await client.send(
        enabled
          ? new AdminEnableUserCommand({ UserPoolId: userPoolId, Username: username })
          : new AdminDisableUserCommand({ UserPoolId: userPoolId, Username: username }),
      );
    },
  };
}

/** 建立 Cognito client(與部署同區)。 */
export function makeCognitoAdminClient(region: string): CognitoIdentityProviderClient {
  return new CognitoIdentityProviderClient({ region });
}
