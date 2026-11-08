import { api } from '../api.js';
import { html, raw, esc, toast, fmtScore, scoreClass, fmtAnswer, speakerLabel, shortTs, fmtSec, scaleValues, typeLabel } from '../util.js';
import { state, setState } from '../app.js';
import { alignClock, fmtClock } from '../align.js';
const onRecordingClock = (list, ref) => alignClock(list, ref).map((m) => (m.t == null ? m : { ...m, timestamp: fmtClock(m.t) }));

let ctx = null;

export async function renderCard(el, id, evaluationId = null) {
  el.innerHTML = '<div class="cqa-empty">Загрузка диалога…</div>';
  const [conv, cls] = await Promise.all([api.conversation(id), api.checklists()]);
  const ev = evaluationId ? await api.evaluation(evaluationId) : await api.latestEvaluation(id);
  if (!state.checklistId || !cls.some((c) => c.id === state.checklistId)) setState({ checklistId: cls[0]?.id || null });

  const views = [{ key: 'original', label: 'Организаторы', transcript: conv.transcript }];
  if (conv.asr) views.push({ key: 'asr', label: `Gemini · ${conv.asr.languages?.join('+') || ''}`, transcript: onRecordingClock(conv.asr.transcript, conv.transcript) });
  let evalKey = null;
  if (ev) {
    if (ev.transcript_source === 'asr' && ev.transcript_used) {
      if (conv.asr && ev.transcript_id === conv.asr.id) evalKey = 'asr';
      else {
        views.push({ key: 'evalasr', label: 'Gemini (версия из оценки)', transcript: onRecordingClock(ev.transcript_used, conv.transcript) });
        evalKey = 'evalasr';
      }
    } else evalKey = 'original';
  }
  ctx = { el, conv, views, evalKey, view: evalKey || (conv.asr ? 'asr' : 'original') };
  const isCall = conv.has_audio;

  el.innerHTML = html`
    <div class="cqa-card-head">
      <a href="#/" class="cqa-back">← К списку</a>
      <h1>${conv.conversation_id}</h1>
      <span class="cqa-chip">${isCall ? '📞 звонок' : '💬 чат'}</span>
      <span class="cqa-chip">${conv.language}</span>
      <div class="cqa-spacer"></div>
      ${conv.evaluations.length > 1
        ? raw(html`<select id="ev-pick" title="История оценок">${conv.evaluations.map((e) =>
            raw(`<option value="${esc(e.id)}" ${ev && e.id === ev.id ? 'selected' : ''}>${esc(new Date(e.created_at).toLocaleString('ru-RU'))} · ${esc(e.checklist_id)}${e.transcript_source === 'asr' ? ' · Gemini' : ''}</option>`))}</select>`)
        : ''}
      <select id="cl" title="Чек-лист">${cls.map((c) => raw(`<option value="${esc(c.id)}" ${c.id === state.checklistId ? 'selected' : ''}>${esc(c.name)} — v${c.version}</option>`))}</select>
      ${isCall
        ? raw(html`<select id="src" title="Какой транскрипт отдать модели">
            <option value="auto">Транскрипт: авто (Gemini, если есть)</option>
            <option value="asr" ${conv.asr ? '' : 'disabled'}>Транскрипт: Gemini</option>
            <option value="original">Транскрипт: организаторов</option>
          </select>`)
        : ''}
      <button id="run" class="cqa-btn cqa-btn--primary">${ev ? 'Переоценить' : 'Оценить'}</button>
    </div>
    <div class="cqa-split">
      <section class="cqa-pane cqa-pane--transcript">
        ${isCall
          ? raw(html`<div class="cqa-player">
              <audio id="audio" controls preload="none" src="${api.audioUrl(conv.conversation_id)}"></audio>
              <div class="cqa-row">
                <a href="${api.audioUrl(conv.conversation_id)}" target="_blank" rel="noopener">Открыть запись в новой вкладке</a>
                <div class="cqa-spacer"></div>
                <button id="asr" class="cqa-btn cqa-btn--sm">${conv.asr ? 'Распознать заново' : 'Распознать запись (Gemini)'}</button>
              </div>
              <div class="cqa-muted">Транскрипт организаторов распознан как ru-RU: казахская речь в нём искажена, а реплики третьих лиц (трейдер на удержании) записаны как оператор. Gemini распознаёт запись заново с определением языка и ролей. Время реплик Gemini пересчитано по часам организаторов, которые совпадают с записью. Кнопка ▶ у реплики перематывает запись к ней.</div>
            </div>`)
          : ''}
        <div class="cqa-tabs" id="tabs"></div>
        <div class="cqa-transcript" id="transcript"></div>
      </section>
      <section class="cqa-pane cqa-pane--result" id="result"></section>
    </div>`;

  const $ = (s) => el.querySelector(s);
  $('#cl').onchange = (e) => setState({ checklistId: e.target.value });
  $('#ev-pick')?.addEventListener('change', (e) => {
    location.hash = `#/c/${encodeURIComponent(id)}/e/${encodeURIComponent(e.target.value)}`;
  });
  const otherAppeals = conv.evaluations.filter((e) => e.id !== ev?.id && e.appeals > 0);
  if (otherAppeals.length) {
    $('.cqa-card-head').insertAdjacentHTML(
      'afterend',
      html`<div class="cqa-banner">Есть апелляции к другим оценкам этого диалога: ${raw(otherAppeals.map((e) => html`<a href="#/c/${encodeURIComponent(id)}/e/${encodeURIComponent(e.id)}">${new Date(e.created_at).toLocaleString('ru-RU')} (${e.appeals})</a>`).join(', '))}</div>`,
    );
  }
  if (ev && conv.evaluations[0] && conv.evaluations[0].id !== ev.id) {
    $('.cqa-card-head').insertAdjacentHTML(
      'afterend',
      html`<div class="cqa-banner">Открыта не последняя оценка диалога (${ev.checklist_id}). <a href="#/c/${encodeURIComponent(id)}">Перейти к последней</a></div>`,
    );
  }
  $('#run').onclick = async () => {
    const btn = $('#run');
    btn.disabled = true;
    btn.textContent = 'Оцениваю… (до пары минут)';
    try {
      await api.evaluate(conv.conversation_id, state.checklistId, $('#src')?.value || 'auto');
      toast('Оценка готова');
      renderCard(el, id);
    } catch (e) {
      toast(`Оценка не удалась: ${e.message}`, 'error');
      $('#eval-error')?.remove();
      $('#result').insertAdjacentHTML('afterbegin', html`<div class="cqa-banner cqa-banner--error" id="eval-error">Оценка не удалась: ${e.message}. Попробуйте ещё раз — бесплатный Gemini бывает перегружен.</div>`);
      btn.disabled = false;
      btn.textContent = ev ? 'Переоценить' : 'Оценить';
    }
  };
  $('#asr')?.addEventListener('click', async (e) => {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = 'Распознаю… (до пары минут)';
    try {
      const tr = await api.transcribe(conv.conversation_id);
      toast(`Распознано реплик: ${tr.transcript.length} (${tr.languages.join(', ')}). Нажмите «Переоценить», чтобы оценить по новому транскрипту.`);
      renderCard(el, id, ev?.id || null);
    } catch (err) {
      toast(`Распознавание не удалось: ${err.message}`, 'error');
      btn.disabled = false;
      btn.textContent = conv.asr ? 'Распознать заново' : 'Распознать запись (Gemini)';
    }
  });

  const audio = $('#audio');
  $('#transcript').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-seek]');
    if (!btn || !audio) return;
    seekAudio(audio, Number(btn.dataset.seek), true);
    audio.scrollIntoView({ block: 'nearest' });
  });
  audio?.addEventListener('timeupdate', () => markPlaying(audio.currentTime));

  drawTranscript();
  const evalTranscript = views.find((v) => v.key === evalKey)?.transcript || conv.transcript;
  drawResult(el, { ...conv, transcript: evalTranscript }, ev);
}

