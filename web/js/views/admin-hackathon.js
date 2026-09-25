import { api, enc } from '../api.js';
import { t } from '../i18n.js';
import {
  h, pick, badge, emptyState, busy, toast, field, formValues, fmtDate, fmtNum, confirmDialog,
  toLocalInput, fromLocalInput, splitList, progressBar,
} from '../ui.js';
import { refresh, go } from '../app.js';
import { hackCtx, shell } from './shell.js';
import { roundBadge } from './reviews.js';

const TABS = ['dashboard', 'settings', 'timeline', 'milestones', 'announcements', 'participants', 'rounds', 'mentors', 'resources', 'audit'];

function subnav(slug, active) {
  return h('nav', { class: 'row', 'aria-label': t('admin.sections') }, TABS.map((k) => h('a', {
    class: `btn btn--small ${k === active ? '' : 'btn--secondary'}`,
    href: `#/h/${enc(slug)}/admin/${k}`,
    'aria-current': k === active ? 'page' : null,
  }, t(`admin.tab.${k}`))));
}

function submitForm(form, fn) {
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter || form.querySelector('[type=submit]'), async () => { await fn(formValues(form)); });
  });
  return form;
}

const input = (name, value, attrs = {}) => h('input', { type: 'text', name, value: value ?? '', ...attrs });
const textarea = (name, value, attrs = {}) => h('textarea', { name, value: value ?? '', ...attrs });
const dateInput = (name, value) => h('input', { type: 'datetime-local', name, value: toLocalInput(value) });

// ---------------------------------------------------------------- dashboard
async function dashboardTab(ctx) {
  const d = await api.get(`/hackathons/${ctx.h.id}/dashboard`);
  const f = d.funnel;
  const steps = [
    ['registered', f.registered], ['ideasStarted', f.ideasStarted], ['ideasSubmitted', f.ideasSubmitted],
    ['teams', f.teams], ['teamsReady', f.teamsReady], ['advanced', f.advanced],
  ];
  const max = Math.max(1, ...steps.map(([, n]) => n));
  const tile = (n, label, accent) => h('div', { class: `tile${accent ? ' tile--accent' : ''}` }, h('strong', null, fmtNum(n, 0)), h('span', null, label));
  const base = `#/h/${enc(ctx.slug)}`;
  return h('div', { class: 'stack' },
    h('div', { class: 'tiles' },
      tile(f.lookingForTeam, t('dash.lookingForTeam'), f.lookingForTeam > 0),
      tile(d.atRisk.length, t('dash.atRiskCount'), d.atRisk.length > 0),
      tile(d.activity.posts24h, t('dash.posts24h')),
      tile(d.activity.openHelp, t('dash.openHelp'), d.activity.openHelp > 0),
      tile(d.mentoring.open, t('dash.mentoringOpen'), d.mentoring.open > 0),
      tile(d.mentoring.done, t('dash.mentoringDone'))),
    h('div', { class: 'grid-2' },
      h('section', { class: 'card stack-sm' },
        h('h2', null, t('dash.funnel')),
        h('div', { class: 'funnel' }, steps.map(([k, n]) => {
          const bar = h('i');
          bar.style.width = `${Math.round((n / max) * 100)}%`;
          return h('div', { class: 'funnel__row' }, h('span', { class: 'small' }, t(`dash.f.${k}`)), h('div', { class: 'funnel__bar' }, bar), h('strong', { class: 'num' }, fmtNum(n, 0)));
        }))),
      h('section', { class: 'card stack-sm' },
        h('h2', null, t('dash.atRisk')),
        d.atRisk.length ? h('div', { class: 'stack-sm' }, d.atRisk.map((x) => h('div', { class: 'row row--between' },
          h('a', { href: `${base}/teams/${x.id}` }, x.name),
          h('span', { class: 'row' }, x.reasons.map((r) => badge(t(`dash.reason.${r}`), r === 'no_mentor' ? '' : 'warn'))))))
          : h('p', { class: 'notice notice--ok' }, t('dash.noRisk')))),
    h('div', { class: 'grid-2' },
      h('section', { class: 'card stack-sm' },
        h('h2', null, t('dash.teamProgress')),
        d.teams.length ? h('div', { class: 'stack-sm' }, d.teams.map((x) => h('div', null,
          h('div', { class: 'row row--between small' }, h('a', { href: `${base}/teams/${x.id}` }, x.name),
            h('span', { class: 'muted' }, t('dash.membersOf', { n: x.members, min: d.minTeamSize }))),
          d.milestonesTotal ? progressBar(x.milestonesDone, d.milestonesTotal) : null)))
          : emptyState(t('teams.none')),
        !d.milestonesTotal ? h('p', { class: 'small muted' }, t('dash.noMilestones'), ' ', h('a', { href: `${base}/admin/milestones` }, t('admin.tab.milestones'))) : null),
      h('div', { class: 'stack' },
        d.tracks.length ? h('section', { class: 'card stack-sm' },
          h('h2', null, t('overview.tracks')),
          h('div', { class: 'table-wrap' }, h('table', null,
            h('thead', null, h('tr', null, h('th', null, t('idea.track')), h('th', { class: 'num' }, t('stats.ideas')), h('th', { class: 'num' }, t('stats.teams')))),
            h('tbody', null, d.tracks.map((tr) => h('tr', null, h('td', null, pick(tr, 'name')), h('td', { class: 'num' }, tr.ideas), h('td', { class: 'num' }, tr.teams))))))) : null,
        h('section', { class: 'card stack-sm' },
          h('h2', null, t('dash.reviews')),
          d.rounds.length ? h('div', { class: 'table-wrap' }, h('table', null,
            h('thead', null, h('tr', null, h('th', null, t('admin.tab.rounds')), h('th', null, t('common.status')), h('th', { class: 'num' }, t('dash.evaluations')), h('th', { class: 'num' }, t('dash.advanced')))),
            h('tbody', null, d.rounds.map((r) => h('tr', null,
              h('td', null, h('a', { href: `${base}/admin/rounds/${r.id}` }, pick(r, 'name'))),
              h('td', null, roundBadge(r.status)),
              h('td', { class: 'num' }, r.evaluations),
              h('td', { class: 'num' }, `${r.advanced}/${r.decided}`))))))
            : h('p', { class: 'muted small' }, t('reviews.noneAdmin'))))));
}

