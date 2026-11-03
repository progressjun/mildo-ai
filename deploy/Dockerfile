# syntax=docker/dockerfile:1.7
# MILDO OS Cloud — API 서버 + 빌드된 프런트(dist) + 워커를 담은 하나의 이미지 (멀티 스테이지)
#
#   빌드:  docker build -f deploy/Dockerfile -t mildo-os-cloud:latest .          (저장소 루트에서)
#   API:   docker run --init -p 8080:8080 --env-file deploy/.env mildo-os-cloud:latest
#   워커:  docker run --init --env-file deploy/.env mildo-os-cloud:latest node server/dist/worker.mjs
#   DB:    docker run --rm --env-file deploy/.env mildo-os-cloud:latest node server/dist/cli.mjs migrate
#
# server/dist 번들은 package.json의 패키지를 모두 외부(external)로 두므로 런타임에 dependencies의 node_modules가 필요하다
# (devDependencies는 넣지 않는다). 무시 목록: deploy/Dockerfile.dockerignore
#
# 사내 SSL 검사 프록시처럼 TLS를 다시 서명하는 네트워크에서는 그 CA를 빌드 비밀값으로 넘긴다(이미지에는 남지 않는다):
#   docker build --secret id=extra_ca,src=/path/to/corp-ca.crt -f deploy/Dockerfile .
#   compose: CA 파일을 deploy/ 안에 두고 .env에 EXTRA_CA_FILE=./corp-ca.crt

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------- 1) 의존성 (빌드용: dev 포함) ----------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    npm ci

# ---------- 2) 빌드: 프런트(vite → dist) + 서버 번들(esbuild → server/dist) ----------
FROM deps AS build
# 타입 검사는 CI가 따로 한다. 이미지 빌드에서도 기본으로 수행하고(npm run build = tsc --noEmit && vite build),
# 급한 핫픽스 빌드에서만 --build-arg SKIP_TYPECHECK=true로 vite build만 실행한다.
ARG SKIP_TYPECHECK=false
COPY . .
RUN if [ "$SKIP_TYPECHECK" = "true" ]; then npx vite build; else npm run build; fi \
 && npm run server:build \
 && test -f dist/index.html && test -f server/dist/index.mjs && test -f server/dist/worker.mjs && test -f server/dist/cli.mjs

# ---------- 3) 런타임 의존성 (dependencies만) ----------
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
ENV npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    npm ci --omit=dev --ignore-scripts

# ---------- 4) 런타임 ----------
FROM ${NODE_IMAGE} AS runtime
ARG APP_VERSION=1.0.0
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.title="MILDO OS Cloud" \
      org.opencontainers.image.description="마케팅 운영 SaaS — API · 프런트 · 워커" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}"

ENV NODE_ENV=production \
    STATIC_DIR=dist \
    PORT=8080 \
    HOST=0.0.0.0 \
    TZ=Asia/Seoul \
    NODE_OPTIONS=--enable-source-maps

WORKDIR /app
RUN groupadd --system --gid 10001 mildo \
 && useradd --system --uid 10001 --gid mildo --home-dir /app --no-create-home --shell /usr/sbin/nologin mildo

# 코드는 root 소유 · 읽기 전용 (앱 사용자는 쓰기 권한이 없다)
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/migrations ./server/migrations
COPY deploy/tools ./deploy/tools

USER mildo
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>r.json().then(j=>process.exit(r.ok&&j.ok?0:1))).catch(()=>process.exit(1))"]
CMD ["node", "server/dist/index.mjs"]
