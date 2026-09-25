import { api, enc } from '../api.js';
import { t, tList } from '../i18n.js';
import { h, pick, badge, emptyState, busy, field, formValues, toast } from '../ui.js';
import { state } from '../state.js';
import { hackCtx, shell } from './shell.js';

const TABS = ['guides', 'prompts', 'timer', 'coach', 'resources'];

// ---------------------------------------------------------------- guides
function guideCard(key, open) {
  return h('details', { class: 'card guide', open },
    h('summary', null, h('strong', null, t(`guide.${key}.title`)), ' — ', h('span', { class: 'muted' }, t(`guide.${key}.lead`))),
    h('ol', { class: 'steps' }, tList(`guide.${key}.steps`).map((s) => h('li', null, s))));
}

function guidesTab() {
  return h('div', { class: 'stack' }, ['plan', 'pitch', 'responsible'].map((k, i) => guideCard(k, i === 0)));
}

// ---------------------------------------------------------------- prompt library
function promptsTab() {
  const items = tList('prompts.items');
  const cats = [...new Set(items.map((p) => p.cat))];
  const list = h('div', { class: 'grid' });
  const filter = h('div', { class: 'segmented', role: 'tablist' });
  let active = '';
  const draw = () => {
    filter.replaceChildren(...['', ...cats].map((c) => h('a', {
      href: '#', role: 'tab', 'aria-current': c === active ? 'page' : null,
      onclick: (e) => { e.preventDefault(); active = c; draw(); },
    }, c ? t(`prompts.cat.${c}`) : t('common.all'))));
    list.replaceChildren(...items.filter((p) => !active || p.cat === active).map((p) => h('article', { class: 'card prompt stack-sm' },
      h('div', { class: 'row row--between' }, h('strong', null, p.title), badge(t(`prompts.cat.${p.cat}`))),
      h('pre', null, p.body),
      h('button', {
        class: 'btn btn--secondary btn--small', type: 'button',
        onclick: async () => {
          try { await navigator.clipboard.writeText(p.body); toast(t('prompts.copied')); } catch { toast(t('prompts.copyFailed'), 'error'); }
        },
      }, t('prompts.copy')))));
  };
  draw();
  return h('div', { class: 'stack' }, h('p', { class: 'muted' }, t('prompts.lead')), filter, list);
}

// ---------------------------------------------------------------- pitch timer
// Segment shares of the total time; a 5-minute pitch gives 45 s, 45 s,
// 2 min, 1 min and a 30 s safety margin.
const SEGMENTS = [['problem', 0.15], ['how', 0.15], ['demo', 0.4], ['impact', 0.2], ['margin', 0.1]];

function timerTab() {
  let totalSec = 300;
  let elapsed = 0;
  let startedAt = null;
  let interval = null;
  const clock = h('div', { class: 'timer__clock', role: 'timer', 'aria-live': 'off' }, '5:00');
  const segLabel = h('div', { class: 'timer__segment' });
  const segHint = h('div', { class: 'muted small' });
  const bar = h('div', { class: 'timer__bar', 'aria-hidden': 'true' });
  const startBtn = h('button', { class: 'btn', type: 'button' }, t('timer.start'));
  const plan = h('ol', { class: 'small' });
  const minutes = h('select', { 'aria-label': t('timer.length') }, [3, 5, 7, 10].map((m) => h('option', { value: m, selected: m === 5 }, t('timer.minutes', { n: m }))));

  const fmt = (s) => {
    const neg = s < 0;
    const a = Math.abs(Math.round(s));
    return `${neg ? '−' : ''}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`;
  };
  const bounds = () => {
    let acc = 0;
    return SEGMENTS.map(([key, share]) => { const start = acc; acc += share * totalSec; return { key, start, end: acc }; });
  };
  const now = () => elapsed + (startedAt ? (Date.now() - startedAt) / 1000 : 0);
  const draw = () => {
    const e = now();
    const left = totalSec - e;
    clock.textContent = fmt(left);
    clock.className = `timer__clock${left < 0 ? ' is-over' : left < 30 ? ' is-warn' : ''}`;
    const b = bounds();
    const cur = b.find((s) => e < s.end) || null;
    segLabel.textContent = cur ? t(`timer.seg.${cur.key}`) : t('timer.overtime');
    segHint.textContent = cur ? `${t(`timer.hint.${cur.key}`)} · ${fmt(cur.end - e)}` : t('timer.questions');
    bar.replaceChildren(...b.map((s) => {
      const d = h('div', { class: e >= s.end ? 'is-done' : cur && cur.key === s.key ? 'is-now' : '', title: t(`timer.seg.${s.key}`) });
      d.style.width = `${((s.end - s.start) / totalSec) * 100}%`;
      return d;
    }));
    plan.replaceChildren(...b.map((s) => h('li', null, `${t(`timer.seg.${s.key}`)} — ${fmt(s.end - s.start)}`)));
  };
  const stop = () => { if (interval) clearInterval(interval); interval = null; };
  startBtn.addEventListener('click', () => {
    if (startedAt) {
      elapsed = now(); startedAt = null; stop(); startBtn.textContent = t('timer.resume');
    } else {
      startedAt = Date.now(); startBtn.textContent = t('timer.pause');
      interval = setInterval(() => { if (!clock.isConnected) { stop(); return; } draw(); }, 250);
    }
    draw();
  });
  const reset = h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => { stop(); elapsed = 0; startedAt = null; startBtn.textContent = t('timer.start'); draw(); } }, t('timer.reset'));
  minutes.addEventListener('change', () => { totalSec = Number(minutes.value) * 60; reset.click(); });
  draw();
  return h('div', { class: 'grid-2' },
    h('section', { class: 'card timer stack-sm' },
      h('div', { class: 'row row--between' }, h('h2', null, t('timer.title')), minutes),
      segLabel, clock, segHint, bar,
      h('div', { class: 'row' }, startBtn, reset)),
    h('section', { class: 'card stack-sm' },
      h('h2', null, t('timer.planTitle')), plan,
      h('p', { class: 'small muted' }, t('timer.tip'))));
}

