/**
 * 測試憑證「值」的寫入層(Secrets Manager)—— 與 secretRefStore(只存名稱清單)分離。
 *
 * 安全不變式(對齊 Req 14):
 * - 明文只寫進 AWS Secrets Manager,永不落 S3、永不回傳給前端(本模組沒有 get/read 值的函式)。
 * - 名稱一律落租戶前綴 playagent/tenant/<tenantId>/;跨租戶名稱由呼叫端(core)以 tenantSecretPrefix 驗證。
 * - runner 執行時才用 task role 讀值(GetSecretValue),不經此模組。
 *
 * upsert 語意:secret 不存在 → CreateSecret;已存在 → PutSecretValue。以 ResourceExistsException 判別。
 */
import {
  SecretsManagerClient,
  CreateSecretCommand,
  PutSecretValueCommand,
  DeleteSecretCommand,
} from '@aws-sdk/client-secrets-manager';

/** 供注入以利測試的最小介面(真實為 Secrets Manager)。 */
export interface SecretWriter {
  /** 建立或更新某機密的明文值(upsert)。 */
  putSecretValue(name: string, value: string): Promise<void>;
  /** 刪除某機密(含排程刪除;找不到視為成功)。 */
  deleteSecret(name: string): Promise<void>;
}

/** 用真實 Secrets Manager client 實作 SecretWriter。 */
export function makeSecretWriter(region: string): SecretWriter {
  const client = new SecretsManagerClient({ region });
  return {
    async putSecretValue(name: string, value: string): Promise<void> {
      try {
        await client.send(
          new CreateSecretCommand({
            Name: name,
            SecretString: value,
            // 貼標便於審計/成本歸屬,並標記由本平台建立。
            Tags: [{ Key: 'managed-by', Value: 'playagent-checker' }],
          }),
        );
      } catch (err) {
        // 已存在 → 改用 PutSecretValue 更新版本。
        if (err instanceof Error && err.name === 'ResourceExistsException') {
          await client.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }));
          return;
        }
        throw err;
      }
    },
    async deleteSecret(name: string): Promise<void> {
      try {
        // 立即刪除(不留 recovery window),讓同名可即時重建;找不到視為成功。
        await client.send(
          new DeleteSecretCommand({ SecretId: name, ForceDeleteWithoutRecovery: true }),
        );
      } catch (err) {
        if (err instanceof Error && err.name === 'ResourceNotFoundException') return;
        throw err;
      }
    },
  };
}