// ---------------------------------------------------------------- milestones
async function milestonesTab(ctx) {
  const { milestones } = await api.get(`/hackathons/${ctx.h.id}/milestones`);
  const form = submitForm(h('form', { class: 'form card' },
    h('h2', null, t('milestones.add')),
    h('div', { class: 'grid-2' },
      field(t('admin.titleEn'), input('titleEn', '', { required: true })),
      field(t('admin.titleAr'), input('titleAr', '', { dir: 'rtl', lang: 'ar' })),
      field(t('admin.descriptionEn'), textarea('descriptionEn', '')),
      field(t('admin.descriptionAr'), textarea('descriptionAr', '', { dir: 'rtl', lang: 'ar' })),
      field(t('milestones.due'), dateInput('dueAt'))),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'submit' }, t('milestones.add')))), async (v) => {
    await api.post(`/hackathons/${ctx.h.id}/milestones`, { ...v, dueAt: fromLocalInput(v.dueAt), sortOrder: milestones.length });
    refresh();
  });
  return h('div', { class: 'grid-2' },
    h('section', { class: 'card stack-sm' },
      h('h2', null, t('milestones.title')),
      h('p', { class: 'small muted' }, t('milestones.adminLead')),
      milestones.length ? h('ol', { class: 'stack-sm' }, milestones.map((m) => h('li', null,
        h('div', { class: 'row row--between' },
          h('strong', null, pick(m, 'title')),
          h('button', {
            class: 'btn btn--ghost btn--small',
            onclick: async (e) => {
              if (!(await confirmDialog(t('common.deleteConfirm'), { danger: true }))) return;
              busy(e.target, async () => { await api.del(`/milestones/${m.id}`); refresh(); });
            },
          }, t('common.delete'))),
        h('div', { class: 'small muted' }, pick(m, 'description')),
        h('div', { class: 'small' }, m.dueAt ? `${t('milestones.due')} ${fmtDate(m.dueAt)} · ` : '', t('milestones.teamsDone', { n: m.teamsDone })))))
        : h('div', { class: 'stack-sm' },
          emptyState(t('milestones.none')),
          h('button', {
            class: 'btn',
            onclick: (e) => busy(e.target, async () => { await api.post(`/hackathons/${ctx.h.id}/milestones/template`); toast(t('milestones.templateAdded')); refresh(); }),
          }, t('milestones.useTemplate')))),
    form);
}

