#!/usr/bin/env bash
# ==============================================================================
# CoupleRH Enterprise — Instalador do Cron Job de Backup 3-2-1 e Restore Drill
# Alvo: /etc/cron.d/couplerh-backup
# ==============================================================================

set -euo pipefail

CRON_FILE="/etc/cron.d/couplerh-backup"
SCRIPTS_DIR="/var/lib/couplerh/scripts"
BACKUP_DIR="/var/lib/couplerh/backups"

echo "Instalando agendamento automático de backups em ${CRON_FILE}..."

mkdir -p "${SCRIPTS_DIR}"
mkdir -p "${BACKUP_DIR}"

# Copia scripts para diretório padrão do sistema
cp docker/scripts/backup.sh "${SCRIPTS_DIR}/backup.sh"
cp docker/scripts/restore-drill.sh "${SCRIPTS_DIR}/restore-drill.sh"
chmod 0750 "${SCRIPTS_DIR}/backup.sh"
chmod 0750 "${SCRIPTS_DIR}/restore-drill.sh"

cat << 'EOF' > "${CRON_FILE}"
# /etc/cron.d/couplerh-backup
# ------------------------------------------------------------------------------
# 1. Backup Completo a cada 6 horas (00:00, 06:00, 12:00, 18:00)
0 */6 * * * root /var/lib/couplerh/scripts/backup.sh >> /var/lib/couplerh/backups/cron-backup.log 2>&1

# 2. Restore Drill Semanal (Todo domingo às 03:00 da madrugada)
0 3 * * 0 root /var/lib/couplerh/scripts/restore-drill.sh >> /var/lib/couplerh/backups/cron-restore-drill.log 2>&1
EOF

chmod 0644 "${CRON_FILE}"
echo "[OK] Cron jobs configurados com sucesso:"
cat "${CRON_FILE}"
