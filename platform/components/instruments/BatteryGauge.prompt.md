Battery gauge with colour-coded remaining % + voltage/current.

```jsx
<BatteryGauge remaining={b.remaining} voltage={b.voltage} current={b.current} cells={4} />
<BatteryGauge remaining={b.remaining} compact />  /* status bar */
```

Thresholds baked in: green >30%, amber ≤30%, red ≤15% (the fill pulses when critical). `compact` drops the V/A line for the top bar.
