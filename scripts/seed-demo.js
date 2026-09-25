'use strict';

// Fills a development database with a demo hackathon so every screen has
// something to show. Development only: the accounts use a shared, published
// password. Run with `npm run dev -- --seed`. Safe to run twice.

const { createPool } = require('../server/db/pool');
const { migrate } = require('../server/db/migrate');
const { hashPassword } = require('../server/lib/password');
const p = require('../server/modules/participation/service');
const g = require('../server/modules/governance/service');
const m = require('../server/modules/mentoring/service');
const tb = require('../server/modules/toolbox/service');
const en = require('../server/modules/engagement/service');

const DEMO_PASSWORD = 'demo-password-2026';
const SLUG = 'open-innovation-2026';

const PEOPLE = [
  ['admin@example.org', 'Demo Admin', 'admin'],
  ['layla@example.org', 'Layla Hassan'], ['omar@example.org', 'Omar Farouk'], ['sara@example.org', 'Sara Lopez'],
  ['yusuf@example.org', 'Yusuf Ali'], ['mei@example.org', 'Mei Chen'], ['noura@example.org', 'Noura Saleh'],
  ['david@example.org', 'David Mensah'], ['amina@example.org', 'Amina Idris'],
  ['mentor@example.org', 'Rana Mentor'], ['chair@example.org', 'Khalid Chair'], ['reviewer@example.org', 'Grace Reviewer'],
];

const IDEAS = [
  ['layla@example.org', 'Clinic queue predictor', 0,
    'Patients wait over 90 minutes on average at walk-in clinics, and staff cannot see the peak coming.',
    'Forecast arrivals per hour from past visits and nudge patients to quieter slots by SMS.'],
  ['omar@example.org', 'Plain-language letters', 2,
    'One in three official letters triggers a follow-up call because readers cannot tell what to do next.',
    'Rewrite letters into plain language with a clear next step, with a person approving every template.'],
  ['sara@example.org', 'Study buddy matcher', 1,
    'First-year students who study alone drop out twice as often as those in study groups.',
    'Match students into small groups by course, schedule and learning style, and suggest weekly goals.'],
];

