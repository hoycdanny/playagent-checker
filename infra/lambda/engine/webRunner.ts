import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';

/**
 * Web 任務的「起始網址 + 目標」解析。
 *
 * 真實瀏覽器測試已移到 ECS Fargate 的 webExplorationRunner(headless Chromium),
 * engine 只負責解析網址後起 task(見 webHost.ts / engine index.ts 的 web 分支)。
 * 這裡保留唯一仍被 engine 使用的邏輯:決定要開哪個網址、測什麼。
 *
 * 網址優先序:case YAML 的 `url:` > App 測試網址(job.package/identifier)> 佔位。
 * 沒有 scheme 就補 https://(使用者常只填 example.com)。
 */
function jobPrefix(tenantId: string, jobId: string): string {
  return `tenants/${tenantId}/jobs/${jobId}/`;
}

export async function readCaseTarget(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  jobId: string,
): Promise<{ url: string; task: string }> {
  const jobObj = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: `${jobPrefix(tenantId, jobId)}job.json` }),
  );
  const job = JSON.parse((await jobObj.Body!.transformToString()) as string) as {
    appId: string;
    caseId: string;
    package?: string;
    identifier?: string;
  };
  let yaml = '';
  try {
    const caseObj = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: `tenants/${tenantId}/cases/${job.appId}/${job.caseId}.yaml`,
      }),
    );
    yaml = (await caseObj.Body?.transformToString()) ?? '';
  } catch {
    /* 無案例 YAML(如純探索)時,靠 app 網址 fallback */
  }
  const urlMatch = /url:\s*(\S+)/i.exec(yaml);
  const taskMatch = /task:\s*(.+)/i.exec(yaml);
  const appUrlRaw = (job.package ?? job.identifier ?? '').trim();
  const appUrl = appUrlRaw && !/^https?:\/\//i.test(appUrlRaw) ? `https://${appUrlRaw}` : appUrlRaw;
  const caseUrl = urlMatch ? urlMatch[1]!.replace(/^["']|["']$/g, '') : '';
  return {
    url: caseUrl || appUrl || 'https://example.com',
    task: taskMatch ? taskMatch[1]!.trim() : '',
  };
}
