Action button — the primary clickable control; `danger` is reserved strictly for destructive actions (disarm/kill).

```jsx
<Button variant="primary" icon={<Plane size={15} />}>Takeoff</Button>
<Button variant="secondary" size="sm">RTL</Button>
<Button variant="danger">Disarm</Button>
<Button variant="ghost" pending>Sending…</Button>
```

Variants: `primary` (blue, one per region) · `secondary` (charcoal, default) · `ghost` (transparent) · `danger` (solid red) · `danger-soft` (red tint outline). Sizes: `sm` 26px · `md` 32px · `lg` 40px. Props: `icon`/`iconRight`, `block`, `pending` (spinner + locked), `disabled`.