// ---------------------------------------------------------------- settings
function settingsTab(ctx) {
  const x = ctx.h;
  return submitForm(h('form', { class: 'form card' },
    h('div', { class: 'grid-2' },
      field(t('admin.titleEn'), input('titleEn', x.titleEn, { required: true, maxlength: 200 })),
      field(t('admin.titleAr'), input('titleAr', x.titleAr, { maxlength: 200, dir: 'rtl', lang: 'ar' })),
      field(t('admin.summaryEn'), textarea('summaryEn', x.summaryEn, { maxlength: 4000 })),
      field(t('admin.summaryAr'), textarea('summaryAr', x.summaryAr, { maxlength: 4000, dir: 'rtl', lang: 'ar' })),
      field(t('common.status'), h('select', { name: 'status' }, ['draft', 'open', 'running', 'closed', 'archived'].map((s) =>
        h('option', { value: s, selected: s === x.status }, t(`status.${s}`)))), t('admin.statusHint')),
      field(t('admin.maxPending'), h('input', { type: 'number', name: 'maxPendingApplications', min: 1, max: 20, value: x.maxPendingApplications })),
      field(t('admin.registrationOpens'), dateInput('registrationOpensAt', x.registrationOpensAt)),
      field(t('admin.registrationCloses'), dateInput('registrationClosesAt', x.registrationClosesAt)),
      field(t('admin.ideaDeadline'), dateInput('ideaSubmissionClosesAt', x.ideaSubmissionClosesAt)),
      h('div', { class: 'row' },
        field(t('admin.minTeam'), h('input', { type: 'number', name: 'minTeamSize', min: 1, max: 50, value: x.minTeamSize })),
        field(t('admin.maxTeam'), h('input', { type: 'number', name: 'maxTeamSize', min: 1, max: 50, value: x.maxTeamSize })))),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'submit' }, t('common.save')))), async (v) => {
    for (const k of ['registrationOpensAt', 'registrationClosesAt', 'ideaSubmissionClosesAt']) v[k] = fromLocalInput(v[k]);
    await api.patch(`/hackathons/${x.id}`, v);
    toast(t('common.saved'));
    refresh();
  });
}

// ---------------------------------------------------------------- tracks and timeline
function timelineTab(ctx) {
  const id = ctx.h.id;
  const trackForm = submitForm(h('form', { class: 'form' },
    h('div', { class: 'grid-2' },
      field(t('admin.nameEn'), input('nameEn', '', { required: true })),
      field(t('admin.nameAr'), input('nameAr', '', { dir: 'rtl', lang: 'ar' })),
      field(t('admin.descriptionEn'), textarea('descriptionEn', '')),
      field(t('admin.descriptionAr'), textarea('descriptionAr', '', { dir: 'rtl', lang: 'ar' }))),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'submit' }, t('admin.addTrack')))), async (v) => {
    await api.post(`/hackathons/${id}/tracks`, v); refresh();
  });
  const stageForm = submitForm(h('form', { class: 'form' },
    h('div', { class: 'grid-2' },
      field(t('admin.nameEn'), input('nameEn', '', { required: true })),
      field(t('admin.nameAr'), input('nameAr', '', { dir: 'rtl', lang: 'ar' })),
      field(t('admin.startsAt'), dateInput('startsAt')),
      field(t('admin.endsAt'), dateInput('endsAt')),
      field(t('admin.order'), h('input', { type: 'number', name: 'sortOrder', value: ctx.stages.length }))),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'submit' }, t('admin.addStage')))), async (v) => {
    await api.post(`/hackathons/${id}/stages`, { ...v, startsAt: fromLocalInput(v.startsAt), endsAt: fromLocalInput(v.endsAt), sortOrder: v.sortOrder || 0 });
    refresh();
  });
  const del = (path) => async (e) => {
    if (!(await confirmDialog(t('common.deleteConfirm'), { danger: true }))) return;
    busy(e.target, async () => { await api.del(path); refresh(); });
  };
  return h('div', { class: 'grid-2' },
    h('section', { class: 'card stack-sm' }, h('h2', null, t('overview.tracks')),
      ctx.tracks.length ? h('ul', null, ctx.tracks.map((tr) => h('li', null, pick(tr, 'name'), ' ',
        h('button', { class: 'btn btn--ghost btn--small', onclick: del(`/tracks/${tr.id}`) }, t('common.delete'))))) : h('p', { class: 'muted' }, t('admin.noTracks')),
      trackForm),
    h('section', { class: 'card stack-sm' }, h('h2', null, t('overview.timeline')),
      ctx.stages.length ? h('ul', null, ctx.stages.map((s) => h('li', null, h('strong', null, pick(s, 'name')), ' ',
        h('span', { class: 'small muted' }, `${fmtDate(s.startsAt)} → ${fmtDate(s.endsAt)}`), ' ',
        h('button', { class: 'btn btn--ghost btn--small', onclick: del(`/stages/${s.id}`) }, t('common.delete'))))) : h('p', { class: 'muted' }, t('overview.noTimeline')),
      stageForm));
}

