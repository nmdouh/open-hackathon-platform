import { api } from '../api.js';
import { t, tList } from '../i18n.js';
import { h, pick, badge, emptyState, busy, field, formValues } from '../ui.js';
import { state } from '../state.js';
import { hackCtx, shell } from './shell.js';

// Built-in guides. Their text lives in i18n.js as arrays, so each
// deployment gets them in both languages without any setup.
const GUIDES = ['plan', 'pitch', 'responsible'];

function guideCard(key) {
  return h('details', { class: 'card guide' },
    h('summary', null, h('strong', null, t(`guide.${key}.title`)), ' — ', h('span', { class: 'muted' }, t(`guide.${key}.lead`))),
    h('ol', { class: 'steps' }, tList(`guide.${key}.steps`).map((s) => h('li', null, s))));
}

function feedbackView(result) {
  if (!result.feedback) return h('div', { class: 'card pre' }, result.text || '');
  const f = result.feedback;
  const list = (title, items) => (items.length ? h('div', null, h('h3', null, title), h('ul', null, items.map((x) => h('li', null, x)))) : null);
  return h('div', { class: 'card stack-sm' },
    h('h2', null, t('coach.feedback')),
    f.summary ? h('p', { class: 'pre' }, f.summary) : null,
    f.scores.length ? h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, t('coach.criterion')), h('th', { class: 'num' }, t('coach.score')), h('th', null, t('coach.reason')))),
      h('tbody', null, f.scores.map((s) => h('tr', null,
        h('td', null, s.criterion),
        h('td', { class: 'num nowrap' }, s.score === null ? '—' : `${s.score} / ${s.max}`),
        h('td', { class: 'small' }, s.reason)))))) : null,
    list(t('coach.strengths'), f.strengths),
    list(t('coach.improvements'), f.improvements),
    list(t('coach.questions'), f.judgeQuestions),
    h('p', { class: 'small muted' }, t('coach.disclaimer')));
}

function coachPanel(ctx) {
  const out = h('div');
  const form = h('form', { class: 'form card' },
    h('h2', null, t('coach.title')),
    h('p', { class: 'muted' }, t('coach.lead')),
    field(t('coach.mode'), h('select', { name: 'mode' },
      h('option', { value: 'idea' }, t('coach.mode.idea')), h('option', { value: 'pitch' }, t('coach.mode.pitch')))),
    field(t('coach.text'), h('textarea', { name: 'text', required: true, minlength: 40, maxlength: 8000, rows: 10 }), t('coach.privacy')),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'submit' }, t('coach.run'))));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('[type=submit]'), async () => {
      out.replaceChildren(h('p', { class: 'muted' }, t('coach.thinking')));
      const r = await api.post(`/hackathons/${ctx.h.id}/coach`, { ...formValues(form), locale: document.documentElement.lang });
      out.replaceChildren(feedbackView(r));
    }).then(() => { if (out.textContent === t('coach.thinking')) out.replaceChildren(); });
  });
  return h('div', { class: 'stack' }, form, out);
}

export async function toolboxView({ slug }) {
  const ctx = await hackCtx(slug);
  const { resources } = await api.get(`/hackathons/${ctx.h.id}/resources`);
  return shell(ctx, 'toolbox',
    h('p', { class: 'muted' }, t('toolbox.lead')),
    h('div', { class: 'grid-2' },
      h('div', { class: 'stack' },
        h('h2', null, t('toolbox.guides')),
        GUIDES.map(guideCard),
        h('h2', { class: 'section-title' }, t('toolbox.resources')),
        resources.length ? resources.map((r) => h('article', { class: 'card stack-sm' },
          h('div', { class: 'row row--between' },
            /^https?:\/\//i.test(r.url) || r.url.startsWith('/')
              ? h('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer' }, pick(r, 'title')) : pick(r, 'title'),
            badge(t(`resource.${r.category}`))),
          pick(r, 'description') ? h('p', { class: 'small muted pre' }, pick(r, 'description')) : null))
          : emptyState(t('toolbox.noResources'))),
      h('div', { class: 'stack' },
        state.config.aiEnabled ? coachPanel(ctx) : h('div', { class: 'notice' }, t('coach.disabled')))));
}
