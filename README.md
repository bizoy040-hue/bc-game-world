# BC GAME WORLD – Agent Registration + Admin Dashboard

Node.js + Express + SQLite. No build step.

## Run locally
```bash
npm install
cp .env.example .env      # then edit values (JWT_SECRET must be 32+ chars)
npm start                 # http://localhost:3000
```
Admin: click **Login** (top right) and use ADMIN_USERNAME / ADMIN_PASSWORD from `.env`.
The database (`data/app.db`) and tables are created automatically on first start. The admin password is hashed with bcrypt and re-synced from `.env` on every start (change the env value to rotate the password).

## Deploy (Render / Railway / any VPS)
1. Push this folder to a Git repo.
2. Create a Node web service. Build: `npm install`. Start: `npm start`.
3. Set env vars: `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `JWT_SECRET`, `NODE_ENV=production`.
4. Attach a **persistent disk** and set `DATA_DIR` to its mount path (e.g. `/data`), otherwise the SQLite file is lost on redeploy.
5. Serve over HTTPS (Render/Railway do this automatically; on a VPS use Caddy or Nginx + Let's Encrypt, proxying to the Node port).

## Security notes
- Admin session: httpOnly, SameSite=Strict, Secure (production) cookie, 2-hour expiry.
- Rate limits: 10 submissions/hour/IP, 10 login attempts/15 min/IP.
- Duplicate protection: one application per email.
- CSV export neutralises spreadsheet formula injection.
- Back up `data/app.db` regularly.
