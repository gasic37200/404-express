FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# 운영 이미지: 빌드 도구 없이 dist와 운영 의존성만 담는다. SQLite는 Node 내장(node:sqlite)이라 네이티브 빌드가 없다.
FROM node:24-alpine
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
# 이미지에 curl이 없어서 Node로 /health를 부른다
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]
