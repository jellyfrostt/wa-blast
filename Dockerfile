FROM node:20-slim
RUN apt-get update && apt-get install -y git python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src/ ./src/
RUN mkdir -p /app/data
EXPOSE 3001
CMD ["npm", "start"]
