import { api } from './api.js';
import { html, raw, store, toast } from './util.js';
import { renderList } from './views/list.js';
import { renderCard } from './views/card.js';
import { renderChecklists } from './views/checklists.js';
import { renderAppeals } from './views/appeals.js';

const root = document.getElementById('cqa-app');

export const state = {
  role: store.get('role', 'qa'),
  group: store.get('group', 'DEV'),
  checklistId: store.get('checklistId', null),
  meta: null,
};
export function setState(patch) {
  Object.assign(state, patch);
  for (const k of ['role', 'group', 'checklistId']) if (k in patch) store.set(k, state[k]);
}

const routes = [
  [/^#\/c\/([^/]+)\/e\/([^/]+)$/, (m, el) => renderCard(el, decodeURIComponent(m[1]), decodeURIComponent(m[2]))],
  [/^#\/c\/([^/]+)$/, (m, el) => renderCard(el, decodeURIComponent(m[1]))],
  [/^#\/checklists(?:\/(.+))?$/, (m, el) => renderChecklists(el, m[1] ? decodeURIComponent(m[1]) : null)],
  [/^#\/appeals$/, (_m, el) => renderAppeals(el)],
  [/^.*$/, (_m, el) => renderList(el)],
];

function shell() {
  const hash = location.hash || '#/';
  const tab = hash.startsWith('#/checklists') ? 'cl' : hash.startsWith('#/appeals') ? 'ap' : 'list';
  root.innerHTML = html`
    <header class="cqa-header">
      <a class="cqa-brand" href="#/" style="text-decoration:none">
        <img class="cqa-logo" src="img/freedom-logo.png" alt="Freedom Broker" width="34" height="34">
        <span class="cqa-wordmark"><b>freedom</b><small>broker</small></span>
        <span class="cqa-product"><b>CQA</b> · оценка качества диалогов</span>
      </a>
      <nav class="cqa-nav">
        <a href="#/" class="${tab === 'list' ? 'is-active' : ''}">Диалоги</a>
        <a href="#/checklists" class="${tab === 'cl' ? 'is-active' : ''}">Чек-листы</a>
        <a href="#/appeals" class="${tab === 'ap' ? 'is-active' : ''}">Апелляции</a>
      </nav>
      <label class="cqa-role" title="Демонстрация ролей без авторизации">
        Роль:
        <select id="cqa-role">
          <option value="qa" ${state.role === 'qa' ? 'selected' : ''}>Оператор / супервайзер</option>
          <option value="reviewer" ${state.role === 'reviewer' ? 'selected' : ''}>Проверяющий</option>
        </select>
      </label>
    </header>
    ${state.meta && !state.meta.has_key ? raw('<div class="cqa-banner">Не задан ключ модели (GEMINI_API_KEY или ANTHROPIC_API_KEY) — оценка недоступна. Добавьте ключ в файл .env и перезапустите сервер.</div>') : ''}
    <main id="cqa-main" class="cqa-main"></main>
    <footer class="cqa-footer">
      <div class="cqa-footer-inner">
        <img class="cqa-logo" src="img/freedom-logo.png" alt="Freedom Broker" width="34" height="34">
        <span><b>Freedom Broker · CQA</b> — прототип оценки качества диалогов операторов</span>
        <span class="cqa-spacer"></span>
        <span>Оценка по «Чек-листу качества чатов» · RU · KZ · EN</span>
      </div>
    </footer>`;
  root.querySelector('#cqa-role').addEventListener('change', (e) => {
    setState({ role: e.target.value });
    route();
  });
  return root.querySelector('#cqa-main');
}

export async function route() {
  const el = shell();
  const hash = location.hash || '#/';
  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (m) {
      try {
        await fn(m, el);
      } catch (e) {
        console.error(e);
        el.innerHTML = html`<div class="cqa-empty cqa-empty--error">Ошибка: ${e.message}</div>`;
      }
      return;
    }
  }
}

window.addEventListener('hashchange', route);
(async () => {
  try {
    state.meta = await api.meta();
  } catch (e) {
    toast(`Сервер недоступен: ${e.message}`, 'error');
  }
  route();
})();
