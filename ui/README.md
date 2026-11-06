# Canary UI

Static, dependency-free UI for Canary: hero, Without/With flow, an interactive
panel mock (Overview / Activity / Manifest), the Four Moves, and the anon-rpc
route with the ENSv2 privacy manifest. Everything lives in this folder.

```
ui/
  index.html            page + inline icon sprite
  styles.css            all styling (rem + grid/flex + container queries)
  app.js                renders the sample panel from a DATA object
  assets/canary.svg     logo
  tools/check-overflow.py   overflow checker (headless Chrome)
```

## Run

Open `index.html` in a browser, or `python3 -m http.server -d ui 8000`.
The data in `app.js` is illustrative sample data, not real scan results.

## Overflow check

Run this after **every** UI change:

```sh
pip install playwright        # uses your installed Chrome; no browser download
python3 ui/tools/check-overflow.py                 # 14 widths x 3 text scales x 4 panel states
python3 ui/tools/check-overflow.py --shots out/    # also save screenshots
```

It reports a page that scrolls sideways, elements past the viewport, elements
that stick out of their parent, and content wider than its box. It exits 1 on
any finding. Set `CHROME_BIN` if Chrome is not on your PATH.

Rules that keep it clean: text containers may shrink (`min-width: 0`), long
strings wrap, no fixed widths on text, layout breakpoints are container queries
so they follow the real text size.

## When the history grows

The UI is rebuilt per history snapshot (10 commits, then +30). Keep all UI
work inside `ui/`; nothing here touches `extension/` or `canary-spike/`.
