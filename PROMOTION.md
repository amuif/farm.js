# Promotion Plan

This is the working plan for growing Farm.js visibility and GitHub stars. It replaces the loose notes from the August playground push (newsletters, Show HN, r/reactjs, short clips) with a measured baseline, a ranked channel list, and a dated six-week calendar.

The goal is developer adoption. Stars are a lagging signal of it, so every tactic here aims at people who might build something with Farm, not at the counter itself.

## Baseline (2026-10-18)

| Signal                                  | Value                                                                         |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| GitHub stars                            | 506 (1 in March, 54 in August, 9 in September, 442 in October)                |
| Biggest star days                       | Oct 10 (149), Oct 18 (92), Oct 17 (77), Oct 11 (68)                           |
| Repo views, last 14 days                | 1,246 views, 524 unique visitors                                              |
| Top referrers, last 14 days             | Instagram 258 uniques, farmjs.dev 46, github.com 44, Brave search 4, Google 2 |
| npm `@farm.js/core`, Oct 10-16          | 3,723 downloads per week                                                      |
| npm `@farm.js/create-app`, Oct 10-16    | 1,478 downloads per week                                                      |
| Contributors                            | 5                                                                             |
| Open issues labelled `good first issue` | 0                                                                             |
| GitHub Discussions                      | Disabled                                                                      |
| Custom social preview image             | Not set (GitHub generates a default card)                                     |
| Latest release                          | 0.1.26 (2026-10-18)                                                           |

How the numbers were collected:

```sh
gh api -H "Accept: application/vnd.github.star+json" --paginate \
  'repos/farming-labs/farm.js/stargazers?per_page=100' --jq '.[].starred_at'
gh api repos/farming-labs/farm.js/traffic/popular/referrers
gh api repos/farming-labs/farm.js/traffic/views
curl -s https://api.npmjs.org/downloads/point/last-week/@farm.js/core
```

