import express from 'express';
import path from 'node:path';
import * as store from './store.js';
import * as ds from './dataset.js';
import * as checklists from './checklists.js';
import { computeScores } from './scoring.js';
import { evaluateConversation, crossCheck, MODEL, PROVIDER, hasCredentials } from './evaluator.js';
import { transcribeCall } from './transcribe.js';
import { quotaStatus } from './gemini.js';
import { alignClock, fmtClock } from '../public/js/align.js';

const PORT = Number(process.env.PORT || 3000);
const CONCURRENCY = Number(process.env.CQA_CONCURRENCY || (PROVIDER === 'gemini' ? 2 : 4));
const app = express();
app.use(express.json({ limit: '20mb' }));

const CORS = (process.env.CQA_CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const corsAllowed = (origin) =>
  CORS.some((o) => o === origin || (o.startsWith('*.') && /^https:\/\//.test(origin) && new URL(origin).hostname.endsWith(o.slice(1))));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && CORS.length && corsAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, msg) => Object.assign(new Error(msg), { status });

async function latestEvaluation(conversationId) {
  const evs = (await store.all('evaluations')).filter((e) => e.conversation_id === conversationId);
  return evs.sort((a, b) => b.created_at.localeCompare(a.created_at))[0] || null;
}

async function viewEvaluation(ev) {
  if (!ev) return null;
  const cl = await checklists.getVersion(ev.checklist_id);
  const overrides = ev.overrides || {};
  const criteria = crossCheck(ev.criteria.map((r) => ({ ...r, warnings: (r.warnings || []).filter((w) => !w.startsWith('Идентификация — «Нет»')) })), cl);
  const original = computeScores(cl, criteria);
  const final = Object.keys(overrides).length ? computeScores(cl, criteria, overrides) : original;
  const appeals = (await store.all('appeals')).filter((a) => a.evaluation_id === ev.id);
  const asr = ev.transcript_id ? await store.get('transcripts', ev.transcript_id) : null;
  return {
    ...ev,
    checklist: cl,
    original,
    final,
    appeals,
    transcript_used: asr ? asr.transcript : null,
    transcript_meta: asr ? { model: asr.model, created_at: asr.created_at, languages: asr.languages || [] } : null,
  };
}

async function latestAsr(conversationId) {
  const rows = (await store.all('transcripts')).filter((t) => t.conversation_id === conversationId);
  return rows.sort((a, b) => b.created_at.localeCompare(a.created_at))[0] || null;
}

async function pickTranscript(conv, source = 'auto') {
  if (source === 'original') return { conv: { ...conv, transcript_note: 'исходный транскрипт организаторов' }, asr: null };
  const asr = await latestAsr(conv.conversation_id);
  if (!asr) {
    if (source === 'asr') throw fail(400, 'Для звонка ещё нет распознавания Gemini');
    const note = conv.audio_url ? 'исходный транскрипт организаторов (распознан как ru-RU: казахская речь может быть искажена)' : 'исходный';
    return { conv: { ...conv, transcript_note: note }, asr: null };
  }
  return {
    conv: {
      ...conv,
      transcript: alignClock(asr.transcript, conv.transcript).map((m) => ({ ...m, timestamp: fmtClock(m.t) })),
      reference_transcript: conv.transcript,
      transcript_note: `повторное распознавание записи (${asr.model}) с автоопределением языка; время реплик сверено с часами записи; роль other — третьи лица`,
    },
    asr,
  };
}

async function runEvaluation(conversationId, checklistId, source = 'auto') {
  const base = await ds.findConversation(conversationId);
  if (!base) throw fail(404, `Диалог ${conversationId} не найден`);
  const cl = await checklists.getVersion(checklistId);
  if (!cl) throw fail(404, `Чек-лист ${checklistId} не найден`);
  const { conv, asr } = await pickTranscript(base, source);
  const result = await evaluateConversation(conv, cl);
  return store.insert('evaluations', {
    id: store.newId('ev'),
    conversation_id: conv.conversation_id,
    group: conv.group,
    checklist_id: cl.id,
    transcript_source: asr ? 'asr' : 'original',
    transcript_id: asr ? asr.id : null,
    created_at: new Date().toISOString(),
    overrides: {},
    ...result,
  });
}

async function runTranscription(conversationId) {
  const conv = await ds.findConversation(conversationId);
  if (!conv) throw fail(404, `Диалог ${conversationId} не найден`);
  const r = await transcribeCall(conv);
  return store.insert('transcripts', {
    id: store.newId('tr'),
    conversation_id: conv.conversation_id,
    source: 'gemini',
    created_at: new Date().toISOString(),
    ...r,
  });
}

app.get('/api/groups', wrap(async (_req, res) => res.json(await ds.listGroups())));

app.post('/api/groups/:group/load', wrap(async (req, res) => {
  const recs = await ds.fetchGroup(req.params.group, { refresh: true });
  res.json({ group: req.params.group, total: recs.length });
}));

app.get('/api/conversations', wrap(async (req, res) => {
  const group = req.query.group || 'DEV';
  const recs = await ds.fetchGroup(group);
  const evs = await store.all('evaluations');
  const appeals = await store.all('appeals');
  const trs = await store.all('transcripts');
  const out = [];
  for (const r of recs) {
    const mine = evs.filter((e) => e.conversation_id === r.conversation_id).sort((a, b) => b.created_at.localeCompare(a.created_at));
    let summary = null;
    if (mine[0]) {
      const v = await viewEvaluation(mine[0]);
      summary = {
        id: v.id,
        checklist_id: v.checklist_id,
        total: v.original.final_total,
        final_total: v.final.final_total,
        critical_error: v.final.critical_error,
        open_appeals: appeals.filter((a) => a.conversation_id === r.conversation_id && a.status === 'open').length,
        created_at: v.created_at,
      };
    }
    const operatorMsgs = r.transcript.filter((m) => m.speaker === 'operator').length;
    out.push({
      conversation_id: r.conversation_id,
      channel: r.channel,
      language: r.language,
      has_audio: Boolean(r.audio_url),
      has_asr: trs.some((t) => t.conversation_id === r.conversation_id),
      messages: r.transcript.length,
      operator_messages: operatorMsgs,
      evaluation: summary,
    });
  }
  res.json(out);
}));

app.get('/api/conversations/:id', wrap(async (req, res) => {
  const conv = await ds.findConversation(req.params.id);
  if (!conv) throw fail(404, 'Диалог не найден');
  const { audio_url, ...rest } = conv;
  const allAppeals = await store.all('appeals');
  const evs = (await store.all('evaluations'))
    .filter((e) => e.conversation_id === conv.conversation_id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((e) => ({ id: e.id, checklist_id: e.checklist_id, transcript_source: e.transcript_source || 'original', created_at: e.created_at, appeals: allAppeals.filter((a) => a.evaluation_id === e.id).length }));
  const asr = await latestAsr(conv.conversation_id);
  res.json({ ...rest, has_audio: Boolean(audio_url), evaluations: evs, asr });
}));

app.post('/api/conversations/:id/transcribe', wrap(async (req, res) => {
  res.json(await runTranscription(req.params.id));
}));

app.post('/api/upload', wrap(async (req, res) => {
  const added = await ds.addUploads(req.body);
  res.json({ group: 'UPLOADS', added: added.map((r) => r.conversation_id) });
}));

app.get('/api/audio/:id', wrap(async (req, res) => {
  const conv = await ds.findConversation(req.params.id);
  if (!conv?.audio_url) throw fail(404, 'Для диалога нет записи');
  const src = await ds.resolveAudio(conv);
  res.redirect(302, src);
}));

app.get('/api/checklists', wrap(async (_req, res) => res.json(await checklists.listLatest())));
app.get('/api/checklists/:key/versions', wrap(async (req, res) => res.json(await checklists.versions(req.params.key))));
app.get('/api/checklist-versions/:id', wrap(async (req, res) => {
  const cl = await checklists.getVersion(req.params.id);
  if (!cl) throw fail(404, 'Версия не найдена');
  res.json(cl);
}));
app.post('/api/checklists/:key', wrap(async (req, res) => {
  const key = String(req.params.key);
  if (!/^[a-z0-9_-]{1,40}$/i.test(key)) throw fail(400, 'Некорректный ключ чек-листа');
  res.json(await checklists.saveVersion(key, req.body, req.body?.note || ''));
}));

app.post('/api/evaluate', wrap(async (req, res) => {
  const { conversation_id, checklist_id, transcript_source = 'auto' } = req.body || {};
  if (!conversation_id || !checklist_id) throw fail(400, 'Нужны conversation_id и checklist_id');
  if (!['auto', 'asr', 'original'].includes(transcript_source)) throw fail(400, 'transcript_source: auto | asr | original');
  const ev = await runEvaluation(conversation_id, checklist_id, transcript_source);
  res.json(await viewEvaluation(ev));
}));

app.get('/api/evaluations/:id', wrap(async (req, res) => {
  const ev = await store.get('evaluations', req.params.id);
  if (!ev) throw fail(404, 'Оценка не найдена');
  res.json(await viewEvaluation(ev));
}));

app.get('/api/conversations/:id/evaluation', wrap(async (req, res) => {
  res.json(await viewEvaluation(await latestEvaluation(req.params.id)));
}));

const jobs = new Map();
app.post('/api/jobs', wrap(async (req, res) => {
  const { kind = 'evaluate', group = 'DEV', checklist_id, only_missing = false, ids } = req.body || {};
  if (!['evaluate', 'transcribe'].includes(kind)) throw fail(400, 'kind: evaluate | transcribe');
  const cl = kind === 'evaluate' ? await checklists.getVersion(checklist_id) : null;
  if (kind === 'evaluate' && !cl) throw fail(404, 'Чек-лист не найден');
  const recs = await ds.fetchGroup(group);
  let targets = Array.isArray(ids) && ids.length ? recs.filter((r) => ids.includes(r.conversation_id)) : recs;
  if (kind === 'transcribe') {
    targets = targets.filter((r) => r.audio_url);
    if (only_missing) {
      const trs = await store.all('transcripts');
      targets = targets.filter((r) => !trs.some((t) => t.conversation_id === r.conversation_id));
    }
  } else if (only_missing) {
    const evs = await store.all('evaluations');
    targets = targets.filter((r) => !evs.some((e) => e.conversation_id === r.conversation_id && e.checklist_id === cl.id));
  }
  const job = { id: store.newId('job'), kind, group, checklist_id: cl?.id || null, total: targets.length, done: 0, failed: [], status: 'running', started_at: new Date().toISOString() };
  jobs.set(job.id, job);
  if (!targets.length) {
    const note = kind === 'transcribe' ? 'Нечего распознавать: все звонки набора уже распознаны' : 'Нечего оценивать: все диалоги уже оценены этой версией чек-листа';
    Object.assign(job, { status: 'finished', finished_at: job.started_at, note });
    return res.json(job);
  }
  const queue = [...targets];
  const worker = async () => {
    while (queue.length) {
      const r = queue.shift();
      try {
        if (kind === 'transcribe') await runTranscription(r.conversation_id);
        else await runEvaluation(r.conversation_id, cl.id);
      } catch (e) {
        console.error(`[job ${job.id}] ${r.conversation_id}: ${e.message}`);
        job.failed.push({ conversation_id: r.conversation_id, error: e.message });
      }
      job.done += 1;
    }
  };
  Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker))
    .then(() => (job.status = 'finished'))
    .catch((e) => {
      console.error(`[job ${job.id}] аварийно остановлена:`, e);
      job.status = 'failed';
      job.error = e.message;
    })
    .finally(() => (job.finished_at = new Date().toISOString()));
  res.json(job);
}));
app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Задача не найдена' });
  res.json(job);
});

