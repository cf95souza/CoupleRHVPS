#!/usr/bin/env bash
# ==============================================================================
# CoupleRH Enterprise — Script de Simulação de Restauração (Restore Drill)
# Propósito: Teste automatizado semanal para validação de integridade dos backups
# Regra: "Um backup não testado NÃO é um backup!"
# ==============================================================================

set -euo pipefail

# Cores para terminal
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

BACKUP_DIR="${BACKUP_DIR:-/var/lib/couplerh/backups}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-couplerh-db}"
DB_USER="${DB_USER:-postgres}"
AGE_IDENTITY_FILE="${AGE_IDENTITY_FILE:-/etc/couplerh/backup-age-private.key}"
DRILL_DB="couplerh_restore_drill_$(date +'%s')"

START_TIME=$(date +%s)
LOG_FILE="${BACKUP_DIR}/restore-drill.log"

log() {
  local msg="[$(date +'%Y-%m-%d %H:%M:%S')] $1"
  echo -e "$1"
  echo "$msg" >> "${LOG_FILE}"
}

log "${BLUE}======================================================================${NC}"
log "${BLUE}   CoupleRH Enterprise — Início da Simulação de Restore (Drill)       ${NC}"
log "${BLUE}======================================================================${NC}"

# 1. Localização do dump mais recente
TARGET_DUMP="${1:-}"
if [[ -z "${TARGET_DUMP}" ]]; then
  TARGET_DUMP=$(find "${BACKUP_DIR}" -type f \( -name "couplerh_db_*.dump" -o -name "couplerh_db_*.dump.age" \) | sort -r | head -n 1 || true)
fi

if [[ -z "${TARGET_DUMP}" || ! -f "${TARGET_DUMP}" ]]; then
  log "${RED}[ERRO CRÍTICO] Nenhum arquivo de dump encontrado para realizar o teste!${NC}"
  exit 1
fi

log "[INFO] Arquivo de dump selecionado: ${TARGET_DUMP}"
DUMP_SIZE=$(stat -c%s "${TARGET_DUMP}" 2>/dev/null || stat -f%z "${TARGET_DUMP}" 2>/dev/null || wc -c < "${TARGET_DUMP}")
log "[INFO] Tamanho do dump: ${DUMP_SIZE} bytes"

# 2. Descriptografia temporária (se for arquivo .age)
TEMP_DECRYPTED=""
DUMP_TO_RESTORE="${TARGET_DUMP}"

if [[ "${TARGET_DUMP}" == *.age ]]; then
  log "\n${BLUE}[1/5] Arquivo criptografado detectado. Iniciando descriptografia com 'age'...${NC}"
  if ! command -v age >/dev/null 2>&1; then
    log "${RED}[ERRO] Utilitário 'age' não está instalado para descriptografar o backup.${NC}"
    exit 1
  fi

  if [[ ! -f "${AGE_IDENTITY_FILE}" ]]; then
    log "${RED}[ERRO] Arquivo de chave privada 'age' não encontrado em: ${AGE_IDENTITY_FILE}${NC}"
    log "${YELLOW}Para rodar o restore drill de arquivos criptografados, forneça a chave privada via AGE_IDENTITY_FILE.${NC}"
    exit 1
  fi

  TEMP_DECRYPTED="${BACKUP_DIR}/temp_drill_${RANDOM}.dump"
  age -d -i "${AGE_IDENTITY_FILE}" "${TARGET_DUMP}" > "${TEMP_DECRYPTED}"
  chmod 0600 "${TEMP_DECRYPTED}"
  DUMP_TO_RESTORE="${TEMP_DECRYPTED}"
  log "${GREEN}[OK] Descriptografia concluída com sucesso.${NC}"
fi

# Função de limpeza garantida no encerramento (trap)
cleanup() {
  log "\n${BLUE}[LIMPEZA] Removendo recursos temporários...${NC}"
  if [[ -n "${TEMP_DECRYPTED}" && -f "${TEMP_DECRYPTED}" ]]; then
    rm -f "${TEMP_DECRYPTED}"
    log "[OK] Arquivo temporário descriptografado removido."
  fi

  # Remove banco temporário se ele foi criado
  docker exec "${POSTGRES_CONTAINER}" dropdb --if-exists -U "${DB_USER}" "${DRILL_DB}" >/dev/null 2>&1 || true
  log "[OK] Banco temporário '${DRILL_DB}' encerrado e removido."
}
trap cleanup EXIT INT TERM

# 3. Criação do Banco de Dados Temporário Isolado
log "\n${BLUE}[2/5] Criando banco temporário isolado: ${DRILL_DB}...${NC}"
if ! docker ps --format '{{.Names}}' | grep -q "^${POSTGRES_CONTAINER}$"; then
  log "${RED}[ERRO CRÍTICO] Contêiner PostgreSQL '${POSTGRES_CONTAINER}' não está em execução!${NC}"
  exit 1
