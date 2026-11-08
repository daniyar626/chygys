import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitize, structuralProblems } from '../server/evaluator.js';

const checklist = {
  criteria: [
    { id: 'a', type: 'binary', critical: false },
    { id: 'b', type: 'scale', scale: { min: 0, max: 2 }, critical: true },
  ],
};
const conv = { transcript: Array.from({ length: 5 }, (_, i) => ({ idx: i })) };
const r = (o) => ({
  criterion_id: 'a', na: false, value: 1, explanation: 'ok', evidence_ids: [1],
  checked_from: null, checked_to: null, na_reason: null, critical_error: false, critical_reason: null, ...o,
});

test('structuralProblems detects missing, unknown, duplicate and empty values', () => {
  assert.deepEqual(structuralProblems({ criteria: [r({}), r({ criterion_id: 'b' })] }, checklist), []);
  assert.match(structuralProblems({ criteria: [r({})] }, checklist)[0], /нет результата по: b/);
  assert.ok(structuralProblems({ criteria: [r({}), r({ criterion_id: 'b' }), r({ criterion_id: 'zzz' })] }, checklist).some((p) => p.includes('zzz')));
  assert.ok(structuralProblems({ criteria: [r({}), r({}), r({ criterion_id: 'b' })] }, checklist).some((p) => p.includes('повторы')));
  assert.ok(structuralProblems({ criteria: [r({ value: null }), r({ criterion_id: 'b' })] }, checklist).some((p) => p.includes('нет значения')));
});

test('sanitize clamps values and records a warning', () => {
  const [, b] = sanitize({ criteria: [r({}), r({ criterion_id: 'b', value: 5 })] }, checklist, conv);
  assert.equal(b.value, 2);
  assert.equal(b.raw_value, 5);
  assert.ok(b.warnings.some((w) => w.includes('приведено')));
});

test('sanitize drops out-of-range evidence with a warning and fixes inverted ranges', () => {
  const [a] = sanitize({ criteria: [r({ value: 0, evidence_ids: [99], checked_from: 4, checked_to: 1 })] }, checklist, conv);
  assert.deepEqual(a.evidence_ids, []);
  assert.equal(a.checked_from, 1);
  assert.equal(a.checked_to, 4);
  assert.ok(a.warnings.some((w) => w.includes('вне диапазона')));
});

test('sanitize warns on a pass without evidence', () => {
  const [a] = sanitize({ criteria: [r({ evidence_ids: [] })] }, checklist, conv);
  assert.ok(a.warnings.some((w) => w.includes('без реплики')));
});

test('sanitize drops critical flag on non-critical criterion but keeps a warning', () => {
  const [a] = sanitize({ criteria: [r({ critical_error: true, critical_reason: 'x' })] }, checklist, conv);
  assert.equal(a.critical_error, false);
  assert.ok(a.warnings.some((w) => w.includes('грубую ошибку')));
});

test('sanitize ignores value when N/A', () => {
  const [a] = sanitize({ criteria: [r({ na: true, value: 1, evidence_ids: [], checked_from: 0, checked_to: 4 })] }, checklist, conv);
  assert.equal(a.value, null);
});
