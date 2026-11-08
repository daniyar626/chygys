import * as store from './store.js';
import * as ds from './dataset.js';
import * as checklists from './checklists.js';
import { computeScores } from './scoring.js';
import { alignClock } from '../public/js/align.js';

export const SCHEMA_VERSION = '1.0';

export const OFFICIAL_IDS = {
  contact: 'contact',
  needs: 'discovery',
  identification: 'identification',
  consultation: 'consultation',
  empathy: 'empathy',
  dialog: 'dialogue',
  closing: 'closure',
  gross_errors: 'critical',
};

const OFFICIAL_ORDER = ['contact', 'discovery', 'identification', 'consultation', 'empathy', 'dialogue', 'closure', 'critical'];

const MASK = new Set(['имя', 'скрыто', 'скрыты', 'персональные', 'данные', 'идентификации']);
const words = (t) => new Set((String(t).toLowerCase().match(/[\p{L}\d]{3,}/gu) || []).filter((x) => !MASK.has(x)));
const dice = (a, b) => {
  let common = 0;
  for (const x of a) if (b.has(x)) common++;
  return (2 * common) / (a.size + b.size || 1);
};

export function asrToOriginal(asrTranscript, original) {
  const aligned = alignClock(asrTranscript, original);
  const origWords = original.map((m) => words(m.text));
  return (asrIdx) => {
    const a = aligned[asrIdx];
    if (!a) return null;
    const w = words(a.text);
    let best = -1;
    let bestScore = 0;
    if (w.size >= 2) {
      original.forEach((m, i) => {
        const s = dice(w, origWords[i]) + (m.speaker === a.speaker ? 0.05 : 0);
        if (s > bestScore) [best, bestScore] = [i, s];
      });
    }
    if (best >= 0 && bestScore >= 0.35) return best;
    if (a.t == null) return null;
    let near = null;
    for (let i = 0; i < original.length; i++) {
      const m = original[i];
      if (m.t == null) continue;
      const d = Math.abs(m.t - a.t) + (m.speaker === a.speaker ? 0 : 30);
      if (!near || d < near.d) near = { i, d };
    }
    return near ? near.i : null;
  };
}

function toValue(c, row) {
  if (row.na) return null;
  if (c.type === 'scale') return Number(row.value);
  return Number(row.value) >= 1;
}

function turnsFor(row, mapIdx) {
  let ids = (row.evidence_ids || []).slice();
  if (!ids.length && row.checked_from != null && row.checked_to != null) {
    ids = [row.checked_from, row.checked_to];
  }
  const turns = ids.map(mapIdx).filter((i) => Number.isInteger(i)).map((i) => i + 1);
  return [...new Set(turns)].sort((x, y) => x - y);
}

