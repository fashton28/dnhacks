/* @ds-bundle: {"format":3,"namespace":"EyeInTheSkyDesignSystem_c7577a","components":[{"name":"Badge","sourcePath":"components/core/Badge.jsx"},{"name":"Button","sourcePath":"components/core/Button.jsx"},{"name":"GaugeReadout","sourcePath":"components/core/GaugeReadout.jsx"},{"name":"HoldButton","sourcePath":"components/core/HoldButton.jsx"},{"name":"IconButton","sourcePath":"components/core/IconButton.jsx"},{"name":"Modal","sourcePath":"components/core/Modal.jsx"},{"name":"Panel","sourcePath":"components/core/Panel.jsx"},{"name":"Slider","sourcePath":"components/core/Slider.jsx"},{"name":"StatusPill","sourcePath":"components/core/StatusPill.jsx"},{"name":"Tabs","sourcePath":"components/core/Tabs.jsx"},{"name":"Toast","sourcePath":"components/core/Toast.jsx"},{"name":"Toggle","sourcePath":"components/core/Toggle.jsx"},{"name":"AttitudeIndicator","sourcePath":"components/instruments/AttitudeIndicator.jsx"},{"name":"BatteryGauge","sourcePath":"components/instruments/BatteryGauge.jsx"},{"name":"Compass","sourcePath":"components/instruments/Compass.jsx"},{"name":"SignalGauge","sourcePath":"components/instruments/SignalGauge.jsx"}],"sourceHashes":{"components/core/Badge.jsx":"122ebdf9b8b4","components/core/Button.jsx":"217dddb79748","components/core/GaugeReadout.jsx":"b64c2e3780f7","components/core/HoldButton.jsx":"c9701bbe95b6","components/core/IconButton.jsx":"4b4bf95e4eca","components/core/Modal.jsx":"79d33c3c12fd","components/core/Panel.jsx":"2859172affec","components/core/Slider.jsx":"34300750207c","components/core/StatusPill.jsx":"7d93fed6e4a4","components/core/Tabs.jsx":"c9e4ab6bbab9","components/core/Toast.jsx":"e0a6003e8522","components/core/Toggle.jsx":"def069ef86aa","components/instruments/AttitudeIndicator.jsx":"232c2daefaee","components/instruments/BatteryGauge.jsx":"c26503987713","components/instruments/Compass.jsx":"60fa56467482","components/instruments/SignalGauge.jsx":"ac8515ea6bb6","ui_kits/ground-control/ControlsPanel.jsx":"8db4d3f6a1d7","ui_kits/ground-control/GroundControl.jsx":"efa9e988666d","ui_kits/ground-control/LogConsole.jsx":"f5acb31c050d","ui_kits/ground-control/ManualControl.jsx":"f67d3c9b8297","ui_kits/ground-control/MapPanel.jsx":"5c12b1d95c7e","ui_kits/ground-control/Modals.jsx":"9dc0d11afc9a","ui_kits/ground-control/StatusBar.jsx":"7cf219d5d67d","ui_kits/ground-control/TelemetryPanel.jsx":"e8ddb5e7a523","ui_kits/ground-control/VideoPanel.jsx":"4ecf84a656c4","ui_kits/ground-control/mock.js":"530752a8a3f2"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.EyeInTheSkyDesignSystem_c7577a = window.EyeInTheSkyDesignSystem_c7577a || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/core/Badge.jsx
try { (() => {
/** Badge — compact count / tag label. Lighter than StatusPill, no dot. */
function Badge({
  children,
  tone = 'neutral',
  mono = false,
  style = {}
}) {
  const tones = {
    neutral: {
      bg: 'rgba(255,255,255,0.06)',
      fg: 'var(--text-secondary)',
      bd: 'var(--border-default)'
    },
    accent: {
      bg: 'var(--accent-subtle)',
      fg: 'var(--accent-text)',
      bd: 'var(--accent-border)'
    },
    nominal: {
      bg: 'var(--nominal-bg)',
      fg: 'var(--nominal-fg)',
      bd: 'var(--green-line)'
    },
    caution: {
      bg: 'var(--caution-bg)',
      fg: 'var(--caution-fg)',
      bd: 'var(--amber-line)'
    },
    danger: {
      bg: 'var(--danger-bg)',
      fg: 'var(--danger-fg)',
      bd: 'var(--red-line)'
    },
    outline: {
      bg: 'transparent',
      fg: 'var(--text-tertiary)',
      bd: 'var(--border-strong)'
    }
  };
  const t = tones[tone] || tones.neutral;
  return /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      height: 18,
      padding: '0 6px',
      borderRadius: 'var(--radius-xs)',
      background: t.bg,
      border: `1px solid ${t.bd}`,
      color: t.fg,
      fontFamily: mono ? 'var(--font-mono)' : 'var(--font-sans)',
      fontSize: 'var(--text-2xs)',
      fontWeight: 'var(--weight-semibold)',
      letterSpacing: mono ? 0 : '0.04em',
      textTransform: mono ? 'none' : 'uppercase',
      lineHeight: 1,
      fontVariantNumeric: 'tabular-nums',
      ...style
    }
  }, children);
}
Object.assign(__ds_scope, { Badge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Badge.jsx", error: String((e && e.message) || e) }); }

// components/core/Button.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Button — primary action control for the Eye in the Sky GCS.
 * Variants map to intent; `danger` is reserved for genuinely destructive actions.
 */
function Button({
  children,
  variant = 'secondary',
  size = 'md',
  icon = null,
  iconRight = null,
  block = false,
  pending = false,
  disabled = false,
  onClick,
  type = 'button',
  title,
  style = {},
  ...rest
}) {
  const [hover, setHover] = React.useState(false);
  const [active, setActive] = React.useState(false);
  const isDisabled = disabled || pending;
  const heights = {
    sm: 'var(--control-h-sm)',
    md: 'var(--control-h)',
    lg: 'var(--control-h-lg)'
  };
  const fontSizes = {
    sm: 'var(--text-xs)',
    md: 'var(--text-base)',
    lg: 'var(--text-md)'
  };
  const pads = {
    sm: '0 10px',
    md: '0 14px',
    lg: '0 18px'
  };
  const palettes = {
    primary: {
      bg: 'var(--accent)',
      bgHover: 'var(--accent-hover)',
      bgActive: 'var(--accent-active)',
      fg: 'var(--text-on-accent)',
      border: 'transparent'
    },
    secondary: {
      bg: 'var(--surface-input)',
      bgHover: 'var(--surface-hover)',
      bgActive: 'var(--surface-raised)',
      fg: 'var(--text-primary)',
      border: 'var(--border-input)'
    },
    ghost: {
      bg: 'transparent',
      bgHover: 'var(--surface-hover)',
      bgActive: 'var(--surface-input)',
      fg: 'var(--text-secondary)',
      border: 'transparent'
    },
    danger: {
      bg: 'var(--red-deep)',
      bgHover: 'var(--red)',
      bgActive: '#b42318',
      fg: '#fff',
      border: 'transparent'
    },
    'danger-soft': {
      bg: 'var(--red-tint)',
      bgHover: 'var(--red-tint-2)',
      bgActive: 'var(--red-tint-2)',
      fg: 'var(--red-bright)',
      border: 'var(--red-line)'
    }
  };
  const p = palettes[variant] || palettes.secondary;
  const bg = isDisabled ? 'var(--surface-input)' : active ? p.bgActive : hover ? p.bgHover : p.bg;
  return /*#__PURE__*/React.createElement("button", _extends({
    type: type,
    title: title,
    disabled: isDisabled,
    onClick: onClick,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => {
      setHover(false);
      setActive(false);
    },
    onMouseDown: () => setActive(true),
    onMouseUp: () => setActive(false),
    style: {
      display: block ? 'flex' : 'inline-flex',
      width: block ? '100%' : 'auto',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '7px',
      height: heights[size],
      padding: pads[size],
      fontFamily: 'var(--font-sans)',
      fontSize: fontSizes[size],
      fontWeight: 'var(--weight-semibold)',
      letterSpacing: '0.01em',
      lineHeight: 1,
      color: isDisabled ? 'var(--text-disabled)' : p.fg,
      background: bg,
      border: `1px solid ${p.border === 'transparent' ? 'transparent' : p.border}`,
      borderRadius: 'var(--radius-md)',
      cursor: isDisabled ? 'not-allowed' : 'pointer',
      opacity: isDisabled ? 0.6 : 1,
      transition: 'background var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out)',
      transform: active && !isDisabled ? 'translateY(0.5px)' : 'none',
      whiteSpace: 'nowrap',
      userSelect: 'none',
      ...style
    }
  }, rest), pending ? /*#__PURE__*/React.createElement(Spinner, null) : icon, children != null && /*#__PURE__*/React.createElement("span", null, children), !pending && iconRight);
}
function Spinner() {
  return /*#__PURE__*/React.createElement("span", {
    style: {
      width: 13,
      height: 13,
      borderRadius: '50%',
      border: '2px solid rgba(255,255,255,0.35)',
      borderTopColor: '#fff',
      display: 'inline-block',
      animation: 'eis-spin 0.7s linear infinite'
    }
  }, /*#__PURE__*/React.createElement("style", null, `@keyframes eis-spin{to{transform:rotate(360deg)}}`));
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Button.jsx", error: String((e && e.message) || e) }); }

// components/core/GaugeReadout.jsx
try { (() => {
/**
 * GaugeReadout — a labelled numeric telemetry value with tabular mono figures
 * so digits don't jitter. Optional unit, status colour, and trend caret.
 */
function GaugeReadout({
  label,
  value,
  unit = '',
  status = 'default',
  size = 'md',
  trend = null,
  // 'up' | 'down' | null
  align = 'left',
  style = {}
}) {
  const colors = {
    default: 'var(--text-primary)',
    nominal: 'var(--nominal-fg)',
    caution: 'var(--caution-fg)',
    danger: 'var(--danger-fg)',
    accent: 'var(--accent-text)',
    muted: 'var(--text-tertiary)'
  };
  const sizes = {
    sm: 'var(--readout-sm)',
    md: 'var(--readout-md)',
    lg: 'var(--readout-lg)',
    xl: 'var(--readout-xl)'
  };
  const valColor = colors[status] || colors.default;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 3,
      alignItems: align === 'right' ? 'flex-end' : 'flex-start',
      ...style
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-sans)',
      fontSize: 'var(--text-2xs)',
      fontWeight: 'var(--weight-semibold)',
      letterSpacing: 'var(--tracking-label)',
      textTransform: 'uppercase',
      color: 'var(--text-tertiary)',
      lineHeight: 1
    }
  }, label), /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'baseline',
      gap: 4,
      lineHeight: 1
    }
  }, trend && /*#__PURE__*/React.createElement("span", {
    style: {
      color: valColor,
      fontSize: '0.7em',
      transform: 'translateY(-1px)'
    }
  }, trend === 'up' ? '▲' : '▼'), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: sizes[size],
      fontWeight: 'var(--weight-medium)',
      fontVariantNumeric: 'tabular-nums',
      fontFeatureSettings: "'tnum' 1, 'zero' 1",
      letterSpacing: 'var(--tracking-mono)',
      color: valColor
    }
  }, value), unit && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: size === 'xl' || size === 'lg' ? 'var(--text-sm)' : 'var(--text-2xs)',
      fontWeight: 'var(--weight-medium)',
      color: 'var(--text-tertiary)'
    }
  }, unit)));
}
Object.assign(__ds_scope, { GaugeReadout });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/GaugeReadout.jsx", error: String((e && e.message) || e) }); }

// components/core/HoldButton.jsx
try { (() => {
/**
 * HoldButton — hold-to-confirm safety control for deliberate, gated actions
 * (Takeoff, Engage Tracking). The user must press and hold for `holdMs` before
 * `onConfirm` fires; releasing early cancels. Never use this to STOP something
 * (stopping must be instant — use a plain Button).
 */
function HoldButton({
  children,
  onConfirm,
  holdMs = 1100,
  variant = 'primary',
  icon = null,
  disabled = false,
  block = true,
  hint = 'Hold to confirm',
  style = {}
}) {
  const [progress, setProgress] = React.useState(0);
  const [holding, setHolding] = React.useState(false);
  const raf = React.useRef(0);
  const start = React.useRef(0);
  const palettes = {
    primary: {
      base: 'var(--accent)',
      fill: 'var(--accent-active)',
      fg: '#fff',
      glow: 'var(--glow-accent)'
    },
    caution: {
      base: 'var(--amber-deep)',
      fill: 'var(--amber)',
      fg: '#1a1205',
      glow: 'var(--glow-caution)'
    },
    danger: {
      base: 'var(--red-deep)',
      fill: 'var(--red)',
      fg: '#fff',
      glow: 'var(--glow-critical)'
    }
  };
  const p = palettes[variant] || palettes.primary;
  const stop = React.useCallback(() => {
    cancelAnimationFrame(raf.current);
    setHolding(false);
    setProgress(0);
  }, []);
  const tick = React.useCallback(() => {
    const elapsed = performance.now() - start.current;
    const pct = Math.min(1, elapsed / holdMs);
    setProgress(pct);
    if (pct >= 1) {
      setHolding(false);
      setProgress(0);
      onConfirm && onConfirm();
    } else {
      raf.current = requestAnimationFrame(tick);
    }
  }, [holdMs, onConfirm]);
  const begin = e => {
    if (disabled) return;
    e.preventDefault();
    setHolding(true);
    start.current = performance.now();
    raf.current = requestAnimationFrame(tick);
  };
  React.useEffect(() => () => cancelAnimationFrame(raf.current), []);
  return /*#__PURE__*/React.createElement("button", {
    type: "button",
    disabled: disabled,
    onMouseDown: begin,
    onMouseUp: stop,
    onMouseLeave: stop,
    onTouchStart: begin,
    onTouchEnd: stop,
    style: {
      position: 'relative',
      display: block ? 'flex' : 'inline-flex',
      width: block ? '100%' : 'auto',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      height: 'var(--control-h-xl)',
      padding: '0 16px',
      background: p.base,
      border: '1px solid rgba(255,255,255,0.12)',
      borderRadius: 'var(--radius-md)',
      color: p.fg,
      fontFamily: 'var(--font-sans)',
      fontSize: 'var(--text-md)',
      fontWeight: 'var(--weight-bold)',
      letterSpacing: '0.02em',
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.5 : 1,
      overflow: 'hidden',
      userSelect: 'none',
      boxShadow: holding ? p.glow : 'none',
      transition: 'box-shadow var(--dur-base) var(--ease-out)',
      ...style
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'absolute',
      left: 0,
      top: 0,
      bottom: 0,
      width: `${progress * 100}%`,
      background: p.fill,
      transition: holding ? 'none' : 'width var(--dur-base) var(--ease-out)',
      pointerEvents: 'none'
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'relative',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
      lineHeight: 1
    }
  }, icon, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-start',
      gap: 2
    }
  }, /*#__PURE__*/React.createElement("span", null, children), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 'var(--text-2xs)',
      fontWeight: 'var(--weight-medium)',
      opacity: 0.8,
      letterSpacing: '0.04em',
      textTransform: 'uppercase'
    }
  }, holding ? `${Math.round(progress * 100)}%` : hint))));
}
Object.assign(__ds_scope, { HoldButton });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/HoldButton.jsx", error: String((e && e.message) || e) }); }

// components/core/IconButton.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** IconButton — square icon-only control for toolbars and panel headers. */
function IconButton({
  icon,
  size = 'md',
  variant = 'ghost',
  active = false,
  disabled = false,
  onClick,
  title,
  style = {},
  ...rest
}) {
  const [hover, setHover] = React.useState(false);
  const dims = {
    sm: 26,
    md: 30,
    lg: 36
  };
  const d = dims[size];
  const rest_bg = variant === 'solid' ? 'var(--surface-input)' : 'transparent';
  const bg = active ? 'var(--accent-subtle)' : hover && !disabled ? 'var(--surface-hover)' : rest_bg;
  const fg = active ? 'var(--accent-text)' : disabled ? 'var(--text-disabled)' : hover ? 'var(--text-primary)' : 'var(--text-secondary)';
  return /*#__PURE__*/React.createElement("button", _extends({
    type: "button",
    title: title,
    "aria-label": title,
    disabled: disabled,
    onClick: onClick,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: d,
      height: d,
      flex: 'none',
      color: fg,
      background: bg,
      border: `1px solid ${active ? 'var(--accent-border)' : variant === 'solid' ? 'var(--border-input)' : 'transparent'}`,
      borderRadius: 'var(--radius-sm)',
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.5 : 1,
      transition: 'background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)',
      ...style
    }
  }, rest), icon);
}
Object.assign(__ds_scope, { IconButton });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/IconButton.jsx", error: String((e && e.message) || e) }); }

