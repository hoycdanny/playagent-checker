/**
 * Bedrock Converse 的請求形狀修正(各 runner 共用,刻意零相依以便單獨使用)。
 *
 * 問題:有些模型不吃 Converse 的獨立 `system` 欄位。服務端會把 system 併成一個 user 回合,
 * 於是對話變成 user → user,模型的 chat template 直接拒收:
 *   "Conversation roles must alternate user/assistant/user/assistant/..."
 *
 * 2026-10-12 於 us-east-2 對 writer.palmyra-vision-7b 實測:
 *   system 欄位 + 1 個 user                     → ValidationException(上面那句)
 *   system 欄位 + user/assistant/user 交替      → 同樣失敗(所以不是「只有單輪才壞」)
 *   不帶 system,指示併進 user                   → OK
 *   不帶 system,user/assistant/user 交替         → OK
 * 任務 job-mv4r3slb-ltxfpa 就是這樣在第 0 步死掉的(真機已開機、427 MB 安裝檔已裝完)。
 *
 * 作法:被拒一次就記住這個模型,之後把 system 併進「第一個 user 回合的文字區塊」最前面。
 * content 的排列順序不變(圖片仍在文字之前),模型看到的內容一樣,只是少一個 user 回合。
 */

/** 這個錯誤是不是「模型不接受獨立 system 回合」造成的。 */
export function isRoleAlternationError(err) {
  return /roles must alternate/i.test(String((err && err.message) || err || ''));
}

/**
 * 把 system 文字併進第一個 user 回合(內部 Anthropic 形態的 messages)。
 * 不修改傳入的 messages(回傳淺拷貝),呼叫端的對話歷史不受影響。
 */
export function foldSystemIntoFirstUser(system, messages) {
  const out = (messages || []).map((m) => ({ ...m, content: [...(m.content || [])] }));
  const first = out.find((m) => m.role === 'user');
  if (!first) return out;
  const i = first.content.findIndex((c) => c.type === 'text');
  if (i >= 0) {
    first.content[i] = { ...first.content[i], text: `${system}\n\n${first.content[i].text ?? ''}` };
  } else {
    first.content.push({ type: 'text', text: system });
  }
  return out;
}
