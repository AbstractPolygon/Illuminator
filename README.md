# Illuminator

Open, refocus and animate Lytro ILLUM light field photos.

**Website:** [abstractpolygon.github.io/Illuminator](https://abstractpolygon.github.io/Illuminator/)

```
npm install
npm start          # desktop app
npm run web        # browser version at http://localhost:8080
npm test
```

The graphics card tests run in headless Chromium (a software renderer where there is no card). Real photos are not in git: point `ILLUMINATOR_PHOTOS` at a folder of `.lfr`, `.lfp` and `.lri` files to check what is kept with each against `test/real-photos.json` (`ILLUMINATOR_PHOTOS=/path node --test test/real-photos.test.mjs`; `UPDATE_RECORDS=1` records them again after a deliberate change).

## Library

Every photo you open, drop or import is copied into the library, each in its folder with its edits next to it:

```
library.json                      photos and albums
Photos/IMG_0001/IMG_0001.LFR
               /edits.illuminator.json
               /thumb.jpg
```

The desktop app keeps the library in `Pictures/Illuminator` (change it in Settings; a library already in `Pictures/ILLUMinator` stays there); a browser keeps it in its private storage. Albums are listed in the left sidebar: drag photos onto an album, or use the ••• button on a photo.

Settings → Import Lytro Desktop library adds every photo in a Lytro Desktop library (or any folder, including a copy of a camera card) to a new album, with the edits Lytro Desktop saved for each one.

## License

[PolyForm Shield 1.0.0](LICENSE.md): free to use for any purpose, including commercial work, but not to sell the software or build a competing product from it.
