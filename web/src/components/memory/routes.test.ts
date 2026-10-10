import { describe, expect, test } from 'vitest';
import { addBranch, addStep, emptyRoute, moveStep, newRouteId, newStepId, removeStep } from './RoutesPanel.tsx';

describe('route editing helpers', () => {
  test('ids match backend formats', () => {
    for (let i = 0; i < 50; i++) {
      expect(newRouteId()).toMatch(/^route-[a-z0-9]{6,24}$/);
      expect(newStepId()).toMatch(/^s-[a-z0-9]{4,24}$/);
    }
  });

  test('add / move / remove steps keeps branches consistent', () => {
    let r = emptyRoute(1, 'zh');
    r = addStep(addStep(addStep(r, 'p1'), 'p2'), 'p3');
    const [s1, s2, s3] = r.steps;
    r = addBranch(r, s2!.id, 'p9');
    expect(r.branches[0]).toMatchObject({ fromStepId: s2!.id, returnStepId: s2!.id, pageId: 'p9' });
    r = { ...r, branches: [{ ...r.branches[0]!, returnStepId: s3!.id }] };

    r = moveStep(r, s3!.id, -1);
    expect(r.steps.map((s) => s.pageId)).toEqual(['p1', 'p3', 'p2']);
    expect(moveStep(r, s1!.id, -1)).toBe(r); // 已在最前

    const noReturn = removeStep(r, s3!.id); // 支線回到的那一步被移除 → 改回所屬步驟
    expect(noReturn.branches[0]!.returnStepId).toBe(s2!.id);
    const noFrom = removeStep(r, s2!.id); // 支線所屬步驟被移除 → 支線一起移除
    expect(noFrom.branches).toEqual([]);
    expect(noFrom.steps).toHaveLength(2);
  });
});