// components/core/Modal.jsx
try { (() => {
/**
 * Modal — centred dialog over a scrim, for config (Settings, Failsafe, PID),
 * confirmations, and the pre-flight checklist. Esc / backdrop close.
 */
function Modal({
  open = true,
  title,
  subtitle = null,
  icon = null,
  onClose,
  children,
  footer = null,
  width = 460,
  tone = 'default',
  closeOnBackdrop = true
}) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = e => {
      if (e.key === 'Escape' && onClose) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  const accentBar = {
    default: 'transparent',
    danger: 'var(--red)',
    caution: 'var(--amber)',
    accent: 'var(--accent)'
  }[tone];
  return /*#__PURE__*/React.createElement("div", {
    onMouseDown: e => {
      if (closeOnBackdrop && e.target === e.currentTarget && onClose) onClose();
    },
    style: {
      position: 'fixed',
      inset: 0,
      zIndex: 1000,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
      background: 'var(--scrim)',
      backdropFilter: 'blur(2px)',
      animation: 'eis-fade var(--dur-base) var(--ease-out)'
    }
  }, /*#__PURE__*/React.createElement("style", null, `@keyframes eis-fade{from{opacity:0}to{opacity:1}}@keyframes eis-rise{from{opacity:0;transform:translateY(8px) scale(.99)}to{opacity:1;transform:none}}`), /*#__PURE__*/React.createElement("div", {
    role: "dialog",
    "aria-modal": "true",
    style: {
      position: 'relative',
      width,
      maxWidth: '100%',
      maxHeight: '90vh',
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--surface-overlay)',
      border: '1px solid var(--border-default)',
      borderRadius: 'var(--radius-xl)',
      boxShadow: 'var(--shadow-modal)',
      overflow: 'hidden',
      animation: 'eis-rise var(--dur-slow) var(--ease-out)'
    }
  }, accentBar !== 'transparent' && /*#__PURE__*/React.createElement("div", {
    style: {
      height: 3,
      background: accentBar,
      flex: 'none'
    }
  }), /*#__PURE__*/React.createElement("header", {
    style: {
      display: 'flex',
      alignItems: 'flex-start',
      gap: 11,
      padding: '16px 18px 12px'
    }
  }, icon && /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 30,
      height: 30,
      flex: 'none',
      borderRadius: 'var(--radius-sm)',
      background: tone === 'danger' ? 'var(--red-tint)' : tone === 'caution' ? 'var(--amber-tint)' : 'var(--accent-subtle)',
      color: tone === 'danger' ? 'var(--red-bright)' : tone === 'caution' ? 'var(--amber-bright)' : 'var(--accent-text)'
    }
  }, icon), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("h2", {
    style: {
      margin: 0,
      fontFamily: 'var(--font-sans)',
      fontSize: 'var(--text-lg)',
      fontWeight: 'var(--weight-semibold)',
      color: 'var(--text-primary)',
      letterSpacing: '-0.01em'
    }
  }, title), subtitle && /*#__PURE__*/React.createElement("p", {
    style: {
      margin: '3px 0 0',
      fontSize: 'var(--text-sm)',
      color: 'var(--text-tertiary)',
      lineHeight: 'var(--leading-snug)'
    }
  }, subtitle)), onClose && /*#__PURE__*/React.createElement("button", {
    onClick: onClose,
    "aria-label": "Close",
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 26,
      height: 26,
      flex: 'none',
      marginTop: -2,
      marginRight: -4,
      background: 'transparent',
      border: 'none',
      borderRadius: 'var(--radius-sm)',
      color: 'var(--text-tertiary)',
      cursor: 'pointer',
      fontSize: 18,
      lineHeight: 1
    }
  }, "\xD7")), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '0 18px 4px',
      overflow: 'auto',
      flex: 1
    }
  }, children), footer && /*#__PURE__*/React.createElement("footer", {
    style: {
      display: 'flex',
      justifyContent: 'flex-end',
      gap: 8,
      padding: '14px 18px 16px',
      marginTop: 8,
      borderTop: '1px solid var(--border-subtle)'
    }
  }, footer)));
}
Object.assign(__ds_scope, { Modal });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Modal.jsx", error: String((e && e.message) || e) }); }

// components/core/Panel.jsx
try { (() => {
/**
 * Panel — the core surface container for the GCS. A titled header strip
 * (uppercase micro-label + optional status/actions) over a content body.
 */
function Panel({
  title,
  icon = null,
  actions = null,
  status = null,
  children,
  pad = true,
  scroll = false,
  variant = 'default',
  bodyStyle = {},
  style = {}
}) {
  const variants = {
    default: {
      bg: 'var(--surface-panel)',
      bd: 'var(--border-default)'
    },
    raised: {
      bg: 'var(--surface-raised)',
      bd: 'var(--border-default)'
    },
    sunken: {
      bg: 'var(--bg-sunken)',
      bd: 'var(--border-subtle)'
    },
    flush: {
      bg: 'transparent',
      bd: 'var(--border-subtle)'
    }
  };
  const v = variants[variant] || variants.default;
  return /*#__PURE__*/React.createElement("section", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      minHeight: 0,
      background: v.bg,
      border: `1px solid ${v.bd}`,
      borderRadius: 'var(--radius-lg)',
      overflow: 'hidden',
      ...style
    }
  }, (title || actions || status) && /*#__PURE__*/React.createElement("header", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      height: 34,
      flex: 'none',
      padding: '0 10px 0 12px',
      borderBottom: '1px solid var(--border-subtle)',
      background: 'rgba(255,255,255,0.015)'
    }
  }, icon && /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text-tertiary)',
      display: 'flex'
    }
  }, icon), title && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-sans)',
      fontSize: 'var(--text-2xs)',
      fontWeight: 'var(--weight-semibold)',
      letterSpacing: 'var(--tracking-label)',
      textTransform: 'uppercase',
      color: 'var(--text-secondary)'
    }
  }, title), status && /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 2
    }
  }, status), actions && /*#__PURE__*/React.createElement("div", {
    style: {
      marginLeft: 'auto',
      display: 'flex',
      alignItems: 'center',
      gap: 4
    }
  }, actions)), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minHeight: 0,
      padding: pad ? 'var(--pad-panel-sm)' : 0,
      overflow: scroll ? 'auto' : 'visible',
      ...bodyStyle
    }
  }, children));
}
Object.assign(__ds_scope, { Panel });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Panel.jsx", error: String((e && e.message) || e) }); }

// components/core/Slider.jsx
try { (() => {
/**
 * Slider — labelled range control for tuning values (standoff distance, max
 * speed). Shows the live value in mono; fill + thumb track the position.
 */
function Slider({
  label,
  value,
  min = 0,
  max = 100,
  step = 1,
  unit = '',
  onChange,
  disabled = false,
  accent = 'var(--accent)',
  ticks = null,
  style = {}
}) {
  const pct = (value - min) / (max - min) * 100;
  const id = React.useId();
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 7,
      opacity: disabled ? 0.5 : 1,
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      justifyContent: 'space-between'
    }
  }, /*#__PURE__*/React.createElement("label", {
    htmlFor: id,
    style: {
      fontFamily: 'var(--font-sans)',
      fontSize: 'var(--text-2xs)',
      fontWeight: 'var(--weight-semibold)',
      letterSpacing: 'var(--tracking-label)',
      textTransform: 'uppercase',
      color: 'var(--text-tertiary)'
    }
  }, label), /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'baseline',
      gap: 3
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-md)',
      fontWeight: 'var(--weight-medium)',
      color: 'var(--text-primary)',
      fontVariantNumeric: 'tabular-nums'
    }
  }, value), unit && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-2xs)',
      color: 'var(--text-tertiary)'
    }
  }, unit))), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      height: 20,
      display: 'flex',
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      left: 0,
      right: 0,
      height: 4,
      borderRadius: 999,
      background: 'var(--gray-5)'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      left: 0,
      width: `${pct}%`,
      height: 4,
      borderRadius: 999,
      background: accent
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      left: `calc(${pct}% - 8px)`,
      width: 16,
      height: 16,
      borderRadius: '50%',
      background: '#fff',
      border: `4px solid ${accent}`,
      boxShadow: 'var(--shadow-raised)',
      pointerEvents: 'none'
    }
  }), /*#__PURE__*/React.createElement("input", {
    id: id,
    type: "range",
    min: min,
    max: max,
    step: step,
    value: value,
    disabled: disabled,
    onChange: e => onChange && onChange(Number(e.target.value)),
    style: {
      position: 'absolute',
      left: 0,
      right: 0,
      width: '100%',
      height: 20,
      margin: 0,
      opacity: 0,
      cursor: disabled ? 'not-allowed' : 'pointer'
    }
  })), ticks && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-2xs)',
      color: 'var(--text-disabled)'
    }
  }, ticks.map((t, i) => /*#__PURE__*/React.createElement("span", {
    key: i
  }, t))));
}
Object.assign(__ds_scope, { Slider });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Slider.jsx", error: String((e && e.message) || e) }); }

// components/core/StatusPill.jsx
try { (() => {
/**
 * StatusPill — the core glanceable status chip used everywhere in the GCS.
 * A coloured dot (optionally pulsing) + uppercase micro-label.
 */
function StatusPill({
  status = 'neutral',
  children,
  pulse = false,
  size = 'md',
  solid = false,
  dot = true,
  icon = null,
  style = {}
}) {
  const map = {
    nominal: {
      fg: 'var(--nominal-fg)',
      dot: 'var(--nominal)',
      bg: 'var(--nominal-bg)',
      line: 'var(--green-line)'
    },
    caution: {
      fg: 'var(--caution-fg)',
      dot: 'var(--caution)',
      bg: 'var(--caution-bg)',
      line: 'var(--amber-line)'
    },
    danger: {
      fg: 'var(--danger-fg)',
      dot: 'var(--danger)',
      bg: 'var(--danger-bg)',
      line: 'var(--red-line)'
    },
    critical: {
      fg: '#fff',
      dot: '#fff',
      bg: 'var(--red)',
      line: 'var(--red)'
    },
    info: {
      fg: 'var(--accent-text)',
      dot: 'var(--accent)',
      bg: 'var(--info-bg)',
      line: 'var(--blue-line)'
    },
    active: {
      fg: 'var(--accent-text)',
      dot: 'var(--accent)',
      bg: 'var(--info-bg)',
      line: 'var(--blue-line)'
    },
    neutral: {
      fg: 'var(--text-secondary)',
      dot: 'var(--inactive)',
      bg: 'rgba(255,255,255,0.05)',
      line: 'var(--border-default)'
    }
  };
  const c = map[status] || map.neutral;
  const sized = size === 'sm' ? {
    h: 18,
    fs: 'var(--text-2xs)',
    px: 7,
    gap: 5,
    d: 6
  } : {
    h: 22,
    fs: 'var(--text-xs)',
    px: 9,
    gap: 6,
    d: 7
  };
  return /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: sized.gap,
      height: sized.h,
      padding: `0 ${sized.px}px`,
      borderRadius: 'var(--radius-pill)',
      background: solid ? c.dot : c.bg,
      border: `1px solid ${solid ? 'transparent' : c.line}`,
      color: solid ? status === 'caution' ? '#1a1205' : '#fff' : c.fg,
      fontFamily: 'var(--font-sans)',
      fontSize: sized.fs,
      fontWeight: 'var(--weight-semibold)',
      letterSpacing: 'var(--tracking-label)',
      textTransform: 'uppercase',
      lineHeight: 1,
      whiteSpace: 'nowrap',
      ...style
    }
  }, dot && !icon && /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'relative',
      width: sized.d,
      height: sized.d,
      flex: 'none'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'absolute',
      inset: 0,
      borderRadius: '50%',
      background: solid ? '#fff' : c.dot
    }
  }), pulse && /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'absolute',
      inset: 0,
      borderRadius: '50%',
      background: solid ? '#fff' : c.dot,
      animation: 'eis-ping 1.4s var(--ease-out) infinite'
    }
  }), /*#__PURE__*/React.createElement("style", null, `@keyframes eis-ping{0%{transform:scale(1);opacity:.7}70%,100%{transform:scale(2.6);opacity:0}}`)), icon, children);
}
Object.assign(__ds_scope, { StatusPill });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/StatusPill.jsx", error: String((e && e.message) || e) }); }

// components/core/Tabs.jsx
try { (() => {
/** Tabs — segmented control / view switcher. Items: [{id,label,icon?}]. */
function Tabs({
  items = [],
  value,
  onChange,
  size = 'md',
  style = {}
}) {
  const h = size === 'sm' ? 26 : 30;
  return /*#__PURE__*/React.createElement("div", {
    role: "tablist",
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 2,
      padding: 2,
      height: h + 4,
      background: 'var(--bg-sunken)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius-md)',
      ...style
    }
  }, items.map(it => {
    const on = it.id === value;
    return /*#__PURE__*/React.createElement("button", {
      key: it.id,
      role: "tab",
      "aria-selected": on,
      onClick: () => onChange && onChange(it.id),
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: h,
        padding: '0 12px',
        borderRadius: 'var(--radius-sm)',
        border: 'none',
        background: on ? 'var(--surface-input)' : 'transparent',
        boxShadow: on ? 'var(--shadow-raised)' : 'none',
        color: on ? 'var(--text-primary)' : 'var(--text-tertiary)',
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--text-sm)',
        fontWeight: 'var(--weight-semibold)',
        letterSpacing: '0.01em',
        cursor: 'pointer',
        transition: 'color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out)',
        whiteSpace: 'nowrap'
      }
    }, it.icon, it.label);
  }));
}
Object.assign(__ds_scope, { Tabs });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Tabs.jsx", error: String((e && e.message) || e) }); }

// components/core/Toast.jsx
try { (() => {
/**
 * Toast — transient command-ack / alert notification. Maps to CommandAck and
 * critical statusText. Render a stack of these top-right or bottom-centre.
 */
function Toast({
  severity = 'info',
  title,
  message = null,
  icon = null,
  onDismiss = null,
  style = {}
}) {
  const map = {
    info: {
      line: 'var(--accent)',
      fg: 'var(--accent-text)',
      bg: 'var(--info-bg)'
    },
    success: {
      line: 'var(--green)',
      fg: 'var(--nominal-fg)',
      bg: 'var(--nominal-bg)'
    },
    warning: {
      line: 'var(--amber)',
      fg: 'var(--caution-fg)',
      bg: 'var(--caution-bg)'
    },
    error: {
      line: 'var(--red)',
      fg: 'var(--danger-fg)',
      bg: 'var(--danger-bg)'
    },
    critical: {
      line: 'var(--red-bright)',
      fg: '#fff',
      bg: 'var(--red-tint-2)'
    }
  };
  const c = map[severity] || map.info;
  return /*#__PURE__*/React.createElement("div", {
    role: "status",
    style: {
      display: 'flex',
      alignItems: 'flex-start',
      gap: 10,
      width: 320,
      padding: '11px 12px',
      background: 'var(--surface-overlay)',
      border: '1px solid var(--border-default)',
      borderLeft: `3px solid ${c.line}`,
      borderRadius: 'var(--radius-md)',
      boxShadow: 'var(--shadow-popover)',
      animation: 'eis-toast var(--dur-slow) var(--ease-out)',
      ...style
    }
  }, /*#__PURE__*/React.createElement("style", null, `@keyframes eis-toast{from{opacity:0;transform:translateX(12px)}to{opacity:1;transform:none}}`), icon && /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 22,
      height: 22,
      flex: 'none',
      marginTop: 1,
      borderRadius: 'var(--radius-xs)',
      background: c.bg,
      color: c.fg
    }
  }, icon), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-sans)',
      fontSize: 'var(--text-base)',
      fontWeight: 'var(--weight-semibold)',
      color: 'var(--text-primary)'
    }
  }, title), message && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 2,
      fontSize: 'var(--text-sm)',
      color: 'var(--text-tertiary)',
      lineHeight: 'var(--leading-snug)'
    }
  }, message)), onDismiss && /*#__PURE__*/React.createElement("button", {
    onClick: onDismiss,
    "aria-label": "Dismiss",
    style: {
      width: 18,
      height: 18,
      flex: 'none',
      background: 'transparent',
      border: 'none',
      color: 'var(--text-tertiary)',
      cursor: 'pointer',
      fontSize: 15,
      lineHeight: 1,
      padding: 0
    }
  }, "\xD7"));
}
Object.assign(__ds_scope, { Toast });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Toast.jsx", error: String((e && e.message) || e) }); }

// components/core/Toggle.jsx
try { (() => {
/** Toggle — on/off switch for settings (SITL, geofence enable, map layers). */
function Toggle({
  checked = false,
  onChange,
  disabled = false,
  label = null,
  size = 'md',
  style = {}
}) {
  const dims = size === 'sm' ? {
    w: 30,
    h: 18,
    k: 12
  } : {
    w: 38,
    h: 22,
    k: 16
  };
  const sw = /*#__PURE__*/React.createElement("button", {
    type: "button",
    role: "switch",
    "aria-checked": checked,
    disabled: disabled,
    onClick: () => !disabled && onChange && onChange(!checked),
    style: {
      position: 'relative',
      width: dims.w,
      height: dims.h,
      flex: 'none',
      borderRadius: 999,
      border: '1px solid',
      borderColor: checked ? 'transparent' : 'var(--border-input)',
      background: checked ? 'var(--accent)' : 'var(--surface-input)',
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.5 : 1,
      transition: 'background var(--dur-base) var(--ease-out)',
      padding: 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'absolute',
      top: '50%',
      left: checked ? `calc(100% - ${dims.k}px - 2px)` : 2,
      width: dims.k,
      height: dims.k,
      marginTop: -dims.k / 2,
      borderRadius: '50%',
      background: '#fff',
      boxShadow: 'var(--shadow-raised)',
      transition: 'left var(--dur-base) var(--ease-out)'
    }
  }));
  if (!label) return sw;
  return /*#__PURE__*/React.createElement("label", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 9,
      cursor: disabled ? 'not-allowed' : 'pointer',
      ...style
    }
  }, sw, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-sans)',
      fontSize: 'var(--text-base)',
      color: 'var(--text-secondary)'
    }
  }, label));
}
Object.assign(__ds_scope, { Toggle });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Toggle.jsx", error: String((e && e.message) || e) }); }

