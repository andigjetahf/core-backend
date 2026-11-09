FROM node:20-alpine AS builder
RUN apk add --no-cache openssl libc6-compat
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY prisma ./prisma/
RUN npx prisma generate
COPY src ./src/
RUN npm run build

FROM node:20-alpine AS runner
RUN apk add --no-cache openssl libc6-compat
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY prisma ./prisma/
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh
EXPOSE 5000
ENTRYPOINT ["./entrypoint.sh"]
