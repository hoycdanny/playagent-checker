import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';

/** 草擬用模型(便宜、快、不需 tool-calling)。 */
const DRAFT_MODEL_ID = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

const SYSTEM_PROMPT = `你是一個把「自然語言測試描述」轉成「測試案例 YAML」的助手。
規則:
- 只輸出 YAML,不要有任何額外說明或 markdown 圍欄。
- YAML 需含欄位: name(案例名), app(被測應用 id), task(要 AI 代理執行的自然語言任務描述), assertions(判斷成功的條件清單)。
- 絕不可寫入任何字面量密碼或密鑰;若流程需要登入,以 \${ENV_VAR} 佔位表示帳密。
- 保持精簡、可執行。`;

/** 有提供範本基礎 YAML 時的系統提示:以編修既有範本為主,而非從零產生。 */
const REFINE_SYSTEM_PROMPT = `你是一個「測試案例 YAML 編修」助手。使用者會給你一份「既有範本 YAML」(通常由記憶地圖的可達路徑自動生成)與一句「自然語言調整指令」。
規則:
- 以既有範本為基礎,依調整指令修改,產出更新後的完整 YAML。
- 只輸出 YAML,不要有任何額外說明或 markdown 圍欄。
- 保留範本原有的合理結構;沒被指令要求更動的部分盡量保留。
- YAML 需含欄位: name, app, task;可含 assertions(成功判斷條件清單)。
- 絕不可寫入任何字面量密碼或密鑰;需登入時以 \${ENV_VAR} 佔位。
- 保持精簡、可執行。`;

export interface DraftDeps {
  bedrock: Pick<BedrockRuntimeClient, 'send'>;
}

/**
 * 呼叫 Bedrock 產出/編修案例 YAML 草稿。
 * - 未提供 baseYaml:從自然語言描述「產生」案例(原行為)。
 * - 提供 baseYaml:以既有範本為基礎,依自然語言指令「編修」(步驟 5:範本感知 AI 編修)。
 */
export async function draftCaseYaml(
  deps: DraftDeps,
  description: string,
  appId: string,
  baseYaml?: string,
): Promise<string> {
  const refining = typeof baseYaml === 'string' && baseYaml.trim() !== '';
  const userContent = refining
    ? `被測應用 id: ${appId}\n既有範本 YAML:\n${baseYaml!.trim()}\n\n自然語言調整指令:\n${description || '(未給明確指令,請潤飾為更清楚可執行的測試案例)'}`
    : `被測應用 id: ${appId}\n自然語言測試描述:\n${description}`;
  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 1500,
    system: refining ? REFINE_SYSTEM_PROMPT : SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: userContent,
      },
    ],
  };
  const res = await deps.bedrock.send(
    new InvokeModelCommand({
      modelId: DRAFT_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(body),
    }),
  );
  const text = new TextDecoder().decode(res.body as Uint8Array);
  const parsed = JSON.parse(text) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const yaml =
    parsed.content?.find((c) => c.type === 'text')?.text?.trim() ?? '';
  // 去除模型偶爾加上的 ``` 圍欄
  return yaml.replace(/^```(?:ya?ml)?\n?/, '').replace(/\n?```$/, '').trim();
}

export function makeBedrockClient(region: string): BedrockRuntimeClient {
  return new BedrockRuntimeClient({ region });
}
