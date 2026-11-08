import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { generateJson, GEMINI_MODEL } from './gemini.js';
import { scaleValues, snapToStep } from './scoring.js';
import { fmtClock } from '../public/js/align.js';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

export const PROVIDER = (process.env.CQA_PROVIDER || (process.env.GEMINI_API_KEY ? 'gemini' : 'claude')).toLowerCase();
export const MODEL = PROVIDER === 'gemini' ? GEMINI_MODEL : process.env.CQA_MODEL || 'claude-opus-5-5';
const EFFORT = process.env.CQA_EFFORT || 'medium';

export const hasCredentials = () =>
  PROVIDER === 'gemini' ? Boolean(process.env.GEMINI_API_KEY) : Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

let claude;
const getClaude = () => (claude ??= new Anthropic());

const CriterionResult = z.object({
  criterion_id: z.string(),
  na: z.boolean().describe('true, если критерий неприменим по правилу N/A'),
  value: z.number().nullable().describe('binary: 1 = выполнено, 0 = нет; scale: целое в пределах шкалы; null при N/A'),
  explanation: z.string().describe('Обоснование на русском, 1-3 предложения'),
  evidence_ids: z.array(z.number().int()).describe('Номера реплик [n], на которых основан вывод'),
  checked_from: z.number().int().nullable().describe('Если действие пропущено — начало проверенного участка [n]'),
  checked_to: z.number().int().nullable().describe('Если действие пропущено — конец проверенного участка [n]'),
  na_reason: z.string().nullable(),
  critical_error: z.boolean(),
  critical_reason: z.string().nullable(),
});

const EvaluationOutput = z.object({
  criteria: z.array(CriterionResult),
  summary: z.string().describe('Общий вывод по работе оператора на русском, 1-2 предложения'),
});

const SYSTEM = `Ты — эксперт отдела контроля качества брокерской компании Freedom Broker. Ты оцениваешь работу ОПЕРАТОРА поддержки в диалоге с клиентом по заданному чек-листу.

Правила:
- Оценивай только реплики с ролью operator. Реплики bot и system — контекст (что клиент уже спросил у бота, когда подключился оператор, верифицирован ли клиент, кто завершил разговор). Роль other — третьи лица (например, трейдер или коллега, с которым оператор говорит, пока клиент на удержании): это не реплики оператора клиенту.
- Диалоги бывают на русском, казахском и английском. Понимай язык оригинала, но объяснения пиши по-русски.
- Транскрипты звонков получены автоматическим распознаванием речи: игнорируй ошибки распознавания и не штрафуй оператора за них.
- Для каждого критерия чек-листа верни ровно один результат с тем же criterion_id.
- binary: value 1 («Да», выполнено) или 0 («Нет»). scale: только одна из перечисленных ступеней шкалы. flag (без баллов): value 1 — нарушение выявлено, 0 — не выявлено.
- N/A ставь только если критерий допускает N/A и выполнено его правило N/A; тогда value = null и заполни na_reason.
- evidence_ids — номера реплик [n], подтверждающих вывод. Если действие пропущено, evidence_ids может быть пустым, но обязательно укажи checked_from/checked_to — участок разговора, где ты искал это действие.
- critical_error = true только для критерия типа flag со значением 1, либо для критерия, помеченного как критичный, если в диалоге есть грубая ошибка по его правилу. Для остальных — false.
- Если в чек-листе есть общие правила оценки, они обязательны.
- Будь последователен между критериями: если оператор сообщил сведения о счёте клиента (статус, ограничения, баланс, поручения) до подтверждения личности, это одновременно «Нет» по идентификации и раскрытие конфиденциальной информации для флага грубых ошибок — даже если клиент сам упомянул проблему.
- Одинаковые ситуации оценивай одинаково независимо от языка диалога.
- Будь строгим, но справедливым; не придумывай то, чего нет в тексте.`;

