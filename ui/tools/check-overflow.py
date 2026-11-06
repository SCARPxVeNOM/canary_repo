#!/usr/bin/env python3
"""Check that no Canary UI component overflows.

For every viewport width x panel state x text scale it opens ui/index.html in
headless Chrome and reports:
  PAGE        the page scrolls horizontally
  OFFSCREEN   an element sticks out past the viewport
  ESCAPES     an element sticks out of its parent's box (either axis)
  CONTENT     an element's content is wider/taller than the element (clipped or spilling)

Usage:
  python3 ui/tools/check-overflow.py [--shots DIR] [--widths 320,375,...]
Env:
  CHROME_BIN   path to Chrome/Chromium (default: first of google-chrome, chromium)
Exit code is 1 if anything is reported, so it can gate a commit or CI job.
Needs: pip install playwright   (uses your installed Chrome, no download)
"""
import argparse, os, shutil, sys, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
PAGE = (ROOT / "index.html").as_uri()

WIDTHS = [320, 360, 375, 414, 480, 600, 720, 768, 900, 1024, 1100, 1280, 1440, 1920]
SCALES = [100, 125, 150]  # root font-size %, simulates larger text settings
STATES = ["overview", "activity", "manifest", "off"]

PROBE = """
() => {
  const out = [];
  const de = document.documentElement;
  const vw = de.clientWidth;
  if (de.scrollWidth > vw) out.push(`PAGE horizontal scroll: scrollWidth ${de.scrollWidth} > viewport ${vw}`);
  const name = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') +
    (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\\s+/).join('.') : '');
  for (const el of document.querySelectorAll('body *')) {
    if (el instanceof SVGElement && el.tagName.toLowerCase() !== 'svg') continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.display === 'contents' || cs.visibility === 'hidden') continue;
    if (el.closest('.sr-only') || el.classList.contains('skip')) continue;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    if (r.right > vw + 0.5 || r.left < -0.5)
      out.push(`OFFSCREEN ${name(el)} x=[${r.left.toFixed(0)}..${r.right.toFixed(0)}] viewport=${vw}`);
    const p = el.parentElement;
    if (p && p !== document.body && p !== document.documentElement && !(el instanceof SVGElement && p instanceof SVGElement)) {
      const pcs = getComputedStyle(p);
      if (pcs.display !== 'contents' && pcs.display !== 'inline') {
        const pr = p.getBoundingClientRect();
        const dx = Math.max(r.right - pr.right, pr.left - r.left);
        const dy = Math.max(r.bottom - pr.bottom, pr.top - r.top);
        if (dx > 1 || dy > 1) out.push(`ESCAPES ${name(el)} out of ${name(p)} by ${Math.max(dx, dy).toFixed(1)}px`);
      }
    }
    if (!(el instanceof SVGElement) && cs.display !== 'inline') {
      if (el.scrollWidth > el.clientWidth + 1) out.push(`CONTENT ${name(el)} scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}`);
      if (cs.overflowY !== 'visible' && el.scrollHeight > el.clientHeight + 1) out.push(`CONTENT ${name(el)} scrollHeight ${el.scrollHeight} > clientHeight ${el.clientHeight}`);
    }
  }
  return [...new Set(out)];
}
"""

def chrome_path():
    env = os.environ.get("CHROME_BIN")
    if env:
        return env
    for c in ("google-chrome", "chromium", "chromium-browser", "chrome"):
        p = shutil.which(c)
        if p:
            return p
    sys.exit("No Chrome found. Set CHROME_BIN.")

def set_state(page, state):
    # reset
    if page.get_attribute("#switch", "aria-checked") == "false":
        page.click("#switch")
    if state == "off":
        page.click("#switch")
        page.click("#tab-overview")
    else:
        page.click(f"#tab-{state}")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shots", help="directory for full-page screenshots")
    ap.add_argument("--widths", help="comma list, e.g. 320,768,1280")
    ap.add_argument("--shot-widths", default="375,768,1280,1440", help="widths to screenshot (with --shots)")
    a = ap.parse_args()
    widths = [int(x) for x in a.widths.split(",")] if a.widths else WIDTHS
    shot_w = {int(x) for x in a.shot_widths.split(",")}
    shots = Path(a.shots) if a.shots else None
    if shots:
        shots.mkdir(parents=True, exist_ok=True)

    problems, runs = [], 0
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=chrome_path(), args=["--no-sandbox"])
        for w in widths:
            ctx = b.new_context(viewport={"width": w, "height": 900})
            page = ctx.new_page()
            page.goto(PAGE)
            page.wait_for_load_state("load")
            for scale in SCALES:
                page.evaluate(f"document.documentElement.style.fontSize='{scale}%'")
                for st in STATES:
                    set_state(page, st)
                    page.wait_for_timeout(30)
                    found = page.evaluate(PROBE)
                    runs += 1
                    for f in found:
                        problems.append(f"[{w}px, {scale}%, {st}] {f}")
                    if shots and scale == 100 and w in shot_w and st in ("overview", "activity", "manifest"):
                        page.screenshot(path=str(shots / f"w{w}-{st}.png"), full_page=True)
            ctx.close()
        b.close()

    print(f"{runs} checks ({len(widths)} widths x {len(SCALES)} text scales x {len(STATES)} states)")
    if problems:
        print(f"{len(problems)} problem(s):")
        for x in problems[:80]:
            print("  ", x)
        if len(problems) > 80:
            print(f"   ... and {len(problems) - 80} more")
        sys.exit(1)
    print("No overflow found.")

if __name__ == "__main__":
    main()
