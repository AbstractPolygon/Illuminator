# Library and Albums

## The library

Every photo you open, drop or import is copied into the library, each in a separate folder with its edits next to it. Your original files are never changed.

A photo that is being opened for the first time takes a while (the light field is decoded, then its depth is measured and its refocus views prepared). While that happens its row in the sidebar and its tile in the grid show a small spinner, the picture area says what is going on (*Opening…*, then *Processing…*), and the bar under the picture shows the steps. The spinner goes when the first picture is drawn and the preparation is done.

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

## Several libraries

You can keep more than one library, each a separate set of photos and albums (one for a client, one for a trip, one on an external drive). The name at the top of the left sidebar is the library in use: click it for the list.

- **Switch:** choose a library in the list. The photo that is open closes, and the sidebar and grid show the other library.
- **Add one:** in the desktop app, *Add library folder…* chooses (or creates) a folder to keep a library in. In a browser, *New library…* asks for a name; each browser library is kept apart in the browser's storage.
- **Rename:** *Rename this library…* changes its name in the list (not its folder).
- **Remove:** in the desktop app, *Remove “name” from the list…* only takes it out of the list: its folder and photos stay where they are, and you can add the folder again later. In a browser a library is its storage, so *Delete library…* deletes its photos too, after asking. The library in use cannot be removed, and neither can a browser's first library.

*Settings* still shows where the library in use is kept and lets you move to another folder; that folder is added to the list too.

## Albums

Albums are listed at the top of the left sidebar. The arrow beside the library name folds the list away: only *All photos* and the album you are looking at stay. The arrow shows it again, and what you chose is remembered.

- **New album:** *+ New album*, type a name, Enter.
- **Import a Lytro Desktop library:** *+ Import Lytro library…*, under *+ New album*. See [[Importing]].
- **Add photos:** drag photos from the list or the grid onto an album, or use **•••** on a photo and tick albums.
- **Remove from an album:** **•••** on the photo, untick the album.
- **Rename or delete an album:** **•••** next to the album. Deleting an album keeps its photos in the library.
- **Export an album:** **•••** next to the album → *Export album…* saves one `.zip` with the album's original photos, their edits, Lytro Desktop edits and thumbnails. Drop that file on the window in another library, such as the desktop app's after using the browser version, and the photos join that library with their edits and the album is made again.
- **Photo menu:** **•••** on a photo, or right-click it, in the list or the grid.
- **Copy settings to other photos:** on the photo with the look you want, **•••** → *Copy settings*; then on each other photo, **•••** → *Paste settings from …*. Every setting comes across except the focus point clicked and the viewpoint, which belong to each scene.
- **Virtual copies:** **•••** → *Create virtual copy* makes another entry for the same photo, right after it in the list. It starts with the photo's settings and changes separately from then on, so one photo can have several looks (color, black and white, a different focus or bokeh) without storing the photo twice: a copy holds only its settings and caches; the light field files are the original's. A copy starts with no rating, flag or keywords; it can be in albums and exported like any photo, and deleting the original deletes its copies.
- **Reset a photo's settings:** **•••** on the photo → *Reset settings…* puts every setting in the right sidebar back to how a newly opened photo starts: adjustments, keyframes, local adjustments, crop and export settings. Edits from Lytro Desktop are not applied again.
- **Delete a photo:** **•••** on the photo → *Delete from library…*. In the desktop app its folder goes to the trash.
- **Delete several photos at once:** in the thumbnail grid (choose *All photos* or an album), press **Select** and click the photos to pick them, or hold **Ctrl** (**Cmd** on a Mac) while you click to pick any photo, and **Shift** to pick a range from the last one you clicked. **Select all** picks every photo shown. The bar shows how many are picked; **Delete…** (or the Delete key) asks once, then deletes them all, and in the desktop app their folders go to the trash. **Esc** clears the picks.

## Looks

A look is the color and tone of a photo's edits, kept so you can put it on other photos and share it. The **Looks** dropdown is at the top of *Process* in the right sidebar, above *LUT*.

- **+ Save look…** keeps the open photo's tone, color, curves, film look and LUT. The dialog names the look and lets you choose what else goes in it: sharpening and noise reduction (on), local adjustments (on) and white balance (off, because it belongs to the light of each photo). The focus, viewpoint, crop and export settings are never part of a look.
- **Choose a look** in the dropdown to put it on the open photo. Its settings replace the photo's for the same controls and the rest of the photo's settings stay; it is one undo step (Ctrl+Z). A look with local adjustments replaces the photo's local adjustments.
- **•••** next to the dropdown (for the look shown): *Apply to the open photo*, *Save as a file…*, *Rename…*, *Delete look…* (photos it was put on keep their settings).
- **Save as a file…** writes a `.illuminator-look` file, a small text file you can send to anyone. **+ Import look…** adds such a file to your list (more than one can be chosen). A file that is not a look is refused with a message.

Looks are kept in the library, next to the photos and albums. To put a look on a whole album and export it, use the [[Render]] Queue's *Choose all* and *Look* list.

## Ratings, flags and keywords

Mark photos so they are easy to find again. **The quickest way:** point at a photo's thumbnail, in the list or in the thumbnail grid. Five stars appear along the bottom (click a star to rate; click the star that is lit to clear the rating) and a checkbox at the top left (tick it to pick the photo, clear it to un-pick). A picked photo keeps its checkbox shown. On a touchscreen the stars and checkbox are always shown. **•••** on a photo → *Rating, flag and keywords…* opens a small window: a rating of one to five stars, a flag (*Picked* or *Rejected*) and keywords separated by commas. The open photo can be marked from the keyboard: Shift + 1 to 5 rate it, Shift + 0 clears the rating, Shift + P picks (again to unpick), Shift + X rejects (again to undo), Shift + U clears the flag. Stars and the flag show under each photo in the list and the grid; hover for the keywords.

Above the list, *Keyword or name*, *Any rating* and *Any flag* narrow what is shown: photos with a keyword (or a name) containing the text, photos with at least a rating, and picked, rejected, not rejected or unflagged ones; the keyword box, at the top, suggests the keywords already in use. *Clear filter* shows everything again. A filter changes only what is listed: nothing is hidden from albums or deleted.

The marks are kept in the library and also written next to each photo as an XMP file (for IMG_0001.LFR, `IMG_0001.xmp` in the photo's folder: `xmp:Rating`, `xmpDM:pick` and `dc:subject` keywords, a rejected photo as rating −1), which Bridge, digiKam and similar programs read. An exported album carries its photos' marks.

Photos you open while an album is selected are added to that album too.

## Thumbnail grid

Choosing *All photos* or an album shows its photos as a grid in the middle of the window. Make the thumbnails bigger or smaller with the slider and <img src="images/thumb-smaller.png" width="20" height="20" alt="Smaller thumbnails"> <img src="images/thumb-bigger.png" width="20" height="20" alt="Bigger thumbnails"> above the grid, or the **+** and **−** keys. Click a thumbnail (or select it and press Enter) to open the photo.
