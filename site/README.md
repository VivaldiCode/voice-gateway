# Voice Gateway — landing page

Static site published to **https://VivaldiCode.github.io/voice-gateway/**.

## Structure

```
site/
├── index.html          single-page landing (hero, features, how, shots, install, FAQ, footer)
├── styles.css          vanilla CSS that mirrors the desktop app theme (tailwind.config.js tokens)
├── assets/
│   ├── logo-mark.svg   square mic-on-violet mark (favicon + nav)
│   ├── og-image.svg    1200×630 OG/Twitter card
│   └── screenshots/    real .png shots dropped in by tools/capture-screenshots.ts
└── README.md           you are here
```

## Theme parity

Colours, type stack and orb animation copy the desktop renderer
(`tailwind.config.js` + `src/renderer/components/StateOrb.tsx`). When
the app rebrands, edit the `:root` block at the top of `styles.css`
to match.

## Capturing real screenshots

The `.shot-mock` cards in `index.html` are CSS-only mockups so the
site builds without a packaged .app on hand. To replace them with
real PNGs:

1. Build the .app: `npm run build:mac`
2. Run the capture script (round-12 follow-up):
   `npm run site:screenshots`
3. The script writes:
   - `site/assets/screenshots/main-idle.png`
   - `site/assets/screenshots/main-capturing.png`
   - `site/assets/screenshots/settings-voz.png`
   - `site/assets/screenshots/wizard-step1.png`
4. Replace the `.shot-mock` markup in `index.html` with `<img>` tags
   pointing at those paths.

The capture script uses the existing Playwright rig + `--video=off
--screenshot=on` flags + scripted `runTurn()` to drive the UI into
each state before snapping.

## Deploying

GitHub Actions handles deploy automatically via
`.github/workflows/deploy-pages.yml` on every push to `main` that
touches `site/**`. First-time setup: **Settings → Pages → Build and
deployment → Source: GitHub Actions**. The workflow will then publish
to `https://VivaldiCode.github.io/voice-gateway/` on the next push.

## Local preview

```bash
# Any static server works. Python is on every Mac.
cd site && python3 -m http.server 8080
# Open http://localhost:8080
```

Or use `npx serve site` if you'd rather not install Python.
