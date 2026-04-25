#!/bin/bash
# Inicia vercel dev com as vars do .env.local sempre carregadas
cd "$(dirname "$0")"
set -a
source .env.local
set +a
npx vercel dev --listen 3002
