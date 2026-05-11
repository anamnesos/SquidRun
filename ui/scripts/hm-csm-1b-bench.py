#!/usr/bin/env python
"""Sesame CSM-1B local benchmark (ARCH #46).

End-to-end runner: warm-load the model, run a fixed prompt suite,
capture latency / VRAM / RTF, optionally write a reference WAV.
All three deps (HF terms acceptance, HF_TOKEN in .env, transformers
+ huggingface_hub + moshi + soundfile + psutil) are verified live;
gate them through --auth-check before a full run if uncertain.

Surface:
  python ui/scripts/hm-csm-1b-bench.py --auth-check
  python ui/scripts/hm-csm-1b-bench.py --no-audio-write --json
  python ui/scripts/hm-csm-1b-bench.py --json --output workspace/bench/csm-1b/run-<ts>.json
  python ui/scripts/hm-csm-1b-bench.py --prompt "Hey James, the build is up." --out-wav workspace/bench/csm-1b/reference.wav
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Optional

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUTPUT_DIR = PROJECT_ROOT / "workspace" / "bench" / "csm-1b"


def _load_dotenv_safely(env_path: Path) -> dict:
    """Load repo-root `.env` into os.environ without ever printing values.

    Prefers python-dotenv when available; falls back to a tiny manual parser
    so the script also works on a fresh box without the optional dep.
    Existing process env wins over `.env` (so a real shell export overrides
    the file). Returns metadata describing what was loaded — keys only,
    never values, never token contents.
    """
    info = {"path": str(env_path), "exists": env_path.exists(), "loader": None, "keys_loaded": 0, "error": None}
    if not env_path.exists():
        return info
    try:
        from dotenv import load_dotenv  # type: ignore
        before = set(os.environ.keys())
        load_dotenv(env_path, override=False)
        info["loader"] = "python-dotenv"
        info["keys_loaded"] = len(set(os.environ.keys()) - before)
        return info
    except ImportError:
        pass
    try:
        added = 0
        for raw in env_path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip()
            if not key or key in os.environ:
                continue
            if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
                value = value[1:-1]
            os.environ[key] = value
            added += 1
        info["loader"] = "manual"
        info["keys_loaded"] = added
        return info
    except Exception as exc:  # noqa: BLE001
        info["error"] = f"{type(exc).__name__}"
        return info


def _self_test_dotenv_loader() -> int:
    """Regression seam: write a temp .env, load it, assert env set, clean up.

    Never prints values; only key + status. Exits 0 on pass, 1 on fail.
    """
    import tempfile

    sentinel_key = "__CSM_BENCH_SELF_TEST_KEY"
    sentinel_value = "loaded-ok"
    if sentinel_key in os.environ:
        del os.environ[sentinel_key]
    with tempfile.TemporaryDirectory() as tmp:
        env_file = Path(tmp) / ".env"
        env_file.write_text(
            f"# self-test\n{sentinel_key}={sentinel_value}\n# comment line\nEMPTY_KEY=\n",
            encoding="utf-8",
        )
        info = _load_dotenv_safely(env_file)
        loaded = os.environ.get(sentinel_key)
        ok = info["exists"] and info["loader"] is not None and loaded == sentinel_value
        print(json.dumps({
            "ok": ok,
            "loader": info["loader"],
            "keys_loaded": info["keys_loaded"],
            "sentinel_set": loaded is not None,
            "error": info.get("error"),
        }, indent=2))
        if sentinel_key in os.environ:
            del os.environ[sentinel_key]
    return 0 if ok else 1

# Fixed prompt suite: three lengths cover short turn-taking, mid utterance,
# and long monologue. Same prompts every run so RTF / TTFT comparisons are
# meaningful across versions.
PROMPT_SUITE = [
    ("short", "Hey, how are you?"),
    ("medium", "I'm trying to decide whether to ship the gate-recovery patch tonight or wait for Oracle to finish the audit pass."),
    ("long", "Walk me through the trade-off between running CSM-1B locally on the 5090 for Mira's voice path versus paying for hosted TTS. Cover latency, voice quality, ongoing cost, and the failure mode where the local model degrades silently on certain prompt shapes."),
]


@dataclass
class EnvAudit:
    python_version: str
    platform: str
    torch_version: Optional[str] = None
    torch_cuda: Optional[str] = None
    cuda_available: bool = False
    gpu_name: Optional[str] = None
    gpu_compute_capability: Optional[str] = None
    gpu_total_mem_gb: Optional[float] = None
    transformers_version: Optional[str] = None
    huggingface_hub_version: Optional[str] = None
    moshi_version: Optional[str] = None
    hf_token_present: bool = False


@dataclass
class TrialMetrics:
    label: str
    prompt_chars: int
    ttft_ms: Optional[float] = None
    wall_ms: Optional[float] = None
    audio_seconds: Optional[float] = None
    rtf: Optional[float] = None
    tokens_per_second: Optional[float] = None
    vram_peak_gb: Optional[float] = None
    vram_steady_gb: Optional[float] = None
    rss_delta_mb: Optional[float] = None
    cpu_percent_max: Optional[float] = None
    gpu_util_max: Optional[float] = None
    determinism_hash: Optional[str] = None
    error: Optional[str] = None


@dataclass
class BenchReport:
    schema: str = "squidrun.bench.csm_1b.v0"
    started_at: str = ""
    finished_at: str = ""
    env: EnvAudit = field(default_factory=lambda: EnvAudit(
        python_version=platform.python_version(),
        platform=platform.platform(),
    ))
    dotenv: dict = field(default_factory=dict)
    auth: dict = field(default_factory=dict)
    cold_load_ms: Optional[float] = None
    cache_present_before_load: Optional[bool] = None
    hf_cache_dir: Optional[str] = None
    reference_wav_path: Optional[str] = None
    trials: list[TrialMetrics] = field(default_factory=list)
    summary: dict = field(default_factory=dict)
    blocker: Optional[str] = None


def audit_env(report: BenchReport) -> None:
    """Fill report.env with what's actually importable on this machine."""
    try:
        import torch
        report.env.torch_version = torch.__version__
        report.env.torch_cuda = torch.version.cuda
        report.env.cuda_available = bool(torch.cuda.is_available())
        if report.env.cuda_available:
            report.env.gpu_name = torch.cuda.get_device_name(0)
            cap = torch.cuda.get_device_capability(0)
            report.env.gpu_compute_capability = f"{cap[0]}.{cap[1]}"
            props = torch.cuda.get_device_properties(0)
            report.env.gpu_total_mem_gb = round(props.total_memory / 1e9, 2)
    except ImportError:
        pass
    for mod_name, attr in (
        ("transformers", "transformers_version"),
        ("huggingface_hub", "huggingface_hub_version"),
        ("moshi", "moshi_version"),
    ):
        try:
            mod = __import__(mod_name)
            setattr(report.env, attr, getattr(mod, "__version__", "unknown"))
        except ImportError:
            pass
    report.env.hf_token_present = bool(
        os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    )


