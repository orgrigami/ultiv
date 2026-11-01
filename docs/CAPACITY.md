# Capacity: how many VMs one host holds (phase 4, slice 1)

Measured on the owner's machine, 1 November 2026, with microsandbox 0.7.11
and the `ultiv-sandbox:latest` image (built from `packages/ext/sandbox/Dockerfile`).
Throwaway VMs named `ultiv-capacity-*`, deleted after the run; the probe lived
in `packages/ext/var/probe/` and is not committed.

## Host

- Apple M4 (arm64), macOS 27.0.1, 16 GB RAM, 10 CPU cores.
- Apple virtualization (the path `GET /api/server/check` reports as available).
- The image was already loaded (`msb load` had been run on this machine).

## Numbers

- **Boot**: 200–560 ms per VM to first exec (`connectOrCreate` + one command).
- **Eight 1-CPU / 512 MiB VMs at once**, each running a concurrent load round
  (a Python sum over 2M terms plus 30 file writes):
  - host-resident memory **47–59 MiB per VM** (guest `used` 46–57 MiB of the
    512 MiB limit), **~400 MiB total**;
  - every load round finished in 100–220 ms; no VM failed or throttled.
- **Headless browser in one VM**: Debian's `chromium` installed from apt
  (`--no-install-recommends`, ~5.4 min, the bulk of the image's disk) and ran
  `--headless --no-sandbox --disable-dev-shm-usage --screenshot=…` against a
  `data:` URL **inside the 512 MiB limit**, writing the screenshot. Host RSS
  peaked around 410 MiB for that VM (page cache from the install included).
  The dbus errors on stderr are headless noise and do not affect the shot.

## Reading

- A 1 CPU / 512 MiB VM idles at ~60 MiB host memory and boots in under a
  second, so an org plus a handful of departments (the phase 4 model: one VM
  per home) is far inside this host's capacity. The 16 GB host could hold
  dozens of idle VMs; memory only binds when VMs run browsers or heavy jobs
  at their cap.
- The defaults (1 CPU, 512 MiB) are workable **and** fit a read-only
  headless-browser slice (slice 9) inside one VM.

## What was not tested

- No sustained or memory-pressure load: nothing drove a VM to its 512 MiB
  cap for long, and the browser ran one page, not many tabs or under
  concurrent VM load.
- The VM count was not pushed to a failure point; 8 concurrent is what was
  measured, not a limit.
- Disk usage over time (upper-layer growth) was not measured; the install
  showed an apt browser adds roughly half a GB to a VM's disk.
- Linux/KVM hosts were not tested — this machine is the only one available.
- Per-bot Linux users and hidepid (slice 2b) are not in this image yet, so
  the numbers above are for today's all-root image.
