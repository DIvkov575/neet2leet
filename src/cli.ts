#!/usr/bin/env bun
/**
 * neet2leet: submit the problems you solved on NeetCode.io to LeetCode, so
 * your LeetCode profile shows them as Accepted.
 *
 * Reads your NeetCode GitHub sync (`neetcode-submissions-*`), skips problems
 * already Accepted or Premium-only, and submits your newest submission in its
 * own language. Dry run unless --yes.
 */
import { parseArgs } from "node:util";
import { checkoutRepoSource, collectRepoProblems, discoverNeetcodeRepo, type RepoProblem } from "./repo.ts";
import { authFromBrowser, configPath, loadConfig, resolveAuth, saveConfig } from "./session.ts";
import { fetchSolvedSlugs, verifySession, type LeetCodeAuth } from "./leetcode-progress.ts";
import { submitSolution } from "./leetcode-submit.ts";
import { version } from "../package.json";

const HELP = `neet2leet ${version}: sync your NeetCode progress to LeetCode

Usage:
  neet2leet [sync] [repo] [options]  Show what would be submitted (dry run)
  neet2leet sync --yes               Submit it
  neet2leet auth                     Grab your LeetCode session from Firefox/Chrome
  neet2leet repo [owner/repo|path]   Show or set the NeetCode sync repo

repo is "owner/repo", a GitHub URL, or a local checkout. Default: the saved
repo, else $NEET2LEET_REPO, else your first GitHub repo named
neetcode-submissions-* (found with gh).

Options:
  -y, --yes          Actually submit (default is a dry run)
  -f, --fallback     If the newest submission fails, try older ones
  -n, --limit <n>    Submit at most n problems
      --delay <sec>  Seconds between submissions (default 12)
      --all          Also re-submit problems already Accepted on LeetCode
  -h, --help         Show this help
  -v, --version      Show the version

Config: ${configPath()}  (env LEETCODE_SESSION / LEETCODE_CSRF override)`;

class UserError extends Error {}

const LANG_LABEL: Record<string, string> = { python3: "py" };

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      yes: { type: "boolean", short: "y" },
      fallback: { type: "boolean", short: "f" },
      limit: { type: "string", short: "n" },
      delay: { type: "string" },
      all: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.help) return console.log(HELP), 0;
  if (values.version) return console.log(version), 0;

  const [cmd, ...rest] = positionals;
  switch (cmd) {
    case "auth": {
      const r = await authFromBrowser();
      console.log(`saved LeetCode session for "${r.username}" (from ${r.from}).`);
      return 0;
    }
    case "repo": {
      const cfg = await loadConfig();
      if (rest[0]) {
        cfg.repo = rest[0];
        await saveConfig(cfg);
        console.log(`repo set to ${rest[0]}`);
      } else {
        console.log(cfg.repo ?? process.env.NEET2LEET_REPO ?? "(unset; will auto-discover with gh)");
      }
      return 0;
    }
    case "help":
      console.log(HELP);
      return 0;
    case "sync":
      return sync(rest[0], values);
    case undefined:
      return sync(undefined, values);
    default:
      // Bare repo argument: `neet2leet owner/repo --yes`.
      if (rest.length === 0 && (cmd.includes("/") || cmd.startsWith("."))) return sync(cmd, values);
      throw new UserError(`unknown command "${cmd}". Run neet2leet --help.`);
  }
}

/** Get a verified session: saved/env first, else grab one from the browser. */
async function ensureAuth(): Promise<LeetCodeAuth> {
  const auth = resolveAuth(await loadConfig());
  if (auth?.csrf) {
    try {
      await verifySession(auth);
      return auth;
    } catch {
      console.error("saved LeetCode session expired; re-reading it from your browser…");
    }
  } else {
    console.error("no LeetCode session saved; reading it from your browser…");
  }
  const r = await authFromBrowser();
  console.error(`signed in as ${r.username} (from ${r.from}).`);
  const fresh = resolveAuth(await loadConfig());
  if (!fresh?.csrf) throw new UserError("browser session has no csrftoken; log into leetcode.com again.");
  return fresh;
}

/** LeetCode problem metadata, or null if the slug doesn't exist. */
async function problemMeta(slug: string): Promise<{ isPaidOnly: boolean } | null> {
  const res = await fetch("https://leetcode.com/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Referer: "https://leetcode.com/" },
    body: JSON.stringify({
      query: "query q($s: String!) { question(titleSlug: $s) { isPaidOnly } }",
      variables: { s: slug },
    }),
  });
  if (!res.ok) throw new Error(`LeetCode responded ${res.status} for ${slug}`);
  const json = (await res.json()) as { data?: { question?: { isPaidOnly: boolean } | null } };
  return json.data?.question ?? null;
}

