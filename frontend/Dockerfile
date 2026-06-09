FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Vite reads VITE_* env vars at build time and inlines them into the bundle.
# Railway passes service variables as build args; ARG + ENV makes them visible to `npm run build`.
ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=build /app /app
ENV PORT=4173
EXPOSE 4173
CMD ["sh", "-c", "npm run start"]
