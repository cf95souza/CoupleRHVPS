#!/usr/bin/env bash
# ==============================================================================
# CoupleRH Enterprise — Script de Provisionamento e Hardening da VPS Oracle Cloud
# Alvo: Oracle Cloud Always Free (ARM64 Ampere A1 — 4 OCPU / 24 GB RAM / 200 GB SSD)
# OS: Ubuntu 24.04 LTS / 22.04 LTS (aarch64)
# Requisito Legal: Portaria MTP 671/2021 (Sincronização estrita NTP / America/Sao_Paulo)
# ==============================================================================

set -euo pipefail

# Cores para logs formatados
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}======================================================================${NC}"
echo -e "${BLUE}     CoupleRH Enterprise — Hardening & Setup VPS Oracle Cloud ARM64   ${NC}"
echo -e "${BLUE}======================================================================${NC}"

# 1. Checagem de privilégios de superusuário
if [[ $EUID -ne 0 ]]; then
   echo -e "${RED}[ERRO] Este script deve ser executado como root (use: sudo bash $0)${NC}" 
   exit 1
fi

# 2. Detecção de arquitetura
ARCH=$(uname -m)
echo -e "${GREEN}[INFO] Arquitetura detectada: ${ARCH}${NC}"
if [[ "$ARCH" != "aarch64" && "$ARCH" != "arm64" ]]; then
    echo -e "${YELLOW}[AVISO] Arquitetura diferente de ARM64 (${ARCH}). Continuando com compatibilidade genérica.${NC}"
fi

# 3. Atualização dos repositórios e pacotes do sistema
echo -e "\n${BLUE}[1/8] Atualizando pacotes do sistema (apt update & upgrade)...${NC}"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold"

# 4. Instalação de utilitários essenciais e ferramentas de segurança
echo -e "\n${BLUE}[2/8] Instalando ferramentas essenciais (chrony, ufw, fail2ban, curl, jq, rsync)...${NC}"
apt-get install -y chrony ufw fail2ban curl wget jq rsync htop net-tools ca-certificates gnupg lsb-release unattended-upgrades

# 5. Configuração rigorosa de NTP e Fuso Horário (Portaria MTP 671/2021)
echo -e "\n${BLUE}[3/8] Configurando Fuso Horário e Sincronização NTP Oficial (NTP.br)...${NC}"
timedatectl set-timezone America/Sao_Paulo

cat << 'EOF' > /etc/chrony/chrony.conf
# Servidores Oficiais do Observatório Nacional / NTP.br (Portaria MTP 671/2021)
server a.st1.ntp.br iburst
server b.st1.ntp.br iburst
server c.st1.ntp.br iburst
server gps.ntp.br iburst
server pool.ntp.org iburst

# Configurações de deriva e sincronismo contínuo
driftfile /var/lib/chrony/chrony.drift
makestep 1.0 3
rtcsync
logdir /var/log/chrony
maxupdateskew 100.0
EOF

systemctl restart chrony
systemctl enable chrony
echo -e "${GREEN}[OK] Chrony configurado com servidores NTP.br e timezone America/Sao_Paulo.${NC}"

# 6. Otimização do Kernel Linux para PostgreSQL em VPS de 24 GB RAM
echo -e "\n${BLUE}[4/8] Otimizando parâmetros do Kernel para alta performance de banco de dados...${NC}"
cat << 'EOF' > /etc/sysctl.d/99-couplerh-kernel.conf
# Limites de memória e swap para instância 24 GB RAM
vm.swappiness = 10
vm.dirty_background_ratio = 3
vm.dirty_ratio = 10
vm.overcommit_memory = 2
vm.overcommit_ratio = 80

# Descritores de arquivos e conexões de rede
fs.file-max = 2097152
net.core.somaxconn = 4096
net.ipv4.tcp_max_syn_backlog = 4096
net.ipv4.tcp_fin_timeout = 15
net.ipv4.tcp_tw_reuse = 1
EOF

sysctl --system > /dev/null
echo -e "${GREEN}[OK] Parâmetros de kernel aplicados com sucesso.${NC}"

# 7. Configuração de Hardening de Firewall (UFW & IPTables Oracle Cloud)
echo -e "\n${BLUE}[5/8] Configurando regras de firewall (UFW) e proteção de portas...${NC}"
# Permitir tráfego loopback
ufw default deny incoming
ufw default allow outgoing

# Limitar SSH para evitar ataques de dicionário
ufw limit 22/tcp comment 'SSH com rate-limiting'

# Permitir HTTP e HTTPS para Caddy Server
ufw allow 80/tcp comment 'HTTP (Let s Encrypt ACME)'
ufw allow 443/tcp comment 'HTTPS (Web + API)'

# Manter portas internas dos sistemas vizinhos protegidas e acessíveis localmente
# Backend do Cozinha (3001) e portas de banco NÃO são expostas publicamente!

ufw --force enable
echo -e "${GREEN}[OK] Firewall UFW ativado com sucesso (Portas abertas: 22/limite, 80/tcp, 443/tcp).${NC}"

# 8. Configuração do Fail2Ban contra Brute-Force
echo -e "\n${BLUE}[6/8] Configurando Fail2Ban para proteção contra ataques SSH...${NC}"
cat << 'EOF' > /etc/fail2ban/jail.local
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 4

[sshd]
enabled = true
port    = ssh
logpath = %(sshd_log)s
backend = %(default_backend)s
EOF

systemctl restart fail2ban
systemctl enable fail2ban
echo -e "${GREEN}[OK] Fail2ban ativado com banimento automático de 1h após 4 tentativas.${NC}"

# 9. Ativação de Atualizações Automáticas de Segurança
echo -e "\n${BLUE}[7/8] Ativando atualizações automáticas de segurança do Ubuntu (unattended-upgrades)...${NC}"
cat << 'EOF' > /etc/apt/apt.conf.d/20auto-upgrades
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
systemctl restart unattended-upgrades
echo -e "${GREEN}[OK] Unattended-upgrades ativado.${NC}"

# 10. Criação da Estrutura de Diretórios com Permissões Restritas
echo -e "\n${BLUE}[8/8] Criando estrutura de diretórios do CoupleRH em /var/lib/couplerh/...${NC}"
mkdir -p /var/lib/couplerh/pgdata
mkdir -p /var/lib/couplerh/storage
mkdir -p /var/lib/couplerh/backups
mkdir -p /var/lib/couplerh/caddy_data
mkdir -p /var/lib/couplerh/caddy_config

# Permissões do PostgreSQL (UID 999 no Alpine/Debian oficial)
chown -R 999:999 /var/lib/couplerh/pgdata || true
chmod 0700 /var/lib/couplerh/pgdata

# Permissões do Storage de documentos privados
chmod 0750 /var/lib/couplerh/storage
chmod 0700 /var/lib/couplerh/backups

echo -e "${GREEN}[OK] Diretórios criados com isolamento de permissões.${NC}"

# 11. Validação Final
echo -e "\n${BLUE}======================================================================${NC}"
echo -e "${GREEN}  ✓ HARDENING CONCLUÍDO COM SUCESSO! Instância preparada para o CoupleRH.${NC}"
echo -e "${BLUE}======================================================================${NC}"
echo -e "Data/Hora Atual: $(date)"
echo -e "Timezone Oficial: $(timedatectl | grep 'Time zone' | xargs)"
echo -e "Status UFW:\n$(ufw status verbose)"
echo -e "Status Fail2ban: $(systemctl is-active fail2ban)"
echo -e "Status Chrony: $(systemctl is-active chrony)"
echo -e "${BLUE}======================================================================${NC}\n"
