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

/**
 * 案例宣告的弱網條件 → 可安全注入容器環境變數的字串。
 *
 * 這是一個信任邊界:案例 YAML 是租戶自己寫的內容,而這個值會成為 runner 容器的
 * 環境變數。所以這裡只做「形狀把關」,不做語意解析 ——
 *
 *   - 語意解析只有一個地方(runner 的 parseNetworkCondition),重複實作遲早會分歧,
 *     而分歧的後果是報告主張一個沒施加的條件。
 *   - 把關的理由不是怕解析錯,是怕超長或含控制字元的值被塞進容器環境。
 *
 * 看不懂形狀就回 null 並讓呼叫端記一筆,不猜、也不悄悄截斷。
 */
const NETWORK_SPEC_MAX = 120;
export function sanitizeNetworkSpec(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim().replace(/^["']|["']$/g, '').trim();
  if (!text) return null;
  if (text.length > NETWORK_SPEC_MAX) return null;
  // 弱網條件的合法字元:鍵=值、逗號分隔、單位符號。其餘(含空白與控制字元)一律不放行。
  if (!/^[A-Za-z0-9=,.%_-]+$/.test(text)) return null;
  return text;
}

export async function readCaseTarget(
  s3: S3Client,
  bucket: string,
  tenantId: string,
  jobId: string,
): Promise<{ url: string; task: string; network: string | null }> {
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
    /** 弱網條件(job 層覆寫;通常由案例 YAML 的 network: 帶入)。 */
    network?: string;
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
  // 弱網條件:job.json 覆寫 > 案例 YAML 的 network:。兩者都沒有 = 不施加任何條件。
  const netMatch = /^network:\s*(\S+)/im.exec(yaml);
  const network = sanitizeNetworkSpec(job.network) ?? sanitizeNetworkSpec(netMatch?.[1]);
  return {
    url: caseUrl || appUrl || 'https://example.com',
    task,
    network,
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
