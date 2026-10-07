# A Player Mode — Track Library and App-Only Tracks

**Status:** OWNER-APPROVED SPECIFICATION
**Date:** 2026-10-07
**Implementation:** `packages/domain/src/index.ts` (`TRACK_DISPLAY_NAMES`), `packages/planning/src/methodology.ts` (`BUILTIN_TRACKS`, `recommendTrackKeys`), `packages/planning/src/track-rules.ts` (reason codes)
**Pinned by:** `packages/planning/test/tracks.test.mjs` reads the Track table and every reason code below against the code.

BHPC v2.1 (`docs/reference/BHPC-v2.1/`, Part IX and Appendix A) supplies four Tracks. APM adds three app-only Tracks for gaps no BHPC Track covers. The two ChatGPT-proposed Tracks were dropped and retired in migration 0020 (§8).

## 1. The seven Tracks

Display names live in one map in code; keys are stable and stored names are never shown.

| Key | Display name | Origin |
|---|---|---|
| `billionaire_mindset` | Billionaire High Performance Coach Track | bhpc |
| `operator_discipline` | Operator Discipline Track | bhpc |
| `strategic_patience` | Strategic Patience Track | bhpc |
| `resilience` | Resilience Track | bhpc |
| `body_foundation` | Body Foundation Track | app |
| `wealth_foundation` | Wealth Foundation Track | app |
| `home_front` | Home Front Track | app |

### Track 1 principle library (later)

The Billionaire High Performance Coach Track will later carry a **principle library of high-performer wisdom**. It holds **principles only**: no quotes attributed to, no likenesses of, and **no implied endorsement by real people**. A principle is stated in APM's own words as a rule the user can apply; it is never presented as advice from, or approved by, any named individual.

## 2. Personas we market to

| Persona | Primary Tracks |
|---|---|
| **Wealth building** | Wealth Foundation Track, Strategic Patience Track, Operator Discipline Track |
| **Weight loss** | Body Foundation Track, Strategic Patience Track, Resilience Track |
| **Founder / Entrepreneur** | Billionaire High Performance Coach Track, Operator Discipline Track, Strategic Patience Track, Resilience Track |
| **Operator** | Operator Discipline Track, Strategic Patience Track, Resilience Track |
| **Parent+** (a parent who is also a founder, entrepreneur or operator) | Home Front Track, Resilience Track, Operator Discipline Track |

Defaults are chosen by `recommendTrackKeys`; the user can always change them. The Billionaire High Performance Coach Track is recommended only where an ownership game (a business or equity) is present, never to a wealth-building user on its own.

## 3. App-only Tracks in one screen

| # | App-only Track | Purpose (one line) | Personas |
|---|---|---|---|
| 1 | **Body Foundation Track** (`body_foundation`) | Build a "person who takes care of their body" identity through small, tracked behaviours at a safe pace. It never prescribes diet or medical action. | Weight loss (primary); also founders, operators and parents who name health as a pillar |
| 2 | **Wealth Foundation Track** (`wealth_foundation`) | Personal wealth through behaviour: pay yourself first, automate, close debts one at a time, and secure the downside before chasing upside. It gives no product advice. | Wealth building (primary); also operators and parents |
| 3 | **Home Front Track** (`home_front`) | Protect presence and family time when someone is playing a second game. Family commitments are scheduled and defended like board meetings. | Parent+ (primary); also founders and operators with partners or children |

- **Runner-up, not built: Career Capital** (visibility and sponsorship for operators). The operator persona already has the most BHPC coverage, and its main check already exists as a Radar pattern. It is the natural next Track if the cap is ever raised.

Research and the full Track specifications follow (research dated 6 Oct 2026).

## 4. Persona → Track map and gaps

