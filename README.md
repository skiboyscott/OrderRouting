# ODM prototype — order routing engine

## Objective

ShipBob is moving from SLA-based commitments to an Estimated Delivery Date (EDD)
model, which means the network — not the merchant — is accountable for hitting
the date shown to the shopper at checkout. That reframes the routing problem:
the job isn't "ship it somehow," it's "protect the promise."

**By default, this engine optimizes for hitting the promised EDD**, with cost
as the second-order decision: among fulfillment center + carrier combinations
that can still hit the date, it picks the cheapest one. That's the "Protect
the promise" mode in the rules engine (see below) — but it isn't hardcoded.
Ops can instead configure the engine to **minimize cost with the date as a
floor**, where the cheapest route within a defined late-tolerance wins, and a
faster route is only chosen when nothing cheaper qualifies.

Either mode holds the same invariant: **cost never silently beats the date.**
In promise-first mode, cost only ever chooses among on-time routes. In
cost-first mode, a late-tolerance window and a cost ceiling bound how far the
engine can drift from the promise — beyond that, it downgrades the order and
says so, rather than quietly shipping late to save money.

I assumed this is a simple, single-parcel order rather than one with
potential split shipments, and that the incoming order data already has
everything needed to act on it (order, SKU, EDD, destination).

## How the engine decides

For each order, the engine evaluates every **fulfillment center + carrier
combination** in the network — not just FCs in isolation — through three
gates, in order, and **every combination's evaluation is shown, not just the
winner's**:

1. **Constraint gate** — blunt on/off rules applied before any scoring:
   is air service allowed, is the facility paused, is this carrier service
   disabled. Anything excluded here never reaches scoring at all.
2. **Stock gate** — does the FC have enough on-hand inventory for the order?
   FCs without stock are eliminated, along with every carrier option that
   would have shipped from them.
3. **Promise gate** — for each FC that passes, every available carrier /
   service level is evaluated for transit time, including a facility-load
   penalty: FCs running above a configurable utilization threshold (default
   60%) get a one-day handling penalty in the transit math, which naturally
   pushes volume toward quieter facilities. Would the order arrive by the
   promised EDD via this specific FC + carrier pairing?
4. **Cost gate** — among combinations that clear the prior gates (per the
   active objective mode and its thresholds), the winner is selected, and
   the runner-up's cost is shown alongside it so the actual dollar tradeoff
   is visible, not implied.

If **no** combination can hit the promise within the configured tolerance,
the engine doesn't wait on a person to decide — it selects the
earliest-arriving option that has stock, revises the promise, states
explicitly that it will miss and by how many days, and flags it for review
rather than shipping quietly.

### Self-service rules engine

Routing priorities shouldn't require an engineering change every time the
business wants to shift strategy, so the objective and its thresholds are
exposed as a configuration surface an ops user can adjust directly:

- **Primary objective** — toggle between "Protect the promise" and
  "Minimize cost, date as floor," as described above.
- **Late tolerance** — how many days past the promised date the engine may
  accept as-is before it's forced to spend up to the premium cap (see
  below) to buy the date back.
- **Max premium to protect the date** — the extra spend per parcel the
  engine may accept over the cheapest available route in order to hit the
  promise. Above this, it falls back within the late-tolerance window
  instead, and says so on the order.
- **Cost ceiling per parcel** — a hard cap. A selected route above this
  ceiling still ships — the date is never broken to save money — but the
  overage is reported on the order so it's visible, not absorbed silently.
- **Facility load penalty threshold** — the utilization percentage above
  which a facility takes the one-day handling penalty described in the
  promise gate above.
- **Constraints** — allow/disallow air service network-wide; excluded
  paused facilities and disabled carrier services are pulled directly from
  the Facilities and Carriers pages and removed from every route table
  before scoring runs.

Rule changes can be evaluated in **shadow mode** before going live: an
"impact on this batch" comparison shows current rules vs. defaults across
on-promise rate, orders flagged for review, average cost per parcel, and
total batch shipping spend, so an ops user can see the real effect of a
change and re-run it against live orders before committing.

### Hard cases

- **Competing orders**: when multiple orders arrive in the same batch, they
  are processed in order of promise urgency (tightest EDD first), and
  inventory reservations carry across the batch so later orders see
  accurate stock.
- **Out-of-stock cascade**: order `O-1002` — the closest FC (Chicago) is the
  obvious pick by distance, but it has zero stock of the SKU. The engine
  eliminates it at the stock gate and lands on New Jersey, the cheapest
  FC + carrier combination that still hits the date.
- **Last-unit contention**: orders `O-1003` and `O-1004` both need a SKU
  where only one unit exists at each of two FCs. `O-1003` has the tighter
  deadline, claims the unit at LAX, and `O-1004` — which loses that unit —
  cleanly reroutes to the remaining unit at Chicago rather than failing.

## Assumptions and shortcuts

This is a prototype, so I deliberately simplified several things that a real
system would need to get right:

- **Distance-based transit and cost models.** Transit time is a coarse
  `miles / 500` heuristic with a capacity penalty; cost is a flat per-mile
  rate plus a base fee, applied per carrier tier. A real version would use
  actual carrier rate cards and zone-based transit tables, which vary by
  carrier, service level, and time of year.
- **Simplified carrier set.** Each FC is assumed to have access to a small,
  fixed set of generic carrier tiers rather than real carrier-specific
  service levels, contracts, and cutoff times.
- **Single ship date.** Every order is assumed to start processing "today."
  A real engine would need to account for FC-specific cutoff times and
  current queue depth.
- **Static, fabricated inventory and FC data.** Five FCs, three SKUs, a
  five-order batch.
- **Split shipments, hard facility capacity caps, and historical carrier
  performance are out of scope.** All three would meaningfully change the
  numbers shown in the impact panel and are called out there directly
  rather than silently assumed away.

## What I'd build next before this went near a real merchant

1. **Replace the distance heuristic and generic carrier tiers with real
   carrier rate cards, contracted service levels, and historical
   transit-time performance data**, so the cost, EDD-feasibility, and
   carrier-choice numbers are trustworthy rather than illustrative.
2. **Model split shipments explicitly** — right now the engine assumes one
   FC fulfills the whole order; multi-item orders with no single FC in
   stock need a defined split-vs-delay tradeoff, with its own cost/promise
   framing.
3. **Add hard network-level capacity caps**, not just the soft load
   penalty, so the engine doesn't repeatedly funnel volume into one
   facility and create a new bottleneck the penalty alone doesn't prevent.
4. **Move the engine out of shadow mode deliberately, with a kill
   threshold defined up front.** I'd want a live comparison against the
   current routing logic on EDD-hit-rate, with an explicit threshold —
   e.g., if the new engine's EDD-hit-rate underperforms the current
   baseline by more than a few points after a defined test window, it
   doesn't ship further, it gets fixed or rolled back. Cost delta would be
   tracked alongside it, but EDD-hit-rate would be the gating metric,
   consistent with promise-protection being the default objective.
5. **Audit trail on rule changes** — since ops can now change routing
   behavior without an engineering change, I'd want every rule change
   logged with who made it and the before/after impact snapshot, so it's
   reviewable after the fact, not just at the moment of the change.

## Running locally

```
python3 -m http.server 8000
```

Then open `http://localhost:8000/`.
