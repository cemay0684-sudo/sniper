FROM node:22-alpine

# Çalışma dizini
WORKDIR /app

# Bağımlılık dosyaları
COPY package.json package-lock.json* pnpm-lock.yaml* yarn.lock* ./ 2>/dev/null || true

# Bağımlılıkları kur
RUN npm install --production=false

# Kaynak kod
COPY tsconfig.json ./tsconfig.json
COPY src ./src

# TypeScript derle
RUN npm run build

# Çalışma zamanı için sadece gerekli dosyaları tutmak istersek:
# (Basitlik için şimdilik tek stage, ileride multi-stage yapabiliriz.)

ENV NODE_ENV=production

EXPOSE 3000

CMD ["npm", "start"]