def auth_check(report: BenchReport) -> bool:
    """Dry-probe gated repo access. Returns True if we'd actually be allowed to download.

    metadata-vs-resolve split: HfApi.model_info works for any authenticated
    user on a gated repo, because public metadata is always visible. The
    real gate fires on file resolve. So this probe does BOTH: metadata
    fetch (catches missing/expired token) and a tiny file resolve on
    config.json (catches user-hasn't-clicked-accept-on-the-model-card).
    Previously the metadata-only check produced a false-positive when terms
    were unaccepted, masking the real blocker behind the cold-pull failure.
    """
    if not report.env.hf_token_present:
        report.blocker = "hf_token_missing"
        report.auth = {"ok": False, "reason": "HF_TOKEN / HUGGING_FACE_HUB_TOKEN not set"}
        return False
    try:
        from huggingface_hub import HfApi, hf_hub_download
        from huggingface_hub.errors import GatedRepoError  # type: ignore
    except ImportError:
        report.blocker = "huggingface_hub_not_installed"
        report.auth = {"ok": False, "reason": "huggingface_hub not importable"}
        return False
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    api = HfApi(token=token)
    try:
        info = api.model_info("sesame/csm-1b")
    except Exception as exc:  # noqa: BLE001
        msg = str(exc)
        if "401" in msg or "gated" in msg.lower():
            report.blocker = "hf_gated_repo_terms_not_accepted"
            report.auth = {"ok": False, "stage": "metadata", "reason": "Accept terms at https://huggingface.co/sesame/csm-1b", "raw": msg[:240]}
        else:
            report.blocker = "hf_auth_error"
            report.auth = {"ok": False, "stage": "metadata", "reason": "huggingface_hub error", "raw": msg[:240]}
        return False

    # Resolve-stage probe: this is what the actual download path hits.
    # config.json is tiny (kB) and identical to what from_pretrained needs
    # before it can decide whether to start the multi-GB pull.
    try:
        hf_hub_download("sesame/csm-1b", "config.json", token=token)
        resolve_ok = True
        resolve_reason = None
        resolve_raw = None
    except GatedRepoError as exc:  # noqa: BLE001
        resolve_ok = False
        resolve_reason = "Accept terms at https://huggingface.co/sesame/csm-1b (token is valid; user hasn't clicked accept on the model card)."
        resolve_raw = str(exc)[:240]
    except Exception as exc:  # noqa: BLE001
        resolve_ok = False
        resolve_reason = "hf_hub_download error"
        resolve_raw = f"{type(exc).__name__}: {str(exc)[:200]}"

    if not resolve_ok:
        report.blocker = "hf_gated_repo_terms_not_accepted"
        report.auth = {
            "ok": False,
            "stage": "resolve",
            "model_id": info.id,
            "gated": getattr(info, "gated", None),
            "reason": resolve_reason,
            "raw": resolve_raw,
        }
        return False

    report.auth = {
        "ok": True,
        "stage": "resolve",
        "model_id": info.id,
        "gated": getattr(info, "gated", None),
        "last_modified": str(getattr(info, "last_modified", "")),
    }
    return True