| Persona | BHPC Tracks that serve it | Gaps no BHPC Track covers |
|---|---|---|
| Wealth building | Strategic Patience (compounding, no panic moves) is strong. Operator Discipline (keeping the plan) is strong. Billionaire High Performance Coach is a **poor fit, and risky**: "favor asymmetric upside" and "ownership > income" push someone with credit-card debt and no emergency fund toward speculation. | Saving by default, an order for paying down debt, building a buffer before taking risk, and spending leaks (subscriptions). These are failures of personal-finance behaviour, not of venture judgement. |
| Weight loss | Resilience (lapses, all-or-nothing) partly. Strategic Patience (plateaus, no programme-hopping) partly. Operator Discipline (logging) partly. | Body or health identity. Self-monitoring cadence. A **safe-pace ceiling** and crash-diet guard. Doctor referral. The abstinence-violation spiral, which is specific to eating. No BHPC Track mentions the body. |
| Founder / entrepreneur | All 4, with Billionaire High Performance Coach as the flagship. | Mostly covered. A residual gap is family and presence for founders with families (→ Home Front) and health erosion under pressure (→ Body Foundation). |
| Operator (moving up at a company) | Operator Discipline, Strategic Patience and Resilience. Billionaire High Performance Coach only fits operators who hold equity. | Career visibility, sponsorship and stakeholder politics. This is a real gap, but the persona is otherwise well served (→ Career Capital, runner-up). |
| Parent+ (parent who is also a founder, entrepreneur or operator) | Resilience (capacity) and Operator Discipline (the plan). | **Protecting presence and family time.** Every BHPC Track tunes the work game. None defends the second game against the first. Billionaire High Performance Coach ("leverage instead of activity", "is this correct in 10 years") can even justify more work hours. |

## 5. Evidence: what drives success and failure for each gap

