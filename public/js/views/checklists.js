import { api } from '../api.js';
import { html, raw, esc, toast } from '../util.js';
import { state, setState } from '../app.js';

let draft = null;

export async function renderChecklists(el, key) {
  const list = await api.checklists();
  const current = list.find((c) => c.key === key) || list.find((c) => c.id === state.checklistId) || list[0];
  if (!current) {
    el.innerHTML = '<div class="cqa-empty">Чек-листов нет</div>';
    return;
  }
  if (!draft || draft.__key !== current.key || draft.__from !== current.id) {
    draft = structuredClone(current);
    draft.__key = current.key;
    draft.__from = current.id;
  }
  const versions = await api.checklistVersions(current.key);

  el.innerHTML = html`
    <div class="cqa-cl-layout">
      <aside class="cqa-cl-side">
        <h2>Чек-листы</h2>
        ${list.map((c) => raw(html`<a class="cqa-cl-item ${c.key === current.key ? 'is-active' : ''}" href="#/checklists/${encodeURIComponent(c.key)}">${c.name}<span class="cqa-muted">v${c.version} · ${c.criteria.length} крит.</span></a>`))}
        <button class="cqa-btn cqa-btn--sm" id="clone">Копировать как новый</button>
        <h3>Версии «${current.key}»</h3>
        ${versions.map((v) => raw(html`<div class="cqa-ver"><b>v${v.version}</b> ${new Date(v.created_at).toLocaleString('ru-RU')}<div class="cqa-muted">${v.note || ''}</div></div>`))}
      </aside>
      <section class="cqa-cl-main">
        <div class="cqa-row cqa-cl-top">
          <label class="cqa-grow">Название <input id="name" value="${draft.name}"></label>
          <label>Округление итога, знаков <input id="dec" type="number" min="0" max="4" value="${draft.rounding?.decimals ?? 0}" style="width:5em"></label>
          <label>Грубая ошибка
            <select id="crit-policy">
              <option value="flag" ${draft.critical_policy !== 'zero_total' ? 'selected' : ''}>отмечается отдельно</option>
              <option value="zero_total" ${draft.critical_policy === 'zero_total' ? 'selected' : ''}>обнуляет итог</option>
            </select>
          </label>
        </div>
        <details class="cqa-sections-edit">
          <summary>Общие правила оценки (передаются модели вместе с критериями)</summary>
          <textarea id="guidelines" rows="8" placeholder="Например: чем «Нет» отличается от N/A, что считать услугой в обход компании…">${draft.guidelines || ''}</textarea>
        </details>
        <details class="cqa-sections-edit" open>
          <summary>Секции (${draft.sections.length})</summary>
          <div id="sections">${draft.sections.map((s, i) => raw(html`
            <div class="cqa-row" data-sec="${i}">
              <input data-f="id" value="${s.id}" placeholder="id" style="width:9em">
              <input data-f="title" value="${s.title}" placeholder="Название секции" class="cqa-grow">
              <button class="cqa-btn cqa-btn--sm" data-del-sec="${i}" title="Удалить секцию">✕</button>
            </div>`))}</div>
          <button class="cqa-btn cqa-btn--sm" id="add-sec">+ Секция</button>
        </details>
        <div id="criteria">${draft.criteria.map((c, i) => raw(criterionEditor(c, i, draft.sections)))}</div>
        <div class="cqa-row cqa-cl-actions">
          <button class="cqa-btn" id="add-crit">+ Критерий</button>
          <span class="cqa-muted" id="wsum"></span>
          <div class="cqa-spacer"></div>
          <input id="note" placeholder="Комментарий к версии (что изменено)" size="32">
          <button class="cqa-btn" id="reset">Отменить изменения</button>
          <button class="cqa-btn cqa-btn--primary" id="save">Сохранить новую версию</button>
        </div>
        <div class="cqa-row cqa-cl-apply">
          <span>Применить сохранённую версию к набору</span>
          <input id="apply-group" value="${state.group}" size="10">
          <button class="cqa-btn" id="apply">Запустить оценку набора</button>
        </div>
      </section>
    </div>`;

  const $ = (s) => el.querySelector(s);
  const sync = () => {
    draft.name = $('#name').value;
    draft.rounding = { decimals: Number($('#dec').value) };
    draft.critical_policy = $('#crit-policy').value;
    draft.guidelines = $('#guidelines').value;
    draft.sections = [...el.querySelectorAll('[data-sec]')].map((row) => ({
      id: row.querySelector('[data-f=id]').value.trim(),
      title: row.querySelector('[data-f=title]').value.trim(),
    }));
    draft.criteria = [...el.querySelectorAll('[data-crit]')].map((row) => {
      const g = (f) => row.querySelector(`[data-f=${f}]`);
      const type = g('type').value;
      return {
        id: g('id').value.trim(),
        section: g('section').value || null,
        title: g('title').value,
        description: g('description').value,
        type,
        ...(type === 'scale' ? { scale: { min: Number(g('min').value), max: Number(g('max').value), steps: parseSteps(g('steps').value) } } : {}),
        weight: type === 'flag' ? 0 : Number(g('weight').value),
        na_allowed: g('na_allowed').checked,
        na_rule: g('na_rule').value,
        critical: g('critical').checked,
        critical_rule: g('critical_rule').value,
      };
    });
    const sum = draft.criteria.reduce((s, c) => s + (Number(c.weight) || 0), 0);
    $('#wsum').textContent = `Сумма весов: ${sum} (итог нормируется к 100 автоматически)`;
  };
  const rerender = () => renderChecklists(el, current.key);
  sync();
  el.oninput = sync;
  el.onchange = (e) => {
    sync();
    if (e.target.matches('[data-f=type], [data-f=na_allowed], [data-f=critical]')) rerender();
  };

  $('#add-sec').onclick = () => {
    sync();
    draft.sections.push({ id: `s${draft.sections.length + 1}`, title: 'Новая секция' });
    rerender();
  };
  el.querySelectorAll('[data-del-sec]').forEach((b) => (b.onclick = () => {
    sync();
    draft.sections.splice(Number(b.dataset.delSec), 1);
    rerender();
  }));
  $('#add-crit').onclick = () => {
    sync();
    draft.criteria.push({
      id: `crit_${draft.criteria.length + 1}`, section: draft.sections[0]?.id || null, title: 'Новый критерий',
      description: '', type: 'binary', weight: 10, na_allowed: false, na_rule: '', critical: false, critical_rule: '',
    });
    rerender();
  };
  el.querySelectorAll('[data-del-crit]').forEach((b) => (b.onclick = () => {
    sync();
    if (!confirm('Удалить критерий?')) return;
    draft.criteria.splice(Number(b.dataset.delCrit), 1);
    rerender();
  }));
  el.querySelectorAll('[data-move]').forEach((b) => (b.onclick = () => {
    sync();
    const [i, d] = b.dataset.move.split(':').map(Number);
    const j = i + d;
    if (j < 0 || j >= draft.criteria.length) return;
    [draft.criteria[i], draft.criteria[j]] = [draft.criteria[j], draft.criteria[i]];
    rerender();
  }));
  $('#reset').onclick = () => {
    draft = null;
    rerender();
  };
  $('#save').onclick = async () => {
    sync();
    try {
      const saved = await api.saveChecklist(current.key, { ...draft, note: $('#note').value });
      draft = null;
      setState({ checklistId: saved.id });
      toast(`Сохранена версия v${saved.version}. Она выбрана для новых оценок.`);
      rerender();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  $('#clone').onclick = async () => {
    const newKey = prompt('Ключ нового чек-листа (латиница, цифры, _ или -):', `${current.key}_copy`);
    if (!newKey) return;
    sync();
    try {
      const saved = await api.saveChecklist(newKey, { ...draft, name: `${draft.name} (копия)`, note: `Копия ${current.id}` });
      draft = null;
      setState({ checklistId: saved.id });
      location.hash = `#/checklists/${encodeURIComponent(saved.key)}`;
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  $('#apply').onclick = async () => {
    const latest = (await api.checklists()).find((c) => c.key === current.key);
    const group = $('#apply-group').value.trim() || state.group;
    if (draft && JSON.stringify(stripMeta(draft)) !== JSON.stringify(stripMeta(latest))) {
      if (!confirm('Есть несохранённые изменения. Применить последнюю сохранённую версию без них?')) return;
    }
    try {
      const job = await api.startJob({ group, checklist_id: latest.id, only_missing: true });
      setState({ checklistId: latest.id, group });
      toast(`Запущена оценка ${job.total} диалогов набора ${group} по v${latest.version}`);
      location.hash = '#/';
    } catch (e) {
      toast(e.message, 'error');
    }
  };
}

const stripMeta = (c) => ({ name: c.name, rounding: c.rounding, critical_policy: c.critical_policy, guidelines: c.guidelines || '', sections: c.sections, criteria: c.criteria });

function parseSteps(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = /^(-?\d+(?:[.,]\d+)?)\s*(?:[—–:-]\s*)?(.*)$/.exec(l);
      return m ? { value: Number(m[1].replace(',', '.')), label: m[2].trim() } : { value: NaN, label: l };
    });
}
const stepsText = (c) => (c.scale?.steps || []).map((s) => `${s.value} — ${s.label}`).join('\n');

function criterionEditor(c, i, sections) {
  return html`
  <div class="cqa-crit-edit" data-crit="${i}">
    <div class="cqa-row">
      <span class="cqa-crit-num">${i + 1}</span>
      <input data-f="title" value="${c.title}" placeholder="Название" class="cqa-grow">
      <input data-f="id" value="${c.id}" placeholder="id" style="width:9em" title="Идентификатор критерия">
      <button class="cqa-btn cqa-btn--sm" data-move="${i}:-1" title="Выше">↑</button>
      <button class="cqa-btn cqa-btn--sm" data-move="${i}:1" title="Ниже">↓</button>
      <button class="cqa-btn cqa-btn--sm" data-del-crit="${i}" title="Удалить">✕</button>
    </div>
    <textarea data-f="description" rows="2" placeholder="Формулировка: что именно проверять">${c.description}</textarea>
    <div class="cqa-row">
      <label>Секция <select data-f="section"><option value="">—</option>${sections.map((s) => raw(`<option value="${esc(s.id)}" ${s.id === c.section ? 'selected' : ''}>${esc(s.title)}</option>`))}</select></label>
      <label>Вес <input data-f="weight" type="number" min="0" step="any" value="${c.type === 'flag' ? 0 : c.weight}" style="width:5em" ${c.type === 'flag' ? 'disabled title="Флаг не даёт баллов"' : ''}></label>
      <label>Тип ответа <select data-f="type">
        <option value="binary" ${c.type === 'binary' ? 'selected' : ''}>Да / Нет</option>
        <option value="scale" ${c.type === 'scale' ? 'selected' : ''}>Шкала</option>
        <option value="flag" ${c.type === 'flag' ? 'selected' : ''}>Флаг грубой ошибки (без баллов)</option>
      </select></label>
      ${c.type === 'scale'
        ? raw(html`<label>от <input data-f="min" type="number" value="${c.scale?.min ?? 0}" style="width:4em"></label><label>до <input data-f="max" type="number" value="${c.scale?.max ?? 2}" style="width:4em"></label>`)
        : raw('<input data-f="min" type="hidden" value="0"><input data-f="max" type="hidden" value="1">')}
      <label><input data-f="na_allowed" type="checkbox" ${c.na_allowed ? 'checked' : ''}> N/A допустим</label>
      <label><input data-f="critical" type="checkbox" ${c.critical ? 'checked' : ''}> Может быть грубой ошибкой</label>
    </div>
    ${c.type === 'scale'
      ? raw(html`<label class="cqa-steps">Ступени шкалы — по одной в строке «значение — описание» (пусто = любое целое от «от» до «до»)<textarea data-f="steps" rows="${Math.max(2, (c.scale?.steps?.length || 0) + 1)}" placeholder="20 — Все существенные вопросы закрыты">${stepsText(c)}</textarea></label>`)
      : raw('<textarea data-f="steps" hidden></textarea>')}
    <input data-f="na_rule" value="${c.na_rule || ''}" placeholder="Правило N/A: когда критерий неприменим" ${c.na_allowed ? '' : 'hidden'}>
    <input data-f="critical_rule" value="${c.critical_rule || ''}" placeholder="Что считается грубой ошибкой" ${c.critical ? '' : 'hidden'}>
  </div>`;
}
