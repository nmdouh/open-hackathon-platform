import { api, enc } from '../api.js';
import { t } from '../i18n.js';
import {
  h, badge, emptyState, busy, toast, field, formValues, confirmDialog, fmtDate, pick,
  avatar, person, progressBar, safeLink,
} from '../ui.js';
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

function teamCard(ctx, x) {
  return h('article', { class: 'card stack-sm' },
    h('div', { class: 'card__title' },
      h('h3', null, h('a', { href: `#/h/${enc(ctx.slug)}/teams/${x.id}` }, x.name)),
      x.isFull ? badge(t('team.full'), 'warn') : x.isOpen ? badge(t('team.open'), 'ok') : badge(t('team.closed'))),
    h('div', { class: 'small muted' }, x.ideaTitle, trackName(x) ? ` · ${trackName(x)}` : ''),
    h('div', { class: 'row' }, avatar(x.ownerName, true), h('span', { class: 'small' }, t('team.members', { n: x.memberCount, max: x.capacity }))),
    x.milestonesTotal ? progressBar(x.milestonesDone, x.milestonesTotal, t('milestones.progress')) : null,
    x.lookingFor ? h('p', { class: 'pre small' }, h('strong', null, t('team.lookingFor'), ': '), x.lookingFor) : null,
    x.myApplicationStatus ? badge(t(`appStatus.${x.myApplicationStatus}`), 'info') : null,
    canApply(ctx, x) ? h('div', null, h('button', { class: 'btn btn--small', onclick: (e) => applyTo(ctx, x, e.target) }, t('team.apply'))) : null);
}

export async function teamsView({ slug, query }) {
  const ctx = await hackCtx(slug);
  const { teams } = await api.get(`/hackathons/${ctx.h.id}/teams`);
  const grid = h('div', { class: 'grid' });
  const search = h('input', { type: 'search', placeholder: t('teams.search'), 'aria-label': t('teams.search'), value: query.get('q') || '' });
  const track = ctx.tracks.length ? h('select', { 'aria-label': t('idea.track') },
    h('option', { value: '' }, t('teams.allTracks')), ctx.tracks.map((tr) => h('option', { value: tr.id }, pick(tr, 'name')))) : null;
  const openOnly = h('input', { type: 'checkbox' });
  const count = h('span', { class: 'small muted' });
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const trackNames = track && track.value ? ctx.tracks.find((tr) => tr.id === track.value) : null;
    const shown = teams.filter((x) => {
      if (openOnly.checked && (!x.isOpen || x.isFull)) return false;
      if (trackNames && x.trackNameEn !== trackNames.nameEn) return false;
      if (!q) return true;
      return [x.name, x.ideaTitle, x.lookingFor, x.ownerName, x.ideaProblem].join(' ').toLowerCase().includes(q);
    });
    grid.replaceChildren(...(shown.length ? shown.map((x) => teamCard(ctx, x)) : [emptyState(t('teams.noMatch'))]));
    count.textContent = t('teams.count', { n: shown.length, total: teams.length });
  };
  search.addEventListener('input', draw);
  if (track) track.addEventListener('change', draw);
  openOnly.addEventListener('change', draw);
  draw();
  return shell(ctx, 'teams',
    teams.length ? h('div', { class: 'filters' },
      search, track, h('label', { class: 'check' }, openOnly, t('teams.openOnly')), count) : null,
    teams.length ? grid : emptyState(t('teams.none')));
}

function applicationsCard(team, applications) {
  if (!applications.length) return h('section', { class: 'card' }, h('h2', null, t('team.applications')), h('p', { class: 'muted' }, t('team.noApplications')));
  return h('section', { class: 'card stack-sm' },
    h('h2', null, t('team.applications')),
    applications.map((a) => {
      const invite = a.direction === 'invite';
      return h('div', { class: 'card card--flat stack-sm' },
        h('div', { class: 'row row--between' },
          person(a.displayName, [a.email, (a.skills || []).join(', ')].filter(Boolean).join(' · ')),
          h('span', { class: 'row' },
            invite ? badge(t('team.invited'), 'info') : null,
            badge(t(`appStatus.${a.status}`), a.status === 'pending' ? 'info' : a.status === 'accepted' ? 'ok' : ''))),
        a.bio ? h('p', { class: 'small pre' }, a.bio) : null,
        a.message ? h('p', { class: 'pre' }, a.message) : null,
        a.status === 'pending' && !invite ? h('div', { class: 'form-actions' },
          h('button', { class: 'btn btn--small', onclick: (e) => busy(e.target, async () => { await api.post(`/applications/${a.id}/accept`); toast(t('team.accepted')); refresh(); }) }, t('team.accept')),
          h('button', { class: 'btn btn--danger btn--small', onclick: (e) => busy(e.target, async () => { await api.post(`/applications/${a.id}/reject`); refresh(); }) }, t('team.reject'))) : null,
        a.status === 'pending' && invite ? h('div', { class: 'form-actions' },
          h('button', { class: 'btn btn--ghost btn--small', onclick: (e) => busy(e.target, async () => { await api.post(`/applications/${a.id}/withdraw`); refresh(); }) }, t('team.cancelInvite'))) : null);
    }));
}