function describeChecklist(checklist) {
  return checklist.criteria
    .map((c) => {
      const type =
        c.type === 'flag' ? 'flag (Да/Нет, без баллов): 1 = нарушение выявлено, 0 = нет'
        : c.type === 'scale' ? (c.scale.steps?.length
          ? `шкала, только ступени ${scaleValues(c).join(' / ')}:\n${c.scale.steps.map((st) => `    ${st.value} — ${st.label}`).join('\n')}`
          : `шкала ${c.scale.min}..${c.scale.max}`)
        : 'binary (1 = Да / 0 = Нет)';
      const lines = [
        `- criterion_id: ${c.id}`,
        `  название: ${c.title}`,
        `  что проверять: ${c.description}`,
        `  тип ответа: ${type}`,
        `  вес: ${c.type === 'flag' ? 'без баллов' : c.weight}`,
        `  N/A: ${c.na_allowed ? `допускается. ${c.na_rule || ''}` : 'не допускается'}`,
      ];
      if (c.critical) lines.push(`  критичный: да. ${c.critical_rule || ''}`);
      return lines.join('\n');
    })
    .join('\n');
}

function describeTranscript(conv) {
  return conv.transcript
    .map((m) => `[${m.idx}] ${m.timestamp} ${m.speaker}: ${m.text.replace(/\s+/g, ' ').trim()}`)
    .join('\n');
}

export function structuralProblems(output, checklist) {
  const want = checklist.criteria.map((c) => c.id);
  const got = output.criteria.map((r) => r.criterion_id);
  const problems = [];
  const missing = want.filter((id) => !got.includes(id));
  const unknown = got.filter((id) => !want.includes(id));
  const dups = got.filter((id, i) => got.indexOf(id) !== i);
  if (missing.length) problems.push(`нет результата по: ${missing.join(', ')}`);
  if (unknown.length) problems.push(`неизвестные критерии: ${unknown.join(', ')}`);
  if (dups.length) problems.push(`повторы: ${[...new Set(dups)].join(', ')}`);
  for (const r of output.criteria) {
    if (!r.na && (r.value === null || !Number.isFinite(r.value))) problems.push(`${r.criterion_id}: нет значения при na=false`);
  }
  return problems;
}

export function sanitize(output, checklist, conv) {
  const maxIdx = conv.transcript.length - 1;
  const okIdx = (n) => Number.isInteger(n) && n >= 0 && n <= maxIdx;
  const byId = new Map(output.criteria.map((r) => [r.criterion_id, r]));
  const rows = checklist.criteria
    .filter((c) => byId.has(c.id))
    .map((c) => {
      const r = byId.get(c.id);
      const warnings = [];
      let value = r.na ? null : r.value;
      if (value !== null && c.type === 'scale') {
        const fixed = snapToStep(c, value);
        if (fixed !== value) warnings.push(`Значение модели ${value} приведено к ступени ${fixed} (допустимо: ${scaleValues(c).join(' / ')})`);
        value = fixed;
      }
      if (value !== null && (c.type === 'binary' || c.type === 'flag') && value !== 0 && value !== 1) {
        const fixed = value >= 1 ? 1 : 0;
        warnings.push(`Значение модели ${value} приведено к ${fixed}`);
        value = fixed;
      }
      const evidence = [...new Set(r.evidence_ids.filter(okIdx))];
      if (evidence.length !== r.evidence_ids.length) warnings.push('Часть ссылок на реплики вне диапазона диалога — отброшены');
      let from = okIdx(r.checked_from) ? r.checked_from : null;
      let to = okIdx(r.checked_to) ? r.checked_to : null;
      if (from !== null && to === null) to = maxIdx;
      if (to !== null && from === null) from = 0;
      if (from !== null && from > to) [from, to] = [to, from];
      if (!r.na && value !== null && value > (c.type === 'scale' ? c.scale.min : 0) && evidence.length === 0) {
        warnings.push('Положительная оценка без реплики-доказательства — проверьте вручную');
      }
      if (!r.na && evidence.length === 0 && from === null) {
        warnings.push('Модель не указала ни доказательство, ни проверенный участок');
      }
      let critical = Boolean(r.critical_error);
      if (c.type === 'flag') critical = value === 1;
      else if (critical && !c.critical) {
        warnings.push(`Модель отметила грубую ошибку, но критерий не помечен как критичный: ${r.critical_reason || ''}`);
        critical = false;
      }
      if (!r.explanation?.trim()) warnings.push('Модель не дала обоснования');
      return {
        ...r,
        raw_value: r.value,
        value,
        evidence_ids: evidence,
        checked_from: from,
        checked_to: to,
        critical_error: critical,
        critical_reason: critical ? r.critical_reason : null,
        warnings,
      };
    });
  return crossCheck(rows, checklist);
}

