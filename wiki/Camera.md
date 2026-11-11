# Camera

The light field controls. Each can be animated: the <img src="images/key-prev.png" width="8" height="14" alt="previous keyframe"> ◆ <img src="images/key-next.png" width="8" height="14" alt="next keyframe"> at the right of a setting adds or removes its keyframes and moves between them (see [[Animation]]).

## Depth

- *Aperture:* f/22 to f/0.5. Small apertures keep everything sharp (at f/22 the app first shows a quick view, and once the photo's depth has been measured (by opening the aperture or clicking to focus), and you stop changing things, it makes the all-in-focus picture from every sensor pixel in the background, at twice the view's size, and swaps it in; any change goes back to the quick view; this needs a graphics card, and is skipped if a step had to fall back to the CPU); wide ones blur what is away from the focus (click the picture to choose what is in focus). Beyond f/2, the widest the camera can record, the blur is synthetic, using the depth map.
- *Depth:* how quickly things blur away from the focus.
- *Smoothing:* smooths the depth map, following the picture's edges.
- *Depth ruler:* the strip under the *Depth* slider shows how much of the picture lies at each depth: nearer to the left (blue), farther to the right (orange). The white line is the focus, and the part of the curve that is lit is the sharp range from *Spread*. Click or drag on it to move the focus; the number under the line is the focus value. It appears once the photo's depth has been measured.
- *Focus peaking:* marks the sharp edges of the picture in green, so you can see what is in focus. It looks at the picture as shown, so it follows the aperture, the focus and the viewpoint, and blurred edges are not marked. *Peaking level* sets how strong an edge has to be: higher marks more. Like *Show spread*, it is a view aid and is not saved with the photo.
- *Depth method:* how the depth map is measured. *Classic Desktop* (the default) is Lytro Desktop's style: the engine's way for raw camera photos, and the Lytro-style measurement for the rest. *Illuminator* is Illuminator's measurement (a plain cost volume). *Blended* mixes the two, with a *Blend* slider from Illuminator's depth (0) to Classic Desktop's (100). Measuring is done on the graphics card where there is a real one; if a step has to be done on the processor instead, a note says so. A photo's measured depth is kept next to it in the library (desktop app), so reopening it is quicker.
- *Depth models:* Depth Anything V2 Small (99 MB, Apache-2.0) and MiDaS v2.1 Small (66 MB, MIT; authors and licenses are listed in *About*) are optional downloads in Settings > Depth models, in the desktop app and in the browser version (ticking a box downloads it, unticking removes it; the browser keeps it in its cache, which it may clear, and runs it on WebGPU where the browser has it, else on the CPU). A downloaded model is then a choice under *Depth method*. It looks at the picture as a whole and gives clean object edges and an answer on glossy or blank surfaces; its depth is relative, so Illuminator fits it to the measured depth, and *Model blend* sets the mix (0 is the measured depth alone, 100 the model's alone; 70 by default). *Model smoothing* blurs the model's depth before it is fitted (for a noisy or blocky model; 0 by default) and *Model curve* bends it (below 50 pulls the middle distances toward the far end, above 50 toward the near end; 50 by default). Each model keeps its three settings: choosing a model brings back the values you last used with it, and they are saved with the photo. The model runs once per photo (a few seconds on the graphics card or the CPU); the blend, smoothing and contrast then change at once. It sees through a blurred fence the way a person does, so for a thin out-of-focus foreground the measured depth is the better one: lower the blend.
- *Lytro Desktop depth map:* shown for photos imported from a Lytro Desktop library. On, the depth map Lytro Desktop computed (or the one edited there) is used for blur and depth masks; off, depth is measured from the light field as for any other photo. Lytro's map is usually the better one where the picture is blank or out of focus, such as a plain wall behind the subject.
- *Object edges:* finds the objects in the photo and puts the depth map's edges on their outlines, so depth steps are clean instead of blocky. It works with or without *High quality depth map*. The first time it is turned on, it downloads an object model (about 45 MB, kept afterwards); finding the objects takes several seconds per photo, and on a computer with a graphics card most of that work (the model itself, the picture's preparation and the clean-up of the depth map) runs on the card.
- *High quality depth map:* sharper depth edges that match the photo, and depth found even on far, very out-of-focus surfaces (a textured wall behind the subject), about two to three times as slow to measure. On by default; off, the faster, blockier depth map is used.
- *Show depth map:* shows the depth map in color. It stays on while you change settings, move the viewpoint or press Render (the full sensor still is made meanwhile and shows when the depth map is turned off).
- *Grayscale:* (next to Show depth map) shows the depth map in gray instead of in color.
- *Depth map contrast:* stretches the depth over a narrower range, so small differences show more (Lytro Desktop's depth maps look this way). It reshapes the depth itself, so the depth map and the depth of field change together.
- *Apply to perspective shift:* also moves the viewpoint's parallax by the reshaped depth, so near and far objects slide against each other as much as the contrast makes their depth differ. It applies to the camera view and animations; a Full sensor render keeps the measured parallax.

## Focus Spread

- *Focus Point:* where you last clicked; spread and tilt are centered there.
- *Spread:* a range of depth kept sharp on each side of the focus.
- *Smoothing:* softens the edges of that range, so blur builds up gradually.
- *Blur:* feathers the spread in the picture: the map of how much each pixel is blurred is smoothed across the picture, so where the sharp range meets blurred areas the change is gradual (and depth map errors show less). It does not blur the picture itself; Smoothing works on depth, Blur on the picture's area.
- *Show spread:* tints what lies outside it, blue nearer and orange farther.

## Tilt

Tilts the plane of focus, like a tilt-shift lens: *Tilt* is the amount, *Rotation* the direction. *Enabled* turns the tilt off and on without losing the settings.

*Preset* gives one-click starting points: *Miniature (horizontal band)* and *Miniature (vertical band)* (a sharp band with strong blur on both sides, a wide aperture and richer color: the toy-model look), *Landscape tilt* (a gentle tilt that keeps the ground sharp from near to far), *Diagonal tilt*, and *Tilt off*. A preset sets the tilt, rotation, spread, aperture and blur (and for a miniature, *Saturation*) in one step, which one Undo takes back; adjust from there. How it looks depends on the photo's depth: a miniature works best on a scene that recedes, such as a street seen from above.

*Show tilt* tints the picture by how far each part lies from the tilted plane of focus, blue nearer and orange farther, clear where it is in focus. It and *Show spread* switch each other off.

## Perspective

*Viewpoint* shows where the viewpoint is (drag on the picture to move it), as a share of the lens aperture across and down; *Center* is the middle.

*Reach* sets how far the viewpoint can move, as a share of the lens's opening (100% to 300%). Up to 100% the picture uses only the views the camera recorded. With the aperture closed (f/22, as a photo opens), real views go farther still: as far as the lens images stay at least 40% as bright as their centers, which the app measures for each photo and each direction (often 120 to 150%; less on some zoomed-in ILLUM photos). Past that, the picture is rendered at the edge of the opening and moved on by the depth map, so the scene can turn farther; the edges of near objects and the background they uncover can smear (more so the farther past 100%, and wherever the depth map is wrong, such as thin wires or glass). Reach applies to dragging the picture, the *Viewpoint* animation's *Amount*, 3D (*Baseline*) and VR. A *Full sensor* render keeps to 100%. For more real movement, zoom in when taking the photo: the lens's opening grows with the zoom (about 8 times from widest to longest on the ILLUM).

Moving the viewpoint shifts every depth but one, the focus plane (or, with the aperture closed, the depth the camera focused on). *Custom pivot* and *Pivot depth* choose another depth to stay still.

## Bokeh

The shape of out-of-focus highlights: *Natural*, *Optical (softer)*, *Circle* or *Blades*, and *Highlights* to make bright points glow into bokeh balls.

- *Blades* (Blades shape): the number of aperture blades, 3 to 32, which is the number of sides of each bokeh ball.
- *Oval* (Circle shape): stretches the circle into an oval, like the cat's-eye bokeh near the edges of a fast lens.
- *Rotation* (Circle and Blades): turns the blades or the oval.
- *Onion* (Circle and Blades): concentric rings inside each bokeh ball, like those from aspherical lens elements.
