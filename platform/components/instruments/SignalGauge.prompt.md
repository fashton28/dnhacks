Link-quality signal bars (from RSSI) with latency readout.

```jsx
<SignalGauge rssi={tel.link.rssi} latencyMs={tel.link.latencyMs} />
<SignalGauge lost compact />  /* status bar, link dropped */
```

4 bars fill by RSSI and recolour green→amber→red as it weakens; `lost` empties them and shows LOST. `compact` shows bars only.
