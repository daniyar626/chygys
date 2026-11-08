export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

class Raw {
  constructor(v) {
    this.v = String(v ?? '');
  }
}
export const raw = (v) => new Raw(v);
const part = (x) => (x instanceof Raw ? x.v : esc(x));

export function html(strings, ...vals) {
  return strings.reduce((out, s, i) => {
    if (i === 0) return s;
    const v = vals[i - 1];
    return out + (Array.isArray(v) ? v.map(part).join('') : part(v)) + s;
  }, '');
}

export const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(`cqa:${k}`);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(`cqa:${k}`, JSON.stringify(v));
    } catch {
    }
  },
};

export function toast(msg, kind = 'info') {
  const el = document.createElement('div');
  el.className = `cqa-toast cqa-toast--${kind}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 3500);
}

export const fmtScore = (v) => (v === null || v === undefined ? '—' : `${v}`);

export function scoreClass(v) {
  if (v === null || v === undefined) return 'cqa-score--none';
  if (v >= 85) return 'cqa-score--good';
  if (v >= 60) return 'cqa-score--mid';
  return 'cqa-score--bad';
}

export function scaleValues(c) {
  if (c.scale?.steps?.length) return c.scale.steps.map((s) => Number(s.value)).sort((a, b) => a - b);
  return Array.from({ length: c.scale.max - c.scale.min + 1 }, (_, i) => c.scale.min + i);
}

export const typeLabel = (c) =>
  c.type === 'flag' ? 'флаг, без баллов' : c.type === 'scale' ? `шкала ${scaleValues(c).join(' / ')}` : 'да/нет';

export function fmtAnswer(criterion, row) {
  if (!row) return '—';
  if (row.na) return 'N/A';
  if (criterion.type === 'flag') return Number(row.value) >= 1 ? 'Да — выявлено' : 'Нет';
  if (criterion.type === 'binary') return Number(row.value) >= 1 ? 'Да' : 'Нет';
  return `${row.value ?? 0} из ${criterion.scale.max}`;
}

export const speakerLabel = { operator: 'Оператор', client: 'Клиент', bot: 'Бот', system: 'Система', other: 'Третье лицо' };

export function shortTs(ts) {
  const d = Date.parse(ts);
  if (/^\d+:\d{2}/.test(ts) || Number.isNaN(d)) return ts;
  return new Date(d).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export const fmtSec = (s) => {
  if (s === null || s === undefined) return '';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};
