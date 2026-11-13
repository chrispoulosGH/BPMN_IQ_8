FROM node:22.17.0-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY catalog ./catalog
ENV NODE_ENV=production
EXPOSE 7000
CMD ["node", "src/launcher.js"]
