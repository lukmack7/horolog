# Parallel ADHD deployment

The ADHD experience can run beside the standard Horolog stack from the same
checkout. Compose project names provide the application and data isolation
boundary: the standard stack defaults to `horolog`, while the example ADHD
configuration uses `horolog-adhd`. The ADHD stack has its own database and API
data volumes, but intentionally uses the same external Ollama endpoint as the
standard stack.

## Prepare the environment

Create a private environment file from the committed example:

```bash
cp .env.adhd.example .env.adhd
```

Replace the `POSTGRES_PASSWORD` placeholder in `.env.adhd` with a new password
used only by the ADHD database. Do not commit that file or put an existing
Horolog database URL in it.

The example uses:

- Compose project `horolog-adhd`
- web port `3200`
- web bound to `192.168.1.84`
- API port `8200`, bound only to `127.0.0.1`
- public URL examples for host `192.168.1.84`
- frontend experience `adhd`
- calendar writeback disabled
- Ollama shared at `http://192.168.1.74:11434/v1`

The API's loopback binding prevents other LAN devices from reaching port
`8200` directly. The web application still proxies `/api/*`, so every device
that can reach port `3200` can also use the Horolog API through that origin.
Only expose it on a trusted LAN; use an authenticated reverse proxy or
Tailscale before exposing it beyond that network. If OAuth callbacks must work
from other devices, route the public API URL through that authenticated proxy.
Change the example public URLs and CORS origin to the addresses clients use.

## Start and inspect

Verify that the shared Ollama endpoint is reachable from the Docker host:

```bash
curl http://192.168.1.74:11434/api/tags
```

Set `HOROLOG_LLM_BASE_URL`, `HOROLOG_LLM_API_KEY`, `HOROLOG_LLM_MODEL`, and
`HOROLOG_LLM_TIMEOUT_S` in `.env.adhd` to the same values as the standard
installation. The ADHD Compose project does not start another Ollama service.

Always pass both the dedicated Compose file and the ADHD environment file:

```bash
docker compose -f docker-compose.adhd.yml --env-file .env.adhd up -d --build
docker compose -f docker-compose.adhd.yml --env-file .env.adhd ps
```

Before adding data, verify that Compose selected the expected project and
volumes:

```bash
docker compose -f docker-compose.adhd.yml --env-file .env.adhd config --volumes
docker volume inspect \
  horolog-adhd_db-data \
  horolog-adhd_api-data
```

The standard stack's corresponding data volume names start with `horolog_`, not
`horolog-adhd_`. Both databases remain on their private project networks; only
the external Ollama API endpoint is shared.

## Backup

Back up the ADHD Postgres database independently before updates:

```bash
docker compose -f docker-compose.adhd.yml --env-file .env.adhd exec -T db \
  pg_dump -U horolog horolog > horolog-adhd-$(date +%F).sql
```

See [BACKUP.md](BACKUP.md) for restore details, adding
`-f docker-compose.adhd.yml --env-file .env.adhd` to every Compose command.

## Isolation rules

**Never configure the standard and ADHD projects to use the same database or
database volume.** A distinct Compose project name and a distinct database
password are required. Ollama is the only shared service; do not set either
stack's `HOROLOG_DATABASE_URL` to the other stack's database.

**Never enable calendar writeback in both stacks at the same time.** Keep
`HOROLOG_CALENDAR_WRITEBACK_ENABLED=false` in the ADHD stack unless writeback
has first been disabled in the standard stack. Parallel writeback can create
competing or duplicate calendar updates.

Stop only the ADHD project with:

```bash
docker compose -f docker-compose.adhd.yml --env-file .env.adhd down
```

Do not add `--volumes` unless the separate ADHD database and all other ADHD
volume data are intentionally being deleted after a verified backup.
