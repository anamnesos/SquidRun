#!/usr/bin/env python
"""Subtitle worker for SquidRun Phase 1 Korean subtitle pipeline."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import traceback
import wave

import numpy as np


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="SquidRun subtitle worker")
    subparsers = parser.add_subparsers(dest="command", required=True)

    transcribe = subparsers.add_parser("transcribe", help="Transcribe audio into timed segments")
    transcribe.add_argument("--audio-path", required=True)
    transcribe.add_argument("--output-path", required=True)
    transcribe.add_argument("--model", default="small")
    transcribe.add_argument("--language", default="en")
    transcribe.add_argument("--device", default="auto")
    transcribe.add_argument("--compute-type", default="auto")
    transcribe.add_argument("--beam-size", type=int, default=5)
    transcribe.add_argument("--align", action="store_true")
    return parser


def configure_windows_dll_paths() -> None:
    if os.name != "nt":
        return
    try:
        import torch

        libdir = Path(torch.__file__).resolve().parent / "lib"
        if libdir.is_dir():
            os.add_dll_directory(str(libdir))
            os.environ["PATH"] = f"{libdir}{os.pathsep}{os.environ.get('PATH', '')}"
    except Exception:
        return


def normalize_word(word) -> dict:
    return {
        "word": str(getattr(word, "word", "") or "").strip(),
        "start": to_float(getattr(word, "start", None)),
        "end": to_float(getattr(word, "end", None)),
        "probability": to_float(getattr(word, "probability", None)),
    }


def to_float(value, fallback=None):
    if value is None:
        return fallback
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def normalize_segment(segment, index: int) -> dict:
    words = [normalize_word(word) for word in (getattr(segment, "words", None) or [])]
    return {
        "id": index,
        "start": to_float(getattr(segment, "start", 0.0), 0.0),
        "end": to_float(getattr(segment, "end", 0.0), 0.0),
        "text": str(getattr(segment, "text", "") or "").strip(),
        "words": [word for word in words if word["word"]],
    }


def load_alignment_audio(audio_path: str):
    path = Path(audio_path)
    if path.suffix.lower() == ".wav":
        with wave.open(str(path), "rb") as wav_file:
            frames = wav_file.readframes(wav_file.getnframes())
        return np.frombuffer(frames, dtype=np.int16).flatten().astype(np.float32) / 32768.0

    import whisperx

    ffmpeg_path = str(os.environ.get("SQUIDRUN_FFMPEG_PATH", "") or "").strip()
    if ffmpeg_path:
        ffmpeg_dir = str(Path(ffmpeg_path).resolve().parent)
        os.environ["PATH"] = f"{ffmpeg_dir}{os.pathsep}{os.environ.get('PATH', '')}"
    return whisperx.load_audio(str(path))


def transcribe_audio(args: argparse.Namespace) -> dict:
    configure_windows_dll_paths()
    from faster_whisper import WhisperModel

    requested_device = str(args.device or "auto").strip().lower()
    device = "cuda" if requested_device == "auto" else requested_device
    requested_compute = str(args.compute_type or "auto").strip().lower()
    compute_type = "float16" if requested_compute == "auto" and device == "cuda" else requested_compute
    if requested_compute == "auto" and device != "cuda":
        compute_type = "int8"

    runtime_notes = []
    try:
        model = WhisperModel(args.model, device=device, compute_type=compute_type)
        segments_iter, info = model.transcribe(
            args.audio_path,
            language=args.language,
            beam_size=max(1, int(args.beam_size or 5)),
            vad_filter=True,
            word_timestamps=True,
        )
    except Exception as exc:
        if device != "cuda":
            raise
        runtime_notes.append(f"cuda_fallback:{exc}")
        device = "cpu"
        compute_type = "int8"
        model = WhisperModel(args.model, device=device, compute_type=compute_type)
        segments_iter, info = model.transcribe(
            args.audio_path,
            language=args.language,
            beam_size=max(1, int(args.beam_size or 5)),
            vad_filter=True,
            word_timestamps=True,
        )
    segments = [normalize_segment(segment, index) for index, segment in enumerate(segments_iter)]
    result = {
        "language": getattr(info, "language", args.language),
        "duration": getattr(info, "duration", None),
        "device": device,
        "computeType": compute_type,
        "runtimeNotes": runtime_notes,
        "alignmentUsed": False,
        "segments": [segment for segment in segments if segment["text"]],
    }

    if args.align:
        try:
            import whisperx

            audio = load_alignment_audio(args.audio_path)
            align_model, metadata = whisperx.load_align_model(
                language_code=result["language"],
                device=device,
            )
            aligned = whisperx.align(
                [{"start": seg["start"], "end": seg["end"], "text": seg["text"]} for seg in result["segments"]],
                align_model,
                metadata,
                audio,
                device,
                return_char_alignments=False,
            )
            aligned_segments = []
            for index, segment in enumerate(aligned.get("segments", [])):
                aligned_segments.append({
                    "id": index,
                    "start": to_float(segment.get("start", 0.0), 0.0),
                    "end": to_float(segment.get("end", 0.0), 0.0),
                    "text": str(segment.get("text", "") or "").strip(),
                    "words": [
                        {
                            "word": str(word.get("word", "") or "").strip(),
                            "start": to_float(word.get("start")),
                            "end": to_float(word.get("end")),
                            "probability": to_float(word.get("score")),
                        }
                        for word in (segment.get("words") or [])
                        if str(word.get("word", "") or "").strip()
                    ],
                })
            if aligned_segments:
                result["segments"] = aligned_segments
                result["alignmentUsed"] = True
        except Exception as exc:  # pragma: no cover - best effort fallback
            result["alignmentError"] = str(exc)
            result["alignmentTraceback"] = traceback.format_exc(limit=20)

    return result


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command != "transcribe":
        parser.error(f"Unsupported command: {args.command}")

    payload = transcribe_audio(args)
    output_path = Path(args.output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
