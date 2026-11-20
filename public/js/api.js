const BASE = (window.CQA_API_BASE || '').replace(/\/$/, '');

// Static demo (GitHub Pages): read-only answers saved by scripts/build-demo.js.
const STATIC = window.CQA_STATIC === true;
const DEMO_OFF = 'В демо-версии это действие недоступно: модель здесь не вызывается';

export const demoFile = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_');

async function request(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

async function demo(file) {
  const res = await fetch(`demo/${file}.json`);
  if (res.status === 404) throw new Error('Этих данных нет в демо-версии');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const off = () => Promise.reject(new Error(DEMO_OFF));

const liveApi = {
  meta: () => request('GET', '/api/meta'),
  groups: () => request('GET', '/api/groups'),
  loadGroup: (g) => request('POST', `/api/groups/${encodeURIComponent(g)}/load`),
  conversations: (g) => request('GET', `/api/conversations?group=${encodeURIComponent(g)}`),
  conversation: (id) => request('GET', `/api/conversations/${encodeURIComponent(id)}`),
  latestEvaluation: (id) => request('GET', `/api/conversations/${encodeURIComponent(id)}/evaluation`),
  evaluation: (id) => request('GET', `/api/evaluations/${encodeURIComponent(id)}`),
  evaluate: (conversation_id, checklist_id, transcript_source = 'auto') => request('POST', '/api/evaluate', { conversation_id, checklist_id, transcript_source }),
  transcribe: (id) => request('POST', `/api/conversations/${encodeURIComponent(id)}/transcribe`),
  startJob: (body) => request('POST', '/api/jobs', body),
  job: (id) => request('GET', `/api/jobs/${encodeURIComponent(id)}`),
  upload: (payload) => request('POST', '/api/upload', payload),
  checklists: () => request('GET', '/api/checklists'),
  checklistVersions: (key) => request('GET', `/api/checklists/${encodeURIComponent(key)}/versions`),
  checklistVersion: (id) => request('GET', `/api/checklist-versions/${encodeURIComponent(id)}`),
  saveChecklist: (key, body) => request('POST', `/api/checklists/${encodeURIComponent(key)}`, body),
  appeals: (status) => request('GET', `/api/appeals${status ? `?status=${status}` : ''}`),
  createAppeal: (body) => request('POST', '/api/appeals', body),
  decideAppeal: (id, body) => request('POST', `/api/appeals/${encodeURIComponent(id)}/decision`, body),
  audioUrl: (id) => `${BASE}/api/audio/${encodeURIComponent(id)}`,
};

const staticApi = {
  meta: () => demo('meta'),
  groups: () => demo('groups'),
  loadGroup: off,
  conversations: (g) => demo(`conversations/${demoFile(g)}`),
  conversation: (id) => demo(`conversation/${demoFile(id)}`),
  latestEvaluation: (id) => demo(`latest-evaluation/${demoFile(id)}`),
  evaluation: (id) => demo(`evaluation/${demoFile(id)}`),
  evaluate: off,
  transcribe: off,
  startJob: off,
  job: off,
  upload: off,
  checklists: () => demo('checklists'),
  checklistVersions: (key) => demo(`checklist-versions/${demoFile(key)}`),
  checklistVersion: (id) => demo(`checklist-version/${demoFile(id)}`),
  saveChecklist: off,
  appeals: async (status) => {
    const rows = await demo('appeals');
    return status ? rows.filter((a) => a.status === status) : rows;
  },
  createAppeal: off,
  decideAppeal: off,
  audioUrl: () => null,
};

export const api = STATIC ? staticApi : liveApi;
