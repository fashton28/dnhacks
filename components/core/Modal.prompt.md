Centred dialog over a scrim — for config (Settings, Failsafe, PID), confirmations, and the pre-flight checklist.

```jsx
<Modal open={open} title="Settings" subtitle="Connection & display" icon={<Settings size={16}/>}
       onClose={close} footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button variant="primary">Save</Button></>}>
  …form…
</Modal>
```

`tone` (`danger`/`caution`/`accent`) adds a top accent bar + tinted icon. Esc and backdrop close (disable via `closeOnBackdrop={false}`).
