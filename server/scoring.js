
export function roundTo(x, decimals = 0) {
  if (x === null || x === undefined || Number.isNaN(x)) return null;
  const f = 10 ** decimals;
  return Math.sign(x) * Math.round(Math.abs(x) * f + 1e-9) / f;
}

export function scaleValues(criterion) {
  const steps = criterion.scale?.steps;
  if (Array.isArray(steps) && steps.length) return [...new Set(steps.map((s) => Number(s.value)))].sort((a, b) => a - b);
  const min = Number(criterion.scale?.min ?? 0);
  const max = Number(criterion.scale?.max ?? 1);
  return Array.from({ length: Math.max(0, max - min) + 1 }, (_, i) => min + i);
}

export function snapToStep(criterion, value) {
  const vals = scaleValues(criterion);
  return vals.reduce((best, v) => (Math.abs(v - value) < Math.abs(best - value) ? v : best), vals[0]);
}

export function normalizeValue(criterion, value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 0;
  const v = Number(value);
  if (criterion.type === 'binary') return v >= 1 ? 1 : 0;
  if (criterion.type === 'flag') return 0;
  const vals = scaleValues(criterion);
  const min = vals[0];
  const max = vals[vals.length - 1];
  if (max <= min) return v >= max ? 1 : 0;
  const clamped = Math.min(max, Math.max(min, v));
  return (clamped - min) / (max - min);
}

export function computeScores(checklist, results, overrides = {}) {
  const decimals = Number(checklist.rounding?.decimals ?? 0);
  const byId = new Map((results || []).map((r) => [r.criterion_id, r]));
  const warnings = [];

  const rows = checklist.criteria.map((c) => {
    const raw = byId.get(c.id);
    const ov = overrides[c.id];
    const row = {
      ...(raw || {}),
      criterion_id: c.id,
      section: c.section ?? null,
      weight: Number(c.weight) || 0,
      warnings: [...(raw?.warnings || [])],
      missing: !raw,
      overridden: Boolean(ov),
    };
    if (!raw) {
      row.value = 0;
      row.na = false;
      row.warnings.push('Модель не вернула результат по критерию — засчитано 0');
      warnings.push(`Нет результата по критерию ${c.id}`);
    }
    if (ov) {
      row.original_value = raw ? raw.value ?? null : null;
      row.original_na = raw ? Boolean(raw.na) : false;
      row.override_reason = ov.reason || '';
      row.override_appeal_id = ov.appeal_id || null;
      row.value = ov.na ? null : ov.value;
      row.na = Boolean(ov.na);
    }
    row.na = Boolean(row.na);
    if (row.na && !c.na_allowed) {
      row.na = false;
      row.value = 0;
      row.warnings.push('N/A недоступен для этого критерия — засчитано 0');
    }
    row.normalized = row.na ? null : normalizeValue(c, row.value);
    row.type = c.type;
    if (c.type === 'flag') {
      row.weight = 0;
      row.critical_error = !row.na && Number(row.value) >= 1;
    }
    return row;
  });

  const summarize = (subset) => {
    const applicable = subset.filter((r) => !r.na && r.type !== 'flag');
    const wSum = applicable.reduce((s, r) => s + r.weight, 0);
    if (wSum <= 0) return { score: null, earned: 0, applicable_weight: 0 };
    const earned = applicable.reduce((s, r) => s + r.normalized * r.weight, 0);
    return { score: roundTo((earned / wSum) * 100, decimals), earned, applicable_weight: wSum };
  };

  const totalInfo = summarize(rows);
  for (const r of rows) {
    if (r.na || r.type === 'flag') {
      r.points = null;
      r.max_points = null;
      r.effective_weight = 0;
    } else {
      r.points = roundTo(r.normalized * r.weight, 2);
      r.max_points = r.weight;
      r.effective_weight = totalInfo.applicable_weight > 0 ? (r.weight / totalInfo.applicable_weight) * 100 : 0;
      r.effective_points = roundTo(r.normalized * r.effective_weight, 2);
    }
  }

  const sectionDefs = checklist.sections?.length
    ? checklist.sections
    : [...new Set(rows.map((r) => r.section).filter(Boolean))].map((id) => ({ id, title: id }));
  const sections = sectionDefs.map((s) => {
    const info = summarize(rows.filter((r) => r.section === s.id));
    return { id: s.id, title: s.title, score: info.score, applicable_weight: info.applicable_weight };
  });

  const criticalRows = rows.filter((r) => r.critical_error && !r.na && !(r.overridden && overrides[r.criterion_id]?.clear_critical));
  const critical_error = criticalRows.length > 0;
  const total = totalInfo.score;
  const final_total =
    critical_error && checklist.critical_policy === 'zero_total' && total !== null ? 0 : total;

  return {
    total,
    final_total,
    critical_error,
    critical_criteria: criticalRows.map((r) => r.criterion_id),
    sections,
    criteria: rows,
    warnings,
  };
}
