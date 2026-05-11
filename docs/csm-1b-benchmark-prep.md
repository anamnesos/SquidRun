# CSM-1B local benchmark — prep spec

Scope (ARCH #46): smallest safe path to benchmark public Sesame CSM-1B on
James's RTX 5090. No architecture rewrite, no MemGPT, no 32B brain. Capture
prerequisites, access gate, command surface, metrics, failure modes.

## Hardware / driver readiness — VERIFIED on this machine

| check | value | status |
| --- | --- | --- |
| GPU | NVIDIA GeForce RTX 5090, 32607 MiB | OK |
| Compute capability | 12.0 (Blackwell, sm_120) | OK |
| NVIDIA driver | 596.21 | OK (>> 555 required for sm_120) |
| CUDA runtime in torch | 12.8 | OK |
| PyTorch | 2.11.0+cu128 | OK — cuda_available True, device 0 recognized as RTX 5090 |
| Free disk | 1.4 TB | OK (model is ~2.7 GB) |
| Python | 3.14.0 at C:\Python314 | works for torch; see "wheel risk" below |
| pip | 25.2 | OK |

## Software gap (missing on this box)

Python deps to add for the bench, in order of importance:
- `transformers>=4.49` — CSM model class shipped in transformers 4.49+. Verify
  the wheel exists for Python 3.14 before committing; if not, fall back to
  `py -3.12 -m venv` for the bench env (3.12 has full wheel coverage).
- `huggingface_hub>=0.26` — for gated download + token auth.
- `torchaudio>=2.6` — only needed if writing/loading reference audio; CSM
  itself decodes through Mimi, not torchaudio.
- `moshi` (Kyutai) — provides the Mimi RVQ codec for decoding CSM's audio
  tokens to PCM. Wheel availability on Python 3.14 is the biggest risk
  factor; falling back to 3.12 is the safe default if `pip install moshi`
  errors.
- `soundfile` — WAV writes (optional for dry runs).
- `psutil` — CPU/RAM sampling.

Single install line (after deciding 3.14 vs 3.12 venv):
```
pip install "transformers>=4.49" "huggingface_hub>=0.26" "moshi" soundfile psutil
```
(torch is already in place at 2.11.0+cu128; do NOT reinstall — risk of
clobbering the Blackwell-capable build.)

## Access gate — BLOCKER, needs James

1. CSM-1B repo (`sesame/csm-1b`) is GATED on Hugging Face. Steps James must
   do once:
   - Log in at https://huggingface.co with his account.
   - Visit https://huggingface.co/sesame/csm-1b.
   - Click "Agree and access repository" — accepts Sesame's usage terms.
   - Confirms; the account now has read access to the weights.
2. Create an HF token with read scope at
   https://huggingface.co/settings/tokens — copy the token.
3. Add `HF_TOKEN=<token>` to `.env` at the repo root (dotenv already
   loaded by squidrun scripts; the bench script will pick it up the same
   way).

Without #1 the API returns `401 gated_repo`; without #2-3 it returns
`401 unauthenticated`. No way around this — both required before any
download can happen.

## Download size estimate

| artifact | size | source |
| --- | --- | --- |
| CSM-1B safetensors (1B params, fp16) | ~2.6 GB | sesame/csm-1b |
| Tokenizer + config + processor | <10 MB | sesame/csm-1b |
| Mimi codec weights | ~50-80 MB | kyutai/mimi |
| **cold pull total** | **~2.7 GB** | |

Cache lands in `~/.cache/huggingface/hub/` by default. To redirect, set
`HF_HOME=D:\projects\squidrun\workspace\models\hf` before invoking. Current
HF cache directories exist but are empty.

## Command surface — bench script (skeleton at ui/scripts/hm-csm-1b-bench.py)

Run shape (after deps + token are in place):
```
python ui/scripts/hm-csm-1b-bench.py --json --output workspace/bench/csm-1b/run-<ts>.json
```
or, for a smoke that does NOT write WAVs (cheap):
```
python ui/scripts/hm-csm-1b-bench.py --no-audio-write --json
```

Behavior:
1. Print env audit (torch / cuda / driver / device / VRAM).
2. Auth check (HF token present; gated_repo dry-probe).
3. Load CSM-1B (cold-load time captured).
4. Load Mimi codec (cold-load time captured).
5. Run a fixed prompt suite (3 lengths: ~20 / ~80 / ~250 chars). 3 trials each.
6. Optionally write WAV per trial; default no, to keep dry runs trivial.
7. Emit a JSON report and an exit code (0 = all trials succeeded; non-zero
   on failure with reason_class).

## Metrics captured per trial

| metric | source | why |
| --- | --- | --- |
| `prompt_chars` | input | normalise by length |
| `cold_load_ms` | wall around `from_pretrained` | first-use latency James actually feels |
| `ttft_ms` | wall from `generate()` to first audio chunk emitted | conversational responsiveness — the metric that decides if Mira can hold real-time turn-taking |
| `wall_ms` | total `generate()` wall | end-to-end |
| `audio_seconds` | output frames / 24000 | Mimi sample rate is 24 kHz |
| `rtf` | `wall_ms / (audio_seconds * 1000)` | < 1.0 means faster than realtime; required for live conversation |
| `tokens_per_second` | output token count / wall | useful for tracking degradation across runs |
| `vram_peak_gb` | `torch.cuda.max_memory_allocated()` reset per trial | sizing headroom on the 5090; informs whether 8B would fit later |
| `vram_steady_gb` | `torch.cuda.memory_allocated()` between trials | what the model holds resident |
| `rss_delta_mb` | psutil before/after | host-side memory cost |
| `cpu_percent_max` | psutil sampled during gen | CPU-bound vs GPU-bound |
| `gpu_util_max` | nvidia-smi sample / pynvml if available | confirms kernels actually executing on the GPU |
| `determinism_hash` | first 16 chars of sha256 over output tokens (greedy run only) | sanity for repeated greedy runs |

## Failure modes to expect

| mode | signal | mitigation in bench |
| --- | --- | --- |
| HF gated_repo (401) | exception at `from_pretrained` | bench dry-probes, returns clean blocker before any download |
| Token missing | exception | bench checks env vars before any network call |
| `moshi` wheel missing on 3.14 | `pip install moshi` fails | spec recommends falling back to Python 3.12 venv |
| Blackwell kernel mismatch | "no kernel image" at first matmul | already ruled out — torch 2.11 + cu128 verified working with sm_120 device |
| OOM on long generations | `torch.cuda.OutOfMemoryError` | unlikely (5090 has 32 GB, CSM-1B fp16 fits in ~3-4 GB); bench captures peak |
| Silent / garbled audio | RTF > 5, audio_seconds suspiciously low, listening confirms | likely Mimi codec version mismatch with CSM weights; spec pins versions before running |
| RTF > 1 (slower than realtime) | live conversation impossible | inform Architect/Oracle; informs whether CSM-1B is viable for Mira's voice path on the 5090 — that IS the question this bench answers |
| Refusal-shaped empty token stream | `audio_seconds == 0`, tokens_per_second == 0 | bench classifies as `empty_audio_token_stream` and writes prompt for review |
| TTFT > 500 ms | turn-taking feels laggy | report as `ttft_above_real_time_threshold` |

## What's pre-decided / NOT in scope here

- Whether to integrate CSM-1B into Mira's voice path (downstream decision; needs the bench numbers first).
- Whether to pursue the larger CSM-8B / Medium model (Oracle confirmed NOT publicly downloadable — out of scope).
- Streaming integration (CSM supports token-by-token decode; if bench shows
  RTF < 1, the next lane spec covers streaming wiring).
- Voice cloning with reference audio (CSM supports a few-second reference;
  not in the smallest-safe-path bench).

## Smallest safe path checklist (in order)

1. James accepts terms at https://huggingface.co/sesame/csm-1b. (manual)
2. James adds `HF_TOKEN=<read-scope>` to `.env`. (manual)
3. Decide Python 3.14 vs Python 3.12 venv:
   - Try `pip install moshi transformers huggingface_hub psutil soundfile` on 3.14 first.
   - If `moshi` errors, `py -3.12 -m venv .venv-csm` and install there.
4. Run `python ui/scripts/hm-csm-1b-bench.py --auth-check` (no download yet — just verifies gated access).
5. Run `python ui/scripts/hm-csm-1b-bench.py --no-audio-write --json` (downloads weights, runs 3-prompt suite, prints metrics).
6. Inspect the JSON report under `workspace/bench/csm-1b/`. Report RTF and
   TTFT back to Architect/Oracle so they can decide the voice-path call.

Step 1-2 are the blocker. Everything from step 3 onward is mechanical and
takes <10 minutes wall time on this hardware once gated access is in place.
