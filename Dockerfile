FROM node:20-bookworm

WORKDIR /app
ENV NODE_ENV=production

# Install node deps + Chromium with OS libraries (browser jobs)
COPY package*.json ./
RUN npm install --omit=dev && npx playwright install --with-deps chromium

COPY worker.js .

EXPOSE 8080
CMD ["node", "worker.js"]
