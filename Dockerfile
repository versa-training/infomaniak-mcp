# Build context: the repository root.
#   docker build -t infomaniak-mcp .
FROM node:22.23.4-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS build
WORKDIR /srv
COPY package.json package-lock.json tsconfig.json ./
COPY packages packages
RUN npm ci --ignore-scripts
COPY src src
RUN for p in mail calendar kdrive contact kchat; do (cd packages/$p && npx tsc); done \
    && npx tsc \
    && npm prune --omit=dev --ignore-scripts

FROM node:22.23.4-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
WORKDIR /srv
ENV HOST=0.0.0.0 PORT=8787 NODE_ENV=production
COPY --from=build /srv/package.json /srv/package-lock.json ./
COPY --from=build /srv/node_modules node_modules
COPY --from=build /srv/dist dist
COPY --from=build /srv/packages packages
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/index.js"]
