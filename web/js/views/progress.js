import { api, enc } from '../api.js';
import { t } from '../i18n.js';
import { h, badge, emptyState, busy, toast, field, formValues, fmtRelative, fmtDate, safeLink, confirmDialog, fmtNum } from '../ui.js';
import { state } from '../state.js';
import { refresh } from '../app.js';
import { hackCtx, shell } from './shell.js';

const KINDS = ['update', 'blocker', 'demo', 'help'];
const KIND_BADGE = { update: '', blocker: 'danger', demo: 'ok', help: 'warn' };

function composer(ctx) {
  const form = h('form', { class: 'form card' },
    h('h2', null, t('progress.postTitle')),
    h('div', { class: 'row' },
      field(t('progress.kind'), h('select', { name: 'kind' }, KINDS.map((k) => h('option', { value: k }, t(`progress.kind.${k}`))))),
      field(t('progress.visibility'), h('select', { name: 'visibility' },
        h('option', { value: 'public' }, t('progress.public')), h('option', { value: 'team' }, t('progress.teamOnly'))))),
    field(t('progress.body'), h('textarea', { name: 'body', required: true, maxlength: 2000, placeholder: t('progress.bodyPlaceholder') })),
    field(t('progress.link'), h('input', { type: 'url', name: 'linkUrl', placeholder: 'https://' })),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'submit' }, t('progress.post'))));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('[type=submit]'), async () => {
      await api.post(`/teams/${ctx.teamId}/progress`, formValues(form));
      toast(t('progress.posted'));
      refresh();
    });
  });
  return form;
}

function postCard(ctx, p) {
  const replies = h('div', { class: 'replies hidden' });
  const toggle = h('button', {
    class: 'btn btn--ghost btn--small',
    onclick: (e) => busy(e.target, async () => {
      if (!replies.classList.contains('hidden')) { replies.classList.add('hidden'); return; }
      const { replies: list } = await api.get(`/progress/${p.id}/replies`);
      const form = h('form', { class: 'row' },
        h('input', { type: 'text', name: 'body', required: true, maxlength: 2000, placeholder: t('progress.replyPlaceholder'), 'aria-label': t('progress.reply') }),
        h('button', { class: 'btn btn--small', type: 'submit' }, t('progress.reply')));
      form.addEventListener('submit', (ev) => {
        ev.preventDefault();
        busy(form.querySelector('[type=submit]'), async () => { await api.post(`/progress/${p.id}/replies`, formValues(form)); refresh(); });
      });
      replies.replaceChildren(
        ...list.map((r) => h('div', { class: 'stack-sm' }, h('div', { class: 'post__meta' }, h('strong', null, r.authorName), fmtRelative(r.createdAt)), h('p', { class: 'pre' }, r.body))),
        form);
      replies.classList.remove('hidden');
    }),
  }, t('progress.replies', { n: p.replyCount }));
  const ownTeam = ctx.teamId === p.teamId;
  return h('article', { class: `card post post--${p.kind}` },
    h('div', { class: 'post__meta' },
      badge(t(`progress.kind.${p.kind}`), KIND_BADGE[p.kind]),
      h('strong', null, p.teamName), '·', p.authorName, '·',
      h('time', { datetime: p.createdAt, title: fmtDate(p.createdAt) }, fmtRelative(p.createdAt)),
      p.visibility === 'team' ? badge(t('progress.teamOnly')) : null,
      p.kind === 'help' ? badge(p.resolved ? t('progress.resolved') : t('progress.open'), p.resolved ? 'ok' : 'warn') : null),
    h('p', { class: 'pre' }, p.body),
    p.linkUrl ? h('p', null, safeLink(p.linkUrl)) : null,
    h('div', { class: 'row' },
      toggle,
      p.kind === 'help' && (ownTeam || ctx.admin) ? h('button', {
        class: 'btn btn--ghost btn--small',
        onclick: (e) => busy(e.target, async () => { await api.post(`/progress/${p.id}/resolve`, { resolved: !p.resolved }); refresh(); }),
      }, p.resolved ? t('progress.reopen') : t('progress.markResolved')) : null,
      p.authorId === state.user.id || ctx.admin ? h('button', {
        class: 'btn btn--ghost btn--small',
        onclick: async (e) => {
          if (!(await confirmDialog(t('progress.deleteConfirm'), { danger: true }))) return;
          busy(e.target, async () => { await api.del(`/progress/${p.id}`); refresh(); });
        },
      }, t('common.delete')) : null),
    replies);
}

function pulsePanel(pulse) {
  const max = Math.max(1, ...pulse.daily.map((d) => d.posts));
  const quiet = pulse.teams.filter((x) => x.quiet);
  return h('section', { class: 'card stack-sm' },
    h('h2', null, t('pulse.title')),
    h('div', { class: 'bars', role: 'img', 'aria-label': t('pulse.chartLabel') },
      pulse.daily.map((d) => {
        const bar = h('div', { title: `${fmtDate(d.day, false)}: ${d.posts}` });
        bar.style.height = `${Math.round((d.posts / max) * 100)}%`;
        return bar;
      })),
    h('div', { class: 'bars-labels' }, pulse.daily.map((d, i) => h('span', null, i % 3 === 0 ? new Date(d.day).getDate() : ''))),
    quiet.length ? h('div', { class: 'notice notice--warn' }, t('pulse.quiet', { n: quiet.length })) : null,
    h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null,
        h('th', null, t('team.team')), h('th', null, t('pulse.lastPost')), h('th', { class: 'num' }, t('pulse.posts7d')),
        h('th', { class: 'num' }, t('pulse.activeDays')), h('th', { class: 'num' }, t('pulse.openHelp')))),
      h('tbody', null, pulse.teams.map((x) => h('tr', null,
        h('td', null, x.name, ' ', x.quiet ? badge(t('pulse.quietBadge'), 'warn') : null),
        h('td', { class: 'small nowrap' }, x.lastPostAt ? fmtRelative(x.lastPostAt) : t('pulse.never')),
        h('td', { class: 'num' }, fmtNum(x.posts7d, 0)),
        h('td', { class: 'num' }, fmtNum(x.activeDays, 0)),
        h('td', { class: 'num' }, fmtNum(x.openHelp, 0))))))));
}

export async function progressView({ slug, query }) {
  const ctx = await hackCtx(slug);
  const kind = query.get('kind') || '';
  const [feed, pulse] = await Promise.all([
    api.get(`/hackathons/${ctx.h.id}/progress${kind ? `?kind=${enc(kind)}` : ''}`),
    ctx.admin || ctx.mentoring.isMentor ? api.get(`/hackathons/${ctx.h.id}/pulse`) : null,
  ]);
  const base = `#/h/${enc(slug)}/progress`;
  return shell(ctx, 'progress',
    h('p', { class: 'muted' }, t('progress.lead')),
    h('div', { class: 'grid-2' },
      h('div', { class: 'stack' },
        h('nav', { class: 'row', 'aria-label': t('progress.filter') },
          h('a', { class: `btn btn--small ${kind ? 'btn--secondary' : ''}`, href: base }, t('common.all')),
          KINDS.map((k) => h('a', { class: `btn btn--small ${kind === k ? '' : 'btn--secondary'}`, href: `${base}?kind=${k}` }, t(`progress.kind.${k}`)))),
        feed.posts.length ? feed.posts.map((p) => postCard(ctx, p)) : emptyState(t('progress.none'))),
      h('div', { class: 'stack' },
        ctx.teamId ? composer(ctx) : h('div', { class: 'notice' }, t('progress.joinToPost')),
        pulse ? pulsePanel(pulse) : null)));
}