// ---------------------------------------------------------------- announcements
async function announcementsTab(ctx) {
  const { announcements } = await api.get(`/hackathons/${ctx.h.id}/announcements`);
  const form = submitForm(h('form', { class: 'form card' },
    h('h2', null, t('admin.newAnnouncement')),
    h('div', { class: 'grid-2' },
      field(t('admin.titleEn'), input('titleEn', '', { required: true })),
      field(t('admin.titleAr'), input('titleAr', '', { dir: 'rtl', lang: 'ar' })),
      field(t('admin.bodyEn'), textarea('bodyEn', '')),
      field(t('admin.bodyAr'), textarea('bodyAr', '', { dir: 'rtl', lang: 'ar' }))),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'pinned' }), t('overview.pinned')),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'submit' }, t('admin.publish')))), async (v) => {
    await api.post(`/hackathons/${ctx.h.id}/announcements`, v); toast(t('admin.published')); refresh();
  });
  return h('div', { class: 'grid-2' }, form,
    h('div', { class: 'stack' }, announcements.length ? announcements.map((a) => h('article', { class: 'card stack-sm' },
      h('div', { class: 'row row--between' }, h('strong', null, pick(a, 'title')),
        h('button', {
          class: 'btn btn--ghost btn--small',
          onclick: async (e) => {
            if (!(await confirmDialog(t('common.deleteConfirm'), { danger: true }))) return;
            busy(e.target, async () => { await api.del(`/announcements/${a.id}`); refresh(); });
          },
        }, t('common.delete'))),
      h('div', { class: 'small muted' }, fmtDate(a.createdAt)),
      h('p', { class: 'pre' }, pick(a, 'body')))) : emptyState(t('overview.noAnnouncements'))));
}

