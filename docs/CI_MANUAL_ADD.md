# Adding the CI workflow manually (required — GitHub App cannot)

## Why manual is needed

The Muse GitHub App does **not** request the Workflows permission.
That is an app-level limitation, not a setting you can toggle on
your side to fix it: granting repository access does not add a
permission the app never requested. Proof in this repo: a push
containing `.github/workflows/ci.yml` fails with
`403 Resource not accessible by integration` on tree creation, while
the identical push without that one file succeeds (see Phase 1 and
Phase 2 reports). No repository permission is changed by this guide,
and no permission change is requested.

The workflow file itself is validated locally (YAML parses, no
`secrets.*` in any `if:` condition, `permissions: contents: read`,
Node 20 matching `engines: >=20` in `package.json`, `npm ci` with
fallback to `npm install`, then `npm test`). It is kept in the
local copy at `.github/workflows/ci.yml` for reference.

## Option A — GitHub web UI (no terminal, recommended)

1. Open https://github.com/SouvikPati11/PayCrypto
2. Click **Add file** → **Create new file**.
3. In the filename box, type exactly:
   `.github/workflows/ci.yml`
   (GitHub will create the `.github/workflows/` folders for you.)
4. Paste the entire workflow below — nothing else, no extra spaces
   at the start.
5. Click **Commit changes** → **Commit directly to the `main` branch**
   → **Commit changes**.
6. Open the **Actions** tab. The `CI` workflow should appear and run
   on that commit. If Actions are disabled for the repo, enable them
   under Settings → Actions → General first (your choice, not
   changed by this guide).

## Option B — Git from your own machine (alternative)

```bash
git clone https://github.com/SouvikPati11/PayCrypto.git
cd PayCrypto
mkdir -p .github/workflows
# Copy .github/workflows/ci.yml from the local PayCrypto copy
# (~/workspace/paycrypto/.github/workflows/ci.yml) into this folder,
# then:
git add .github/workflows/ci.yml
git commit -m "ci: add GitHub Actions workflow (node 20, npm test)"
git push origin main
```

## The exact workflow content to paste

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci || npm install
      - run: npm test
```

## Verify it worked

- The file must exist at
  https://github.com/SouvikPati11/PayCrypto/blob/main/.github/workflows/ci.yml
- The Actions tab must show a `CI` run for the commit that added it.
- If the run fails on `npm ci`, check that `package-lock.json` on
  `main` matches `package.json` — the workflow already falls back
  to `npm install` in that case, so a lock mismatch alone should
  not block the test step.
