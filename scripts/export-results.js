import fs from 'node:fs/promises';
import path from 'node:path';
import { buildResults, validateResults } from '../server/export.js';
import * as ds from '../server/dataset.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : acc), []),
);

const group = args.group || 'DEV';
const set = args.set || (group.toUpperCase() === 'DEV' ? 'dev' : 'prod');
const out = path.resolve(args.out || `results/${set}/results.json`);
const team = args.team || process.env.CQA_TEAM_NAME || 'chygys';
const source = args.source === 'original' ? 'original' : 'final';

const doc = await buildResults({ group, checklistId: args.checklist, teamName: team, source });
const expected = (await ds.fetchGroup(group)).map((r) => r.conversation_id);
const problems = validateResults(doc, expected);

await fs.mkdir(path.dirname(out), { recursive: true });
await fs.writeFile(out, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');

const ok = doc.results.filter((r) => r.status === 'ok').length;
const errors = doc.results.filter((r) => r.status === 'error');
console.log(`Набор ${group}: записей ${doc.results.length} (ok ${ok}, error ${errors.length}) → ${path.relative(process.cwd(), out)}`);
console.log(`Модель: ${doc.model.mode} · ${doc.model.name}`);
for (const e of errors) console.log(`  error ${e.conversation_id}: ${e.error}`);
if (set === 'prod' && doc.results.length !== 10) console.log(`ВНИМАНИЕ: в prod должно быть ровно 10 записей, сейчас ${doc.results.length}`);
if (problems.length) {
  console.log(`Проверка формата: ${problems.length} замечаний`);
  for (const p of problems.slice(0, 30)) console.log(`  - ${p}`);
  process.exitCode = 1;
} else {
  console.log('Проверка формата: OK');
}