// ---------------------------------------------------------------- AI coach
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

function coachTab(ctx) {
  if (!state.config.aiEnabled) {
    return h('div', { class: 'notice' }, t('coach.disabled'),
      ctx.admin ? [' ', h('a', { href: '#/admin' }, t('coach.enableHere'))] : null);
  }
  const out = h('div');
  const idea = ctx.me && ctx.me.idea;
  const prefill = idea ? [idea.title, idea.problem, idea.solution, idea.targetUsers, idea.expectedImpact].filter(Boolean).join('\n\n') : '';
  const form = h('form', { class: 'form card' },
    h('h2', null, t('coach.title')),
    h('p', { class: 'muted' }, t('coach.lead')),
    field(t('coach.mode'), h('select', { name: 'mode' },
      h('option', { value: 'idea' }, t('coach.mode.idea')), h('option', { value: 'pitch' }, t('coach.mode.pitch')))),
    field(t('coach.text'), h('textarea', { name: 'text', required: true, minlength: 40, maxlength: 8000, rows: 10, value: prefill }),
      prefill ? t('coach.prefilled') : t('coach.privacy')),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'submit' }, t('coach.run'))));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('[type=submit]'), async () => {
      out.replaceChildren(h('p', { class: 'muted' }, t('coach.thinking')));
      try {
        const r = await api.post(`/hackathons/${ctx.h.id}/coach`, { ...formValues(form), locale: document.documentElement.lang });
        out.replaceChildren(feedbackView(r));
      } catch (err) {
        out.replaceChildren();
        throw err;
      }
    });
  });
  return h('div', { class: 'grid-2' }, form, out);
}

// ---------------------------------------------------------------- resources
async function resourcesTab(ctx) {
  const { resources } = await api.get(`/hackathons/${ctx.h.id}/resources`);
  if (!resources.length) return emptyState(t('toolbox.noResources'));
  return h('div', { class: 'grid' }, resources.map((r) => h('article', { class: 'card stack-sm' },
    h('div', { class: 'row row--between' },
      /^https?:\/\//i.test(r.url) || r.url.startsWith('/')
        ? h('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer' }, h('strong', null, pick(r, 'title'))) : pick(r, 'title'),
      badge(t(`resource.${r.category}`))),
    pick(r, 'description') ? h('p', { class: 'small muted pre' }, pick(r, 'description')) : null)));
}

export async function toolboxView({ slug, query }) {
  const ctx = await hackCtx(slug);
  const tab = TABS.includes(query.get('tab')) ? query.get('tab') : 'guides';
  const views = { guides: guidesTab, prompts: promptsTab, timer: timerTab, coach: () => coachTab(ctx), resources: () => resourcesTab(ctx) };
  return shell(ctx, 'toolbox',
    h('p', { class: 'muted' }, t('toolbox.lead')),
    h('nav', { class: 'segmented', 'aria-label': t('toolbox.sections') }, TABS.map((k) => h('a', {
      href: `#/h/${enc(slug)}/toolbox?tab=${k}`, 'aria-current': k === tab ? 'page' : null,
    }, t(`toolbox.tab.${k}`), k === 'coach' && state.config.aiEnabled ? ' ✦' : ''))),
    await views[tab]());
}
