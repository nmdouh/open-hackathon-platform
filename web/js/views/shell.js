import { api, enc } from '../api.js';
import { t } from '../i18n.js';
import { h, pick, badge } from '../ui.js';
import { state, isAdmin } from '../state.js';

// Loads everything the hackathon pages need to decide what to show.
export async function hackCtx(slug) {
  const base = await api.get(`/hackathons/${enc(slug)}`);
  const ctx = {
    slug,
    h: base.hackathon,
    tracks: base.tracks,
    stages: base.stages,
    me: null,
    rounds: [],
    mentoring: { isMentor: false, teams: [] },
  };
  if (state.user) {
    const id = base.hackathon.id;
    const [me, rounds, mentoring] = await Promise.all([
      api.get(`/hackathons/${id}/me`),
      api.get(`/hackathons/${id}/rounds`),
      api.get(`/hackathons/${id}/mentoring/me`),
    ]);
    ctx.me = me;
    ctx.rounds = rounds.rounds;
    ctx.mentoring = mentoring;
  }
  ctx.registered = Boolean(ctx.me && ctx.me.registration);
  ctx.admin = isAdmin();
  ctx.insider = ctx.registered || ctx.admin || ctx.mentoring.isMentor;
  ctx.teamId = ctx.me && ctx.me.membership ? ctx.me.membership.teamId : null;
  return ctx;
}

export function statusBadge(status) {
  const kind = { open: 'ok', running: 'info', closed: 'warn', draft: '', archived: '' }[status];
  return badge(t(`status.${status}`), kind);
}

// Page frame for a hackathon: title, status and the tab bar.
export function shell(ctx, active, ...content) {
  const base = `#/h/${enc(ctx.slug)}`;
  const tabs = [
    ['overview', base, true],
    ['me', `${base}/me`, Boolean(state.user)],
    ['ideas', `${base}/ideas`, ctx.insider],
    ['teams', `${base}/teams`, ctx.insider],
    ['progress', `${base}/progress`, ctx.insider],
    ['mentoring', `${base}/mentoring`, Boolean(ctx.teamId) || ctx.mentoring.isMentor || ctx.admin],
    ['toolbox', `${base}/toolbox`, ctx.insider],
    ['reviews', `${base}/reviews`, ctx.rounds.length > 0 || ctx.admin],
    ['admin', `${base}/admin`, ctx.admin],
  ];
  return h('div', null,
    h('div', { class: 'hero' },
      h('div', { class: 'row' }, h('h1', null, pick(ctx.h, 'title')), statusBadge(ctx.h.status))),
    h('nav', { class: 'tabs', 'aria-label': t('nav.sections') },
      tabs.filter(([, , show]) => show).map(([key, href]) =>
        h('a', { class: 'tab', href, 'aria-current': key === active ? 'page' : null }, t(`tab.${key}`)))),
    ...content);
}

export function trackName(obj) {
  return pick(obj, 'trackName') || '';
}