export function crossCheck(rows, checklist) {
  const isIdent = (c) => /идентиф|верифик|identif|verif/i.test(`${c.id} ${c.title}`);
  const identIds = checklist.criteria.filter((c) => c.type === 'binary' && isIdent(c)).map((c) => c.id);
  const flagIds = checklist.criteria.filter((c) => c.type === 'flag').map((c) => c.id);
  const identNo = rows.find((r) => identIds.includes(r.criterion_id) && !r.na && r.value === 0);
  if (!identNo) return rows;
  return rows.map((r) =>
    flagIds.includes(r.criterion_id) && !r.na && r.value === 0
      ? { ...r, warnings: [...r.warnings, 'Идентификация — «Нет», а грубая ошибка не отмечена. Проверьте: если данные по счёту раскрыты без подтверждения личности, это раскрытие конфиденциальной информации'] }
      : r,
  );
}

const clampVotes = (v, d) => Math.max(1, Math.min(7, Number(v) || d));
export const VOTES = clampVotes(process.env.CQA_VOTES, 1);
export const CONTROL_VOTES = clampVotes(process.env.CQA_CONTROL_VOTES, 3);
export const CONTROL_GROUPS = (process.env.CQA_CONTROL_GROUPS ?? 'FBroker').split(',').map((g) => g.trim().toLowerCase()).filter(Boolean);
export const votesFor = (group) => (CONTROL_GROUPS.includes(String(group || '').toLowerCase()) ? CONTROL_VOTES : VOTES);

export function timingFacts(transcript, ref = false) {
  const n = (i) => (ref ? `(${i})` : `[${i}]`);
  const lines = (transcript || []).filter((m) => m.t != null);
  const firstOp = lines.findIndex((m) => m.speaker === 'operator');
  if (firstOp < 0) return '';
  let startIdx = 0;
  for (let i = firstOp - 1; i >= 0; i--) {
    if (lines[i].speaker === 'system' || lines[i].speaker === 'bot') { startIdx = i; break; }
  }
  const start = lines[startIdx];
  const first = lines[firstOp];
  let maxWait = null;
  for (let i = firstOp; i < lines.length; i++) {
    if (lines[i].speaker !== 'client') continue;
    const reply = lines.slice(i + 1).find((m) => m.speaker === 'operator');
    if (!reply) continue;
    const wait = reply.t - lines[i].t;
    if (!maxWait || wait > maxWait.wait) maxWait = { wait, from: lines[i], to: reply };
  }
  const out = [`- первая реакция оператора: ${fmtClock(first.t - start.t)} (от ${n(start.idx)} ${start.speaker} до ${n(first.idx)} operator${ref ? ', по справочному транскрипту' : ''}); порог 3:00 ${first.t - start.t <= 180 ? 'соблюдён' : 'ПРЕВЫШЕН'}`];
  if (maxWait) out.push(`- самое долгое ожидание ответа оператора на реплику клиента: ${fmtClock(maxWait.wait)} (от ${n(maxWait.from.idx)} до ${n(maxWait.to.idx)})`);
  return out.join('\n');
}

