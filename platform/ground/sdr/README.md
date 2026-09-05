# DNHacks receive-only SDR sidecar

The SDR sidecar publishes newline-delimited JSON on stdout. It is intentionally
receive-only: live backends open RX streams and expose no transmit operation.
Electron owns the process and forwards each decoded message to the renderer.

The default path is deterministic and offline:

```powershell
$env:SDR = "scripted"
companion\.venv\Scripts\python.exe -m ground.sdr.sidecar
```

`SDR_SCRIPT=nominal|floor_rise|narrowband|saturated` chooses the scripted
scenario. Interference scenarios start after `SDR_SCRIPT_EVENT_AFTER_S` (65 s
by default) so the 60-second rolling baseline can warm. Set `SDR=live` to try
SoapySDR first and pyrtlsdr second. Missing hardware produces a `healthEvent`
with state `no_device`; it never blocks the rest of the demo.

The first rail is GPS L1 at 1575.42 MHz, sampled at 2.4 MHz. Every one-second
capture uses a 4096-point Hann-window FFT. The detector emits
`gnss_interference` when the rolling-baseline floor rises at least 6 dB for two
seconds or a spectral bin within ±1 MHz of L1 rises at least 15 dB.

Run the offline tests with:

```powershell
companion\.venv\Scripts\python.exe -m pytest ground/sdr/tests -q
```
