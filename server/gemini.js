import { GoogleGenAI } from '@google/genai';

export const GEMINI_MODEL = process.env.CQA_GEMINI_MODEL || (process.env.CQA_PROVIDER === 'gemini' && process.env.CQA_MODEL) || 'gemini-3.5-flash';
const FALLBACK_MODELS = (process.env.CQA_FALLBACK_MODELS ?? 'gemini-3.7-flash,gemini-3.8-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite')
  .split(',').map((s) => s.trim()).filter((m) => m && m !== GEMINI_MODEL);

const exhaustedUntil = new Map();
const dailyQuotaReset = (e) => {
  const m = String(e?.message || '');
  if (!/PerDay/i.test(m)) return null;
  const delay = /retryDelay"?:\s*"(\d+)s"/.exec(m);
  return Date.now() + (delay ? Number(delay[1]) * 1000 : 3600_000);
};
export const quotaStatus = () =>
  Object.fromEntries([GEMINI_MODEL, ...FALLBACK_MODELS].map((m) => [m, exhaustedUntil.get(m) > Date.now() ? new Date(exhaustedUntil.get(m)).toISOString() : 'ok']));

let client;
const getClient = () => (client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isTransient = (e) => [429, 500, 503].includes(e?.status) || /"code":\s*(429|500|503)/.test(String(e?.message));

export async function generateJson({ contents, system, schema, maxOutputTokens = 16000, temperature = 0, onUsage = () => {}, fail, label = '' }) {
  if (!process.env.GEMINI_API_KEY) throw fail('Не задан GEMINI_API_KEY в .env');
  let lastErr;
  const models = [GEMINI_MODEL, ...FALLBACK_MODELS].filter((m) => !(exhaustedUntil.get(m) > Date.now()));
  if (!models.length) throw fail('Дневной лимит бесплатного Gemini исчерпан у всех моделей. Подключите оплату в Google AI Studio или переключитесь на Claude (CQA_PROVIDER=claude).');
  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let r;
      try {
        r = await getClient().models.generateContent({
          model,
          contents,
          config: {
            ...(system ? { systemInstruction: system } : {}),
            responseMimeType: 'application/json',
            responseJsonSchema: schema,
            maxOutputTokens,
            temperature,
          },
        });
      } catch (e) {
        lastErr = e;
        if (!isTransient(e)) throw fail(`Gemini (${model}): ${String(e.message).slice(0, 300)}`);
        const reset = dailyQuotaReset(e);
        if (reset) {
          exhaustedUntil.set(model, reset);
          console.warn(`[gemini${label ? ` ${label}` : ''}] ${model}: дневной лимит исчерпан до ${new Date(reset).toLocaleString('ru-RU')}, переключаюсь`);
          break;
        }
        console.warn(`[gemini${label ? ` ${label}` : ''}] ${model}: временная ошибка, попытка ${attempt + 1}: ${String(e.message).slice(0, 100)}`);
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      const u = r.usageMetadata || {};
      onUsage(model, u.promptTokenCount || 0, (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0));
      const finish = r.candidates?.[0]?.finishReason;
      if (finish === 'MAX_TOKENS') throw fail('Ответ модели обрезан по лимиту токенов');
      if (finish && finish !== 'STOP') throw fail(`Gemini завершил ответ с причиной ${finish}`);
      try {
        return { json: JSON.parse(r.text), model };
      } catch {
        throw fail('Gemini вернул невалидный JSON');
      }
    }
  }
  throw fail(`Gemini недоступен (перегрузка или лимит бесплатного уровня): ${String(lastErr?.message).slice(0, 200)}`);
}
