import fs from 'node:fs/promises';
import path from 'node:path';
import { paths } from './store.js';

const API_URL = (process.env.CQA_API_URL || '').replace(/&group_id=[^&]*/, '');
const AUDIO_HOSTS = (process.env.CQA_AUDIO_HOSTS || 'powerplatform.com,dynamics.com').split(',').map((s) => s.trim()).filter(Boolean);
const DS_DIR = path.join(paths.ROOT, 'datasets');
const groups = new Map();

const safeGroup = (g) => {
  const s = String(g || '').trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) throw Object.assign(new Error('Некорректный group_id'), { status: 400 });
  return s;
};

export function withOffsets(transcript) {
  const parseMMSS = (ts) => {
    const m = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(String(ts).trim());
    if (!m) return null;
    return m[3] !== undefined ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
  };
  let base = null;
  return transcript.map((t, i) => {
    let sec = parseMMSS(t.timestamp);
    if (sec === null) {
      const ms = Date.parse(t.timestamp);
      if (!Number.isNaN(ms)) {
        if (base === null) base = ms;
        sec = (ms - base) / 1000;
      }
    }
    return { idx: i, timestamp: String(t.timestamp ?? ''), speaker: String(t.speaker ?? ''), text: String(t.text ?? ''), t: sec };
  });
}

function normalize(rec, group) {
  if (!rec?.conversation_id || !Array.isArray(rec.transcript)) {
    throw Object.assign(new Error('Запись без conversation_id или transcript'), { status: 400 });
  }
  return {
    conversation_id: String(rec.conversation_id),
    group,
    channel: String(rec.channel || 'agent chat'),
    language: String(rec.language || 'RU'),
    audio_url: typeof rec.audio_url === 'string' && rec.audio_url ? rec.audio_url : null,
    transcript: withOffsets(rec.transcript),
  };
}

async function readCache(group) {
  const file = path.join(DS_DIR, `${group}.json`);
  let txt;
  try {
    txt = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  try {
    return JSON.parse(txt);
  } catch (e) {
    throw Object.assign(new Error(`Повреждён кеш набора ${group} (${file}): ${e.message}. Загрузите набор заново.`), { status: 500 });
  }
}

async function writeCache(group, records) {
  await fs.mkdir(DS_DIR, { recursive: true });
  await fs.writeFile(path.join(DS_DIR, `${group}.json`), JSON.stringify(records, null, 1), 'utf8');
}

export async function fetchGroup(groupId, { refresh = false } = {}) {
  const group = safeGroup(groupId);
  if (!refresh) {
    if (groups.has(group)) return groups.get(group);
    const cached = await readCache(group);
    if (cached) {
      groups.set(group, cached);
      return cached;
    }
  }
  if (group === 'UPLOADS') return groups.get(group) || [];
  if (!API_URL) throw Object.assign(new Error('Не задан CQA_API_URL в .env (ссылка GET из задания, без group_id)'), { status: 500 });
  const url = `${API_URL}&group_id=${encodeURIComponent(group)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw Object.assign(new Error(`API организаторов вернул HTTP ${res.status}`), { status: 502 });
  const body = await res.json();
  if (!body.isSuccess) throw Object.assign(new Error(`API организаторов: ${body.error || 'isSuccess=false'}`), { status: 502 });
  if (!Array.isArray(body.data?.records)) throw Object.assign(new Error('API организаторов: в ответе нет data.records'), { status: 502 });
  if (body.data.records.length === 0) throw Object.assign(new Error(`API организаторов: набор ${group} пуст (проверьте group_id)`), { status: 404 });
  const records = body.data.records.map((r, i) => {
    try {
      return normalize(r, group);
    } catch (e) {
      throw Object.assign(new Error(`Запись №${i + 1} (${r?.conversation_id || 'без id'}): ${e.message}`), { status: 502 });
    }
  });
  await writeCache(group, records);
  groups.set(group, records);
  return records;
}

export async function listGroups() {
  let files = [];
  try {
    files = await fs.readdir(DS_DIR);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
}

export async function findConversation(id) {
  for (const g of await listGroups()) {
    let recs;
    try {
      recs = await fetchGroup(g);
    } catch (e) {
      console.error(`[dataset] пропускаю набор ${g}: ${e.message}`);
      continue;
    }
    const hit = recs.find((r) => r.conversation_id === id);
    if (hit) return hit;
  }
  return null;
}

export async function addUploads(payload) {
  if (!payload || typeof payload !== 'object') throw Object.assign(new Error('Ожидается JSON-объект или массив записей'), { status: 400 });
  const list = Array.isArray(payload) ? payload : payload.data?.records || payload.records || [payload];
  if (!list.length) throw Object.assign(new Error('В файле нет записей'), { status: 400 });
  const current = await fetchGroup('UPLOADS');
  const added = list.map((r, i) => {
    try {
      return normalize(r, 'UPLOADS');
    } catch (e) {
      throw Object.assign(new Error(`Запись №${i + 1}: ${e.message}`), { status: 400 });
    }
  });
  const ids = new Set(added.map((r) => r.conversation_id));
  const merged = [...current.filter((r) => !ids.has(r.conversation_id)), ...added];
  await writeCache('UPLOADS', merged);
  groups.set('UPLOADS', merged);
  return added;
}

export async function resolveAudio(conversation) {
  if (!conversation?.audio_url) return null;
  const allowed = (u) => {
    try {
      const { protocol, hostname } = new URL(u);
      return protocol === 'https:' && AUDIO_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`));
    } catch {
      return false;
    }
  };
  if (!allowed(conversation.audio_url)) throw Object.assign(new Error('Адрес записи не из разрешённых доменов (CQA_AUDIO_HOSTS)'), { status: 400 });
  const res = await fetch(conversation.audio_url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw Object.assign(new Error(`Страница записи вернула HTTP ${res.status}`), { status: 502 });
  const type = res.headers.get('content-type') || '';
  if (type.startsWith('audio/') || type.startsWith('video/') || type.includes('octet-stream')) {
    res.body?.cancel();
    return conversation.audio_url;
  }
  const html = await res.text();
  const m = /<(?:audio|source)[^>]*\ssrc="([^"]+)"/i.exec(html) || /\ssrc="(https:[^"]+)"/i.exec(html);
  if (!m) throw Object.assign(new Error('Не удалось найти ссылку на запись на странице плеера'), { status: 502 });
  const src = m[1].replace(/&amp;/g, '&');
  if (!allowed(src)) throw Object.assign(new Error('Ссылка на запись ведёт на неразрешённый домен'), { status: 502 });
  return src;
}
