import { api, enc } from '../api.js';
import { t } from '../i18n.js';
import { h, pick, fmtDate, emptyState } from '../ui.js';
import { state, isAdmin } from '../state.js';
import { statusBadge } from './shell.js';

export async function homeView() {
  const { hackathons } = await api.get('/hackathons');
  return h('div', null,
    h('section', { class: 'hero' },
      h('h1', null, t('home.title')),
      h('p', null, t('home.lead')),
      !state.user ? h('div', { class: 'row' },
        state.config.allowSignup ? h('a', { class: 'btn', href: '#/signup' }, t('nav.signup')) : null,
        h('a', { class: 'btn btn--secondary', href: '#/login' }, t('nav.login'))) : null,
      isAdmin() ? h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/admin' }, t('home.createHackathon'))) : null),
    h('h2', { class: 'section-title' }, t('home.hackathons')),
    hackathons.length
      ? h('div', { class: 'grid' }, hackathons.map((x) => h('article', { class: 'card stack-sm' },
        h('div', { class: 'card__title' },
          h('h3', null, h('a', { href: `#/h/${enc(x.slug)}` }, pick(x, 'title'))),
          statusBadge(x.status)),
        pick(x, 'summary') ? h('p', { class: 'muted pre' }, pick(x, 'summary')) : null,
        x.registrationClosesAt ? h('p', { class: 'small muted' }, t('home.registrationCloses', { date: fmtDate(x.registrationClosesAt) })) : null,
        h('a', { class: 'btn btn--secondary btn--small', href: `#/h/${enc(x.slug)}` }, t('common.open')))))
      : emptyState(t('home.none')));
}
