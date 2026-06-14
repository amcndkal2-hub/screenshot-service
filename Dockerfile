FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY server.js ./

EXPOSE 3001

CMD ["node", "server.js"]
