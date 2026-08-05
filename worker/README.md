# resume-stats

Private click analytics for the resume landing page. Runs on Cloudflare Workers +
KV, both free at this volume.

- `POST /hit` — called by `index.html` on page load and on each tracked link.
- `GET /stats` — aggregates, gated behind the `STATS_PASSWORD` secret.

`stats.html` at the site root is the dashboard that reads from `/stats`.

## Setup

Run everything from this `worker/` folder.

1. **Sign in.** Creates a free Cloudflare account if you don't have one. No card needed.

   ```bash
   npx wrangler login
   ```

2. **Create the KV namespace**, then paste the printed `id` into `wrangler.toml`
   in place of `PASTE_KV_NAMESPACE_ID_HERE`.

   ```bash
   npx wrangler kv namespace create HITS
   ```

3. **Set the dashboard password.** Pick anything; you'll type it once into the
   stats page. It is stored encrypted at Cloudflare and never enters the repo.

   ```bash
   npx wrangler secret put STATS_PASSWORD
   ```

4. **Deploy.** Note the `https://resume-stats.<something>.workers.dev` URL it prints.

   ```bash
   npx wrangler deploy
   ```

5. **Paste that URL into two files**, replacing `YOUR-SUBDOMAIN`:
   - `../index.html` — the `ENDPOINT` constant near the bottom
   - `../stats.html` — the `ENDPOINT` constant in its script block

6. **Commit and push.** The dashboard is then at
   `https://aayanvikramsingh.github.io/Resume_AayanVikramSingh/stats.html`.

## Tagging your links

Anywhere you paste the resume link, add a source tag so the dashboard can tell
the channels apart:

```
https://aayanvikramsingh.github.io/Resume_AayanVikramSingh/?utm_source=linkedin&utm_medium=featured
```

Vary `utm_source` per channel — `linkedin`, `email`, `whatsapp`, `naukri`, or a
company name when you apply somewhere directly. Untagged visits show up as
`(untagged)`.

## Inspecting the raw data

```bash
npx wrangler kv key list --namespace-id 6d6f009018b1432c84145b9ad4bedc51 --remote
```

`--remote` is not optional. Without it Wrangler queries a local simulated KV and
cheerfully prints `[]`, which looks exactly like "nothing was recorded".

## Free tier

Workers allow 100k requests/day and KV allows 1,000 writes/day. One visit costs
one write, one click costs one more. A dashboard load costs a handful of reads
regardless of how much data has accumulated, because each event's payload lives
in its key's metadata and comes back with `list()`.

Events expire after 400 days.

## Privacy

No cookies, no client-side storage, no consent banner needed. Raw IPs are never
written down — repeat visits are recognised through a SHA-256 hash of IP + user
agent + the current date, which changes at every UTC midnight, so the same person
cannot be followed across days. None of this can identify anyone by name.
