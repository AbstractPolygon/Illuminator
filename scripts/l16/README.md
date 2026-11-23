# Light L16 experiments

Scripts used to work out how to read `.lri` files and measure depth between the camera modules (not part of the app yet).

- `inspect.mjs FILE...`: lists the modules, sizes, formats and exposure of a capture.
- `preview.mjs FILE MODULE OUT.png`: half size picture from one module (simple binning, white balance from the header).
- `depth-prototype.mjs FILE OUT.png [SCALE]`: plane sweep depth from A1 against A3, A4 and A5 with the factory calibration (intrinsics from the lens position, canonical extrinsics, polynomial distortion). Works on the 28 mm modules only; the B and C modules sit behind movable mirrors and need the mirror geometry first.
