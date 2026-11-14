# Retouch

The **Retouch** section (above Crop) removes blemishes: dust on the sensor, a spot on a face, a distracting speck. More tools will join it.

## Spot removal

1. Open the **Retouch** section and press **Spot removal**.
2. Click the blemish. A solid circle marks it and a dashed circle marks the **source**, the place the patch is copied from. They start side by side.
3. Drag the dashed circle to a clean area that looks like what should be under the blemish. Drag the solid circle to move the blemish (its source moves with it).

Press **Escape** or the button again to leave the tool. *Show spots* hides the circles; the spots keep working.

Each spot has:

- **Mode:** *Heal* matches the color around the blemish, so a patch from a lighter or darker place blends in. *Clone* copies the source as it is.
- **Size:** the radius of the spot.
- **Feather:** how much of the edge fades out.
- **Opacity:** how much of the copy shows.
- **Depth** and **Source depth:** how far the blemish and the source are, read from the depth map when the spot is placed.

Spots belong to the scene, not only to the picture. When the viewpoint moves, or the focus changes, a spot follows the scene at its depth, so it stays on the blemish. Where the depth map is wrong (thin wires, glass), a spot can slip: drag **Depth** or **Source depth** until it stays put. Double-click a slider to reset it.

A photo can have up to 32 spots. They are saved with the photo's edits (not in looks, since a spot belongs to one photo).
