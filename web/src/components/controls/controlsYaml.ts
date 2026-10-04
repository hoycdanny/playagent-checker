/**
 * 案例 YAML 的頂層 `controls:` 欄位讀寫(與後端 controlSchemes.parseCaseControls 對齊)。
 * 寫入一律用單行 `controls: [a, b]`;空清單 = 明確「不限定」(runner 走舊行為)。
 */

export function readControls(yaml: string): string[] | undefined {
  const lines = yaml.split(/\r?\n/);
  const idx = lines.findIndex((l) => /^controls:/.test(l));
  if (idx < 0) return undefined;
  const inline = lines[idx]!.replace(/^controls:/, '').replace(/#.*$/, '').trim();
  if (inline) {
    return inline
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const items: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const m = /^\s+-\s*([A-Za-z_]+)/.exec(lines[i]!);
    if (m) items.push(m[1]!);
    else if (lines[i]!.trim() !== '') break;
  }
  return items;
}

/** 以 ids 改寫(或新增)`controls:`;yaml 為空時不動(等草擬/手寫後再套)。 */
export function writeControls(yaml: string, ids: string[]): string {
  if (!yaml.trim()) return yaml;
  const line = `controls: [${ids.join(', ')}]`;
  const lines = yaml.split(/\r?\n/);
  const idx = lines.findIndex((l) => /^controls:/.test(l));
  if (idx >= 0) {
    // 移除舊的區塊清單項目(- xxx)。
    let end = idx + 1;
    if (!lines[idx]!.replace(/^controls:/, '').replace(/#.*$/, '').trim()) {
      while (end < lines.length && /^\s+-\s*/.test(lines[end]!)) end++;
    }
    lines.splice(idx, end - idx, line);
    return lines.join('\n');
  }
  // 放在 name: 之後(沒有 name 就放最前面),方便閱讀。
  const nameIdx = lines.findIndex((l) => /^name:/.test(l));
  lines.splice(nameIdx >= 0 ? nameIdx + 1 : 0, 0, line);
  return lines.join('\n');
}

/** 移除 `controls:`(回到「未指定 = 依類型建議」)。 */
export function removeControls(yaml: string): string {
  const lines = yaml.split(/\r?\n/);
  const idx = lines.findIndex((l) => /^controls:/.test(l));
  if (idx < 0) return yaml;
  let end = idx + 1;
  if (!lines[idx]!.replace(/^controls:/, '').replace(/#.*$/, '').trim()) {
    while (end < lines.length && /^\s+-\s*/.test(lines[end]!)) end++;
  }
  lines.splice(idx, end - idx);
  return lines.join('\n');
}

/** ids undefined → 移除欄位;否則寫入。 */
export function applyControls(yaml: string, ids: string[] | undefined): string {
  return ids === undefined ? removeControls(yaml) : writeControls(yaml, ids);
}
