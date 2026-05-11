#!/usr/bin/env python
"""Sesame CSM-1B local benchmark — smallest safe path (ARCH #46).

Status: SKELETON. Does not run end-to-end until:
  1. James accepts terms at https://huggingface.co/sesame/csm-1b.
  2. HF_TOKEN is exported (or in .env at repo root).
  3. `pip install transformers>=4.49 huggingface_hub>=0.26 moshi soundfile psutil`.

Hardware/torch already verified on this box: torch 2.11.0+cu128 with
Blackwell sm_120 support on an RTX 5090; see workspace/specs/csm-1b-benchmark-prep.md.

Surface:
  python ui/scripts/hm-csm-1b-bench.py --auth-check
  python ui/scripts/hm-csm-1b-bench.py --no-audio-write --json
  python ui/scripts/hm-csm-1b-bench.py --json --output workspace/bench/csm-1b/run-<ts>.json
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
    """Dry-probe gated repo access. Returns True if we'd be allowed to download."""
    if not report.env.hf_token_present:
        report.blocker = "hf_token_missing"
        report.auth = {"ok": False, "reason": "HF_TOKEN / HUGGING_FACE_HUB_TOKEN not set"}
        return False
    try:
        from huggingface_hub import HfApi
    except ImportError:
        report.blocker = "huggingface_hub_not_installed"
        report.auth = {"ok": False, "reason": "huggingface_hub not importable"}
        return False
    api = HfApi(token=os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN"))
    try:
        info = api.model_info("sesame/csm-1b")
        report.auth = {
            "ok": True,
            "model_id": info.id,
            "gated": getattr(info, "gated", None),
            "last_modified": str(getattr(info, "last_modified", "")),
        }
        return True
    except Exception as exc:  # noqa: BLE001
        msg = str(exc)
        if "401" in msg or "gated" in msg.lower():
            report.blocker = "hf_gated_repo_terms_not_accepted"
            report.auth = {"ok": False, "reason": "Accept terms at https://huggingface.co/sesame/csm-1b", "raw": msg[:240]}
        else:
            report.blocker = "hf_auth_error"
            report.auth = {"ok": False, "reason": "huggingface_hub error", "raw": msg[:240]}
        return False


def run_trial(label: str, prompt: str, model, processor, mimi) -> TrialMetrics:
    """Single generate-and-decode trial. Captures latency + resource metrics."""
    import torch
    import psutil

    metrics = TrialMetrics(label=label, prompt_chars=len(prompt))
    proc = psutil.Process()
    torch.cuda.reset_peak_memory_stats()
    rss_before = proc.memory_info().rss
    cpu_samples: list[float] = []

    t0 = time.perf_counter()
    try:
        # CSM uses a conversation-shaped processor input: the official model
        # card on sesame/csm-1b passes a `conversation` list with role/content
        # pairs rather than raw text. Concretely:
        #   conv = [{"role": "0", "content": [{"type": "text", "text": prompt}]}]
        #   inputs = processor.apply_chat_template(conv, tokenize=True,
        #                                          return_dict=True,
        #                                          return_tensors="pt").to(model.device)
        # The runner author should follow the model-card snippet rather than
        # this `processor(text=...)` shortcut, which the CSM AutoProcessor
        # may not accept.
        inputs = processor(text=prompt, return_tensors="pt").to(model.device)
        # CsmForConditionalGeneration.generate emits Mimi RVQ audio tokens.
        # Greedy (do_sample=False) lets determinism_hash mean something; the
        # exploratory pass should re-run with do_sample=True, temperature=0.8
        # to measure variety + RTF under sampling load.
        with torch.inference_mode():
            output_tokens = model.generate(**inputs, max_new_tokens=2048, do_sample=False)
        t_first_token = time.perf_counter()
        audio = mimi.decode(output_tokens)
        t_end = time.perf_counter()

        sample_rate = 24000  # Mimi
        audio_len = audio.shape[-1] if hasattr(audio, "shape") else len(audio)
        metrics.audio_seconds = audio_len / sample_rate
        metrics.ttft_ms = (t_first_token - t0) * 1000
        metrics.wall_ms = (t_end - t0) * 1000
        if metrics.audio_seconds and metrics.audio_seconds > 0:
            metrics.rtf = metrics.wall_ms / (metrics.audio_seconds * 1000)
        token_count = output_tokens.shape[-1] if hasattr(output_tokens, "shape") else 0
        if metrics.wall_ms and metrics.wall_ms > 0:
            metrics.tokens_per_second = token_count / (metrics.wall_ms / 1000)
        metrics.vram_peak_gb = torch.cuda.max_memory_allocated() / 1e9
        metrics.vram_steady_gb = torch.cuda.memory_allocated() / 1e9
        metrics.rss_delta_mb = (proc.memory_info().rss - rss_before) / 1e6
        # Best-effort CPU sample after generation (single point).
        cpu_samples.append(psutil.cpu_percent(interval=None))
        metrics.cpu_percent_max = max(cpu_samples) if cpu_samples else None
        if not output_tokens.requires_grad and hasattr(output_tokens, "cpu"):
            token_bytes = output_tokens.cpu().numpy().tobytes()
            metrics.determinism_hash = hashlib.sha256(token_bytes).hexdigest()[:16]
        if metrics.audio_seconds == 0:
            metrics.error = "empty_audio_token_stream"
    except Exception as exc:  # noqa: BLE001
        metrics.error = f"{type(exc).__name__}: {exc}"
    return metrics


def summarize(report: BenchReport) -> None:
    successful = [t for t in report.trials if t.error is None]
    if not successful:
        report.summary = {"trial_count": len(report.trials), "successful": 0}
        return
    report.summary = {
        "trial_count": len(report.trials),
        "successful": len(successful),
        "avg_ttft_ms": round(sum(t.ttft_ms for t in successful if t.ttft_ms) / len(successful), 1),
        "avg_rtf": round(sum(t.rtf for t in successful if t.rtf) / len(successful), 3),
        "max_vram_peak_gb": round(max((t.vram_peak_gb or 0) for t in successful), 2),
        "live_conversation_capable": all((t.rtf or 99) < 1.0 for t in successful),
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--auth-check", action="store_true", help="Dry-probe HF gated access; no download.")
    parser.add_argument("--no-audio-write", action="store_true", help="Skip WAV writes.")
    parser.add_argument("--json", action="store_true", help="Print the full JSON report to stdout.")
    parser.add_argument("--output", type=Path, default=None, help="Write JSON report to this path.")
    parser.add_argument("--self-test", action="store_true", help="Run the dotenv loader regression test and exit.")
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

    # Skeleton stops here — actual load/generate path is left to the runner
    # author after deps are in place. CSM uses its own model class in
    # transformers (CsmForConditionalGeneration); do NOT swap to
    # AutoModelForCausalLM, which loads a text-only head and discards the
    # audio decoder. The structure above is enough to mechanically fill in:
    #
    #   from transformers import AutoProcessor, CsmForConditionalGeneration
    #   from moshi.models import loaders
    #
    #   t_load = time.perf_counter()
    #   processor = AutoProcessor.from_pretrained("sesame/csm-1b")
    #   model = CsmForConditionalGeneration.from_pretrained(
    #       "sesame/csm-1b",
    #       torch_dtype="auto",
    #       device_map="cuda:0",
    #   )
    #   mimi = loaders.get_mimi(loaders.DEFAULT_REPO).cuda()
    #   report.cold_load_ms = (time.perf_counter() - t_load) * 1000
    #
    #   for label, prompt in PROMPT_SUITE:
    #       for _ in range(3):
    #           report.trials.append(run_trial(label, prompt, model, processor, mimi))
    #
    # summarize(report)
    report.blocker = "skeleton_only_runner_path_not_wired"
    report.finished_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    _emit(report, args)
    return 4


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
