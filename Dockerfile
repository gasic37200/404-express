FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
ENV NODE_ENV=production DB_PATH=/data/courier.db PORT=3000
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# named volume은 처음 만들 때 이 소유권을 물려받는다
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "dist/main.js"]
