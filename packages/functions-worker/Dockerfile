# Pin matches packages/cli/releases/deno/VERSION (CDN mirror uses the same).
FROM denoland/deno:debian-2.2.0

WORKDIR /app
COPY deno.json main.ts ./

ENV PORT=8001
EXPOSE 8001

CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "main.ts"]
