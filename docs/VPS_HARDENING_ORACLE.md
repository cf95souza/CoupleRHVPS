# CoupleRH Enterprise — Guia de Hardening e Provisionamento da VPS Oracle Cloud ARM64

> **Referência:** Blueprint v2.0 §2 e §3 (FASE V1 — `VPS-01`)  
> **Sistema Alvo:** Oracle Cloud Always Free (`VM.Standard.A1.Flex` — 4 OCPU / 24 GB RAM / 200 GB SSD)  
> **Sistema Operacional:** Ubuntu 24.04 LTS Minimal ARM64 (ou Ubuntu 22.04 LTS aarch64)  
> **Script Automatizado:** `docker/scripts/vps-setup-hardening.sh`  

---

## 1. Visão Geral e Requisitos de Conformidade

O processo de hardening da VPS foi projetado especificamente para atender a duas exigências críticas:
1. **Conformidade Legal com a Portaria MTP 671/2021 (Ponto Eletrônico):**
   - É exigência inegociável do Ministério do Trabalho e Previdência que todo sistema de registro eletrônico de ponto (REP-P) opere com o relógio estritamente sincronizado com o fuso horário oficial de Brasília (`America/Sao_Paulo`) através dos servidores de estrato 1 do Observatório Nacional / NTP.br.
2. **Coexistência Segura com Sistemas Vizinhos:**
   - Durante a fase de transição, a VPS abriga os sistemas vizinhos (`cozinha` e `CarX`). O firewall é configurado para expor apenas as portas web públicas padrão (`80/TCP` e `443/TCP`), blindando as portas de aplicação e bancos de dados locais contra varreduras e ataques da internet pública.

---

## 2. Como Executar na VPS

O script `vps-setup-hardening.sh` é idempotente (pode ser executado várias vezes sem quebrar o ambiente existente).

### Passo 1: Conectar na VPS via SSH
No seu terminal local (PowerShell):

```powershell
ssh -i "D:\VPSOracle\ssh-key-2026-08-27.key" ubuntu@137.131.151.125
```

### Passo 2: Executar o Script de Hardening
Dentro da pasta do projeto na VPS:

```bash
chmod +x docker/scripts/vps-setup-hardening.sh
sudo bash docker/scripts/vps-setup-hardening.sh
```

---

## 3. Os 8 Pilares de Segurança Aplicados

| Pilar | Ação Executada | Justificativa Técnica |
|---|---|---|
| **1. Atualização Base** | `apt update && apt upgrade -y` | Aplicação dos últimos patches de segurança do kernel e pacotes Ubuntu. |
| **2. Ferramentas Essenciais** | Instalação de `chrony`, `ufw`, `fail2ban`, `htop`, `jq` | Utilitários de infraestrutura, sincronismo e monitoramento leve. |
| **3. NTP Oficial (Portaria 671)** | `timedatectl set-timezone America/Sao_Paulo` + servidores `a.st1.ntp.br`, `b.st1.ntp.br` no `chrony` | Eliminação de desvios de horário nas marcações de ponto do colaborador. |
| **4. Otimização do Kernel** | `/etc/sysctl.d/99-couplerh-kernel.conf`: `vm.swappiness=10`, `vm.dirty_ratio=10`, `fs.file-max=2097152` | Evita uso desnecessário de swap nos 24 GB de RAM e otimiza o I/O do PostgreSQL 17. |
| **5. Firewall UFW** | Bloqueio de entrada padrão; liberação estrita de `22/tcp` (com rate-limit), `80/tcp` e `443/tcp` | Fecha portas de banco (5432, etc.) e portas internas para acesso externo. |
| **6. Defesa Anti-Bruteforce** | `fail2ban` com jail SSH (ban de 1 hora após 4 falhas em 10 minutos) | Neutraliza tentativas automáticas de força-bruta contra a porta SSH. |
| **7. Patches Automáticos** | `unattended-upgrades` ativo para atualizações diárias de segurança | Mantém a máquina protegida contra novas vulnerabilidades de dia-zero. |
| **8. Estrutura de Diretórios** | Criação de `/var/lib/couplerh/{pgdata,storage,backups,caddy_data}` com permissões `0700` e `0750` | Isolamento físico rigoroso para o banco de dados e arquivos privados. |

---

## 4. Comandos de Validação Rápida

Após a execução do script, você pode confirmar que tudo está 100% ativo rodando:

```bash
# 1. Verificar sincronização do relógio e timezone
timedatectl
chronyc tracking

# 2. Verificar regras do firewall
sudo ufw status verbose

# 3. Verificar status do fail2ban
sudo systemctl status fail2ban

# 4. Verificar diretórios do CoupleRH
ls -ld /var/lib/couplerh/*
```