async function seedDemo(databaseUrl) {
  const pool = createPool(databaseUrl);
  try {
    await migrate(pool);
    const exists = await pool.query('SELECT 1 FROM hackathons WHERE slug = $1', [SLUG]);
    if (exists.rows.length) {
      console.log(`Demo data already present (hackathon "${SLUG}").`);
      return;
    }
    const hash = await hashPassword(DEMO_PASSWORD);
    const users = {};
    for (const [email, name, role = 'user'] of PEOPLE) {
      const { rows } = await pool.query(
        `INSERT INTO users (email, display_name, password_hash, role) VALUES ($1, $2, $3, $4)
         ON CONFLICT (lower(email)) DO UPDATE SET display_name = EXCLUDED.display_name RETURNING id, role, display_name`,
        [email, name, hash, role],
      );
      users[email] = rows[0];
    }
    const admin = users['admin@example.org'];
    const day = 24 * 3600 * 1000;
    const at = (d) => new Date(Date.now() + d * day).toISOString();

    const { rows: [h] } = await pool.query(
      `INSERT INTO hackathons (slug, title_en, title_ar, summary_en, summary_ar, status,
         registration_opens_at, registration_closes_at, idea_submission_closes_at, min_team_size, max_team_size, created_by)
       VALUES ($1, 'Open Innovation Challenge 2026', 'تحدي الابتكار المفتوح 2026',
         'A ten-day challenge to build working prototypes that make public services faster, fairer and easier to use.',
         'تحدٍّ لمدة عشرة أيام لبناء نماذج أولية تعمل، تجعل الخدمات العامة أسرع وأعدل وأسهل استخداماً.',
         'open', $2, $3, $4, 2, 4, $5) RETURNING *`,
      [SLUG, at(-5), at(10), at(3), admin.id],
    );
    const tracks = [];
    for (const [i, [en, ar]] of [['Health', 'الصحة'], ['Education', 'التعليم'], ['Public services', 'الخدمات العامة']].entries()) {
      const { rows } = await pool.query(
        'INSERT INTO tracks (hackathon_id, name_en, name_ar, sort_order) VALUES ($1, $2, $3, $4) RETURNING id', [h.id, en, ar, i],
      );
      tracks.push(rows[0].id);
    }
    const stages = [
      ['Registration and ideas', 'التسجيل وتقديم الأفكار', -5, 3], ['Screening', 'الفرز', 3, 4],
      ['Build days', 'أيام البناء', 4, 14], ['Final pitches', 'العروض النهائية', 14, 15],
    ];
    for (const [i, [en, ar, s, e]] of stages.entries()) {
      await pool.query('INSERT INTO stages (hackathon_id, name_en, name_ar, starts_at, ends_at, sort_order) VALUES ($1, $2, $3, $4, $5, $6)',
        [h.id, en, ar, at(s), at(e), i]);
    }
    await pool.query(
      `INSERT INTO announcements (hackathon_id, title_en, title_ar, body_en, body_ar, pinned, created_by) VALUES
       ($1, 'Welcome to the challenge', 'مرحباً بكم في التحدي',
        'Submit your idea before the deadline, or join a team that needs your skills. Mentors are available every day.',
        'قدّم فكرتك قبل الموعد النهائي، أو انضم إلى فريق يحتاج مهاراتك. المرشدون متاحون كل يوم.', true, $2)`,
      [h.id, admin.id],
    );
    await pool.query(
      `INSERT INTO resources (hackathon_id, category, title_en, title_ar, description_en, description_ar, url) VALUES
       ($1, 'guide', 'Web accessibility basics', 'أساسيات إتاحة الويب', 'Short introduction from W3C.', 'مقدمة قصيرة من W3C.',
        'https://www.w3.org/WAI/fundamentals/accessibility-intro/')`,
      [h.id],
    );

    const u = (email) => ({ ...users[email], id: users[email].id });
    const teams = [];
    for (const [email, title, track, problem, solution] of IDEAS) {
      await p.register(pool, u(email), h.id, { role: 'idea_owner', skills: ['product'] });
      const idea = await p.createIdea(pool, u(email), h.id, {
        title, problem, solution, trackId: tracks[track], targetUsers: 'Residents and front-line staff', expectedImpact: 'Measured before and after with pilot users.',
      }, { submit: true });
      teams.push({ owner: email, idea, team: await p.createTeam(pool, u(email), idea.id, { name: `${title} team`, lookingFor: 'Frontend, data analysis' }) });
    }
    const members = [['yusuf@example.org', ['python', 'data']], ['mei@example.org', ['design', 'research']],
      ['noura@example.org', ['frontend']], ['david@example.org', ['backend']], ['amina@example.org', ['testing']]];
    for (const [email, skills] of members) await p.register(pool, u(email), h.id, { role: 'member', skills });
    const join = async (email, t) => {
      const app = await p.apply(pool, u(email), t.team.id, { message: 'I would love to help.' });
      await p.decide(pool, u(t.owner), app.id, 'accepted');
    };
    await join('yusuf@example.org', teams[0]);
    await join('mei@example.org', teams[0]);
    await join('noura@example.org', teams[1]);
    await p.apply(pool, u('david@example.org'), teams[2].team.id, { message: 'Backend developer, free every evening.' });
    await p.invite(pool, u('sara@example.org'), teams[2].team.id, { userId: users['amina@example.org'].id, message: 'We need a tester who asks hard questions.' });

    await en.applyMilestoneTemplate(pool, admin, h.id);
    const { rows: ms } = await pool.query('SELECT id FROM milestones WHERE hackathon_id = $1 ORDER BY sort_order', [h.id]);
    await pool.query('UPDATE milestones SET due_at = $2 WHERE id = $1', [ms[0].id, at(1)]);
    for (const [teamIndex, count] of [[0, 3], [1, 1]]) {
      for (const m of ms.slice(0, count)) {
        await en.setTeamMilestone(pool, u(teams[teamIndex].owner), teams[teamIndex].team.id, m.id, { done: true, evidenceUrl: '' });
      }
    }

    await m.addMentor(pool, admin, h.id, { email: 'mentor@example.org', expertise: ['product', 'data'], maxTeams: 3 });
    const req = await m.createRequest(pool, u('layla@example.org'), teams[0].team.id, { topic: 'Choosing a forecasting model', details: 'We have two years of hourly visits.' });
    await m.mentorAction(pool, u('mentor@example.org'), req.id, 'accept', { scheduledAt: at(1) });

    await pool.query("UPDATE hackathons SET status = 'running' WHERE id = $1", [h.id]);
    await tb.createPost(pool, u('layla@example.org'), teams[0].team.id, { kind: 'demo', body: 'First forecast is live on last month’s data.', linkUrl: '', visibility: 'public' });
    await tb.createPost(pool, u('omar@example.org'), teams[1].team.id, { kind: 'help', body: 'Looking for someone to review our plain-language rules for an hour.', linkUrl: '', visibility: 'public' });
    await pool.query("UPDATE teams SET created_at = now() - interval '3 days' WHERE id = $1", [teams[2].team.id]);

    const round = await g.createRound(pool, admin, h.id, {
      kind: 'screening', nameEn: 'Idea screening', nameAr: 'فرز الأفكار', sourceRoundId: null,
      assignmentMode: 'all', minReviewers: 2, advanceCount: 2, sortOrder: 0, useTemplate: true,
    });
    await g.addReviewer(pool, admin, round.id, { email: 'chair@example.org', isChair: true });
    await g.addReviewer(pool, admin, round.id, { email: 'reviewer@example.org', isChair: false });
    await g.transition(pool, admin, round.id, 'open');
    const { rows: criteria } = await pool.query('SELECT id FROM round_criteria WHERE round_id = $1 ORDER BY sort_order', [round.id]);
    const vote = (email, idea, score, recommendation) => g.saveEvaluation(pool, u(email), round.id, idea.id, {
      scores: Object.fromEntries(criteria.map((c, i) => [c.id, Math.max(1, Math.min(5, score + (i % 2)))])),
      comment: '', recommendation, submit: true, conflict: false,
    });
    await vote('chair@example.org', teams[0].idea, 4, 'advance');
    await vote('reviewer@example.org', teams[0].idea, 4, 'advance');
    await vote('chair@example.org', teams[1].idea, 3, 'hold');

    console.log('Demo data created. Sign in with any of these (password for all: %s):', DEMO_PASSWORD);
    console.log('  admin@example.org     administrator');
    console.log('  layla@example.org     idea owner with a team');
    console.log('  david@example.org     member with a pending application');
    console.log('  mentor@example.org    mentor');
    console.log('  chair@example.org     screening committee chair');
  } finally {
    await pool.end();
  }
}

module.exports = { seedDemo, DEMO_PASSWORD };