const voteKey = (r) => (r.na ? 'N/A' : String(r.value));

export function mergeVotes(runs, checklist) {
  const n = runs.length;
  const merged = checklist.criteria.map((c) => {
    const rows = runs.map((run) => run.criteria.find((r) => r.criterion_id === c.id)).filter(Boolean);
    const counts = new Map();
    for (const r of rows) counts.set(voteKey(r), (counts.get(voteKey(r)) || 0) + 1);
    const top = Math.max(...counts.values());
    const leaders = [...counts.keys()].filter((k) => counts.get(k) === top);
    let pick = rows.find((r) => voteKey(r) === leaders[0]);
    if (leaders.length > 1 && c.type === 'scale') {
      const nums = rows.filter((r) => !r.na).map((r) => Number(r.value)).sort((a, b) => a - b);
      if (nums.length) {
        const median = snapToStep(c, nums[Math.floor((nums.length - 1) / 2)]);
        pick = rows.find((r) => !r.na && Number(r.value) === median) || pick;
      }
    }
    const agree = counts.get(voteKey(pick)) || 0;
    const spread = [...counts.entries()].map(([k, v]) => `${k === 'N/A' ? 'N/A' : k}×${v}`).join(', ');
    const warnings = (pick.warnings || []).filter((w) => !w.startsWith('Идентификация — «Нет»') && !w.startsWith('Модель не уверена'));
    if (agree < n) warnings.push(`Модель не уверена: совпало ${agree} из ${n} прогонов (${spread}) — проверьте вручную`);
    return { ...pick, warnings, votes: { agree, total: n, spread } };
  });
  return crossCheck(merged, checklist);
}

export async function evaluateConversation(conv, checklist, votes = votesFor(conv.group)) {
  const timing = timingFacts(conv.reference_transcript || conv.transcript, Boolean(conv.reference_transcript));
  const prompt = `ЧЕК-ЛИСТ «${checklist.name}» (версия ${checklist.version}):
${describeChecklist(checklist)}
${checklist.guidelines ? `
ОБЩИЕ ПРАВИЛА ОЦЕНКИ:
${checklist.guidelines}
` : ''}
ДИАЛОГ ${conv.conversation_id} (канал: ${conv.channel}, язык: ${conv.language}, транскрипт: ${conv.transcript_note || 'исходный'}):
${describeTranscript(conv)}
${conv.reference_transcript ? `
СПРАВОЧНЫЙ ТРАНСКРИПТ ОРГАНИЗАТОРОВ (тот же звонок, распознан как ru-RU: казахская речь искажена, третьи лица могут быть записаны как operator).
Используй его только для сверки: если в основном транскрипте фрагмент пропущен или роли перепутаны (например, нет приветствия, а в справочном оно есть), учитывай справочный и упомяни это в объяснении. Ссылки evidence_ids и checked_from/checked_to — только на номера основного транскрипта; если подтверждение есть лишь в справочном, оставь evidence_ids пустым и укажи в объяснении «по справочному транскрипту: …».
${conv.reference_transcript.map((m) => `(${m.idx})${m.t != null ? ` ${fmtClock(m.t)}` : ''} ${m.speaker}: ${String(m.text).replace(/\s+/g, ' ').trim()}`).join('\n')}
` : ''}
${timing ? `
ФАКТЫ О ВРЕМЕНИ (вычислены автоматически по меткам времени, используй их для критерия о скорости и не пересчитывай):
${timing}
` : ''}
Оцени работу оператора по каждому критерию чек-листа.`;

  const started = Date.now();
  const settled = await Promise.allSettled(Array.from({ length: votes }, () => evaluateOnce(conv, checklist, prompt)));
  const ok = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
  const usage = settled.reduce(
    (u, s) => {
      const x = s.status === 'fulfilled' ? s.value.usage : s.reason?.usage;
      if (x) {
        u.input_tokens += x.input_tokens || 0;
        u.output_tokens += x.output_tokens || 0;
        u.calls += x.calls || 0;
      }
      return u;
    },
    { input_tokens: 0, output_tokens: 0, calls: 0 },
  );
  usage.duration_ms = Date.now() - started;
  usage.votes = votes;
  usage.votes_ok = ok.length;
  if (!ok.length) {
    const err = settled.find((s) => s.status === 'rejected').reason;
    throw Object.assign(err, { usage });
  }
  const criteria = ok.length > 1 ? mergeVotes(ok, checklist) : ok[0].criteria;
  const best = ok
    .map((r) => ({ r, score: r.criteria.filter((x) => criteria.some((m) => m.criterion_id === x.criterion_id && voteKey(m) === voteKey(x))).length }))
    .sort((a, b) => b.score - a.score)[0].r;
  return { criteria, summary: best.summary, model: best.model, usage };
}

