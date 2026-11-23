# CoupleRH Enterprise — Documentação Técnica do Sistema

> **Versão:** 2.0.0 (Enterprise VPS Open-Source Edition)  
> **Arquitetura:** Monorepo Modular (`packages/payroll-core`, `apps/api`, `apps/web`)  
> **Infraestrutura Alvo:** Oracle Cloud Always Free ARM64 (Ubuntu 24.04, 4 OCPU, 24 GB RAM, 200 GB SSD)  
> **Repositório:** `https://github.com/cf95souza/CoupleRHVPS.git`  

---

## 1. Visão Geral do Produto e Escopo

O **CoupleRH** é uma plataforma corporativa completa de Gestão de Recursos Humanos e Departamento Pessoal com foco estrito na legislação trabalhista brasileira (CLT), Portaria MTP 671/2021 (Ponto Eletrônico) e padrões de transmissão do eSocial.

O sistema atende a dois perfis integrados de uso:
1. **Ambiente Administrativo RH / DP:** Gestão cadastral de empresas, trabalhadores e contratos, apuração de ponto eletrônico, processamento em lote da folha de pagamento com motor de cálculo declarativo, apuração de encargos patronais (INSS Empresa, RAT/FAP, Terceiros), provisões, emissão de guias e relatórios legais.
2. **Portal do Colaborador Unificado:** Acesso seguro via web e PWA para marcação de ponto eletrônico com geolocalização e anti-spoofing, visualização de espelho de ponto, solicitação de ajustes e inclusão de atestados, consulta e download de holerites em PDF, assinatura digital de documentos e canal de comunicação interna.

---

## 2. Decisões Arquiteturais Fundamentais

### 2.1 Transição de BaaS Proprietário para 100% Código Aberto
- **Antes (Legado):** Vercel + Supabase BaaS (com dependências proprietárias `@supabase/supabase-js`, autenticação `auth.users`, falta de controle fino sobre recursos e custos de escala).
- **Agora (CoupleRH v2.0):** 100% open-source com controle total sob a infraestrutura em container Docker `postgres:17-alpine`, API modular em Fastify 5 + TypeScript e frontend React 19 servido via Caddy Server com TLS automático.

### 2.2 Estrutura do Monorepo (Workspaces)
- **`packages/payroll-core`:** Núcleo de domínio e cálculo matemático 100% puro em TypeScript. Não possui dependências com banco de dados ou frameworks. Responsável pelo cálculo progressivo de INSS, IRRF (reforma 2026), FGTS, adicionais de insalubridade, periculosidade e noturno, DAG de dependências de rubricas e cálculo de geodistância (Haversine).
- **`apps/api`:** Servidor de backend de alta performance baseado em Fastify 5, com validação de schemas em tempo de execução via Zod, pool nativo do PostgreSQL (`pg`), filas transacionais com `pg-boss`, autenticação própria Argon2id/JWT/Cookies HttpOnly e MFA TOTP nativo.
- **`apps/web`:** Single Page Application (SPA) moderna em React 19, Vite 8 e Tailwind CSS 4, com componentes responsivos e suporte nativo a offline e PWA.

### 2.3 Princípios Matemáticos e Financeiros Inegociáveis
- **Proibição de Ponto Flutuante:** É terminantemente proibido o uso de `number` nativo do JavaScript para cálculos financeiros (`0.1 + 0.2 !== 0.3`). Toda aritmética de moeda utiliza inteiros (centavos) com a biblioteca interna `money.ts` e arredondamento legal `HALF_UP`.
- **Cálculo Legal 100% no Servidor:** O frontend é meramente visual. Nenhuma regra tributária, previdenciária ou trabalhista é calculada no cliente.
- **Memória de Cálculo Imutável:** Todo holerite processado gera registros imutáveis na tabela `payroll_memory_calc`, permitindo auditoria forense retrospectiva de cada centavo gerado.

---

## 3. Segurança e Governança

