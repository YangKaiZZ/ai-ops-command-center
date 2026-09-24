# AI Ops Command Center: deploying to a VPS

Runs the whole app on one Linux server with Docker Compose:

| Service | What it does |
|---|---|
| `caddy` | The only thing open to the internet (ports 80 and 443). Gets and renews the HTTPS certificate. Sends `/api/*` to the backend and everything else to the dashboard. |
| `dashboard` | The Next.js dashboard ([ai-ops-dashboard](../ai-ops-dashboard)). |
| `backend` | The Express API ([ai-ops-backend](../ai-ops-backend)), with the MCP server ([ai-ops-mcp](../ai-ops-mcp)) built into the same image: the agent starts it as a subprocess for each run. Runs the database migrations each time it starts. |
| `mysql` | MySQL 8.4. Data lives in the `mysql-data` volume. |

Everything is served from one domain: `https://<DOMAIN>/` is the dashboard,
`https://<DOMAIN>/api/...` is the API, including Shopify's install link,
OAuth callback and webhooks.

## 1. A server

- A VPS with Ubuntu 24.04 (or any Linux with Docker), **2 GB of RAM** or more
  (MySQL alone uses about 500 MB), and a public IPv4 address.
- Install Docker Engine with the Compose plugin:
  ```bash
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker $USER   # then log out and back in
  ```
- Open only SSH, HTTP and HTTPS:
  ```bash
  sudo ufw allow OpenSSH && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw enable
  ```
  Docker publishes only Caddy's ports; MySQL, the backend and the dashboard
  are reachable only inside Compose's private network.

## 2. A domain

Add a DNS **A record** for the domain you'll use (e.g. `ops.example.com`)
pointing at the server's IP. Caddy can only get a certificate once this
resolves, so do it first. Check with `ping ops.example.com`.

## 3. The code

The four repos sit side by side (the paths are set in `.env`):

```
/opt/ai-ops/
  ai-ops-deploy/      this folder: docker-compose.yml, Caddyfile, .env
  ai-ops-backend/
  ai-ops-dashboard/
  ai-ops-mcp/
```

**Option A, GitHub (recommended, makes updates a `git pull`).** Push each repo
to a private GitHub repository, then on the server:

```bash
sudo mkdir -p /opt/ai-ops && sudo chown $USER /opt/ai-ops && cd /opt/ai-ops
for repo in ai-ops-deploy ai-ops-backend ai-ops-dashboard ai-ops-mcp; do
  git clone git@github.com:<you>/$repo.git
done
```

The server needs read access to the private repos: add its SSH key
(`ssh-keygen -t ed25519`, then `cat ~/.ssh/id_ed25519.pub`) to your GitHub
account, or as a read-only deploy key on each repo.

**Option B, copy from your computer.** In each repo on your computer, make an
archive of the committed code (this leaves out `node_modules` and `.env`),
then copy and unpack it on the server:

```bash
git archive --format=tar.gz -o ai-ops-backend.tar.gz HEAD
scp ai-ops-backend.tar.gz you@server:/opt/ai-ops/
ssh you@server "mkdir -p /opt/ai-ops/ai-ops-backend && tar -xzf /opt/ai-ops/ai-ops-backend.tar.gz -C /opt/ai-ops/ai-ops-backend"
```

## 4. Settings

```bash
cd /opt/ai-ops/ai-ops-deploy
cp .env.example .env
# Fill in the four secrets with random values:
for v in JWT_SECRET ENCRYPTION_KEY DB_PASSWORD MYSQL_ROOT_PASSWORD; do
  sed -i "s|^$v=$|$v=$(openssl rand -hex 32)|" .env
done
nano .env   # DOMAIN, the Shopify app keys, DEEPSEEK_API_KEY, alert settings
```

- **Keep a copy of `.env` somewhere safe** (a password manager).
  `ENCRYPTION_KEY` in particular: without it the stored Shopify tokens can't
  be read, and every store has to be connected again.
- `TELEGRAM_BOT_TOKEN`: only one backend can use a bot at a time, so give the
  server its own bot, not the one your local backend uses.
- Leave a setting blank to turn that feature off: blank email or Telegram
  settings hide those channels in Settings, and without the Shopify keys
  sellers connect with a pasted Admin API token instead.

## 5. Start it

```bash
docker compose up -d --build
docker compose ps                 # all four "running"; mysql and backend "healthy"
docker compose logs -f backend    # "Database is up to date." then "AI Ops backend running on port 3000"
```

