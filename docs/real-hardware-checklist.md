# Checklist for a machine with a real graphics card

Everything graphics-related so far was checked on a software renderer, which agrees with the CPU to float rounding but says nothing about speed or about drivers. Run this on each
kind of machine you can reach (an NVIDIA, an AMD and an Intel or Apple graphics card are the ones that differ) with the newest desktop test build, and write what you see next to each line.
Use the same photo each time: a raw ILLUM photo with a sharp thin object in front (the fence photo).

## Starts and shows a picture
- [ ] The app opens, the photo opens, and the first picture appears. Note the time to first picture.
- [ ] Info panel > GPU time shows a number (ms per view). Note it. (The software renderer is 1000x slower, so anything above ~50 ms per view is worth a note.)
- [ ] No "falls back to the CPU" notice appears while working. If one does, copy its text.

## Settings that need the graphics card
- [ ] Settings > Memory: the video memory slider's maximum is close to the card's memory less 512 MB; set it low (1 GB) and open a photo: it still renders, more slowly.
- [ ] Render (Full sensor) at 2x, then 3x and 4x: finishes, no black or striped picture. Note the times. At 3x and 4x the diamond pattern should be gone (Lattice filter on).
- [ ] Depth style Illuminator at Normal and High quality: depth map shows no black splotches on shiny things.
- [ ] Depth style Classic Desktop: finishes; note the time (it solves on the GPU).

## Things only seen on real hardware
- [ ] Click to focus on a fence wire in the depth map blur: the first answer is quick, then it sharpens when the full depth arrives.
- [ ] f/22 with no blur: after a moment the picture sharpens (the background all-in-focus render).
- [ ] Upscaling with a downloaded model (needs WebGPU: Chrome or the desktop app on a recent card): Settings > Upscaling models downloads, then Render at 2x with the model finishes.
- [ ] Depth models (Depth Anything, MiDaS): Settings > Depth models downloads one, then Depth method uses it.
- [ ] Export a 4K video of 60 frames: finishes, the file plays.

## Desktop app only
- [ ] Help > Check for Updates says what it finds; with an older version the update window lists "What's new" and the download for this computer.
- [ ] The Windows installers: the .exe's last page and the .msi's last page both have "Add Illuminator to the desktop" beside "Run Illuminator"; unticked leaves the desktop clean.
- [ ] Camera > Depth: the depth ruler shows the photo's depth spread, and clicking or dragging it moves the focus; Focus peaking marks sharp edges in green.
- [ ] Info > Speed lists the stages with their times, and says a graphics card is in use (and nothing is holding it back); Copy speed report puts text on the clipboard.
- [ ] Render Settings > Photo > Color space: a photo saved as Display P3 (PNG, 16-bit PNG and JPEG) opens in another program with that profile.
- [ ] Local Adjustments > Haze: on a Depth mask with a wide Feather, the far parts fade into fog; below zero it removes haze.
- [ ] Command line: `Illuminator --cli render photo.lfr -o out.png --exit-file code.txt` makes the picture, code.txt holds 0, and the process ends without a crash message.
- [ ] Render Queue (desktop app): add two pictures and a video of a library photo, choose a folder, start; the files appear in the folder one after another, the picture on screen stays usable, and the video plays. (Only pictures have been tried, on a software renderer.)
- [ ] Ratings and keywords: mark a photo, then open its folder in Lightroom, Bridge or digiKam: the XMP file's rating, pick flag and keywords show there.
- [ ] A focus change in Full sensor mode at 2× resolution: the new picture appears at once, the finished one follows; no "Measuring depth" or "Focusing every depth" shows for a new focus point.

## If something fails
Send: the line above, the text of any notice, the graphics card and driver version (the Info panel and `chrome://gpu` in the browser version), and the photo if you can.

## Looks

- Save a look from an edited photo (try one with a LUT and local adjustments), put it on another photo with a click, undo it with Ctrl+Z.
- Save it as a file, delete it, import the file again, and put it on a photo on another computer.
- Render Queue: choose an album with *Choose all*, pick a look, add the pictures, start the queue, and check the files have the look and the photos in the library do not.
- Render Queue videos: open a photo with Animation on, choose an album, click *Choose all* and *Add video* (with and without a look), start the queue, and play the files. Try MP4 H.264 and WebM. Check the queue works while the window is in the background.
- Ratings: point at a thumbnail in the list and in the grid, rate with a click on a star, clear it by clicking the lit star, pick with the checkbox; on a touchscreen the stars and checkbox should always show.
- Depth map contrast with *Apply to perspective shift*: set contrast to 100, tick the box, and drag the viewpoint on a photo with near and far objects; near and far should slide against each other more than with the box off, and the center viewpoint should look the same either way. Try it in an animation too. (A Full sensor render keeps the measured parallax.)
- Render Queue and saved depth: in the desktop app, queue a few raw photos with a blur (f-number) twice. The first run measures each photo's depth; the second should start drawing at once, and opening those photos in the app should not measure the depth again. A photo with a depth map edited in Lytro Desktop should look the same from the queue as in the app.
- Web app saved depth: open a raw photo in the web app, show its depth map, wait for it, reload the page and open the same photo from the library: the depth map should come at once. (The browser keeps about 1 MB per photo for it with the library.)
- Click to focus: open a raw photo, set an aperture like f/2.8 or wider, and click a detailed spot (text, fine texture). It should look exactly as sharp as the same spot at f/22; the out-of-focus parts should still blur. Check it at the picture's edges too, and at a depth very close to the lens.
