# API overview

All endpoints are under `/api`, accept and return JSON, and use the session cookie set by `/api/auth/login`.
Errors look like `{ "error": { "code": "TEAM_FULL", "message": "..." } }`; the codes are stable and listed in `web/js/i18n.js`.

See the route files for the full list:

- `server/modules/auth/routes.js`: sign-up, sign-in, profile
- `server/modules/hackathons/routes.js`: hackathons, tracks, stages, announcements
- `server/modules/participation/routes.js`: registration, ideas, teams, applications
- `server/modules/governance/routes.js`: review rounds, criteria, committee, evaluations, decisions, results
- `server/modules/mentoring/routes.js`: mentors and mentoring requests
- `server/modules/toolbox/routes.js`: progress wall, pulse, resources, AI coach
- `server/modules/admin/routes.js`: users and audit log
