# Render

The *Render Settings* section of the sidebar (3D, Lenticular Print, Quality, Upscaling, Photo and Video) and the Render, Save and Export buttons below it. Render Settings shows in the Camera view, not the Lenslets view.

## 3D

A stereo pair from two viewpoints across the lens, for photos and videos.

- *Show 3D* shows the picture in 3D while you edit.
- *3D type:* *Anaglyph* (red / cyan glasses), *Side by side* (parallel viewing), *Cross-eyed* or *VR headset* (side by side at full size for headsets such as the Meta Quest 3; files get `_3D_SBS` in their names so headset players recognize them).
- *Baseline:* how far apart the two viewpoints are.
- *Save 3D image* saves the pair as an image, in the Photo *File format*. With *Show 3D* on, *Export video* makes a 3D video in the same 3D type.
- *View in VR* (in a headset's web browser, such as the Meta Quest Browser, with the browser version) shows the 3D picture on a large screen in front of you; press a controller trigger to leave.

## Lenticular Print

A print to put under a lenticular lens sheet, which changes as it is tilted: *3D* (a still scene that looks three-dimensional, from views across the lens; *Movement* sets how far the viewpoint moves, past the lens's opening up to 300%) or *Animation* (frames sampled evenly from the Animation section's animation, so a focus sweep refocuses), tilted *Left and right* or *Up and down*. Enter the sheet's lenses per inch, the printer's resolution, the print's size in inches and, after printing *Save pitch* and looking at it through the sheet, the measured pitch. *Preview* shows the print as it is tilted. *Save print* saves a PNG at the printer's resolution, to print at 100% without scaling. See [Exporting](Exporting) for each setting.

## Render Queue

The Render Queue makes pictures and videos one after another in the background, so a long full sensor render or a video does not hold up your editing. It has its own view, which takes the place of the photo: click the <img src="images/queue-view.png" width="20" height="20" alt="Render Queue"> icon to the left of *Quick export* (click it again, or the Camera or Lenslets button, to go back). Choosing a photo in the library keeps you in the Render Queue view, so you can pick photo after photo and add each to the queue; the view says which photo *Add picture* and *Add video* will use.

To add several photos at once, choose them in the library while the view is open: Ctrl-click (Command-click on a Mac) adds or removes a photo, and Shift-click chooses everything from the last one you clicked. The buttons then read *Add 3 pictures* and add one job for each chosen photo, with the *Photo* and *Full sensor* settings as they are now and each photo's own edits as saved with it (*Add video* skips photos whose *Animation* is off). Going back to the photo view keeps only the first chosen photo and shows it.

**A whole album, with a look.** Choose an album in the left sidebar, click *Choose all* (or press Ctrl+A or Command+A) in the Render Queue view to choose every photo in the list, pick a look in the *Look* list (the looks are under *Library > Looks*, see [[Library and Albums]]), and click *Add picture*. Each job puts the look on its photo for the export only: the photos keep their settings. A photo that was never edited here starts from the edits Lytro Desktop made, with the look on top. The card shows *Look: name*. Then *Start queue* makes them all.

**Videos in a batch.** *Add video* works the same way for every chosen photo. A photo with its own animation (Animation on) keeps it; a photo without one gets the open photo's animation, if that has Animation on, so a whole album can have the same camera move (the card says *Animation of the open photo*). The *Video* settings (format, codec, size, quality) are the ones in the app when you click *Add video*. If no photo has an animation to use, the notice says how many were skipped. A computer that cannot encode the chosen format makes the job fail with a message instead of saving an empty file.

1. Set a library photo up as you want it (its settings, *Photo* format, color space and size, *Full sensor* with its *Scale* and *Detail recovery*, or the animation and *Video* settings).
2. *Add picture* or *Add video* (in the Render Queue view, or in the *Render Queue* section of the right sidebar, below *Render Settings*) puts a job in the list. The job keeps the photo's settings as they are at that moment; carry on editing the photo, or other photos, as you like. A video needs *Animation* turned on.
3. The view shows a card for every job: the photo's thumbnail (marked with ▶ for a video), a bar with the percentage done and what it is doing, and its export settings (format, color space and size, *Full sensor* scale and recovery, aperture; for a video the format, compression, size and bitrate).
4. *Start queue* runs the jobs in order, one at a time. *Pause queue* lets the running job finish and starts no more. *▲* and *▼* reorder waiting jobs, *Cancel* on a card stops that picture or video (a running job stops at once and saves nothing), *Cancel all* stops the running job and drops every waiting one, *Remove* and *Clear finished* tidy the list.

In the browser each finished file is saved as a download (named like the photo; a second one with the same name gets *(2)*). In the desktop app you choose a folder once per session (*Choose folder…*) and the files are written there without asking each time.

The renders run in a hidden second copy of the app, with its own worker and graphics context, so the picture on screen stays live; the two copies share the computer's graphics card and memory, so a change on screen is slower while a job runs, and a full sensor render needs graphics memory for both copies (see *Settings > Memory*). The queue works for library photos only, is kept in memory (closing the app clears it), and the hidden copy measures the photo's depth itself, so the first job of a photo can take a while longer than a render in the app. The percentage is an estimate: each step (opening the photo, the full sensor render, saving or making the video) has its share of the bar.

## Quality

These apply to photos and videos alike.

- *Resolution:* the picture's resolution, 1× (fast), 1.5× or 2×, for editing, photos and every video frame.
- *Full sensor* (F): renders a high resolution still from every pixel of the sensor. *Scale* sets its size (2×, 3× or 4× the lens grid) and *Detail recovery* adds passes that bring back more fine detail (slower). *Render*, just below the Render Settings section, starts it; on a graphics card a quick preview (one pixel per lens, from a quarter of the lenses) shows first and is replaced by the finished picture (the all in focus pictures of raw ILLUM photos have no preview). The still is shown at the Photo *Size*, enlarged with the Upscaling settings, just as it will be saved; *Save PNG* then saves it. In the desktop app a finished full sensor render is kept next to the photo (the last four): pressing *Render* again with the same settings shows it at once. While you edit, the picture just before its color pass is also kept in memory (and, in the desktop app, next to the photo, the last two, so a photo opened again keeps it too), so changes to Process, Optics or Local Adjustments settings show on the full sensor render again within a moment, without combining the sensor's rays again. With *Auto render* on, the picture on screen stays put while that happens (it does not drop back to the live view) and is swapped for the new one when it is ready (changing anything that shapes the picture, such as the focus, depth, Scale or Lens centers, still renders it from the sensor; the first change after a photo's first full sensor render does too, once, because that render measures the lens centers). The first full sensor render of a photo also measures where each microlens's center really sits, from that photo alone (each camera, zoom and focus is a little different), and every later render of the photo uses it for sharper close detail. With the aperture closed (everything in focus), pixels at the edge of a near object are checked against the depths on both sides of the edge, so edges stay clean instead of doubled. With *Full sensor* on, *Export video* renders every frame this way too (much slower). With *Auto render* (under the *Render* button) checked, the still is rendered again by itself shortly after each change, once you stop dragging.
- *Lattice filter* (under *Lens centers*, shown only when *Full sensor* is on, whatever Detail recovery is set to): takes out the diamond pattern the microlens grid can leave in out-of-focus areas of a full sensor picture at 3× and 4×, which shows most once the picture is sharpened. It is off by default: Lytro Desktop has no such step, and on the fence photo it softened detail near the camera's focus, so the picture is Lytro's own without it. When turned on, the defaults below suit both scales (measured at 4× as at 3×: the pattern's frequencies drop to about 1% of their energy, and nothing below them changes); at 2× the pattern does not appear, so the filter is not run there. *Lattice detection* (50 by default) is how faint a pattern it looks for before it acts. *Lattice strength* (75 by default) is how hard it pulls the pattern down: lower leaves some of it, higher takes it all out and can soften fine texture at the same frequencies.
- *Lens centers* (under Scale, with Full sensor on): where each microlens really is. The lenses sit a little off their regular grid, each by a different amount, which can show as a pattern at the lens grid's period in out-of-focus areas at 3× and 4×. *Automatic* uses the camera's white images when its calibration has been imported (Settings > Camera calibration) and otherwise the white image stored in the photo; *Camera calibration* and *Measured from photo* use one of those only; *Off* uses the regular grid. On the photos tried the offsets are small (about 0.07 sensor pixel), so this changes the picture very little. The *Lattice filter* takes out what is left of the pattern at 3× and 4×.

## Upscaling

Settings for every enlarged picture, photo or video. *Method*: *Lanczos (sharp)*, a filter that keeps edges crisp; *Smooth*, the softer ordinary enlarging; or *FSR 1* (AMD FidelityFX Super Resolution 1), which enlarges along the edges it finds and then sharpens with its built-in contrast-adaptive sharpening. All three run on the graphics card, or on the processor where WebGL 2 is not available (slower). When a picture is made smaller, FSR 1 uses Lanczos.

Optional *upscaling models* (Real-ESRGAN general, fast, 5 MB; SPAN x4, fast and light, 2 MB; Real-ESRGAN x4plus, best quality, 64 MB) are not part of the app's download. Tick one under Settings > Upscaling models to download it (it is checked and kept on this computer, in the desktop app, or in the browser's cache in the browser version; untick it to delete it), and it then appears in the *Method* list. They run on the graphics card (WebGPU) and enlarge a *saved photo*: the picture is made again at 16 bits, enlarged four times by the model tile by tile, and brought to the Photo *Size* (a smaller size than 4× is a reduction by Lanczos). The picture on show, videos and 3D images use Lanczos. Models invent plausible fine detail rather than recover real detail; pictures above about 6 million pixels are too large for them. Real-ESRGAN is by Xintao Wang et al., BSD 3-Clause licensed; SPAN x4 is Philip Hofmann's 4xNomosUni_span_multijpg (a SPAN network by Wan et al.), CC BY 4.0. Copies of the model files are in the repository's `models` folder and are checked for updates every week; a model that was replaced is downloaded again by the app by itself. *About* lists each model's author and license.