// components/instruments/AttitudeIndicator.jsx
try { (() => {
/**
 * AttitudeIndicator — artificial horizon (roll/pitch) drawn in SVG.
 * Sky/ground tilt with roll and translate with pitch; a fixed aircraft glyph,
 * pitch ladder, and roll arc with bank pointer sit on top. Needle motion glides.
 */
function AttitudeIndicator({
  roll = 0,
  pitch = 0,
  size = 200,
  label = true
}) {
  const r = size / 2;
  const pxPerDeg = size / 70; // vertical px per degree of pitch
  const clip = `eis-ai-clip`;

  // pitch ladder marks
  const ladder = [];
  for (let d = -30; d <= 30; d += 10) {
    if (d === 0) continue;
    const w = d % 20 === 0 ? 34 : 20;
    ladder.push({
      d,
      w,
      y: -d * pxPerDeg
    });
  }
  // roll arc ticks
  const rollTicks = [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'inline-flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("svg", {
    width: size,
    height: size,
    viewBox: `${-r} ${-r} ${size} ${size}`,
    style: {
      display: 'block'
    }
  }, /*#__PURE__*/React.createElement("defs", null, /*#__PURE__*/React.createElement("clipPath", {
    id: clip
  }, /*#__PURE__*/React.createElement("circle", {
    cx: 0,
    cy: 0,
    r: r - 3
  })), /*#__PURE__*/React.createElement("linearGradient", {
    id: "eis-sky",
    x1: "0",
    y1: "0",
    x2: "0",
    y2: "1"
  }, /*#__PURE__*/React.createElement("stop", {
    offset: "0",
    stopColor: "#2f6db0"
  }), /*#__PURE__*/React.createElement("stop", {
    offset: "1",
    stopColor: "#4f93cf"
  })), /*#__PURE__*/React.createElement("linearGradient", {
    id: "eis-gnd",
    x1: "0",
    y1: "0",
    x2: "0",
    y2: "1"
  }, /*#__PURE__*/React.createElement("stop", {
    offset: "0",
    stopColor: "#7a5a32"
  }), /*#__PURE__*/React.createElement("stop", {
    offset: "1",
    stopColor: "#5a4124"
  }))), /*#__PURE__*/React.createElement("circle", {
    cx: 0,
    cy: 0,
    r: r - 1,
    fill: "#0b0d11"
  }), /*#__PURE__*/React.createElement("g", {
    clipPath: `url(#${clip})`
  }, /*#__PURE__*/React.createElement("g", {
    style: {
      transition: 'transform var(--needle-ease) 120ms'
    },
    transform: `rotate(${-roll})`
  }, /*#__PURE__*/React.createElement("g", {
    transform: `translate(0 ${pitch * pxPerDeg})`
  }, /*#__PURE__*/React.createElement("rect", {
    x: -r * 2,
    y: -r * 4,
    width: r * 4,
    height: r * 4,
    fill: "url(#eis-sky)"
  }), /*#__PURE__*/React.createElement("rect", {
    x: -r * 2,
    y: 0,
    width: r * 4,
    height: r * 4,
    fill: "url(#eis-gnd)"
  }), /*#__PURE__*/React.createElement("line", {
    x1: -r * 2,
    y1: 0,
    x2: r * 2,
    y2: 0,
    stroke: "#eef3f8",
    strokeWidth: 1.5
  }), ladder.map(m => /*#__PURE__*/React.createElement("g", {
    key: m.d,
    stroke: "rgba(255,255,255,0.85)",
    strokeWidth: 1.2
  }, /*#__PURE__*/React.createElement("line", {
    x1: -m.w / 2,
    y1: m.y,
    x2: m.w / 2,
    y2: m.y
  })))))), /*#__PURE__*/React.createElement("g", {
    transform: `rotate(${-roll})`,
    style: {
      transition: 'transform var(--needle-ease) 120ms'
    }
  }, rollTicks.map(t => {
    const a = (t - 90) * Math.PI / 180;
    const len = t % 30 === 0 ? 9 : 5;
    const r1 = r - 4,
      r2 = r - 4 - len;
    return /*#__PURE__*/React.createElement("line", {
      key: t,
      x1: Math.cos(a) * r1,
      y1: Math.sin(a) * r1,
      x2: Math.cos(a) * r2,
      y2: Math.sin(a) * r2,
      stroke: "rgba(255,255,255,0.7)",
      strokeWidth: t === 0 ? 2 : 1.2
    });
  }), /*#__PURE__*/React.createElement("polygon", {
    points: `0,${-r + 4} -6,${-r + 14} 6,${-r + 14}`,
    fill: "#fff"
  })), /*#__PURE__*/React.createElement("g", {
    stroke: "var(--amber-bright)",
    strokeWidth: 2.5,
    fill: "none",
    strokeLinecap: "round"
  }, /*#__PURE__*/React.createElement("line", {
    x1: -r * 0.42,
    y1: 0,
    x2: -r * 0.16,
    y2: 0
  }), /*#__PURE__*/React.createElement("line", {
    x1: r * 0.16,
    y1: 0,
    x2: r * 0.42,
    y2: 0
  }), /*#__PURE__*/React.createElement("circle", {
    cx: 0,
    cy: 0,
    r: 2.2,
    fill: "var(--amber-bright)",
    stroke: "none"
  })), /*#__PURE__*/React.createElement("polygon", {
    points: "0,-7 -5,2 5,2",
    transform: `translate(0 ${-r + 16})`,
    fill: "var(--amber-bright)"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: 0,
    cy: 0,
    r: r - 1,
    fill: "none",
    stroke: "var(--border-strong)",
    strokeWidth: 1
  })), label && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 16
    }
  }, /*#__PURE__*/React.createElement(Mini, {
    label: "ROLL",
    value: `${roll >= 0 ? '+' : ''}${roll.toFixed(0)}°`
  }), /*#__PURE__*/React.createElement(Mini, {
    label: "PITCH",
    value: `${pitch >= 0 ? '+' : ''}${pitch.toFixed(0)}°`
  })));
}
function Mini({
  label,
  value
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 1
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-sans)',
      fontSize: 'var(--text-2xs)',
      fontWeight: 600,
      letterSpacing: 'var(--tracking-label)',
      color: 'var(--text-tertiary)'
    }
  }, label), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-md)',
      color: 'var(--text-primary)',
      fontVariantNumeric: 'tabular-nums'
    }
  }, value));
}
Object.assign(__ds_scope, { AttitudeIndicator });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/instruments/AttitudeIndicator.jsx", error: String((e && e.message) || e) }); }

// components/instruments/BatteryGauge.jsx
try { (() => {
/**
 * BatteryGauge — horizontal battery bar with colour-coded remaining %, plus
 * voltage/current readouts. Amber <30%, red <15% (critical pulses).
 */
function BatteryGauge({
  remaining = 100,
  voltage = null,
  current = null,
  cells = null,
  compact = false
}) {
  const status = remaining <= 15 ? 'critical' : remaining <= 30 ? 'caution' : 'nominal';
  const col = {
    nominal: 'var(--green)',
    caution: 'var(--amber)',
    critical: 'var(--red)'
  }[status];
  const fg = {
    nominal: 'var(--nominal-fg)',
    caution: 'var(--caution-fg)',
    critical: 'var(--danger-fg)'
  }[status];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      width: '100%'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      justifyContent: 'space-between'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-sans)',
      fontSize: 'var(--text-2xs)',
      fontWeight: 600,
      letterSpacing: 'var(--tracking-label)',
      textTransform: 'uppercase',
      color: 'var(--text-tertiary)'
    }
  }, "Battery"), /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'baseline',
      gap: 2
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: compact ? 'var(--text-md)' : 'var(--readout-md)',
      fontWeight: 500,
      color: fg,
      fontVariantNumeric: 'tabular-nums'
    }
  }, Math.round(remaining)), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-2xs)',
      color: 'var(--text-tertiary)'
    }
  }, "%"))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 3
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      flex: 1,
      height: compact ? 8 : 12,
      background: 'var(--bg-sunken)',
      border: '1px solid var(--border-input)',
      borderRadius: 3,
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      left: 0,
      top: 0,
      bottom: 0,
      width: `${Math.max(2, remaining)}%`,
      background: col,
      transition: 'width var(--dur-slow) var(--ease-out), background var(--dur-base) var(--ease-out)',
      animation: status === 'critical' ? 'eis-batpulse 1s ease-in-out infinite' : 'none'
    }
  }), /*#__PURE__*/React.createElement("style", null, `@keyframes eis-batpulse{0%,100%{opacity:1}50%{opacity:.45}}`)), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 3,
      height: compact ? 4 : 6,
      background: 'var(--border-input)',
      borderRadius: '0 2px 2px 0'
    }
  })), (voltage != null || current != null) && !compact && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 14,
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-2xs)',
      color: 'var(--text-tertiary)',
      fontVariantNumeric: 'tabular-nums'
    }
  }, voltage != null && /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text-secondary)'
    }
  }, voltage.toFixed(1), /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text-disabled)'
    }
  }, " V"), cells ? /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text-disabled)'
    }
  }, " \xB7 ", cells, "S") : null), current != null && /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text-secondary)'
    }
  }, current.toFixed(1), /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text-disabled)'
    }
  }, " A"))));
}
Object.assign(__ds_scope, { BatteryGauge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/instruments/BatteryGauge.jsx", error: String((e && e.message) || e) }); }

// components/instruments/Compass.jsx
try { (() => {
/**
 * Compass — heading rose (SVG). A rotating card with N/E/S/W + tick ring under
 * a fixed lubber line; large mono heading readout in the centre.
 */
function Compass({
  heading = 0,
  size = 200,
  target = null,
  label = true
}) {
  const r = size / 2;
  const ticks = [];
  for (let d = 0; d < 360; d += 5) {
    const major = d % 30 === 0;
    ticks.push({
      d,
      major
    });
  }
  const cardinals = [{
    d: 0,
    t: 'N',
    c: 'var(--red-bright)'
  }, {
    d: 90,
    t: 'E',
    c: 'var(--text-secondary)'
  }, {
    d: 180,
    t: 'S',
    c: 'var(--text-secondary)'
  }, {
    d: 270,
    t: 'W',
    c: 'var(--text-secondary)'
  }];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'inline-flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("svg", {
    width: size,
    height: size,
    viewBox: `${-r} ${-r} ${size} ${size}`
  }, /*#__PURE__*/React.createElement("circle", {
    cx: 0,
    cy: 0,
    r: r - 1,
    fill: "#0b0d11",
    stroke: "var(--border-strong)",
    strokeWidth: 1
  }), /*#__PURE__*/React.createElement("g", {
    transform: `rotate(${-heading})`,
    style: {
      transition: 'transform var(--needle-ease) 120ms'
    }
  }, ticks.map(t => {
    const a = (t.d - 90) * Math.PI / 180;
    const len = t.major ? 10 : 5;
    const r1 = r - 6,
      r2 = r - 6 - len;
    return /*#__PURE__*/React.createElement("line", {
      key: t.d,
      x1: Math.cos(a) * r1,
      y1: Math.sin(a) * r1,
      x2: Math.cos(a) * r2,
      y2: Math.sin(a) * r2,
      stroke: t.major ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.22)',
      strokeWidth: t.major ? 1.4 : 1
    });
  }), cardinals.map(c => {
    const a = (c.d - 90) * Math.PI / 180;
    const rr = r - 30;
    return /*#__PURE__*/React.createElement("text", {
      key: c.t,
      x: Math.cos(a) * rr,
      y: Math.sin(a) * rr,
      fill: c.c,
      fontFamily: "var(--font-sans)",
      fontSize: size * 0.085,
      fontWeight: 700,
      textAnchor: "middle",
      dominantBaseline: "central",
      transform: `rotate(${heading} ${Math.cos(a) * rr} ${Math.sin(a) * rr})`
    }, c.t);
  }), target != null && (() => {
    const a = (target - 90) * Math.PI / 180;
    return /*#__PURE__*/React.createElement("polygon", {
      points: "0,-7 -5,3 5,3",
      fill: "var(--accent)",
      transform: `translate(${Math.cos(a) * (r - 6)} ${Math.sin(a) * (r - 6)}) rotate(${target})`
    });
  })()), /*#__PURE__*/React.createElement("polygon", {
    points: `0,${-r + 4} -5,${-r + 14} 5,${-r + 14}`,
    fill: "var(--amber-bright)"
  }), /*#__PURE__*/React.createElement("text", {
    x: 0,
    y: -2,
    textAnchor: "middle",
    dominantBaseline: "central",
    fill: "var(--text-primary)",
    fontFamily: "var(--font-mono)",
    fontSize: size * 0.22,
    fontWeight: 500,
    style: {
      fontVariantNumeric: 'tabular-nums'
    }
  }, String(Math.round(heading)).padStart(3, '0')), /*#__PURE__*/React.createElement("text", {
    x: 0,
    y: size * 0.16,
    textAnchor: "middle",
    fill: "var(--text-tertiary)",
    fontFamily: "var(--font-sans)",
    fontSize: size * 0.07,
    fontWeight: 600,
    letterSpacing: "0.1em"
  }, "HDG")), label && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-sans)',
      fontSize: 'var(--text-2xs)',
      fontWeight: 600,
      letterSpacing: 'var(--tracking-label)',
      color: 'var(--text-tertiary)'
    }
  }, "HEADING"));
}
Object.assign(__ds_scope, { Compass });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/instruments/Compass.jsx", error: String((e && e.message) || e) }); }

