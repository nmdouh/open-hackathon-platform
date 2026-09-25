import { api, enc } from '../api.js';
import { t } from '../i18n.js';
import { h, badge, emptyState, busy, toast, field, formValues, confirmDialog, fmtDate } from '../ui.js';
import { state } from '../state.js';
import { refresh, go } from '../app.js';
import { hackCtx, shell, trackName } from './shell.js';

function canApply(ctx, team) {
  return ctx.registered && ctx.me.registration.role === 'member' && !ctx.teamId
    && team.isOpen && !team.isFull && team.myApplicationStatus !== 'pending';
}

async function applyTo(ctx, team, button) {
  const message = await confirmDialog(t('team.applyPrompt', { name: team.name }), {
    okLabel: t('team.apply'), withNote: true, notePlaceholder: t('team.applyMessage'),
  });
  if (message === null) return;
  await busy(button, async () => {
    await api.post(`/teams/${team.id}/applications`, { message });
    toast(t('team.applied'));
    refresh();
  });
}

export async function teamsView({ slug }) {
  const ctx = await hackCtx(slug);
  const { teams } = await api.get(`/hackathons/${ctx.h.id}/teams`);
  return shell(ctx, 'teams',
    teams.length ? h('div', { class: 'grid' }, teams.map((x) => h('article', { class: 'card stack-sm' },
      h('div', { class: 'card__title' },
        h('h3', null, h('a', { href: `#/h/${enc(slug)}/teams/${x.id}` }, x.name)),
        x.isFull ? badge(t('team.full'), 'warn') : x.isOpen ? badge(t('team.open'), 'ok') : badge(t('team.closed'))),
      h('div', { class: 'small muted' }, x.ideaTitle, trackName(x) ? ` · ${trackName(x)}` : ''),
      h('div', { class: 'small' }, t('team.members', { n: x.memberCount, max: x.capacity })),
      x.lookingFor ? h('p', { class: 'pre' }, h('strong', null, t('team.lookingFor'), ': '), x.lookingFor) : null,
      x.myApplicationStatus ? badge(t(`appStatus.${x.myApplicationStatus}`), 'info') : null,
      canApply(ctx, x) ? h('button', { class: 'btn btn--small', onclick: (e) => applyTo(ctx, x, e.target) }, t('team.apply')) : null)))
      : emptyState(t('teams.none')));
}

function applicationsCard(team, applications) {
  if (!applications.length) return h('section', { class: 'card' }, h('h2', null, t('team.applications')), h('p', { class: 'muted' }, t('team.noApplications')));
  return h('section', { class: 'card stack-sm' },
    h('h2', null, t('team.applications')),
    applications.map((a) => h('div', { class: 'card card--flat stack-sm' },
      h('div', { class: 'row row--between' },
        h('strong', null, a.displayName),
        badge(t(`appStatus.${a.status}`), a.status === 'pending' ? 'info' : a.status === 'accepted' ? 'ok' : '')),
      h('div', { class: 'small muted' }, a.email, (a.skills || []).length ? ` · ${a.skills.join(', ')}` : ''),
      a.bio ? h('p', { class: 'small pre' }, a.bio) : null,
      a.message ? h('p', { class: 'pre' }, a.message) : null,
      a.status === 'pending' ? h('div', { class: 'form-actions' },
        h('button', { class: 'btn btn--small', onclick: (e) => busy(e.target, async () => { await api.post(`/applications/${a.id}/accept`); toast(t('team.accepted')); refresh(); }) }, t('team.accept')),
        h('button', { class: 'btn btn--danger btn--small', onclick: (e) => busy(e.target, async () => { await api.post(`/applications/${a.id}/reject`); refresh(); }) }, t('team.reject'))) : null)));
}

function settingsCard(team, slug) {
  const form = h('form', { class: 'form' },
    field(t('team.name'), h('input', { type: 'text', name: 'name', value: team.name, maxlength: 120 })),
    field(t('team.lookingFor'), h('textarea', { name: 'lookingFor', value: team.lookingFor, maxlength: 2000 })),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'isOpen', checked: team.isOpen }), t('team.acceptingApplications')),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn btn--secondary', type: 'submit' }, t('common.save'))));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('[type=submit]'), async () => { await api.patch(`/teams/${team.id}`, formValues(form)); toast(t('common.saved')); refresh(); });
  });
  return h('section', { class: 'card stack-sm' }, h('h2', null, t('team.settings')), form,
    h('button', {
      class: 'btn btn--danger btn--small',
      onclick: async (e) => {
        if (!(await confirmDialog(t('team.disbandConfirm'), { danger: true, okLabel: t('team.disband') }))) return;
        busy(e.target, async () => { await api.del(`/teams/${team.id}`); go(`h/${enc(slug)}/me`); refresh(); });
      },
    }, t('team.disband')));
}

export async function teamView({ slug, id }) {
  const ctx = await hackCtx(slug);
  const { team, members, insider } = await api.get(`/teams/${enc(id)}`);
  const manager = team.ownerId === state.user.id || ctx.admin;
  const [apps, mentors] = await Promise.all([
    manager ? api.get(`/teams/${team.id}/applications`) : { applications: [] },
    api.get(`/teams/${team.id}/mentors`),
  ]);
  const myId = state.user.id;
  const listing = { ...team, isFull: members.length >= team.capacity, myApplicationStatus: null };
  return shell(ctx, 'teams',
    h('div', { class: 'grid-2' },
      h('div', { class: 'stack' },
        h('section', { class: 'card stack-sm' },
          h('h2', null, team.name),
          h('p', null, t('team.idea'), ': ', h('a', { href: `#/h/${enc(slug)}/ideas/${team.ideaId}` }, team.ideaTitle)),
          team.lookingFor ? h('p', { class: 'pre' }, h('strong', null, t('team.lookingFor'), ': '), team.lookingFor) : null,
          h('h3', null, t('team.membersTitle', { n: members.length, max: team.capacity })),
          h('ul', null, members.map((m) => h('li', null,
            m.displayName, ' ', m.role === 'owner' ? badge(t('team.owner'), 'info') : null,
            insider && m.email ? h('span', { class: 'small muted' }, ` ${m.email}`) : null,
            (manager && m.role !== 'owner') || (m.userId === myId && m.role !== 'owner')
              ? h('button', {
                class: 'btn btn--ghost btn--small',
                onclick: async (e) => {
                  if (!(await confirmDialog(m.userId === myId ? t('team.leaveConfirm') : t('team.removeConfirm', { name: m.displayName }), { danger: true }))) return;
                  busy(e.target, async () => { await api.del(`/teams/${team.id}/members/${m.userId}`); refresh(); });
                },
              }, m.userId === myId ? t('team.leave') : t('team.remove')) : null))),
          canApply(ctx, listing) ? h('button', { class: 'btn', onclick: (e) => applyTo(ctx, listing, e.target) }, t('team.apply')) : null),
        mentors.mentors.length ? h('section', { class: 'card' }, h('h2', null, t('mentoring.mentors')),
          h('ul', null, mentors.mentors.map((m) => h('li', null, m.displayName, (m.expertise || []).length ? h('span', { class: 'muted' }, ` — ${m.expertise.join(', ')}`) : null)))) : null),
      h('div', { class: 'stack' },
        manager ? applicationsCard(team, apps.applications) : null,
        manager ? settingsCard(team, slug) : null,
        h('p', { class: 'small muted' }, t('common.created'), ' ', fmtDate(team.createdAt)))));
}
