#!/usr/bin/env bash
# ==============================================================================
# CoupleRH Enterprise — Script de Backup 3-2-1 Automatizado
# Alvo: Oracle Cloud Always Free (ARM64) / Docker Compose
# Componentes: PostgreSQL 17 (pg_dump -Fc) + Storage Local (/var/lib/couplerh/storage)
# Segurança: Criptografia de ponta a ponta com 'age' + Sincronização Off-Site 'rclone'
# ==============================================================================

set -euo pipefail

# Cores para terminal
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Configurações de diretórios e contêineres
BACKUP_DIR="${BACKUP_DIR:-/var/lib/couplerh/backups}"
STORAGE_DIR="${STORAGE_DIR:-/var/lib/couplerh/storage}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-couplerh-db}"
DB_NAME="${DB_NAME:-couplerh}"
DB_USER="${DB_USER:-postgres}"

# Chave pública 'age' para criptografia (pode ser passada via ENV ou arquivo)
AGE_KEY_FILE="${AGE_KEY_FILE:-/etc/couplerh/backup-age-public.key}"
AGE_RECIPIENT="${AGE_RECIPIENT_KEY:-}"

# Destino remoto no Oracle Cloud Object Storage via rclone
RCLONE_REMOTE="${RCLONE_REMOTE:-oci-couplerh:couplerh-backups}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"

# Identificador de execução
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
LOG_FILE="${BACKUP_DIR}/backup.log"

# Garante que o diretório de backups exista com permissão estrita
mkdir -p "${BACKUP_DIR}"
chmod 0700 "${BACKUP_DIR}"

log() {
  local msg="[$(date +'%Y-%m-%d %H:%M:%S')] $1"
  echo -e "$1"
  echo "$msg" >> "${LOG_FILE}"
}

log "${BLUE}======================================================================${NC}"
log "${BLUE}   CoupleRH Enterprise — Início da Rotina de Backup 3-2-1             ${NC}"
log "${BLUE}======================================================================${NC}"
log "[INFO] Timestamp: ${TIMESTAMP}"
log "[INFO] Diretório de Destino: ${BACKUP_DIR}"

# 1. Carrega chave pública do 'age' se existir em arquivo
if [[ -z "${AGE_RECIPIENT}" && -f "${AGE_KEY_FILE}" ]]; then
  AGE_RECIPIENT=$(grep -v '^#' "${AGE_KEY_FILE}" | head -n 1 | xargs || true)
fi

# 2. Backup do Banco de Dados PostgreSQL 17 (formato binário customizado -Fc)
DUMP_FILENAME="couplerh_db_${TIMESTAMP}.dump"
DUMP_FILEPATH="${BACKUP_DIR}/${DUMP_FILENAME}"

log "\n${BLUE}[1/4] Executando pg_dump -Fc no contêiner ${POSTGRES_CONTAINER}...${NC}"
if ! docker ps --format '{{.Names}}' | grep -q "^${POSTGRES_CONTAINER}$"; then
  log "${RED}[ERRO CRÍTICO] Contêiner PostgreSQL '${POSTGRES_CONTAINER}' não está em execução!${NC}"
  exit 1
fi

docker exec "${POSTGRES_CONTAINER}" pg_dump -U "${DB_USER}" -d "${DB_NAME}" -Fc > "${DUMP_FILEPATH}"

DUMP_SIZE=$(stat -c%s "${DUMP_FILEPATH}" 2>/dev/null || stat -f%z "${DUMP_FILEPATH}" 2>/dev/null || wc -c < "${DUMP_FILEPATH}")
if [[ "${DUMP_SIZE}" -le 100 ]]; then
  log "${RED}[ERRO CRÍTICO] O arquivo de dump gerado tem tamanho inválido (${DUMP_SIZE} bytes). Abortando!${NC}"
  rm -f "${DUMP_FILEPATH}"
  exit 1
fi
chmod 0600 "${DUMP_FILEPATH}"
log "${GREEN}[OK] Dump do banco concluído com sucesso (${DUMP_SIZE} bytes).${NC}"

# 3. Backup do Storage de Arquivos Privados (/var/lib/couplerh/storage)
STORAGE_FILENAME="couplerh_storage_${TIMESTAMP}.tar.gz"
STORAGE_FILEPATH="${BACKUP_DIR}/${STORAGE_FILENAME}"

log "\n${BLUE}[2/4] Compactando diretório de arquivos de storage (${STORAGE_DIR})...${NC}"
if [[ -d "${STORAGE_DIR}" ]]; then
  tar -czf "${STORAGE_FILEPATH}" -C "${STORAGE_DIR}" .
  chmod 0600 "${STORAGE_FILEPATH}"
  STORAGE_SIZE=$(stat -c%s "${STORAGE_FILEPATH}" 2>/dev/null || stat -f%z "${STORAGE_FILEPATH}" 2>/dev/null || wc -c < "${STORAGE_FILEPATH}")
  log "${GREEN}[OK] Storage compactado com sucesso (${STORAGE_SIZE} bytes).${NC}"
