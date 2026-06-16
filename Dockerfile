FROM node:20-slim

# Install Chromium dan semua dependensi
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libgdk-pixbuf2.0-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libxss1 \
    libxtst6 \
    xdg-utils \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Verifikasi chromium berhasil terinstall dan catat path-nya
RUN echo "=== Chromium path ===" && \
    (which chromium && which chromium | xargs ls -la) || \
    (which chromium-browser && which chromium-browser | xargs ls -la) || \
    (echo "ERROR: chromium not found" && exit 1)

WORKDIR /app

COPY package*.json ./
RUN npm install

# Playwright: skip download, pakai chromium sistem
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY server.js ./
COPY start.sh ./
RUN chmod +x start.sh

EXPOSE 3001

CMD ["./start.sh"]
