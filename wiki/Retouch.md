# Retouch

The **Retouch** section (above Crop) removes blemishes and red-eye: dust on the sensor, a spot on a face, a scratch or a wire, red pupils. It has five tools, as icons: select and move, spot removal, the healing brush, content-aware fill and red-eye. It can also visualize spots (to find dust) and copy and paste spots between photos. The select tool picks a spot or stroke and drags it or its dashed source. The brush mask and the adjustment brushes (soften skin, whiten teeth and others) are in Local Adjustments: see [Local Adjustments](Local-Adjustments).

## Spot removal

1. Open the **Retouch** section and press the **Spot removal** icon (two circles).
2. Click the blemish. A solid circle marks it and a dashed circle marks the **source**, the place the patch is copied from. They start side by side.
3. Drag the dashed circle to a clean area that looks like what should be under the blemish. Drag the solid circle to move the blemish (its source moves with it).

Press **Escape** or the icon again to leave the tool. *Show spots* hides the circles; the spots keep working.

## Healing brush

Press the **Healing brush** icon (a brush) and paint over a blemish or a line, such as a scratch, a hair or a wire. When you let go, a dashed copy of the stroke appears beside it: that is where the patch is taken from. Drag the dashed copy to a clean area (or drag the stroke to move both). The stroke heals along its whole length, matching the color as it goes. Its **Size**, **Feather** and **Opacity** are in the spot's controls. A stroke is anchored to the scene like a spot.

## Red-eye

Press the **Red-eye** icon (an eye) and click a red pupil. Red pixels inside the circle become neutral and darker; the rest of the circle is left alone. **Size** sets the circle (make it just bigger than the pupil), **Feather** softens its edge and **Opacity** sets how strong the correction is.

## Each spot, stroke or eye has


- **Mode:** *Heal* matches the color around the blemish, so a patch from a lighter or darker place blends in. *Clone* copies the source as it is. *Red-eye* corrects red pupils.
- **Size:** the radius of the spot.
- **Feather:** how much of the edge fades out.
- **Opacity:** how much of the copy shows.
- **Depth** and **Source depth:** how far the blemish and the source are, read from the depth map when the spot is placed.

Spots belong to the scene, not only to the picture. When the viewpoint moves, or the focus changes, a spot follows the scene at its depth, so it stays on the blemish. Where the depth map is wrong (thin wires, glass), a spot can slip: drag **Depth** or **Source depth** until it stays put. Double-click a slider to reset it.

A photo can have up to 32 spots, strokes and eyes in all. They are saved with the photo's edits (not in looks, since a spot belongs to one photo).

## Content-aware fill

Press the **Content-aware fill** icon and paint over an object or a blemish too big for a spot (a sign, a wire, a person far off). The app looks for the part of the picture whose surroundings look most like the surroundings of what you painted, and copies from there, blending the color as the healing brush does. It is a healing stroke with its source chosen for you: drag the dashed copy if it picked a poor place, or press **Find best source** on any spot or stroke to choose again. It works best on repeating or plain backgrounds (grass, sky, walls, water); it does not invent what is not in the picture.

## Visualize spots

**Visualize spots** shows the picture as fine detail only, black where it is smooth, so dust, hairs and blemishes show up as bright dots and are easy to find. **Sensitivity** sets how bright. Untick it to see the picture again.

## Copy and paste spots

**Copy spots** keeps the spots of the photo; **Paste spots** adds them to the photo that is open. Dust on the sensor is in the same place in every photo from one camera, so one set of spots can clean a whole series. The spots keep their positions and depths; check them (the select tool helps) and move any that land on something else. The copy is kept for the next start too.
