# 狼人杀「12人丘比特奇缘」腾讯云 CloudBase 云托管镜像
# 单容器同源部署：前端 dist/（静态）+ WebSocket 后端（server.js，监听 PORT||8080）

# ---------- 构建阶段：编译前端 ----------
FROM node:20-slim AS build
WORKDIR /app
# 先复制依赖清单，利用 Docker 层缓存
COPY package.json package-lock.json* ./
RUN npm install
# 复制源码并构建前端（产出 dist/）
COPY . .
RUN npm run build

# ---------- 运行阶段：仅装生产依赖 ----------
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
# 后端代码
COPY server.js ./
COPY party ./party
# 前端构建产物
COPY --from=build /app/dist ./dist

EXPOSE 8080
# 云托管会注入 PORT；本地默认 8080
CMD ["node", "server.js"]
