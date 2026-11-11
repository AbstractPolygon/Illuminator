# Importing

## From Lytro Desktop

*+ Import Lytro library…* in the left sidebar (under *+ New album*), or **Settings → Import Lytro Desktop library…**, then choose your Lytro Desktop library folder. This needs the desktop app; in the browser version the button explains this and links to the download. The folder is usually:

- macOS: `Pictures/Lytro Desktop/Libraries/Lytro Library.lytrolibrary`
- Windows: `Pictures\Lytro Desktop\Libraries\Lytro Library.lytrolibrary`

Every picture in it (and in all its subfolders) is added to the library, in a new album named after the folder. The same works for any folder of Lytro photos, such as a copy of a camera card.

The edits you made in Lytro Desktop come along: when a picture is first opened, Illuminator applies them and says so in a note over the picture. Edits it does not support yet are listed in that note. Once you change something, Illuminator saves the edits in its format and uses them from then on.

What carries over from Lytro Desktop:

- *Camera:* focus, focus point, aperture, focus spread, tilt, viewpoint and perspective pivot.
- *Process:* exposure, white balance, contrast, highlights, shadows, whites, blacks, saturation, vibrance, per-color saturation, the tone curve (its points and its Highlights, Lights, Darks and Shadows) and a custom color matrix.
- *Details and Optics:* sharpening (amount, radius, detail, edge masking), noise reduction, defringe and reduce flare.
- *Crop:* crop, straighten and orientation.
- *Animation:* every animated setting becomes keyframes, curves included, with Keyframe animation turned on: focus, focus point, aperture, focus spread, tilt, viewpoint, pivot, zoom, pan, exposure, white balance, the tone sliders, saturation and defringe threshold. Zoom and pan carry over when they are not animated too.
- *Effects:* each of Lytro Desktop's effect layers becomes a local adjustment, named *Lytro effect 1*, *2* and so on: its ellipse or depth range as the mask, and its exposure, contrast, brightness, saturation and black and white as the effects. Lytro's living filters Film Noir, Carnival, Mosaic, Crayon, Blur+ and Pop become Illuminator's filters of the same kind.
- *3D:* the stereo baseline.
- *Depth map:* the depth map Lytro Desktop computed (in `stack.lfp`) is kept with the photo and used for blur and depth masks; one edited in Lytro Desktop (`stack.userdepthmap.png`) is kept too and used first. *Lytro Desktop depth map* under [[Camera]] → Depth turns it off.

Some things have no equivalent yet and are listed in the note: animated sharpening, noise reduction, defringe radius and 3D (they keep their starting value), the 3D pivot, the Glass, Line Art and 8-Track filters, and effects that shift hues, fill with a color, insert an image or combine a place and a depth mask (these keep the place). Depth ranges of effects are matched to a typical picture's depth, so check them on photos with a very deep or very shallow scene.

Importing the same library again replaces the photos already imported from it (matched by name) with the new files: their Lytro Desktop edits apply again and changes made in Illuminator start over. They keep their place in albums.

Lytro Desktop keeps its albums in a database Illuminator does not read, so they are not imported; the album named after the folder holds everything instead.

## From another Illuminator library

An album exported with *Export album…* (see [[Library and Albums]]) is a `.zip`. Drop it on the window: its photos join the library with their edits, and the album is made again (or joined, if one has its name). A photo already in the library is not copied twice, and its edits there are kept. This is how to move photos from the browser version to the desktop app.

## From files

Drag files onto the window (in the desktop app, also *File → Import Lytro File…*). To bring Lytro Desktop's edits for a single picture, open its `raw.lfp` together with its `stack.view.lfp`; an exported `IMG_0001.LFP` opened with `IMG_0001.LFR` works the same way.

## Camera calibration

Every camera is calibrated at the factory, and the data is specific to that camera: a list of defective pixels, the lens grid at each zoom and focus setting, and white images. In the desktop app, open **Settings** (the gear at the top right) and use **Camera calibration** to add it (the browser version points to the desktop app instead), either from the camera's backup (a `.tar` file) or from its unpacked folder. Backups are over a gigabyte, so the app reads the file in place and keeps only the small files: the tables and the hot pixel list. The big white images stay where they are.

The calibration is kept in your library and applies to every photo taken with the same camera, matched by the serial number stored in the photo. Photos open with it the next time they are opened. **Remove** in the same place deletes it.

The camera's hot pixel list is used together with the search that *Remove hot pixels* does. The white images (one for each zoom and focus setting, 34 in an ILLUM backup) are measured while the backup is added, which takes a minute or so: each shows where every lens really sits, and only those centers are kept, a few hundred kilobytes per image. A photo made with one of them uses its lens centers directly, so it skips the measuring step it otherwise needs at its first full-resolution render. Lens grid tables and focus tables are added next.

*Lens centers* in the same place chooses where each lens's center comes from: the camera's calibration (the default when it has been added) or a measurement from each photo at its first full resolution render, which takes longer. The choice is kept for next time.

## From a camera

*Import from camera…* (desktop app) lists the photos on a connected Lytro camera, with their thumbnails, and imports the ones you pick (*Select all* and *Select none* are next to each other). The ILLUM shows up as a drive. The first generation Lytro is reached the way Lytro Desktop does it, through its disk, so no driver is needed on Windows; its photos are put together from the camera's raw, metadata and thumbnail files. The same photos also show in the *Camera* section above the library when a camera is plugged in.

### Over Wi-Fi

A Lytro camera can send its photos over Wi-Fi, without a cable (desktop app):

1. Turn on the camera's Wi-Fi. **First generation** (firmware 1.2 or later): swipe up on the screen to bring up the taskbar, then tap the Wi-Fi icon. **ILLUM**: *Settings*, *iOS Connect*, set *Access Point* to *On*; the camera shows its network name and password.
2. In the sidebar, under the library, click *+ Connect over Wi-Fi…*. Choose the camera's network (Lytro networks are listed first; *Refresh* looks again), type its password and click *Connect*. Illuminator joins the network through the computer's own Wi-Fi settings, so the computer is off the internet while it is joined; if the computer is on the camera's network already, no password is needed.

The camera then shows in the *Camera* section and in *Import from camera…* like a camera on USB, labeled *(Wi-Fi)*, and its photos import the same way. While connected, Illuminator asks the camera something every 30 seconds, so it does not turn its Wi-Fi off while you choose photos. When the camera stops answering (switched off, out of range, or its Wi-Fi turned off) it leaves the list; *Disconnect* in the same window ends the connection, and the computer stays on the camera's network until you join another. The password is passed to the computer's Wi-Fi settings and not kept by Illuminator (the computer remembers the network as it does any other).

Copying over Wi-Fi is slower than over USB: a first generation photo is about 16 MB, an ILLUM photo about 55 MB.

How Illuminator reaches the camera: first with the first generation camera's protocol (as worked out by the Lytro Meltdown project and ea's lytroctrl), at the camera's address and at the first address of the network joined; the ILLUM may speak it too, as Lytro's phone app served both cameras. If the camera does not answer it but offers Android debugging over the network (the ILLUM runs Android), Illuminator connects that way (adb must be installed), and the camera shows as it does on USB debugging. If neither works, the message lists the network ports the camera has open: please send it, so the camera can be supported. None of this has been tried with a real camera yet; it was tested against a stand-in camera.

First generation photos get Lytro Desktop's automatic level (an exposure found from the picture and the camera's ISO) and its color steps: the color is limited to the sensor's range before the color matrix, then a contrast curve is applied. *Look → Flat* turns this off.