- *Sharpen:* sharpens the enlarged picture to bring back crispness lost in enlarging; 0 for none (25 by default). With FSR 1 it sets the strength of FSR's built-in sharpening. It has no effect at *Native* size.

Each method keeps its settings: the sliders under *Method* show the chosen method's, and changing the method brings back the values you last used with it (all of them are saved with the photo). Beyond *Sharpen* (called *Sharpness (RCAS)* for FSR 1):

- *Lobes* (Lanczos only, 2 to 4, 3 by default): the filter's width. 2 is softer with less ringing at edges, 4 is crisper with more.
- For a downloaded model: *Model strength* (how much of the model's result is used, the rest being the plain enlargement), *Clean up first* (smooths noise in the picture before the model sees it, keeping strong edges, so the model does not take noise for texture; 0 for none) and *Grain* (fine film-like grain on the result, mostly in the mid-tones, because a model's picture is smoother than a photograph; 0 for none). *Sharpen* then sharpens the model's enlargement.

The pictures in the app are enlarged the same way: the picture on screen is shown at the Photo *Size*, and animation frames at the Video *Size* (when it is a height such as 1080p), with these settings, so what you see is what is saved or exported. (Not while a slider or the picture is being dragged.)

Enlarging adds pixels, not detail. For the most detail, render with *Full sensor* and enlarge that.

