import { createApp } from "./app.js";
import { config } from "./config.js";
import { openDb } from "./db.js";

const db = openDb(config.dbPath);
const app = createApp({ db, config, now: () => new Date() });

const server = app.listen(config.port, () => {
  console.log(`UAE instant payments simulator listening on http://localhost:${config.port}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