// ---------------------------------------------------------------- participants
async function participantsTab(ctx) {
  const { participants } = await api.get(`/hackathons/${ctx.h.id}/participants`);
  const owners = participants.filter((p) => p.role === 'idea_owner').length;
  const withTeam = participants.filter((p) => p.teamId).length;
  const csv = () => {
    const rows = [['name', 'email', 'role', 'skills', 'idea', 'idea_status', 'team', 'team_role']]
      .concat(participants.map((p) => [p.displayName, p.email, p.role, (p.skills || []).join('; '), p.ideaTitle || '', p.ideaStatus || '', p.teamName || '', p.teamRole || '']));
    // Prefix cells that a spreadsheet would treat as formulas.
    const cell = (v) => `"${String(v).replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"`;
    const blob = new Blob([`﻿${rows.map((r) => r.map(cell).join(',')).join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `${ctx.slug}-participants.csv` });
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return h('div', { class: 'stack' },
    h('div', { class: 'row' },
      badge(t('admin.countRegistered', { n: participants.length }), 'info'),
      badge(t('admin.countOwners', { n: owners })),
      badge(t('admin.countInTeams', { n: withTeam }), 'ok'),
      badge(t('admin.countWithoutTeam', { n: participants.length - withTeam }), 'warn'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn--secondary btn--small', onclick: csv }, t('admin.exportCsv'))),
    participants.length ? h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, ['name', 'role', 'skills', 'idea', 'team'].map((k) => h('th', null, t(`admin.col.${k}`))))),
      h('tbody', null, participants.map((p) => h('tr', null,
        h('td', null, p.displayName, h('div', { class: 'small muted' }, p.email)),
        h('td', null, t(`role.${p.role}`)),
        h('td', { class: 'small' }, (p.skills || []).join(', ')),
        h('td', null, p.ideaTitle ? [p.ideaTitle, ' ', badge(t(`ideaStatus.${p.ideaStatus}`))] : '—'),
        h('td', null, p.teamName ? h('a', { href: `#/h/${enc(ctx.slug)}/teams/${p.teamId}` }, p.teamName) : '—')))))) : emptyState(t('admin.noParticipants')));
}

// ---------------------------------------------------------------- rounds
function roundsTab(ctx) {
  const form = submitForm(h('form', { class: 'form card' },
    h('h2', null, t('admin.newRound')),
    h('div', { class: 'grid-2' },
      field(t('admin.roundKind'), h('select', { name: 'kind' }, ['screening', 'review', 'final'].map((k) => h('option', { value: k }, t(`roundKind.${k}`))))),
      field(t('admin.sourceRound'), h('select', { name: 'sourceRoundId' },
        h('option', { value: '' }, t('admin.allSubmitted')),
        ctx.rounds.map((r) => h('option', { value: r.id }, pick(r, 'name'))))),
      field(t('admin.nameEn'), input('nameEn', '', { required: true })),
      field(t('admin.nameAr'), input('nameAr', '', { dir: 'rtl', lang: 'ar' })),
      field(t('admin.minReviewers'), h('input', { type: 'number', name: 'minReviewers', min: 1, max: 50, value: 2 })),
      field(t('admin.advanceCount'), h('input', { type: 'number', name: 'advanceCount', min: 0 }), t('admin.advanceCountHint')),
      field(t('admin.assignmentMode'), h('select', { name: 'assignmentMode' },
        h('option', { value: 'all' }, t('admin.assign.all')), h('option', { value: 'assigned' }, t('admin.assign.assigned'))))),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'useTemplate', checked: true }), t('admin.useTemplate')),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'submit' }, t('admin.createRound')))), async (v) => {
    const { round } = await api.post(`/hackathons/${ctx.h.id}/rounds`, {
      ...v, sourceRoundId: v.sourceRoundId || null, minReviewers: v.minReviewers || 1, sortOrder: ctx.rounds.length,
    });
    go(`h/${enc(ctx.slug)}/admin/rounds/${round.id}`);
  });
  return h('div', { class: 'grid-2' },
    h('div', { class: 'stack' }, ctx.rounds.length ? ctx.rounds.map((r) => h('article', { class: 'card stack-sm' },
      h('div', { class: 'card__title' }, h('h3', null, h('a', { href: `#/h/${enc(ctx.slug)}/admin/rounds/${r.id}` }, pick(r, 'name'))), roundBadge(r.status)),
      h('div', { class: 'small muted' }, t(`roundKind.${r.kind}`), ' · ', t('admin.criteriaCount', { n: r.criteriaCount }), ' · ', t('reviews.reviewersCount', { n: r.reviewerCount })),
      r.resultsPublished ? badge(t('admin.resultsPublished'), 'ok') : null)) : emptyState(t('reviews.noneAdmin'))),
    form);
}

// ---------------------------------------------------------------- mentors
async function mentorsTab(ctx) {
  const { mentors } = await api.get(`/hackathons/${ctx.h.id}/mentors`);
  const { teams } = await api.get(`/hackathons/${ctx.h.id}/teams`).catch(() => ({ teams: [] }));
  const form = submitForm(h('form', { class: 'form card' },
    h('h2', null, t('admin.addMentor')),
    field(t('auth.email'), h('input', { type: 'email', name: 'email', required: true }), t('admin.mentorEmailHint')),
    field(t('admin.expertise'), input('expertise', ''), t('me.skillsHint')),
    field(t('admin.maxTeams'), h('input', { type: 'number', name: 'maxTeams', min: 1, max: 50, value: 5 })),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'submit' }, t('admin.addMentor')))), async (v) => {
    await api.post(`/hackathons/${ctx.h.id}/mentors`, { email: v.email, expertise: splitList(v.expertise), maxTeams: v.maxTeams || 5 });
    toast(t('common.saved')); refresh();
  });
  const assign = (m) => {
    const sel = h('select', { 'aria-label': t('admin.assignTeam') }, h('option', { value: '' }, t('admin.assignTeam')), teams.map((x) => h('option', { value: x.id }, x.name)));
    return h('div', { class: 'row' }, sel, h('button', {
      class: 'btn btn--secondary btn--small',
      onclick: (e) => { if (sel.value) busy(e.target, async () => { await api.put(`/teams/${sel.value}/mentors/${m.userId}`); toast(t('common.saved')); refresh(); }); },
    }, t('admin.assign')));
  };
  return h('div', { class: 'grid-2' },
    h('div', { class: 'stack' }, mentors.length ? mentors.map((m) => h('article', { class: 'card stack-sm' },
      h('div', { class: 'row row--between' }, h('strong', null, m.displayName),
        h('button', {
          class: 'btn btn--ghost btn--small',
          onclick: async (e) => {
            if (!(await confirmDialog(t('admin.removeMentorConfirm', { name: m.displayName }), { danger: true }))) return;
            busy(e.target, async () => { await api.del(`/hackathons/${ctx.h.id}/mentors/${m.userId}`); refresh(); });
          },
        }, t('team.remove'))),
      h('div', { class: 'small muted' }, m.email, ' · ', (m.expertise || []).join(', ')),
      h('div', { class: 'small' }, t('admin.mentorLoad', { n: m.teamCount, max: m.maxTeams })),
      teams.length ? assign(m) : null)) : emptyState(t('admin.noMentors'))),
    form);
}

