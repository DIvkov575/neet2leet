# neet2leet

Sync the problems you solved on [NeetCode](https://neetcode.io) to LeetCode.

NeetCode's GitHub sync stores your work in a `neetcode-submissions-*` repo.
neet2leet reads that repo, and for every problem not yet Accepted on your
LeetCode account it submits your newest submission in the language you wrote it in.

```sh
neet2leet            # dry run: show what would be submitted
neet2leet --yes      # submit
neet2leet --yes --fallback   # if the newest submission fails, try older ones
```

First run finds your `neetcode-submissions-*` repo with `gh` and reads your
LeetCode session from Firefox or Chrome. Both are saved to
`~/.config/neet2leet/config.json` (mode 0600).

- Skips Premium-only problems and problems already Accepted.
- Maps NeetCode's renamed slugs to LeetCode's (e.g. `pow-x-n` to `powx-n`).
- Counts a problem as Accepted only if LeetCode's final status is Accepted.
  LeetCode can pass the tests and then fail a problem's restrictions
  ("Restrictions Failed"), which does not count as solved.
- Submits one at a time, 12s apart, with backoff on rate limits.

Other commands: `neet2leet auth` (refresh the session), `neet2leet repo [owner/repo|path]`.
Env: `LEETCODE_SESSION`, `LEETCODE_CSRF`, `NEET2LEET_REPO`, `NEET2LEET_CONFIG`.

## Install

Needs [Bun](https://bun.sh) and, for private repos, the `gh` CLI.

```sh
bun run install-bin   # builds ./neet2leet and copies it to ~/.local/bin
```

Cookie readers, submit, and solved-list code come from
[leet-cli](https://github.com/DIvkov575/leet-cli).
