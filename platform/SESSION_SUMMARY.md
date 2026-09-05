# Session summary / work log

A running log of notable Claude Code sessions on this repo. Newest first.

---

## `CLAUDE.md` initialization and Windows-to-Linux GCS port

### 1. Repo onboarding (`/init`)
Analyzed the monorepo and wrote **`CLAUDE.md`** — orientation + non-obvious gotchas
for future sessions (the three subsystems + shared contract, the `engageManual`
naming alias, the Mock↔Live one-line swap, Windows/PowerShell command notes, the
Python-3.14-vs-`numpy==1.26.4` trap, electron-builder code-sign skip, the config
safety floor, and which root dirs are design-system reference only).

### 2. Windows → Linux ground-station port
**Goal:** "move the existing Windows version to a subfolder and make a parallel
Linux version," driven by **`LINUX_PRD.md`** + the full-system **`claude-code-prd(1).md`**.

**Key reframe from reading the PRDs:** `LINUX_PRD.md` is a **port delta, not a fork**.
Only the Electron shell + packaging are OS-specific; the React renderer
(`ground/ui`), `companion/`, and `sim/` are shared / out of scope. A whole-repo
duplication would have contradicted the brief.

**Approved layout** (split `ground/app` by OS; renderer stays shared):

```
ground/
├─ ui/                 # SHARED renderer — unchanged
└─ app/
   ├─ windows/         # original shell, moved verbatim (NSIS, .ico)
   └─ linux/           # new parallel shell (AppImage/.deb/.rpm, XDG, udev, power-inhibit)
```

**Work done, in order:**
1. **`PORT_AUDIT.md`** (PRD §0, mandatory first). Audited Electron main/preload/IPC
   + the renderer seam → **source is already cross-platform-clean** (`app.getPath`,
   `process.platform` guards; no `%APPDATA%`/registry/COM/DirectShow). Coupling was
   confined to packaging + the PowerShell bootstrap.
2. **Moved** `ground/app/*` → `ground/app/windows/`, and fixed the relative paths
   that descended a level (`../ui`→`../../ui`; `.env`/UI-dist depths in `main.ts`).
3. **Created `ground/app/linux/`** — shared `src/` + Linux additions:
   `electron-builder.yml` (AppImage/.deb/.rpm + GTK/libnotify/nss/xss/alsa deps),
   `.desktop` (app-id `com.dnhacks.platform.gcs`), gamepad **udev rule** +
   `post(install|remove).sh`, placeholder `icon.png` + `make-icons.sh`, and a
   **`powerSaveBlocker`** inhibit IPC (PRD §7).
4. **Two safety features in the SHARED renderer** (surfaced in PORT_AUDIT per §1,
   implemented once so both OSes benefit, both Windows-safe via optional chaining):
   - controller-disconnect → position-hold failsafe in `panels/ManualControl.tsx`
     (PRD §5; placed in the gamepad owner rather than `LiveDataProvider` — noted);
   - power-inhibit effect in `App.tsx` + optional `power` on the `ElectronBridge`
     type (`vite-env.d.ts`).
5. **Plumbing & docs:** `setup-ground.ps1` retargeted to `ground/app/windows`; new
   `scripts/setup-ground-linux.sh`; `Makefile`/`justfile` gained
   `setup-ground-linux` / `build-ground-linux` / `package-linux`; updated root
   `README.md`, `CLAUDE.md`, and the moved Windows `README.md`.

**Verified ✅:** typecheck clean for the shared UI, the Windows shell, **and** the
Linux shell (via a temporary `node_modules` junction — types are platform-agnostic).
Windows `dist-electron` recompiled so the shell stays runnable.

**Not verified ⚠️ (no Linux host on this box):** the actual AppImage/.deb/.rpm
build, gamepad enumeration, and Wayland/X11 behavior; the real icon needs
`make-icons.sh` (committed PNG is a placeholder). Full residual-QA list lives in
`PORT_AUDIT.md`.

**Maintenance note:** per the chosen per-OS split, the two `app/*/src/` trees are
near-duplicates — keep them in sync for shared changes (flagged in the READMEs +
`CLAUDE.md`). Lighter alternative if the duplication chafes: one shell with a
multi-target electron-builder.

#### File inventory
- **New:** `CLAUDE.md`, `PORT_AUDIT.md`, `SESSION_SUMMARY.md`,
  `scripts/setup-ground-linux.sh`, all of `ground/app/linux/**`.
- **Moved:** `ground/app/*` → `ground/app/windows/*` (paths fixed).
- **Modified:** `ground/ui/src/App.tsx`, `ground/ui/src/panels/ManualControl.tsx`,
  `ground/ui/src/vite-env.d.ts`, `scripts/setup-ground.ps1`, `Makefile`, `justfile`,
  `README.md`, `ground/app/windows/README.md`.
- **Pre-existing input (authored by the user before the session):** `LINUX_PRD.md`.
