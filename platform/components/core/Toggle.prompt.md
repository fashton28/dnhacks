On/off switch for boolean settings.

```jsx
<Toggle checked={sitl} onChange={setSitl} label="SITL simulator" />
<Toggle checked={geofence} onChange={setGeofence} size="sm" />
```

Pass `label` for an inline label; omit for a bare switch. Sizes `sm`/`md`.