function drawTranscript() {
  const { el, conv, views, evalKey, view } = ctx;
  const current = views.find((v) => v.key === view) || views[0];
  const tabs = el.querySelector('#tabs');
  tabs.hidden = views.length < 2;
  tabs.innerHTML = views
    .map((v) => html`<button class="cqa-tab ${v.key === view ? 'is-active' : ''}" data-view="${v.key}">${v.label}${v.key === evalKey ? raw(' <span class="cqa-badge">оценка</span>') : ''}</button>`)
    .join('');
  tabs.querySelectorAll('[data-view]').forEach((b) =>
    b.addEventListener('click', () => {
      ctx.view = b.dataset.view;
      drawTranscript();
    }),
  );
  const note = evalKey && view !== evalKey
    ? html`<div class="cqa-banner cqa-banner--inline">Оценка ссылается на другой транскрипт — ссылки [n] в результате переключат вкладку.</div>`
    : '';
  el.querySelector('#transcript').innerHTML = note + current.transcript.map((m) => html`
    <div class="cqa-msg cqa-msg--${m.speaker}" id="cqa-m-${m.idx}" data-idx="${m.idx}" data-t="${m.t ?? ''}">
      <div class="cqa-msg-meta"><span class="cqa-idx">[${m.idx}]</span> ${speakerLabel[m.speaker] || m.speaker} · ${shortTs(m.timestamp)}${m.language ? raw(` · <span class="cqa-lang">${esc(m.language)}</span>`) : ''}</div>
      ${conv.has_audio && m.t != null ? raw(html`<button class="cqa-time" data-seek="${m.t}" title="Перейти к этому месту записи и воспроизвести">▶ ${fmtSec(m.t)}</button>`) : ''}
      <div class="cqa-msg-text">${m.text}</div>
    </div>`).join('');
}

