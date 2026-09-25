import { api, enc } from '../api.js';
import { t } from '../i18n.js';
import { h, badge, emptyState, busy, toast, field, formValues, fmtDate, confirmDialog, toLocalInput, fromLocalInput } from '../ui.js';
import { refresh } from '../app.js';
import { hackCtx, shell } from './shell.js';

const STATUS_BADGE = { open: 'info', accepted: 'ok', done: '', declined: 'warn', cancelled: '' };

function requestCard(ctx, r, { asMentor }) {
  const actions = [];
  if (asMentor && r.status === 'open') {
    const when = h('input', { type: 'datetime-local', 'aria-label': t('mentoring.scheduledAt'), value: toLocalInput(null) });
    actions.push(when,
      h('button', { class: 'btn btn--small', onclick: (e) => busy(e.target, async () => { await api.post(`/mentoring-requests/${r.id}/accept`, { scheduledAt: fromLocalInput(when.value) }); toast(t('mentoring.acceptedToast')); refresh(); }) }, t('mentoring.accept')));
    if (r.mentorId) actions.push(h('button', { class: 'btn btn--ghost btn--small', onclick: (e) => busy(e.target, async () => { await api.post(`/mentoring-requests/${r.id}/decline`); refresh(); }) }, t('mentoring.decline')));
  }
  if (asMentor && r.status === 'accepted') {
    actions.push(h('button', {
      class: 'btn btn--small',
      onclick: async (e) => {
        const notes = await confirmDialog(t('mentoring.completePrompt'), { withNote: true, notePlaceholder: t('mentoring.notes'), okLabel: t('mentoring.complete') });
        if (notes === null) return;
        busy(e.target, async () => { await api.post(`/mentoring-requests/${r.id}/complete`, { notes }); refresh(); });
      },
    }, t('mentoring.complete')));
  }
  if (!asMentor && ['open', 'accepted'].includes(r.status)) {
    actions.push(h('button', { class: 'btn btn--ghost btn--small', onclick: (e) => busy(e.target, async () => { await api.post(`/mentoring-requests/${r.id}/cancel`); refresh(); }) }, t('common.cancel')));
  }
  return h('article', { class: 'card stack-sm' },
    h('div', { class: 'row row--between' }, h('strong', null, r.topic), badge(t(`mentoring.status.${r.status}`), STATUS_BADGE[r.status])),
    h('div', { class: 'small muted' }, r.teamName, ' · ', r.requestedByName, ' · ', fmtDate(r.createdAt),
      r.mentorName ? ` · ${t('mentoring.mentor')}: ${r.mentorName}` : '',
      r.scheduledAt ? ` · ${t('mentoring.scheduledAt')}: ${fmtDate(r.scheduledAt)}` : ''),
    r.details ? h('p', { class: 'pre' }, r.details) : null,
    r.mentorNotes ? h('div', { class: 'notice' }, h('strong', null, t('mentoring.notes'), ': '), h('span', { class: 'pre' }, r.mentorNotes)) : null,
    actions.length ? h('div', { class: 'row' }, actions) : null);
}

export async function mentoringView({ slug }) {
  const ctx = await hackCtx(slug);
  const sections = [];
  if (ctx.teamId) {
    const [{ requests }, { mentors }] = await Promise.all([
      api.get(`/hackathons/${ctx.h.id}/mentoring/requests?teamId=${ctx.teamId}`),
      api.get(`/hackathons/${ctx.h.id}/mentors`),
    ]);
    const form = h('form', { class: 'form card' },
      h('h2', null, t('mentoring.askTitle')),
      field(t('mentoring.topic'), h('input', { type: 'text', name: 'topic', required: true, maxlength: 200 })),
      field(t('mentoring.details'), h('textarea', { name: 'details', maxlength: 4000 })),
      field(t('mentoring.preferredMentor'), h('select', { name: 'mentorId' },
        h('option', { value: '' }, t('mentoring.anyMentor')),
        mentors.map((m) => h('option', { value: m.userId }, `${m.displayName}${(m.expertise || []).length ? ` — ${m.expertise.join(', ')}` : ''}`)))),
      h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'submit' }, t('mentoring.send'))));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(form.querySelector('[type=submit]'), async () => {
        const v = formValues(form);
        await api.post(`/teams/${ctx.teamId}/mentoring-requests`, { ...v, mentorId: v.mentorId || null });
        toast(t('mentoring.sent'));
        refresh();
      });
    });
    sections.push(h('div', { class: 'grid-2' },
      h('div', { class: 'stack' }, h('h2', null, t('mentoring.teamRequests')),
        requests.length ? requests.map((r) => requestCard(ctx, r, { asMentor: false })) : emptyState(t('mentoring.noRequests'))),
      h('div', { class: 'stack' }, form)));
  }
  if (ctx.mentoring.isMentor || ctx.admin) {
    const { requests } = await api.get(`/hackathons/${ctx.h.id}/mentoring/requests`);
    sections.push(h('div', { class: 'stack' },
      h('h2', { class: 'section-title' }, ctx.mentoring.isMentor ? t('mentoring.queue') : t('mentoring.allRequests')),
      ctx.mentoring.teams.length ? h('p', { class: 'muted' }, t('mentoring.yourTeams'), ': ', ctx.mentoring.teams.map((x) => x.name).join(', ')) : null,
      requests.length ? h('div', { class: 'grid' }, requests.map((r) => requestCard(ctx, r, { asMentor: ctx.mentoring.isMentor }))) : emptyState(t('mentoring.noRequests'))));
  }
  return shell(ctx, 'mentoring', h('p', { class: 'muted' }, t('mentoring.lead')), ...sections);
}
