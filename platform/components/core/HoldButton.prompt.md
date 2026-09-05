Hold-to-confirm safety control — the user presses and holds; a fill sweeps; `onConfirm` fires only on completion. For deliberate, gated actions.

```jsx
<HoldButton variant="primary" icon={<Crosshair size={17}/>} onConfirm={engage}>
  Engage Tracking
</HoldButton>
<HoldButton variant="danger" holdMs={1400} hint="Hold to take off" onConfirm={takeoff}>
  Takeoff · 4 m
</HoldButton>
```

Variants `primary`/`caution`/`danger`. **Never** use to stop/abort — stopping must be a single instant Button. Pair with a confirm summary (standoff + max speed) per the safety rules.