function markPlaying(time) {
  const msgs = [...ctx.el.querySelectorAll('#transcript .cqa-msg')].filter((m) => m.dataset.t !== '');
  let current = null;
  for (const m of msgs) if (Number(m.dataset.t) <= time + 0.25) current = m;
  if (current?.classList.contains('is-playing')) return;
  ctx.el.querySelectorAll('.cqa-msg.is-playing').forEach((m) => m.classList.remove('is-playing'));
  current?.classList.add('is-playing');
}

function focusMessages(el, ids, { range = null, seek = true } = {}) {
  if (ctx?.evalKey && ctx.view !== ctx.evalKey) {
    ctx.view = ctx.evalKey;
    drawTranscript();
  }
  el.querySelectorAll('.cqa-msg.is-hl, .cqa-msg.is-range').forEach((m) => m.classList.remove('is-hl', 'is-range'));
  if (range) {
    for (let i = range[0]; i <= range[1]; i++) el.querySelector(`#cqa-m-${i}`)?.classList.add('is-range');
  }
  ids.forEach((i) => el.querySelector(`#cqa-m-${i}`)?.classList.add('is-hl'));
  const first = el.querySelector(`#cqa-m-${ids[0] ?? range?.[0]}`);
  first?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const audio = el.querySelector('#audio');
  if (seek && audio && first?.dataset.t) seekAudio(audio, Number(first.dataset.t), false);
}

function seekAudio(audio, t, play) {
  const go = () => {
    audio.currentTime = t;
    if (play) audio.play().catch(() => toast('Не удалось воспроизвести запись', 'error'));
  };
  if (audio.readyState >= 1) return go();
  audio.addEventListener('loadedmetadata', go, { once: true });
  audio.load();
}

