# OrderRouting
Order Routing Engine Exercise

A merchant-facing console for a rule-driven order routing engine: batch queue,
order-level route evaluation, metrics, inventory, facilities, carriers, and a
self-service routing rules page. Ported from a Claude Design prototype
(`Order Routing Engine.dc.html`).

Plain HTML/CSS/JS, no build step. The engine — haversine distances, a
stock → promise → cost gate pipeline, and tightest-EDD-first batch
processing with reservations carrying across the batch — lives in
`engine.js`; `app.js` derives all view state and renders it.

## Running locally

```
python3 -m http.server 8000
```

Then open `http://localhost:8000/`.
