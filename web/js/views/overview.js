import { api } from '../api.js';
import { t } from '../i18n.js';
import { h, pick, fmtDate, badge, emptyState, fmtNum } from '../ui.js';
import { state } from '../state.js';
import { hackCtx, shell, statusBadge } from './shell.js';
import { journeyData, journey, nextStepCard } from './journey.js';

function stageClass(s) {
  const now = Date.now();
  const start = s.startsAt ? new Date(s.startsAt).getTime() : null;
  const end = s.endsAt ? new Date(s.endsAt).getTime() : null;
  if (end && end < now) return 'is-done';
  if (start && start <= now && (!end || end >= now)) return 'is-now';
  return '';
}

// The moment that matters next: the end of the current stage, or the start
// of the next one, falling back to the registration deadline.
function nextMoment(ctx) {
  const now = Date.now();
  for (const s of ctx.stages) {
    const start = s.startsAt ? new Date(s.startsAt).getTime() : null;
    const end = s.endsAt ? new Date(s.endsAt).getTime() : null;
    if (start && start > now) return { at: start, label: t('countdown.starts', { name: pick(s, 'name') }) };
    if (end && end > now && (!start || start <= now)) return { at: end, label: t('countdown.ends', { name: pick(s, 'name') }) };
  }
  if (ctx.h.registrationClosesAt && new Date(ctx.h.registrationClosesAt).getTime() > now) {
    return { at: new Date(ctx.h.registrationClosesAt).getTime(), label: t('countdown.registration') };
  }
  return null;
}

function countdown(moment) {
  if (!moment) return null;
  const parts = ['days', 'hours', 'minutes', 'seconds'].map((k) => {
    const v = h('strong', null, '0');
    return { k, v, el: h('div', null, v, h('span', null, t(`countdown.${k}`))) };
  });
  const root = h('div', null, h('div', { class: 'countdown__label' }, moment.label),
    h('div', { class: 'countdown', role: 'timer', 'aria-live': 'off' }, parts.map((p) => p.el)));
  const tick = () => {
    const s = Math.max(0, Math.floor((moment.at - Date.now()) / 1000));
    const vals = [Math.floor(s / 86400), Math.floor((s % 86400) / 3600), Math.floor((s % 3600) / 60), s % 60];
    parts.forEach((p, i) => { p.v.textContent = String(vals[i]).padStart(2, '0'); });
  };
  tick();
  const timer = setInterval(() => {
    if (!root.isConnected && root.dataset.mounted) { clearInterval(timer); return; }
    if (root.isConnected) root.dataset.mounted = '1';
    tick();
  }, 1000);
  return root;
}

function statTiles(stats) {
  const tile = (n, label, accent) => h('div', { class: `tile${accent ? ' tile--accent' : ''}` }, h('strong', null, fmtNum(n, 0)), h('span', null, label));
  return h('div', { class: 'tiles' },
    tile(stats.participants, t('stats.participants')),
    tile(stats.ideas, t('stats.ideas')),
    tile(stats.teams, t('stats.teams')),
    tile(stats.mentors, t('stats.mentors')),
    tile(stats.openSpots, t('stats.openSpots'), stats.openSpots > 0));
}

const MEDALS = ['🥇', '🥈', '🥉'];
function resultsCard(rounds) {
  if (!rounds.length) return null;
  return h('section', { class: 'card stack' },
    h('h2', null, t('overview.results')),
    rounds.map((r) => {
      const ranked = r.advanced.filter((a) => a.rank).sort((a, b) => a.rank - b.rank);
      const podium = r.kind === 'final' && ranked.length >= 3;
      return h('div', { class: 'stack-sm' },
        h('h3', null, pick(r, 'name')),
        r.myOutcome ? h('p', null, t('overview.yourOutcome'), ' ', badge(t(`outcome.${r.myOutcome}`), r.myOutcome === 'advance' ? 'ok' : r.myOutcome === 'reject' ? 'danger' : 'warn')) : null,
        podium ? h('div', { class: 'podium', role: 'list' },
          [1, 0, 2].map((i) => h('div', { class: `p${i + 1}`, role: 'listitem' },
            h('span', { class: 'medal', 'aria-hidden': 'true' }, MEDALS[i]),
            h('strong', null, ranked[i].title),
            ranked[i].teamName ? h('span', { class: 'small' }, ranked[i].teamName) : null))) : null,
        h('ol', { start: podium ? 4 : 1 }, (podium ? r.advanced.filter((a) => !ranked.slice(0, 3).includes(a)) : r.advanced)
          .map((a) => h('li', null, a.title, a.teamName ? h('span', { class: 'muted' }, ` — ${a.teamName}`) : null))));
    }));
}

