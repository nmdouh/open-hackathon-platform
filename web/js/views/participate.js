import { api, enc } from '../api.js';
import { t } from '../i18n.js';
import { h, field, busy, toast, formValues, splitList, badge, confirmDialog, fmtDate, pick } from '../ui.js';
import { refresh } from '../app.js';
import { hackCtx, shell } from './shell.js';

function registerForm(ctx) {
  const form = h('form', { class: 'form card' },
    h('h2', null, t('me.registerTitle')),
    h('fieldset', null, h('legend', null, t('me.chooseRole')),
      ['idea_owner', 'member'].map((role, i) => h('label', { class: 'check' },
        h('input', { type: 'radio', name: 'role', value: role, checked: i === 0 }),
        h('span', null, h('strong', null, t(`role.${role}`)), ' — ', t(`role.${role}.hint`))))),
    field(t('me.skills'), h('input', { type: 'text', name: 'skills', placeholder: t('me.skillsPlaceholder') }), t('me.skillsHint')),
    field(t('me.bio'), h('textarea', { name: 'bio', maxlength: 2000 })),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'submit' }, t('overview.register'))));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('[type=submit]'), async () => {
      const v = formValues(form);
      await api.post(`/hackathons/${ctx.h.id}/registration`, { role: v.role, skills: splitList(v.skills), bio: v.bio });
      toast(t('me.registered'));
      refresh();
    });
  });
  return form;
}

function registrationCard(ctx) {
  const reg = ctx.me.registration;
  const form = h('form', { class: 'form' },
    field(t('me.skills'), h('input', { type: 'text', name: 'skills', value: (reg.skills || []).join(', ') })),
    field(t('me.bio'), h('textarea', { name: 'bio', maxlength: 2000, value: reg.bio })),
    h('div', { class: 'form-actions' },
      h('button', { class: 'btn btn--secondary', type: 'submit' }, t('common.save')),
      h('button', {
        class: 'btn btn--danger', type: 'button',
        onclick: async (e) => {
          if (!(await confirmDialog(t('me.withdrawConfirm'), { danger: true, okLabel: t('me.withdraw') }))) return;
          busy(e.target, async () => { await api.del(`/hackathons/${ctx.h.id}/registration`); refresh(); });
        },
      }, t('me.withdraw'))));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('[type=submit]'), async () => {
      const v = formValues(form);
      await api.patch(`/hackathons/${ctx.h.id}/registration`, { skills: splitList(v.skills), bio: v.bio });
      toast(t('common.saved'));
    });
  });
  return h('section', { class: 'card stack-sm' },
    h('div', { class: 'row row--between' }, h('h2', null, t('me.yourRegistration')), badge(t(`role.${reg.role}`), 'info')),
    form);
}

export function ideaForm(ctx, idea) {
  const v = idea || {};
  const ta = (name, label, hint) => field(label, h('textarea', { name, maxlength: 6000, value: v[name] || '' }), hint);
  const form = h('form', { class: 'form' },
    field(t('idea.title'), h('input', { type: 'text', name: 'title', required: true, maxlength: 200, value: v.title || '' })),
    ctx.tracks.length ? field(t('idea.track'), h('select', { name: 'trackId' },
      h('option', { value: '' }, '—'),
      ctx.tracks.map((tr) => h('option', { value: tr.id, selected: tr.id === v.trackId }, pick(tr, 'name'))))) : null,
    ta('problem', t('idea.problem'), t('idea.problemHint')),
    ta('solution', t('idea.solution'), t('idea.solutionHint')),
    ta('targetUsers', t('idea.targetUsers')),
    ta('expectedImpact', t('idea.expectedImpact')),
    ta('dataAndTools', t('idea.dataAndTools')),
    h('div', { class: 'form-actions' },
      h('button', { class: 'btn btn--secondary', type: 'submit', value: 'save' }, t('idea.saveDraft')),
      !idea || idea.status === 'draft' ? h('button', { class: 'btn', type: 'submit', value: 'submit' }, t('idea.submit')) : null));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const submit = e.submitter && e.submitter.value === 'submit';
    busy(e.submitter, async () => {
      const body = formValues(form);
      body.trackId = body.trackId || null;
      if (idea) {
        await api.patch(`/ideas/${idea.id}`, body);
        if (submit) await api.post(`/ideas/${idea.id}/submit`);
      } else {
        await api.post(`/hackathons/${ctx.h.id}/ideas`, { ...body, submit });
      }
      toast(submit ? t('idea.submitted') : t('common.saved'));
      refresh();
    });
  });
  return form;
}

