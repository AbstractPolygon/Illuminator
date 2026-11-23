# Light L16 experiments

Scripts used to work out how to read `.lri` files and measure depth between the camera modules (not part of the app yet).

- `inspect.mjs FILE...`: lists the modules, sizes, formats and exposure of a capture.
- `preview.mjs FILE MODULE OUT.png`: half size picture from one module (simple binning, white balance from the header).
- `depth.mjs FILE OUT.png [SCALE] [STEPS]`: depth of a capture with the app code (core/l16depth.js), written as a color picture and a confidence picture; `REF=B4` picks the reference module. Works on a group of modules of one focal length (A1 to A5, or B1 to B5): the fixed 28 mm modules use their calibration pose, the B and C modules the pose of their tilting mirror.