async function sync(
  repoArg: string | undefined,
  values: { yes?: boolean; fallback?: boolean; limit?: string; delay?: string; all?: boolean },
): Promise<number> {
  const cfg = await loadConfig();
  const source = repoArg ?? cfg.repo ?? process.env.NEET2LEET_REPO ?? (await discoverNeetcodeRepo());
  if (!source) {
    throw new UserError(
      "no NeetCode sync repo found. Pass one (neet2leet owner/neetcode-submissions-xxxx) or save it:\n" +
        "  neet2leet repo owner/neetcode-submissions-xxxx",
    );
  }
  if (!cfg.repo && !repoArg) {
    cfg.repo = source;
    await saveConfig(cfg);
    console.error(`using ${source} (saved; change with \`neet2leet repo\`).`);
  }

  const dryRun = !values.yes;
  const limit = values.limit ? Math.max(1, Number(values.limit)) : Infinity;
  const delayMs = values.delay ? Math.max(0, Number(values.delay) * 1000) : 12_000;
  const auth = await ensureAuth();

  console.error(`reading your submissions from ${source}…`);
  const { dir, cleanup } = await checkoutRepoSource(source);
  try {
    const problems = await collectRepoProblems(dir);
    const remoteSolved = values.all ? new Set<string>() : new Set(await fetchSolvedSlugs(auth));

    const work: RepoProblem[] = [];
    const premium: string[] = [];
    const missing: string[] = [];
    let synced = 0;
    for (const pr of problems) {
      if (remoteSolved.has(pr.slug)) {
        synced++;
        continue;
      }
      if (work.length >= limit) continue;
      const meta = await problemMeta(pr.slug);
      if (!meta) missing.push(pr.neetcodeSlug === pr.slug ? pr.slug : `${pr.neetcodeSlug} (as ${pr.slug})`);
      else if (meta.isPaidOnly) premium.push(pr.slug);
      else work.push(pr);
    }

    console.log(`${problems.length} NeetCode problems, ${synced} already Accepted on LeetCode.`);
    if (premium.length) console.log(`skip ${premium.length} Premium-only: ${premium.join(", ")}`);
    if (missing.length) console.log(`skip ${missing.length} not on LeetCode: ${missing.join(", ")}`);
    if (work.length === 0) {
      console.log("nothing to submit: LeetCode is in sync.");
      return 0;
    }
    console.log(`${work.length} to submit:`);
    for (const pr of work) {
      const s = pr.submissions[0]!;
      console.log(`  ${pr.slug}  (submission-${s.n}.${LANG_LABEL[s.lang] ?? s.lang})`);
    }
    if (dryRun) {
      console.log(`\ndry run: nothing submitted. Re-run with --yes to submit.`);
      return 0;
    }

    const failed: string[] = [];
    let accepted = 0;
    let first = true;
    for (let i = 0; i < work.length; i++) {
      const pr = work[i]!;
      const attempts = values.fallback ? pr.submissions : pr.submissions.slice(0, 1);
      let ok = false;
      for (const s of attempts) {
        if (!first) await Bun.sleep(delayMs);
        first = false;
        process.stdout.write(`[${i + 1}/${work.length}] ${pr.slug} submission-${s.n} (${s.lang})… `);
        try {
          const v = await submitSolution(auth, pr.slug, await Bun.file(s.path).text(), {
            lang: s.lang,
            onRetry: (n, ms) => process.stdout.write(`(rate-limited, retry ${n} in ${Math.round(ms / 1000)}s)… `),
          });
          console.log(v.accepted ? "Accepted" : `${v.statusMsg}${v.detail ? `: ${v.detail.split("\n")[0]}` : ""}`);
          if (v.accepted) {
            ok = true;
            break;
          }
        } catch (err) {
          console.log(`error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (ok) accepted++;
      else failed.push(pr.slug);
    }
    console.log(`\ndone: ${accepted}/${work.length} accepted.`);
    if (failed.length) {
      console.log(`not accepted: ${failed.join(", ")}${values.fallback ? "" : " (--fallback tries older submissions)"}`);
    }
    return failed.length ? 1 : 0;
  } finally {
    await cleanup();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(err instanceof UserError ? 2 : 1);
  },
);
