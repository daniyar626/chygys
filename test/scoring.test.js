import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeScores, normalizeValue, roundTo } from '../server/scoring.js';

const checklist = {
  rounding: { decimals: 1 },
  critical_policy: 'flag',
  sections: [
    { id: 's1', title: 'A' },
    { id: 's2', title: 'B' },
  ],
  criteria: [
    { id: 'c1', section: 's1', type: 'binary', weight: 10, na_allowed: false },
    { id: 'c2', section: 's1', type: 'scale', scale: { min: 0, max: 2 }, weight: 20, na_allowed: true },
    { id: 'c3', section: 's2', type: 'scale', scale: { min: 1, max: 5 }, weight: 30, na_allowed: true },
    { id: 'c4', section: 's2', type: 'binary', weight: 40, na_allowed: false, critical: true },
  ],
};

test('normalizeValue maps binary and scale to 0..1', () => {
  assert.equal(normalizeValue({ type: 'binary' }, 1), 1);
  assert.equal(normalizeValue({ type: 'binary' }, 0), 0);
  assert.equal(normalizeValue({ type: 'scale', scale: { min: 0, max: 2 } }, 1), 0.5);
  assert.equal(normalizeValue({ type: 'scale', scale: { min: 1, max: 5 } }, 5), 1);
  assert.equal(normalizeValue({ type: 'scale', scale: { min: 1, max: 5 } }, 1), 0);
});

test('normalizeValue clamps out-of-range scale values', () => {
  assert.equal(normalizeValue({ type: 'scale', scale: { min: 0, max: 2 } }, 7), 1);
  assert.equal(normalizeValue({ type: 'scale', scale: { min: 0, max: 2 } }, -3), 0);
});

test('roundTo rounds half away from zero', () => {
  assert.equal(roundTo(84.25, 1), 84.3);
  assert.equal(roundTo(84.24, 1), 84.2);
  assert.equal(roundTo(50, 0), 50);
});

test('all criteria max → 100', () => {
  const r = computeScores(checklist, [
    { criterion_id: 'c1', value: 1 },
    { criterion_id: 'c2', value: 2 },
    { criterion_id: 'c3', value: 5 },
    { criterion_id: 'c4', value: 1 },
  ]);
  assert.equal(r.total, 100);
  assert.equal(r.critical_error, false);
});

test('weighted total with scale values', () => {
  const r = computeScores(checklist, [
    { criterion_id: 'c1', value: 1 },
    { criterion_id: 'c2', value: 1 },
    { criterion_id: 'c3', value: 3 },
    { criterion_id: 'c4', value: 1 },
  ]);
  assert.equal(r.total, 75);
  const c3 = r.criteria.find((c) => c.criterion_id === 'c3');
  assert.equal(c3.points, 15);
  assert.equal(c3.max_points, 30);
});

test('N/A weight is redistributed across applicable criteria', () => {
  const r = computeScores(checklist, [
    { criterion_id: 'c1', value: 1 },
    { criterion_id: 'c2', na: true, value: null },
    { criterion_id: 'c3', value: 3 },
    { criterion_id: 'c4', value: 1 },
  ]);
  assert.equal(r.total, 81.3);
  const c1 = r.criteria.find((c) => c.criterion_id === 'c1');
  assert.equal(roundTo(c1.effective_weight, 2), 12.5);
  const c2 = r.criteria.find((c) => c.criterion_id === 'c2');
  assert.equal(c2.effective_weight, 0);
  assert.equal(c2.points, null);
});

test('section scores computed separately with their own N/A redistribution', () => {
  const r = computeScores(checklist, [
    { criterion_id: 'c1', value: 0 },
    { criterion_id: 'c2', na: true, value: null },
    { criterion_id: 'c3', value: 5 },
    { criterion_id: 'c4', value: 0 },
  ]);
  const s1 = r.sections.find((s) => s.id === 's1');
  const s2 = r.sections.find((s) => s.id === 's2');
  assert.equal(s1.score, 0);
  assert.equal(s2.score, 42.9);
});

