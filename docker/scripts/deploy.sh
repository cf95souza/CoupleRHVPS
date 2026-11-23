#!/usr/bin/env bash
# ==============================================================================
# CoupleRH Enterprise — Script de Continuous Deployment (CD) Zero Downtime na VPS
# Alvo: Oracle Cloud Always Free (ARM64)
# Fluxo: Backup Pre-Deploy -> Migrations Transacionais -> Swap Atômico -> Restart -> Smoke Test
# ==============================================================================

set -euo pipefail

# Cores para logs formatados
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

APP_DIR="${APP_DIR:-/opt/couplerh}"
DOCKER_DIR="${APP_DIR}/docker"
WEB_DIST_DIR="${APP_DIR}/apps/web/dist"
WEB_BACKUP_DIR="${APP_DIR}/apps/web/dist_previous"
API_URL="${API_URL:-http://localhost:4000}"
LOG_FILE="/var/lib/couplerh/backups/deploy.log"

log() {
  local msg="[$(date +'%Y-%m-%d %H:%M:%S')] $1"
  echo -e "$1"
  mkdir -p "$(dirname "${LOG_FILE}")"
  echo "$msg" >> "${LOG_FILE}"
}

log "${BLUE}======================================================================${NC}"
log "${BLUE}   CoupleRH Enterprise — Início do Deploy Automatizado na VPS         ${NC}"
log "${BLUE}======================================================================${NC}"

cd "${APP_DIR}"

# 1. Registro do commit atual para rollback se necessário
PREV_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
log "[INFO] Commit atual pré-deploy: ${PREV_COMMIT}"

# 2. Backup de segurança rápido do banco de dados antes das migrations
log "\n${BLUE}[1/6] Executando snapshot rápido de segurança do banco...${NC}"
if [[ -f "${DOCKER_DIR}/scripts/backup.sh" ]]; then
  bash "${DOCKER_DIR}/scripts/backup.sh" || {
    log "${YELLOW}[AVISO] Backup pré-deploy falhou, mas continuando com cautela...${NC}"
  }
else
  log "${YELLOW}[AVISO] Script de backup não localizado em ${DOCKER_DIR}/scripts/backup.sh.${NC}"
fi

# 3. Atualização do repositório Git
log "\n${BLUE}[2/6] Atualizando repositório Git para o commit mais recente...${NC}"
git fetch origin main
git checkout main
git pull origin main
NEW_COMMIT=$(git rev-parse HEAD)
log "${GREEN}[OK] Código atualizado para o commit: ${NEW_COMMIT}${NC}"

# 4. Execução de Migrations Transacionais do PostgreSQL 17
log "\n${BLUE}[3/6] Aplicando migrations pendentes de forma transacional...${NC}"
cd "${DOCKER_DIR}"
# Executa runner de migrations via container da API conectado ao PostgreSQL oficial
if ! docker compose exec -T couplerh-api npm run migrate; then
  log "${RED}[ERRO CRÍTICO] Falha ao aplicar migrations transacionais! Abortando deploy.${NC}"
  exit 1
fi
log "${GREEN}[OK] Migrations transacionais aplicadas com sucesso.${NC}"

# 5. Swap Atômico do Frontend Web SPA
log "\n${BLUE}[4/6] Realizando swap atômico do frontend React SPA...${NC}"
if [[ -d "${APP_DIR}/apps/web/dist_new" ]]; then
  # Salva backup da versão anterior
  rm -rf "${WEB_BACKUP_DIR}"
  if [[ -d "${WEB_DIST_DIR}" ]]; then
    mv "${WEB_DIST_DIR}" "${WEB_BACKUP_DIR}"
  fi
  # Promove a nova versão de forma atômica
  mv "${APP_DIR}/apps/web/dist_new" "${WEB_DIST_DIR}"
  log "${GREEN}[OK] Swap atômico de dist/ concluído.${NC}"
else
  log "[INFO] Diretório dist_new não fornecido; mantendo bundle web existente."
fi

# 6. Atualização e Reinício Controlado da API
log "\n${BLUE}[5/6] Reiniciando contêiner da API com zero downtime percebido...${NC}"
docker compose build couplerh-api
docker compose up -d --no-deps couplerh-api

# Recarrega Caddy se necessário
docker compose exec -T couplerh-caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || true
log "${GREEN}[OK] Contêineres atualizados.${NC}"

# 7. Smoke Test Automatizado no Endpoint /health
log "\n${BLUE}[6/6] Executando Smoke Test no endpoint de saúde (/health)...${NC}"
SMOKE_SUCCESS=false
for i in {1..10}; do
  log "[SMOKE] Tentativa ${i}/10: Verificando ${API_URL}/health..."
  HTTP_CODE=$(curl -s -o /tmp/health_response.json -w "%{http_code}" "${API_URL}/health" || echo "000")
  if [[ "${HTTP_CODE}" == "200" ]]; then
    HEALTH_STATUS=$(grep -o '"status":"[^"]*"' /tmp/health_response.json | cut -d':' -f2 | tr -d '"' || true)
    if [[ "${HEALTH_STATUS}" == "healthy" ]]; then
      SMOKE_SUCCESS=true
      log "${GREEN}[OK] Smoke test aprovado! Status: healthy (HTTP 200).${NC}"
      break
    fi
  fi
  sleep 3
done

if [[ "${SMOKE_SUCCESS}" != "true" ]]; then
  log "${RED}[ERRO CRÍTICO] Smoke test falhou após 10 tentativas! Disparando rollback automático...${NC}"
  if [[ -f "${DOCKER_DIR}/scripts/rollback.sh" ]]; then
    bash "${DOCKER_DIR}/scripts/rollback.sh" "${PREV_COMMIT}"
  fi
  exit 1
fi

log "\n${GREEN}======================================================================${NC}"
log "${GREEN}  ✓ DEPLOY CONCLUÍDO COM SUCESSO!                                    ${NC}"
log "${GREEN}  Commit em Produção: ${NEW_COMMIT}                                  ${NC}"
log "${GREEN}  Status da Aplicação: 100% OPERACIONAL                              ${NC}"
log "${GREEN}======================================================================${NC}"
