Segmented control / view switcher.

```jsx
<Tabs value={view} onChange={setView} items={[
  { id: 'video', label: 'Video', icon: <Video size={14}/> },
  { id: 'map', label: 'Map', icon: <Map size={14}/> },
]} />
```

Inset track with a raised active segment. Sizes `sm`/`md`.
