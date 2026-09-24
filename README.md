# Experimental Film — JavaScript

**Maison Lumière — a home tour.** A short film rendered entirely in JavaScript on an HTML canvas, with no images, video files or libraries.

The camera arrives at a house at dusk, goes through the front door, tours the **bathroom**, the **kitchen** and the **hall**, and ends back at the **front door**.

- A small perspective 3D engine on Canvas 2D: camera paths, near-plane clipping, painter's sorting and backface culling
- Per-face lighting with ACES tone mapping, fake ambient occlusion and light pools
- Volumetric sun beams, floating dust, bloom, warm grade, vignette, film grain and letterbox
- A generative ambient score made with Web Audio
- **Export video** records the film from the canvas with MediaRecorder and downloads it as MP4 or WebM

Run it by opening `index.html` or serving the folder. Add `?t=12` to the URL to render a single frame.