## Speed

With *Full sensor* on, a change of focus (or of the blur, the bokeh or the color) makes the picture again from the all-in-focus picture kept on the graphics card, so only the blur and the color pass are done again (the progress reads *Applying the changes to the kept picture*, and no quick look is drawn first); the rays are not rendered and every depth is not focused once more. A change that alters the all-in-focus picture itself (the photo's depth settings, the scale, Detail recovery, the viewpoint) renders it again. Rendering runs on the GPU (WebGL 2); without it, on the CPU, much more slowly (the CPU path shares the work of building a photo's views among up to three helper workers, which are shut down when they are done). On computers with two graphics chips (many laptops) Illuminator asks for the faster one. While you drag a slider or the picture, strong depth of field blur is drawn as a quicker draft; the finished picture follows when you let go. [[Histogram and Info]] shows the renderer in use and, where the browser can measure it, the GPU time per view.

## Photo

Photo and Video are the last two subsections of *Render Settings*. Below Render Settings, always shown: *Render*, *Auto render*, *Save PNG* and *Export video*.

- *Size:* how much saved photos and 3D images are enlarged: *Native* (as rendered), 1.5×, 2×, 3× or 4×, with the [Upscaling](#upscaling) settings. Each option shows the size in pixels it gives.
- *File format:* *PNG* (lossless, bigger files), *PNG 16-bit*, *JPEG* (much smaller files) or *JPEG HDR* (a JPEG that also keeps the highlights brighter than white) or *TIFF HDR* (a 32-bit float TIFF in linear light); both HDR formats are always sRGB, see Exporting. For the JPEGs, *JPEG quality* (50 to 100, 92 by default) sets how much detail is kept.
- *Color space:* *sRGB* (the default), *Display P3*, *Adobe RGB (1998)*, *Rec. 2020* or *ProPhoto RGB*. The saved photo is converted to that space and its profile is saved in the file (PNG, 16-bit PNG and JPEG), so other software reads the colors right. The picture is made in sRGB, so a wider space does not add colors beyond sRGB's range; it suits software or displays that work in that space, and editing at 16 bits (*PNG 16-bit*) keeps the most precision. Quick export has the same setting.
- *Save PNG* (or *Save JPEG*), below the Render button, saves the picture as shown, at that size.

## Video

- *Size:* *1080p*, *1440p* or *4K (2160p)* keep the shape of the crop, with that many pixels on the short side. The *Social media* sizes have a fixed shape and take the largest centered part of the picture with it:
  - 9:16, 1080 × 1920: Instagram Reels, TikTok, YouTube Shorts, Stories (and 2160 × 3840 for 4K vertical)
  - 4:5, 1080 × 1350: Instagram and Facebook feed posts
  - 1:1, 1080 × 1080: square posts
  - 16:9, 1920 × 1080: YouTube, X, LinkedIn (and 3840 × 2160 for YouTube 4K)

  For a part of the picture other than the center, first crop to the same shape (Crop → *Aspect ratio*). Frames are enlarged with the [Upscaling](#upscaling) settings; frames larger than the video are reduced with a filter that keeps fine detail from flickering.
- *Compression:* the codec. WebM: *VP9*, *VP8* or *AV1*; MP4: *H.264*, *H.265 (HEVC)* or *AV1*. Only the kinds this browser or computer can record are offered; the others are marked *not available here*. H.265 depends on the computer's video hardware.
- *File format:* *MP4* (plays nearly everywhere; the default, with *H.264*) or *WebM* (plays in browsers and most players).
- *Quality:* the video's bitrate, 1 to 40 Mbit/s (16 by default). Higher keeps more detail and makes bigger files; for 4K, 30 or more works well.
- *Export video* saves the animation, at the current *Resolution*, or with *Full sensor* on, every frame rendered from the whole sensor with its *Scale* and *Detail recovery*. See [[Exporting]].