function settingsCard(team, slug) {
  const form = h('form', { class: 'form' },
    field(t('team.name'), h('input', { type: 'text', name: 'name', value: team.name, maxlength: 120 })),
    field(t('team.lookingFor'), h('textarea', { name: 'lookingFor', value: team.lookingFor, maxlength: 2000 }), t('team.lookingForHint')),
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

// The team's build milestones: members tick them off and can attach evidence.
function milestonesCard(team, data) {
  const { milestones, canEdit } = data;
  if (!milestones.length) return null;
  const done = milestones.filter((m) => m.doneAt).length;
  const toggle = (m) => async (e) => {
    const box = e.target;
    let evidenceUrl = '';
    if (box.checked) {
      const answer = await confirmDialog(t('milestones.evidencePrompt', { title: pick(m, 'title') }),
        { withNote: true, notePlaceholder: 'https://…', okLabel: t('milestones.markDone') });
      if (answer === null) { box.checked = false; return; }
      evidenceUrl = answer;
    }
    busy(box, async () => {
      try {
        await api.put(`/teams/${team.id}/milestones/${m.id}`, { done: box.checked, evidenceUrl });
      } catch (err) {
        box.checked = !box.checked;
        throw err;
      }
      refresh();
    });
  };
  return h('section', { class: 'card stack-sm' },
    h('h2', null, t('milestones.title')),
    progressBar(done, milestones.length, t('milestones.progress')),
    h('ul', { class: 'checklist' }, milestones.map((m) => h('li', { class: m.doneAt ? 'is-done' : '' },
      h('input', { type: 'checkbox', checked: Boolean(m.doneAt), disabled: !canEdit, 'aria-label': pick(m, 'title'), onchange: toggle(m) }),
      h('div', null,
        h('strong', null, pick(m, 'title')),
        pick(m, 'description') ? h('div', { class: 'small muted' }, pick(m, 'description')) : null,
        h('div', { class: 'small muted' },
          m.dueAt ? `${t('milestones.due')} ${fmtDate(m.dueAt)}` : '',
          m.doneAt ? ` ${t('milestones.doneBy', { name: m.doneByName || '', date: fmtDate(m.doneAt) })}` : ''),
        m.evidenceUrl ? h('div', { class: 'small' }, safeLink(m.evidenceUrl, t('milestones.evidence'))) : null)))));
}

export async function teamView({ slug, id }) {
  const ctx = await hackCtx(slug);
  const { team, members, insider } = await api.get(`/teams/${enc(id)}`);
  const manager = team.ownerId === state.user.id || ctx.admin;
  const [apps, mentors, ms] = await Promise.all([
    manager ? api.get(`/teams/${team.id}/applications`) : { applications: [] },
    api.get(`/teams/${team.id}/mentors`),
    api.get(`/teams/${team.id}/milestones`),
  ]);
  const myId = state.user.id;
  const listing = { ...team, isFull: members.length >= team.capacity, myApplicationStatus: null };
  return shell(ctx, 'teams',
    h('p', null, h('a', { href: `#/h/${enc(slug)}/teams` }, t('common.back'))),
    h('div', { class: 'grid-2' },
      h('div', { class: 'stack' },
        h('section', { class: 'card stack-sm' },
          h('div', { class: 'row row--between' }, h('h2', null, team.name),
            listing.isFull ? badge(t('team.full'), 'warn') : team.isOpen ? badge(t('team.open'), 'ok') : badge(t('team.closed'))),
          h('p', null, t('team.idea'), ': ', h('a', { href: `#/h/${enc(slug)}/ideas/${team.ideaId}` }, team.ideaTitle)),
          team.lookingFor ? h('p', { class: 'pre' }, h('strong', null, t('team.lookingFor'), ': '), team.lookingFor) : null,
          h('h3', null, t('team.membersTitle', { n: members.length, max: team.capacity })),
          h('div', { class: 'stack-sm' }, members.map((m) => h('div', { class: 'row row--between' },
            person(m.displayName, [m.role === 'owner' ? t('team.owner') : null, insider ? m.email : null, (m.skills || []).join(', ')].filter(Boolean).join(' · ')),
            (manager && m.role !== 'owner') || (m.userId === myId && m.role !== 'owner')
              ? h('button', {
                class: 'btn btn--ghost btn--small',
                onclick: async (e) => {
                  if (!(await confirmDialog(m.userId === myId ? t('team.leaveConfirm') : t('team.removeConfirm', { name: m.displayName }), { danger: true }))) return;
                  busy(e.target, async () => { await api.del(`/teams/${team.id}/members/${m.userId}`); refresh(); });
                },
              }, m.userId === myId ? t('team.leave') : t('team.remove')) : null))),
          canApply(ctx, listing) ? h('button', { class: 'btn', onclick: (e) => applyTo(ctx, listing, e.target) }, t('team.apply')) : null),
        milestonesCard(team, ms),
        mentors.mentors.length ? h('section', { class: 'card stack-sm' }, h('h2', null, t('mentoring.mentors')),
          mentors.mentors.map((m) => person(m.displayName, (m.expertise || []).join(', ')))) : null),
      h('div', { class: 'stack' },
        manager ? applicationsCard(team, apps.applications) : null,
        manager ? settingsCard(team, slug) : null,
        h('p', { class: 'small muted' }, t('common.created'), ' ', fmtDate(team.createdAt)))));
}
