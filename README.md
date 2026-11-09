# Garment Motion Studio

Drop in an un-rigged 3D garment, auto-fit it onto a rigged body, play realistic motion, and record social-ready video straight from the browser.

## How it works
1. **Load** an `.obj`, `.glb/.gltf` or `.fbx` garment (drag & drop or file picker). Each material becomes a part with its own colour.
2. **Auto-fit** – the garment is scaled and placed on the body; arms and legs are posed to match the sleeves and hems; skin weights are copied from the nearest body surface, smoothed, and any part sitting inside the body is pushed out by the *Clearance* amount.
3. **Animate** – mocap clips (idle, walk, run, dance, nods, poses) are retargeted onto the body; the garment follows.
4. **Record** – pick 9:16, 4:5, 1:1 or 16:9, a camera move and a length, hit **Record** (or press `R`). Chrome saves H.264 MP4; other browsers may save WebM.

5. **Rigged file** – *Download rigged .glb* exports a clean armature (metres, Y-up, identity root) with the skinned garment, optional body, and the motions as named actions. In Blender: File › Import › glTF 2.0. Rest pose = the garment's own modelled pose.

Best results: garments modelled in an A- or T-pose, fitted (not floor-length/very loose). Keep the tab in front while recording.

## Files
- `index.html` – UI
- `js/studio.js` – scene, motions, retargeting, camera moves, recording
- `js/autoskin.js` – garment extraction, fitting and weight transfer
- `js/exportrig.js` – rigged .glb export
- `assets/rigs/` – body (`Michelle.glb`) and motion library (`Xbot.glb`), Mixamo rigs from the three.js examples
- `vendor/three/` – three.js r170 (MIT)

Run locally with any static server, e.g. `python3 -m http.server`.
