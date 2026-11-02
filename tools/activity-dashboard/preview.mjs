import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = join(dirname(fileURLToPath(import.meta.url)), "dist");
const files = new Map([
  ["/", ["index.html", "text/html"]],
  ["/index.html", ["index.html", "text/html"]],
  ["/styles.css", ["styles.css", "text/css"]],
  ["/app.mjs", ["app.mjs", "text/javascript"]],
  ["/model.mjs", ["model.mjs", "text/javascript"]],
  ["/activity.json", ["activity.json", "application/json"]],
]);
const server = createServer(async (request, response) => {
  const file = files.get(new URL(request.url, "http://localhost").pathname);
  if (!file) { response.writeHead(404).end("Not found"); return; }
  try {
    const content = await readFile(join(directory, file[0]));
    response.writeHead(200, { "Content-Type": `${file[1]}; charset=utf-8`, "Cache-Control": "no-store" });
    response.end(content);
  } catch (error) {
    console.error(error);
    response.writeHead(500).end("Preview file unavailable. Run the dashboard build first.");
  }
});
server.listen(4173, "127.0.0.1", () => console.log("Dashboard preview: http://127.0.0.1:4173"));
server.on("error", error => { console.error(error); process.exitCode = 1; });