else
  log "${YELLOW}[AVISO] Diretório de storage não encontrado em ${STORAGE_DIR}. Criando arquivo vazio.${NC}"
  tar -czf "${STORAGE_FILEPATH}" --files-from /dev/null
  chmod 0600 "${STORAGE_FILEPATH}"
fi

# 4. Criptografia com 'age' (se disponível e configurado)
FINAL_DUMP="${DUMP_FILEPATH}"
FINAL_STORAGE="${STORAGE_FILEPATH}"

log "\n${BLUE}[3/4] Criptografia de dados de ponta a ponta com 'age'...${NC}"
if command -v age >/dev/null 2>&1 && [[ -n "${AGE_RECIPIENT}" ]]; then
  log "[INFO] Criptografando dump com chave pública age: ${AGE_RECIPIENT:0:16}..."
  age -r "${AGE_RECIPIENT}" "${DUMP_FILEPATH}" > "${DUMP_FILEPATH}.age"
  rm -f "${DUMP_FILEPATH}"
  FINAL_DUMP="${DUMP_FILEPATH}.age"
  chmod 0600 "${FINAL_DUMP}"

  log "[INFO] Criptografando storage com chave pública age..."
  age -r "${AGE_RECIPIENT}" "${STORAGE_FILEPATH}" > "${STORAGE_FILEPATH}.age"
  rm -f "${STORAGE_FILEPATH}"
  FINAL_STORAGE="${STORAGE_FILEPATH}.age"
  chmod 0600 "${FINAL_STORAGE}"

  log "${GREEN}[OK] Arquivos criptografados com sucesso com algoritmo ChaCha20-Poly1305 ('age').${NC}"
else
  log "${YELLOW}[ALERTA DE SEGURANÇA] 'age' não instalado ou chave pública não configurada.${NC}"
  log "${YELLOW}Os arquivos permanecerão protegidos localmente apenas com permissão Unix 0600.${NC}"
fi

# 5. Geração de Manifesto SHA-256 para Integridade
MANIFEST_FILE="${BACKUP_DIR}/manifest_${TIMESTAMP}.sha256"
cd "${BACKUP_DIR}"
sha256sum "$(basename "${FINAL_DUMP}")" > "${MANIFEST_FILE}"
sha256sum "$(basename "${FINAL_STORAGE}")" >> "${MANIFEST_FILE}"
chmod 0600 "${MANIFEST_FILE}"
log "${GREEN}[OK] Manifesto SHA-256 gerado: ${MANIFEST_FILE}${NC}"

# 6. Rotação Local de Backups (manter apenas últimos RETENTION_DAYS dias)
log "\n${BLUE}[4/4] Limpeza e rotação local (retenção: ${RETENTION_DAYS} dias)...${NC}"
find "${BACKUP_DIR}" -type f \( -name "couplerh_db_*" -o -name "couplerh_storage_*" -o -name "manifest_*" \) -mtime "+${RETENTION_DAYS}" -exec rm -f {} +
log "${GREEN}[OK] Rotação local finalizada.${NC}"

# 7. Sincronização Externa (Off-Site) via 'rclone' para OCI Object Storage Always Free
if command -v rclone >/dev/null 2>&1; then
  log "\n${BLUE}[OFF-SITE] Sincronizando com OCI Object Storage (${RCLONE_REMOTE})...${NC}"
  if rclone listremotes | grep -q "^$(echo "${RCLONE_REMOTE}" | cut -d':' -f1):"; then
    rclone sync "${BACKUP_DIR}" "${RCLONE_REMOTE}" --fast-list --transfers 4 --log-level NOTICE
    log "${GREEN}[OK] Sincronização remota off-site 3-2-1 concluída com sucesso!${NC}"
  else
    log "${YELLOW}[AVISO] Remote do rclone '${RCLONE_REMOTE}' não configurado. Pule a etapa remota ou configure com 'rclone config'.${NC}"
  fi
else
  log "${YELLOW}[AVISO] Utilitário 'rclone' não instalado. Sincronização off-site ignorada.${NC}"
fi

log "\n${GREEN}======================================================================${NC}"
log "${GREEN}  ✓ ROTINA DE BACKUP CONCLUÍDA COM SUCESSO!                           ${NC}"
log "${GREEN}  Dump:    $(basename "${FINAL_DUMP}")                                ${NC}"
log "${GREEN}  Storage: $(basename "${FINAL_STORAGE}")                             ${NC}"
log "${GREEN}======================================================================${NC}"
