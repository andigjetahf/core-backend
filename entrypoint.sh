#!/bin/sh
set -e
echo "[Entrypoint] Waiting for PostgreSQL..."
until nc -z $(echo $DATABASE_URL | sed 's|.*@||' | sed 's|/.*||' | sed 's|:| |') ; do
  sleep 1
done
echo "[Entrypoint] PostgreSQL is up."
echo "[Entrypoint] Running Prisma migrations..."
npx prisma db push --skip-generate
echo "[Entrypoint] Starting core backend..."
exec node dist/index.js
