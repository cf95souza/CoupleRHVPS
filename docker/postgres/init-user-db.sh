#!/usr/bin/env bash
set -e

# ==============================================================================
# CoupleRH Enterprise — Script de Inicialização da Role de Aplicação no PostgreSQL
# Garante a criação da role couplerh_app com NOBYPASSRLS para defesa em profundidade
# ==============================================================================

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    -- 1. Criação da Role couplerh_app (não-superuser estrito, RLS obrigatório)
    DO \$\$
    BEGIN
        IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'couplerh_app') THEN
            CREATE ROLE couplerh_app WITH LOGIN PASSWORD 'couplerh_app_password_2026' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
        END IF;
    END
    \$\$;

    -- 2. Permissões de Conexão e Schemas
    GRANT CONNECT ON DATABASE couplerh_prod TO couplerh_app;
    GRANT USAGE ON SCHEMA public TO couplerh_app;
    GRANT USAGE ON SCHEMA audit TO couplerh_app;

    -- 3. Permissões padrão para futuras tabelas e sequências
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO couplerh_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO couplerh_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA audit GRANT SELECT, INSERT ON TABLES TO couplerh_app;
EOSQL