function drawResult(el, conv, ev) {
  const box = el.querySelector('#result');
  if (!ev) {
    box.innerHTML = html`<div class="cqa-empty">Диалог ещё не оценён. Выберите чек-лист и нажмите «Оценить».</div>`;
    return;
  }
  const cl = ev.checklist;
  const fin = ev.final;
  const org = ev.original;
  const changed = org.final_total !== fin.final_total;
  const secTitle = Object.fromEntries((cl.sections || []).map((s) => [s.id, s.title]));

  box.innerHTML = html`
    <div class="cqa-summary">
      <div class="cqa-total">
        <div class="cqa-total-label">Итоговый балл</div>
        <div class="cqa-total-value ${scoreClass(fin.final_total)}">${fmtScore(fin.final_total)}</div>
        ${changed ? raw(html`<div class="cqa-muted">исходная оценка: <s>${fmtScore(org.final_total)}</s> → после апелляций: ${fmtScore(fin.final_total)}</div>`) : ''}
        ${fin.critical_error ? raw(html`<div class="cqa-badge cqa-badge--crit">Грубая ошибка: ${fin.criteria
          .filter((r) => fin.critical_criteria.includes(r.criterion_id))
          .map((r) => r.critical_reason || r.explanation || cl.criteria.find((x) => x.id === r.criterion_id)?.title || r.criterion_id)
          .join('; ')}</div>`) : ''}
        ${fin.critical_error && cl.critical_policy === 'zero_total' ? raw('<div class="cqa-muted">По правилу чек-листа грубая ошибка обнуляет итог</div>') : ''}
      </div>
      <div class="cqa-sections">
        ${fin.sections.filter((s) => s.applicable_weight > 0 || s.score !== null).map((s) => raw(html`<div class="cqa-section-score"><span>${s.title}</span><b class="${scoreClass(s.score)}">${fmtScore(s.score)}</b></div>`))}
      </div>
    </div>
    <p class="cqa-summary-text">${ev.summary || ''}</p>
    <div class="cqa-muted cqa-meta-line">Чек-лист ${cl.name} v${cl.version} · ${new Date(ev.created_at).toLocaleString('ru-RU')} · округление: ${cl.rounding.decimals} зн.</div>
    ${raw(modelsBlock(conv, ev))}
    ${fin.warnings.length ? raw(html`<div class="cqa-banner">${fin.warnings.join('; ')}</div>`) : ''}
    <div class="cqa-criteria">
      ${cl.criteria.map((c) => {
        const row = fin.criteria.find((r) => r.criterion_id === c.id);
        const orig = org.criteria.find((r) => r.criterion_id === c.id);
        const appeals = ev.appeals.filter((a) => a.criterion_id === c.id);
        return raw(criterionCard(c, row, orig, appeals, conv, secTitle));
      })}
    </div>`;

  box.querySelectorAll('[data-ev]').forEach((b) =>
    b.addEventListener('click', () => focusMessages(el, b.dataset.ev.split(',').map(Number))),
  );
  box.querySelectorAll('[data-range]').forEach((b) =>
    b.addEventListener('click', () => {
      const [a, z] = b.dataset.range.split('-').map(Number);
      focusMessages(el, [], { range: [a, z] });
    }),
  );
  box.querySelectorAll('[data-appeal]').forEach((b) =>
    b.addEventListener('click', () => openAppealForm(el, conv, ev, b.dataset.appeal)),
  );
  box.querySelectorAll('[data-decide]').forEach((b) =>
    b.addEventListener('click', () => openDecisionForm(el, conv, ev, b.dataset.decide)),
  );
}

