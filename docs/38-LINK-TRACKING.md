# 38 — Link tracking (BHPC and aplayermode.com)

**Status:** LIVING EXECUTION RECORD. Goal: the next sale of the Billionaire High Performance Coach
(BHPC, A Player Mode's flagship digital product on Gumroad) says where the buyer came from.

## Where the links live

| Surface | Source | BHPC buy links |
|---|---|---|
| `aplayermode.com` (landing) | `sprylabs-hpc-site/aplayermode/` (see `REPO_IDENTITY.md`) | 8 on the home page; changes belong in that repo |
| `app.aplayermode.com` (this repo, `apps/mobile`) | this repo | none (checked with `grep -rn gumroad` over the repo, 8 Nov 2026) |

## What Gumroad records (from Gumroad's own docs, read 8 Nov 2026)

- **UTM links**: `utm_source`, `utm_medium` and `utm_campaign` added to a product URL auto-create
  a UTM link the first time someone uses it. Gumroad counts unique clicks, and a purchase within
  7 days is attributed to that link. Analytics → Links shows Clicks, Sales, Revenue and Conversion
  rate per link. A product-page link counts only purchases of that product.
  ([analytics dashboard](https://gumroad.com/help/article/74-the-analytics-dashboard),
  [UTM links announcement](https://gumroad.gumroad.com/p/paypal-is-back-on-gumroad-utm-links))
- **Referrer**: the page that sent the buyer to Gumroad is the sale's referrer (the analytics
  referrer list and the sales CSV's Referrer column). A `referrer=` URL parameter overrides it
  ([URL parameters](https://gumroad.com/help/article/270-url-parameters)).
- Gumroad does not see the UTM tags on *our* page. A tag on an aplayermode.com URL shows in that
  site's analytics only, unless the page passes it on to its buy links.

## The scheme

| Parameter | Values |
|---|---|
| `utm_source` | `kdp` · `pinterest` · `instagram` · `tiktok` · `direct-share` |
| `utm_medium` | on buy buttons: `site`; otherwise leave it out |
| `utm_campaign` | the book or post slug (lower-case, hyphens), e.g. `executive-dysfunction` |

Buy buttons on our own pages use `utm_source=<site host>`, `utm_medium=site`,
`utm_campaign=<page slug>-<button slug>` (e.g. `home-hero`), so Gumroad's Links view shows which
page and which button sold.

## Ready-made share link (for messages she sends by hand)

```
https://aplayermode.com/?utm_source=direct-share&utm_campaign=<slug>
```

KDP in-book link: `https://aplayermode.com/?utm_source=kdp&utm_campaign=<book-slug>`.
Pins: `utm_source=pinterest&utm_campaign=<pin-slug>`.

## Page analytics (free)

`aplayermode.com` already runs Microsoft Clarity (free), which records the referrer and the full
landing URL with its UTM tags per session. No paid tool is used.
