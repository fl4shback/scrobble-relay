FROM node:24-alpine
WORKDIR /app
COPY ./app/package.json ./
RUN npm install --omit=dev
COPY ./app/ ./
EXPOSE 3000
CMD ["npm", "start"]
