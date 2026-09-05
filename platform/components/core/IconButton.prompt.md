Square icon-only control for toolbars, panel headers, and map overlays.

```jsx
<IconButton icon={<Settings size={16} />} title="Settings" />
<IconButton icon={<Layers size={16} />} active title="Layers" />
<IconButton icon={<Plus size={16} />} variant="solid" title="Zoom in" />
```

Sizes `sm`/`md`/`lg`; `variant="solid"` adds a bordered rest surface; `active` shows accent-tinted toggled state. Always pass `title` for the tooltip + a11y label.
