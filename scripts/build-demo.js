// Saves read-only API answers of a running local server into demo/ for the
// GitHub Pages demo (public/js/api.js reads them when window.CQA_STATIC is set).
// Usage: start the server (npm start), then: npm run demo [-- http://127.0.0.1:3000]
import fs from 'node:fs/promises';
import path from 'node:path';

const BASE = (process.argv[2] || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/$/, '');
const OUT = path.resolve('demo');
// Same rule as demoFile() in public/js/api.js.
const file = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_');

async function get(url) {
  const res = await fetch(BASE + url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

async function save(name, data) {
  const p = path.join(OUT, `${name}.json`);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(data));
}

await fs.rm(OUT, { recursive: true, force: true });

const meta = await get('/api/meta');
await save('meta', { provider: meta.provider, model: meta.model, has_key: true, quota: null, demo: true });

const groups = await get('/api/groups');
await save('groups', groups);

const convIds = new Set();
for (const g of groups) {
  const rows = await get(`/api/conversations?group=${encodeURIComponent(g)}`);
  await save(`conversations/${file(g)}`, rows);
  rows.forEach((r) => convIds.add(r.conversation_id));
}

let evCount = 0;
for (const id of convIds) {
  const conv = await get(`/api/conversations/${encodeURIComponent(id)}`);
  await save(`conversation/${file(id)}`, conv);
  let latest = null;
  if (conv.evaluations.length) latest = await get(`/api/conversations/${encodeURIComponent(id)}/evaluation`);
  await save(`latest-evaluation/${file(id)}`, latest);
  for (const e of conv.evaluations) {
    await save(`evaluation/${file(e.id)}`, await get(`/api/evaluations/${encodeURIComponent(e.id)}`));
    evCount++;
  }
}

const cls = await get('/api/checklists');
await save('checklists', cls);
for (const c of cls) {
  const versions = await get(`/api/checklists/${encodeURIComponent(c.key)}/versions`);
  await save(`checklist-versions/${file(c.key)}`, versions);
  for (const v of versions) await save(`checklist-version/${file(v.id)}`, v);
}

await save('appeals', await get('/api/appeals'));

console.log(`demo/: ${groups.length} groups, ${convIds.size} conversations, ${evCount} evaluations, ${cls.length} checklists`);
