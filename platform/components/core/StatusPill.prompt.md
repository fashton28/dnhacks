Glanceable status chip (dot + uppercase label) — the workhorse status indicator across the GCS.

```jsx
<StatusPill status="nominal">Armed</StatusPill>
<StatusPill status="active" pulse>Tracking</StatusPill>
<StatusPill status="critical" solid>Battery 12%</StatusPill>
<StatusPill status="neutral" dot={false}>SITL</StatusPill>
```

Status: `nominal` `caution` `danger` `critical` `info`/`active` `neutral`. `pulse` for live states, `solid` for filled, `dot={false}` to hide the dot, `icon` to swap the dot for an icon.
