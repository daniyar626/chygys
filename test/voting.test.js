import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeVotes, timingFacts } from '../server/evaluator.js';

const cl = {
  criteria: [
    { id: 'contact', title: 'Установление контакта', type: 'binary' },
    { id: 'identification', title: 'Идентификация', type: 'binary' },
    { id: 'consultation', title: 'Консультация', type: 'scale', scale: { min: 0, max: 20, steps: [{ value: 20 }, { value: 15 }, { value: 10 }, { value: 5 }, { value: 0 }] } },
    { id: 'gross_errors', title: 'Грубые ошибки', type: 'flag' },
  ],
};
const row = (id, value, extra = {}) => ({ criterion_id: id, value, na: value === null, explanation: `${id}=${value}`, evidence_ids: [1], warnings: [], ...extra });
const run = (contact, ident, cons, gross = 0) => ({ criteria: [row('contact', contact), row('identification', ident), row('consultation', cons), row('gross_errors', gross)], summary: 's' });
const get = (rows, id) => rows.find((r) => r.criterion_id === id);

test('majority wins per criterion and full agreement has no warning', () => {
  const m = mergeVotes([run(1, null, 15), run(1, null, 15), run(0, null, 15)], cl);
  assert.equal(get(m, 'contact').value, 1);
  assert.equal(get(m, 'contact').votes.agree, 2);
  assert.ok(get(m, 'contact').warnings.some((w) => w.includes('2 из 3')));
  assert.equal(get(m, 'consultation').value, 15);
  assert.equal(get(m, 'consultation').warnings.length, 0);
});

test('N/A is a vote like any other value', () => {
  const m = mergeVotes([run(1, null, 15), run(1, null, 15), run(1, 0, 15)], cl);
  assert.equal(get(m, 'identification').na, true);
  assert.equal(get(m, 'identification').value, null);
});

test('three different scale answers → median step', () => {
  const m = mergeVotes([run(1, null, 10), run(1, null, 20), run(1, null, 15)], cl);
  assert.equal(get(m, 'consultation').value, 15);
  assert.equal(get(m, 'consultation').votes.agree, 1);
});

test('explanation and evidence come from a run that gave the chosen answer', () => {
  const m = mergeVotes([run(0, null, 15), run(1, null, 15), run(1, null, 15)], cl);
  assert.equal(get(m, 'contact').explanation, 'contact=1');
});

test('consistency check is reapplied on the merged result', () => {
  const m = mergeVotes([run(1, 0, 15, 0), run(1, 0, 15, 0), run(1, 0, 15, 1)], cl);
  assert.ok(get(m, 'gross_errors').warnings.some((w) => w.startsWith('Идентификация — «Нет»')));
});

test('timingFacts: first reaction from escalation and the longest wait', () => {
  const t = [
    { idx: 0, speaker: 'client', text: 'q', t: 0 },
    { idx: 1, speaker: 'bot', text: 'b', t: 5 },
    { idx: 2, speaker: 'system', text: 'Эскалация', t: 40 },
    { idx: 3, speaker: 'operator', text: 'hi', t: 100 },
    { idx: 4, speaker: 'client', text: 'q2', t: 110 },
    { idx: 5, speaker: 'operator', text: 'a', t: 200 },
  ];
  const f = timingFacts(t);
  assert.match(f, /первая реакция оператора: 1:00 \(от \[2\] system до \[3\] operator\); порог 3:00 соблюдён/);
  assert.match(f, /самое долгое ожидание .* 1:30 \(от \[4\] до \[5\]\)/);
  assert.match(timingFacts(t, true), /\(2\) system/);
  assert.equal(timingFacts([{ idx: 0, speaker: 'client', text: 'x', t: 0 }]), '');
});
