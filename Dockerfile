# VibeShare node image: runs any node type.
#   docker run -p 7701:7701 -v vibeshare:/data ghcr.io/mabzgamesstudio/vibeshare provider --public-url https://cdn.example.org
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY gui/package.json gui/package-lock.json ./gui/
RUN npm --prefix gui ci
COPY tsconfig.json ./
COPY src ./src
COPY gui ./gui
RUN npm run build

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    VIBESHARE_HOME=/data
WORKDIR /app
COPY package.json ./
COPY --from=build /src/dist ./dist
COPY --from=build /src/gui/dist ./gui/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 7700 7701 7702
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["provider"]
