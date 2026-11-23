# CoupleRH Enterprise — Arquitetura de Banco de Dados (PostgreSQL 17 Puro)

> **Versão:** 2.0.0 (Baseline Open-Source VPS)  
> **Motor:** PostgreSQL 17.x (`postgres:17-alpine`)  
> **Isolamento:** Multi-tenant com Row-Level Security (RLS) sob role restrita `couplerh_app`  
> **Auditoria:** Schema dedicado `audit` com integridade e imutabilidade criptográfica  

---

## 1. Princípios de Arquitetura e Segurança de Dados

1. **100% Código Aberto:** Eliminação completa de qualquer dependência de BaaS proprietário (zero Supabase, zero Vercel). O banco opera em container Docker oficial `postgres:17-alpine` na VPS Oracle Cloud ARM64.
2. **Defesa em Profundidade:**
   - A API conecta ao banco sob a role **`couplerh_app`** (usuário comum sem privilégio de superusuário).
   - O RLS é ativado forçadamente (`FORCE ROW LEVEL SECURITY`) em 46 tabelas com a coluna `tenant_id`.
   - O contexto transacional é injetado via variáveis de sessão locais:
     - `app.current_user_id` $\rightarrow$ lido por `current_app_user_id()`
     - `app.current_tenant_id` $\rightarrow$ lido por `current_app_tenant_id()`
     - `app.current_role` $\rightarrow$ lido por `current_app_role()`
     - `app.current_worker_id` $\rightarrow$ lido por `current_app_worker_id()`
3. **Auditoria Imutável:**
   - O schema `audit.logs` registra automaticamente inserts, updates e deletes com payload `OLD` e `NEW` em JSONB.
   - Triggers de bloqueio impedem atualização ou exclusão manual de registros em `audit.logs`, `time_punch_records`, `payslips` aprovados e `payroll_memory_calc`.
4. **Precisão Monetária Sem Ponto Flutuante:**
   - Todos os campos financeiros utilizam `NUMERIC(15,2)` no banco de dados e são manipulados em centavos inteiros via `@couplerh/payroll-core/money.ts` (arredondamento `HALF_UP`).

---

## 2. Mapa Estrutural dos Schemas

```
couplerh_prod
├── audit
│   └── logs (Tabela de trilha de auditoria append-only imutável)
└── public
    ├── Segurança & Autenticação Nativa (users, user_sessions, user_mfa_factors, auth_tokens, stored_files)
    ├── Governança Multi-Tenant (tenants, tenant_users, tenant_user_scopes)
    ├── Estrutura Corporativa (companies, establishments, departments, sectors, cost_centers, positions, workplaces, contract_types, holidays)
    ├── Gestão Contratual CLT (workers, contracts, dependents, contract_salaries, employee_deductions, leaves, vacation_periods, vacation_schedules, terminations)
    ├── Ponto Eletrônico Portaria 671/2021 (work_shifts, contract_work_shifts, time_devices, time_punch_records, time_punch_daily_summaries, time_bank_accounts, time_bank_transactions, time_punch_adjustments)
    ├── Benefícios Flexíveis (benefit_catalogs, employee_benefits)
    ├── Motor de Folha Enterprise (legal_versions, inss_parameters, irrf_parameters, general_legal_parameters, rubrics, payroll_periods, payroll_variable_events, payroll_fixed_events, payslips, payslip_items, payroll_memory_calc, payroll_company_taxes, payroll_loans)
    ├── Assinaturas & Documentos (employee_documents, document_signatures, signatures_log)
    └── eSocial Integrado (esocial_certificates, esocial_events, esocial_totalizers)
```

---

## 3. Catálogo das 56 Tabelas de Negócio

### 3.1 Schema de Auditoria (`audit`)
| Tabela | Descrição | Regra Especial |
|---|---|---|
| `audit.logs` | Trilha forense de alterações em todas as entidades | Imutável (`trg_prevent_audit_tampering`), registra `user_id` via `current_app_user_id()` |

