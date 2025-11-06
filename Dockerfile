FROM denoland/deno:latest

# Create app directory and set permissions
WORKDIR /app

# Copy files as root
COPY deno.json .
COPY src/ src/

# Set up proper permissions for deno cache directory and app
RUN mkdir -p /deno-dir && \
    chown -R deno:deno /deno-dir && \
    chown -R deno:deno /app

# Switch to deno user before caching
USER deno

# Cache dependencies as deno user
RUN deno cache src/main.ts

# Set up environment
EXPOSE 8080
ENV PORT=8080

CMD ["task", "start"]