function criterionCard(c, row, orig, appeals, conv, secTitle) {
  const open = appeals.find((a) => a.status === 'open');
  const evIds = row?.evidence_ids || [];
  const msgById = (i) => conv.transcript[i];
  const answer = fmtAnswer(c, row);
  const weightNote = row?.na ? 'вес перераспределён' : `${row?.effective_weight?.toFixed(1) ?? c.weight}% итога`;
  const isFlag = c.type === 'flag';
  const stepLabel = c.type === 'scale' && !row?.na ? c.scale.steps?.find((st) => st.value === Number(row?.value))?.label : null;
  const tone = row?.na ? 'na' : isFlag ? (Number(row?.value) >= 1 ? 'bad' : 'ok') : row?.normalized === 1 ? 'ok' : row?.normalized === 0 ? 'bad' : 'mid';
  return html`
  <article class="cqa-crit ${row?.na ? 'is-na' : ''} ${row?.critical_error ? 'is-crit' : ''}" id="crit-${c.id}">
    <header>
      <div>
        <div class="cqa-crit-title">${c.title}</div>
        <div class="cqa-muted">${c.section ? secTitle[c.section] || c.section : ''} · ${isFlag ? 'без баллов' : `вес ${c.weight} (${weightNote})`} · ${typeLabel(c)}</div>
      </div>
      <div class="cqa-crit-score">
        <div class="cqa-answer cqa-answer--${tone}">${answer}</div>
        <div class="cqa-muted">${row?.na || isFlag ? '—' : `${row?.points ?? 0} / ${row?.max_points ?? c.weight} б.`}</div>
      </div>
    </header>
    ${row?.overridden ? raw(html`<div class="cqa-override">Изменено проверяющим: было «${fmtAnswer(c, { value: row.original_value, na: row.original_na })}», стало «${answer}». Причина: ${row.override_reason || ''}</div>`) : ''}
    ${stepLabel ? raw(html`<p class="cqa-step"><b>Ступень ${row.value}:</b> ${stepLabel}</p>`) : ''}
    <p class="cqa-expl">${orig?.explanation || 'Нет обоснования'}</p>
    ${row?.na && row?.na_reason ? raw(html`<p class="cqa-na-reason"><b>Причина N/A:</b> ${row.na_reason}</p>`) : ''}
    ${row?.critical_error && row.critical_reason ? raw(html`<p class="cqa-crit-reason"><b>Грубая ошибка:</b> ${row.critical_reason}</p>`) : ''}
    ${row?.warnings?.length ? raw(html`<p class="cqa-warn">${row.warnings.join('; ')}</p>`) : ''}
    <div class="cqa-evidence">
      ${evIds.length
        ? raw(html`<span class="cqa-muted">Доказательства:</span> ${evIds.map((i) => raw(html`<button class="cqa-ev" data-ev="${i}" title="${msgById(i)?.text || ''}">[${i}] ${speakerLabel[msgById(i)?.speaker] || ''} ${shortTs(msgById(i)?.timestamp || '')}</button>`))}
            ${evIds.length > 1 ? raw(html`<button class="cqa-ev cqa-ev--all" data-ev="${evIds.join(',')}">показать все</button>`) : ''}`)
        : ''}
      ${row?.checked_from != null && row?.checked_to != null
        ? raw(html`<button class="cqa-ev cqa-ev--range" data-range="${row.checked_from}-${row.checked_to}">Проверенный участок [${row.checked_from}]–[${row.checked_to}]</button>`)
        : ''}
    </div>
    ${evIds[0] != null ? raw(html`<blockquote class="cqa-quote">«${msgById(evIds[0])?.text || ''}»</blockquote>`) : ''}
    <footer>
      ${appeals.map((a) => raw(appealLine(a, c)))}
      ${!open && state.role === 'qa' ? raw(html`<button class="cqa-btn cqa-btn--sm" data-appeal="${c.id}">Оспорить</button>`) : ''}
      ${open && state.role === 'reviewer' ? raw(html`<button class="cqa-btn cqa-btn--sm cqa-btn--primary" data-decide="${open.id}">Рассмотреть апелляцию</button>`) : ''}
      ${open && state.role === 'qa' ? raw('<span class="cqa-muted">Апелляция на рассмотрении. Переключите роль на «Проверяющий», чтобы принять решение.</span>') : ''}
      <div class="cqa-form-slot" id="slot-${c.id}"></div>
    </footer>
  </article>`;
}

