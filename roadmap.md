# Roadmap

- [x] Import the public GitHub project (spark-tale-flair) into this workspace
- [x] Store the Z.ai and Agnes keys as encrypted server-only secrets (never in code, never in the browser)
- [x] Keep Z.ai on glm-4.5-flash (free) and Agnes on agnes-image-2.5-flash (free)
- [x] Replace the rate-limit handling: one adaptive, cross-tab image budget in the page
      (src/lib/image-rate.ts) plus a fast-failing server safety gate, so the run never
      freezes for 15-20 minutes after a limit