async function evaluateOnce(conv, checklist, prompt) {
  const started = Date.now();
  const total = { input_tokens: 0, output_tokens: 0, calls: 0 };
  let usedModel = MODEL;
  const summarizeUsage = () => ({
    input_tokens: total.input_tokens,
    output_tokens: total.output_tokens,
    calls: total.calls,
    duration_ms: Date.now() - started,
  });
  const fail = (msg) => Object.assign(new Error(msg), { status: 502, usage: summarizeUsage() });
  const track = (_model, inTok, outTok) => {
    total.calls += 1;
    total.input_tokens += inTok;
    total.output_tokens += outTok;
  };

  let lastProblem = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const text = attempt === 1
      ? prompt
      : `${prompt}\n\nПредыдущий ответ был неполным (${lastProblem}). Верни ровно по одному результату на каждый criterion_id чек-листа.`;
    const { parsed, model } = PROVIDER === 'gemini' ? await callGemini(text, track, fail) : await callClaude(text, track, fail);
    usedModel = model;

    const problems = structuralProblems(parsed, checklist);
    if (problems.length) {
      lastProblem = problems.join('; ');
      console.warn(`[evaluator] ${conv.conversation_id} попытка ${attempt}: ${lastProblem}`);
      continue;
    }
    return { criteria: sanitize(parsed, checklist, conv), summary: parsed.summary, model: usedModel, usage: summarizeUsage() };
  }
  throw fail(`Ответ модели неполный после повтора: ${lastProblem}`);
}

async function callClaude(text, track, fail) {
  const response = await getClaude().messages.parse({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { effort: EFFORT, format: zodOutputFormat(EvaluationOutput) },
    messages: [{ role: 'user', content: text }],
  });
  track(MODEL, response.usage?.input_tokens || 0, response.usage?.output_tokens || 0);
  if (response.stop_reason === 'refusal') throw fail('Модель отказалась оценивать диалог (refusal)');
  if (response.stop_reason === 'max_tokens') throw fail('Ответ модели обрезан по max_tokens');
  if (response.stop_reason !== 'end_turn') throw fail(`Неожиданное завершение ответа модели: ${response.stop_reason}`);
  if (!response.parsed_output) throw fail('Модель вернула ответ не по схеме');
  return { parsed: response.parsed_output, model: MODEL };
}

const GEMINI_SCHEMA = z.toJSONSchema(EvaluationOutput);

async function callGemini(text, track, fail) {
  const { json, model } = await generateJson({ contents: text, system: SYSTEM, schema: GEMINI_SCHEMA, onUsage: track, fail, label: 'оценка' });
  const check = EvaluationOutput.safeParse(json);
  if (!check.success) throw fail(`Gemini вернул ответ не по схеме: ${check.error.issues[0]?.message || ''}`);
  return { parsed: check.data, model };
}
