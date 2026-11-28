# Splitting main.js

`app/js/main.js` was one file of 7,700 lines. Sections that stand on their own now live under `app/js/ui/` (updates, number fields, tone curve, color matrix, white balance
picker, LUT, frame rate, 3D, local adjustments, living filters, keyframes, curves view, export, camera import, camera section), about 3,500 lines; it then grew back to about 6,950
lines, and a second round moved 15 more sections (see the end), about 3,300 lines. It is now about 3,700 lines. The rest is the page's core (see below).

## How a section moves

`node scripts/extract-section.mjs "<section name>" ui/<name>.js init<Name>` moves the lines between two `// ------ name` markers into a module:

```js
export function initThing({ $, state, scheduleSave }) { ...the section's code...; return { whatTheRestUses }; }
```

and main.js calls it where the section was: `const { whatTheRestUses } = initThing({ $, state, scheduleSave: (...a) => scheduleSave(...a) });`.
Functions are handed over as wrappers, so a function defined later in main.js is looked up when it is called, not when the section starts.

The tool does not add the module's import to main.js (it looks for an import that is no longer there): add `import { initThing } from './ui/<name>.js';` with the other `init` imports,
and remove the imports main.js no longer uses (lint reports them). It also does not tell a function returned by an earlier moved module from a plain value (both are `const`s in
main.js now), and it lists names by text, so a local variable inside the section with the name of one in main.js shows up as something to hand over. The smoke page shows both:
`Cannot access 'x' before initialization` means `x` is handed over before main.js has it. Then:

- a function returned by a module further down: hand it over as a wrapper (`showGrid: (...a) => showGrid(...a)`);
- an object or value defined further down (`DEFAULT_EDITS`): hand over a getter (`defaultEdits: () => DEFAULT_EDITS`) and call it in the module, or move the `initThing(...)` line
  (with its `// name: ui/file.js` line) down to where everything it is handed exists, if nothing runs its exports in between (ui/lenslets.js is called after the zoom section for
  `view` and `viewer`);
- a name the section only uses as a local variable (`view` in ui/info.js and ui/menus.js): take it out of the call and the module's parameters.

Afterwards: `npm run lint` (a name the section needs but was not handed over is a `no-undef` error), `node scripts/smoke-page.mjs PLAYWRIGHT_PATH` (the page loads without errors and the
controls it handles react) and `node scripts/capture-settings.mjs OUT.json PLAYWRIGHT_PATH` followed by `cmp OUT.json test/fixtures/settings-golden.json`.
The golden file is not made again with every settings change, so if it already differs before the move, capture the page before the move and compare with that instead.
`PLAYWRIGHT_PATH` is a Playwright module whose browser is installed (for example the global one, `$(npm root -g)/playwright/index.mjs`, when the project's copy expects another browser build).

## What stops the rest

The tool refuses a section when it shares a `let` variable with the rest of the page, since a copy handed to the new module would silently go out of step. Each such variable has been
put on the page's `state` object instead (`state.maskSel`, `state.anim`, `state.keySel`, `state.fps`, `state.upscaleShown`, `state.lib`, `state.cameraSection`, `state.rememberedFailed`, `state.webUsb*`, `state.askCameraPermission`;
in the second round `state.libReady`, `state.calReady`, `state.marks`, `state.looks`, `state.queueUi`, `state.retouchUi`, `state.emitEvent`, `state.previewing`, `state.processing`,
`state.selectMode`, `state.gridOrder`, `state.gridTiles`, `state.menuEl`, `state.pressHandled*`, `state.nrFinalTimer`, `state.recoveryRunning`, `state.autoRenderTimer`,
`state.speedFacts`, `state.suppressClick`, `state.lastClick`, `state.depthModelShown`, `state.checkForUpdateNow`, `state.saveTimer`, `state.lastHistoryKey`, `state.applyAgain`), which every module is handed:

1. Find what still blocks: `node scripts/extract-section.mjs "<section>" x y --dry` lists the `let` variables the section shares.
2. For each, check it is declared once at the top level (no local variable of the same name), then rename every use to `state.<name>` and give it its starting value in the `state` literal at
   the top of main.js (the renames were made with a parser, not a text search, so a property or a string with the same name is left alone).
3. If the variable turns out to always equal another field (`KEY_FPS` was always `state.fps`), use that field.
4. Move the section, then lint, `node scripts/smoke-page.mjs`, and the settings check above.

Nothing that blocks a section is left: every section can be moved by the tool. What remains in main.js (about 3,700 lines) is the page's core, which everything else calls: opening photos,
drawing, the depth ruler and camera rendering, full resolution and depth renders, zoom, pointer handling, crop and straighten, the wiring of the controls, and the edits and undo
machinery. Splitting those further would mean choosing seams that do not exist yet (for example a `view` module that owns drawing and zoom), which is a design question rather than a
move; do it when a feature needs one of them changed.

A section that only reads a shared object's fields can be handed a getter instead (`getAnim: () => anim`), and a section that assigns a shared variable needs a getter and a setter.
The tool ends a section at the next `// ------` header or at the `// name: ui/file.js` line left where an earlier section was moved.

## Sections moved in the second round

| Section | Module | Lines |
| --- | --- | --- |
| progress | ui/progress.js | 133 |
| library | ui/library.js | 211 |
| libraries and the albums list | ui/albums.js | 177 |
| film strip and the way back to the thumbnails | ui/filmstrip.js | 106 |
| grid | ui/grid.js | 283 |
| menus | ui/menus.js | 344 |
| histogram (and the viewpoint, focus point and f-number helpers in it) | ui/histogram.js | 270 |
| focus peaking | ui/peaking.js | 45 |
| animation | ui/animation.js | 396 |
| modes | ui/modes.js | 77 |
| info | ui/info.js | 98 |
| speed report | ui/speedreport.js | 147 |
| lenslets | ui/lenslets.js | 182 |
| zoomed in on a Light L16 photo | ui/l16zoom.js | 298 |
| settings (the Settings window: libraries, calibrations, model downloads, memory) | ui/settings.js | 588 |
