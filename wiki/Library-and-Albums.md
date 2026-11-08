# Library and Albums

## The library

Every photo you open, drop or import is copied into the library, each in a separate folder with its edits next to it. Your original files are never changed.

- **Desktop app:** the library is a folder, `Pictures/Illuminator` by default (a library already in `Pictures/ILLUMinator` stays there). Change it in **Settings → Library location → Choose folder…**.
- **Processed version:** next to each photo the desktop app keeps what it measured (the depth map and the focus offset, `processed.illuminator.bin`) the last few full sensor renders, and the last two full sensor pictures before their color pass (so changing Process or Optics settings on a reopened photo does not combine the sensor's rays again), so reopening a photo is quicker. They are made again when the photo's settings or the app version change.
- **Open in Explorer / Finder:** the photo's ••• menu in the left sidebar opens its folder (desktop app only).
- **Browser:** the library is kept in the browser's private storage for the site. If the browser cannot store files (some private windows), photos are kept until the page is closed, and the sidebar says so.

The library folder looks like this:

```
library.json                        the list of photos and albums
Photos/IMG_0001/IMG_0001.LFR        the photo
               /edits.illuminator.json   its edits
               /thumb.jpg           its thumbnail
Photos/Beach/raw.lfp                imported from Lytro Desktop
            /stack.view.lfp         with Lytro Desktop's edits
            /stack.lfp              Lytro Desktop's picture, with the depth it computed
            /stack.userdepthmap.png a depth map edited in Lytro Desktop, with its .txt
```

The folders are the truth: copy a photo folder into `Photos/` and it appears in the library the next time it opens; delete one and it disappears. The same photo is never added twice (photos are recognized by their content, not their name).

## Albums

Albums are listed at the top of the left sidebar.

- **New album:** *+ New album*, type a name, Enter.
- **Import a Lytro Desktop library:** *+ Import Lytro library…*, under *+ New album*. See [[Importing]].
- **Add photos:** drag photos from the list or the grid onto an album, or use **•••** on a photo and tick albums.
- **Remove from an album:** **•••** on the photo, untick the album.
- **Rename or delete an album:** **•••** next to the album. Deleting an album keeps its photos in the library.
- **Export an album:** **•••** next to the album → *Export album…* saves one `.zip` with the album's original photos, their edits, Lytro Desktop edits and thumbnails. Drop that file on the window in another library, such as the desktop app's after using the browser version, and the photos join that library with their edits and the album is made again.
- **Photo menu:** **•••** on a photo, or right-click it, in the list or the grid.
- **Copy settings to other photos:** on the photo with the look you want, **•••** → *Copy settings*; then on each other photo, **•••** → *Paste settings from …*. Every setting comes across except the focus point clicked and the viewpoint, which belong to each scene.
- **Reset a photo's settings:** **•••** on the photo → *Reset settings…* puts every setting in the right sidebar back to how a newly opened photo starts: adjustments, keyframes, local adjustments, crop and export settings. Edits from Lytro Desktop are not applied again.
- **Delete a photo:** **•••** on the photo → *Delete from library…*. In the desktop app its folder goes to the trash.

## Looks

A look is the color and tone of a photo's edits, kept so you can put it on other photos and share it. The **Looks** list is under *Library* in the left sidebar.

- **+ Save look…** keeps the open photo's tone, color, curves, film look and LUT. The dialog names the look and lets you choose what else goes in it: sharpening and noise reduction (on), local adjustments (on) and white balance (off, because it belongs to the light of each photo). The focus, viewpoint, crop and export settings are never part of a look.
- **Click a look** to put it on the open photo. Its settings replace the photo's for the same controls and the rest of the photo's settings stay; it is one undo step (Ctrl+Z). A look with local adjustments replaces the photo's local adjustments.
- **•••** next to a look: *Apply to the open photo*, *Save as a file…*, *Rename…*, *Delete look…* (photos it was put on keep their settings).
- **Save as a file…** writes a `.illuminator-look` file, a small text file you can send to anyone. **+ Import look…** adds such a file to your list (more than one can be chosen). A file that is not a look is refused with a message.

Looks are kept in the library, next to the photos and albums. To put a look on a whole album and export it, use the [[Render]] Queue's *Choose all* and *Look* list.

## Ratings, flags and keywords

Mark photos so they are easy to find again. **•••** on a photo → *Rating, flag and keywords…* opens a small window: a rating of one to five stars, a flag (*Picked* or *Rejected*) and keywords separated by commas. The open photo can be marked from the keyboard: Shift + 1 to 5 rate it, Shift + 0 clears the rating, Shift + P picks (again to unpick), Shift + X rejects (again to undo), Shift + U clears the flag. Stars and the flag show under each photo in the list and the grid; hover for the keywords.

Above the list, *Any rating*, *Any flag* and *Keyword or name* narrow what is shown: photos with at least a rating, picked, rejected, not rejected or unflagged ones, and photos with a keyword (or a name) containing the text; the keyword box suggests the keywords already in use. *Clear filter* shows everything again. A filter changes only what is listed: nothing is hidden from albums or deleted.

The marks are kept in the library and also written next to each photo as an XMP file (for IMG_0001.LFR, `IMG_0001.xmp` in the photo's folder: `xmp:Rating`, `xmpDM:pick` and `dc:subject` keywords, a rejected photo as rating −1), which Lightroom, Bridge, digiKam and similar programs read. An exported album carries its photos' marks.

Photos you open while an album is selected are added to that album too.

## Thumbnail grid

Choosing *All photos* or an album shows its photos as a grid in the middle of the window. Make the thumbnails bigger or smaller with the slider and <img src="images/thumb-smaller.png" width="20" height="20" alt="Smaller thumbnails"> <img src="images/thumb-bigger.png" width="20" height="20" alt="Bigger thumbnails"> above the grid, or the **+** and **−** keys. Click a thumbnail (or select it and press Enter) to open the photo.
