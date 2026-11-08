import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { computeScores, snapToStep, scaleValues } from '../server/scoring.js';
import { validateChecklist } from '../server/checklists.js';

const cl = validateChecklist(JSON.parse(fs.readFileSync(new URL('../checklists/default.json', import.meta.url), 'utf8')));
const res = (o) => cl.criteria.map((c) => ({ criterion_id: c.id, na: false, value: c.type === 'flag' ? 0 : c.type === 'binary' ? 1 : scaleValues(c).at(-1), ...(o[c.id] || {}) }));

test('official checklist: 8 criteria, weights 10/15/20/20/15/15/5 + flag without points', () => {
  assert.equal(cl.criteria.length, 8);
  assert.deepEqual(cl.criteria.map((c) => c.weight), [10, 15, 20, 20, 15, 15, 5, 0]);
  assert.equal(cl.criteria.at(-1).type, 'flag');
  assert.equal(cl.rounding.decimals, 2);
});

test('scale steps: consultation 0/5/10/15/20, dialog management 0/4/7/10', () => {
  const cons = cl.criteria.find((c) => c.id === 'consultation');
  const dlg = cl.criteria.find((c) => c.id === 'dialog');
  assert.deepEqual(scaleValues(cons), [0, 5, 10, 15, 20]);
  assert.deepEqual(scaleValues(dlg), [0, 4, 7, 10]);
  assert.equal(snapToStep(cons, 12), 10);
  assert.equal(snapToStep(dlg, 8), 7);
  assert.equal(snapToStep(dlg, 9), 10);
});

test('everything perfect → 100.00, no gross error', () => {
  const r = computeScores(cl, res({}));
  assert.equal(r.total, 100);
  assert.equal(r.critical_error, false);
});

test('top step gives full weight; scale values recalculated proportionally', () => {
  const r = computeScores(cl, res({ consultation: { value: 15 }, dialog: { value: 7 } }));
  assert.equal(r.criteria.find((c) => c.criterion_id === 'consultation').points, 15);
  assert.equal(r.criteria.find((c) => c.criterion_id === 'dialog').points, 10.5);
  assert.equal(r.total, 90.5);
});

test('N/A redistributes weight, total rounded to two decimals', () => {
  const r = computeScores(cl, res({ identification: { na: true, value: null }, needs: { value: 0 } }));
  assert.equal(r.total, 81.25);
  const r2 = computeScores(cl, res({ identification: { na: true, value: null }, needs: { value: 0 }, contact: { value: 0 }, closing: { na: true, value: null } }));
  assert.equal(r2.total, 66.67);
});

test('gross error flag: no points, marked separately, does not change the total', () => {
  const r = computeScores(cl, res({ gross_errors: { value: 1 } }));
  assert.equal(r.total, 100);
  assert.equal(r.critical_error, true);
  assert.deepEqual(r.critical_criteria, ['gross_errors']);
  const g = r.criteria.find((c) => c.criterion_id === 'gross_errors');
  assert.equal(g.points, null);
});

test('reviewer can clear a gross error by changing the flag to Нет', () => {
  const r = computeScores(cl, res({ gross_errors: { value: 1 } }), { gross_errors: { value: 0, na: false, reason: 'r' } });
  assert.equal(r.critical_error, false);
});

test('no applicable weighted criteria → total is not calculated', () => {
  const r = computeScores(cl, cl.criteria.map((c) => ({ criterion_id: c.id, na: c.na_allowed, value: c.na_allowed ? null : 0 })));
  assert.notEqual(r.total, null);
  const onlyNa = { ...cl, criteria: cl.criteria.filter((c) => c.na_allowed || c.type === 'flag') };
  const r2 = computeScores(onlyNa, onlyNa.criteria.map((c) => ({ criterion_id: c.id, na: c.type !== 'flag', value: c.type === 'flag' ? 0 : null })));
  assert.equal(r2.total, null);
});
