import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignClock, fmtClock } from '../public/js/align.js';
import { crossCheck } from '../server/evaluator.js';

const lines = [
  'Компания Freedom Broker меня зовут оператор здравствуйте чем могу помочь',
  'Хочу купить облигации но приказ постоянно отклоняется уже второй день',
  'Подскажите пожалуйста ваш полный адрес регистрации для идентификации клиента',
  'Вижу ваш приказ на покупку облигаций его можно выставить только через трейдеров',
  'Понятно спасибо большое тогда буду писать трейдерам на почту',
  'Благодарю за обращение всего хорошего до свидания',
];
const ref = lines.map((text, i) => ({ idx: i, speaker: i % 2 ? 'client' : 'operator', text, t: 60 + i * 40 }));
const gem = lines.map((text, i) => ({ idx: i, speaker: i % 2 ? 'client' : 'operator', text, t: 90 + i * 60 }));

test('alignClock maps drifting Gemini times onto the reference clock', () => {
  const out = alignClock(gem, ref);
  assert.deepEqual(out.map((m) => m.t), ref.map((m) => m.t));
});

test('alignClock keeps everything except t', () => {
  const out = alignClock(gem, ref);
  assert.deepEqual(out.map(({ t, ...rest }) => rest), gem.map(({ t, ...rest }) => rest));
});

test('alignClock extrapolates past the last anchor with the observed drift rate', () => {
  const extra = [...gem, { idx: 6, speaker: 'operator', text: 'Келесіде хабарласыңыз', t: 90 + 5 * 60 + 30 }];
  const out = alignClock(extra, ref);
  assert.equal(out.at(-1).t, 60 + 5 * 40 + 20);
});

test('a single wrong match does not drag the mapping', () => {
  const wrong = gem.map((m) => ({ ...m }));
  wrong.unshift({ idx: -1, speaker: 'other', text: 'Благодарю за обращение всего хорошего до свидания', t: 5 });
  const out = alignClock(wrong, ref);
  assert.deepEqual(out.slice(1).map((m) => m.t), ref.map((m) => m.t));
});

test('masking placeholders alone do not create a match', () => {
  const masked = [
    { idx: 0, speaker: 'client', text: '[Имя скрыто] [Персональные данные скрыты]', t: 10 },
    { idx: 1, speaker: 'client', text: 'А, [Имя скрыто].', t: 20 },
  ];
  assert.deepEqual(alignClock(masked, ref), masked);
});

test('fewer than two anchors → unchanged', () => {
  assert.equal(alignClock(gem.slice(0, 1), ref).at(0).t, gem[0].t);
  assert.equal(alignClock([], ref).length, 0);
});

test('fmtClock formats seconds as m:ss', () => {
  assert.equal(fmtClock(76.6), '1:17');
  assert.equal(fmtClock(0), '0:00');
  assert.equal(fmtClock(605), '10:05');
});

const cl = {
  criteria: [
    { id: 'identification', title: 'Идентификация', type: 'binary' },
    { id: 'gross_errors', title: 'Грубые ошибки', type: 'flag' },
  ],
};
const row = (id, value, na = false) => ({ criterion_id: id, value, na, warnings: [] });

test('crossCheck flags identification «Нет» without a gross error', () => {
  const out = crossCheck([row('identification', 0), row('gross_errors', 0)], cl);
  assert.equal(out[1].warnings.length, 1);
  assert.match(out[1].warnings[0], /конфиденциальной информации/);
  assert.equal(out[1].value, 0);
});

test('crossCheck stays quiet when consistent', () => {
  assert.equal(crossCheck([row('identification', 0), row('gross_errors', 1)], cl)[1].warnings.length, 0);
  assert.equal(crossCheck([row('identification', 1), row('gross_errors', 0)], cl)[1].warnings.length, 0);
  assert.equal(crossCheck([row('identification', null, true), row('gross_errors', 0)], cl)[1].warnings.length, 0);
});