// components/instruments/SignalGauge.jsx
try { (() => {
/**
 * SignalGauge — link-quality bars driven by RSSI, with latency readout.
 * Degrades to caution/danger as signal drops; shows "LINK LOST" when null.
 */
function SignalGauge({
  rssi = -60,
  latencyMs = null,
  lost = false,
  label = 'Link',
  compact = false
}) {
  // map rssi (-100 weak .. -40 strong) → 0..4 bars
  const norm = Math.max(0, Math.min(1, (rssi + 100) / 60));
  const bars = lost ? 0 : Math.max(1, Math.ceil(norm * 4));
  const status = lost ? 'danger' : norm < 0.3 ? 'danger' : norm < 0.55 ? 'caution' : 'nominal';
  const col = {
    nominal: 'var(--green)',
    caution: 'var(--amber)',
    danger: 'var(--red)'
  }[status];
  const heights = [6, 9, 12, 15];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'flex-end',
      gap: 2,
      height: 15
    }
  }, heights.map((h, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      width: 3.5,
      height: h,
      borderRadius: 1,
      background: !lost && i < bars ? col : 'var(--gray-6)',
      opacity: !lost && i < bars ? 1 : 0.5,
      transition: 'background var(--dur-base) var(--ease-out)'
    }
  }))), !compact && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 1
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-sans)',
      fontSize: 'var(--text-2xs)',
      fontWeight: 600,
      letterSpacing: 'var(--tracking-label)',
      textTransform: 'uppercase',
      color: 'var(--text-tertiary)'
    }
  }, label), lost ? /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-sans)',
      fontSize: 'var(--text-xs)',
      fontWeight: 700,
      color: 'var(--danger-fg)',
      letterSpacing: '0.04em'
    }
  }, "LOST") : /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-xs)',
      color: 'var(--text-secondary)',
      fontVariantNumeric: 'tabular-nums'
    }
  }, Math.round(rssi), " dBm", latencyMs != null ? ` · ${latencyMs}ms` : '')));
}
Object.assign(__ds_scope, { SignalGauge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/instruments/SignalGauge.jsx", error: String((e && e.message) || e) }); }

// ui_kits/ground-control/ControlsPanel.jsx
try { (() => {
/* ControlsPanel — left column: flight controls, the prominent Engage Tracking
   safety action, and tuning sliders. */
function ControlsPanel({
  tel,
  tracking,
  connState,
  standoff,
  maxSpeed,
  onCmd,
  onSetStandoff,
  onSetMaxSpeed,
  onArm,
  onTakeoff,
  onEngage,
  checklistDone
}) {
  const DS = window.EyeInTheSkyDesignSystem_c7577a;
  const {
    Panel,
    Button,
    HoldButton,
    StatusPill,
    Slider
  } = DS;
  const Ic = window.EISIcon;
  const armed = tel?.armed;
  const flying = (tel?.position?.relAlt ?? 0) > 0.5;
  const tState = tracking?.state || 'idle';
  const tracking_on = tState !== 'idle';
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      height: '100%',
      minHeight: 0
    }
  }, /*#__PURE__*/React.createElement(Panel, {
    title: "Flight",
    icon: /*#__PURE__*/React.createElement(Ic, {
      d: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
        d: "M12 2l3 7h7l-5.5 4 2 7-6.5-4.5L5.5 27"
      })),
      s: 13
    })
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: 7
    }
  }, !armed ? /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    block: true,
    onClick: onArm,
    icon: /*#__PURE__*/React.createElement(Ic, {
      d: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("rect", {
        x: "5",
        y: "11",
        width: "14",
        height: "10",
        rx: "2"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M8 11V7a4 4 0 0 1 8 0v4"
      })),
      s: 14
    })
  }, "Arm") : /*#__PURE__*/React.createElement(Button, {
    variant: "secondary",
    block: true,
    onClick: () => onCmd('disarm'),
    icon: /*#__PURE__*/React.createElement(Ic, {
      d: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("rect", {
        x: "5",
        y: "11",
        width: "14",
        height: "10",
        rx: "2"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M8 11V8"
      })),
      s: 14
    })
  }, "Disarm"), /*#__PURE__*/React.createElement(Button, {
    variant: "secondary",
    block: true,
    disabled: !armed || flying,
    onClick: onTakeoff,
    icon: /*#__PURE__*/React.createElement(Ic, {
      d: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
        d: "M12 20V8M6 14l6-6 6 6"
      })),
      s: 14
    })
  }, "Takeoff"), /*#__PURE__*/React.createElement(Button, {
    variant: "secondary",
    block: true,
    disabled: !flying,
    onClick: () => onCmd('land'),
    icon: /*#__PURE__*/React.createElement(Ic, {
      d: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
        d: "M12 4v12M6 10l6 6 6-6"
      })),
      s: 14
    })
  }, "Land"), /*#__PURE__*/React.createElement(Button, {
    variant: "secondary",
    block: true,
    disabled: !flying,
    onClick: () => onCmd('rtl'),
    icon: /*#__PURE__*/React.createElement(Ic, {
      d: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
        d: "M9 10l-5 5 5 5"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M4 15h11a5 5 0 0 0 5-5V4"
      })),
      s: 14
    })
  }, "RTL")), !checklistDone && !armed && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 8,
      fontSize: 11,
      color: 'var(--caution-fg)',
      display: 'flex',
      alignItems: 'center',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement(Ic, {
    d: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
      d: "M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
    }), /*#__PURE__*/React.createElement("line", {
      x1: "12",
      y1: "9",
      x2: "12",
      y2: "13"
    }), /*#__PURE__*/React.createElement("line", {
      x1: "12",
      y1: "17",
      x2: "12.01",
      y2: "17"
    })),
    s: 13
  }), " Pre-flight checklist required"), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 9
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 10,
      fontWeight: 600,
      letterSpacing: '0.06em',
      textTransform: 'uppercase',
      color: 'var(--text-tertiary)'
    }
  }, "Mode"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexWrap: 'wrap',
      gap: 5,
      marginTop: 6
    }
  }, ['LOITER', 'GUIDED', 'ALT_HOLD', 'POSHOLD', 'BRAKE'].map(m => /*#__PURE__*/React.createElement("button", {
    key: m,
    onClick: () => onCmd('setMode', {
      mode: m
    }),
    style: {
      padding: '4px 8px',
      fontFamily: 'var(--font-mono)',
      fontSize: 10.5,
      fontWeight: 500,
      background: tel?.mode === m ? 'var(--accent-subtle)' : 'var(--surface-input)',
      border: `1px solid ${tel?.mode === m ? 'var(--accent-border)' : 'var(--border-input)'}`,
      color: tel?.mode === m ? 'var(--accent-text)' : 'var(--text-secondary)',
      borderRadius: 'var(--radius-sm)',
      cursor: 'pointer'
    }
  }, m))))), /*#__PURE__*/React.createElement(Panel, {
    title: "Person tracking",
    icon: /*#__PURE__*/React.createElement(Ic, {
      d: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
        cx: "12",
        cy: "12",
        r: "8"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M12 2v3M12 19v3M2 12h3M19 12h3"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "12",
        cy: "12",
        r: "2.5",
        fill: "currentColor",
        stroke: "none"
      })),
      s: 13
    }),
    status: /*#__PURE__*/React.createElement(StatusPill, {
      size: "sm",
      status: tState === 'locked' ? 'caution' : tState === 'searching' ? 'info' : tState === 'lost' ? 'danger' : 'neutral',
      pulse: tState === 'locked'
    }, tState)
  }, !tracking_on ? /*#__PURE__*/React.createElement(HoldButton, {
    variant: "primary",
    disabled: !flying,
    hint: flying ? 'Hold to engage' : 'Take off first',
    icon: /*#__PURE__*/React.createElement(Ic, {
      d: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
        cx: "12",
        cy: "12",
        r: "7"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M12 2v4M12 18v4M2 12h4M18 12h4"
      })),
      s: 17
    }),
    onConfirm: onEngage
  }, "Engage Tracking") : /*#__PURE__*/React.createElement("button", {
    onClick: () => onCmd('disengageTracking'),
    style: {
      display: 'flex',
      width: '100%',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      height: 'var(--control-h-xl)',
      background: 'var(--red-deep)',
      border: '1px solid var(--red)',
      borderRadius: 'var(--radius-md)',
      color: '#fff',
      fontFamily: 'var(--font-sans)',
      fontSize: 14,
      fontWeight: 700,
      cursor: 'pointer',
      letterSpacing: '0.02em'
    }
  }, /*#__PURE__*/React.createElement(Ic, {
    d: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("rect", {
      x: "6",
      y: "6",
      width: "12",
      height: "12",
      rx: "2",
      fill: "currentColor",
      stroke: "none"
    })),
    s: 15
  }), " Disengage Tracking"), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 12,
      display: 'flex',
      flexDirection: 'column',
      gap: 13
    }
  }, /*#__PURE__*/React.createElement(Slider, {
    label: "Standoff distance",
    value: standoff,
    min: 2,
    max: 15,
    step: 0.5,
    unit: "m",
    ticks: ['2 m', '15 m'],
    onChange: onSetStandoff
  }), /*#__PURE__*/React.createElement(Slider, {
    label: "Max speed",
    value: maxSpeed,
    min: 0.5,
    max: 8,
    step: 0.5,
    unit: "m/s",
    ticks: ['0.5', '8'],
    accent: "var(--green)",
    onChange: onSetMaxSpeed
  }))));
}
Object.assign(window, {
  ControlsPanel
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/ground-control/ControlsPanel.jsx", error: String((e && e.message) || e) }); }

// ui_kits/ground-control/GroundControl.jsx
try { (() => {
/* GroundControl — the app shell. Subscribes to the mock DataSource, holds UI
   state, wires safety flows (checklist → arm, takeoff/engage confirm, instant
   disarm/disengage), keyboard shortcuts, toasts, and composes every panel. */
function GroundControl() {
  const DS = window.EyeInTheSkyDesignSystem_c7577a;
  const {
    Toast
  } = DS;
  const ds = window.EISMock;
  const HOME = {
    lat: 37.7699,
    lon: -122.4666
  };
  const [tel, setTel] = React.useState(null);
  const [tracking, setTracking] = React.useState(null);
  const [connState, setConnState] = React.useState('connected');
  const [logs, setLogs] = React.useState([]);
  const [toasts, setToasts] = React.useState([]);
  const [history, setHistory] = React.useState({
    alt: [],
    bat: []
  });
  const [trail, setTrail] = React.useState([]);
  const [elapsed, setElapsed] = React.useState(0);
  const [recording, setRecording] = React.useState(false);
  const [standoff, setStandoff] = React.useState(4);
  const [maxSpeed, setMaxSpeed] = React.useState(3);
  const [checklistDone, setChecklistDone] = React.useState(false);
  const [modal, setModal] = React.useState(null); // 'checklist'|'takeoff'|'settings'
  const [config, setConfig] = React.useState({
    host: '192.168.1.42',
    controlPort: 8765,
    videoUrl: '',
    sitl: true
  });
  const [manualActive, setManualActive] = React.useState(false);
  const [controllerOn, setControllerOn] = React.useState(false);
  const pushToast = React.useCallback(t => {
    const id = Math.random();
    setToasts(ts => [...ts, {
      ...t,
      id
    }]);
    setTimeout(() => setToasts(ts => ts.filter(x => x.id !== id)), 4200);
  }, []);

  // subscriptions
  React.useEffect(() => {
    ds.start();
    const offT = ds.onTelemetry(t => setTel(t));
    const offK = ds.onTracking(t => setTracking(t));
    const offC = ds.onConnectionChange(s => setConnState(s));
    const offTxt = ds.onStatusText(s => {
      setLogs(l => [...l.slice(-200), s]);
      if (s.severity === 'critical') pushToast({
        severity: 'critical',
        title: s.text
      });
    });
    const offAck = ds.onAck(a => {
      if (!a.success) pushToast({
        severity: 'error',
        title: `${a.command} failed`,
        message: a.message
      });
    });
    return () => {
      offT();
      offK();
      offC();
      offTxt();
      offAck();
    };
  }, [ds, pushToast]);

  // history + trail + flight timer sampling
  React.useEffect(() => {
    const id = setInterval(() => {
      setTel(cur => {
        if (cur) {
          setHistory(h => ({
            alt: [...h.alt.slice(-59), cur.position.relAlt],
            bat: [...h.bat.slice(-59), cur.battery.remaining]
          }));
          if (cur.position.relAlt > 0.4) setTrail(tr => [...tr.slice(-120), {
            lat: cur.position.lat,
            lon: cur.position.lon
          }]);
          if (cur.armed) setElapsed(e => e + 1);
        }
        return cur;
      });
    }, 1000);
    return () => clearInterval(id);
  }, []);
  const cmd = React.useCallback((command, params) => ds.sendCommand({
    type: 'command',
    command,
    params
  }), [ds]);

  // safety flows
  const doArm = () => {
    if (!checklistDone) {
      setModal('checklist');
      return;
    }
    cmd('arm');
    pushToast({
      severity: 'success',
      title: 'Armed'
    });
  };
  const doTakeoff = () => setModal('takeoff');
  const confirmTakeoff = alt => {
    cmd('takeoff', {
      altitude: alt
    });
    setModal(null);
    pushToast({
      severity: 'success',
      title: 'Takeoff acknowledged',
      message: `Climbing to ${alt} m`
    });
  };
  const doEngage = () => {
    setManualActive(false);
    cmd('engageTracking');
    cmd('setStandoff', {
      meters: standoff
    });
    cmd('setMaxSpeed', {
      mps: maxSpeed
    });
    pushToast({
      severity: 'warning',
      title: 'Tracking engaged',
      message: `Standoff ${standoff} m`
    });
  };
  const doDisarm = () => {
    setManualActive(false);
    cmd('emergencyStop');
    pushToast({
      severity: 'error',
      title: 'Disarmed'
    });
  };
  const onStandoff = v => {
    setStandoff(v);
    cmd('setStandoff', {
      meters: v
    });
  };
  const onMaxSpeed = v => {
    setMaxSpeed(v);
    cmd('setMaxSpeed', {
      mps: v
    });
  };

  // manual (game-controller) piloting
  const doManualEngage = () => {
    cmd('engageManual');
    setManualActive(true);
    pushToast({
      severity: 'warning',
      title: 'Manual control engaged',
      message: 'Operator has the sticks'
    });
  };
  const doManualRelease = () => {
    cmd('disengageManual');
    setManualActive(false);
    pushToast({
      severity: 'info',
      title: 'Manual released',
      message: 'Position hold'
    });
  };
  const onStickInput = React.useCallback(v => ds.setManualInput(v), [ds]);

  // keyboard shortcuts
  React.useEffect(() => {
    const onKey = e => {
      if (e.target.tagName === 'INPUT') return;
      if (e.code === 'Space') {
        e.preventDefault();
        doDisarm();
      } else if (e.key === 't' || e.key === 'T') {
        if (tracking?.state === 'idle' && (tel?.position?.relAlt ?? 0) > 0.5) doEngage();
      } else if (e.key === 'd' || e.key === 'D') {
        if (tracking && tracking.state !== 'idle') cmd('disengageTracking');
      } else if (e.key === 'r' || e.key === 'R') {
        if ((tel?.position?.relAlt ?? 0) > 0.5) cmd('rtl');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const trackingActive = tracking && tracking.state !== 'idle';
  const flying = (tel?.position?.relAlt ?? 0) > 0.5;
  const {
    StatusBar,
    VideoPanel,
    ControlsPanel,
    ManualControl,
    TelemetryPanel,
    MapPanel,
    LogConsole,
    ChecklistModal,
    TakeoffModal,
    SettingsModal,
    TrackingBanner,
    ManualBanner
  } = window;
  return /*#__PURE__*/React.createElement("div", {
    className: "eis-root",
    style: {
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      background: 'var(--bg-app)',
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement(StatusBar, {
    tel: tel,
    connState: connState,
    sitl: config.sitl,
    elapsed: elapsed,
    controllerOn: controllerOn,
    manualActive: manualActive,
    onDisarm: doDisarm,
    onOpenSettings: () => setModal('settings')
  }), trackingActive && /*#__PURE__*/React.createElement(TrackingBanner, {
    standoff: standoff,
    maxSpeed: maxSpeed,
    onDisengage: () => cmd('disengageTracking')
  }), manualActive && /*#__PURE__*/React.createElement(ManualBanner, {
    onRelease: doManualRelease
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minHeight: 0,
      display: 'grid',
      gridTemplateColumns: 'var(--leftpanel-w) 1fr var(--rightpanel-w)',
      gap: 10,
      padding: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      minHeight: 0,
      overflow: 'auto',
      paddingRight: 2
    }
  }, /*#__PURE__*/React.createElement(ControlsPanel, {
    tel: tel,
    tracking: tracking,
    connState: connState,
    standoff: standoff,
    maxSpeed: maxSpeed,
    onCmd: cmd,
    onSetStandoff: onStandoff,
    onSetMaxSpeed: onMaxSpeed,
    onArm: doArm,
    onTakeoff: doTakeoff,
    onEngage: doEngage,
    checklistDone: checklistDone
  }), /*#__PURE__*/React.createElement(ManualControl, {
    armed: !!tel?.armed,
    flying: flying,
    manualActive: manualActive,
    onEngage: doManualEngage,
    onRelease: doManualRelease,
    onInput: onStickInput,
    onControllerChange: setControllerOn
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateRows: '1.55fr 1fr',
      gap: 10,
      minHeight: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      borderRadius: 'var(--radius-lg)',
      overflow: 'hidden',
      border: '1px solid var(--border-default)',
      minHeight: 0
    }
  }, /*#__PURE__*/React.createElement(VideoPanel, {
    tracking: tracking,
    connState: connState,
    standoff: standoff,
    onSelectTarget: id => cmd('selectTarget', {
      targetId: id
    })
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1.1fr 1fr',
      gap: 10,
      minHeight: 0
    }
  }, /*#__PURE__*/React.createElement(MapPanel, {
    tel: tel,
    tracking: tracking,
    home: HOME,
    trail: trail
  }), /*#__PURE__*/React.createElement(LogConsole, {
    logs: logs,
    recording: recording,
    onToggleRecord: () => {
      setRecording(r => !r);
    }
  }))), /*#__PURE__*/React.createElement(TelemetryPanel, {
    tel: tel,
    tracking: tracking,
    history: history
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'fixed',
      top: 56,
      right: 14,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      zIndex: 1200
    }
  }, toasts.map(t => /*#__PURE__*/React.createElement(Toast, {
    key: t.id,
    severity: t.severity,
    title: t.title,
    message: t.message,
    onDismiss: () => setToasts(ts => ts.filter(x => x.id !== t.id))
  }))), /*#__PURE__*/React.createElement(ChecklistModal, {
    open: modal === 'checklist',
    onClose: () => setModal(null),
    onComplete: () => {
      setChecklistDone(true);
      setModal(null);
      cmd('arm');
      pushToast({
        severity: 'success',
        title: 'Checklist complete — Armed'
      });
    }
  }), /*#__PURE__*/React.createElement(TakeoffModal, {
    open: modal === 'takeoff',
    onClose: () => setModal(null),
    onConfirm: confirmTakeoff,
    defaultAlt: 4
  }), /*#__PURE__*/React.createElement(SettingsModal, {
    open: modal === 'settings',
    onClose: () => setModal(null),
    config: config,
    onChange: c => setConfig(p => ({
      ...p,
      ...c
    }))
  }));
}
Object.assign(window, {
  GroundControl
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/ground-control/GroundControl.jsx", error: String((e && e.message) || e) }); }

// ui_kits/ground-control/LogConsole.jsx
try { (() => {
/* LogConsole — scrolling statusText stream, colour-coded by severity,
   filterable, with flight-recording controls. */
function LogConsole({
  logs,
  recording,
  onToggleRecord
}) {
  const DS = window.EyeInTheSkyDesignSystem_c7577a;
  const {
    Panel,
    Tabs,
    Badge
  } = DS;
  const Ic = window.EISIcon;
  const [filter, setFilter] = React.useState('all');
  const scrollRef = React.useRef(null);
  const filtered = logs.filter(l => filter === 'all' ? true : filter === 'warn' ? l.severity === 'warning' || l.severity === 'error' || l.severity === 'critical' : l.severity === filter);
  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs.length, filter]);
  const sevColor = {
    info: 'var(--text-tertiary)',
    warning: 'var(--caution-fg)',
    error: 'var(--danger-fg)',
    critical: 'var(--danger-fg)'
  };
  const sevTag = {
    info: 'INFO',
    warning: 'WARN',
    error: 'ERR ',
    critical: 'CRIT'
  };
  return /*#__PURE__*/React.createElement(Panel, {
    title: "Event log",
    pad: false,
    status: /*#__PURE__*/React.createElement(Badge, {
      tone: "neutral",
      mono: true
    }, logs.length),
    actions: /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8
      }
    }, /*#__PURE__*/React.createElement(Tabs, {
      size: "sm",
      value: filter,
      onChange: setFilter,
      items: [{
        id: 'all',
        label: 'All'
      }, {
        id: 'warn',
        label: 'Alerts'
      }, {
        id: 'info',
        label: 'Info'
      }]
    }), /*#__PURE__*/React.createElement("button", {
      onClick: onToggleRecord,
      title: recording ? 'Stop recording' : 'Start recording',
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 26,
        padding: '0 10px',
        background: recording ? 'var(--red-tint)' : 'var(--surface-input)',
        border: `1px solid ${recording ? 'var(--red-line)' : 'var(--border-input)'}`,
        borderRadius: 'var(--radius-sm)',
        color: recording ? 'var(--danger-fg)' : 'var(--text-secondary)',
        fontFamily: 'var(--font-sans)',
        fontSize: 11,
        fontWeight: 600,
        cursor: 'pointer'
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        width: 8,
        height: 8,
        borderRadius: recording ? 2 : '50%',
        background: recording ? 'var(--red)' : 'var(--text-tertiary)'
      }
    }), recording ? 'REC' : 'Record')),
    style: {
      height: '100%'
    }
  }, /*#__PURE__*/React.createElement("div", {
    ref: scrollRef,
    style: {
      height: '100%',
      overflow: 'auto',
      padding: '6px 0',
      fontFamily: 'var(--font-mono)',
      fontSize: 11.5,
      lineHeight: 1.65
    }
  }, filtered.map((l, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: 'flex',
      gap: 10,
      padding: '1px 12px',
      alignItems: 'baseline',
      background: l.severity === 'critical' ? 'var(--red-tint)' : 'transparent'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text-disabled)',
      flex: 'none',
      fontVariantNumeric: 'tabular-nums'
    }
  }, fmtClock(l.ts)), /*#__PURE__*/React.createElement("span", {
    style: {
      color: sevColor[l.severity],
      fontWeight: 600,
      flex: 'none',
      letterSpacing: '0.04em'
    }
  }, sevTag[l.severity]), /*#__PURE__*/React.createElement("span", {
    style: {
      color: l.severity === 'info' ? 'var(--text-secondary)' : sevColor[l.severity]
    }
  }, l.text))), filtered.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '8px 12px',
      color: 'var(--text-disabled)'
    }
  }, "No events.")));
}
function fmtClock(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}
Object.assign(window, {
  LogConsole
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/ground-control/LogConsole.jsx", error: String((e && e.message) || e) }); }

// ui_kits/ground-control/ManualControl.jsx
try { (() => {
/* ManualControl — game-controller / keyboard piloting. Reads the Gamepad API
   (with a WASD + arrow-keys fallback for testing), shows dual stick visualizers
   and channel bars, and routes stick input to the vehicle once manual override
   is engaged. Engage is a deliberate hold-to-confirm; release is instant. */
function ManualControl({
  armed,
  flying,
  manualActive,
  onEngage,
  onRelease,
  onInput,
  onControllerChange
}) {
  const DS = window.EyeInTheSkyDesignSystem_c7577a;
  const {
    Panel,
    HoldButton,
    StatusPill
  } = DS;
  const Ic = window.EISIcon;
  const [axes, setAxes] = React.useState({
    throttle: 0,
    yaw: 0,
    pitch: 0,
    roll: 0
  });
  const [pad, setPad] = React.useState(null); // {name}
  const activeRef = React.useRef(manualActive);
  activeRef.current = manualActive;
  const keysRef = React.useRef({});
  const dz = v => Math.abs(v) < 0.09 ? 0 : v;

  // keyboard fallback (only when manual is active)
  React.useEffect(() => {
    const codes = ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    const down = e => {
      if (activeRef.current && codes.includes(e.code)) {
        keysRef.current[e.code] = true;
        e.preventDefault();
      }
    };
    const up = e => {
      if (codes.includes(e.code)) keysRef.current[e.code] = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // poll loop
  React.useEffect(() => {
    let raf,
      lastPadId = null;
    const onConn = () => {};
    window.addEventListener('gamepadconnected', onConn);
    window.addEventListener('gamepaddisconnected', onConn);
    const tick = () => {
      const gps = navigator.getGamepads ? navigator.getGamepads() : [];
      let gp = null;
      for (const g of gps) {
        if (g && g.connected) {
          gp = g;
          break;
        }
      }
      const id = gp ? gp.id : null;
      if (id !== lastPadId) {
        lastPadId = id;
        setPad(gp ? {
          name: gp.id.replace(/\(.*\)/, '').trim().slice(0, 28) || 'Gamepad'
        } : null);
        onControllerChange && onControllerChange(!!gp);
      }
      let v = {
        throttle: 0,
        yaw: 0,
        pitch: 0,
        roll: 0
      };
      if (gp) {
        const a = gp.axes;
        v = {
          yaw: dz(a[0] || 0),
          throttle: dz(-(a[1] || 0)),
          roll: dz(a[2] || 0),
          pitch: dz(-(a[3] || 0))
        };
        // B / Circle (index 1) releases manual
        if (gp.buttons[1] && gp.buttons[1].pressed && activeRef.current) onRelease();
      } else {
        const k = keysRef.current;
        v = {
          throttle: (k.KeyW ? 1 : 0) - (k.KeyS ? 1 : 0),
          yaw: (k.KeyD ? 1 : 0) - (k.KeyA ? 1 : 0),
          pitch: (k.ArrowUp ? 1 : 0) - (k.ArrowDown ? 1 : 0),
          roll: (k.ArrowRight ? 1 : 0) - (k.ArrowLeft ? 1 : 0)
        };
      }
      setAxes(v);
      if (activeRef.current) onInput(v);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('gamepadconnected', onConn);
      window.removeEventListener('gamepaddisconnected', onConn);
    };
  }, [onInput, onRelease, onControllerChange]);
  const status = manualActive ? 'active' : pad ? 'info' : 'neutral';
  const statusLabel = manualActive ? 'Active' : pad ? 'Ready' : 'No pad';
  return /*#__PURE__*/React.createElement(Panel, {
    title: "Manual control",
    icon: /*#__PURE__*/React.createElement(Ic, {
      d: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
        d: "M6 11h4M8 9v4"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "16",
        cy: "10",
        r: "1.2",
        fill: "currentColor",
        stroke: "none"
      }), /*#__PURE__*/React.createElement("circle", {
        cx: "18",
        cy: "13",
        r: "1.2",
        fill: "currentColor",
        stroke: "none"
      }), /*#__PURE__*/React.createElement("rect", {
        x: "2",
        y: "6",
        width: "20",
        height: "12",
        rx: "6"
      })),
      s: 14
    }),
    status: /*#__PURE__*/React.createElement(StatusPill, {
      size: "sm",
      status: status,
      pulse: manualActive
    }, statusLabel)
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 12,
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement(Stick, {
    label: "Throttle / Yaw",
    x: axes.yaw,
    y: -axes.throttle,
    active: manualActive,
    tl: "\u2191 thr",
    bl: "yaw"
  }), /*#__PURE__*/React.createElement(Stick, {
    label: "Pitch / Roll",
    x: axes.roll,
    y: -axes.pitch,
    active: manualActive,
    tl: "pitch",
    bl: "roll"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: '7px 14px',
      marginTop: 12
    }
  }, /*#__PURE__*/React.createElement(Chan, {
    label: "THR",
    value: axes.throttle,
    active: manualActive
  }), /*#__PURE__*/React.createElement(Chan, {
    label: "YAW",
    value: axes.yaw,
    active: manualActive
  }), /*#__PURE__*/React.createElement(Chan, {
    label: "PITCH",
    value: axes.pitch,
    active: manualActive
  }), /*#__PURE__*/React.createElement(Chan, {
    label: "ROLL",
    value: axes.roll,
    active: manualActive
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 13
    }
  }, !manualActive ? /*#__PURE__*/React.createElement(HoldButton, {
    variant: "primary",
    disabled: !armed || !flying,
    hint: !armed ? 'Arm first' : !flying ? 'Take off first' : 'Hold to take control',
    icon: /*#__PURE__*/React.createElement(Ic, {
      d: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("rect", {
        x: "2",
        y: "6",
        width: "20",
        height: "12",
        rx: "6"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M7 11h3M8.5 9.5v3"
      })),
      s: 16
    }),
    onConfirm: onEngage
  }, "Take manual control") : /*#__PURE__*/React.createElement("button", {
    onClick: onRelease,
    style: {
      display: 'flex',
      width: '100%',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      height: 'var(--control-h-lg)',
      background: 'var(--surface-input)',
      border: '1px solid var(--border-strong)',
      borderRadius: 'var(--radius-md)',
      color: 'var(--text-primary)',
      fontFamily: 'var(--font-sans)',
      fontSize: 13,
      fontWeight: 700,
      cursor: 'pointer'
    }
  }, /*#__PURE__*/React.createElement(Ic, {
    d: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
      d: "M9 10l-5 5 5 5"
    }), /*#__PURE__*/React.createElement("path", {
      d: "M4 15h11a5 5 0 0 0 5-5V4"
    })),
    s: 14
  }), " Release to auto-hold")), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 9,
      display: 'flex',
      alignItems: 'center',
      gap: 7,
      fontSize: 11,
      color: 'var(--text-tertiary)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 7,
      height: 7,
      borderRadius: '50%',
      background: pad ? 'var(--green)' : 'var(--gray-6)',
      flex: 'none'
    }
  }), pad ? /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 10.5,
      color: 'var(--text-secondary)'
    }
  }, pad.name) : /*#__PURE__*/React.createElement("span", null, "No controller \xB7 keyboard ", /*#__PURE__*/React.createElement("b", {
    style: {
      color: 'var(--text-secondary)'
    }
  }, "WASD"), " + ", /*#__PURE__*/React.createElement("b", {
    style: {
      color: 'var(--text-secondary)'
    }
  }, "arrows"))));
}
function Stick({
  label,
  x,
  y,
  active,
  tl,
  bl
}) {
  const size = 96,
    r = size / 2 - 12;
  const dotColor = active ? 'var(--accent)' : 'var(--text-tertiary)';
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      width: size,
      height: size,
      borderRadius: '50%',
      background: 'var(--bg-sunken)',
      border: `1px solid ${active ? 'var(--accent-border)' : 'var(--border-input)'}`,
      boxShadow: active ? 'inset 0 0 12px rgba(47,129,247,0.18)' : 'none'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      left: '50%',
      top: 8,
      bottom: 8,
      width: 1,
      background: 'var(--border-default)',
      transform: 'translateX(-0.5px)'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: '50%',
      left: 8,
      right: 8,
      height: 1,
      background: 'var(--border-default)',
      transform: 'translateY(-0.5px)'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      left: '50%',
      top: '50%',
      width: 16,
      height: 16,
      borderRadius: '50%',
      background: dotColor,
      boxShadow: active ? '0 0 10px rgba(47,129,247,0.5)' : 'none',
      transform: `translate(calc(-50% + ${x * r}px), calc(-50% + ${y * r}px))`,
      transition: 'background var(--dur-base)'
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'absolute',
      top: 4,
      left: 7,
      fontSize: 8,
      color: 'var(--text-disabled)',
      fontFamily: 'var(--font-mono)'
    }
  }, tl), /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'absolute',
      bottom: 4,
      right: 7,
      fontSize: 8,
      color: 'var(--text-disabled)',
      fontFamily: 'var(--font-mono)'
    }
  }, bl)), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 9.5,
      fontWeight: 600,
      letterSpacing: '0.05em',
      textTransform: 'uppercase',
      color: 'var(--text-tertiary)'
    }
  }, label));
}
function Chan({
  label,
  value,
  active
}) {
  const pct = Math.abs(value) * 50;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 7
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 34,
      fontSize: 9,
      fontWeight: 600,
      letterSpacing: '0.05em',
      color: 'var(--text-tertiary)',
      flex: 'none'
    }
  }, label), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      flex: 1,
      height: 5,
      background: 'var(--bg-sunken)',
      borderRadius: 3,
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      left: '50%',
      top: 0,
      bottom: 0,
      width: 1,
      background: 'var(--border-strong)'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      background: active ? 'var(--accent)' : 'var(--gray-6)',
      left: value >= 0 ? '50%' : `${50 - pct}%`,
      width: `${pct}%`,
      transition: 'all 60ms linear'
    }
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      width: 30,
      textAlign: 'right',
      fontFamily: 'var(--font-mono)',
      fontSize: 10,
      color: active ? 'var(--text-secondary)' : 'var(--text-disabled)',
      fontVariantNumeric: 'tabular-nums'
    }
  }, value >= 0 ? '+' : '', value.toFixed(1)));
}
Object.assign(window, {
  ManualControl
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/ground-control/ManualControl.jsx", error: String((e && e.message) || e) }); }

// ui_kits/ground-control/MapPanel.jsx
try { (() => {
/* MapPanel — Google-Earth-style situational map. In the live build this is
   react-leaflet over Google/OSM satellite tiles; here it's a self-contained
   procedural satellite-look canvas with home, drone (heading), target, geofence
   ring and a breadcrumb trail driven by telemetry. */
function MapPanel({
  tel,
  tracking,
  home,
  trail
}) {
  const DS = window.EyeInTheSkyDesignSystem_c7577a;
  const {
    Panel,
    IconButton,
    Badge
  } = DS;
  const Ic = window.EISIcon;
  const cvRef = React.useRef(null);
  const wrapRef = React.useRef(null);
  const stateRef = React.useRef({
    tel,
    tracking,
    trail
  });
  stateRef.current = {
    tel,
    tracking,
    trail
  };
  const [zoom, setZoom] = React.useState(1);
  const zoomRef = React.useRef(zoom);
  zoomRef.current = zoom;
  React.useEffect(() => {
    let raf;
    // deterministic terrain features generated once
    const rnd = mulberry32(42);
    const fields = Array.from({
      length: 16
    }, () => ({
      x: rnd(),
      y: rnd(),
      r: 0.06 + rnd() * 0.12,
      tone: rnd()
    }));
    const draw = () => {
      const cv = cvRef.current,
        wrap = wrapRef.current;
      if (!cv || !wrap) {
        raf = requestAnimationFrame(draw);
        return;
      }
      const r = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const W = r.width,
        H = r.height;
      if (cv.width !== W * dpr || cv.height !== H * dpr) {
        cv.width = W * dpr;
        cv.height = H * dpr;
      }
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      // base satellite ground
      ctx.fillStyle = '#1c2a1e';
      ctx.fillRect(0, 0, W, H);
      // fields / patches
      fields.forEach(f => {
        const tones = ['#243425', '#2c3a26', '#33402a', '#3b3a28', '#2a3530'];
        ctx.fillStyle = tones[Math.floor(f.tone * tones.length)];
        ctx.beginPath();
        ctx.ellipse(f.x * W, f.y * H, f.r * W, f.r * H * 0.8, f.tone * 6, 0, Math.PI * 2);
        ctx.fill();
      });
      // river
      ctx.strokeStyle = '#1c3344';
      ctx.lineWidth = 13;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-10, H * 0.7);
      ctx.bezierCurveTo(W * 0.3, H * 0.5, W * 0.4, H * 0.9, W * 0.7, H * 0.62);
      ctx.bezierCurveTo(W * 0.85, H * 0.5, W * 0.95, H * 0.6, W + 10, H * 0.55);
      ctx.stroke();
      // roads
      ctx.strokeStyle = 'rgba(180,180,170,0.18)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(W * 0.15, -5);
      ctx.lineTo(W * 0.22, H + 5);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-5, H * 0.3);
      ctx.lineTo(W + 5, H * 0.42);
      ctx.stroke();
      // grid
      ctx.strokeStyle = 'rgba(255,255,255,0.04)';
      ctx.lineWidth = 1;
      for (let x = 0; x < W; x += 48) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
        ctx.stroke();
      }
      for (let y = 0; y < H; y += 48) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
      }
      const cx = W / 2,
        cy = H / 2;
      const z = zoomRef.current;
      const mPerPx = 0.55 / z; // scale
      const {
        tel: T,
        tracking: TK,
        trail: TR
      } = stateRef.current;
      const HOME = home;
      const toXY = (lat, lon) => {
        const dN = (lat - HOME.lat) * 111320;
        const dE = (lon - HOME.lon) * 111320 * Math.cos(HOME.lat * Math.PI / 180);
        return [cx + dE / mPerPx, cy - dN / mPerPx];
      };

      // geofence ring (radius 60 m default)
      const fenceR = 60 / mPerPx;
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = 'rgba(47,129,247,0.55)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, fenceR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(47,129,247,0.05)';
      ctx.beginPath();
      ctx.arc(cx, cy, fenceR, 0, Math.PI * 2);
      ctx.fill();

      // breadcrumb trail
      if (TR && TR.length > 1) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(90,160,255,0.7)';
        ctx.beginPath();
        TR.forEach((p, i) => {
          const [x, y] = toXY(p.lat, p.lon);
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        });
        ctx.stroke();
      }

      // home marker
      ctx.fillStyle = '#e6eaf0';
      ctx.beginPath();
      ctx.arc(cx, cy, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // drone marker
      if (T) {
        const [dx, dy] = toXY(T.position.lat, T.position.lon);
        const hd = (T.heading || 0) * Math.PI / 180;
        // heading cone
        const g = ctx.createRadialGradient(dx, dy, 0, dx, dy, 46);
        g.addColorStop(0, 'rgba(245,166,35,0.28)');
        g.addColorStop(1, 'rgba(245,166,35,0)');
        ctx.save();
        ctx.translate(dx, dy);
        ctx.rotate(hd);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, 46, -Math.PI / 2 - 0.4, -Math.PI / 2 + 0.4);
        ctx.closePath();
        ctx.fill();
        // triangle
        ctx.fillStyle = '#ffc24b';
        ctx.strokeStyle = '#0b0d11';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(0, -9);
        ctx.lineTo(6, 7);
        ctx.lineTo(0, 3);
        ctx.lineTo(-6, 7);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }

      // target marker (locked)
      if (TK && TK.state === 'locked' && T) {
        // place target standoff ahead of drone along heading
        const hd = (T.heading || 0) * Math.PI / 180;
        const [dx, dy] = toXY(T.position.lat, T.position.lon);
        const tx = dx + Math.sin(hd) * (TK.estimatedDistance || 5) / mPerPx;
        const ty = dy - Math.cos(hd) * (TK.estimatedDistance || 5) / mPerPx;
        ctx.strokeStyle = '#f04438';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(tx, ty, 7, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(tx - 11, ty);
        ctx.lineTo(tx + 11, ty);
        ctx.moveTo(tx, ty - 11);
        ctx.lineTo(tx, ty + 11);
        ctx.stroke();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [home]);
  return /*#__PURE__*/React.createElement(Panel, {
    title: "Situational map",
    variant: "sunken",
    pad: false,
    actions: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(Badge, {
      tone: "outline",
      mono: true
    }, "SAT"), /*#__PURE__*/React.createElement(IconButton, {
      size: "sm",
      icon: /*#__PURE__*/React.createElement(Ic, {
        d: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("line", {
          x1: "5",
          y1: "12",
          x2: "19",
          y2: "12"
        }), /*#__PURE__*/React.createElement("line", {
          x1: "12",
          y1: "5",
          x2: "12",
          y2: "19"
        })),
        s: 15
      }),
      title: "Zoom in",
      onClick: () => setZoom(z => Math.min(3, z + 0.3))
    }), /*#__PURE__*/React.createElement(IconButton, {
      size: "sm",
      icon: /*#__PURE__*/React.createElement(Ic, {
        d: /*#__PURE__*/React.createElement("line", {
          x1: "5",
          y1: "12",
          x2: "19",
          y2: "12"
        }),
        s: 15
      }),
      title: "Zoom out",
      onClick: () => setZoom(z => Math.max(0.6, z - 0.3))
    })),
    style: {
      height: '100%'
    },
    bodyStyle: {
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("div", {
    ref: wrapRef,
    style: {
      position: 'absolute',
      inset: 0
    }
  }, /*#__PURE__*/React.createElement("canvas", {
    ref: cvRef,
    style: {
      position: 'absolute',
      inset: 0,
      width: '100%',
      height: '100%'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      left: 10,
      bottom: 10,
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      padding: '7px 9px',
      background: 'rgba(8,12,16,0.72)',
      backdropFilter: 'blur(6px)',
      border: '1px solid var(--border-default)',
      borderRadius: 'var(--radius-sm)'
    }
  }, /*#__PURE__*/React.createElement(Leg, {
    color: "#ffc24b",
    label: "Drone"
  }), /*#__PURE__*/React.createElement(Leg, {
    color: "#e6eaf0",
    label: "Home"
  }), /*#__PURE__*/React.createElement(Leg, {
    color: "#f04438",
    label: "Target"
  }), /*#__PURE__*/React.createElement(Leg, {
    color: "rgba(47,129,247,0.8)",
    label: "Geofence 60 m",
    dash: true
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      right: 10,
      top: 10,
      fontFamily: 'var(--font-mono)',
      fontSize: 10,
      color: 'var(--text-tertiary)',
      background: 'rgba(8,12,16,0.6)',
      padding: '3px 6px',
      borderRadius: 3
    }
  }, tel ? `${tel.position.lat.toFixed(4)}, ${tel.position.lon.toFixed(4)}` : '—')));
}
function Leg({
  color,
  label,
  dash
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 7
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 12,
      height: dash ? 0 : 8,
      borderRadius: dash ? 0 : '50%',
      background: dash ? 'transparent' : color,
      borderTop: dash ? `2px dashed ${color}` : 'none',
      flex: 'none'
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 10,
      color: 'var(--text-secondary)'
    }
  }, label));
}
function mulberry32(a) {
  return function () {
    a |= 0;
    a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
Object.assign(window, {
  MapPanel
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/ground-control/MapPanel.jsx", error: String((e && e.message) || e) }); }

// ui_kits/ground-control/Modals.jsx
try { (() => {
/* Modals & banners — pre-flight checklist (gates Arm), takeoff confirm,
   settings, the persistent tracking-active banner, and critical alerts. */
const DSM = () => window.EyeInTheSkyDesignSystem_c7577a;
function ChecklistModal({
  open,
  onClose,
  onComplete
}) {
  const {
    Modal,
    Button
  } = DSM();
  const Ic = window.EISIcon;
  const items = ['GPS 3D fix acquired (≥ 12 sats)', 'Battery ≥ 90% & secured', 'Props clear of obstructions', 'RC transmitter bound & armed', 'Geofence configured', 'Camera & companion link healthy'];
  const [checked, setChecked] = React.useState(() => items.map(() => false));
  React.useEffect(() => {
    if (open) setChecked(items.map(() => false));
  }, [open]);
  const all = checked.every(Boolean);
  return /*#__PURE__*/React.createElement(Modal, {
    open: open,
    onClose: onClose,
    tone: "accent",
    width: 440,
    icon: /*#__PURE__*/React.createElement(Ic, {
      d: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
        d: "M9 11l3 3L22 4"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"
      })),
      s: 16
    }),
    title: "Pre-flight checklist",
    subtitle: "All items must be confirmed before the vehicle can arm.",
    footer: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(Button, {
      variant: "ghost",
      onClick: onClose
    }, "Cancel"), /*#__PURE__*/React.createElement(Button, {
      variant: "primary",
      disabled: !all,
      onClick: onComplete
    }, "Confirm & enable Arm"))
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      padding: '6px 0 10px'
    }
  }, items.map((it, i) => /*#__PURE__*/React.createElement("label", {
    key: i,
    onClick: () => setChecked(c => c.map((v, j) => j === i ? !v : v)),
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 11,
      padding: '9px 10px',
      borderRadius: 'var(--radius-sm)',
      cursor: 'pointer',
      background: checked[i] ? 'var(--nominal-bg)' : 'var(--surface-input)',
      border: `1px solid ${checked[i] ? 'var(--green-line)' : 'var(--border-subtle)'}`,
      transition: 'all var(--dur-fast)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 18,
      height: 18,
      borderRadius: 4,
      flex: 'none',
      background: checked[i] ? 'var(--green)' : 'transparent',
      border: `1.5px solid ${checked[i] ? 'var(--green)' : 'var(--border-strong)'}`,
      color: '#04140b'
    }
  }, checked[i] && /*#__PURE__*/React.createElement(Ic, {
    d: /*#__PURE__*/React.createElement("path", {
      d: "M5 12l4 4L19 6"
    }),
    s: 12
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      color: checked[i] ? 'var(--text-primary)' : 'var(--text-secondary)'
    }
  }, it)))));
}
function TakeoffModal({
  open,
  onClose,
  onConfirm,
  defaultAlt = 4
}) {
  const {
    Modal,
    Button,
    HoldButton
  } = DSM();
  const Ic = window.EISIcon;
  const [alt, setAlt] = React.useState(defaultAlt);
  React.useEffect(() => {
    if (open) setAlt(defaultAlt);
  }, [open, defaultAlt]);
  return /*#__PURE__*/React.createElement(Modal, {
    open: open,
    onClose: onClose,
    tone: "caution",
    width: 400,
    icon: /*#__PURE__*/React.createElement(Ic, {
      d: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
        d: "M12 20V8M6 14l6-6 6 6"
      })),
      s: 16
    }),
    title: "Confirm takeoff",
    subtitle: "The vehicle will arm-climb to the set altitude in GUIDED mode.",
    footer: null
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '4px 0 12px'
    }
  }, /*#__PURE__*/React.createElement("label", {
    style: {
      fontSize: 10,
      fontWeight: 600,
      letterSpacing: '0.06em',
      textTransform: 'uppercase',
      color: 'var(--text-tertiary)'
    }
  }, "Target altitude"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      marginTop: 8,
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "range",
    min: 2,
    max: 30,
    step: 1,
    value: alt,
    onChange: e => setAlt(Number(e.target.value)),
    style: {
      flex: 1,
      accentColor: 'var(--amber)'
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 22,
      color: 'var(--text-primary)',
      fontVariantNumeric: 'tabular-nums',
      minWidth: 64,
      textAlign: 'right'
    }
  }, alt, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: 'var(--text-tertiary)'
    }
  }, " m"))), /*#__PURE__*/React.createElement(HoldButton, {
    variant: "caution",
    hint: "Hold to take off",
    onConfirm: () => onConfirm(alt),
    icon: /*#__PURE__*/React.createElement(Ic, {
      d: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
        d: "M12 20V8M6 14l6-6 6 6"
      })),
      s: 16
    })
  }, "Takeoff \xB7 ", alt, " m"), /*#__PURE__*/React.createElement("button", {
    onClick: onClose,
    style: {
      width: '100%',
      marginTop: 8,
      height: 32,
      background: 'transparent',
      border: 'none',
      color: 'var(--text-tertiary)',
      fontSize: 12,
      cursor: 'pointer'
    }
  }, "Cancel")));
}
function SettingsModal({
  open,
  onClose,
  config,
  onChange
}) {
  const {
    Modal,
    Button,
    Toggle
  } = DSM();
  const Ic = window.EISIcon;
  return /*#__PURE__*/React.createElement(Modal, {
    open: open,
    onClose: onClose,
    width: 460,
    icon: /*#__PURE__*/React.createElement(Ic, {
      d: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
        cx: "12",
        cy: "12",
        r: "3"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M12 2v3M12 19v3M2 12h3M19 12h3M5.5 5.5l2 2M16.5 16.5l2 2M18.5 5.5l-2 2M7.5 16.5l-2 2"
      })),
      s: 16
    }),
    title: "Settings",
    subtitle: "Connection & display. Persisted via SettingsStore in the live build.",
    footer: /*#__PURE__*/React.createElement(Button, {
      variant: "primary",
      onClick: onClose
    }, "Done")
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 14,
      padding: '6px 0 12px'
    }
  }, /*#__PURE__*/React.createElement(Field, {
    label: "Host / Jetson IP"
  }, /*#__PURE__*/React.createElement(Input, {
    value: config.sitl ? 'sitl' : config.host,
    disabled: config.sitl,
    onChange: v => onChange({
      host: v
    })
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement(Field, {
    label: "Control port",
    flex: true
  }, /*#__PURE__*/React.createElement(Input, {
    value: String(config.controlPort),
    onChange: v => onChange({
      controlPort: Number(v) || 8765
    }),
    mono: true
  })), /*#__PURE__*/React.createElement(Field, {
    label: "Video URL",
    flex: true
  }, /*#__PURE__*/React.createElement(Input, {
    value: config.videoUrl,
    placeholder: "rtsp:// \xB7 empty = mock",
    onChange: v => onChange({
      videoUrl: v
    }),
    mono: true
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '11px 12px',
      background: 'var(--surface-input)',
      borderRadius: 'var(--radius-sm)',
      border: '1px solid var(--border-subtle)'
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: 'var(--text-primary)',
      fontWeight: 500
    }
  }, "SITL simulator"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: 'var(--text-tertiary)'
    }
  }, "Software-in-the-loop \u2014 no hardware")), /*#__PURE__*/React.createElement(Toggle, {
    checked: config.sitl,
    onChange: v => onChange({
      sitl: v
    })
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement(Field, {
    label: "Units",
    flex: true
  }, /*#__PURE__*/React.createElement(Segment, {
    options: ['Metric', 'Imperial'],
    value: "Metric"
  })), /*#__PURE__*/React.createElement(Field, {
    label: "Map tiles",
    flex: true
  }, /*#__PURE__*/React.createElement(Segment, {
    options: ['Satellite', 'Terrain'],
    value: "Satellite"
  })))));
}
function Field({
  label,
  children,
  flex
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      flex: flex ? 1 : 'none',
      display: 'flex',
      flexDirection: 'column',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("label", {
    style: {
      fontSize: 10,
      fontWeight: 600,
      letterSpacing: '0.06em',
      textTransform: 'uppercase',
      color: 'var(--text-tertiary)'
    }
  }, label), children);
}
function Input({
  value,
  onChange,
  disabled,
  placeholder,
  mono
}) {
  return /*#__PURE__*/React.createElement("input", {
    value: value,
    disabled: disabled,
    placeholder: placeholder,
    onChange: e => onChange && onChange(e.target.value),
    style: {
      height: 32,
      padding: '0 10px',
      background: disabled ? 'var(--bg-sunken)' : 'var(--surface-input)',
      border: '1px solid var(--border-input)',
      borderRadius: 'var(--radius-sm)',
      color: disabled ? 'var(--text-tertiary)' : 'var(--text-primary)',
      fontFamily: mono ? 'var(--font-mono)' : 'var(--font-sans)',
      fontSize: 13,
      outline: 'none',
      width: '100%',
      boxSizing: 'border-box'
    }
  });
}
function Segment({
  options,
  value
}) {
  const [v, setV] = React.useState(value);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 2,
      padding: 2,
      background: 'var(--bg-sunken)',
      borderRadius: 'var(--radius-sm)',
      border: '1px solid var(--border-subtle)'
    }
  }, options.map(o => /*#__PURE__*/React.createElement("button", {
    key: o,
    onClick: () => setV(o),
    style: {
      flex: 1,
      height: 26,
      border: 'none',
      borderRadius: 4,
      background: v === o ? 'var(--surface-input)' : 'transparent',
      color: v === o ? 'var(--text-primary)' : 'var(--text-tertiary)',
      fontSize: 12,
      fontWeight: 500,
      cursor: 'pointer'
    }
  }, o)));
}
function TrackingBanner({
  standoff,
  maxSpeed,
  onDisengage
}) {
  const Ic = window.EISIcon;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      height: 36,
      flex: 'none',
      padding: '0 14px',
      background: 'linear-gradient(90deg, var(--amber-tint), rgba(245,166,35,0.06))',
      borderBottom: '1px solid var(--amber-line)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      color: 'var(--amber-bright)',
      fontWeight: 700,
      fontSize: 12,
      letterSpacing: '0.06em',
      textTransform: 'uppercase'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 8,
      height: 8,
      borderRadius: '50%',
      background: 'var(--amber)',
      animation: 'eis-ping2 1.2s infinite'
    }
  }), /*#__PURE__*/React.createElement("style", null, `@keyframes eis-ping2{0%,100%{opacity:1}50%{opacity:.3}}`), "Autonomous tracking active"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 12,
      color: 'var(--text-secondary)'
    }
  }, "standoff ", standoff.toFixed(1), " m \xB7 max ", maxSpeed.toFixed(1), " m/s"), /*#__PURE__*/React.createElement("button", {
    onClick: onDisengage,
    style: {
      marginLeft: 'auto',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      height: 26,
      padding: '0 12px',
      background: 'var(--red-deep)',
      border: '1px solid var(--red)',
      borderRadius: 'var(--radius-sm)',
      color: '#fff',
      fontSize: 12,
      fontWeight: 700,
      cursor: 'pointer'
    }
  }, /*#__PURE__*/React.createElement(Ic, {
    d: /*#__PURE__*/React.createElement("rect", {
      x: "6",
      y: "6",
      width: "12",
      height: "12",
      rx: "2",
      fill: "currentColor",
      stroke: "none"
    }),
    s: 12
  }), " Disengage"));
}
Object.assign(window, {
  ChecklistModal,
  TakeoffModal,
  SettingsModal,
  TrackingBanner,
  ManualBanner
});
function ManualBanner({
  onRelease
}) {
  const Ic = window.EISIcon;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      height: 36,
      flex: 'none',
      padding: '0 14px',
      background: 'linear-gradient(90deg, var(--blue-tint), rgba(47,129,247,0.05))',
      borderBottom: '1px solid var(--blue-line)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      color: 'var(--accent-text)',
      fontWeight: 700,
      fontSize: 12,
      letterSpacing: '0.06em',
      textTransform: 'uppercase'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 8,
      height: 8,
      borderRadius: '50%',
      background: 'var(--accent)',
      animation: 'eis-ping2 1.2s infinite'
    }
  }), "Manual control active"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 12,
      color: 'var(--text-secondary)'
    }
  }, "operator has the sticks \xB7 STABILIZE"), /*#__PURE__*/React.createElement("button", {
    onClick: onRelease,
    style: {
      marginLeft: 'auto',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      height: 26,
      padding: '0 12px',
      background: 'var(--surface-input)',
      border: '1px solid var(--border-strong)',
      borderRadius: 'var(--radius-sm)',
      color: 'var(--text-primary)',
      fontSize: 12,
      fontWeight: 700,
      cursor: 'pointer'
    }
  }, /*#__PURE__*/React.createElement(Ic, {
    d: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
      d: "M9 10l-5 5 5 5"
    }), /*#__PURE__*/React.createElement("path", {
      d: "M4 15h11a5 5 0 0 0 5-5V4"
    })),
    s: 12
  }), " Release"));
}
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/ground-control/Modals.jsx", error: String((e && e.message) || e) }); }

