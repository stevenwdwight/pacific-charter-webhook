FROM node:20-slim
WORKDIR /app
COPY package.json .
COPY server.js .
RUN npm install --production 2>/dev/null; exit 0
EXPOSE 10000
CMD ["node", "server.js"]
