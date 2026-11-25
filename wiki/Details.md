# Details

## Sharpening

*Amount*, *Radius*, *Detail* (lower holds back strong edges, for fewer halos) and *Masking* (sharpen only edges: 0 everywhere, 100 only the strongest edges).

## Noise Reduction

*Multi-view* (on by default) averages the many viewpoints a light field holds (with *Blend*; not at f/16 and f/22, where the picture is fully in focus and the plain view is sharper), then *Luminance* and *Color* noise reduction.

*Dust* fills small, faint dark spots left by dust on the sensor or lens; higher values remove larger spots. Strong dark detail, like eyes and lettering, is left alone. *Despeckle* removes small bright or dark specks, filling them from the surroundings; *Speck size* sets the largest speck removed (1 to 5 pixels across). Larger spots, lines and edges are kept. *Remove hot pixels* (on by default) finds hot, warm and dead pixels on the sensor and fills them from their neighbors before the picture is made; the photo's Info shows how many were fixed. On a Light L16 photo taken with a long exposure (over a quarter second), fainter warm pixels and pairs of them are found too, and small spots of one strong color left after the cameras are merged (warm pixels and reflections in the cameras' mirrors, which show as green, yellow, magenta and cyan dots in a dark photo) are filled from around them, in every view: the picture, the zoomed-in detail, a full size render and a moved viewpoint. When the camera's calibration has been added (see below), the pixels it lists as defective are always fixed as well.