// ui_kits/ground-control/StatusBar.jsx
try { (() => {
/* StatusBar — always-visible top bar: connection, armed, mode, timer, battery,
   GPS, link, and the persistent DISARM / KILL button at the far right. */
function StatusBar({
  tel,
  connState,
  sitl,
  elapsed,
  controllerOn,
  manualActive,
  onDisarm,
  onOpenSettings
}) {
  const {
    StatusPill,
    Badge,
    IconButton
  } = window.EyeInTheSkyDesignSystem_c7577a;
  const {
    BatteryGauge,
    SignalGauge
  } = window.EyeInTheSkyDesignSystem_c7577a;
  const b = tel?.battery?.remaining ?? 100;
  const armed = tel?.armed;
  const connected = connState === 'connected';
  const fixLabel = ['NO GPS', 'NO FIX', '2D', '3D', 'DGPS', 'RTK', 'RTK'][tel?.gps?.fixType ?? 0] || '3D';
  const Sep = () => /*#__PURE__*/React.createElement("div", {
    style: {
      width: 1,
      height: 22,
      background: 'var(--border-subtle)'
    }
  });
  return /*#__PURE__*/React.createElement("header", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      height: 'var(--statusbar-h)',
      flex: 'none',
      padding: '0 12px',
      background: 'var(--surface-raised)',
      borderBottom: '1px solid var(--border-default)'
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: "../../assets/logo-mark.svg",
    width: "24",
    height: "24",
    alt: "",
    style: {
      flex: 'none'
    }
  }), /*#__PURE__*/React.createElement(StatusPill, {
    status: connected ? 'nominal' : connState === 'connecting' ? 'caution' : 'danger',
    dot: true,
    pulse: connState === 'connecting'
  }, connected ? 'Connected' : connState === 'connecting' ? 'Connecting' : 'Disconnected'), /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      marginLeft: -6
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 11,
      color: 'var(--text-tertiary)'
    }
  }, sitl ? 'sitl' : tel ? '192.168.1.42' : '—'), /*#__PURE__*/React.createElement(Badge, {
    tone: sitl ? 'caution' : 'nominal'
  }, sitl ? 'SITL' : 'LIVE')), /*#__PURE__*/React.createElement(Sep, null), /*#__PURE__*/React.createElement(StatusPill, {
    status: armed ? 'danger' : 'neutral',
    solid: armed
  }, armed ? 'Armed' : 'Disarmed'), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-sans)',
      fontSize: 12,
      fontWeight: 600,
      letterSpacing: '0.04em',
      color: 'var(--accent-text)'
    }
  }, tel?.mode || 'LOITER'), /*#__PURE__*/React.createElement(Sep, null), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      lineHeight: 1,
      gap: 2
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 9,
      fontWeight: 600,
      letterSpacing: '0.08em',
      color: 'var(--text-tertiary)'
    }
  }, "FLIGHT"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 13,
      color: 'var(--text-primary)',
      fontVariantNumeric: 'tabular-nums'
    }
  }, fmtTime(elapsed))), /*#__PURE__*/React.createElement(Sep, null), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 116
    }
  }, /*#__PURE__*/React.createElement(BatteryGauge, {
    remaining: b,
    voltage: tel?.battery?.voltage,
    compact: true
  })), /*#__PURE__*/React.createElement(Sep, null), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      lineHeight: 1,
      gap: 2
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 9,
      fontWeight: 600,
      letterSpacing: '0.08em',
      color: 'var(--text-tertiary)'
    }
  }, "GPS \xB7 ", fixLabel), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 13,
      color: 'var(--text-primary)',
      fontVariantNumeric: 'tabular-nums'
    }
  }, tel?.gps?.satellites ?? '—', " sats")), /*#__PURE__*/React.createElement(Sep, null), /*#__PURE__*/React.createElement(SignalGauge, {
    rssi: tel?.link?.rssi ?? -60,
    latencyMs: tel?.link?.latencyMs,
    lost: !connected
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      marginLeft: 'auto',
      display: 'flex',
      alignItems: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    title: manualActive ? 'Manual control active' : controllerOn ? 'Controller connected' : 'No controller',
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      height: 26,
      padding: '0 9px',
      background: manualActive ? 'var(--accent-subtle)' : 'var(--surface-input)',
      border: `1px solid ${manualActive ? 'var(--accent-border)' : 'var(--border-input)'}`,
      borderRadius: 'var(--radius-sm)',
      color: manualActive ? 'var(--accent-text)' : controllerOn ? 'var(--nominal-fg)' : 'var(--text-tertiary)',
      fontFamily: 'var(--font-sans)',
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: '0.04em'
    }
  }, /*#__PURE__*/React.createElement(Ic, {
    d: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("rect", {
      x: "2",
      y: "6",
      width: "20",
      height: "12",
      rx: "6"
    }), /*#__PURE__*/React.createElement("path", {
      d: "M7 11h3M8.5 9.5v3"
    }), /*#__PURE__*/React.createElement("circle", {
      cx: "16",
      cy: "10.5",
      r: "1",
      fill: "currentColor",
      stroke: "none"
    }), /*#__PURE__*/React.createElement("circle", {
      cx: "18",
      cy: "13",
      r: "1",
      fill: "currentColor",
      stroke: "none"
    })),
    s: 15
  }), manualActive ? 'MANUAL' : controllerOn ? 'PAD' : 'NO PAD'), /*#__PURE__*/React.createElement(IconButton, {
    icon: /*#__PURE__*/React.createElement(Ic, {
      d: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
        cx: "12",
        cy: "12",
        r: "3"
      }), /*#__PURE__*/React.createElement("path", {
        d: "M12 2v3M12 19v3M2 12h3M19 12h3M5.5 5.5l2 2M16.5 16.5l2 2M18.5 5.5l-2 2M7.5 16.5l-2 2"
      })),
      s: 16
    }),
    title: "Settings",
    onClick: onOpenSettings,
    variant: "solid"
  }), /*#__PURE__*/React.createElement("button", {
    onClick: onDisarm,
    title: "Disarm / Kill (Space)",
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 7,
      height: 34,
      padding: '0 16px',
      background: armed ? 'var(--red-deep)' : 'var(--surface-input)',
      border: `1px solid ${armed ? 'var(--red)' : 'var(--border-input)'}`,
      borderRadius: 'var(--radius-md)',
      color: armed ? '#fff' : 'var(--text-secondary)',
      fontFamily: 'var(--font-sans)',
      fontSize: 13,
      fontWeight: 700,
      letterSpacing: '0.04em',
      cursor: 'pointer',
      boxShadow: armed ? 'var(--glow-critical)' : 'none',
      transition: 'all var(--dur-base) var(--ease-out)'
    }
  }, /*#__PURE__*/React.createElement(Ic, {
    d: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
      d: "M18.36 6.64A9 9 0 1 1 5.64 6.64"
    }), /*#__PURE__*/React.createElement("line", {
      x1: "12",
      y1: "2",
      x2: "12",
      y2: "12"
    })),
    s: 15
  }), "DISARM")));
}
function Ic({
  d,
  s = 16
}) {
  return /*#__PURE__*/React.createElement("svg", {
    width: s,
    height: s,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, d);
}
function fmtTime(s) {
  const m = Math.floor(s / 60),
    ss = s % 60;
  return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}
Object.assign(window, {
  StatusBar,
  EISIcon: Ic
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/ground-control/StatusBar.jsx", error: String((e && e.message) || e) }); }

// ui_kits/ground-control/TelemetryPanel.jsx
try { (() => {
/* TelemetryPanel — right column: artificial horizon, compass, numeric readouts,
   and battery/altitude sparklines. */
function TelemetryPanel({
  tel,
  tracking,
  history
}) {
  const DS = window.EyeInTheSkyDesignSystem_c7577a;
  const {
    Panel,
    GaugeReadout,
    AttitudeIndicator,
    Compass
  } = DS;
  const pos = tel?.position || {};
  const vel = tel?.velocity || {};
  const gps = tel?.gps || {};
  const bat = tel?.battery || {};
  const estDist = tracking?.state === 'locked' ? tracking?.estimatedDistance : null;
  const batStatus = (bat.remaining ?? 100) <= 15 ? 'danger' : (bat.remaining ?? 100) <= 30 ? 'caution' : 'nominal';
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      height: '100%',
      minHeight: 0,
      overflow: 'auto'
    }
  }, /*#__PURE__*/React.createElement(Panel, {
    title: "Attitude & heading",
    pad: true
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-around',
      alignItems: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement(AttitudeIndicator, {
    roll: tel?.attitude?.roll ?? 0,
    pitch: tel?.attitude?.pitch ?? 0,
    size: 132,
    label: false
  }), /*#__PURE__*/React.createElement(Compass, {
    heading: tel?.heading ?? 0,
    size: 132,
    label: false
  }))), /*#__PURE__*/React.createElement(Panel, {
    title: "Telemetry"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: '14px 10px'
    }
  }, /*#__PURE__*/React.createElement(GaugeReadout, {
    label: "Rel Alt",
    value: (pos.relAlt ?? 0).toFixed(1),
    unit: "m",
    size: "md"
  }), /*#__PURE__*/React.createElement(GaugeReadout, {
    label: "Ground Spd",
    value: (vel.groundspeed ?? 0).toFixed(1),
    unit: "m/s",
    size: "md"
  }), /*#__PURE__*/React.createElement(GaugeReadout, {
    label: "Vert Spd",
    value: (vel.verticalSpeed ?? 0).toFixed(1),
    unit: "m/s",
    size: "md",
    trend: (vel.verticalSpeed ?? 0) > 0.1 ? 'up' : (vel.verticalSpeed ?? 0) < -0.1 ? 'down' : null
  }), /*#__PURE__*/React.createElement(GaugeReadout, {
    label: "To Home",
    value: (tel?.home?.distance ?? 0).toFixed(0),
    unit: "m",
    size: "md"
  }), /*#__PURE__*/React.createElement(GaugeReadout, {
    label: "To Target",
    value: estDist != null ? estDist.toFixed(1) : '—',
    unit: estDist != null ? 'm' : '',
    size: "md",
    status: estDist != null ? 'caution' : 'muted'
  }), /*#__PURE__*/React.createElement(GaugeReadout, {
    label: "Battery",
    value: (bat.remaining ?? 0).toFixed(0),
    unit: "%",
    size: "md",
    status: batStatus
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 1,
      background: 'var(--border-subtle)',
      margin: '12px 0'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr 1fr',
      gap: '10px 8px'
    }
  }, /*#__PURE__*/React.createElement(Mini, {
    label: "Sats",
    value: gps.satellites ?? '—'
  }), /*#__PURE__*/React.createElement(Mini, {
    label: "HDOP",
    value: (gps.hdop ?? 0).toFixed(1)
  }), /*#__PURE__*/React.createElement(Mini, {
    label: "Voltage",
    value: `${(bat.voltage ?? 0).toFixed(1)}V`
  }), /*#__PURE__*/React.createElement(Mini, {
    label: "Lat",
    value: (pos.lat ?? 0).toFixed(4)
  }), /*#__PURE__*/React.createElement(Mini, {
    label: "Lon",
    value: (pos.lon ?? 0).toFixed(4),
    span2: true
  }))), /*#__PURE__*/React.createElement(Panel, {
    title: "History"
  }, /*#__PURE__*/React.createElement(Spark, {
    label: "Altitude",
    data: history.alt,
    unit: "m",
    color: "var(--accent)"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 10
    }
  }), /*#__PURE__*/React.createElement(Spark, {
    label: "Battery",
    data: history.bat,
    unit: "%",
    color: batStatus === 'danger' ? 'var(--red)' : batStatus === 'caution' ? 'var(--amber)' : 'var(--green)'
  })));
}
function Mini({
  label,
  value,
  span2
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
      gridColumn: span2 ? 'span 2' : 'auto'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 9.5,
      fontWeight: 600,
      letterSpacing: '0.06em',
      textTransform: 'uppercase',
      color: 'var(--text-tertiary)'
    }
  }, label), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 13,
      color: 'var(--text-secondary)',
      fontVariantNumeric: 'tabular-nums'
    }
  }, value));
}
function Spark({
  label,
  data,
  unit,
  color
}) {
  const w = 252,
    h = 34;
  const vals = data.length ? data : [0];
  const min = Math.min(...vals),
    max = Math.max(...vals);
  const rng = max - min || 1;
  const pts = vals.map((v, i) => `${i / Math.max(1, vals.length - 1) * w},${h - (v - min) / rng * (h - 4) - 2}`).join(' ');
  const last = vals[vals.length - 1];
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'baseline',
      marginBottom: 3
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 9.5,
      fontWeight: 600,
      letterSpacing: '0.06em',
      textTransform: 'uppercase',
      color: 'var(--text-tertiary)'
    }
  }, label), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 12,
      color: 'var(--text-secondary)'
    }
  }, last.toFixed(1), " ", unit)), /*#__PURE__*/React.createElement("svg", {
    width: "100%",
    height: h,
    viewBox: `0 0 ${w} ${h}`,
    preserveAspectRatio: "none"
  }, /*#__PURE__*/React.createElement("polyline", {
    points: pts,
    fill: "none",
    stroke: color,
    strokeWidth: "1.5",
    vectorEffect: "non-scaling-stroke"
  })));
}
Object.assign(window, {
  TelemetryPanel
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/ground-control/TelemetryPanel.jsx", error: String((e && e.message) || e) }); }

// ui_kits/ground-control/VideoPanel.jsx
try { (() => {
/* VideoPanel — synthetic forward-view canvas scene + tracking overlay.
   Draws a believable scene with people at the mock's bbox positions, renders
   DOM bounding boxes for hover/click-to-select, crosshair, and distance HUD. */
function VideoPanel({
  tracking,
  connState,
  standoff,
  onSelectTarget
}) {
  const canvasRef = React.useRef(null);
  const trackRef = React.useRef(tracking);
  trackRef.current = tracking;
  const sizeRef = React.useRef({
    w: 800,
    h: 450
  });
  const [box, setBox] = React.useState({
    w: 800,
    h: 450
  });

  // resize observer
  const wrapRef = React.useRef(null);
  React.useEffect(() => {
    const el = wrapRef.current;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      sizeRef.current = {
        w: r.width,
        h: r.height
      };
      setBox({
        w: r.width,
        h: r.height
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // canvas scene animation
  React.useEffect(() => {
    let raf,
      t = 0;
    const draw = () => {
      const cv = canvasRef.current;
      if (!cv) {
        raf = requestAnimationFrame(draw);
        return;
      }
      const {
        w,
        h
      } = sizeRef.current;
      const dpr = window.devicePixelRatio || 1;
      if (cv.width !== w * dpr || cv.height !== h * dpr) {
        cv.width = w * dpr;
        cv.height = h * dpr;
      }
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      t += 0.016;
      const connected = connState === 'connected';

      // sky → ground gradient
      const horizon = h * 0.42;
      const g2 = ctx.createLinearGradient(0, 0, 0, horizon);
      g2.addColorStop(0, '#0e1c28');
      g2.addColorStop(1, '#26323a');
      ctx.fillStyle = g2;
      ctx.fillRect(0, 0, w, horizon);
      // ground
      const grd = ctx.createLinearGradient(0, horizon, 0, h);
      grd.addColorStop(0, '#2a3a30');
      grd.addColorStop(1, '#161f1a');
      ctx.fillStyle = grd;
      ctx.fillRect(0, horizon, w, h - horizon);
      // perspective ground lines
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 1;
      for (let i = -6; i <= 6; i++) {
        ctx.beginPath();
        ctx.moveTo(w / 2, horizon);
        ctx.lineTo(w / 2 + i * w * 0.16, h);
        ctx.stroke();
      }
      for (let j = 1; j <= 5; j++) {
        const yy = horizon + (h - horizon) * (j / 5) * (j / 5);
        ctx.beginPath();
        ctx.moveTo(0, yy);
        ctx.lineTo(w, yy);
        ctx.stroke();
      }

      // draw people from tracking targets
      if (connected) {
        const tk = trackRef.current;
        (tk?.targets || []).forEach(tgt => {
          const [nx, ny, nw, nh] = tgt.bbox;
          const px = nx * w,
            py = ny * h,
            pw = nw * w,
            ph = nh * h;
          // shadow
          ctx.fillStyle = 'rgba(0,0,0,0.35)';
          ctx.beginPath();
          ctx.ellipse(px + pw / 2, py + ph, pw * 0.5, ph * 0.08, 0, 0, Math.PI * 2);
          ctx.fill();
          // body
          ctx.fillStyle = tgt.isLocked ? '#3a4654' : '#34404c';
          roundRect(ctx, px + pw * 0.22, py + ph * 0.28, pw * 0.56, ph * 0.72, pw * 0.18);
          ctx.fill();
          // head
          ctx.fillStyle = '#414f5e';
          ctx.beginPath();
          ctx.arc(px + pw / 2, py + ph * 0.16, pw * 0.22, 0, Math.PI * 2);
          ctx.fill();
        });
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [connState]);
  const connected = connState === 'connected';
  const state = tracking?.state || 'idle';
  const {
    Badge
  } = window.EyeInTheSkyDesignSystem_c7577a;

  // border treatment per tracking state
  const borderColor = !connected ? 'transparent' : state === 'locked' ? 'var(--amber)' : state === 'searching' ? 'var(--accent)' : state === 'lost' ? 'var(--red)' : 'transparent';
  return /*#__PURE__*/React.createElement("div", {
    ref: wrapRef,
    style: {
      position: 'relative',
      width: '100%',
      height: '100%',
      overflow: 'hidden',
      background: '#0a1016'
    }
  }, /*#__PURE__*/React.createElement("canvas", {
    ref: canvasRef,
    style: {
      position: 'absolute',
      inset: 0,
      width: '100%',
      height: '100%',
      display: connected ? 'block' : 'none'
    }
  }), connected && (state === 'locked' || state === 'searching' || state === 'lost') && /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: 0,
      pointerEvents: 'none',
      boxShadow: `inset 0 0 0 2px ${borderColor}`,
      animation: state === 'locked' ? 'eis-trackpulse 1.3s ease-in-out infinite' : 'none'
    }
  }, /*#__PURE__*/React.createElement("style", null, `@keyframes eis-trackpulse{0%,100%{opacity:.5}50%{opacity:1}}`)), !connected && /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: 0,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
      color: 'var(--text-disabled)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 46,
      height: 46,
      borderRadius: '50%',
      border: '2px solid var(--gray-6)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 22,
      height: 2,
      background: 'var(--gray-6)',
      transform: 'rotate(45deg)'
    }
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-sans)',
      fontSize: 13,
      fontWeight: 600,
      letterSpacing: '0.1em'
    }
  }, connState === 'connecting' ? 'CONNECTING…' : 'NO VIDEO SIGNAL')), connected && (tracking?.targets || []).map(tgt => {
    const [nx, ny, nw, nh] = tgt.bbox;
    const locked = tgt.isLocked;
    return /*#__PURE__*/React.createElement("button", {
      key: tgt.id,
      onClick: () => onSelectTarget(tgt.id),
      title: `Select target #${tgt.id}`,
      style: {
        position: 'absolute',
        left: `${nx * 100}%`,
        top: `${ny * 100}%`,
        width: `${nw * 100}%`,
        height: `${nh * 100}%`,
        border: `1.5px solid ${locked ? 'var(--amber-bright)' : 'rgba(255,255,255,0.6)'}`,
        borderRadius: 2,
        background: 'transparent',
        cursor: 'pointer',
        padding: 0,
        boxShadow: locked ? '0 0 0 1px rgba(0,0,0,0.5), 0 0 14px rgba(245,166,35,0.4)' : 'none',
        transition: 'border-color var(--dur-fast)'
      }
    }, locked && [['0', '0'], ['100%', '0'], ['0', '100%'], ['100%', '100%']].map(([x, y], i) => /*#__PURE__*/React.createElement("span", {
      key: i,
      style: {
        position: 'absolute',
        left: x,
        top: y,
        width: 7,
        height: 7,
        transform: `translate(${x === '0' ? '-1px' : '-6px'},${y === '0' ? '-1px' : '-6px'})`,
        borderLeft: x === '0' ? '2px solid var(--amber-bright)' : 'none',
        borderRight: x !== '0' ? '2px solid var(--amber-bright)' : 'none',
        borderTop: y === '0' ? '2px solid var(--amber-bright)' : 'none',
        borderBottom: y !== '0' ? '2px solid var(--amber-bright)' : 'none'
      }
    })), /*#__PURE__*/React.createElement("span", {
      style: {
        position: 'absolute',
        top: -18,
        left: -1.5,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '1px 5px',
        height: 16,
        background: locked ? 'var(--amber)' : 'rgba(0,0,0,0.7)',
        color: locked ? '#1a1205' : '#fff',
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        fontWeight: 600,
        borderRadius: 2,
        whiteSpace: 'nowrap'
      }
    }, locked ? 'LOCKED' : `PERSON ${tgt.id}`, " \xB7 ", Math.round(tgt.confidence * 100), "%"));
  }), connected && /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      left: '50%',
      top: '50%',
      transform: 'translate(-50%,-50%)',
      pointerEvents: 'none',
      opacity: 0.55
    }
  }, /*#__PURE__*/React.createElement("svg", {
    width: "44",
    height: "44",
    viewBox: "0 0 44 44",
    fill: "none",
    stroke: "rgba(255,255,255,0.8)",
    strokeWidth: "1.4"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M22 6 V16 M22 28 V38 M6 22 H16 M28 22 H38",
    strokeLinecap: "round"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "22",
    cy: "22",
    r: "2",
    fill: "rgba(255,255,255,0.8)",
    stroke: "none"
  }))), connected && state === 'locked' && tracking?.estimatedDistance != null && /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      left: '50%',
      bottom: 14,
      transform: 'translateX(-50%)',
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      padding: '7px 14px',
      background: 'rgba(8,12,16,0.78)',
      backdropFilter: 'blur(6px)',
      border: '1px solid var(--border-default)',
      borderRadius: 'var(--radius-md)',
      fontFamily: 'var(--font-mono)',
      fontVariantNumeric: 'tabular-nums'
    }
  }, /*#__PURE__*/React.createElement(HudVal, {
    label: "DIST",
    value: tracking.estimatedDistance.toFixed(1),
    unit: "m",
    color: "var(--amber-bright)"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 1,
      height: 22,
      background: 'var(--border-default)'
    }
  }), /*#__PURE__*/React.createElement(HudVal, {
    label: "STANDOFF",
    value: standoff.toFixed(1),
    unit: "m",
    color: "var(--text-secondary)"
  })), connected && /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: 12,
      left: 12,
      display: 'flex',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: '4px 9px',
      background: 'rgba(8,12,16,0.7)',
      backdropFilter: 'blur(6px)',
      border: '1px solid var(--border-default)',
      borderRadius: 'var(--radius-pill)',
      fontFamily: 'var(--font-sans)',
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: '0.05em',
      textTransform: 'uppercase',
      color: trackColor(state)
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 7,
      height: 7,
      borderRadius: '50%',
      background: trackColor(state)
    }
  }), trackLabel(state))), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: 12,
      right: 12
    }
  }, /*#__PURE__*/React.createElement(Badge, {
    tone: connected ? 'danger' : 'neutral'
  }, "\u25CF REC")));
}
function HudVal({
  label,
  value,
  unit,
  color
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 1
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 9,
      fontWeight: 600,
      letterSpacing: '0.1em',
      color: 'var(--text-tertiary)'
    }
  }, label), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 18,
      fontWeight: 500,
      color
    }
  }, value, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      color: 'var(--text-tertiary)'
    }
  }, " ", unit)));
}
function trackColor(s) {
  return s === 'locked' ? 'var(--amber-bright)' : s === 'searching' ? 'var(--accent-text)' : s === 'lost' ? 'var(--red-bright)' : 'var(--text-tertiary)';
}
function trackLabel(s) {
  return s === 'locked' ? 'Tracking · Locked' : s === 'searching' ? 'Searching' : s === 'lost' ? 'Target Lost' : 'Tracking Idle';
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
Object.assign(window, {
  VideoPanel
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/ground-control/VideoPanel.jsx", error: String((e && e.message) || e) }); }

// ui_kits/ground-control/mock.js
try { (() => {
/* ============================================================================
   Eye in the Sky — UI-kit mock data layer
   A self-contained, lifelike mock that mirrors the PRD's DataSource contract
   (Section 4). Drives the whole demo with no backend: telemetry @ ~10Hz,
   tracking with bboxes that match the canvas scene, status-text log, and a
   command state machine. Exposes window.EISMock (a singleton).
   ============================================================================ */
(function () {
  const HOME = {
    lat: 37.7699,
    lon: -122.4666
  }; // generic park
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const now = () => Date.now();
  class Mock {
    constructor() {
      this.cbs = {
        tel: [],
        trk: [],
        txt: [],
        ack: [],
        conn: []
      };
      this.connState = 'connected';
      this.config = {
        host: 'sitl',
        controlPort: 8765,
        videoUrl: '',
        sitl: true
      };
      this.t = 0;
      this.s = {
        armed: false,
        mode: 'LOITER',
        relAlt: 0,
        targetAlt: 0,
        roll: 0,
        pitch: 0,
        yaw: 0,
        heading: 215,
        lat: HOME.lat,
        lon: HOME.lon,
        groundspeed: 0,
        vspeed: 0,
        battery: 96,
        voltage: 16.6,
        current: 0.4,
        sats: 16,
        fix: 3,
        hdop: 0.7,
        rssi: -48,
        latency: 38,
        phase: 'idle' // idle | takeoff | flying | rtl | landing
      };
      this.track = {
        state: 'idle',
        standoff: 4,
        maxSpeed: 3,
        estimatedDistance: null,
        lockedTargetId: null,
        targets: []
      };
      // two "people" moving in the frame (normalised centre + size)
      this.people = [{
        id: 1,
        x: 0.40,
        y: 0.58,
        w: 0.10,
        h: 0.30,
        vx: 0.0011,
        conf: 0.0
      }, {
        id: 2,
        x: 0.66,
        y: 0.55,
        w: 0.09,
        h: 0.27,
        vx: -0.0008,
        conf: 0.0
      }];
      this._lostTimer = 0;
      this._started = false;

      // manual (game-controller) piloting
      this.manual = {
        active: false,
        throttle: 0,
        yaw: 0,
        pitch: 0,
        roll: 0
      };
    }

    /* high-frequency stick input — bypasses the ack path on purpose */
    setManualInput(v) {
      Object.assign(this.manual, v);
    }

    /* ---- subscription API (DataSource-shaped) ---------------------------- */
    onTelemetry(cb) {
      this.cbs.tel.push(cb);
      return () => this._off('tel', cb);
    }
    onTracking(cb) {
      this.cbs.trk.push(cb);
      return () => this._off('trk', cb);
    }
    onStatusText(cb) {
      this.cbs.txt.push(cb);
      return () => this._off('txt', cb);
    }
    onAck(cb) {
      this.cbs.ack.push(cb);
      return () => this._off('ack', cb);
    }
    onConnectionChange(cb) {
      this.cbs.conn.push(cb);
      cb(this.connState);
      return () => this._off('conn', cb);
    }
    getVideoUrl() {
      return '';
    }
    _off(k, cb) {
      this.cbs[k] = this.cbs[k].filter(f => f !== cb);
    }
    _emit(k, msg) {
      this.cbs[k].forEach(f => f(msg));
    }
    log(severity, text) {
      this._emit('txt', {
        type: 'statusText',
        ts: now(),
        severity,
        text
      });
    }

    /* ---- command handling ------------------------------------------------ */
    sendCommand(cmd) {
      const p = cmd.params || {};
      let ok = true,
        message = 'OK';
      switch (cmd.command) {
        case 'arm':
          this.s.armed = true;
          this.log('info', 'Vehicle ARMED');
          break;
        case 'disarm':
        case 'emergencyStop':
          this.s.armed = false;
          this.s.phase = 'idle';
          this.s.mode = 'LOITER';
          this.s.targetAlt = 0;
          this.manual.active = false;
          this.manual.throttle = this.manual.yaw = this.manual.pitch = this.manual.roll = 0;
          if (this.track.state !== 'idle') {
            this.track.state = 'idle';
            this.track.lockedTargetId = null;
            this.track.estimatedDistance = null;
          }
          this.log(cmd.command === 'emergencyStop' ? 'critical' : 'warning', cmd.command === 'emergencyStop' ? 'EMERGENCY STOP — motors disarmed' : 'Vehicle DISARMED');
          break;
        case 'takeoff':
          if (!this.s.armed) {
            ok = false;
            message = 'Not armed';
            break;
          }
          this.s.phase = 'takeoff';
          this.s.mode = 'GUIDED';
          this.s.targetAlt = p.altitude || 4;
          this.log('info', `Takeoff to ${this.s.targetAlt} m`);
          break;
        case 'land':
          this.s.phase = 'landing';
          this.s.mode = 'LAND';
          this.log('info', 'Landing');
          break;
        case 'rtl':
          this.s.phase = 'rtl';
          this.s.mode = 'RTL';
          this.log('info', 'Return to launch');
          break;
        case 'setMode':
          this.s.mode = p.mode;
          this.log('info', `Mode → ${p.mode}`);
          break;
        case 'engageTracking':
          this.track.state = 'searching';
          this.log('info', 'Tracking engaged — searching');
          break;
        case 'disengageTracking':
          this.track.state = 'idle';
          this.track.lockedTargetId = null;
          this.track.estimatedDistance = null;
          this.log('warning', 'Tracking disengaged');
          break;
        case 'selectTarget':
          this.track.lockedTargetId = p.targetId;
          if (this.track.state === 'idle') this.track.state = 'searching';
          this.log('info', `Target #${p.targetId} selected`);
          break;
        case 'setStandoff':
          this.track.standoff = p.meters;
          break;
        case 'setMaxSpeed':
          this.track.maxSpeed = p.mps;
          break;
        case 'engageManual':
          if (!this.s.armed) {
            ok = false;
            message = 'Not armed';
            break;
          }
          this.manual.active = true;
          this.s.mode = 'STABILIZE';
          if (this.s.phase === 'idle') this.s.phase = 'flying';
          if (this.track.state !== 'idle') {
            this.track.state = 'idle';
            this.track.lockedTargetId = null;
            this.track.estimatedDistance = null;
            this.log('warning', 'Tracking released for manual control');
          }
          this.log('warning', 'MANUAL CONTROL engaged');
          break;
        case 'disengageManual':
          this.manual.active = false;
          this.manual.throttle = this.manual.yaw = this.manual.pitch = this.manual.roll = 0;
          if (this.s.armed) this.s.mode = 'LOITER';
          this.log('info', 'Manual released — position hold');
          break;
        default:
          ok = false;
          message = 'Unknown command';
      }
      const ack = {
        type: 'ack',
        ts: now(),
        command: cmd.command,
        success: ok,
        message
      };
      setTimeout(() => this._emit('ack', ack), 60);
      return Promise.resolve(ack);
    }

    /* ---- simulation loop ------------------------------------------------- */
    start() {
      if (this._started) return;
      this._started = true;
      this.log('info', 'EKF healthy');
      this.log('info', 'GPS fix acquired — 16 sats');
      this._tel = setInterval(() => this.stepTelemetry(), 100); // 10 Hz
      this._trk = setInterval(() => this.stepTracking(), 120);
      this._amb = setInterval(() => this.ambientLog(), 7000);
    }
    stop() {
      clearInterval(this._tel);
      clearInterval(this._trk);
      clearInterval(this._amb);
      this._started = false;
    }
    stepTelemetry() {
      const s = this.s;
      this.t += 0.1;
      // altitude toward target
      if (s.phase === 'takeoff') {
        s.relAlt = lerp(s.relAlt, s.targetAlt, 0.06);
        if (Math.abs(s.relAlt - s.targetAlt) < 0.15) {
          s.relAlt = s.targetAlt;
          s.phase = 'flying';
          this.log('info', 'Reached target altitude');
        }
      } else if (s.phase === 'rtl') {
        s.lat = lerp(s.lat, HOME.lat, 0.02);
        s.lon = lerp(s.lon, HOME.lon, 0.02);
        if (Math.abs(s.lat - HOME.lat) < 1e-5) {
          s.phase = 'landing';
          s.mode = 'LAND';
        }
      } else if (s.phase === 'landing') {
        s.relAlt = lerp(s.relAlt, 0, 0.05);
        if (s.relAlt < 0.12) {
          s.relAlt = 0;
          s.armed = false;
          s.phase = 'idle';
          s.mode = 'LOITER';
          this.log('info', 'Landed & disarmed');
        }
      }
      const flying = s.relAlt > 0.5;
      const man = this.manual;
      if (man.active && s.armed) {
        // direct stick → vehicle response
        s.roll = lerp(s.roll, man.roll * 30, 0.25);
        s.pitch = lerp(s.pitch, -man.pitch * 20, 0.25);
        s.heading = (s.heading + man.yaw * 2.6 + 360) % 360;
        s.vspeed = man.throttle * 2.2;
        s.relAlt = clamp(s.relAlt + s.vspeed * 0.1, 0, 80);
        // translate over ground: pitch = forward, roll = lateral
        const fwd = -man.pitch,
          lat = man.roll;
        s.groundspeed = Math.min(this.track.maxSpeed * 1.6, Math.hypot(fwd, lat) * 6);
        const hd = s.heading * Math.PI / 180;
        const step = 1.0e-5;
        s.lat += (Math.cos(hd) * fwd - Math.sin(hd) * lat) * step;
        s.lon += (Math.sin(hd) * fwd + Math.cos(hd) * lat) * step / Math.cos(HOME.lat * Math.PI / 180);
      } else {
        // gentle attitude motion when flying (autonomous)
        s.roll = flying ? Math.sin(this.t * 0.6) * 7 + (this.track.state === 'locked' ? Math.sin(this.t * 1.7) * 3 : 0) : lerp(s.roll, 0, 0.1);
        s.pitch = flying ? Math.cos(this.t * 0.5) * 4 : lerp(s.pitch, 0, 0.1);
        s.heading = (s.heading + (flying ? 0.25 + (this.track.state === 'locked' ? 0.5 : 0) : 0)) % 360;
        s.groundspeed = flying ? clamp(1.2 + Math.sin(this.t * 0.4) * 0.8 + (this.track.state === 'locked' ? 1.2 : 0), 0, this.track.maxSpeed) : lerp(s.groundspeed, 0, 0.2);
        s.vspeed = s.phase === 'takeoff' ? 1.4 : s.phase === 'landing' ? -0.8 : flying ? Math.sin(this.t * 0.9) * 0.3 : 0;
        // drift position while flying
        if (flying && s.phase === 'flying') {
          s.lat += Math.cos(s.heading * Math.PI / 180) * 1.2e-6;
          s.lon += Math.sin(s.heading * Math.PI / 180) * 1.2e-6;
        }
      }
      // battery drain
      const draw = s.armed ? flying ? 18 + s.groundspeed * 1.5 : 6 : 0.4;
      s.current = lerp(s.current, draw, 0.1);
      s.battery = clamp(s.battery - (s.armed ? 0.0065 + s.groundspeed * 0.0008 : 0), 0, 100);
      s.voltage = lerp(s.voltage, 14.0 + s.battery / 100 * 2.8, 0.05);
      // link jitter
      s.rssi = Math.round(clamp(-48 + Math.sin(this.t * 0.3) * 6 - (flying ? 4 : 0), -95, -40));
      s.latency = Math.round(clamp(38 + Math.sin(this.t * 0.7) * 12 + (flying ? 8 : 0), 20, 120));

      // distance to home (haversine-ish, small scale)
      const dLat = (s.lat - HOME.lat) * 111320;
      const dLon = (s.lon - HOME.lon) * 111320 * Math.cos(HOME.lat * Math.PI / 180);
      const homeDist = Math.sqrt(dLat * dLat + dLon * dLon);

      // battery warnings
      const b = Math.round(s.battery);
      if (b === 30 && !this._warn30) {
        this._warn30 = true;
        this.log('warning', 'Battery 30% — consider RTL');
      }
      if (b === 15 && !this._warn15) {
        this._warn15 = true;
        this.log('critical', 'Battery 15% — failsafe imminent');
      }
      this._emit('tel', {
        type: 'telemetry',
        ts: now(),
        armed: s.armed,
        mode: s.mode,
        attitude: {
          roll: s.roll,
          pitch: s.pitch,
          yaw: s.heading
        },
        position: {
          lat: s.lat,
          lon: s.lon,
          relAlt: s.relAlt,
          absAlt: s.relAlt + 32
        },
        velocity: {
          groundspeed: s.groundspeed,
          verticalSpeed: s.vspeed
        },
        heading: s.heading,
        battery: {
          voltage: s.voltage,
          current: s.current,
          remaining: s.battery
        },
        gps: {
          fixType: s.fix,
          satellites: s.sats,
          hdop: s.hdop
        },
        home: {
          lat: HOME.lat,
          lon: HOME.lon,
          distance: homeDist
        },
        link: {
          rssi: s.rssi,
          latencyMs: s.latency
        }
      });
    }
    stepTracking() {
      const tr = this.track;
      // move people
      this.people.forEach(p => {
        p.x += p.vx;
        if (p.x < 0.12 || p.x > 0.88) p.vx *= -1;
        p.y = 0.56 + Math.sin(this.t * 0.5 + p.id) * 0.03;
        p.conf = clamp(0.78 + Math.sin(this.t * 1.3 + p.id) * 0.18, 0.5, 0.99);
      });

      // state machine
      if (tr.state === 'searching') {
        if (!this._searchT) this._searchT = this.t;
        if (this.t - this._searchT > 1.4) {
          tr.state = 'locked';
          if (tr.lockedTargetId == null) tr.lockedTargetId = this.people[0].id;
          tr.estimatedDistance = 9.5;
          this._searchT = 0;
          this.log('info', `Target lock acquired — #${tr.lockedTargetId}`);
        }
      } else if (tr.state === 'locked') {
        tr.estimatedDistance = lerp(tr.estimatedDistance ?? tr.standoff, tr.standoff, 0.04) + Math.sin(this.t * 1.1) * 0.06;
        // occasional lost
        this._lostTimer += 0.12;
        if (this._lostTimer > 22 && Math.random() < 0.01) {
          tr.state = 'lost';
          this._lostTimer = 0;
          this.log('warning', 'Tracking lock lost — re-acquiring');
        }
      } else if (tr.state === 'lost') {
        if (!this._lostStart) this._lostStart = this.t;
        if (this.t - this._lostStart > 1.8) {
          tr.state = 'locked';
          this._lostStart = 0;
          this.log('info', 'Target re-acquired');
        }
      }
      tr.targets = this.people.map(p => ({
        id: p.id,
        bbox: [p.x - p.w / 2, p.y - p.h / 2, p.w, p.h],
        confidence: p.conf,
        isLocked: tr.state === 'locked' && p.id === tr.lockedTargetId
      }));
      this._emit('trk', {
        type: 'tracking',
        ts: now(),
        state: tr.state,
        targets: tr.targets,
        lockedTargetId: tr.lockedTargetId,
        standoffDistance: tr.standoff,
        estimatedDistance: tr.state === 'locked' ? tr.estimatedDistance : null,
        maxSpeed: tr.maxSpeed
      });
    }
    ambientLog() {
      const msgs = [['info', 'GCS heartbeat OK'], ['info', `Satellites: ${this.s.sats} · HDOP ${this.s.hdop.toFixed(1)}`], ['info', 'EKF variance nominal'], ['info', `Link RSSI ${Math.round(this.s.rssi)} dBm`]];
      const m = msgs[Math.floor(Math.random() * msgs.length)];
      this.log(m[0], m[1]);
    }
  }
  window.EISMock = new Mock();
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/ground-control/mock.js", error: String((e && e.message) || e) }); }

__ds_ns.Badge = __ds_scope.Badge;

__ds_ns.Button = __ds_scope.Button;

__ds_ns.GaugeReadout = __ds_scope.GaugeReadout;

__ds_ns.HoldButton = __ds_scope.HoldButton;

__ds_ns.IconButton = __ds_scope.IconButton;

__ds_ns.Modal = __ds_scope.Modal;

__ds_ns.Panel = __ds_scope.Panel;

__ds_ns.Slider = __ds_scope.Slider;

__ds_ns.StatusPill = __ds_scope.StatusPill;

__ds_ns.Tabs = __ds_scope.Tabs;

__ds_ns.Toast = __ds_scope.Toast;

__ds_ns.Toggle = __ds_scope.Toggle;

__ds_ns.AttitudeIndicator = __ds_scope.AttitudeIndicator;

__ds_ns.BatteryGauge = __ds_scope.BatteryGauge;

__ds_ns.Compass = __ds_scope.Compass;

__ds_ns.SignalGauge = __ds_scope.SignalGauge;

})();