function modelsBlock(conv, ev) {
  const dt = (s) => (s ? new Date(s).toLocaleString('ru-RU') : '');
  const provider = /^claude/.test(ev.model) ? 'Anthropic Claude' : /^gemini/.test(ev.model) ? 'Google Gemini' : '';
  const rows = [
    html`<div><b>Оценка по чек-листу:</b> <code>${ev.model}</code>${provider ? ` (${provider})` : ''}</div>`,
  ];
  const votes = ev.usage?.votes;
  if (votes > 1) {
    const voted = (ev.criteria || []).filter((r) => r.votes);
    const unanimous = voted.filter((r) => r.votes.agree === r.votes.total).length;
    rows.push(html`<div><b>Прогонов модели:</b> ${ev.usage.votes_ok ?? votes} из ${votes} · ответ по большинству · полное согласие по ${unanimous} из ${voted.length} критериев</div>`);
  }
  if (conv.has_audio) {
    const tm = ev.transcript_meta;
    rows.push(tm
      ? html`<div><b>Распознавание записи:</b> <code>${tm.model}</code> (Google Gemini) · ${dt(tm.created_at)}${tm.languages?.length ? ` · языки: ${tm.languages.join(', ')}` : ''}</div>`
      : html`<div><b>Распознавание записи:</b> не использовалось — модель получила транскрипт организаторов</div>`);
    rows.push(html`<div><b>Транскрипт для оценки:</b> ${tm ? 'распознавание Gemini (основной) + транскрипт организаторов (сверка)' : 'транскрипт организаторов'}</div>`);
    if (conv.asr && conv.asr.id !== ev.transcript_id) {
      rows.push(html`<div class="cqa-warn">Есть более новое распознавание: <code>${conv.asr.model}</code> от ${dt(conv.asr.created_at)}. Чтобы оценить по нему, нажмите «Переоценить».</div>`);
    }
  } else {
    rows.push(html`<div><b>Транскрипт для оценки:</b> исходная переписка чата</div>`);
  }
  return html`<details class="cqa-models" open><summary>Модели</summary>${raw(rows.join(''))}</details>`;
}

function appealLine(a, c) {
  const st = { open: 'На рассмотрении', confirmed: 'Оценка подтверждена', changed: 'Оценка изменена' }[a.status];
  return html`<div class="cqa-appeal cqa-appeal--${a.status}">
    <div><b>Апелляция</b> · ${st} · ${new Date(a.created_at).toLocaleString('ru-RU')}</div>
    <div>Комментарий: ${a.comment}</div>
    ${a.decision ? raw(html`<div>Решение: ${a.decision.decision === 'confirm' ? 'подтвердить' : `изменить на «${fmtAnswer(c, a.decision)}»`}. Причина: ${a.decision.reason.replace(/[.\s]+$/, '')}. Итог: ${fmtScore(a.total_before)} → ${fmtScore(a.total_after)}</div>`) : ''}
  </div>`;
}

function openAppealForm(el, conv, ev, criterionId) {
  const slot = el.querySelector(`#slot-${criterionId}`);
  slot.innerHTML = html`<div class="cqa-form">
    <label>Почему вы не согласны с оценкой?</label>
    <textarea rows="3" placeholder="Например: оператор представился в реплике [9]"></textarea>
    <div class="cqa-row"><button class="cqa-btn cqa-btn--primary" data-act="send">Подать апелляцию</button><button class="cqa-btn" data-act="cancel">Отмена</button></div>
  </div>`;
  slot.querySelector('textarea').focus();
  slot.querySelector('[data-act=cancel]').onclick = () => (slot.innerHTML = '');
  slot.querySelector('[data-act=send]').onclick = async (e) => {
    e.target.disabled = true;
    try {
      await api.createAppeal({ evaluation_id: ev.id, criterion_id: criterionId, comment: slot.querySelector('textarea').value });
      toast('Апелляция сохранена');
      renderCard(el, conv.conversation_id, ev.id);
    } catch (err) {
      toast(err.message, 'error');
      e.target.disabled = false;
    }
  };
}

