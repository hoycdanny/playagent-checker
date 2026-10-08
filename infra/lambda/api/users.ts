import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  AdminDeleteUserCommand,
  AdminUpdateUserAttributesCommand,
  ListUsersInGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';

/** 成員管理列表的一列(不含機密,只回可顯示欄位)。 */
export interface MemberRecord {
  username: string;
  email: string | null;
  tenantId: string | null;
  enabled: boolean;
  status: string | null;
  createdAt: string | null;
  /** 是否在 admins 群組(管理員)。 */
  admin?: boolean;
  /**
   * 帳號最後一次被修改的時間(Cognito UserLastModifiedDate)。
   * 注意:**不是最後登入時間** —— Cognito 的 ListUsers 不提供登入時間,
   * 要有「最後登入」得另外接 CloudTrail/Lambda 觸發器記錄,目前沒有。
   */
  updatedAt?: string | null;
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
  /** 設/取消管理員(admins 群組)。 */
  setAdmin(username: string, admin: boolean): Promise<void>;
  /** 由管理員直接設定新密碼(永久,使用者下次登入即用新密碼)。 */
  resetPassword(username: string, password: string): Promise<void>;
  /** 改租戶(custom:tenantId)。改完該成員只看得到新租戶的資料。 */
  setTenant(username: string, tenantId: string): Promise<void>;
  /** 永久刪除成員。 */
  deleteMember(username: string): Promise<void>;
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
      // 管理員名單用一次 ListUsersInGroup 取得(每個使用者各打一次
      // AdminListGroupsForUser 會變成 N 次 API 呼叫)。取不到就當作沒有人是管理員,
      // 但不讓整個清單失敗。
      const adminSet = new Set<string>();
      try {
        let t: string | undefined;
        do {
          const g = await client.send(
            new ListUsersInGroupCommand({
              UserPoolId: userPoolId,
              GroupName: ADMIN_GROUP,
              Limit: 60,
              ...(t ? { NextToken: t } : {}),
            }),
          );
          for (const u of g.Users ?? []) if (u.Username) adminSet.add(u.Username);
          t = g.NextToken;
        } while (t);
      } catch {
        /* 群組讀不到:admin 欄位留空,其餘照常回 */
      }
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
            admin: adminSet.has(u.Username ?? ''),
            updatedAt: u.UserLastModifiedDate ? u.UserLastModifiedDate.toISOString() : null,
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
        admin: input.admin === true,
      };
    },

    async setEnabled(username, enabled) {
      await client.send(
        enabled
          ? new AdminEnableUserCommand({ UserPoolId: userPoolId, Username: username })
          : new AdminDisableUserCommand({ UserPoolId: userPoolId, Username: username }),
      );
    },

    async setAdmin(username, admin) {
      await client.send(
        admin
          ? new AdminAddUserToGroupCommand({ UserPoolId: userPoolId, Username: username, GroupName: ADMIN_GROUP })
          : new AdminRemoveUserFromGroupCommand({ UserPoolId: userPoolId, Username: username, GroupName: ADMIN_GROUP }),
      );
    },

    async resetPassword(username, password) {
      await client.send(
        new AdminSetUserPasswordCommand({
          UserPoolId: userPoolId,
          Username: username,
          Password: password,
          // 永久密碼:使用者下次登入直接用,不會被要求改密碼(本平台沒有改密碼頁)。
          Permanent: true,
        }),
      );
    },

    async setTenant(username, tenantId) {
      await client.send(
        new AdminUpdateUserAttributesCommand({
          UserPoolId: userPoolId,
          Username: username,
          UserAttributes: [{ Name: 'custom:tenantId', Value: tenantId }],
        }),
      );
    },

    async deleteMember(username) {
      await client.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: username }));
    },
  };
}

/** 建立 Cognito client(與部署同區)。 */
export function makeCognitoAdminClient(region: string): CognitoIdentityProviderClient {
  return new CognitoIdentityProviderClient({ region });
}
