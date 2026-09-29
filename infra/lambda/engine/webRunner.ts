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
    /** API 提交時已正確解析好的案例 task(含多行 task: | 內容,如登入帳密/步驟)。 */
    caseTask?: string;
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
  const appUrlRaw = (job.package ?? job.identifier ?? '').trim();
  const appUrl = appUrlRaw && !/^https?:\/\//i.test(appUrlRaw) ? `https://${appUrlRaw}` : appUrlRaw;
  const caseUrl = urlMatch ? urlMatch[1]!.replace(/^["']|["']$/g, '') : '';
  // task 優先用 job.caseTask(API 已正確處理多行 task: |);缺時才從 YAML 取(同樣支援多行)。
  const task =
    typeof job.caseTask === 'string' && job.caseTask.trim()
      ? job.caseTask
      : extractYamlTask(yaml);
  return {
    url: caseUrl || appUrl || 'https://example.com',
    task,
  };
}

/**
 * 從案例 YAML 取 task,支援行內與 YAML 區塊純量(task: | 多行)。
 * 舊版用 /task:\s*(.+)/ 只抓第一行,對 `task: |` 只得 "|",導致多行任務(含帳密)遺失。
 */
function extractYamlTask(yaml: string): string {
  const lines = yaml.split(/\r?\n/);
  const headIdx = lines.findIndex((l) => /^task:\s*/.test(l));
  if (headIdx < 0) return '';
  const trimmed = lines[headIdx]!.replace(/^task:\s*/, '').trim();
  if (trimmed && !/^[|>][+-]?\d*$/.test(trimmed)) return trimmed;
  const body: string[] = [];
  for (let i = headIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') { body.push(''); continue; }
    if (line.length - line.trimStart().length === 0) break; // 回到頂層 key
    body.push(line);
  }
  while (body.length && body[body.length - 1] === '') body.pop();
  if (body.length === 0) return '';
  const first = body.find((l) => l.trim() !== '') ?? '';
  const base = first.length - first.trimStart().length;
  return body.map((l) => (l.length >= base ? l.slice(base) : l.trimStart())).join('\n').trim();
}
