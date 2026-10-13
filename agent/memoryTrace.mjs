/**
 * 記憶命中追蹤(runner 每步呼叫;純函式,無 I/O)。
 *
 * 目的:每一步都看得出 AI 有沒有用到記憶,並用「記憶的預測有沒有應驗」間接證明記憶功能正常。
 *
 * 基準(baseline)= 本次測試開始前已存在的記憶(先前測試累積的導覽圖 + 測試人員畫的路徑)。
 * 本次測試途中新學到的畫面/路徑不算「命中記憶」,另外標為「本次稍早見過」。
 *
 * 每步記錄:
 *  - screen   這個畫面是記憶中已知的(known)、本次稍早才見過的(learned)、第一次看到的(new)。
 *  - arrival  上一步的操作,記憶裡有沒有「做了會到哪」的已驗證路徑;實際結果是否應驗(followed)、
 *             到了別的畫面(diverged)、還是畫面沒反應(no_effect)。← 記憶正確性的間接證據
 *  - plan     這一步 AI 選的操作,是否正好是記憶中這個畫面的已驗證路徑。← AI 有在用記憶
 *  - hints    這一步提醒了哪幾條測試人員教學、是否對得上 AI 實際看到的畫面。
 *  - route    目前畫面在測試人員畫的路線第幾步。
 */
import { edgeKind, normTarget } from './memoryGraph.mjs';
import { sameScreen } from './operatorMemory.mjs';

const NAV_MARK = '## 畫面導覽圖';

const reliable = (e) => Boolean(e.manual) || (e.hitCount ?? 0) > (e.missCount ?? 0);
const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function activeRoutes(routes) {
  return (Array.isArray(routes) ? routes : []).filter((r) => r && r.enabled !== false && Array.isArray(r.steps) && r.steps.length);
}

/** 畫面在路線上的位置(第幾步 / 支線)。 */
export function routePositions(routes, pageId) {
  if (!pageId) return [];
  const out = [];
  for (const r of activeRoutes(routes)) {
    r.steps.forEach((s, i) => { if (s.pageId === pageId) out.push({ name: r.name, step: i + 1, total: r.steps.length }); });
    for (const b of r.branches ?? []) if (b.pageId === pageId) out.push({ name: r.name, branch: true, total: r.steps.length });
  }
  return out.slice(0, 4);
}

/**
 * @param {object} p
 * @param {object} p.struct     runner 載入的導覽圖(快照,建立後不受本次更新影響)
 * @param {Array}  p.hints      啟用中的測試人員教學
 * @param {object} p.edits      edits.json(addedEdges = 測試人員手畫的路徑,routes = 路線)
 * @param {string} p.knowledge  engine 組好的背景知識(含導覽圖摘要)
 * @param {number} p.knowledgeLimit system prompt 實際收進去的知識字數上限
 */
