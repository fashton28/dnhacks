Labelled numeric telemetry readout with tabular mono figures — the standard way to show any live number.

```jsx
<GaugeReadout label="Rel Alt" value="42.7" unit="m" size="lg" />
<GaugeReadout label="Battery" value="34" unit="%" status="caution" />
<GaugeReadout label="V.Speed" value="-1.2" unit="m/s" trend="down" />
```

Sizes `sm`/`md`/`lg`/`xl` (hero values). `status` colours the value (`nominal`/`caution`/`danger`/`accent`). `trend` adds a caret; `align="right"` for right-aligned columns. Always mono + tabular so values don't shift width.
