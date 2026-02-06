#!/usr/bin/env python3
import argparse
import json
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="all-MiniLM-L6-v2")
    args = parser.parse_args()

    try:
        from sentence_transformers import SentenceTransformer
    except Exception as exc:
        sys.stderr.write(f"sentence-transformers import failed: {exc}\n")
        sys.stderr.flush()
        return 1

    model = SentenceTransformer(args.model)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            texts = req.get("texts", [])
            vectors = model.encode(texts).tolist() if texts else []
            dim = len(vectors[0]) if vectors else 0
            resp = {
                "id": req.get("id"),
                "vectors": vectors,
                "dim": dim,
            }
        except Exception as exc:
            resp = {
                "id": req.get("id"),
                "error": str(exc),
            }
        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
