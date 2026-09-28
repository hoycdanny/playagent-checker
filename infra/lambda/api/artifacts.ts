import { PutObjectCommand, GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { tenantPrefix } from './tenantCredentials.js';

/** 發一個限時的 presigned GET URL(供前端顯示截圖等產物,位元組不經 Lambda)。 */
export async function createDownloadUrl(
  s3: S3Client,
  bucket: string,
  key: string,
  ttlSeconds = 900,
): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: ttlSeconds,
  });
}

export type ArtifactKind = 'apk' | 'ipa' | 'zip' | 'png';

const FILENAME_BY_KIND: Record<ArtifactKind, string> = {
  apk: 'app.apk',
  ipa: 'app.ipa',
  zip: 'game.zip',
  // 應用圖示/代表截圖(前端列表小截圖)。與被測產物同機制:租戶前綴 + presigned。
  png: 'icon.png',
};

export const ARTIFACT_KINDS: readonly ArtifactKind[] = ['apk', 'ipa', 'zip', 'png'];

/** presigned PUT URL 有效期(秒)。 */
const UPLOAD_URL_TTL_SECONDS = 900;

/** 產物在租戶前綴下的 S3 key。 */
export function artifactKey(
  tenantId: string,
  artifactId: string,
  kind: ArtifactKind,
): string {
  return `${tenantPrefix(tenantId)}artifacts/${artifactId}/${FILENAME_BY_KIND[kind]}`;
}

/**
 * 發一個租戶前綴限定、限時的 presigned PUT URL(Req 2.1)。
 * 瀏覽器用此 URL 直傳 S3,位元組永不經過 Lambda(Req 2.4)。
 */
export async function createUploadUrl(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  artifactId: string,
  kind: ArtifactKind,
): Promise<{ url: string; key: string }> {
  const key = artifactKey(tenantId, artifactId, kind);
  // 不把 ContentType 綁進簽章:瀏覽器對 .xapk 等副檔名給的 file.type 常為空或不一致,
  // 若簽章綁死 type 會導致 S3 校驗 403。租戶前綴隔離已是安全邊界,不需靠 Content-Type 限制。
  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
    { expiresIn: UPLOAD_URL_TTL_SECONDS },
  );
  return { url, key };
}
