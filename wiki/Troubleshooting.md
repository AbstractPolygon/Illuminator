# Troubleshooting

**The picture is slow to appear or to change.** The first open of a photo measures its depth, which takes a few seconds. Lower *Render → Resolution* to 1× for speed. Info shows the renderer in use: *CPU* means WebGL 2 is not available, which is much slower; on a laptop, check that the browser may use the faster graphics chip. *GPU time* in Info shows how long each view takes on the GPU. At *Resolution* 1.5× and 2× the engine's noise reduction is the slowest step of every change of focus or color; when the graphics card takes long over it, a change shows the new picture at once without the noise reduction, and the finished picture follows when you stop (a moment later). The *Speed* report under it times each stage and says what limits it; *Copy speed report* gives you text to send with a report.

**The picture looks rougher while dragging.** Strong depth of field blur is drawn as a quicker draft while a slider or the picture is dragged; the finished picture follows on release.

**Photos are gone after closing the browser.** Some browsers (or private windows) do not let sites store files. Settings → Library location says *Not available* then. Use another browser, a normal window, or the desktop app.

**Lytro Desktop edits were not applied.** They are used only for photos that have no Illuminator edits yet. Open the picture's `raw.lfp` together with its `stack.view.lfp` (importing a Lytro Desktop library does this for you). The note over the picture lists edits that are not supported yet.

**Report a problem:** [GitHub issues](https://github.com/AbstractPolygon/Illuminator/issues).

**The first generation camera does not show (Windows).** It is read through its disk, which needs the camera switched on and its USB cable connected; the *Import from camera…* dialog's diagnostics list the disks it saw. If its thumbnails look like color noise, send the camera log, which says how the thumbnail files are stored.

**The camera is not found over Wi-Fi.** Check that the camera's Wi-Fi is on (first generation: the Wi-Fi icon in the taskbar; ILLUM: *Settings*, *iOS Connect*, *Access Point* on) and that the network chosen is the camera's, with the password the camera shows. The camera turns its Wi-Fi off after a while without use, so connect soon after turning it on. A VPN or a firewall that blocks local connections can also stop it. If the message lists open ports, the camera was reached but spoke in a way Illuminator does not know yet: please send the message.

**Depth measuring is slow.** With a real graphics card the depth is measured on it; when a step falls back to the processor, or only a software renderer is found, a note appears over the picture. Choosing *Depth method → Illuminator* is the quickest measurement.

**"WebGL context is lost" (or a photo will not open after the picture froze).** The computer can take the graphics card away from an app for a moment (a driver reset, running low on video memory, many windows open). Illuminator notices, builds a new renderer, uploads the photo to it again and repeats the step that failed, so you should only see a short pause. If no new graphics context can be made, the processor does the work instead (slower). Closing other programs that use the graphics card, or lowering the *Scale* in Render Settings, makes it less likely.

**Limiting the memory the app uses.** In the desktop app, Settings > Memory has two sliders: the most RAM and the most video memory (VRAM) the app may plan to use, each from 1 GB up to what the computer has less what is left for the system (4 GB of RAM, 512 MB of video memory; the video memory is read from the graphics card; a card that shares the computer's memory counts as half of it). They start at the top. Lower them to keep the app out of the way of other programs: a full sensor render, a 16-bit export or an upscaling model that would need more than the limit is not started, and the notice says what to lower. The limits also cap the app's JavaScript memory and the video memory its browser engine plans for, which applies the next time the app starts.
