Artificial horizon instrument (SVG) showing roll + pitch attitude.

```jsx
<AttitudeIndicator roll={tel.attitude.roll} pitch={tel.attitude.pitch} size={200} />
```

Sky/ground ball rotates with roll and translates with pitch; fixed amber aircraft glyph, pitch ladder, roll arc + bank pointer on top. `label` toggles the ROLL/PITCH readouts. Feed degrees straight from `telemetry.attitude`.