SAMPLE_RATE_HZ = 24000


def run_trial(label: str, prompt: str, model, processor, *, return_audio: bool = False):
    """Single generate trial via transformers-native CSM path (no direct moshi).

    Follows the Sesame model-card snippet: apply_chat_template with a
    conversation list, then model.generate(..., output_audio=True). The
    transformers integration handles Mimi decoding internally; we never
    import moshi here. Audio duration is derived from the returned tensor
    shape (sample rate 24 kHz per the CSM card).

    When return_audio=True, returns (metrics, audio_tensor_on_cpu_or_None).
    Otherwise returns just metrics.
    """
    import torch
    import psutil

    metrics = TrialMetrics(label=label, prompt_chars=len(prompt))
    proc = psutil.Process()
    torch.cuda.reset_peak_memory_stats()
    rss_before = proc.memory_info().rss

    conversation = [{"role": "0", "content": [{"type": "text", "text": prompt}]}]

    t0 = time.perf_counter()
    try:
        inputs = processor.apply_chat_template(
            conversation,
            tokenize=True,
            return_dict=True,
            return_tensors="pt",
        ).to(model.device)
        input_token_len = int(inputs["input_ids"].shape[-1]) if "input_ids" in inputs else None

        # output_audio=True asks the transformers CSM integration to
        # decode Mimi tokens to PCM internally. The result is an audio
        # tensor at 24 kHz. do_sample=False keeps the run deterministic
        # so determinism_hash is meaningful.
        with torch.inference_mode():
            output = model.generate(
                **inputs,
                output_audio=True,
                max_new_tokens=512,
                do_sample=False,
            )
        t_end = time.perf_counter()

        # output may be a tensor (audio waveform) or a tuple/object with
        # both tokens and audio depending on transformers version. Probe
        # defensively without forcing a shape.
        audio_tensor = output
        if hasattr(output, "audio"):
            audio_tensor = output.audio
        elif isinstance(output, (list, tuple)) and len(output) > 0:
            # Common shape: (audio_tensor,) or (tokens, audio_tensor).
            audio_tensor = output[-1]

        sample_rate = SAMPLE_RATE_HZ
        audio_len_samples = None
        if hasattr(audio_tensor, "shape") and audio_tensor.shape:
            audio_len_samples = int(audio_tensor.shape[-1])
        if audio_len_samples is not None:
            metrics.audio_seconds = audio_len_samples / sample_rate
        metrics.wall_ms = (t_end - t0) * 1000
        # TTFT in this loader is generate-call latency; transformers doesn't
        # surface a streaming first-frame timestamp without an extra hook.
        # Record wall_ms as the conservative ceiling and leave TTFT slot
        # alongside for clarity.
        metrics.ttft_ms = metrics.wall_ms
        if metrics.audio_seconds and metrics.audio_seconds > 0:
            metrics.rtf = metrics.wall_ms / (metrics.audio_seconds * 1000)
        if audio_len_samples and metrics.wall_ms and metrics.wall_ms > 0:
            # Audio samples per wall-second — useful as a steady-state
            # throughput proxy.
            metrics.tokens_per_second = audio_len_samples / (metrics.wall_ms / 1000)
        metrics.vram_peak_gb = torch.cuda.max_memory_allocated() / 1e9
        metrics.vram_steady_gb = torch.cuda.memory_allocated() / 1e9
        metrics.rss_delta_mb = (proc.memory_info().rss - rss_before) / 1e6
        metrics.cpu_percent_max = psutil.cpu_percent(interval=None)
        if hasattr(audio_tensor, "cpu"):
            try:
                wave_bytes = audio_tensor.cpu().detach().numpy().tobytes()
                metrics.determinism_hash = hashlib.sha256(wave_bytes).hexdigest()[:16]
            except Exception:  # noqa: BLE001
                metrics.determinism_hash = None
        if not metrics.audio_seconds or metrics.audio_seconds == 0:
            metrics.error = "empty_audio_token_stream"
        audio_cpu = None
        if return_audio and hasattr(audio_tensor, "cpu"):
            try:
                audio_cpu = audio_tensor.detach().cpu()
            except Exception:  # noqa: BLE001
                audio_cpu = None
        if return_audio:
            return metrics, audio_cpu
        return metrics
    except Exception as exc:  # noqa: BLE001
        msg = str(exc)
        cls = type(exc).__name__
        lowered = msg.lower()
        if "llama-3.2" in lowered or "llama-3.2-1b" in lowered or ("gated" in lowered and "llama" in lowered):
            metrics.error = f"blocked_dependent_gated_repo:llama-3.2:{cls}"
        elif "no module named" in lowered or isinstance(exc, ModuleNotFoundError):
            metrics.error = f"missing_package:{cls}:{msg[:160]}"
        else:
            metrics.error = f"{cls}: {msg[:240]}"
    if return_audio:
        return metrics, None
    return metrics