function ownerSection(ctx) {
  const idea = ctx.me.idea;
  const cards = [];
  cards.push(h('section', { class: 'card stack-sm' },
    h('div', { class: 'row row--between' },
      h('h2', null, t('me.yourIdea')),
      idea ? badge(t(`ideaStatus.${idea.status}`), idea.status === 'submitted' ? 'ok' : 'warn') : null),
    !ctx.h.ideaSubmissionOpen && !idea ? h('p', { class: 'notice notice--warn' }, t('me.ideaClosed')) : null,
    ctx.h.ideaSubmissionOpen ? ideaForm(ctx, idea) : idea ? h('a', { href: `#/h/${enc(ctx.slug)}/ideas/${idea.id}` }, idea.title) : null));
  if (idea && idea.status === 'submitted' && !ctx.teamId) {
    const form = h('form', { class: 'form' },
      field(t('team.name'), h('input', { type: 'text', name: 'name', required: true, maxlength: 120 })),
      field(t('team.lookingFor'), h('textarea', { name: 'lookingFor', maxlength: 2000 }), t('team.lookingForHint')),
      h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'submit' }, t('team.create'))));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(form.querySelector('[type=submit]'), async () => {
        await api.post(`/ideas/${idea.id}/team`, formValues(form));
        toast(t('team.created'));
        refresh();
      });
    });
    cards.push(h('section', { class: 'card stack-sm' }, h('h2', null, t('team.createTitle')), h('p', { class: 'muted' }, t('team.createLead')), form));
  }
  return cards;
}

function memberSection(ctx) {
  const apps = ctx.me.applications;
  return h('section', { class: 'card stack-sm' },
    h('h2', null, t('me.yourApplications')),
    !ctx.teamId ? h('p', null, h('a', { class: 'btn btn--secondary btn--small', href: `#/h/${enc(ctx.slug)}/teams` }, t('me.browseTeams'))) : null,
    apps.length ? h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, t('team.team')), h('th', null, t('common.status')), h('th', null, t('common.date')), h('th', null, ''))),
      h('tbody', null, apps.map((a) => h('tr', null,
        h('td', null, h('a', { href: `#/h/${enc(ctx.slug)}/teams/${a.teamId}` }, a.teamName)),
        h('td', null, badge(t(`appStatus.${a.status}`), a.status === 'accepted' ? 'ok' : a.status === 'pending' ? 'info' : '')),
        h('td', { class: 'small' }, fmtDate(a.createdAt)),
        h('td', null, a.status === 'pending' ? h('button', {
          class: 'btn btn--ghost btn--small',
          onclick: (e) => busy(e.target, async () => { await api.post(`/applications/${a.id}/withdraw`); refresh(); }),
        }, t('me.withdrawApplication')) : null)))))) : h('p', { class: 'muted' }, t('me.noApplications')));
}

export async function participateView({ slug }) {
  const ctx = await hackCtx(slug);
  if (!ctx.registered) {
    if (ctx.mentoring.isMentor) return shell(ctx, 'me', h('div', { class: 'notice' }, t('overview.youAreMentor')));
    return shell(ctx, 'me', ctx.h.registrationOpen
      ? h('div', { class: 'narrow' }, registerForm(ctx))
      : h('div', { class: 'notice notice--warn' }, t('overview.registrationClosed')));
  }
  const role = ctx.me.registration.role;
  return shell(ctx, 'me',
    h('div', { class: 'grid-2' },
      h('div', { class: 'stack' },
        ctx.teamId ? h('div', { class: 'notice notice--ok row row--between' },
          h('span', null, t('me.inTeam')),
          h('a', { class: 'btn btn--small', href: `#/h/${enc(slug)}/teams/${ctx.teamId}` }, t('me.openTeam'))) : null,
        role === 'idea_owner' ? ownerSection(ctx) : memberSection(ctx)),
      h('div', { class: 'stack' }, registrationCard(ctx))));
}