Re-run these at every checkpoint in [Metrics](#metrics) and append the results to the [Log](#log).

## What the baseline says

1. **Almost all traffic comes from one personal channel.** Instagram sends five times more unique visitors than every developer channel combined. Search is close to zero (Google 2, Brave 4), and no newsletter, forum, or aggregator appears in the referrers at all.
2. **Recent stars are mostly casual.** A sample of accounts that starred on Oct 17 and 18 found 18 of 30 created after June 2026, 8 of 30 with zero public repositories, and 2 of 30 with five or more followers. The August and Oct 10 cohorts look like working developers. Casual stars are welcome, but they rarely turn into issues, PRs, or production apps, and a star curve that jumps in steps reads as inorganic to experienced reviewers.
3. **npm usage is real.** About 3.7k weekly core downloads against 1.5k create-app downloads means people are scaffolding apps, not only CI mirrors. The product is ready for a larger developer audience.
4. **Gatekeepers want maturity signals.** Coolify closed the deploy guide (coollabsio/coolify-docs#721) because Farm is "still relatively new to the ecosystem and in its early v0.x releases". Expect the same response from other curated lists until the repo shows outside contributors, real apps, and a steady release cadence.
5. **The repo page does not convert yet.** No custom social card, no Discussions, no starter issues, and a README whose first screen is a feature table rather than a 30-second proof.

## Principles

- **Developer channels first.** A visitor from This Week in React or Hacker News is worth more than ten from a general social feed. Prioritize channels where people try frameworks.
- **Lead with one measurable claim per post.** Farm already has defensible numbers. Use one per piece, link the reproducible benchmark, and never round up.
- **Ship the claim before posting it.** Do not demo an API or number that is not in a published release. The 0.1.0 film showed APIs that had not shipped yet; do not repeat that.
- **No paid or exchanged stars, ever.** Star-for-star groups, engagement panels, and giveaways break the GitHub Acceptable Use Policies, make lists such as Best of JS and OSS Insight discount the repo, and are easy to spot in `starred_at` data. The referrers already include one hit from `panel.socialplug.io`, a paid-engagement service; find out where it came from and make sure nothing is connected to it.
- **One owner per channel.** A channel without a named owner and a date does not happen.

## Assets to build before the next big push

These are repo changes. Each one gets its own small PR.

| #   | Asset                                                                                                                                                                                                                                                        | Why                                                                                                      | Effort             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------ |
| A1  | Custom social preview image (Settings > General > Social preview, 1280x640, built from `.github/assets/farmjs-lockup.svg` and the site tokens in `/design.md`)                                                                                               | Every link shared on X, Slack, Discord, and HN uses this card. Today it is GitHub's default.             | S, repo admin only |
| A2  | README first screen: one-line pitch, a 15-second GIF of create-app to first page to HMR, the StackBlitz button, and a three-row "measured" table (install size, boot time, server CPU per request against TanStack Start) linking to `benchmarks/frameworks` | Converts visitors who scroll once and leave. The feature table stays below.                              | M                  |
| A3  | Enable GitHub Discussions with Q&A, Show and Tell, and Ideas categories                                                                                                                                                                                      | Gives curious visitors somewhere to talk that is not an issue, and gives Show and Tell posts to reshare. | S                  |
| A4  | Label 10 or more `good first issue` and `help wanted` issues, each with a file pointer and a test command                                                                                                                                                    | Outside contributors are the maturity signal gatekeepers ask for.                                        | M                  |
| A5  | Issue templates (bug, feature, docs) and a "first PR in 15 minutes" section in `CONTRIBUTING.md`                                                                                                                                                             | Lowers the cost of the first contribution.                                                               | S                  |
| A6  | Comparison pages next to `/docs/migrations`: "Farm.js vs Next.js" and "Farm.js vs TanStack Start", each with the measured table and honest "choose the other one when" notes                                                                                 | These are the search terms people actually use. Search sends 6 visitors today.                           | M                  |
| A7  | Showcase page listing real apps (Viby, Farm.js Infrastructure at app.farmjs.dev, the starters) with a "submit yours" link to Discussions                                                                                                                     | Social proof for curated lists and newcomers.                                                            | S                  |
| A8  | Three 30 to 45 second clips from the existing launch-film pipeline: AOT compiler swap benchmark, one-line renderer switch, server functions as MCP tools                                                                                                     | Reusable on X, Bluesky, LinkedIn, YouTube Shorts, and Reddit.                                            | M                  |

## Channels, ranked

Ranked by expected developer reach per hour of work. Status is as of 2026-10-18.

### Tier 1: high-signal developer audiences

| Channel                                                           | Angle                                                                                            | Status and next step                                                                                                                      |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| This Week in React                                                | AOT React compiler: direct DOM updates with full fallback, plus the js-framework-benchmark entry | Not submitted. Send it once the bumped entry (krausest/js-framework-benchmark#2124, merged Oct 18) appears in the next official results.  |
| JavaScript Weekly, Node Weekly, Frontend Focus                    | "A Vite and Nitro full-stack framework that installs in 99 MB and runs five renderers"           | Not submitted. Use the Cooperpress submission form with the latest release post.                                                          |
| Show HN                                                           | "Farm.js, a full-stack framework on Vite and Nitro with five renderers"                          | Not posted. Post only after A1, A2, and A3 ship. Tuesday to Thursday, 8 to 10am US Eastern. Answer every comment for the first six hours. |
| r/reactjs, r/javascript, r/webdev, r/vuejs, r/sveltejs, r/solidjs | The same app on each renderer, with that subreddit's renderer first                              | Not posted. One subreddit per week, follow each sub's self-promotion rules, and post a write-up with code rather than a bare link.        |
| Vite ecosystem                                                    | awesome-vite listing; ask about vite-ecosystem-ci                                                | vitejs/awesome-vite#1144 open since Sep 1, ping once. Ask on the Vite Discord before opening an ecosystem-ci PR.                          |
| X and Bluesky                                                     | Clips from A8, benchmark threads, release notes                                                  | Ongoing. Tag Vite, UnJS, and renderer maintainers only when the post is about their tool.                                                 |

### Tier 2: listings and integrations (compounding, low effort)

| Channel                                                                | Status and next step                                                                                                                                                           |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Best of JS                                                             | Listed at bestofjs.org/projects/farmjs. Nothing to do.                                                                                                                         |
| krausest js-framework-benchmark                                        | Entry merged; #2124 bump merged Oct 18. Bump after every `@farm.js/react` release.                                                                                             |
| openship                                                               | Detection and icon merged.                                                                                                                                                     |
| Netlify build-info detection                                           | netlify/build#7266 open since Oct 13. Ping the frameworks team once.                                                                                                           |
| Railway, Fly, Zeabur, Dokploy deploy guides                            | railwayapp/docs#1403, superfly/docs#2542, zeabur/zeabur#817, Dokploy/examples#24 and Dokploy/website#198 are open. Bump pinned versions to the current release before pinging. |
| Coolify                                                                | Closed as too early (coollabsio/coolify-docs#721). Retry after 1.0, or once the repo shows visible outside contributors.                                                       |
| better-auth integrations page                                          | Not opened. Waku and Encore set the precedent, and Farm already documents better-auth.                                                                                         |
| State of JS 2026 write-ins (Devographics entities)                     | Not opened. Add Farm.js to the meta-frameworks entities so write-ins count.                                                                                                    |
| awesome-javascript, awesome-vue, awesome-preact, llms-txt-hub, devicon | Not opened. One PR each, after A2 so the README holds up to review.                                                                                                            |
| Context7 library listing                                               | "farm.js" currently resolves to farm-fe. Submit `farming-labs/farm.js` through the web form (repo owner only).                                                                 |

### Tier 3: longer bets

- **Talks.** Submit "Ahead-of-time compiling React without breaking React" to React Advanced, React Summit, ViteConf, and local meetups. Recorded talks keep sending traffic.
- **Podcasts.** Pitch JS Party, Syntax, and PodRocket with the compiler story and the agent-readable docs story.
- **Guest posts.** Offer "build X in 20 minutes" tutorials to dev.to, Hashnode, and the blogs of providers Farm integrates with (Stripe, Resend, Neon, Upstash). Provider blogs reach their own developers and usually link back.
- **Template marketplaces.** Vercel templates, Netlify templates, and StackBlitz starters for the auth and react-compiler starters.

## Six-week calendar

Week 1 starts Monday 2026-10-19.

| Week       | Ship                                               | Post                                                                               |
| ---------- | -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1 (Oct 19) | A1 social card, A3 Discussions, A5 issue templates | Nothing new. Reply on the open distribution PRs with current versions.             |
| 2 (Oct 26) | A2 README first screen, A4 starter issues          | Cooperpress submission with the latest release post. One X thread on install size. |
| 3 (Nov 2)  | A8 compiler clip, A7 showcase                      | This Week in React submission. r/reactjs write-up.                                 |
| 4 (Nov 9)  | A6 comparison pages                                | Show HN on Tuesday or Wednesday. Keep that day free to answer comments.            |
| 5 (Nov 16) | A8 renderer clip                                   | r/vuejs or r/sveltejs write-up. better-auth and State of JS PRs.                   |
| 6 (Nov 23) | A8 MCP clip                                        | Talk CFPs and one podcast pitch. Review metrics and rewrite weeks 7 to 12.         |

## Metrics

Check at the end of weeks 2, 4, and 6, and add a row to the [Log](#log).

| Metric                                                                    | Baseline | Week 6 target | Why it matters                                              |
| ------------------------------------------------------------------------- | -------- | ------------- | ----------------------------------------------------------- |
| Stars                                                                     | 506      | 1,200         | Headline signal for lists and gatekeepers.                  |
| Unique repo visitors per 14 days                                          | 524      | 3,000         | Reach.                                                      |
| Developer-channel share of referrers (HN, Reddit, newsletters, X, search) | under 5% | 50%           | Confirms the audience shift away from one personal channel. |
| Weekly `@farm.js/create-app` downloads                                    | 1,478    | 3,000         | Actual trials.                                              |
| Contributors                                                              | 5        | 12            | Maturity signal for curated lists.                          |
| Show and Tell discussions                                                 | 0        | 10            | Real apps people will vouch for.                            |

If stars rise but create-app downloads and contributors do not, the channel mix is wrong. Move effort toward Tier 1 and away from whatever drove the stars.

## Message bank

Every number below is measured and reproducible. Update it when a release changes the result.

- **Install size:** a clean `npm install` of core, CLI, and React is 99 MB on 0.1.24, against 105 MB for TanStack Start 1.169.3 (`benchmarks/frameworks` fixtures).
- **Boot and server cost:** 77 ms boot to first 200 and 330 us of server CPU per request, against 84 ms and 370 us for TanStack Start on the same fixture and machine.
- **AOT compiler:** about 6.8x faster keyed swaps and about 2x less CPU per action cycle in `benchmarks/compiler`, with a full fallback to normal React when eligibility cannot be proven.
- **Renderer choice:** React, Preact, Solid, Vue, and Svelte share the same routes, server functions, and integrations, selected with one line of config.
- **Deployment:** Nitro-backed output with first-class targets plus direct Nitro presets.
- **Agent-ready:** server functions exposed as MCP tools, and docs served as Markdown to agents.

Avoid in public copy: "blazingly fast" without a number, claims about unreleased APIs, and comparisons that were not measured on the same machine and fixture.

## Log

| Date       | Stars | 14-day uniques | Top referrers                               | create-app per week | Notes                                                                |
| ---------- | ----- | -------------- | ------------------------------------------- | ------------------- | -------------------------------------------------------------------- |
| 2026-10-18 | 506   | 524            | Instagram 258, farmjs.dev 46, github.com 44 | 1,478               | Baseline. Best of JS listed, Coolify declined, krausest bump merged. |