def summarize(report: BenchReport) -> None:
    successful = [t for t in report.trials if t.error is None]
    if not successful:
        report.summary = {"trial_count": len(report.trials), "successful": 0}
        return
    # Steady-state = drop run0 (cold per prompt), keep run1+. The reference
    # trial is special-cased: it's always a "warmup" against the just-loaded
    # model, so exclude it from steady-state aggregates too.
    steady = [t for t in successful if t.label.endswith((":run1", ":run2", ":run3", ":run4"))]
    pool = steady or successful

    def _avg(field_name: str) -> Optional[float]:
        values = [getattr(t, field_name) for t in pool if getattr(t, field_name) is not None]
        return round(sum(values) / len(values), 3) if values else None

    report.summary = {
        "trial_count": len(report.trials),
        "successful": len(successful),
        "steady_state_count": len(steady),
        "avg_ttft_ms": _avg("ttft_ms"),
        "avg_wall_ms": _avg("wall_ms"),
        "avg_rtf": _avg("rtf"),
        "avg_tokens_per_second": _avg("tokens_per_second"),
        "max_vram_peak_gb": round(max((t.vram_peak_gb or 0) for t in successful), 2),
        "max_rss_delta_mb": round(max((t.rss_delta_mb or 0) for t in successful), 1),
        "live_conversation_capable": all((t.rtf or 99) < 1.0 for t in pool),
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--auth-check", action="store_true", help="Dry-probe HF gated access; no download.")
    parser.add_argument("--no-audio-write", action="store_true", help="Skip WAV writes.")
    parser.add_argument("--json", action="store_true", help="Print the full JSON report to stdout.")
    parser.add_argument("--output", type=Path, default=None, help="Write JSON report to this path.")
    parser.add_argument("--self-test", action="store_true", help="Run the dotenv loader regression test and exit.")
    parser.add_argument("--prompt", type=str, default=None, help="Override reference prompt (default: 'Hey James, the build is up.').")
    parser.add_argument("--out-wav", type=Path, default=None, help="Write reference-run audio to this WAV path.")
    parser.add_argument("--runs-per-prompt", type=int, default=2, help="Total runs per prompt; first is warmup-tagged. Default 2.")
    parser.add_argument("--skip-suite", action="store_true", help="Run only the reference prompt; skip the short/medium/long suite.")
    args = parser.parse_args(argv)

    if args.self_test:
        return _self_test_dotenv_loader()

    report = BenchReport(started_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))

    # Load repo-root `.env` BEFORE env audit / auth check so HF_TOKEN
    # written to the file picks up automatically. Never print or log the
    # token; only keys-loaded counts and loader name survive into the report.
    report.dotenv = _load_dotenv_safely(PROJECT_ROOT / ".env")

    audit_env(report)

    if not auth_check(report):
        report.finished_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        _emit(report, args)
        # Exit code 3 = blocker (no download attempted).
        return 3
    if args.auth_check:
        report.finished_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        _emit(report, args)
        return 0

    # Cold-pull detection: check the HF hub cache before the first
    # from_pretrained call so cold_load_ms can be interpreted as either
    # full download + load (cache_present_before_load=False) or warm
    # in-place load (True).
    hf_home = Path(os.environ.get("HF_HOME") or os.environ.get("HUGGINGFACE_HUB_CACHE") or (Path.home() / ".cache" / "huggingface"))
    model_cache_dir = hf_home / "hub" / "models--sesame--csm-1b"
    report.hf_cache_dir = str(hf_home)
    report.cache_present_before_load = model_cache_dir.exists()

    try:
        import torch
        from transformers import AutoProcessor, CsmForConditionalGeneration
    except ImportError as exc:
        report.blocker = f"transformers_import_failed:{type(exc).__name__}:{str(exc)[:160]}"
        report.finished_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        _emit(report, args)
        return 5

    # huggingface_hub 0.36 reads HF_TOKEN from env, but transformers'
    # from_pretrained doesn't automatically forward it on every version.
    # Pass explicitly so the gated-repo download works regardless.
    hf_token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    t_load = time.perf_counter()
    try:
        processor = AutoProcessor.from_pretrained("sesame/csm-1b", token=hf_token)
        model = CsmForConditionalGeneration.from_pretrained(
            "sesame/csm-1b",
            torch_dtype="auto",
            device_map="cuda:0",
            token=hf_token,
        )
    except Exception as exc:  # noqa: BLE001
        cls = type(exc).__name__
        msg = str(exc)
        report.blocker = f"model_load_failed:{cls}:{msg[:200]}"
        report.cold_load_ms = (time.perf_counter() - t_load) * 1000
        report.finished_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        _emit(report, args)
        return 6
    report.cold_load_ms = (time.perf_counter() - t_load) * 1000

    runs_per_prompt = max(1, int(args.runs_per_prompt or 1))

    # Reference run — always first, writes WAV (unless --no-audio-write).
    ref_prompt = args.prompt or "Hey James, the build is up."
    ref_metrics, ref_audio = run_trial("reference", ref_prompt, model, processor, return_audio=True)
    ref_metrics.label = "reference:run0"
    report.trials.append(ref_metrics)

    # Optional WAV write of the reference run.
    if not args.no_audio_write and ref_audio is not None and ref_metrics.error is None:
        wav_path = args.out_wav or (DEFAULT_OUTPUT_DIR / f"reference-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}.wav")
        try:
            import soundfile as sf
            wav_path.parent.mkdir(parents=True, exist_ok=True)
            arr = ref_audio.numpy()
            # CSM audio tensors land as (1, T) or (B, 1, T); squeeze to (T,)
            # mono for soundfile.write.
            while arr.ndim > 1 and arr.shape[0] == 1:
                arr = arr[0]
            sf.write(str(wav_path), arr, SAMPLE_RATE_HZ)
            report.reference_wav_path = str(wav_path)
        except Exception as exc:  # noqa: BLE001
            report.reference_wav_path = f"write_failed:{type(exc).__name__}:{str(exc)[:160]}"

    # Suite runs — short / medium / long, runs_per_prompt times each.
    if not args.skip_suite:
        for label, prompt in PROMPT_SUITE:
            for run_idx in range(runs_per_prompt):
                trial_label = f"{label}:run{run_idx}"
                metrics = run_trial(trial_label, prompt, model, processor)
                report.trials.append(metrics)

    summarize(report)
    report.finished_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    _emit(report, args)
    return 0 if not report.blocker and any(t.error is None for t in report.trials) else 7


def _emit(report: BenchReport, args: argparse.Namespace) -> None:
    blob = json.dumps(_to_jsonable(report), indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(blob, encoding="utf-8")
    if args.json or not args.output:
        print(blob)


def _to_jsonable(obj):
    if hasattr(obj, "__dataclass_fields__"):
        return {k: _to_jsonable(v) for k, v in asdict(obj).items()}
    if isinstance(obj, dict):
        return {k: _to_jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_to_jsonable(v) for v in obj]
    return obj


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