export async function buildResults({ group, checklistId, teamName, source = 'final' }) {
  const recs = await ds.fetchGroup(group);
  const cl = checklistId ? await checklists.getVersion(checklistId) : (await checklists.listLatest())[0];
  if (!cl) throw new Error(`Чек-лист ${checklistId || ''} не найден`);
  const evs = (await store.all('evaluations')).filter((e) => e.checklist_id === cl.id);
  const latest = new Map();
  for (const e of evs.sort((a, b) => a.created_at.localeCompare(b.created_at))) latest.set(e.conversation_id, e);
  const transcripts = new Map((await store.all('transcripts')).map((t) => [t.id, t]));

  const evalModels = new Set();
  const asrModels = new Set();
  const results = [];

  for (const conv of recs) {
    const ev = latest.get(conv.conversation_id);
    if (!ev) {
      results.push({ conversation_id: conv.conversation_id, status: 'error', criteria: [], score: null, error: `Диалог не оценён по чек-листу ${cl.id}` });
      continue;
    }
    evalModels.add(ev.model);
    let mapIdx = (i) => (Number.isInteger(i) && i >= 0 && i < conv.transcript.length ? i : null);
    if (ev.transcript_source === 'asr' && ev.transcript_id) {
      const asr = transcripts.get(ev.transcript_id);
      if (asr) {
        asrModels.add(asr.model);
        mapIdx = asrToOriginal(asr.transcript, conv.transcript);
      }
    }
    const overrides = source === 'final' ? ev.overrides || {} : {};
    const scored = computeScores(cl, ev.criteria, overrides);
    const criteria = cl.criteria.map((c) => {
      const row = scored.criteria.find((r) => r.criterion_id === c.id);
      const rationale = [row.explanation, row.na && row.na_reason && row.na_reason !== row.explanation ? `N/A: ${row.na_reason}` : '', row.overridden ? `Изменено проверяющим: ${row.override_reason}` : '']
        .filter(Boolean)
        .join(' ');
      return {
        criterion_id: OFFICIAL_IDS[c.id] || c.id,
        value: toValue(c, row),
        rationale,
        evidence_turns: turnsFor(row, mapIdx),
      };
    });
    criteria.sort((a, b) => {
      const ia = OFFICIAL_ORDER.indexOf(a.criterion_id);
      const ib = OFFICIAL_ORDER.indexOf(b.criterion_id);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    const critical = criteria.find((x) => x.criterion_id === 'critical');
    results.push({
      conversation_id: conv.conversation_id,
      status: 'ok',
      criteria,
      score: {
        final_score: scored.final_total,
        critical_flag: critical ? critical.value === true : scored.critical_error,
      },
    });
  }

  const names = [...evalModels].map((m) => `${m} (оценка)`);
  if (asrModels.size) names.push(`${[...asrModels].join(', ')} (распознавание звонков)`);
  const isLocal = (m) => !/^(claude|gemini)/i.test(m);
  const all = [...evalModels, ...asrModels];
  const mode = all.length && all.every(isLocal) ? 'local' : all.some(isLocal) ? 'hybrid' : 'external_api';

  return {
    schema_version: SCHEMA_VERSION,
    team_name: teamName,
    model: { mode, name: names.join('; ') || 'нет оценённых диалогов' },
    results,
  };
}

const SCALE_VALUES = { consultation: [0, 5, 10, 15, 20], dialogue: [0, 4, 7, 10] };
const NULLABLE = new Set(['discovery', 'identification', 'consultation', 'closure']);

export function validateResults(doc, expectedIds = null) {
  const problems = [];
  if (doc.schema_version !== SCHEMA_VERSION) problems.push('schema_version должен быть "1.0"');
  if (!doc.team_name?.trim()) problems.push('не указан team_name');
  if (!['local', 'external_api', 'hybrid'].includes(doc.model?.mode)) problems.push('model.mode: local | external_api | hybrid');
  if (!doc.model?.name?.trim()) problems.push('не указан model.name');
  if (!Array.isArray(doc.results)) return [...problems, 'results должен быть массивом'];
  const seen = new Set();
  for (const r of doc.results) {
    const id = r.conversation_id;
    if (!id) problems.push('запись без conversation_id');
    if (seen.has(id)) problems.push(`${id}: повторяющийся ID`);
    seen.add(id);
    if (r.status === 'error') {
      if (!Array.isArray(r.criteria) || r.criteria.length) problems.push(`${id}: при error criteria должен быть []`);
      if (r.score !== null) problems.push(`${id}: при error score должен быть null`);
      if (!r.error) problems.push(`${id}: при error нужна причина в error`);
      continue;
    }
    if (r.status !== 'ok') { problems.push(`${id}: status должен быть ok или error`); continue; }
    const ids = r.criteria.map((c) => c.criterion_id);
    for (const need of OFFICIAL_ORDER) if (ids.filter((x) => x === need).length !== 1) problems.push(`${id}: критерий ${need} должен быть ровно один раз`);
    for (const c of r.criteria) {
      const v = c.value;
      if (c.criterion_id in SCALE_VALUES) {
        if (!(v === null && NULLABLE.has(c.criterion_id)) && !SCALE_VALUES[c.criterion_id].includes(v)) problems.push(`${id}/${c.criterion_id}: недопустимое значение ${JSON.stringify(v)}`);
      } else if (OFFICIAL_ORDER.includes(c.criterion_id)) {
        if (!(typeof v === 'boolean' || (v === null && NULLABLE.has(c.criterion_id)))) problems.push(`${id}/${c.criterion_id}: недопустимое значение ${JSON.stringify(v)}`);
      }
      if (typeof c.rationale !== 'string') problems.push(`${id}/${c.criterion_id}: rationale должен быть строкой`);
      if (!Array.isArray(c.evidence_turns) || c.evidence_turns.some((t) => !Number.isInteger(t) || t < 1)) problems.push(`${id}/${c.criterion_id}: evidence_turns — целые номера с 1`);
    }
    const s = r.score?.final_score;
    if (!(s === null || (typeof s === 'number' && s >= 0 && s <= 100 && Math.round(s * 100) === Math.round(s * 100 + 1e-9)))) problems.push(`${id}: final_score от 0 до 100`);
    const crit = r.criteria.find((c) => c.criterion_id === 'critical');
    if (crit && r.score?.critical_flag !== crit.value) problems.push(`${id}: critical_flag должен совпадать с критерием critical`);
  }
  if (expectedIds) {
    for (const want of expectedIds) if (!seen.has(want)) problems.push(`нет записи для ${want}`);
    for (const got of seen) if (!expectedIds.includes(got)) problems.push(`лишняя запись ${got}`);
  }
  return problems;
}
