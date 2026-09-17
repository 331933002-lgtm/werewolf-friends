FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --registry=https://registry.npmmirror.com
COPY server.js ./
COPY party ./party
EXPOSE 8080
CMD ["node", "server.js"]