### Weight loss / body
- **Self-monitoring is the strongest behavioural predictor.** Frequent, consistent self-weighing and food logging predict loss and maintenance. Over 75% of National Weight Control Registry members weigh themselves at least weekly. About 90% exercise regularly, and that is the best single predictor of maintenance. Sources: [PMC4149603](https://pmc.ncbi.nlm.nih.gov/articles/PMC4149603/), [Drexel, consistent self-weighing](https://researchdiscovery.drexel.edu/esploro/outputs/journalArticle/Consistent-self-monitoring-of-weight-a-key/991014878135404721), [PMC6861630](https://pmc.ncbi.nlm.nih.gov/articles/PMC6861630)
- **Safe pace.** CDC: people who lose about 1–2 lb per week are more successful at keeping weight off. Source: [CDC archived page](https://webarchive.library.unt.edu/eot2008/20090116002322mp_/http:/www.cdc.gov/nccdphp/dnpa/healthyweight/losing_weight/index.htm)
- **The main failure mode is the abstinence-violation ("what-the-hell") effect.** One perceived slip triggers more overeating, and internal "I'm weak" attributions make it worse. Self-compassion after a slip improves control in the hours that follow. Sources: [PMC10909537](https://pmc.ncbi.nlm.nih.gov/articles/PMC10909537), [WW on the what-the-hell effect](https://www.weightwatchers.com/us/blog/what-the-hell-effect)
- **Identity drives adherence.** People who see themselves as "exercisers" do more and keep doing it. Identity as a correlate is well evidenced; identity as an intervention is under-researched. Sources: [PMC8114372](https://pmc.ncbi.nlm.nih.gov/articles/PMC8114372), [SDT, exercise identity](https://selfdeterminationtheory.org/SDT/documents/Understanding_variations_in_exercise-identity.pdf)
- **Competitor: Noom** sells "psychology, not dieting": daily CBT/ACT-style lessons, a 1–2 lb/week expectation, no banned foods, and coaching. Sources: [Healthline review](https://healthline.com/nutrition/noom-diet-review), [App Store](https://apps.apple.com/app/id634598719)

### Personal wealth
- **Defaults beat willpower.** Under auto-enrolment, participation was 90% at hire and 96% at 36 months, against 20% and 65% under opt-in. Save More Tomorrow (commit now to raise savings with each future pay rise) was accepted by about 80% of people who had refused an immediate increase. Sources: [Chicago Booth Review](https://www.chicagobooth.edu/review/2013/september/retirement-savings), [Thaler's Senate testimony](https://www.jec.senate.gov/archive/Documents/Hearings/thalertestimony10march2004.pdf)
- **Debt: small wins keep people going.** Closing accounts, whatever their balance, predicted eliminating all debt. "Small victories" payers were about 14% more likely to finish. Sources: [Kellogg Insight](https://insight.kellogg.northwestern.edu/article/to_beat_debt_consider_starting_small), [Kellogg news](https://www.kellogg.northwestern.edu/news/blog/2012/08/07/the-snowball-approach-to-debt/)
- **Failure mode: speculation dressed as ambition.** Each point on the Manifestation Scale meant about 40% higher odds of past bankruptcy and about 30% higher odds of having bought crypto, with no gain in income. Sources: [UQ news](https://news.uq.edu.au/2023-09-20-manifesting-your-way-bankruptcy), [Dixon et al. 2023, PSPB](https://researchgate.net/profile/Lucas-Dixon/publication/372220661_The_Secret_to_Success_The_Psychology_of_Belief_in_Manifestation/links/64ad0976c41fb852dd683610/The-Secret-to-Success-The-Psychology-of-Belief-in-Manifestation.pdf)
- **Competitors:**
  - YNAB sells a method: every dollar gets a job.
  - Rocket Money sells leak-stopping: subscription cancelling, bill negotiation and safe-to-spend.
  - Monarch sells net-worth visibility.
  - None of them enforces *behaviour* through a daily plan, and that is APM's opening.
  - Sources: [Rocket Money vs Monarch](https://rocketmoney.com/learn/personal-finance/monarch-money-vs-rocket-money), [unstar 2026 ranking](https://unstar.app/blog/ynab-rocket-money-monarch-everydollar-copilot-budget-apps-ranked-2026)

### Parent+ / family presence
- **Technoference.** Even low, "normal" levels of phone interruption during family time are associated with more child frustration, whining and tantrums. Mothers reported device interruptions in 65% of playtime and 26% of mealtimes and bedtimes. Sources: [PMC5681450 (McDaniel & Radesky)](https://pmc.ncbi.nlm.nih.gov/articles/PMC5681450/), [Zero to Three](https://zerotothree.org/resource/technoference-parent-mobile-device-use-and-implications-for-children-and-parent-child-relationships)
- **Detachment is the recovery mechanism.** Mentally detaching from work in the evening predicts better sleep, mood and life satisfaction. Workload is what erodes it. Sources: [Sonnentag stressor-detachment model](https://madoc.bib.uni-mannheim.de/48525/), [Univ. Mannheim](https://www.uni-mannheim.de/en/newsroom/forum/edition-2-2023/research/evening-recovery/)
- **Entrepreneurs find it harder to detach than employees.** Boundary strategy (segmentation versus integration) shapes work–family conflict. Mothers of young children and early-stage founders tend to integrate, so the boundaries have to be explicit rather than assumed. Sources: [IDEAS/RePEc, J. Small Business Mgmt 2019](https://ideas.repec.org/a/taf/ujbmxx/v57y2019i1p185-205.html), [Auburn, boundary theory](https://etd.auburn.edu/handle/10415/7817)

### Operator / career (runner-up)
- **Sponsorship is the gap, not effort.** People with a senior sponsor are about 2.3× more likely to get a stretch role or promotion. Managers with a sponsor were 53–60% more likely to be promoted or to receive stretch work. Sources: [Stanford Medicine, sponsorship](https://med.stanford.edu/facultydevelopment/mentorship-and-sponsorship/sponsorship.html), [WEF 2023](https://www.weforum.org/stories/2023/04/growth-summit-2023-sponsorship-women-workplace-equity/), [Fortune](https://fortune.com/2012/05/21/want-to-move-up-in-the-business-world-get-a-sponsor)

### Cross-cutting: why deterministic enforcement works
- **If-then plans have a medium-to-large effect on goal attainment** (d ≈ 0.65 over 94 tests; d 0.27–0.66 over 642 tests in 2024). The effect is largest when the if-then format is used and the plan is rehearsed. APM's agenda and Radar can generate if-then plans and check for them. Sources: [NCI, implementation intentions](https://cancercontrol.cancer.gov/brp/research/constructs/implementation-intentions), [KOPS Konstanz](https://kops.uni-konstanz.de/handle/123456789/69905)

## 6. Shortlist scoring (1 = poor, 5 = strong)

| Candidate | Persona coverage and ad pull | Distinct from the 4 BHPC Tracks | Deterministically enforceable | Safety | Total | Verdict |
|---|---|---|---|---|---|---|
| Body Foundation | 5 (weight loss is the biggest consumer category; also a pillar for every persona) | 5 (no BHPC Track mentions the body) | 5 (logging cadence, rate ceiling, movement floor, lapse handling) | 4 (safe when kept behavioural, with a pace cap and referral; the risk is managed by rules) | **19** | **Recommend** |
| Home Front | 4 (Parent+ is an advertised persona, and it is emotionally sticky ad copy) | 5 (every BHPC Track optimises the work game) | 5 (protected blocks, conflict Radar, after-hours guard; the `family_obligation` kind already exists) | 5 | **19** | **Recommend** |
| Wealth Foundation | 5 (a broad audience; the Billionaire framing alienates most of it) | 4 (overlaps Billionaire High Performance Coach on compounding, but **inverts** its risk posture for this persona) | 4 (automation set, debt-order step, buffer gate, leak review; amounts are user-entered) | 4 (behaviour only; no securities, tax or product advice) | **17** | **Recommend** |
| Career Capital | 3 (the operator persona) | 4 | 4 (weekly visible win, sponsor touch, stakeholder cadence) | 5 | 16 | Runner-up |
| Investor + AI Leverage (ChatGPT) | 2 | 1 (capital allocation and leverage *are* Billionaire High Performance Coach; "AI" is a tool, not a lens) | 2 | 2 (the "investor" framing invites financial advice) | 7 | **Drop** |
| Manifestation Mastery (ChatGPT) | 3 (it draws ad clicks) | 2 (its useful part, identity, is the Part IX epigraph and Body Foundation's mechanism) | 1 (expectancy and alignment are a tone, not a rule) | 1 (evidence links the belief to bankruptcy and speculative risk) | 7 | **Drop** |

## 7. Recommended Tracks in BHPC format

---

### APP TRACK A — BODY FOUNDATION TRACK

**Purpose**
- Build the identity of a person who takes care of their body.
- Get there through small, tracked, repeatable behaviours at a safe pace.
- Outcomes (weight, measurements) are lagging data. The behaviours are the scoreboard.

**When to Activate**
- A weight-loss, fitness or health-rebuilding goal is a pillar or the Foreground.
- History of crash diets, programme-hopping, or "starting Monday" cycles.
- History of one slip turning into an abandoned week.
- Health has eroded under work or parenting pressure.

**Rules**
- **Identity before outcome.** Each day logs at least one behaviour that "a person who takes care of their body" would do.
- **Track the behaviour, glance at the number.** Behaviour logs (movement, meals planned, sleep window) are daily. A weigh-in is optional, and the user sets its cadence.
- **Safe pace is the ceiling, not the floor.** The default target rate is ≤1% of body weight per week, capped at 2 lb (0.9 kg) per week. Faster targets are refused unless the user confirms a clinician is supervising.
- **One slip is a data point.** The next planned meal or session is the recovery. There is no compensation (no skipping meals, no punishment workouts).
- **Movement floor every day.** The floor is the user's MVD (for example, a 10-minute walk), never zero.
- **The app does not prescribe.** No diet plans, calorie numbers, supplements, medication or GLP-1 guidance. Those belong to the user's clinician.

**Coaching Tone**
- Calm, factual and identity-reinforcing. Name the behaviour ("You've moved 5 of 7 days"), not the body.
- After a slip, apply self-compassion plus a next action ("Slip logged. Next planned meal is lunch. That's the recovery.").
- Never comment on appearance. Never use shame, "earn your food", or before/after language.

**Enforcement**
When active, this Track must challenge:
- Targets faster than the safe-pace ceiling.
- Compensatory behaviour after a slip (skipped meals, "double session tomorrow").
- Days planned with no body behaviour at all.
- Restarting or programme-hopping before the Strategic Patience gate.

Whenever the user reports a red-flag symptom, this Track must **refer to a doctor and stop coaching on body goals**. Red flags are chest pain, fainting, disordered-eating signals (purging, fasting more than 24 h, or eating under 1,200 kcal by the user's own statement), pregnancy, or a diagnosed condition.

**Filters**
- *Identity:* Would the person I am becoming do this today?
- *Sustainability:* Could I still do this in 12 months?
- *Pace:* Is this within the safe-pace ceiling?
- *Recovery:* After a slip, what is the very next planned action?

**Deterministic enforcement in app**
1. **Rate ceiling at goal set.** If `(start − target) / weeks > min(1% bodyweight, 0.9 kg)` per week, reject the plan. Offer the safe-pace date instead, or require a "clinician-supervised" acknowledgement. Reason code `body.rate_ceiling`.
2. **Daily body-behaviour presence.** A Today agenda with zero items tagged `pillar=body` fails validation. Insert the user's movement MVD automatically. Reason code `body.floor_missing`.
3. **Slip-recovery Radar.** If a logged slip is followed by a planned skip or compensation item within 24 h, replace it with the next normal planned item. Surface "Next planned meal is the recovery". Reason code `body.compensation_blocked`.
4. **Red-flag keyword or answer stop.** Certain intake answers or check-in entries suppress body coaching and show a referral card. These are: pregnancy, eating-disorder history, a diagnosed condition, or the symptom list. The suppression lasts until the user confirms clinician clearance. Reason code `body.referral`.

**Personas served:** weight loss (primary). Also any founder, operator or parent who lists Body as a pillar. This fills the Health/rebuilding row in APP-INTENT-MAPPING.

---

### APP TRACK B — WEALTH FOUNDATION TRACK

**Purpose**
- Build personal wealth through behaviour rather than bets.
- The method: save by default, close debts one at a time, secure the downside first, and let compounding work.
- This is the base that Billionaire High Performance Coach assumes already exists.

**When to Activate**
- A goal to save, invest, get out of debt, or reach a net-worth or emergency-fund number.
- High-interest debt or no cash buffer.
- A pull toward "get rich quick", speculation or lifestyle creep.
- Money stress is a known failure pattern.

**Rules**
- **Pay yourself first.** Saving is automated, and it happens before spending, not from what is left over.
- **Raise with raises.** Any income increase gets a pre-committed share routed to savings or debt (the Save More Tomorrow pattern).
- **One debt at a time.** The user picks an order, and the app keeps that order. Closing an account is a win and is logged.
- **Buffer before bets.** Speculative or high-volatility moves are flagged until the user's own buffer target is met and high-interest debt is cleared.
- **Leaks get reviewed.** Recurring charges are reviewed on a schedule, not when they happen to be remembered.
- **The app does not advise on products.** No securities, crypto, tax, insurance or specific-allocation advice. Those belong to a licensed professional.

**Coaching Tone**
- Steady, unglamorous and pro-compounding. Celebrate boring consistency ("Third automatic transfer this quarter").
- Name speculation as speculation, without judging it.
- No shame about debt, because debt is data.

**Enforcement**
When active, this Track must challenge:
- Speculative or high-risk moves while the buffer is unmet or high-interest debt remains.
- Pausing or cancelling automated savings without an explicit declaration (ties to Operator Discipline).
- Switching debt-payoff order mid-plan (ties to Strategic Patience).
- New recurring commitments added without a review.

When the Billionaire High Performance Coach Track is also active, Wealth Foundation's buffer gate takes precedence for personal money. Billionaire High Performance Coach still governs venture and business decisions.

**Filters**
- *Downside first:* If this goes to zero, is my buffer intact?
- *Automatic:* Will this happen without my willpower?
- *Order:* Is this the next debt on my list?
- *Leak:* Is this recurring cost still earning its place?

**Deterministic enforcement in app**
1. **Automation presence check.** If `pillar=money` exists but no recurring `savings_transfer` or `debt_payment` item exists, the weekly review shows a single setup action ("Set the automatic transfer: amount, account, date"). Reason code `wealth.no_automation`.
2. **Buffer gate.** A goal, task or decision tagged `speculative` when the user-entered `buffer_months < buffer_target` or `high_interest_debt > 0` is flagged before it can be scheduled. The flag requires an explicit "declared exception". Reason code `wealth.buffer_gate`.
3. **Debt-order lock.** A debt payment scheduled against any account other than the current #1 is flagged. Closing #1 generates a win entry and advances the order. Reason code `wealth.debt_order`.
4. **Leak review cadence.** This uses the existing Radar `subscription` and `bill` kinds: a monthly "review recurring charges" item, with lead days as in `lifeAdminLeadDays`. A new `subscription` item triggers a 7-day review prompt. Reason code `wealth.leak_review`.

**Personas served:** wealth building (primary). Also operators and parents, who make up most salaried users. It is also a safety counterweight to Billionaire High Performance Coach for users with no buffer.

---

### APP TRACK C — HOME FRONT TRACK

**Purpose**
- Protect presence and family time for people playing a second game (a company, a promotion, a venture).
- Family commitments are scheduled, defended and attended like the most important meeting of the week.

**When to Activate**
- The user is a parent or caregiver with a founder, entrepreneur or operator game alongside.
- History of "just one more email" evenings, missed school events, or phones at the dinner table.
- A partner or child has named absence as a problem.
- A high-pressure work period is coming (launch, fundraise, review cycle).

**Rules**
- **Family blocks are fixed commitments.** Once scheduled they are not renegotiated quietly. The same rule as Operator Discipline applies, pointed at home.
- **Presence means the phone is away.** During a protected block, work items do not surface.
- **Conflicts are decided ahead of time.** Every work and family clash is resolved before the day it happens, never in the moment.
- **A hard stop exists.** Each workday has a declared end time. Work after it is declared, not drifted into.
- **The minimum floor at home is non-zero.** Even on the heaviest day there is one protected touchpoint: bedtime, a meal or a school run.

**Coaching Tone**
- Warm but firm. Treat family time with the same seriousness as a board meeting.
- Ask "Who is this time for?" before accepting any intrusion into a protected block.
- No guilt about work. The aim is presence, not perfection.

**Enforcement**
When active, this Track must challenge:
- Work scheduled over a protected family block.
- Unresolved work and family conflicts within the lead window.
- Work items planned after the declared hard stop.
- Days with no family touchpoint.

**Filters**
- *Presence:* Will I be fully there, or physically there and mentally at work?
- *Ten years:* Which will matter more in ten years, this hour of work or this hour at home?
- *Decided early:* Has this conflict been resolved before the day it happens?
- *Floor:* What is today's one protected touchpoint?

**Deterministic enforcement in app**
1. **Protected-block collision.** Any work item scheduled overlapping a `family_obligation` or protected block is rejected at agenda build. The user must move it or file an explicit declared exception. Reason code `home.block_collision`.
2. **Conflict-ahead Radar.** This extends the existing pattern ("Tomorrow's appointment conflicts with pickup; choose the handoff now"). Any work/family overlap within 48 h surfaces with "choose now". Reason code `home.conflict_ahead`.
3. **Hard-stop guard.** Work-tagged items whose start is after the user's `hard_stop` are flagged. The weekly review reports the count of after-hours items. Reason code `home.after_hours`.
4. **Daily touchpoint floor.** A Today agenda with zero `family` items fails validation for a Parent+ user, and the user's default touchpoint is inserted. During protected blocks, notifications for work items are held. Reason code `home.floor_missing`.

**Personas served:** Parent+ (primary). Also founders and operators with partners or children. It fills the Parent/caregiver row in APP-INTENT-MAPPING.

---

## 8. Verdict on the two ChatGPT Tracks

- **Manifestation Mastery: DROP.**
  - Peer-reviewed evidence (Dixon et al. 2023, PSPB) ties manifestation belief to bankruptcy, crypto risk and overconfidence, with no gain in success.
  - It cannot be enforced by rules, because "expectancy and alignment" is a tone.
  - Its one sound idea, identity, is already the Part IX epigraph ("You get who you are") and is the mechanism behind Body Foundation.
- **Investor + AI Leverage: DROP.**
  - It duplicates Billionaire High Performance Coach: capital allocation and leverage are already that Track's "Does this scale without me?".
  - "Investor" invites financial advice.
  - AI is a tool, not a permanent decision lens.
  - Personal-investing behaviour is served safely by Wealth Foundation.
