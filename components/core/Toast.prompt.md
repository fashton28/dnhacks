Transient notification — maps to `CommandAck` results and critical `statusText`.

```jsx
<Toast severity="success" icon={<Check size={14}/>} title="Takeoff acknowledged" message="Climbing to 4 m" onDismiss={…} />
<Toast severity="critical" icon={<AlertTriangle size={14}/>} title="Link lost" message="No telemetry for 3 s" />
```

Severity `info`/`success`/`warning`/`error`/`critical` sets the left bar + icon tint. Stack several top-right.
