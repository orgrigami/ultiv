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
- **The live cast on top of the browser** (the takeover's streaming view,
  Nov 2026): the cast is a thread of the browser broker (one python3
  process beside chromium, stdlib only), streaming a JPEG frame only when
  the view repaints — a static page sends nothing after it settles. Not yet
  measured: the cast's own memory/CPU overhead and per-frame sizes under
  real pages. Casts are bounded by construction: one per session while
  someone watches or drives, wound down when the last viewer leaves.
- **One shared browser, many bots (the broker, Nov 2026)**: a home VM runs
  ONE chromium; each browsing bot adds a context and one tab (plus at most 3
  popups), not a browser. NOT YET MEASURED: the per-tab cost under real
  pages and how many bots browsing at once a 512 MiB VM holds — measure it
  (several bots, real sign-in pages, popups) before choosing a per-home cap
  on concurrent browsing bots. Until then, keep browser-heavy bots spread
  across homes, and remember the idle window (10 min) and the task-end
  close keep forgotten tabs from piling up.

## Reading

- A 1 CPU / 512 MiB VM idles at ~60 MiB host memory and boots in under a
  second, so an org plus a handful of teams (the phase 4 model: one VM
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
- The numbers above were measured on the all-root image. Per-bot Linux
  users and hidepid now run in every VM (the opt-in real-VM suite checks
  them), but the capacity numbers were not measured again with them.
- The shared-folder caps (Phase 4 fix 2) add work to every sandboxed `bash`
  call: a host-side walk of each capped store before and after the call
  (it stops once past the cap, so the cost grows with the file count up to
  the cap), and the post-call group handover runs one `find` per writable
  shared folder. Neither was timed under load.

## Slice 4 follow-up (VM size), 1 November 2026

Re-probed with real VMs for the slice 4 limits (throwaway VMs, deleted
after): a VM created with 256 MiB reads ~229 MiB `MemTotal` in the guest
(kernel overhead takes the rest); a Python process allocating ~1 GiB inside
it is OOM-killed (the exec fails, the process is gone, the VM survives and
serves the next command); a 1-CPU VM reports `nproc` 1 and runs four
concurrent busy loops in 0.73 s against 0.19 s for one — a 3.84× ratio, so
the CPU cap holds under contention; `cpus: 2` reads `nproc` 2. Four VMs
sized 512/256/512/1024 MiB booted in parallel in ~240 ms and each completed
a load round. These numbers set the slice 4 bounds (1–8 CPUs, 128–8192 MiB
per VM) and the host-capacity rule (all homes' CONFIGURED VM memory ≤ half
the host's RAM — a configured-sum heuristic, not a live measurement;
docs/SECURITY.md).

## Slice 9 follow-up (chromium in the image), 1 November 2026

The sandbox image now carries the headless browser permanently: `chromium`
plus `fonts-liberation` joined `packages/ext/sandbox/Dockerfile`, the image
was rebuilt (`docker build -t ultiv-sandbox:latest packages/ext/sandbox`)
and loaded again into the runtime's image store (`docker save` +
`vp -C packages/ext exec msb load -i … -t ultiv-sandbox:latest`). The image
grew from 579 MB to 1.56 GB of disk (the browser adds roughly +1 GB, more
than slice 1's ~0.5 GB estimate from the throwaway apt install); idle RAM
cost is unchanged (none until a page runs). A fresh machine must run the
same one-time build + `msb load` before `browser_open` works — the tool
refuses with an owner-worded message when the image has no chromium and
never apt-installs at call time. RUNNING VMs keep the old image until they
are recreated (an allowlist or size edit does that at the next start), so
an existing install shows the new tool failing with the rebuild message
until each home's VM is recreated once.
