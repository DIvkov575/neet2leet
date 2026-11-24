/**
 * LeetCode session + settings storage for neet2leet.
 * Config lives at $NEET2LEET_CONFIG or ~/.config/neet2leet/config.json.
 * Env LEETCODE_SESSION / LEETCODE_CSRF override the saved session.
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { readFirefoxCookies } from "./firefox-cookies.ts";
import { readChromeCookies } from "./chrome-cookies.ts";
import { verifySession, type LeetCodeAuth } from "./leetcode-progress.ts";

export interface Config {
  session?: string;
  csrf?: string;
  /** NeetCode sync repo: "owner/repo" or a local path. */
  repo?: string;
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.NEET2LEET_CONFIG || join(homedir(), ".config", "neet2leet", "config.json");
}

export async function loadConfig(path = configPath()): Promise<Config> {
  const f = Bun.file(path);
  if (!(await f.exists())) return {};
  try {
    return (await f.json()) as Config;
  } catch {
    return {};
  }
}

export async function saveConfig(cfg: Config, path = configPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(cfg, null, 2) + "\n");
  // The file holds a session cookie: keep it private.
  await Bun.spawn(["chmod", "600", path]).exited;
}

export function resolveAuth(cfg: Config, env: NodeJS.ProcessEnv = process.env): LeetCodeAuth | null {
  const session = env.LEETCODE_SESSION || cfg.session;
  if (!session) return null;
  return { session, csrf: env.LEETCODE_CSRF || cfg.csrf };
}

/**
 * Grab the LeetCode session from Firefox, then Chrome; verify and save it.
 * Returns the LeetCode username and which browser it came from.
 */
export async function authFromBrowser(): Promise<{ username: string; from: string }> {
  const notes: string[] = [];
  for (const src of ["firefox", "chrome"] as const) {
    try {
      const reader = src === "firefox" ? readFirefoxCookies : readChromeCookies;
      const c = await reader("leetcode.com", ["LEETCODE_SESSION", "csrftoken"]);
      const session = c.get("LEETCODE_SESSION");
      if (!session) {
        notes.push(`${src}: no LeetCode session (are you logged in there?)`);
        continue;
      }
      const csrf = c.get("csrftoken");
      const username = await verifySession({ session, csrf });
      const cfg = await loadConfig();
      cfg.session = session;
      if (csrf) cfg.csrf = csrf;
      await saveConfig(cfg);
      return { username, from: src };
    } catch (err) {
      notes.push(`${src}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(
    "couldn't find a working LeetCode session in a local browser:\n  " +
      notes.join("\n  ") +
      "\nLog into leetcode.com in Firefox or Chrome and retry, or set LEETCODE_SESSION and LEETCODE_CSRF.",
  );
}
