import { api } from '../api.js';
import { html, raw, fmtScore } from '../util.js';
import { state } from '../app.js';

const STATUS = { open: 'На рассмотрении', confirmed: 'Подтверждена оценка', changed: 'Оценка изменена' };

export async function renderAppeals(el) {
  const rows = await api.appeals();
  const open = rows.filter((a) => a.status === 'open');
  el.innerHTML = html`
    <div class="cqa-eyebrow">Открытый диалог</div>
    <h2>Апелляции</h2>
    <p class="cqa-muted">${state.role === 'reviewer'
      ? 'Откройте карточку диалога, изучите доказательства и примите решение по апелляции.'
      : 'Подать апелляцию можно в карточке диалога кнопкой «Оспорить» у критерия.'} Открытых: ${open.length}.</p>
    ${rows.length
      ? raw(html`<div class="cqa-table-wrap"><table class="cqa-table">
        <thead><tr><th>Создана</th><th>Диалог / оценка</th><th>Критерий</th><th>Комментарий</th><th>Статус</th><th>Итог</th></tr></thead>
        <tbody>${rows.map((a) => raw(html`<tr>
          <td>${new Date(a.created_at).toLocaleString('ru-RU')}</td>
          <td><a href="#/c/${encodeURIComponent(a.conversation_id)}/e/${encodeURIComponent(a.evaluation_id)}">${a.conversation_id}</a><div class="cqa-muted">${a.checklist_id || a.evaluation_id}</div></td>
          <td>${a.criterion_title || a.criterion_id}</td>
          <td>${a.comment}</td>
          <td><span class="cqa-badge ${a.status === 'open' ? '' : 'cqa-badge--done'}">${STATUS[a.status]}</span></td>
          <td>${a.status === 'open' ? '' : `${fmtScore(a.total_before)} → ${fmtScore(a.total_after)}`}</td>
        </tr>`))}</tbody></table></div>`)
      : raw('<div class="cqa-empty">Апелляций пока нет</div>')}`;
}
