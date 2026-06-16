FROM mcr.microsoft.com/playwright:v1.49.0-noble

WORKDIR /app

COPY package*.json ./

# Install dependencies (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 karena browser sudah ada di base image)
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install

COPY server.js ./

EXPOSE 3001

CMD ["node", "server.js"]