function openDecisionForm(el, conv, ev, appealId) {
  const ap = ev.appeals.find((a) => a.id === appealId);
  const c = ev.checklist.criteria.find((x) => x.id === ap.criterion_id);
  const slot = el.querySelector(`#slot-${c.id}`);
  const options = c.type === 'binary'
    ? [[1, 'Да (выполнено)'], [0, 'Нет (не выполнено)']]
    : c.type === 'flag'
      ? [[0, 'Нет — нарушений нет'], [1, 'Да — грубая ошибка выявлена']]
      : scaleValues(c).slice().reverse().map((v) => [v, `${v}${c.scale.steps?.find((st) => st.value === v)?.label ? ` — ${c.scale.steps.find((st) => st.value === v).label}` : ''}`]);
  if (c.na_allowed) options.push(['na', 'N/A']);
  slot.innerHTML = html`<div class="cqa-form cqa-form--review">
    <div><b>Спорная оценка:</b> ${fmtAnswer(c, ap.disputed)} — ${ap.disputed?.explanation || ''}</div>
    <div><b>Комментарий:</b> ${ap.comment}</div>
    ${ap.disputed?.evidence_ids?.length ? raw(html`<button class="cqa-ev" data-ev2="${ap.disputed.evidence_ids.join(',')}">Показать фрагмент диалога</button>`) : ''}
    <div class="cqa-row">
      <label><input type="radio" name="dec" value="confirm" checked> Подтвердить оценку</label>
      <label><input type="radio" name="dec" value="change"> Изменить оценку</label>
    </div>
    <div class="cqa-row" data-change hidden>
      <label>Новое значение <select name="val">${options.map(([v, l]) => raw(`<option value="${v}">${esc(l)}</option>`))}</select></label>
      ${c.critical ? raw('<label><input type="checkbox" name="clear" checked> Снять грубую ошибку</label>') : ''}
    </div>
    <label>Причина решения</label>
    <textarea rows="2" name="reason"></textarea>
    <div class="cqa-row"><button class="cqa-btn cqa-btn--primary" data-act="save">Сохранить решение</button><button class="cqa-btn" data-act="cancel">Отмена</button></div>
  </div>`;
  slot.querySelector('[data-ev2]')?.addEventListener('click', (e) => focusMessages(el, e.target.dataset.ev2.split(',').map(Number)));
  slot.querySelectorAll('input[name=dec]').forEach((r) =>
    r.addEventListener('change', () => (slot.querySelector('[data-change]').hidden = slot.querySelector('input[name=dec]:checked').value !== 'change')),
  );
  slot.querySelector('[data-act=cancel]').onclick = () => (slot.innerHTML = '');
  slot.querySelector('[data-act=save]').onclick = async (ev0) => {
    const decision = slot.querySelector('input[name=dec]:checked').value;
    const v = slot.querySelector('select[name=val]').value;
    ev0.target.disabled = true;
    try {
      const r = await api.decideAppeal(ap.id, {
        decision,
        value: v === 'na' ? null : Number(v),
        na: v === 'na',
        clear_critical: Boolean(slot.querySelector('input[name=clear]')?.checked),
        reason: slot.querySelector('textarea[name=reason]').value,
      });
      toast(`Решение сохранено. Итог: ${fmtScore(r.total_before)} → ${fmtScore(r.total_after)}`);
      renderCard(el, conv.conversation_id, ev.id);
    } catch (e) {
      toast(e.message, 'error');
      ev0.target.disabled = false;
    }
  };
}