// ---------------------------------------------------------------- resources
async function resourcesTab(ctx) {
  const { resources } = await api.get(`/hackathons/${ctx.h.id}/resources`);
  const form = submitForm(h('form', { class: 'form card' },
    h('h2', null, t('admin.addResource')),
    h('div', { class: 'grid-2' },
      field(t('admin.titleEn'), input('titleEn', '', { required: true })),
      field(t('admin.titleAr'), input('titleAr', '', { dir: 'rtl', lang: 'ar' })),
      field(t('admin.descriptionEn'), textarea('descriptionEn', '')),
      field(t('admin.descriptionAr'), textarea('descriptionAr', '', { dir: 'rtl', lang: 'ar' })),
      field(t('admin.url'), h('input', { type: 'url', name: 'url', required: true, placeholder: 'https://' })),
      field(t('admin.category'), h('select', { name: 'category' }, ['guide', 'template', 'tool', 'video', 'data', 'other'].map((c) => h('option', { value: c }, t(`resource.${c}`)))))),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'global' }), t('admin.globalResource')),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'submit' }, t('admin.addResource')))), async (v) => {
    await api.post(`/hackathons/${ctx.h.id}/resources`, v); refresh();
  });
  return h('div', { class: 'grid-2' },
    h('div', { class: 'stack' }, resources.length ? resources.map((r) => h('div', { class: 'card row row--between' },
      h('div', null, h('strong', null, pick(r, 'title')), ' ', badge(t(`resource.${r.category}`)), r.hackathonId ? null : badge(t('admin.global'), 'info'),
        h('div', { class: 'small muted' }, r.url)),
      h('button', {
        class: 'btn btn--ghost btn--small',
        onclick: (e) => busy(e.target, async () => { await api.del(`/resources/${r.id}`); refresh(); }),
      }, t('common.delete')))) : emptyState(t('toolbox.noResources'))),
    form);
}

// ---------------------------------------------------------------- audit
export async function auditTable(query) {
  const { entries } = await api.get(`/admin/audit?limit=200${query}`);
  if (!entries.length) return emptyState(t('admin.noAudit'));
  return h('div', { class: 'table-wrap' }, h('table', null,
    h('thead', null, h('tr', null, h('th', null, t('common.date')), h('th', null, t('admin.actor')), h('th', null, t('admin.action')), h('th', null, t('admin.details')))),
    h('tbody', null, entries.map((e) => h('tr', null,
      h('td', { class: 'small nowrap' }, fmtDate(e.at)),
      h('td', { class: 'small' }, e.actorName || '—'),
      h('td', null, h('code', null, e.action)),
      h('td', { class: 'small pre' }, Object.keys(e.details || {}).length ? JSON.stringify(e.details) : ''))))));
}

export async function adminHackathonView({ slug, tab = 'dashboard' }) {
  const ctx = await hackCtx(slug);
  if (!ctx.admin) return shell(ctx, 'admin', h('div', { class: 'notice notice--danger' }, t('error.ADMIN_ONLY')));
  if (!TABS.includes(tab)) tab = 'dashboard';
  const views = {
    dashboard: () => dashboardTab(ctx),
    milestones: () => milestonesTab(ctx),
    settings: () => settingsTab(ctx),
    timeline: () => timelineTab(ctx),
    announcements: () => announcementsTab(ctx),
    participants: () => participantsTab(ctx),
    rounds: () => roundsTab(ctx),
    mentors: () => mentorsTab(ctx),
    resources: () => resourcesTab(ctx),
    audit: () => auditTable(`&hackathonId=${ctx.h.id}`),
  };
  return shell(ctx, 'admin', h('div', { class: 'stack' }, subnav(slug, tab), await views[tab]()));
}

