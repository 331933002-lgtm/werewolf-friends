FROM ccr.ccs.tencentyun.com/library/node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --registry=https://registry.npmmirror.com
COPY server.js ./
COPY party ./party
EXPOSE 8080
CMD ["node", "server.js"]
