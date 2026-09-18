const dist = "dist";
const port = Number(Bun.env.PORT || 1234);

await Bun.$`bun run build`;

const server = Bun.serve({
  port,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const file = Bun.file(`${dist}${path === "/" ? "/index.html" : path}`);
    return (await file.exists())
      ? new Response(file)
      : new Response("Not found", { status: 404 });
  },
});

console.log(`StreamCap running at http://localhost:${server.port}`);
