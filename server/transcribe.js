import { z } from 'zod';
import { resolveAudio } from './dataset.js';
import { generateJson } from './gemini.js';

const MAX_INLINE_BYTES = 19 * 1024 * 1024;

const Segment = z.object({
  start_sec: z.number().describe('Время начала реплики в секундах от начала записи'),
  speaker: z.enum(['operator', 'client', 'bot', 'other']),
  language: z.enum(['ru', 'kk', 'en', 'mixed']),
  text: z.string(),
});
const AsrOutput = z.object({ segments: z.array(Segment) });
const SCHEMA = z.toJSONSchema(AsrOutput);

const PROMPT = `Транскрибируй запись телефонного звонка в поддержку брокера Freedom Broker.

- Пиши дословно на языке оригинала: казахскую речь — по-казахски кириллицей (с буквами ә, ғ, қ, ң, ө, ұ, ү, һ, і), русскую — по-русски, английскую — по-английски. Не переводи.
- Раздели на реплики. Для каждой укажи время начала в секундах от начала записи (как можно точнее), язык и роль:
  bot — автоответчик / голосовое меню (IVR);
  operator — сотрудник поддержки, говорящий с клиентом;
  client — клиент;
  other — третьи лица (например трейдер или коллега, с которым оператор говорит, пока клиент на удержании).
- Слова-паразиты и повторы оставляй, ничего не додумывай. Неразборчивое помечай как [неразборчиво].
- Маскируй персональные данные так же, как в исходных транскриптах: имена и фамилии людей → [Имя скрыто]; ИИН, номера документов, счетов, телефонов, адреса, коды из SMS, кодовые слова → [Персональные данные скрыты]. Названия компаний, продуктов и ценных бумаг не маскируй.
- Музыку ожидания и тишину пропускай, но время следующих реплик считай по реальной позиции в записи.
- Начинай с самой первой фразы записи, даже если она тихая или обрывается; ничего не пропускай в начале и в конце.
- Как отличать роли: operator — говорит от имени компании (представляется «Freedom Broker…», просит пройти идентификацию, ставит на удержание, благодарит за ожидание); client — тот, кто обратился с вопросом. Не меняй роль реплики только из-за смены темы.
- start_sec — секунды от начала аудиофайла; они должны расти и не могут превышать длительность записи.`;

const fmt = (sec) => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export async function transcribeCall(conv) {
  const started = Date.now();
  const usage = { input_tokens: 0, output_tokens: 0, calls: 0 };
  const fail = (msg) => Object.assign(new Error(msg), { status: 502, usage });
  if (!conv.audio_url) throw Object.assign(new Error('У диалога нет записи'), { status: 400 });

  const src = await resolveAudio(conv);
  const res = await fetch(src, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw fail(`Не удалось скачать запись: HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_INLINE_BYTES) {
    res.body?.cancel();
    throw fail(`Запись слишком большая для распознавания (${Math.round(len / 1e6)} МБ)`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_INLINE_BYTES) throw fail(`Запись слишком большая для распознавания (${Math.round(buf.length / 1e6)} МБ)`);
  const mime = (res.headers.get('content-type') || 'audio/mpeg').split(';')[0];

  const { json, model } = await generateJson({
    contents: [{ inlineData: { mimeType: mime, data: buf.toString('base64') } }, { text: PROMPT }],
    schema: SCHEMA,
    maxOutputTokens: 30000,
    onUsage: (_m, i, o) => {
      usage.calls += 1;
      usage.input_tokens += i;
      usage.output_tokens += o;
    },
    fail,
    label: `ASR ${conv.conversation_id}`,
  });
  const check = AsrOutput.safeParse(json);
  if (!check.success) throw fail(`Распознавание вернуло ответ не по схеме: ${check.error.issues[0]?.message || ''}`);
  const segs = check.data.segments.filter((s) => s.text.trim());
  if (!segs.length) throw fail('Распознавание вернуло пустой транскрипт');

  segs.sort((a, b) => a.start_sec - b.start_sec);
  const transcript = segs.map((s, i) => ({
    idx: i,
    timestamp: fmt(s.start_sec),
    speaker: s.speaker,
    language: s.language,
    text: s.text.trim(),
    t: Math.max(0, s.start_sec),
  }));
  const languages = [...new Set(transcript.map((m) => m.language))];
  return { transcript, model, languages, audio_bytes: buf.length, usage: { ...usage, duration_ms: Date.now() - started } };
}