// ---------------------------------------------------------------- one round
export async function adminRoundView({ slug, roundId }) {
  const ctx = await hackCtx(slug);
  if (!ctx.admin) return shell(ctx, 'admin', h('div', { class: 'notice notice--danger' }, t('error.ADMIN_ONLY')));
  const { round, criteria, reviewers } = await api.get(`/rounds/${enc(roundId)}`);
  const draft = round.status === 'draft';
  const totalWeight = criteria.reduce((s, c) => s + Number(c.weight), 0);

  const criteriaCard = h('section', { class: 'card stack-sm' },
    h('div', { class: 'row row--between' }, h('h2', null, t('admin.criteria')), h('span', { class: 'muted small' }, t('admin.totalWeight', { w: fmtNum(totalWeight) }))),
    !draft ? h('p', { class: 'notice notice--warn small' }, t('admin.criteriaLocked')) : null,
    criteria.length ? h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, t('coach.criterion')), h('th', { class: 'num' }, t('admin.weight')), h('th', { class: 'num' }, t('admin.share')), h('th', { class: 'num' }, t('admin.scale')), h('th', null, ''))),
      h('tbody', null, criteria.map((c) => h('tr', null,
        h('td', null, pick(c, 'name'), h('div', { class: 'small muted' }, pick(c, 'description'))),
        h('td', { class: 'num' }, fmtNum(c.weight)),
        h('td', { class: 'num' }, totalWeight ? `${fmtNum((Number(c.weight) / totalWeight) * 100)}%` : '—'),
        h('td', { class: 'num nowrap' }, `${c.minScore}–${c.maxScore}`),
        h('td', null, draft ? h('button', {
          class: 'btn btn--ghost btn--small',
          onclick: (e) => busy(e.target, async () => { await api.del(`/criteria/${c.id}`); refresh(); }),
        }, t('common.delete')) : null)))))) : emptyState(t('admin.noCriteria')),
    draft ? submitForm(h('form', { class: 'form' },
      h('div', { class: 'grid-2' },
        field(t('admin.nameEn'), input('nameEn', '', { required: true })),
        field(t('admin.nameAr'), input('nameAr', '', { dir: 'rtl', lang: 'ar' })),
        field(t('admin.descriptionEn'), textarea('descriptionEn', '')),
        field(t('admin.descriptionAr'), textarea('descriptionAr', '', { dir: 'rtl', lang: 'ar' })),
        field(t('admin.weight'), h('input', { type: 'number', name: 'weight', min: 0.01, step: 'any', required: true, value: 10 })),
        h('div', { class: 'row' },
          field(t('admin.minScore'), h('input', { type: 'number', name: 'minScore', min: 0, value: 1 })),
          field(t('admin.maxScore'), h('input', { type: 'number', name: 'maxScore', min: 1, value: 5 })))),
      h('div', { class: 'form-actions' }, h('button', { class: 'btn btn--secondary', type: 'submit' }, t('admin.addCriterion')))), async (v) => {
      await api.post(`/rounds/${round.id}/criteria`, { ...v, sortOrder: criteria.length }); refresh();
    }) : null);

  const reviewersCard = h('section', { class: 'card stack-sm' },
    h('h2', null, t('admin.committee')),
    h('p', { class: 'small muted' }, t('admin.committeeHint')),
    reviewers.length ? h('ul', null, reviewers.map((r) => h('li', null,
      r.displayName, ' ', r.isChair ? badge(t('reviews.chair'), 'info') : null,
      h('span', { class: 'small muted' }, ` ${r.email || ''} · ${t('admin.submittedCount', { n: r.submitted })}`), ' ',
      round.status !== 'finalized' && !r.isChair ? h('button', {
        class: 'btn btn--ghost btn--small',
        onclick: (e) => busy(e.target, async () => { await api.post(`/rounds/${round.id}/reviewers`, { userId: r.userId, isChair: true }); refresh(); }),
      }, t('admin.makeChair')) : null,
      round.status !== 'finalized' ? h('button', {
        class: 'btn btn--ghost btn--small',
        onclick: (e) => busy(e.target, async () => { await api.del(`/rounds/${round.id}/reviewers/${r.userId}`); refresh(); }),
      }, t('team.remove')) : null))) : emptyState(t('admin.noReviewers')),
    round.status !== 'finalized' ? submitForm(h('form', { class: 'row' },
      h('input', { type: 'email', name: 'email', required: true, placeholder: t('auth.email'), 'aria-label': t('auth.email') }),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'isChair' }), t('reviews.chair')),
      h('button', { class: 'btn btn--secondary btn--small', type: 'submit' }, t('admin.addReviewer'))), async (v) => {
      await api.post(`/rounds/${round.id}/reviewers`, v); refresh();
    }) : null);

  let assignCard = null;
  if (round.assignmentMode === 'assigned' && ['draft', 'open'].includes(round.status)) {
    const { ideas } = await api.get(`/hackathons/${ctx.h.id}/ideas`);
    const candidates = ideas.filter((i) => i.status === 'submitted');
    assignCard = h('section', { class: 'card stack-sm' },
      h('h2', null, t('admin.assignments')),
      h('p', { class: 'small muted' }, t('admin.assignmentsHint')),
      candidates.length ? candidates.map((i) => {
        const sel = h('select', { multiple: true, 'aria-label': i.title, size: Math.min(4, reviewers.length || 1) },
          reviewers.map((r) => h('option', { value: r.userId }, r.displayName)));
        return h('div', { class: 'row' }, h('span', { class: 'spacer' }, i.title), sel, h('button', {
          class: 'btn btn--secondary btn--small',
          onclick: (e) => busy(e.target, async () => {
            await api.put(`/rounds/${round.id}/assignments/${i.id}`, { reviewerIds: [...sel.selectedOptions].map((o) => o.value) });
            toast(t('common.saved'));
          }),
        }, t('common.save')));
      }) : emptyState(t('ideas.none')));
  }

  const actions = h('div', { class: 'row' },
    round.status === 'draft' || round.status === 'closed' ? h('button', {
      class: 'btn',
      onclick: (e) => busy(e.target, async () => { await api.post(`/rounds/${round.id}/open`); toast(t('admin.roundOpened')); refresh(); }),
    }, round.status === 'draft' ? t('admin.openRound') : t('admin.reopenRound')) : null,
    round.status === 'open' ? h('button', {
      class: 'btn btn--secondary',
      onclick: async (e) => {
        if (!(await confirmDialog(t('admin.closeConfirm')))) return;
        busy(e.target, async () => { await api.post(`/rounds/${round.id}/close`); refresh(); });
      },
    }, t('admin.closeRound')) : null,
    round.status === 'finalized' ? h('button', {
      class: 'btn btn--secondary',
      onclick: (e) => busy(e.target, async () => { await api.post(`/rounds/${round.id}/publish`, { published: !round.resultsPublished }); refresh(); }),
    }, round.resultsPublished ? t('admin.unpublishResults') : t('admin.publishResults')) : null,
    round.status !== 'draft' ? h('a', { class: 'btn btn--ghost', href: `#/h/${enc(slug)}/reviews/${round.id}` }, t('board.title')) : null,
    draft ? h('button', {
      class: 'btn btn--danger',
      onclick: async (e) => {
        if (!(await confirmDialog(t('common.deleteConfirm'), { danger: true }))) return;
        busy(e.target, async () => { await api.del(`/rounds/${round.id}`); go(`h/${enc(slug)}/admin/rounds`); });
      },
    }, t('common.delete')) : null);

  return shell(ctx, 'admin',
    h('div', { class: 'stack' },
      subnav(slug, 'rounds'),
      h('div', { class: 'row' }, h('h2', null, pick(round, 'name')), roundBadge(round.status), badge(t(`roundKind.${round.kind}`))),
      h('p', { class: 'small muted' },
        t('admin.roundSummary', { min: round.minReviewers }), ' ',
        round.advanceCount !== null ? t('board.quota', { n: round.advanceCount }) : t('board.majority'), ' ',
        round.assignmentMode === 'assigned' ? t('admin.assign.assigned') : t('admin.assign.all')),
      actions,
      h('div', { class: 'grid-2' }, criteriaCard, h('div', { class: 'stack' }, reviewersCard, assignCard))));
}
