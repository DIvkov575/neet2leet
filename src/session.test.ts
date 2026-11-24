import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveAuth, saveConfig } from "./session.ts";

test("config round-trips to disk with 0600 perms; env overrides session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "n2l-"));
  const path = join(dir, "nested", "config.json");
  try {
    expect(await loadConfig(path)).toEqual({});
    await saveConfig({ session: "s", csrf: "c", repo: "me/neetcode-submissions-x" }, path);
    const cfg = await loadConfig(path);
    expect(cfg.repo).toBe("me/neetcode-submissions-x");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(resolveAuth(cfg, {})).toEqual({ session: "s", csrf: "c" });
    expect(resolveAuth(cfg, { LEETCODE_SESSION: "e", LEETCODE_CSRF: "f" })).toEqual({ session: "e", csrf: "f" });
    expect(resolveAuth({}, {})).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
