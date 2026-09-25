import { api, enc } from '../api.js';
import { t } from '../i18n.js';
import { h, pick, fmtDate, badge, emptyState } from '../ui.js';
import { state } from '../state.js';
import { hackCtx, shell } from './shell.js';

function stageClass(s) {
  const now = Date.now();
  const start = s.startsAt ? new Date(s.startsAt).getTime() : null;
  const end = s.endsAt ? new Date(s.endsAt).getTime() : null;
  if (end && end < now) return 'is-done';
  if (start && start <= now && (!end || end >= now)) return 'is-now';
  return '';
}

function callToAction(ctx) {
  const base = `#/h/${enc(ctx.slug)}`;
  if (!state.user) {
    return h('div', { class: 'notice' }, t('overview.signInToJoin'), ' ',
      h('a', { href: `#/login?next=${enc(`h/${ctx.slug}`)}` }, t('nav.login')));
  }
  if (ctx.registered) {
    return h('div', { class: 'notice notice--ok row row--between' },
      h('span', null, t('overview.youAreRegistered', { role: t(`role.${ctx.me.registration.role}`) })),
      h('a', { class: 'btn btn--small', href: `${base}/me` }, t('overview.goToMyParticipation')));
  }
  if (ctx.mentoring.isMentor) return h('div', { class: 'notice' }, t('overview.youAreMentor'));
  if (ctx.h.registrationOpen) {
    return h('div', { class: 'notice row row--between' },
      h('span', null, t('overview.registrationOpen')),
      h('a', { class: 'btn btn--small', href: `${base}/me` }, t('overview.register')));
  }
  return h('div', { class: 'notice notice--warn' }, t('overview.registrationClosed'));
}

export async function overviewView({ slug }) {
  const ctx = await hackCtx(slug);
  const [ann, results] = await Promise.all([
    state.user || ctx.h.status !== 'draft' ? api.get(`/hackathons/${ctx.h.id}/announcements`) : { announcements: [] },
    state.user ? api.get(`/hackathons/${ctx.h.id}/results`) : { rounds: [] },
  ]);
  const x = ctx.h;
  return shell(ctx, 'overview',
    h('div', { class: 'grid-2' },
      h('div', { class: 'stack' },
        callToAction(ctx),
        pick(x, 'summary') ? h('section', { class: 'card' }, h('p', { class: 'pre' }, pick(x, 'summary'))) : null,
        h('section', { class: 'card' },
          h('h2', null, t('overview.keyFacts')),
          h('dl', { class: 'kv' },
            h('dt', null, t('overview.registration')),
            h('dd', null, `${fmtDate(x.registrationOpensAt)} → ${fmtDate(x.registrationClosesAt)}`),
            h('dt', null, t('overview.ideaDeadline')), h('dd', null, fmtDate(x.ideaSubmissionClosesAt)),
            h('dt', null, t('overview.teamSize')), h('dd', null, t('overview.teamSizeValue', { min: x.minTeamSize, max: x.maxTeamSize })))),
        ctx.tracks.length ? h('section', { class: 'card' },
          h('h2', null, t('overview.tracks')),
          h('div', { class: 'stack-sm' }, ctx.tracks.map((tr) => h('div', null,
            h('h3', null, pick(tr, 'name')),
            pick(tr, 'description') ? h('p', { class: 'muted pre' }, pick(tr, 'description')) : null)))) : null),
      h('div', { class: 'stack' },
        results.rounds.length ? h('section', { class: 'card' },
          h('h2', null, t('overview.results')),
          results.rounds.map((r) => h('div', { class: 'stack-sm' },
            h('h3', null, pick(r, 'name')),
            r.myOutcome ? h('p', null, t('overview.yourOutcome'), ' ', badge(t(`outcome.${r.myOutcome}`), r.myOutcome === 'advance' ? 'ok' : r.myOutcome === 'reject' ? 'danger' : 'warn')) : null,
            h('ol', null, r.advanced.map((a) => h('li', null, a.title, a.teamName ? h('span', { class: 'muted' }, ` — ${a.teamName}`) : null)))))) : null,
        h('section', { class: 'card' },
          h('h2', null, t('overview.timeline')),
          ctx.stages.length
            ? h('ol', { class: 'timeline' }, ctx.stages.map((s) => h('li', { class: stageClass(s) },
              h('strong', null, pick(s, 'name')),
              h('div', { class: 'small muted' }, `${fmtDate(s.startsAt)}${s.endsAt ? ` → ${fmtDate(s.endsAt)}` : ''}`))))
            : h('p', { class: 'muted' }, t('overview.noTimeline'))),
        h('section', { class: 'card' },
          h('h2', null, t('overview.announcements')),
          ann.announcements.length
            ? h('div', { class: 'stack' }, ann.announcements.map((a) => h('article', null,
              h('div', { class: 'row' }, h('h3', null, pick(a, 'title')), a.pinned ? badge(t('overview.pinned'), 'info') : null),
              h('div', { class: 'small muted' }, fmtDate(a.createdAt)),
              pick(a, 'body') ? h('p', { class: 'pre' }, pick(a, 'body')) : null)))
            : emptyState(t('overview.noAnnouncements'))))));
}