app.post('/api/appeals', wrap(async (req, res) => {
  const { evaluation_id, criterion_id, comment } = req.body || {};
  if (!comment?.trim()) throw fail(400, 'Добавьте комментарий к апелляции');
  const ev = await store.get('evaluations', evaluation_id);
  if (!ev) throw fail(404, 'Оценка не найдена');
  const cl = await checklists.getVersion(ev.checklist_id);
  if (!cl.criteria.some((c) => c.id === criterion_id)) throw fail(400, 'Критерий не найден в чек-листе оценки');
  const dup = (await store.all('appeals')).find((a) => a.evaluation_id === ev.id && a.criterion_id === criterion_id && a.status === 'open');
  if (dup) throw fail(409, 'По этому критерию уже есть открытая апелляция');
  const original = ev.criteria.find((c) => c.criterion_id === criterion_id) || null;
  res.json(await store.insert('appeals', {
    id: store.newId('ap'),
    evaluation_id: ev.id,
    checklist_id: ev.checklist_id,
    conversation_id: ev.conversation_id,
    criterion_id,
    comment: comment.trim(),
    status: 'open',
    created_at: new Date().toISOString(),
    disputed: original ? { value: original.value, na: original.na, explanation: original.explanation, evidence_ids: original.evidence_ids } : null,
  }));
}));