The first start takes a few minutes: it builds the two images, and MySQL
creates the tables. Then open `https://<DOMAIN>/signup` and create your
account. The first request can take a few seconds while Caddy gets the
certificate.

## 6. Point the Shopify app at the server

In the Shopify Dev Dashboard, in your app's settings (replace the domain):

| Setting | Value |
|---|---|
| App URL | `https://ops.example.com/api/shopify/install` |
| Allowed redirection URL | `https://ops.example.com/api/shopify/callback` |
| Compliance webhooks (all three) | `https://ops.example.com/api/webhooks/compliance` |

The order and inventory webhooks don't need setting up: the backend registers
them on each store when it connects.

## 7. Claude Desktop (optional)

To use the MCP tools against the live server, create an API key in the live
dashboard (Settings, API keys) and put these in your local `ai-ops-mcp/.env`:

```
BACKEND_URL=https://ops.example.com
BACKEND_API_KEY=aiops_...
```

## Updating

```bash
cd /opt/ai-ops
for repo in ai-ops-deploy ai-ops-backend ai-ops-dashboard ai-ops-mcp; do git -C $repo pull; done
cd ai-ops-deploy && docker compose up -d --build
```

Only the images that changed are rebuilt. Database migrations run when the
backend starts. Old images pile up over time; `docker image prune` removes them.

## Backups

`scripts/backup.sh` saves the database to `backups/ai_ops-<date>.sql.gz` and
keeps the newest 14. Run it daily from cron (`crontab -e`):

```
30 3 * * * /opt/ai-ops/ai-ops-deploy/scripts/backup.sh >> /opt/ai-ops/ai-ops-deploy/backups/backup.log 2>&1
```

Copy the backups off the server now and then (e.g. `scp`), because a backup
on the same disk is lost along with the server. To restore one, which
**replaces** the current data:

```bash
gunzip -c backups/ai_ops-20260101-033000.sql.gz \
  | docker compose exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" exec mysql -u "$MYSQL_USER" "$MYSQL_DATABASE"'
```

A backup is only readable with the same `ENCRYPTION_KEY` it was made under.

## Moving your local data over (optional)

The server starts with an empty database. To bring your local sellers,
orders and decisions along instead:

1. Put your local `JWT_SECRET` and `ENCRYPTION_KEY` in the server's `.env`
   (the stored Shopify tokens are encrypted with that key).
2. Dump the local database. On Windows, in the MySQL `bin` folder:
   `mysqldump --no-tablespaces -u root -p ai_ops > ai_ops.sql`
3. Copy `ai_ops.sql` to the server and load it:
   `docker compose exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" exec mysql -u "$MYSQL_USER" "$MYSQL_DATABASE"' < ai_ops.sql`
4. `docker compose restart backend` (it migrates the data if needed).
5. Point each connected store's webhooks at the server instead of your ngrok
   tunnel: `docker compose exec backend node scripts/register-webhooks.js https://ops.example.com`

## When something's wrong

- **Look at the logs first:** `docker compose logs --tail 100 backend`
  (or `caddy`, `dashboard`, `mysql`).
- **The build stops at `npm ci` with `ECONNRESET`:** a dropped download.
  Run the same command again.
- **The backend keeps restarting:** it stops at start-up when a required
  setting is missing or wrong (`JWT_SECRET`, `ENCRYPTION_KEY`) or a migration
  fails; the log says which.
- **No certificate / the browser warns:** the DNS record isn't pointing at the
  server yet, or ports 80/443 are closed. `docker compose logs caddy` shows
  why. After fixing it, `docker compose restart caddy`.
- **502 Bad Gateway:** the backend or dashboard isn't running; check
  `docker compose ps`.
- **A shell in a container:** `docker compose exec backend sh`.
- **The database directly:**
  `docker compose exec mysql sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" mysql -u "$MYSQL_USER" "$MYSQL_DATABASE"'`

## Try it locally

With Docker Desktop, you can run the same stack on your own computer. Make an
`.env` with `DOMAIN=localhost`, `HTTP_PORT=8080`, `HTTPS_PORT=8443`, the four
secrets, and on the Windows layout `BACKEND_DIR=../ai-ops-backend/ai-ops-backend`.
Start it with `docker compose -p ai-ops-local up -d --build` and open
`https://localhost:8443` directly (Caddy uses its own certificate for
`localhost`, so the browser warns once; `http://localhost:8080` redirects to
port 443, which only works on a real server). The `-p` name keeps it apart
from your other Docker projects, and
`docker compose -p ai-ops-local down -v --rmi local` removes its containers,
database and images again.