export async function overviewView({ slug }) {
  const ctx = await hackCtx(slug);
  const [ann, stats, jd] = await Promise.all([
    api.get(`/hackathons/${ctx.h.id}/announcements`),
    api.get(`/hackathons/${ctx.h.id}/stats`),
    journeyData(ctx),
  ]);
  const x = ctx.h;
  const j = journey(ctx, jd);
  const moment = nextMoment(ctx);
  const banner = h('section', { class: 'banner' },
    h('div', { class: 'banner__row' },
      h('div', null,
        statusBadge(x.status),
        h('h1', null, pick(x, 'title')),
        pick(x, 'summary') ? h('p', { class: 'pre' }, pick(x, 'summary')) : null,
        j.next ? h('div', { class: 'row' }, h('a', { class: 'btn', href: j.next.href }, j.next.label)) : null),
      countdown(moment)));

  return shell(ctx, 'overview',
    banner,
    statTiles(stats.stats),
    state.user && j.next ? nextStepCard(j.next) : null,
    h('div', { class: 'grid-2' },
      h('div', { class: 'stack' },
        resultsCard(jd.results),
        h('section', { class: 'card' },
          h('h2', null, t('overview.announcements')),
          ann.announcements.length
            ? h('div', { class: 'stack' }, ann.announcements.map((a) => h('article', null,
              h('div', { class: 'row' }, h('h3', null, pick(a, 'title')), a.pinned ? badge(t('overview.pinned'), 'info') : null),
              h('div', { class: 'small muted' }, fmtDate(a.createdAt)),
              pick(a, 'body') ? h('p', { class: 'pre' }, pick(a, 'body')) : null)))
            : emptyState(t('overview.noAnnouncements'))),
        ctx.tracks.length ? h('section', { class: 'card' },
          h('h2', null, t('overview.tracks')),
          h('div', { class: 'grid' }, ctx.tracks.map((tr) => h('div', null,
            h('h3', null, pick(tr, 'name')),
            pick(tr, 'description') ? h('p', { class: 'muted pre small' }, pick(tr, 'description')) : null)))) : null),
      h('div', { class: 'stack' },
        h('section', { class: 'card' },
          h('h2', null, t('overview.timeline')),
          ctx.stages.length
            ? h('ol', { class: 'timeline' }, ctx.stages.map((s) => h('li', { class: stageClass(s) },
              h('strong', null, pick(s, 'name')),
              h('div', { class: 'small muted' }, `${fmtDate(s.startsAt)}${s.endsAt ? ` → ${fmtDate(s.endsAt)}` : ''}`))))
            : h('p', { class: 'muted' }, t('overview.noTimeline'))),
        h('section', { class: 'card' },
          h('h2', null, t('overview.keyFacts')),
          h('dl', { class: 'kv' },
            h('dt', null, t('overview.registration')),
            h('dd', null, `${fmtDate(x.registrationOpensAt)} → ${fmtDate(x.registrationClosesAt)}`),
            h('dt', null, t('overview.ideaDeadline')), h('dd', null, fmtDate(x.ideaSubmissionClosesAt)),
            h('dt', null, t('overview.teamSize')), h('dd', null, t('overview.teamSizeValue', { min: x.minTeamSize, max: x.maxTeamSize })),
            stats.stats.lookingForTeam ? [h('dt', null, t('stats.lookingForTeam')), h('dd', null, fmtNum(stats.stats.lookingForTeam, 0))] : null)))));
}
