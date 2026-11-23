#!/usr/bin/env bash
# ==============================================================================
# CoupleRH Enterprise — Script de Rollback Automatizado e de Emergência
# Alvo: Oracle Cloud Always Free (ARM64)
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
TARGET_COMMIT="${1:-HEAD~1}"
LOG_FILE="/var/lib/couplerh/backups/deploy.log"

log() {
  local msg="[$(date +'%Y-%m-%d %H:%M:%S')] $1"
  echo -e "$1"
  echo "$msg" >> "${LOG_FILE}"
}

log "\n${RED}======================================================================${NC}"
log "${RED}   [EMERGÊNCIA] Iniciando Procedimento de Rollback no CoupleRH        ${NC}"
log "${RED}======================================================================${NC}"
log "[INFO] Alvo de rollback: ${TARGET_COMMIT}"

cd "${APP_DIR}"

# 1. Rollback do frontend web
if [[ -d "${WEB_BACKUP_DIR}" ]]; then
  log "\n${BLUE}[1/4] Revertendo bundle do frontend web para versão anterior...${NC}"
  rm -rf "${WEB_DIST_DIR}"
  mv "${WEB_BACKUP_DIR}" "${WEB_DIST_DIR}"
  log "${GREEN}[OK] Frontend web revertido com sucesso.${NC}"
else
  log "${YELLOW}[AVISO] Pasta dist_previous não encontrada. Mantendo bundle atual.${NC}"
fi

# 2. Reversão do código Git
log "\n${BLUE}[2/4] Revertendo código da API para commit ${TARGET_COMMIT}...${NC}"
git checkout "${TARGET_COMMIT}"
CURRENT_REV=$(git rev-parse --short HEAD)
log "${GREEN}[OK] Código restaurado no commit ${CURRENT_REV}.${NC}"

# 3. Reconstrução e reinício dos contêineres
log "\n${BLUE}[3/4] Reconstruindo e reiniciando API no commit estável...${NC}"
cd "${DOCKER_DIR}"
docker compose build couplerh-api
docker compose up -d --no-deps couplerh-api
docker compose exec -T couplerh-caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || true

# 4. Verificação de restabelecimento do serviço
log "\n${BLUE}[4/4] Validando restabelecimento do serviço...${NC}"
sleep 5
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:4000/health || echo "000")
if [[ "${HTTP_CODE}" == "200" ]]; then
  log "${GREEN}======================================================================${NC}"
  log "${GREEN}  ✓ ROLLBACK CONCLUÍDO COM SUCESSO! Sistema restabelecido.           ${NC}"
  log "${GREEN}  Commit Ativo: ${CURRENT_REV}                                        ${NC}"
  log "${GREEN}======================================================================${NC}"
else
  log "${RED}[ALERTA MÁXIMO] Sistema não retornou HTTP 200 após o rollback! Código: ${HTTP_CODE}${NC}"
  log "${RED}Intervenção manual necessária via SSH.${NC}"
  exit 1
fi
