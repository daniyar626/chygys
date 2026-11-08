import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateResults, asrToOriginal, OFFICIAL_IDS } from '../server/export.js';

const crit = (over = {}) => [
  { criterion_id: 'contact', value: true, rationale: 'ok', evidence_turns: [4] },
  { criterion_id: 'discovery', value: null, rationale: 'ok', evidence_turns: [1] },
  { criterion_id: 'identification', value: null, rationale: 'ok', evidence_turns: [1] },
  { criterion_id: 'consultation', value: 15, rationale: 'ok', evidence_turns: [5, 6] },
  { criterion_id: 'empathy', value: true, rationale: 'ok', evidence_turns: [4, 5] },
  { criterion_id: 'dialogue', value: 7, rationale: 'ok', evidence_turns: [5, 6] },
  { criterion_id: 'closure', value: true, rationale: 'ok', evidence_turns: [8] },
  { criterion_id: 'critical', value: false, rationale: 'ok', evidence_turns: [4] },
].map((c) => ({ ...c, ...(over[c.criterion_id] || {}) }));
const doc = (results) => ({ schema_version: '1.0', team_name: 'T', model: { mode: 'external_api', name: 'm' }, results });
const okRec = (id, over) => ({ conversation_id: id, status: 'ok', criteria: crit(over), score: { final_score: 85.38, critical_flag: false } });

test('the example from the appendix passes validation', () => {
  assert.deepEqual(validateResults(doc([okRec('demo-001')]), ['demo-001']), []);
});

test('error record format from the appendix passes', () => {
  const e = { conversation_id: 'demo-002', status: 'error', criteria: [], score: null, error: 'Не удалось получить ответ модели.' };
  assert.deepEqual(validateResults(doc([okRec('demo-001'), e]), ['demo-001', 'demo-002']), []);
});

test('validation catches missing, duplicate, wrong values and flags', () => {
  const p = validateResults(doc([okRec('a'), okRec('a'), okRec('b', { dialogue: { value: 8 }, contact: { value: null } })]), ['a', 'b', 'c']);
  assert.ok(p.some((x) => x.includes('повторяющийся')));
  assert.ok(p.some((x) => x.includes('dialogue')));
  assert.ok(p.some((x) => x.includes('contact')));
  assert.ok(p.some((x) => x.includes('нет записи для c')));
  const flag = okRec('x');
  flag.score.critical_flag = true;
  assert.ok(validateResults(doc([flag]), ['x']).some((x) => x.includes('critical_flag')));
});

test('our criterion ids map to the official codes', () => {
  assert.deepEqual(Object.values(OFFICIAL_IDS), ['contact', 'discovery', 'identification', 'consultation', 'empathy', 'dialogue', 'closure', 'critical']);
});

test('Gemini line indices map to the organizers transcript', () => {
  const original = [
    { idx: 0, speaker: 'system', text: 'Агент присоединился', t: 0 },
    { idx: 1, speaker: 'operator', text: 'Компания Фридом брокер меня зовут Анна здравствуйте чем могу помочь', t: 20 },
    { idx: 2, speaker: 'client', text: 'Хочу купить облигации но приказ отклоняется второй день', t: 30 },
    { idx: 3, speaker: 'operator', text: 'Подскажите пожалуйста тикер облигации которую хотите купить', t: 45 },
  ];
  const asr = [
    { idx: 0, speaker: 'operator', text: 'Компания Freedom Broker меня зовут Анна здравствуйте чем могу помочь', t: 30 },
    { idx: 1, speaker: 'client', text: 'Хочу купить облигации но приказ отклоняется уже второй день', t: 45 },
    { idx: 2, speaker: 'operator', text: 'Подскажите пожалуйста тикер облигации', t: 68 },
  ];
  const map = asrToOriginal(asr, original);
  assert.equal(map(0), 1);
  assert.equal(map(1), 2);
  assert.equal(map(2), 3);
  assert.equal(map(99), null);
});
