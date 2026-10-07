import type { Config } from "./config.js";
import type { DB } from "./db.js";

export interface Ctx {
  db: DB;
  config: Config;
  /** Injectable clock so tests can control time (expiry, daily limits, PIN lockout). */
  now: () => Date;
}
