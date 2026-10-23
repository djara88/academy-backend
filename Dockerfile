# Pinned, audit-friendly build of the Evolution API 2.3.7 pairing fix.
# Source: https://github.com/evolution-foundation/evolution-api/pull/2759
# Review and test before attaching this image to the existing Render service.
FROM alpine:3.21 AS source
RUN apk add --no-cache git ca-certificates
ARG EVOLUTION_PATCH_COMMIT=5cdf324044d4ddb178f1be487b42cfba2c346c47
RUN git init -q /source \
    && git -C /source remote add origin https://github.com/ErgoCodes/evolution-api.git \
    && git -C /source fetch --depth=1 origin "${EVOLUTION_PATCH_COMMIT}" \
    && git -C /source checkout -q --detach FETCH_HEAD \
    && test "$(git -C /source rev-parse HEAD)" = "${EVOLUTION_PATCH_COMMIT}" \
    && git -C /source submodule update --init --recursive

FROM node:24-alpine AS builder
RUN apk add --no-cache git ffmpeg wget curl bash openssl dos2unix
WORKDIR /evolution

# Keep the upstream patched lockfile; npm ci applies vendored patch-package patch.
COPY --from=source /source/package.json /source/package-lock.json ./
COPY --from=source /source/patches ./patches
COPY --from=source /source/tsconfig.json /source/tsup.config.ts ./
RUN npm ci --silent \
    && node -e "if(require('./node_modules/baileys/package.json').version!=='7.0.0-rc14')process.exit(1)" \
    && grep -q 'handleCompanionRegRefresh' ./node_modules/baileys/lib/Socket/socket.js

COPY --from=source /source/src ./src
COPY --from=source /source/public ./public
COPY --from=source /source/prisma ./prisma
COPY --from=source /source/manager ./manager
COPY --from=source /source/.env.example ./.env
COPY --from=source /source/runWithProvider.js ./
COPY --from=source /source/Docker ./Docker

RUN chmod +x ./Docker/scripts/* && dos2unix ./Docker/scripts/* \
    && ./Docker/scripts/generate_database.sh \
    && npm run build

FROM node:24-alpine AS final
RUN apk add --no-cache tzdata ffmpeg bash openssl
ENV TZ=America/Sao_Paulo
ENV DOCKER_ENV=true
WORKDIR /evolution
COPY --from=builder /evolution/package.json ./package.json
COPY --from=builder /evolution/package-lock.json ./package-lock.json
COPY --from=builder /evolution/node_modules ./node_modules
COPY --from=builder /evolution/dist ./dist
COPY --from=builder /evolution/prisma ./prisma
COPY --from=builder /evolution/manager ./manager
COPY --from=builder /evolution/public ./public
COPY --from=builder /evolution/.env ./.env
COPY --from=builder /evolution/Docker ./Docker
COPY --from=builder /evolution/runWithProvider.js ./runWithProvider.js
COPY --from=builder /evolution/tsup.config.ts ./tsup.config.ts
EXPOSE 8080
ENTRYPOINT ["/bin/bash", "-c", ". ./Docker/scripts/deploy_database.sh && npm run start:prod"]
