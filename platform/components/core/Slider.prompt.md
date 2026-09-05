Labelled range control with a live mono value — for tuning sliders (standoff distance, max speed).

```jsx
<Slider label="Standoff" value={standoff} min={2} max={15} unit="m"
        ticks={['2', '15']} onChange={setStandoff} />
<Slider label="Max speed" value={spd} min={0.5} max={8} step={0.5} unit="m/s" onChange={setSpd} />
```

Shows the current value top-right in tabular mono. `accent` recolours fill/thumb; `ticks` labels the extents.
