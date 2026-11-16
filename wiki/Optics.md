# Optics

## Bokeh

The shape of out-of-focus highlights: *Natural*, *Optical (softer)*, *Circle*, *Blades*, *Star*, *Heart* or *Custom image*, and *Highlights* to make bright points glow into bokeh balls.

- *Natural*: the blur is drawn from the depth map as a soft glow (a Gaussian).
- *Optical (softer)*: up to the camera's widest f-stop (f/2), and with *Depth* at 0 and no *Focus Spread* or *Tilt*, it refocuses by averaging the camera's real views, so the blur is the lens's own: softer, and what is in focus is a little softer too. Any blur past that (wider f-stops, *Depth*, *Focus Spread*, *Tilt*) is drawn as a disc with a soft edge, like a real lens's bokeh ball. The preview above *Shape* shows one out-of-focus point of light with the current settings (brighter with more *Highlights*). *Blades*, *Points*, *Inner radius*, *Outer radius*, *Width*, *Oval*, *Rotation*, *Onion*, *Irregularity*, *Ring blur*, *Spots*, every Bokeh character and Glow and flare setting and *Highlights* can be keyframed. On the processor (without a graphics card) the rings keep their spacing, blur and shape but not their wobble round the ball, and there are no spots.

- *Custom image*: *Load shape image…* takes any picture and uses it as the bokeh's shape: white is where light passes, black lets none through, and gray lets some through. It is fitted into a square and centered, so draw the shape on black (a star, a heart, a letter). *Rotation* and *Onion* work on it too, and it is saved with the photo. Very small balls (under about 2 pixels across) stay round.
- *Star*: *Points* (3 to 12), *Inner radius* (how deep the notches between the points go; lower is a thinner, spikier star) and *Outer radius* (how far the tips reach, 30 to 100% of the ball's size).
- *Heart*: *Width* (60 to 140%).
- *Blades* (Blades shape): the number of aperture blades, 3 to 32, which is the number of sides of each bokeh ball.
- *Oval* (Circle shape): stretches the circle into an oval, like the cat's-eye bokeh near the edges of a fast lens.
- *Rotation* (Circle, Blades, Star, Heart and Custom image): turns the shape.
- *Onion* (Circle, Blades, Star, Heart and Custom image): fine concentric rings inside each bokeh ball, like the marks a molded aspherical lens element leaves: closer together and stronger toward the edge, with a brighter rim. The rings follow the ball's shape (ovals in an oval, stars in a star). With some Onion, *Irregularity* makes them uneven (spacing, strength and roundness vary round the ball, with fine grain; 50 by default) and *Ring blur* softens them (30 by default). *Rings warp* bends the whole ring pattern out of round (off center, oval, wavy; 0 by default). *Onion rings* (the checkbox above them) turns the rings off with their settings kept: with it off, no ring is made or drawn, so the blur costs no more for them.
- *Size* (all shapes): scales the bokeh balls in the picture, 25 to 400 percent of the lens's blur (100 by default). It can be keyframed.
- *Spots* (the same shapes): dust specks and a few faint bubble rings inside each bokeh ball, as from dust on the lens's glass (0, none, by default).
- *Bokeh character* (a group under the shapes, for Circle, Blades, Star, Heart and Custom image; all 0 by default):
  - *Cat's-eye*: near the frame's edge the lens's barrel clips each ball into a lens shape that is narrow toward the center of the frame, as with fast lenses (the effect of vignetting on bokeh balls). The preview shows the ball as it looks near a corner. *Swirl* (with some Cat's-eye) turns those lenses around the center, for swirly bokeh.
  - *Edge*: a brighter rim on each ball (above 0) or a darker, softer edge (below 0). *Front / back* adds to the rim for what is behind the focus and takes from it in front (above 0), or the reverse (below 0): many lenses give a bright-rimmed background and a soft-edged foreground.
  - *Bubble*: soap bubble bokeh: a clear center and a bright rim with rainbow colors.
  - *Hole*: a dark hole in the middle of each ball, as from a mirror lens (donut bokeh).
  - *Color fringe*: each color's ball is a little larger or smaller than the others, so the rims are magenta in front of the focus and green behind it.
  - *Hot spot*: a bright glow in the middle of each ball.
  - *Grain*: a fixed texture inside each ball, as from pores in the glass.
  - *Diffraction*: fine rings at the rim of each ball.
  Each part keeps the ball's total light, so turning it up does not brighten or darken the picture. Without a graphics card, the processor's blur shows Edge, Bubble's shape (not its colors), Hole, Hot spot, Grain and Diffraction, but not Cat's-eye, Swirl, Front / back or Color fringe.
- *Glow and flare* (a group of its own; all 0 by default): lens effects round the bright parts of the picture, drawn after the blur and with or without it. They work on any bokeh shape, and on pictures with bright light (parts near white; nothing is added where there is none).
  - *Streaks* (with *Streak length* and *Streak threshold*): a thin horizontal streak of bluish light through bright points, as from an anamorphic lens. *Streak threshold* is how bright a point must be to streak, as a share of white (70 by default; lower makes more streaks). Only small bright points streak: a large bright area does not.
  - *Starburst* (with *Spikes*, 3 to 16): thin spikes of light from bright points, as from a lens stopped down. The light stays the same with more or fewer spikes.
  - *Ghosts*: faint, colored copies of bright parts along the line through the center of the frame, as in-lens reflections.
  - *Fog*: a soft glow round bright parts that lifts the shadows near them (veiling glare).
  - *Dirty lens*: bright parts light up a fixed pattern of smudges and specks, as from dirt on the glass.
  The processor's version (without a graphics card) draws the same effects with a little less smooth streaks and ghosts.

## Chromatic Aberration

Removes colored fringes along high-contrast edges. *Enabled*, *Auto* (finds the fringe colors by itself), *Radius*, *Threshold*, and amount and hue for purple, green, red and blue fringes.

## Lens Correction

- *Correct lens distortion* (on by default): corrects the camera lens's distortion for the zoom the photo was taken at, the way Lytro Desktop does. It bends the picture outward toward the corners, a little at wide zoom and about 10% of the way to the corner at full zoom. The distortion table was measured against Lytro Desktop's pictures of 15 ILLUM photos. Photos from cameras that do not record a zoom are left alone.
- *Distortion:* adds to that correction. Negative straightens barrel distortion (lines bowing outward), positive pincushion. The picture is enlarged just enough that no edge shows.
- *Vignetting:* brightens (or darkens) the corners; *Midpoint* sets how far from the middle it starts.

## Flare

*Reduce flare* removes the haze that light scattered in the lens lays over the picture; *Amount* sets how much.
