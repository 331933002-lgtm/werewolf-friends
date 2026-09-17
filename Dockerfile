FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server.js ./
COPY party ./party
EXPOSE 8080
CMD ["node", "server.js"]
