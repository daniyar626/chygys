const MASK = new Set(['имя', 'скрыто', 'скрыты', 'персональные', 'данные', 'идентификации']);
const words = (t) => new Set((String(t).toLowerCase().match(/[\p{L}\d]{3,}/gu) || []).filter((x) => !MASK.has(x)));

export function alignClock(target, reference) {
  if (!target?.length || !reference?.length) return target;
  const refWords = reference.filter((m) => m.t != null && m.speaker !== 'system').map((m) => ({ t: m.t, w: words(m.text) }));
  const anchors = [];
  for (const m of target) {
    if (m.t == null || m.speaker === 'system') continue;
    const w = words(m.text);
    if (w.size < 3) continue;
    let best = null;
    let bestScore = 0;
    for (const r of refWords) {
      let common = 0;
      for (const x of w) if (r.w.has(x)) common++;
      const score = (2 * common) / (w.size + r.w.size || 1);
      if (score > bestScore) [best, bestScore] = [r, score];
    }
    if (best && bestScore >= 0.5) anchors.push([m.t, best.t]);
  }
  anchors.sort((x, y) => x[0] - y[0]);
  const len = anchors.map(() => 1);
  const prev = anchors.map(() => -1);
  for (let i = 0; i < anchors.length; i++) {
    for (let j = 0; j < i; j++) {
      if (anchors[j][0] < anchors[i][0] && anchors[j][1] < anchors[i][1] && len[j] + 1 > len[i]) [len[i], prev[i]] = [len[j] + 1, j];
    }
  }
  const chain = [];
  for (let i = len.indexOf(Math.max(...len, 0)); i >= 0; i = prev[i]) chain.unshift(anchors[i]);
  if (chain.length < 2) return target;

  const [f0, f1] = chain[0];
  const [l0, l1] = chain.at(-1);
  const rate = Math.min(2, Math.max(0.5, (l1 - f1) / (l0 - f0 || 1)));
  const map = (t) => {
    if (t <= f0) return Math.max(0, f1 - (f0 - t) * rate);
    if (t >= l0) return l1 + (t - l0) * rate;
    const i = chain.findIndex((p) => p[0] >= t);
    const [o0, a0] = chain[i - 1];
    const [o1, a1] = chain[i];
    return a0 + ((t - o0) / (o1 - o0 || 1)) * (a1 - a0);
  };
  return target.map((m) => (m.t == null ? m : { ...m, t: Math.round(map(m.t) * 10) / 10 }));
}

export const fmtClock = (sec) => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
