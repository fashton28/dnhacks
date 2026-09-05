Core surface container — an uppercase-label header strip over a content body. Used for every region of the GCS.

```jsx
<Panel title="Telemetry" actions={<IconButton icon={<Maximize2 size={15}/>} title="Pop out" />}>
  …readouts…
</Panel>
<Panel title="Live feed" variant="sunken" pad={false}>…video…</Panel>
```

Variants: `default` `raised` `sunken` (near-black, for video/map) `flush`. Use `pad={false}` for full-bleed media; `scroll` for the log console. Compose `actions`/`status` from IconButton + StatusPill.
