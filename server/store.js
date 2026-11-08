import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(process.env.CQA_DATA_DIR || 'data');
const DB_DIR = path.join(ROOT, 'db');
const cache = new Map();
const chains = new Map();

function load(name) {
  if (!cache.has(name)) {
    const file = path.join(DB_DIR, `${name}.json`);
    const p = fs.readFile(file, 'utf8').then(
      (txt) => {
        try {
          return JSON.parse(txt);
        } catch (e) {
          throw new Error(`Повреждён файл ${file}: ${e.message}`);
        }
      },
      (e) => {
        if (e.code === 'ENOENT') return [];
        throw new Error(`Не удалось прочитать ${file}: ${e.message}`);
      },
    );
    cache.set(name, p);
    p.catch(() => cache.delete(name));
  }
  return cache.get(name);
}

function mutate(name, fn) {
  const prev = chains.get(name) || Promise.resolve();
  const run = prev.then(async () => {
    const rows = await load(name);
    const result = fn(rows);
    try {
      await fs.mkdir(DB_DIR, { recursive: true });
      const file = path.join(DB_DIR, `${name}.json`);
      const tmp = `${file}.${process.pid}.${crypto.randomUUID().slice(0, 6)}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(rows, null, 2), 'utf8');
      for (let attempt = 0; ; attempt++) {
        try {
          await fs.rename(tmp, file);
          break;
        } catch (e) {
          if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) {
            await fs.rm(tmp, { force: true });
            throw e;
          }
          await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
        }
      }
    } catch (e) {
      cache.delete(name);
      throw new Error(`Не удалось сохранить ${name}: ${e.message}`);
    }
    return result;
  });
  chains.set(name, run.catch(() => {}));
  return run;
}

export const newId = (prefix) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;

export async function all(name) {
  return [...(await load(name))];
}

export async function get(name, id) {
  return (await load(name)).find((r) => r.id === id) || null;
}

export function insert(name, row) {
  return mutate(name, (rows) => {
    rows.push(row);
    return row;
  });
}

export function update(name, id, patch) {
  return mutate(name, (rows) => {
    const i = rows.findIndex((r) => r.id === id);
    if (i < 0) return null;
    rows[i] = { ...rows[i], ...patch };
    return rows[i];
  });
}

export const paths = { ROOT, DB_DIR };