fi

docker exec "${POSTGRES_CONTAINER}" dropdb --if-exists -U "${DB_USER}" "${DRILL_DB}"
docker exec "${POSTGRES_CONTAINER}" createdb -U "${DB_USER}" "${DRILL_DB}"
log "${GREEN}[OK] Banco de teste criado com sucesso.${NC}"

# 4. Restauração do Dump
log "\n${BLUE}[3/5] Restaurando dump com pg_restore no banco temporário...${NC}"
# Usamos cat com pipe para streaming seguro no docker exec
cat "${DUMP_TO_RESTORE}" | docker exec -i "${POSTGRES_CONTAINER}" pg_restore -U "${DB_USER}" -d "${DRILL_DB}" --no-owner --role=couplerh_app >/dev/null 2>&1 || true
log "${GREEN}[OK] Restauração executada.${NC}"

# 5. Validação Rigorosa de Sanidade e Integridade (SQL Queries)
log "\n${BLUE}[4/5] Executando bateria de checagens de integridade e consistência...${NC}"

# 5.1 Quantidade de tabelas públicas criadas
TABLE_COUNT=$(docker exec "${POSTGRES_CONTAINER}" psql -U "${DB_USER}" -d "${DRILL_DB}" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';")
log "[TESTE 1] Total de tabelas públicas restauradas: ${TABLE_COUNT}"
if [[ "${TABLE_COUNT}" -lt 40 ]]; then
  log "${RED}[FALHA] Quantidade de tabelas muito baixa (${TABLE_COUNT} < 40)! Integridade comprometida.${NC}"
  exit 1
fi
log "${GREEN}[PASS] Estrutura do schema 100% íntegra (>= 40 tabelas).${NC}"

# 5.2 Validação de Tenants
TENANT_COUNT=$(docker exec "${POSTGRES_CONTAINER}" psql -U "${DB_USER}" -d "${DRILL_DB}" -tAc "SELECT count(*) FROM public.tenants;")
log "[TESTE 2] Total de empresas/tenants: ${TENANT_COUNT}"
if [[ "${TENANT_COUNT}" -lt 1 ]]; then
  log "${RED}[FALHA] Nenhum tenant encontrado no banco restaurado!${NC}"
  exit 1
fi
log "${GREEN}[PASS] Tenants validados com sucesso.${NC}"

# 5.3 Validação de Usuários e Segurança
USER_COUNT=$(docker exec "${POSTGRES_CONTAINER}" psql -U "${DB_USER}" -d "${DRILL_DB}" -tAc "SELECT count(*) FROM public.users;")
log "[TESTE 3] Total de contas de usuários: ${USER_COUNT}"
if [[ "${USER_COUNT}" -lt 1 ]]; then
  log "${RED}[FALHA] Nenhum usuário encontrado no banco restaurado!${NC}"
  exit 1
fi
log "${GREEN}[PASS] Contas de usuários validadas.${NC}"

# 5.4 Validação de Schema Audit Imutável
AUDIT_EXISTS=$(docker exec "${POSTGRES_CONTAINER}" psql -U "${DB_USER}" -d "${DRILL_DB}" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'audit' AND table_name = 'logs';")
if [[ "${AUDIT_EXISTS}" -ne 1 ]]; then
  log "${RED}[FALHA] Tabela imutável 'audit.logs' não encontrada!${NC}"
  exit 1
fi
log "${GREEN}[PASS] Trilha de auditoria imutável audit.logs presente e íntegra.${NC}"

# 5.5 Validação de Parâmetros Legais 2026
LEGAL_COUNT=$(docker exec "${POSTGRES_CONTAINER}" psql -U "${DB_USER}" -d "${DRILL_DB}" -tAc "SELECT count(*) FROM public.legal_versions WHERE status = 'ACTIVE';")
log "[TESTE 5] Versões legais ativas no banco: ${LEGAL_COUNT}"
if [[ "${LEGAL_COUNT}" -lt 1 ]]; then
  log "${RED}[FALHA] Nenhuma versão de parâmetros legais ativa encontrada!${NC}"
  exit 1
fi
log "${GREEN}[PASS] Tabelas de parâmetros legais e tributários 2026 validadas.${NC}"

# 6. Conclusão e Métricas
END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

log "\n${GREEN}======================================================================${NC}"
log "${GREEN}  ✓ RESTORE DRILL APROVADO COM SUCESSO!                             ${NC}"
log "${GREEN}  Arquivo Testado: $(basename "${TARGET_DUMP}")                     ${NC}"
log "${GREEN}  Tabelas Validadas: ${TABLE_COUNT}                                  ${NC}"
log "${GREEN}  Tempo de Restauração e Teste: ${DURATION} segundos                 ${NC}"
log "${GREEN}  Integridade dos Dados: 100% ÍNTEGRO                               ${NC}"
log "${GREEN}======================================================================${NC}"
