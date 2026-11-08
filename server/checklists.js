import fs from 'node:fs/promises';
import path from 'node:path';
import * as store from './store.js';

const COL = 'checklists';
const SHIPPED_KEY = 'freedom';
const RETIRED_KEYS = ['default'];

const err = (msg) => Object.assign(new Error(msg), { status: 400 });

export function validateChecklist(cl) {
  if (!cl || typeof cl !== 'object') throw err('Пустой чек-лист');
  if (!cl.name?.trim()) throw err('У чек-листа нет названия');
  if (!Array.isArray(cl.criteria) || cl.criteria.length === 0) throw err('Добавьте хотя бы один критерий');
  const sections = Array.isArray(cl.sections) ? cl.sections : [];
  const sectionIds = new Set(sections.map((s) => s.id));
  const seen = new Set();
  for (const c of cl.criteria) {
    if (!/^[a-z0-9_-]{1,40}$/i.test(c.id || '')) throw err(`Некорректный id критерия: «${c.id}»`);
    if (seen.has(c.id)) throw err(`Повторяющийся id критерия: ${c.id}`);
    seen.add(c.id);
    if (!c.title?.trim()) throw err(`У критерия ${c.id} нет названия`);
    if (!c.description?.trim()) throw err(`У критерия ${c.id} нет формулировки`);
    if (!['binary', 'scale', 'flag'].includes(c.type)) throw err(`Критерий ${c.id}: тип должен быть binary, scale или flag`);
    if (!(Number(c.weight) >= 0)) throw err(`Критерий ${c.id}: вес должен быть числом ≥ 0`);
    if (c.type === 'scale') {
      const steps = Array.isArray(c.scale?.steps) ? c.scale.steps : [];
      if (steps.length) {
        const vals = steps.map((st) => Number(st.value));
        if (vals.some((v) => !Number.isFinite(v))) throw err(`Критерий ${c.id}: ступень шкалы должна быть числом`);
        if (new Set(vals).size !== vals.length) throw err(`Критерий ${c.id}: ступени шкалы повторяются`);
        if (vals.length < 2) throw err(`Критерий ${c.id}: нужно минимум две ступени`);
      } else {
        const min = Number(c.scale?.min);
        const max = Number(c.scale?.max);
        if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) throw err(`Критерий ${c.id}: шкала задана неверно`);
      }
    }
    if (c.section && sections.length && !sectionIds.has(c.section)) throw err(`Критерий ${c.id}: неизвестная секция ${c.section}`);
  }
  const decimals = Number(cl.rounding?.decimals ?? 0);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 4) throw err('Округление: от 0 до 4 знаков');
  return {
    name: cl.name.trim(),
    rounding: { decimals },
    critical_policy: cl.critical_policy === 'zero_total' ? 'zero_total' : 'flag',
    guidelines: String(cl.guidelines || '').trim(),
    sections: sections.map((s) => ({ id: String(s.id), title: String(s.title || s.id) })),
    criteria: cl.criteria.map((c) => ({
      id: c.id,
      section: c.section || null,
      title: c.title.trim(),
      description: c.description.trim(),
      type: c.type,
      ...(c.type === 'scale' ? { scale: normScale(c.scale) } : {}),
      weight: c.type === 'flag' ? 0 : Number(c.weight),
      na_allowed: Boolean(c.na_allowed),
      na_rule: c.na_rule || '',
      critical: Boolean(c.critical),
      critical_rule: c.critical_rule || '',
    })),
  };
}

function normScale(sc) {
  const steps = Array.isArray(sc?.steps) && sc.steps.length
    ? sc.steps.map((st) => ({ value: Number(st.value), label: String(st.label || '').trim() })).sort((a, b) => b.value - a.value)
    : null;
  if (steps) return { min: steps.at(-1).value, max: steps[0].value, steps };
  return { min: Number(sc.min), max: Number(sc.max) };
}

export async function seed() {
  const raw = JSON.parse(await fs.readFile(path.resolve('checklists/default.json'), 'utf8'));
  const key = raw.id || 'default';
  if ((await store.all(COL)).some((r) => r.key === key)) return;
  await saveVersion(key, raw, 'Начальная конфигурация из Quality Checklist.pdf');
}

let saveLock = Promise.resolve();
export function saveVersion(key, body, note = '') {
  const run = saveLock.then(() => saveVersionUnlocked(key, body, note));
  saveLock = run.catch(() => {});
  return run;
}

async function saveVersionUnlocked(key, body, note) {
  const clean = validateChecklist(body);
  const versions = (await store.all(COL)).filter((r) => r.key === key);
  const version = versions.reduce((m, r) => Math.max(m, r.version), 0) + 1;
  return store.insert(COL, {
    id: `${key}@v${version}`,
    key,
    version,
    note,
    created_at: new Date().toISOString(),
    ...clean,
  });
}

export async function listLatest() {
  const latest = new Map();
  for (const r of await store.all(COL)) {
    if (RETIRED_KEYS.includes(r.key)) continue;
    if (!latest.has(r.key) || latest.get(r.key).version < r.version) latest.set(r.key, r);
  }
  return [...latest.values()].sort((x, y) => (y.key === SHIPPED_KEY) - (x.key === SHIPPED_KEY));
}

export async function versions(key) {
  return (await store.all(COL)).filter((r) => r.key === key).sort((a, b) => b.version - a.version);
}

export const getVersion = (id) => store.get(COL, id);