### 3.2 Autenticação, Sessões e Storage Privado
| Tabela | Descrição | Chaves / Índices |
|---|---|---|
| `public.users` | Contas de usuário com senha Argon2id e controle anti-força-bruta | `email UNIQUE`, `cpf UNIQUE`, `idx_users_email` |
| `public.user_sessions` | Sessões de usuário ativas com tokens rotativos e nível AAL1/AAL2 | `refresh_token_hash UNIQUE`, `idx_user_sessions_lookup` |
| `public.user_mfa_factors` | Fatores de autenticação MFA TOTP (RFC 6238) com códigos de emergência | `user_id FK`, `idx_user_mfa_factors_user` |
| `public.auth_tokens` | Tokens de uso único (convite RH, 1º acesso colaborador, reset) | `token_hash UNIQUE`, expiração automática |
| `public.stored_files` | Catálogo de arquivos privados no disco da VPS (`/var/lib/couplerh/storage`) | `storage_rel_path UNIQUE`, hash SHA-256 |

### 3.3 Governança Multi-Tenant e Escopo RBAC
| Tabela | Descrição | Chaves / Índices |
|---|---|---|
| `public.tenants` | Organizações clientes com isolamento lógico | `id PK`, `status CHECK` |
| `public.tenant_users` | Associação de usuários aos tenants com papéis estritos | `UNIQUE(tenant_id, user_id)`, `role CHECK` |
| `public.tenant_user_scopes` | Escopos granulares (Filial, Depto, Equipe) com sigilo salarial | `scope_type CHECK`, `can_view_salary`, `can_view_medical` |

### 3.4 Estrutura Organizacional da Empresa
| Tabela | Descrição |
|---|---|
| `public.companies` | Empresas registradas com CNPJ, regime tributário e configurações fiscais |
| `public.establishments` | Filiais e estabelecimentos físicos/fiscais com CNPJ próprio |
| `public.departments` | Departamentos organizacionais da empresa |
| `public.sectors` | Setores funcionais internos aos departamentos |
| `public.cost_centers` | Centros de custo para apropriação contábil da folha |
| `public.positions` | Cargos cadastrados com código CBO e nível funcional |
| `public.workplaces` | Postos e locais de trabalho (presencial, teletrabalho, externo) |
| `public.contract_types` | Tipos de vínculo contratual (CLT, Estágio, Aprendiz, Temporário) |
| `public.holidays` | Calendário de feriados nacionais, estaduais e municipais |

### 3.5 Trabalhadores e Vínculos Contratuais CLT
| Tabela | Descrição |
|---|---|
| `public.workers` | Cadastro civil unificado de colaboradores (CPF, PIS, CTPS, dados bancários, PIX) |
| `public.contracts` | Contratos de trabalho ativos com salário-base, carga horária e parâmetros CLT |
| `public.dependents` | Dependentes legais para fins de dedução de IRRF e Salário-Família |
| `public.contract_salaries` | Histórico evolutivo de alterações salariais e motivos de promoção |
| `public.employee_deductions` | Deduções fixas autorizadas em folha (pensão alimentícia, previdência privada) |
| `public.leaves` | Afastamentos temporários (maternidade, auxílio-doença, acidente de trabalho) |
| `public.vacation_periods` | Controle de períodos aquisitivos e concessivos de férias com dobro legal |
| `public.vacation_schedules` | Agendamentos e fracionamentos de férias com abono pecuniário |
| `public.terminations` | Rescisões de contrato com cálculo de saldo, aviso prévio e multas rescisórias |

### 3.6 Ponto Eletrônico e Jornada (Portaria MTP 671/2021)
| Tabela | Descrição |
|---|---|
| `public.work_shifts` | Escalas de trabalho (semanal padrão, 12x36, turnos flexíveis) |
| `public.contract_work_shifts` | Vinculação temporal do colaborador a uma determinada escala |
| `public.time_devices` | Dispositivos homologados de registro (REP-C, REP-P Mobile, Importador) |
| `public.time_punch_records` | Marcações brutas de ponto com geolocalização e NSR sequencial |
| `public.time_punch_daily_summaries` | Resumo diário consolidado (trabalhadas, HE, noturnas, atrasos, faltas) |
| `public.time_bank_accounts` | Contas correntes de banco de horas por contrato |
| `public.time_bank_transactions` | Lançamentos de crédito, débito, compensação e expiração de banco de horas |
| `public.time_punch_adjustments` | Justificativas e solicitações de ajuste com fluxo de aprovação do gestor |

