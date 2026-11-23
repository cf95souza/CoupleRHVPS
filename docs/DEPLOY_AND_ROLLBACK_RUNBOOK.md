# Runbook de Continuous Deployment (CD) e Rollback na VPS — CoupleRH Enterprise

Este documento é o guia operacional e runbook de emergência para o pipeline de implantação contínua (CD) e reversão de falhas (Rollback) do **CoupleRH Enterprise** na VPS Oracle Cloud Always Free (ARM64).

---

## 1. Visão Geral do Pipeline de CD

O processo de deploy opera sob o princípio de **Gates Estritos e Zero Downtime**:

```mermaid
flowchart TD
    A["Push na branch main"] --> B["CI Pipeline: 5 Gates Bloqueadores"]
    B -->|Falha em qualquer gate| C["❌ Deploy Bloqueado (Notificação)"]
    B -->|100% Aprovado| D["CD Pipeline (.github/workflows/deploy-vps.yml)"]
    D --> E["Compilação do Frontend Web (dist)"]
    D --> F["Conexão Segura SSH com a VPS"]
    F --> G["docker/scripts/deploy.sh na VPS"]
    G --> H["1. Snapshot de Backup Preventivo"]
    G --> I["2. Migrations Transacionais (PostgreSQL 17)"]
    G --> J["3. Swap Atômico do Frontend (/srv/web)"]
    G --> K["4. Restart Controlado da API (Fastify)"]
    G --> L["5. Smoke Test Automatizado (/health)"]
    L -->|Sucesso 200 OK| M["✅ Deploy Concluído com Sucesso"]
    L -->|Falha no Smoke Test| N["🚨 Disparo Imediato de Rollback Automático"]
```

---

## 2. Configuração de Segredos no GitHub Repository

Para habilitar o CD automático, configure os seguintes **Repository Secrets** no GitHub (`Settings → Secrets and variables → Actions`):

| Segredo | Descrição | Exemplo |
| :--- | :--- | :--- |
| `VPS_SSH_HOST` | IP público ou hostname da VPS Oracle Cloud | `129.148.xx.xx` ou `vps.couplerh.com.br` |
| `VPS_SSH_USER` | Usuário do sistema com permissão de sudo/docker | `ubuntu` |
| `VPS_SSH_KEY` | Chave privada SSH sem passphrase para acesso não interativo | `-----BEGIN OPENSSH PRIVATE KEY-----...` |
| `VPS_SSH_PORT` | Porta SSH configurada no UFW/sshd | `22` |
| `APP_PUBLIC_URL` | URL de produção protegida por HTTPS para o smoke test | `https://app.couplerh.com.br` |

---

## 3. Arquitetura de Deploy Zero Downtime

### 3.1 Swap Atômico do Frontend SPA
O Caddy serve diretamente a pasta `/srv/web` mapeada para `apps/web/dist`. Durante o deploy:
1. O novo bundle é recebido em `apps/web/dist_new`;
2. A versão atual é movida para backup em `apps/web/dist_previous`;
3. A nova versão é renomeada de forma atômica para `apps/web/dist` (`mv dist_new dist`);
4. Nenhuma requisição de usuário recebe erro 404 durante a transição.

### 3.2 Migrations Transacionais ACID no PostgreSQL 17
O runner `apps/api/db/migrate.ts` aplica migrations com integridade relacional estrita:
- Cada migration `.sql` executa dentro de uma transação `BEGIN ... COMMIT`;
- Se qualquer instrução SQL falhar, a transação sofre `ROLLBACK` completo;
- A tabela `schema_migrations` só é atualizada se a migration for concluída com 100% de sucesso.

### 3.3 Restart Controlado da API
A API Node.js Fastify é atualizada com `docker compose up -d --no-deps couplerh-api`:
- O Docker mantém o contêiner antigo ativo até que a nova instância passe no healthcheck;
- O proxy Caddy mantém as conexões ativas abertas e redireciona novas requisições para o novo processo.

---

## 4. Smoke Test Automatizado

O script de deploy executa até **10 tentativas consecutivas com intervalo de 3 segundos** consultando `http://localhost:4000/health`:

Critérios de Aceite do Smoke Test:
- Retorno HTTP Status `200`;
- Payload JSON contendo `"status":"healthy"`;
- Verificação ativa do banco de dados (`checks.database.status = "healthy"`).

Se a aplicação não responder com saúde em até 30 segundos, o processo aborta e dispara imediatamente o **Rollback Automático**.

---

## 5. Procedimentos de Rollback

### 5.1 Rollback Automático (Falha durante o Deploy)
Caso o smoke test ou a migração falhe, o script `deploy.sh` invoca imediatamente `docker/scripts/rollback.sh`, que:
1. Reverte o bundle do frontend de `dist_previous` para `dist`;
2. Faz checkout do commit anterior no Git;
3. Reconstrói e reinicia os contêineres na versão anterior estável;
4. Recarrega o Caddy e confirma a restauração de `/health`.

### 5.2 Rollback Manual via GitHub Actions
Se um bug de negócio for identificado em produção após um deploy bem-sucedido:
1. Acesse o repositório no GitHub → Aba **Actions**;
2. Selecione o workflow **CoupleRH CD Pipeline**;
3. Clique em **Run workflow**;
4. No campo **Ação a ser executada na VPS**, selecione `rollback`;
5. Clique em **Run workflow**.

### 5.3 Rollback Manual de Emergência via SSH
Se o GitHub Actions estiver indisponível:
```bash
# 1. Conecte à VPS
ssh ubuntu@<IP_VPS>

# 2. Execute o script de rollback fornecendo o hash do commit estável desejado
sudo bash /opt/couplerh/docker/scripts/rollback.sh <HASH_DO_COMMIT>

# 3. Verifique o status da aplicação
curl -s http://localhost:4000/health | jq
```

---

## 6. Validação do Gate V1

Com a conclusão do item **VPS-07**, a infraestrutura base da VPS Oracle Cloud Always Free atinge todos os critérios de aceite estabelecidos no planejamento arquitetural:

- [x] **Stack 100% Open-Source:** PostgreSQL 17 Alpine + Fastify 5 API + Caddy 2 TLS;
- [x] **Zero Supabase / Zero Vercel:** Todas as dependências proprietárias foram eliminadas;
- [x] **Role `couplerh_app` com RLS Ativo:** Zero permissão de superusuário na aplicação;
- [x] **Storage Local Protegido:** URLs assinadas HMAC-SHA256 e blindagem contra Path Traversal;
- [x] **Serviço de Mailer SMTP:** Suporte a STARTTLS/SSL, templates corporativos em PT-BR e fila `pg-boss`;
- [x] **Estratégia de Backup 3-2-1:** Criptografia `age`, sincronização OCI Object Storage e Restore Drill testado;
- [x] **Observabilidade e Sanitização LGPD:** Redaction Pino de dados pessoais, rotação Docker e Uptime Kuma;
- [x] **Pipeline CI/CD Completo:** 5 Gates bloqueadores no CI e pipeline automatizado com rollback na VPS.