test('N/A on a criterion that does not allow it is treated as 0 and flagged', () => {
  const r = computeScores(checklist, [
    { criterion_id: 'c1', na: true, value: null },
    { criterion_id: 'c2', value: 2 },
    { criterion_id: 'c3', value: 5 },
    { criterion_id: 'c4', value: 1 },
  ]);
  const c1 = r.criteria.find((c) => c.criterion_id === 'c1');
  assert.equal(c1.na, false);
  assert.ok(c1.warnings.some((w) => w.includes('N/A')));
  assert.equal(r.total, 90);
});

test('missing criterion result is flagged and scored as 0', () => {
  const r = computeScores(checklist, [
    { criterion_id: 'c1', value: 1 },
    { criterion_id: 'c3', value: 5 },
    { criterion_id: 'c4', value: 1 },
  ]);
  const c2 = r.criteria.find((c) => c.criterion_id === 'c2');
  assert.equal(c2.missing, true);
  assert.equal(r.total, 80);
  assert.ok(r.warnings.length > 0);
});

test('critical error is flagged separately and does not change total under "flag" policy', () => {
  const r = computeScores(checklist, [
    { criterion_id: 'c1', value: 1 },
    { criterion_id: 'c2', value: 2 },
    { criterion_id: 'c3', value: 5 },
    { criterion_id: 'c4', value: 1, critical_error: true, critical_reason: 'x' },
  ]);
  assert.equal(r.critical_error, true);
  assert.equal(r.total, 100);
  assert.equal(r.final_total, 100);
});

test('critical error zeroes final_total under "zero_total" policy', () => {
  const r = computeScores({ ...checklist, critical_policy: 'zero_total' }, [
    { criterion_id: 'c1', value: 1 },
    { criterion_id: 'c2', value: 2 },
    { criterion_id: 'c3', value: 5 },
    { criterion_id: 'c4', value: 0, critical_error: true },
  ]);
  assert.equal(r.critical_error, true);
  assert.equal(r.total, 60);
  assert.equal(r.final_total, 0);
});

test('all criteria N/A → total null', () => {
  const cl = { ...checklist, criteria: checklist.criteria.map((c) => ({ ...c, na_allowed: true })) };
  const r = computeScores(cl, cl.criteria.map((c) => ({ criterion_id: c.id, na: true, value: null })));
  assert.equal(r.total, null);
});

test('overrides (appeal decisions) replace model results', () => {
  const base = [
    { criterion_id: 'c1', value: 0 },
    { criterion_id: 'c2', value: 2 },
    { criterion_id: 'c3', value: 5 },
    { criterion_id: 'c4', value: 1 },
  ];
  const r = computeScores(checklist, base, { c1: { value: 1, na: false } });
  assert.equal(r.total, 100);
  const c1 = r.criteria.find((c) => c.criterion_id === 'c1');
  assert.equal(c1.overridden, true);
  assert.equal(c1.original_value, 0);
});

test('critical error is ignored on a criterion judged N/A (e.g. after an appeal)', () => {
  const cl = { ...checklist, critical_policy: 'zero_total', criteria: checklist.criteria.map((c) => (c.id === 'c4' ? { ...c, na_allowed: true } : c)) };
  const res = [
    { criterion_id: 'c1', value: 1 },
    { criterion_id: 'c2', value: 2 },
    { criterion_id: 'c3', value: 5 },
    { criterion_id: 'c4', value: 0, critical_error: true },
  ];
  assert.equal(computeScores(cl, res).final_total, 0);
  const after = computeScores(cl, res, { c4: { na: true, value: null, reason: 'r', appeal_id: 'ap1' } });
  assert.equal(after.critical_error, false);
  assert.equal(after.final_total, 100);
  assert.equal(after.criteria.find((c) => c.criterion_id === 'c4').override_reason, 'r');
});
