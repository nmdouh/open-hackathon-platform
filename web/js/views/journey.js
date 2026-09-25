import { api, enc } from '../api.js';
import { t } from '../i18n.js';
import { h, pick } from '../ui.js';
import { state } from '../state.js';

// Loads the extra data the journey needs for the signed-in participant.
export async function journeyData(ctx) {
  const out = { team: null, members: [], milestones: [], results: [] };
  if (!state.user) return out;
  const tasks = [api.get(`/hackathons/${ctx.h.id}/results`).then((r) => { out.results = r.rounds; })];
  if (ctx.teamId) {
    tasks.push(api.get(`/teams/${ctx.teamId}`).then((r) => { out.team = r.team; out.members = r.members; }));
    tasks.push(api.get(`/teams/${ctx.teamId}/milestones`).then((r) => { out.milestones = r.milestones; }));
  }
  await Promise.all(tasks);
  return out;
}

// Six steps every participant goes through, with the current one marked,
// plus the single most useful next action.
export function journey(ctx, jd) {
  const me = ctx.me || {};
  const reg = me.registration;
  const owner = reg && reg.role === 'idea_owner';
  const ideaDone = Boolean(me.idea && me.idea.status === 'submitted');
  const inTeam = Boolean(ctx.teamId);
  const teamReady = inTeam && jd.members.length >= ctx.h.minTeamSize;
  const msDone = jd.milestones.filter((m) => m.doneAt).length;
  const msTotal = jd.milestones.length;
  const built = msTotal ? msDone === msTotal : false;
  const published = jd.results.length > 0;

  const steps = [
    ['register', Boolean(reg)],
    [owner ? 'idea' : 'join', owner ? ideaDone : inTeam],
    ['team', teamReady],
    ['build', built],
    ['pitch', published || built],
    ['results', published],
  ];
  const firstOpen = steps.findIndex(([, done]) => !done);
  const stepper = steps.map(([key, done], i) => ({ key, state: done ? 'done' : i === firstOpen ? 'current' : 'todo' }));

  const base = `#/h/${enc(ctx.slug)}`;
  let next = null;
  const pendingInvites = (me.applications || []).filter((a) => a.direction === 'invite' && a.status === 'pending');
  if (!state.user) next = { text: t('next.signIn'), href: `#/login?next=${enc(`h/${ctx.slug}`)}`, label: t('nav.login') };
  else if (ctx.mentoring.isMentor) next = { text: t('next.mentor'), href: `${base}/mentoring`, label: t('tab.mentoring') };
  else if (!reg) {
    next = ctx.h.registrationOpen ? { text: t('next.register'), href: `${base}/me`, label: t('overview.register') } : null;
  } else if (owner && !ideaDone) next = { text: t('next.submitIdea'), href: `${base}/me`, label: t('idea.submit') };
  else if (owner && !inTeam) next = { text: t('next.createTeam'), href: `${base}/me`, label: t('team.create') };
  else if (!owner && !inTeam && pendingInvites.length) next = { text: t('next.answerInvites', { n: pendingInvites.length }), href: `${base}/me`, label: t('me.invitations') };
  else if (!owner && !inTeam) next = { text: t('next.findTeam'), href: `${base}/me`, label: t('match.seeSuggestions') };
  else if (!teamReady && owner) next = { text: t('next.recruit', { n: ctx.h.minTeamSize - jd.members.length }), href: `${base}/me`, label: t('match.seeSuggestions') };
  else if (msTotal && !built) {
    const m = jd.milestones.find((x) => !x.doneAt);
    next = { text: t('next.milestone', { title: pick(m, 'title') }), href: `${base}/teams/${ctx.teamId}`, label: t('milestones.open') };
  } else if (!published) next = { text: t('next.rehearse'), href: `${base}/toolbox?tab=timer`, label: t('toolbox.tab.timer') };
  else next = { text: t('next.results'), href: base, label: t('overview.results') };
  return { stepper, next, msDone, msTotal };
}

export function stepperView(j) {
  return h('ol', { class: 'stepper', 'aria-label': t('journey.title') },
    j.stepper.map((s) => h('li', { class: s.state === 'done' ? 'is-done' : s.state === 'current' ? 'is-current' : '', 'aria-current': s.state === 'current' ? 'step' : null },
      t(`journey.${s.key}`))));
}

export function nextStepCard(next) {
  if (!next) return null;
  return h('section', { class: 'card next-step' },
    h('div', null, h('div', { class: 'next-step__eyebrow' }, t('next.title')), h('div', { class: 'pre' }, next.text)),
    h('a', { class: 'btn', href: next.href }, next.label));
}
