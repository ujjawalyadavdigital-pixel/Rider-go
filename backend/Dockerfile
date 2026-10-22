FROM node:22-slim
WORKDIR /srv/backend
COPY backend/package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY backend/src ./src
COPY app/www /srv/app/www
ENV PORT=3000 DB_FILE=/data/ridergo.db DEMO_MODE=1
VOLUME /data
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