### 3.7 Benefícios e Catálogo Unificado
| Tabela | Descrição |
|---|---|
| `public.benefit_catalogs` | Catálogo de benefícios da empresa (`MEAL_VOUCHER`, `TRANSPORTATION_VOUCHER`, etc.) |
| `public.employee_benefits` | Adesão dos colaboradores aos benefícios com custeio empresa vs desconto empregado |

### 3.8 Motor de Folha de Pagamento CLT Enterprise
| Tabela | Descrição |
|---|---|
| `public.legal_versions` | Versões de vigência dos parâmetros legais previdenciários e tributários |
| `public.inss_parameters` | Faixas de alíquotas progressivas do INSS com tetos oficiais vigentes |
| `public.irrf_parameters` | Tabela progressiva do IRRF com faixas, alíquotas, deduções e dedução simplificada |
| `public.general_legal_parameters` | Parâmetros gerais (salário mínimo nacional, teto salário-família, alíquota FGTS) |
| `public.rubrics` | Catálogo de rubricas com fórmulas AST, naturezas eSocial e bases de incidência |
| `public.payroll_periods` | Competências da folha (mensal, 13º 1ª/2ª parcela, férias, rescisão, adiantamento) |
| `public.payroll_variable_events` | Lançamentos variáveis da competência (horas extras, comissões, faltas) |
| `public.payroll_fixed_events` | Eventos fixos contratuais de recorrência mensal |
| `public.payslips` | Holerites processados e consolidados com totais tributários e líquido |
| `public.payslip_items` | Detalhamento dos itens do holerite (código da rubrica, referência, valor) |
| `public.payroll_memory_calc` | Memória de cálculo imutável explicando passo a passo cada rubrica gerada |
| `public.payroll_company_taxes` | Apuração de encargos patronais (INSS Empresa, RAT/FAP, Terceiros/Outras Entidades) |
| `public.payroll_loans` | Gestão de empréstimos consignados com margem legal de 35% |

### 3.9 Documentos, Assinaturas Digitais e eSocial
| Tabela | Descrição |
|---|---|
| `public.employee_documents` | Documentos do colaborador vinculados a arquivos seguros em `stored_files` |
| `public.document_signatures` | Registro de assinaturas eletrônicas (PIN, OTP, biometria desenhada) |
| `public.signatures_log` | Trilha técnica de auditoria das assinaturas (IP, User-Agent, carimbo do tempo) |
| `public.esocial_certificates` | Cofre criptografado de certificados A1 (AES-256-GCM) para transmissão |
| `public.esocial_events` | Fila e histórico de eventos transmitidos ao ambiente nacional do eSocial |
| `public.esocial_totalizers` | Retornos e totalizadores oficiais de tributos apurados pelo eSocial (S-5001 a S-5011) |

---

## 4. Procedimentos e Funções do Sistema

### 4.1 Funções de Contexto de Sessão
```sql
CREATE OR REPLACE FUNCTION public.current_app_user_id() RETURNS UUID AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::UUID;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION public.current_app_tenant_id() RETURNS UUID AS $$
  SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::UUID;
$$ LANGUAGE sql STABLE;
```

### 4.2 Procedure de Importação de Arquivos AFD (Portaria 671/2021)
```sql
CREATE OR REPLACE PROCEDURE public.import_afd_punch_records(
    p_tenant_id UUID,
    p_company_id UUID,
    p_device_id UUID,
    p_punches JSONB
)
...
```

---

## 5. Recriação Completa do Banco

Para recriar a base de dados do zero em qualquer ambiente Docker ou VPS:

```bash
# 1. Subir container PostgreSQL 17
docker run -d --name couplerh-db -p 5432:5432 -e POSTGRES_DB=couplerh_prod -e POSTGRES_PASSWORD=secret postgres:17-alpine

# 2. Executar migrações com seeds 2026 automáticas
npm --workspace=@couplerh/api run migrate -- --seed

# 3. Executar validação de migração ETL de dados legados
npm --workspace=@couplerh/api run etl:legacy
```
