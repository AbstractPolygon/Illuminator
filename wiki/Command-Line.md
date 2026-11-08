# Command line and scripting

Illuminator can be run from a terminal or a script to make pictures without opening a window: batch renders, conversions, and repeatable test pictures. It runs the app itself in a hidden window, so what it makes is what the app makes. The desktop app has it built in; there is no separate program to install.

## Running it

Add `--cli` and a command to the desktop app's program:

- **Windows:** `"C:\Program Files\Illuminator\Illuminator.exe" --cli render photo.lfr -o photo.png`. Windows does not show a program's text in the terminal for an app like this, so use `--exit-file result.txt` to learn how it went, and look at the files it makes.
- **macOS:** `/Applications/Illuminator.app/Contents/MacOS/Illuminator --cli render photo.lfr -o photo.png`
- **Linux:** `Illuminator --cli render photo.lfr -o photo.png` (the AppImage, or the installed program). On a computer with no screen, run it under `xvfb-run`.
- **From a source checkout:** `npm run cli -- render photo.lfr -o photo.png`. On Linux without a display it uses `xvfb-run` when that is installed.

Photos are made on the graphics card when the computer has one, as in the app; without one the processor does the work, much more slowly (*Info* in the app shows which, and [[Histogram and Info]] has the speed report).

## Commands

| Command | What it does |
| --- | --- |
| `render <photo...>` | Makes a picture of each photo (.LFR or .LFP) and saves it |
| `info <photo>` | Prints the photo's details (camera, sizes, renderer) as JSON |
| `controls` | Prints every setting that can be changed, with its default, as JSON |
| `version`, `help` | |

## Options for `render`

| Option | |
| --- | --- |
| `-o`, `--out <file or folder>` | A file name for one photo, a folder for several. Without it each picture is saved next to its photo. |
| `--format png, png16 or jpeg` | The file format (default: from the `--out` file name, else png) |
| `--quality 50-100` | JPEG quality |
| `--color-space srgb, p3, adobe, rec2020 or prophoto` | Converts to that color space and saves its profile in the file (see [[Render]]) |
| `--size 1, 1.5, 2, 3 or 4` | Enlarges by this much (Photo *Size*) |
| `--f-number 2.8` | The aperture (f/22 to f/0.5, the steps the slider has) |
| `--focus 0.2` | The focus depth, -1.6 (near) to 1.6 (far) |
| `--view u,v` | The viewpoint, in sensor pixels within the lens |
| `--set setting=value` | Any setting from `controls`, for example `--set ev=0.5 --set tone-contrast=20`. Repeat for more. |
| `--edits file.json` | An edits document saved by Illuminator, applied on top |
| `--full-sensor`, `--scale`, `--passes` | Render from every sensor pixel, with its *Scale* and *Detail recovery* |
| `--script file.js` | Runs a script in the app once the photo is open (see below). Without `-o` or `--format` it makes no picture of its own. |
| `--timeout seconds` | Gives up on a photo after this long (1200 by default) |
| `--exit-file file` | Writes the exit code to this file |
| `--quiet` | Prints only errors |

The exit code is 0 when everything was made, 1 when a photo could not be made (the message says why and the other photos are still made), and 2 when the command was not understood.

Photos are made from the settings in the file (Lytro Desktop's), not the ones saved in your library, so a command gives the same picture on any computer. Settings you give are applied on top.

### Examples

```
Illuminator --cli render IMG_0001.lfr -o IMG_0001.jpg --f-number 2.8 --focus -0.3 --quality 90
Illuminator --cli render *.lfr -o pictures --format png16 --color-space p3
Illuminator --cli render IMG_0001.lfr -o big.png --full-sensor --scale 2 --size 2
Illuminator --cli controls > controls.json
```

## Scripting interface

The same interface is in the app's page as `window.illuminator`, for scripts passed with `--script` and for plugins. It drives the app's controls, so every dependent step follows, and each call that changes the picture finishes when the app has nothing left to render.

| Call | |
| --- | --- |
| `version`, `apiVersion` | The app's version, and the interface's (1) |
| `await open(name, bytes, { edits })` | Opens a photo from its bytes; resolves its details |
| `info()` | Name, camera, sensor size, view size, renderer, picture size |
| `controls()` | Every settable control and its value now |
| `await set({ id: value })` | Changes settings, such as `{ ev: 0.5, 'tone-contrast': 20, 'photo-format': 'jpeg' }`. Values may be text. |
| `getEdits()`, `await setEdits(edits)` | The photo's settings as an edits document, and put back |
| `await camera({ fNumber, focus, u, v })` | The aperture, focus depth and viewpoint |
| `await fullSensor({ scale, passes })` | Renders the full sensor picture |
| `await export({ format, quality, colorSpace, size })` | Makes the file: resolves `{ name, type, bytes }` |
| `await report()` | The speed report as text |
| `busy()`, `await settled()` | What the app is still working on; wait until it is done |
| `on(event, fn)` | Events: `photoOpened`, `rendered`, `exported` |
| `use(plugin)`, `plugins()` | Runs a plugin (a function, or `{ name, setup(api) }`) once, with the interface |

A script given to `--script` is the body of an async function with `illuminator` in scope; what it returns is printed as JSON:

```js
// bright.js: a brighter picture and the settings that made it
await illuminator.set({ ev: 0.5 });
return illuminator.getEdits().process;
```

In a browser, the interface is there too: open the developer console on the app and call `illuminator.controls()`.