### 3.1 Modelo de Defesa em Profundidade
1. **Nível 1 (Rede & Proxy):** Caddy Server com TLS automático, limitação de taxa de requisições (`@fastify/rate-limit`) e cabeçalhos de segurança rígidos (CSP, HSTS, X-Frame-Options).
2. **Nível 2 (Autenticação da API):** Hash de senhas com Argon2id, Access Token JWT de curta duração (15 minutos), Refresh Token rotativo armazenado em cookie seguro `HttpOnly; Secure; SameSite=Lax`, bloqueio contra força-bruta e MFA TOTP obrigatório para cargos administrativos.
3. **Nível 3 (Controle de Acesso RBAC & Escopos):** Permissões dinâmicas atribuídas a perfis (`system_admin`, `tenant_admin`, `dp_analyst`, `manager`, `employee`, `sst_specialist`, `auditor`) com filtros de visibilidade por Filial, Departamento, Setor, Centro de Custo e restrição explícita de visualização de salários (`can_view_salary`) e atestados médicos (`can_view_medical`).
4. **Nível 4 (Banco de Dados RLS):** Acesso à base sob o usuário não-superuser `couplerh_app`, com Row-Level Security forçado em todas as tabelas de dados de clientes, blindando contra vazamento entre organizações (multi-tenancy real).
5. **Nível 5 (Auditoria):** Trilha forense automática em `audit.logs` capturando usuário, operação, timestamp e delta dos dados com bloqueio de adulteração via trigger.

---

## 4. Módulos Funcionais Principais

### 4.1 Motor de Folha de Pagamento CLT Enterprise
- Suporte a múltiplos tipos de folhas: Mensal, Adiantamento, 13º Salário (1ª e 2ª parcelas), Férias, Rescisão e Folhas Complementares.
- Resolução automática de ordem de cálculo de rubricas via grafo direcionado acíclico (`DAGResolver`), impedindo dependências circulares.
- Cálculo de médias históricas (horas extras, adicionais, comissões) para férias, 13º e rescisão contratual.
- Apuração automatizada de encargos patronais (INSS Empresa, RAT ajustado pelo FAP, Terceiros/Outras Entidades).

### 4.2 Ponto Eletrônico Homologado (Portaria MTP 671/2021)
- Registro de ponto digital com validação rigorosa de geolocalização e raio de tolerância.
- Detecção de tentativas de fraude (anti-spoofing de GPS, emuladores e adulteração de relógio).
- Numeração Sequencial de Registro (NSR) estrita e imutável.
- Importador nativo de arquivos AFD / AFDT / ACJEF via procedure PostgreSQL de alta performance.
- Gestão completa de banco de horas com controle de saldo acumulado, prazos de expiração legal e compensações.

### 4.3 Portal do Colaborador
- Interface fluida e responsiva para consulta individual de dados contratuais.
- Visualização de espelho de ponto em tempo real com status diário e marcações realizadas.
- Envio de justificativas de atraso, faltas e atestados médicos com anexo de comprovantes.
- Consulta, visualização e download de recibos de pagamento (holerites) e informes de rendimentos.
- Assinatura digital de documentos internos (contratos, termos de banco de horas, ciência de EPI).

---

## 5. Instruções de Desenvolvimento e Testes

### 5.1 Requisitos
- Node.js 22.x LTS
- Docker Desktop / Docker Engine com suporte a Compose v2

### 5.2 Comandos Principais do Monorepo

```bash
# Instalação limpa de todas as dependências
npm ci

# Execução de validação estática de tipos
npm run typecheck

# Execução de análise de lint
npm run lint

# Execução de toda a suíte de testes (core + api)
npm run test

# Build de produção de todos os pacotes
npm run build

# Execução do pipeline de CI local completo (Lint + Typecheck + Test + Build)
npm run ci

# Execução de migrações e seeds no banco de dados local
npm run db:migrate

# Execução do script de importação de dados do sistema legado
npm run etl:legacy
```

---

## 6. Histórico de Versões

- **v2.0.0 (Fase V0 — Concluída em 22/11/2026):**
  - Isolamento completo do histórico legado e criação do novo repositório limpo (`CoupleRHVPS`).
  - Estruturação do Monorepo modular open-source (`packages/payroll-core`, `apps/api`, `apps/web`).
  - Baseline 100% PostgreSQL 17 puro (`0001_baseline_schema.sql`) com 56 tabelas de negócio, 46 com RLS forçado, 150 triggers e seeds 2026.
  - Script ETL idempotente com conciliação financeira de divergência R$ 0,00 e 100% de integridade referencial.
  - Pipeline de CI no GitHub Actions com 5 gates bloqueadores contra container oficial `postgres:17-alpine`.
  - Documentação arquitetural e de banco de dados completamente sincronizada.
