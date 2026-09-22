#!/usr/bin/env python3
"""Render terminal transcripts as PNG screenshots for the README.

The screenshots committed under ``docs/screenshots/`` are produced by this
script from the *captured* output in ``docs/verification/``, so they always
reflect a real run rather than a mock-up. Regenerate them with:

    python3 scripts/render-screenshots.py

Requires Pillow (``pip install Pillow``). Fonts are DejaVu Sans Mono, which
ships with most Linux distributions.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # pragma: no cover - dependency hint
    sys.exit("Pillow is required: pip install Pillow")

ROOT = Path(__file__).resolve().parent.parent

FONT_REGULAR = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"

# Terminal palette.
BG = (13, 17, 23)
BG_BAR = (22, 27, 34)
BORDER = (48, 54, 61)
TITLE_FG = (139, 148, 158)
FG = (201, 209, 217)
DIM = (110, 118, 129)
GREEN = (63, 185, 80)
BRIGHT_GREEN = (86, 211, 100)
YELLOW = (210, 168, 60)
ORANGE = (240, 136, 62)
RED = (248, 81, 73)
CYAN = (86, 182, 194)
WHITE = (240, 246, 252)

FONT_SIZE = 15
LINE_HEIGHT = 22
PAD_X = 22
PAD_Y = 18
BAR_HEIGHT = 34
RADIUS = 10

ADDRESS_RE = re.compile(r"\b[0-9a-f]{64}\b")
VERSION_RE = re.compile(r"\b\d+\.\d+\.\d+\b")
SEPARATOR_RE = re.compile(r"^\s*[─━]{4,}\s*$")


def load_transcript(path: Path) -> list[str]:
    """Read a transcript, collapsing carriage-return progress redraws."""
    raw = path.read_text(encoding="utf-8", errors="replace")
    lines: list[str] = []
    for line in raw.split("\n"):
        # `npm`/docker-compose redraw progress with \r; a terminal keeps only
        # the final state of the line.
        parts = [p for p in line.split("\r") if p.strip()]
        lines.append(parts[-1].rstrip() if parts else "")
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return lines


def classify(line: str) -> tuple[int, int | None, list[tuple[str, tuple[int, int, int]]]]:
    """Return (base colour, fg override or None, inline spans)."""
    stripped = line.strip()

    if SEPARATOR_RE.match(line):
        return DIM, None, []
    if stripped.startswith("$ "):
        return FG, None, [("$", GREEN)]
    if stripped.startswith(">"):
        return DIM, None, []
    if "✓" in line:
        return BRIGHT_GREEN, None, []
    if re.search(r"\d+ passed", line):
        return BRIGHT_GREEN, None, []
    if re.search(r"\b(ERROR|error|failed|Fatal)\b", line):
        return RED, None, []
    if re.search(r"Compiling \d+ circuits", line):
        return WHITE, None, []

    colour = FG
    if stripped.startswith(("Network:", "Phase:", "Contract address:", "Deploy record:",
                            "Auctioneer key:", "Lot digest:", "Balance:", "DUST:",
                            "Reserve price:", "Sealed bids:", "Winner:", "Address:",
                            "Indexer:", "Recorded", "Recomputed", "Lot document:",
                            "Deploying", "Initialising", "Deployed", "Tests",
                            "Test Files", "Duration", "Start at", "Verify with:")):
        colour = CYAN
    return colour, None, []


def build_spans(line: str) -> list[tuple[str, tuple[int, int, int]]]:
    """Tokenise a line into (text, colour) spans with inline highlighting."""
    base, _, overrides = classify(line)

    # Apply whole-line colour overrides keyed by prefix.
    spans: list[tuple[str, tuple[int, int, int]]] = []
    cursor = 0
    matches: list[tuple[int, int, tuple[int, int, int]]] = []
    for m in ADDRESS_RE.finditer(line):
        matches.append((m.start(), m.end(), ORANGE))
    for m in VERSION_RE.finditer(line):
        matches.append((m.start(), m.end(), YELLOW))
    for text, colour in overrides:
        idx = line.find(text)
        if idx >= 0:
            matches.append((idx, idx + len(text), colour))
    for m in re.finditer(r"\bYES\b", line):
        matches.append((m.start(), m.end(), BRIGHT_GREEN))
    matches.sort()

    for start, end, colour in matches:
        if start < cursor:
            continue
        if start > cursor:
            spans.append((line[cursor:start], base))
        spans.append((line[start:end], colour))
        cursor = end
    if cursor < len(line):
        spans.append((line[cursor:], base))
    if not spans:
        spans = [(line, base)]
    return spans


def render(transcript: Path, out: Path, title: str) -> None:
    lines = load_transcript(transcript)
    font = ImageFont.truetype(FONT_REGULAR, FONT_SIZE)
    font_bold = ImageFont.truetype(FONT_BOLD, FONT_SIZE)
    font_title = ImageFont.truetype(FONT_REGULAR, 13)

    # Measure with a temporary canvas.
    probe = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    cell = probe.textlength("M", font=font)

    text_width = max((probe.textlength(l, font=font) for l in lines), default=0)
    text_height = len(lines) * LINE_HEIGHT

    width = int(text_width + PAD_X * 2)
    height = int(BAR_HEIGHT + PAD_Y * 2 + text_height)
    # Keep the image within sane limits.
    width = max(760, min(width, 1500))
    height = max(240, height)

    img = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(img)

    # Window chrome.
    draw.rounded_rectangle([0, 0, width - 1, height - 1], radius=RADIUS, outline=BORDER, width=1)
    draw.rectangle([1, 1, width - 2, BAR_HEIGHT], fill=BG_BAR)
    draw.line([1, BAR_HEIGHT, width - 2, BAR_HEIGHT], fill=BORDER)
    for i, colour in enumerate(((255, 95, 86), (255, 189, 46), (39, 201, 63))):
        cx = 18 + i * 20
        draw.ellipse([cx - 6, BAR_HEIGHT // 2 - 6, cx + 6, BAR_HEIGHT // 2 + 6], fill=colour)
    draw.text((88, BAR_HEIGHT // 2 - 8), title, font=font_title, fill=TITLE_FG)

    y = BAR_HEIGHT + PAD_Y
    for line in lines:
        if line.strip():
            x = PAD_X
            for text, colour in build_spans(line):
                use = font_bold if colour in (BRIGHT_GREEN, WHITE, ORANGE) else font
                draw.text((x, y), text, font=use, fill=colour)
                x += draw.textlength(text, font=use)
        y += LINE_HEIGHT

    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out, "PNG", optimize=True)
    print(f"wrote {out.relative_to(ROOT)}  ({width}x{height}, {len(lines)} lines)")


SHOTS = [
    ("compile.txt", "compile.png", "compact compile — 6 circuits"),
    ("tests.txt", "tests.png", "npm test — 97 tests"),
    ("deploy.txt", "deploy.png", "sealedbid deploy — undeployed devnet"),
    ("verify.txt", "verify.png", "sealedbid verify — read from the indexer"),
    ("demo.txt", "demo.png", "sealedbid demo — all six circuits on chain"),
]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--evidence-dir", default=str(ROOT / "docs" / "verification"))
    ap.add_argument("--out-dir", default=str(ROOT / "docs" / "screenshots"))
    ap.add_argument("--only", help="render a single evidence file, e.g. deploy.txt")
    args = ap.parse_args()

    evidence = Path(args.evidence_dir)
    out_dir = Path(args.out_dir)
    shots = [s for s in SHOTS if not args.only or s[0] == args.only]
    if not shots:
        sys.exit(f"no screenshot defined for {args.only}")

    for src, dst, title in shots:
        path = evidence / src
        if not path.exists():
            print(f"skip {src}: not captured yet", file=sys.stderr)
            continue
        render(path, out_dir / dst, title)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