export function createMemoryTrace({ struct, hints = [], edits = null, knowledge = '', knowledgeLimit = Infinity } = {}) {
  const pages = new Map();
  for (const p of Object.values(struct?.pages ?? {})) {
    pages.set(p.id, { name: p.name, visits: p.visitCount ?? 0, transient: Boolean(p.transient) });
  }
  const added = (Array.isArray(edits?.addedEdges) ? edits.addedEdges : []).map((e) => ({ ...e, hitCount: 0, missCount: 0, manual: true }));
  const edges = [...(struct?.edges ?? []), ...added]
    .filter((e) => e && pages.has(e.fromPageId) && pages.has(e.toPageId) && e.fromPageId !== e.toPageId)
    .map((e) => ({
      from: e.fromPageId,
      to: e.toPageId,
      kind: e.trigger?.kind ?? 'auto',
      target: normTarget(e.trigger?.target),
      hit: e.hitCount ?? 0,
      miss: e.missCount ?? 0,
      manual: Boolean(e.manual),
    }));
  const verified = edges.filter((e) => reliable({ manual: e.manual, hitCount: e.hit, missCount: e.miss }));
  const routes = activeRoutes(edits?.routes);
  const k = String(knowledge ?? '').trim();
  const navAt = k.indexOf(NAV_MARK);
  // 摘要要在 system prompt 實際收進去的範圍內才算「有給 AI」(背景知識太長時會被截掉)。
  const navInjected = navAt >= 0 && navAt < knowledgeLimit;
  const baseline = {
    pages: [...pages.values()].filter((p) => !p.transient).length,
    verifiedPaths: verified.length,
    hints: hints.length,
    routes: routes.length,
    navInjected,
    navTruncated: navAt >= knowledgeLimit,
  };

  const seenThisRun = new Set();
  const nameOf = (id) => pages.get(id)?.name ?? '';
  const matching = (from, action, target) => {
    const kind = edgeKind(action);
    const tgt = kind === 'auto' ? '' : normTarget(target);
    return verified.filter((e) => e.from === from && e.kind === kind && (kind === 'auto' || e.target === tgt));
  };

  const totals = {
    steps: 0, named: 0, known: 0, learned: 0, newScreens: 0,
    hintSteps: 0, hintMatched: 0, hintIds: new Set(),
    routeSteps: 0,
    interactive: 0, guided: 0,
    predicted: 0, followed: 0, diverged: 0, noEffect: 0,
  };

  return {
    baseline,

    /** 開始時的一行日誌:這次測試手上有哪些記憶、有沒有真的給 AI。 */
    startupLog() {
      const nav = baseline.pages
        ? `導覽圖 已知畫面 ${baseline.pages}、已驗證路徑 ${baseline.verifiedPaths}(${navInjected ? '已注入 AI' : baseline.navTruncated ? '未注入:背景知識過長被截掉' : '未注入'})`
        : '導覽圖 空白(第一次測試這個 App,本次會開始建立)';
      return `[memory] 本次可用記憶:${nav};測試人員教學 ${baseline.hints} 條;路線 ${baseline.routes} 條`;
    },

    /**
     * 每步呼叫一次(在 upsertPage 之後、recordTransition 之前)。
     * prevPageId/navAction/prevTarget = 上一步所在畫面與造成轉場的動作;injectedHints = 這一步提示詞裡的教學提醒。
     */
    onStep({ pageId, screenName, prevPageId, navAction, prevTarget, screenChanged, injectedHints = [], action, target, override } = {}) {
      totals.steps++;
      // 第一步附上「這次手上有哪些記憶」,任務頁不必另外讀檔就能顯示。
      const rec = totals.steps === 1 ? { baseline } : {};
      if (!pageId) {
        rec.screen = 'unnamed';
      } else {
        totals.named++;
        const base = pages.get(pageId);
        if (base && !base.transient) {
          rec.screen = 'known';
          totals.known++;
          rec.page = { name: base.name, priorVisits: base.visits };
          const exits = verified.filter((e) => e.from === pageId && e.kind !== 'auto').length;
          if (exits) rec.page.verifiedExits = exits;
        } else if (base) {
          rec.screen = 'known';
          totals.known++;
          rec.page = { name: base.name, priorVisits: base.visits, loading: true };
        } else if (seenThisRun.has(pageId)) {
          rec.screen = 'learned';
          totals.learned++;
        } else {
          rec.screen = 'new';
          totals.newScreens++;
        }
        seenThisRun.add(pageId);
      }

      // 上一步的操作 → 記憶預測會到哪;實際到了哪。
      if (prevPageId && navAction) {
        const predicted = matching(prevPageId, navAction, prevTarget);
        if (predicted.length) {
          const best = [...predicted].sort((a, b) => Number(b.manual) - Number(a.manual) || b.hit - a.hit)[0];
          const result = pageId && predicted.some((e) => e.to === pageId)
            ? 'followed'
            : (!pageId || pageId === prevPageId) && screenChanged === false ? 'no_effect' : 'diverged';
          totals.predicted++;
          if (result === 'followed') totals.followed++;
          else if (result === 'no_effect') totals.noEffect++;
          else totals.diverged++;
          rec.arrival = {
            from: nameOf(prevPageId),
            kind: best.kind,
            ...(best.target ? { target: best.target } : {}),
            expected: [...new Set(predicted.map((e) => nameOf(e.to)))].slice(0, 3),
            result,
            hit: best.hit,
            miss: best.miss,
            ...(best.manual ? { manual: true } : {}),
          };
        }
      }

      // 這一步 AI 選的操作,是不是這個畫面在記憶中的已驗證路徑。
      const kind = edgeKind(action);
      if (pageId && kind !== 'auto') {
        totals.interactive++;
        if (!override) {
          const plan = matching(pageId, action, target);
          if (plan.length) {
            totals.guided++;
            const best = [...plan].sort((a, b) => Number(b.manual) - Number(a.manual) || b.hit - a.hit)[0];
            rec.plan = {
              kind: best.kind,
              ...(best.target ? { target: best.target } : {}),
              to: nameOf(best.to),
              hit: best.hit,
              miss: best.miss,
              ...(best.manual ? { manual: true } : {}),
            };
          }
        }
      }

      // 測試人員教學提醒(這一步提示詞實際帶了哪些)。
      if (injectedHints.length) {
        totals.hintSteps++;
        const list = injectedHints.slice(0, 3).map((h) => {
          const matched = Boolean((h.pageId && h.pageId === pageId) || (h.screen && sameScreen(h.screen, screenName)));
          if (matched) totals.hintMatched++;
          if (h.id) totals.hintIds.add(h.id);
          return { ...(h.id ? { id: h.id } : {}), text: clip(h.text, 80), matched };
        });
        rec.hints = list;
      }

      // 路線位置(這一步提示詞的路線提醒以上一個畫面為準)。
      const route = routePositions(routes, prevPageId);
      if (route.length) {
        totals.routeSteps++;
        rec.route = route;
      }
      return rec;
    },

    /** 一步的 CloudWatch 日誌。 */
    formatLog(index, rec) {
      const parts = [];
      if (rec.screen === 'known') parts.push(`已知畫面「${rec.page?.name ?? ''}」(先前到訪 ${rec.page?.priorVisits ?? 0} 次)`);
      else if (rec.screen === 'learned') parts.push('本次稍早見過的畫面');
      else if (rec.screen === 'new') parts.push('新畫面(記憶中沒有)');
      else parts.push('畫面未命名');
      if (rec.arrival) {
        const how = rec.arrival.kind === 'auto' ? '自動切換' : `${rec.arrival.kind} ${rec.arrival.target ?? ''}`.trim();
        const verdict = rec.arrival.result === 'followed' ? '應驗 ✓' : rec.arrival.result === 'no_effect' ? '沒有反應 ✕' : '與記憶不符 ⚠';
        parts.push(`記憶預測「${rec.arrival.from}」${how} → 「${rec.arrival.expected.join('/')}」:${verdict}`);
      }
      if (rec.plan) parts.push(`照已驗證路徑操作:${rec.plan.kind} ${rec.plan.target ?? ''} → 「${rec.plan.to}」(${rec.plan.manual ? '人工標註' : `${rec.plan.hit}/${rec.plan.miss}`})`.replace(/\s+→/, ' →'));
      if (rec.hints?.length) parts.push(`教學提醒 ${rec.hints.length} 條(對上畫面 ${rec.hints.filter((h) => h.matched).length})`);
      if (rec.route?.length) parts.push(`路線 ${rec.route.map((r) => (r.branch ? `${r.name} 支線` : `${r.name} ${r.step}/${r.total}`)).join('、')}`);
      return `[memory] #${index} ${parts.join(' · ')}`;
    },

    /** 整場統計(寫進 report.json,供報告與任務頁顯示)。 */
    summary() {
      return {
        baseline,
        steps: totals.steps,
        namedSteps: totals.named,
        knownScreenSteps: totals.known,
        learnedScreenSteps: totals.learned,
        newScreens: totals.newScreens,
        hintReminderSteps: totals.hintSteps,
        hintsMatchedScreen: totals.hintMatched,
        distinctHintsUsed: totals.hintIds.size,
        routeReminderSteps: totals.routeSteps,
        interactiveActions: totals.interactive,
        memoryGuidedActions: totals.guided,
        predictions: { total: totals.predicted, followed: totals.followed, diverged: totals.diverged, noEffect: totals.noEffect },
      };
    },

    /** 結束時的一行日誌(間接證明記憶有在運作)。 */
    summaryLog() {
      const s = this.summary();
      const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
      return `[memory] 本次總結:已知畫面 ${s.knownScreenSteps}/${s.namedSteps} 步(${pct(s.knownScreenSteps, s.namedSteps)});` +
        `記憶預測 ${s.predictions.total} 次,應驗 ${s.predictions.followed}(${pct(s.predictions.followed, s.predictions.total)})、` +
        `不符 ${s.predictions.diverged}、沒反應 ${s.predictions.noEffect};` +
        `照已驗證路徑操作 ${s.memoryGuidedActions}/${s.interactiveActions};教學提醒 ${s.hintReminderSteps} 步;新畫面 ${s.newScreens}`;
    },
  };
}
