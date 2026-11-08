import { api } from '../api.js';
import { html, raw, toast, fmtScore, scoreClass, esc } from '../util.js';
import { state, setState } from '../app.js';

let filters = { lang: '', channel: '', q: '', crit: false };

export async function renderList(el) {
  const [groups, cls] = await Promise.all([api.groups(), api.checklists()]);
  if (!groups.includes(state.group)) groups.unshift(state.group);
  if (!state.checklistId || !cls.some((c) => c.id === state.checklistId)) setState({ checklistId: cls[0]?.id || null });

  el.innerHTML = html`
    <section class="cqa-hero">
      <div>
        <div class="cqa-sets" role="tablist" aria-label="Набор диалогов">
          ${groups.map((g) => raw(html`<button class="cqa-set ${g === state.group ? 'is-active' : ''}" data-set="${g}" role="tab">${g === 'DEV' ? 'DEV · разработка' : g === 'FBroker' ? 'FBroker · контрольный' : g === 'UPLOADS' ? 'Мои загрузки' : g}</button>`))}
        </div>
        <div class="cqa-eyebrow">Контроль качества · Freedom Broker</div>
        <h1>Каждый диалог.<br><em>Понятная оценка.</em></h1>
        <p>Чаты и звонки на русском, казахском и английском оцениваются по чек-листу организаторов: баллы, обоснование и реплика-доказательство по каждому критерию.</p>
      </div>
      <div class="cqa-kpis">
        <div class="cqa-kpi"><span>Диалогов в наборе ${state.group}</span><b id="kpi-total">—</b></div>
        <div class="cqa-kpi"><span>Оценено</span><b id="kpi-scored">—</b></div>
        <div class="cqa-kpi"><span>Средний балл</span><b class="is-green" id="kpi-avg">—</b></div>
        <div class="cqa-kpi"><span>Грубые ошибки</span><b class="is-red" id="kpi-crit">—</b></div>
      </div>
    </section>
    <section class="cqa-toolbar">
      <div class="cqa-field">
        <label>Набор (group_id)</label>
        <div class="cqa-row">
          <select id="grp">${groups.map((g) => raw(`<option ${g === state.group ? 'selected' : ''}>${esc(g)}</option>`))}</select>
          <input id="grp-new" placeholder="другой group_id" size="12">
          <button id="grp-load" class="cqa-btn">Загрузить из API</button>
        </div>
      </div>
      <div class="cqa-field">
        <label>Чек-лист для оценки</label>
        <select id="cl">${cls.map((c) => raw(`<option value="${esc(c.id)}" ${c.id === state.checklistId ? 'selected' : ''}>${esc(c.name)} — v${c.version}</option>`))}</select>
      </div>
      <div class="cqa-field">
        <label>Пакетная оценка</label>
        <div class="cqa-row">
          <button id="run-missing" class="cqa-btn cqa-btn--primary">Оценить неоценённые</button>
          <button id="run-all" class="cqa-btn">Переоценить все</button>
        </div>
      </div>
      <div class="cqa-field">
        <label>Звонки</label>
        <button id="run-asr" class="cqa-btn" title="Распознать записи звонков заново через Gemini (казахская речь, роли)">Распознать звонки (Gemini)</button>
      </div>
      <div class="cqa-field">
        <label>Свой транскрипт</label>
        <label class="cqa-btn cqa-upload">Загрузить JSON<input type="file" id="upload" accept=".json,application/json" hidden></label>
      </div>
    </section>
    <div id="job" class="cqa-job" hidden></div>
    <section class="cqa-filters">
      <input id="f-q" placeholder="Поиск по ID" value="${filters.q}">
      <select id="f-lang"><option value="">Все языки</option>${['RU', 'KZ', 'EN'].map((l) => raw(`<option ${filters.lang === l ? 'selected' : ''}>${l}</option>`))}</select>
      <select id="f-ch"><option value="">Все каналы</option>${['agent chat', 'voice call'].map((c) => raw(`<option ${filters.channel === c ? 'selected' : ''}>${c}</option>`))}</select>
      <label class="cqa-check"><input type="checkbox" id="f-crit" ${filters.crit ? 'checked' : ''}> Только с грубыми ошибками</label>
      <span id="stats" class="cqa-muted"></span>
    </section>
    <div id="table" class="cqa-table-wrap"><div class="cqa-empty">Загрузка…</div></div>`;

  const $ = (s) => el.querySelector(s);
  let rows = [];
  el.querySelectorAll('[data-set]').forEach((b) => (b.onclick = () => {
    setState({ group: b.dataset.set });
    renderList(el);
  }));
  $('#grp').onchange = (e) => {
    setState({ group: e.target.value });
    renderList(el);
  };
  $('#cl').onchange = (e) => setState({ checklistId: e.target.value });
  $('#grp-load').onclick = async () => {
    const g = $('#grp-new').value.trim() || state.group;
    $('#grp-load').disabled = true;
    try {
      const r = await api.loadGroup(g);
      toast(`Загружено диалогов: ${r.total}`);
      setState({ group: g });
      renderList(el);
    } catch (e) {
      toast(e.message, 'error');
      $('#grp-load').disabled = false;
    }
  };
  $('#upload').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const r = await api.upload(JSON.parse(await file.text()));
      toast(`Добавлено: ${r.added.join(', ')}`);
      setState({ group: 'UPLOADS' });
      renderList(el);
    } catch (err) {
      toast(`Не удалось загрузить: ${err.message}`, 'error');
    } finally {
      e.target.value = '';
    }
  };
  const startJob = async (onlyMissing) => {
    if (!state.checklistId) return toast('Выберите чек-лист', 'error');
    try {
      const job = await api.startJob({ group: state.group, checklist_id: state.checklistId, only_missing: onlyMissing });
      pollJob(el, job.id);
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  $('#run-missing').onclick = () => startJob(true);
  $('#run-asr').onclick = async () => {
    try {
      const job = await api.startJob({ kind: 'transcribe', group: state.group, only_missing: true });
      pollJob(el, job.id);
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  $('#run-all').onclick = () => {
    if (confirm('Переоценить все диалоги набора? Это вызовет модель для каждого диалога.')) startJob(false);
  };
  $('#f-crit').onchange = (e) => {
    filters.crit = e.target.checked;
    drawTable(el, rows);
  };
  for (const [id, key] of [['#f-q', 'q'], ['#f-lang', 'lang'], ['#f-ch', 'channel']]) {
    $(id).oninput = (e) => {
      filters[key] = e.target.value;
      drawTable(el, rows);
    };
  }

  try {
    rows = await api.conversations(state.group);
  } catch (e) {
    $('#table').innerHTML = html`<div class="cqa-empty cqa-empty--error">${e.message}</div>`;
    return;
  }
  drawTable(el, rows);
}

function drawTable(el, rows) {
  const f = rows.filter(
    (r) =>
      (!filters.lang || r.language === filters.lang) &&
      (!filters.channel || r.channel === filters.channel) &&
      (!filters.q || r.conversation_id.toLowerCase().includes(filters.q.toLowerCase())) &&
      (!filters.crit || r.evaluation?.critical_error),
  );
  const scored = f.filter((r) => r.evaluation?.final_total != null);
  const avg = scored.length ? (scored.reduce((s, r) => s + r.evaluation.final_total, 0) / scored.length).toFixed(1) : '—';
  el.querySelector('#stats').textContent = `Показано ${f.length} из ${rows.length} · оценено ${scored.length} · средний балл ${avg} · грубых ошибок ${f.filter((r) => r.evaluation?.critical_error).length}`;
  const set = (id, v) => { const n = el.querySelector(id); if (n) n.textContent = v; };
  set('#kpi-total', rows.length);
  set('#kpi-scored', `${scored.length}`);
  set('#kpi-avg', avg);
  set('#kpi-crit', f.filter((r) => r.evaluation?.critical_error).length);
  if (!f.length) {
    el.querySelector('#table').innerHTML = html`<div class="cqa-empty">Нет диалогов. Загрузите набор из API.</div>`;
    return;
  }
  el.querySelector('#table').innerHTML = html`
    <table class="cqa-table">
      <thead><tr><th>Диалог</th><th>Канал</th><th>Язык</th><th>Реплик (опер.)</th><th>Чек-лист</th><th>Исходный балл</th><th>Итог</th><th>Грубая ошибка</th><th>Апелляции</th></tr></thead>
      <tbody>${f.map((r) => {
        const e = r.evaluation;
        return raw(html`<tr data-id="${r.conversation_id}" tabindex="0">
          <td><a href="#/c/${encodeURIComponent(r.conversation_id)}">${r.conversation_id}</a></td>
          <td>${r.channel === 'voice call' ? '📞 звонок' : '💬 чат'}${r.has_asr ? raw(' <span class="cqa-badge" title="Есть распознавание Gemini">ASR</span>') : ''}</td>
          <td>${r.language}</td>
          <td>${r.messages} (${r.operator_messages})</td>
          <td class="cqa-muted">${e?.checklist_id || '—'}</td>
          <td>${e ? fmtScore(e.total) : '—'}</td>
          <td>${e ? raw(`<span class="cqa-score ${scoreClass(e.final_total)}">${fmtScore(e.final_total)}</span>`) : raw('<span class="cqa-muted">не оценён</span>')}</td>
          <td>${e?.critical_error ? raw('<span class="cqa-badge cqa-badge--crit">Да</span>') : ''}</td>
          <td>${e?.open_appeals ? raw(`<span class="cqa-badge">${e.open_appeals} откр.</span>`) : ''}</td>
        </tr>`);
      })}</tbody>
    </table>`;
  el.querySelectorAll('tbody tr').forEach((tr) => {
    const go = () => (location.hash = `#/c/${encodeURIComponent(tr.dataset.id)}`);
    tr.addEventListener('click', (ev) => ev.target.tagName !== 'A' && go());
    tr.addEventListener('keydown', (ev) => ev.key === 'Enter' && go());
  });
}

let pollTimer = null;
function pollJob(el, id) {
  clearTimeout(pollTimer);
  const box = el.querySelector('#job');
  let errors = 0;
  const tick = async () => {
    let job;
    try {
      job = await api.job(id);
      errors = 0;
    } catch (e) {
      box.hidden = false;
      if (++errors >= 5) {
        box.textContent = `Не удаётся получить статус задачи: ${e.message}`;
        return;
      }
      box.textContent = `Нет связи с сервером, повторяю… (${e.message})`;
      pollTimer = setTimeout(tick, 3000);
      return;
    }
    if (!document.body.contains(box)) return;
    box.hidden = false;
    const pct = job.total ? Math.round((job.done / job.total) * 100) : 100;
    box.innerHTML = html`
      <div class="cqa-row"><strong>${job.kind === 'transcribe' ? 'Распознавание звонков' : 'Оценка'} набора ${job.group}</strong>
        <span>${job.done} / ${job.total}</span>
        ${job.note ? raw(`<span class="cqa-muted">${esc(job.note)}</span>`) : ''}
        ${job.status === 'failed' ? raw(`<span class="cqa-badge cqa-badge--crit">задача остановлена: ${esc(job.error || '')}</span>`) : ''}
        ${job.failed.length ? raw(`<span class="cqa-badge cqa-badge--crit">ошибок: ${job.failed.length}</span>`) : ''}
      </div>
      <div class="cqa-progress"><div style="width:${pct}%"></div></div>
      ${job.failed.length ? raw(`<details><summary>Ошибки</summary>${job.failed.map((f) => `<div>${esc(f.conversation_id)}: ${esc(f.error)}</div>`).join('')}</details>`) : ''}`;
    if (job.status === 'running') pollTimer = setTimeout(tick, 2000);
    else {
      toast(job.note || `${job.kind === 'transcribe' ? 'Распознавание' : 'Оценка'} завершена: успешно ${job.done - job.failed.length}, с ошибкой ${job.failed.length}`, job.failed.length ? 'error' : 'info');
      try {
        drawTable(el, await api.conversations(state.group));
      } catch (e) {
        toast(`Не удалось обновить список: ${e.message}`, 'error');
      }
    }
  };
  tick();
}
