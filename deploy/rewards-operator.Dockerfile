FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY scripts/ scripts/
COPY server/ server/
COPY src/lib/ src/lib/
RUN node --input-type=module -e 'import {build} from "esbuild"; await build({entryPoints:["scripts/rewards-operator.ts"],outfile:"runner/rewards-operator.mjs",bundle:true,packages:"external",platform:"node",format:"esm",target:"node22"});'

FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/runner/ runner/
RUN mkdir -p /var/lib/spreadline-rewards && chown node:node /var/lib/spreadline-rewards
USER node
ENV REWARDS_STATE_DIR=/var/lib/spreadline-rewards
VOLUME ["/var/lib/spreadline-rewards"]
CMD ["node", "runner/rewards-operator.mjs", "--execute", "--watch"]
