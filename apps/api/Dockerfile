# ==============================================================================
# CoupleRH Enterprise — API Server Dockerfile Multi-Stage (Node 22 LTS ARM64/x64)
# Fastify 5 + pg + pg-boss + Zod + Argon2id
# ==============================================================================

# --- Estágio 1: Builder ---
FROM node:22-alpine AS builder

WORKDIR /app

# Instalar dependências nativas para compilação (Argon2, etc.)
RUN apk add --no-cache python3 make g++

# Copiar arquivos de configuração do monorepo
COPY package*.json tsconfig.base.json ./
COPY packages/payroll-core/package*.json ./packages/payroll-core/
COPY packages/payroll-core/tsconfig*.json ./packages/payroll-core/
COPY apps/api/package*.json ./apps/api/
COPY apps/api/tsconfig*.json ./apps/api/
COPY apps/web/package*.json ./apps/web/

# Instalar todas as dependências (workspaces)
RUN npm ci

# Copiar código-fonte
COPY packages/payroll-core/src ./packages/payroll-core/src
COPY apps/api/src ./apps/api/src
COPY apps/api/db ./apps/api/db

# Compilar pacotes
RUN npm --workspace=@couplerh/payroll-core run build
RUN npm --workspace=@couplerh/api run build

# --- Estágio 2: Runner de Produção ---
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4000
ENV HOST=0.0.0.0

# Dependências mínimas de runtime
RUN apk add --no-cache wget ca-certificates tzdata
ENV TZ=America/Sao_Paulo

# Criar usuário não-privilegiado para execução segura
RUN addgroup -S couplerh -g 1001 && adduser -S couplerh -u 1001 -G couplerh

# Copiar package configs
COPY package*.json ./
COPY packages/payroll-core/package*.json ./packages/payroll-core/
COPY apps/api/package*.json ./apps/api/
COPY apps/web/package*.json ./apps/web/

# Instalar dependências apenas de produção
RUN npm ci --omit=dev

# Copiar artefatos compilados do estágio builder
COPY --from=builder /app/packages/payroll-core/dist ./packages/payroll-core/dist
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/db ./apps/api/db

# Criar pasta de storage com permissões adequadas
RUN mkdir -p /var/lib/couplerh/storage && chown -R couplerh:couplerh /var/lib/couplerh/storage /app

USER couplerh

EXPOSE 4000

# Healthcheck embutido
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:4000/health || exit 1

CMD ["node", "apps/api/dist/server.js"]