app.get('/api/appeals', wrap(async (req, res) => {
  let rows = await store.all('appeals');
  if (req.query.status) rows = rows.filter((a) => a.status === req.query.status);
  const titles = new Map();
  for (const a of rows) {
    if (a.checklist_id && !titles.has(a.checklist_id)) titles.set(a.checklist_id, await checklists.getVersion(a.checklist_id));
  }
  const withTitles = rows.map((a) => ({ ...a, criterion_title: titles.get(a.checklist_id)?.criteria.find((c) => c.id === a.criterion_id)?.title || a.criterion_id }));
  res.json(withTitles.sort((a, b) => b.created_at.localeCompare(a.created_at)));
}));

let decisionLock = Promise.resolve();
const serialized = (fn) => {
  const run = decisionLock.then(fn);
  decisionLock = run.catch(() => {});
  return run;
};

app.post('/api/appeals/:id/decision', wrap((req, res) => serialized(async () => {
  const ap = await store.get('appeals', req.params.id);
  if (!ap) throw fail(404, 'Апелляция не найдена');
  if (ap.status !== 'open') throw fail(409, 'Апелляция уже рассмотрена');
  const { decision, value = null, na = false, reason, clear_critical = false } = req.body || {};
  if (!['confirm', 'change'].includes(decision)) throw fail(400, 'decision: confirm или change');
  if (!reason?.trim()) throw fail(400, 'Укажите причину решения');
  const ev = await store.get('evaluations', ap.evaluation_id);
  if (!ev) throw fail(404, 'Оценка, к которой относится апелляция, не найдена');
  const cl = await checklists.getVersion(ev.checklist_id);
  if (!cl) throw fail(404, `Версия чек-листа ${ev.checklist_id} не найдена`);
  const c = cl.criteria.find((x) => x.id === ap.criterion_id);
  if (!c) throw fail(400, 'Критерий апелляции отсутствует в чек-листе оценки');
  const overrides = { ...(ev.overrides || {}) };
  if (decision === 'change') {
    if (na && !c.na_allowed) throw fail(400, 'Для этого критерия N/A недоступен');
    if (!na) {
      if (value === null || value === undefined || value === '') throw fail(400, 'Укажите новое значение');
      const v = Number(value);
      const [min, max] = c.type === 'scale' ? [c.scale.min, c.scale.max] : [0, 1];
      if (!Number.isFinite(v) || v < min || v > max) throw fail(400, `Значение должно быть от ${min} до ${max}`);
    }
    overrides[c.id] = { value: na ? null : Number(value), na: Boolean(na), clear_critical: Boolean(clear_critical), reason: reason.trim(), appeal_id: ap.id };
  }
  const before = computeScores(cl, ev.criteria, ev.overrides || {});
  const after = computeScores(cl, ev.criteria, overrides);
  const updated = await store.update('appeals', ap.id, {
    status: decision === 'confirm' ? 'confirmed' : 'changed',
    decision: { decision, value: decision === 'change' ? (na ? null : Number(value)) : null, na: decision === 'change' && Boolean(na), reason: reason.trim(), decided_at: new Date().toISOString() },
    total_before: before.final_total,
    total_after: after.final_total,
  });
  if (decision === 'change') {
    try {
      await store.update('evaluations', ev.id, { overrides });
    } catch (e) {
      await store.update('appeals', ap.id, { status: 'open', decision: null, total_before: null, total_after: null });
      throw e;
    }
  }
  res.json(updated);
})));

app.get('/api/meta', (_req, res) => res.json({ provider: PROVIDER, model: MODEL, has_key: hasCredentials(), quota: PROVIDER === 'gemini' ? quotaStatus() : null }));

app.use(express.static(path.resolve('public')));

app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Внутренняя ошибка' });
});

await checklists.seed();
const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => console.log(`CQA: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (${PROVIDER}: ${MODEL}, параллельно ${CONCURRENCY})`));
