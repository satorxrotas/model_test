# Garment Motion Studio

Drop in an un-rigged 3D garment, auto-fit it onto a rigged body, play realistic motion, and record social-ready video straight from the browser.

## How it works
1. **Load** an `.obj`, `.glb/.gltf` or `.fbx` garment (drag & drop or file picker). Each material becomes a part with its own colour.
2. **Auto-fit** – the garment is scaled and placed on the body; arms and legs are posed to match the sleeves and hems; skin weights are copied from the nearest body surface, smoothed, and any part sitting inside the body is pushed out by the *Clearance* amount.
3. **Animate** – *Reference sway* is motion measured from a reference clip (optical-flow tracking of the garment, `js/refmotion.js`). *Model poses* are in-place looping poses (weight shift, hip pop, hand on hip, hands on hips, slow twist, knee pop, hand in hair, lean back) with both feet locked to the floor by IK. *Movement* clips (idle, walk, run, dance, nods) are mocap retargeted onto the body. The garment follows either way.
4. **Record** – pick 9:16, 4:5, 1:1 or 16:9, a camera move and a length, hit **Record** (or press `R`). Chrome saves H.264 MP4; other browsers may save WebM.

5. **Rigged file** – *Download rigged .glb* exports a clean armature (metres, Y-up, identity root) with the skinned garment, optional body, and the motions as named actions. In Blender: File › Import › glTF 2.0. Rest pose = the garment's own modelled pose. Plain glTF 2.0 (no extensions), passes the Khronos validator with 0 errors/warnings; tested in Blender 4.2 and 5.0, built for 3.5+.

Best results: garments modelled in an A- or T-pose, fitted (not floor-length/very loose). Keep the tab in front while recording.

## Poly Simplify (`poly.html`)
Second tab. Upload a high-poly model (.glb/.gltf, .obj + .mtl + textures, .fbx, .stl, .ply, or a .zip of any of these), pick how much detail to keep (0.5–100%, or an exact triangle target), compare original vs low poly in a split view, and export OBJ.

- Simplifier: meshoptimizer 1.3 quadric edge collapse (same family as Blender's Decimate › Collapse), shading- and UV-aware; per-part, so materials stay separate.
- **Quads mode** (auto-selected for quad models, e.g. Marvelous/CLO exports): collapses whole quad strips (edge loops) toward an even target spacing, relaxes the grid and snaps it back onto the original surface (three-mesh-bvh), and fixes inconsistent face winding. Output stays a clean quad grid that follows the form. OBJ quads are read natively; GLB/FBX quads are rebuilt from their triangles.
- **Triangles mode**: options to protect open edges, allow collapsing across UV seams (stronger reduction), remove tiny pieces.
- **Mode detection**: Quads mode only for real quad grids (≥70% quads and ≥60% of interior vertices with four quads); irregular triangle meshes such as Marvelous Designer exports use Triangles mode.
- **Triangles mode** uses meshoptimizer's Regularize by default (*Even triangles*): slivers drop from ~22% to ~1%.
- **Auto UV unwrap** (`js/uvunwrap.js`), built for garments:
  - *Front / back* islands (default): each piece is cut like a basic sewing pattern (pants → front + back). *Model's panels* follows the pieces in the source file (seams found from the file's own vertex topology). *By direction* is a Smart-UV-style split.
  - Islands are flattened with LSCM, kept upright (model up = texture up) and, with *Level stripes across seams*, V is locked to the model's height and U re-solved, so horizontal stripes are level and meet exactly at every seam. Each garment is laid out by height, then garments are packed together.
  - Preview with Material / Checker / Stripes; UV layout PNG in the export. Off by default for textured models.
- Export: OBJ + MTL + textures as .zip (original texture files reused), or OBJ only. Y-up, source units — Blender 3.5+: File › Import › Wavefront (.obj) with default settings.

## Image to Model (`image.html`)
Third tab. Upload a garment photo (flat lay or product shot); no AI service needed.

1. **Cut-out**: background colours are clustered from the photo's border (the garment may touch the frame); each cluster is tried as the background in a chroma-weighted colour space and the most central, least frame-touching result wins. Transparent PNGs use their alpha. *Background tolerance* adjusts it.
2. **Measure**: garment type guessed from the silhouette (pants / skirt / top). Pants: waistband, hips, crotch, each leg's width down to the hem (legs cross-checked for symmetry so anything touching the garment is ignored); hems cut off by the photo continue to the floor with the texture mirrored.
3. **Build**: clean quad garment on the Motion Studio body (T-pose, metres, +Z front), sized from the hips (flat width = half circumference), legs never narrower than a standard female leg. Pants have a proper crotch (shared seam between the legs); skirts clear both legs; tops get a torso and sleeves along the arms. The photo is wrapped on (front and back mirrored, no UV seams).
4. **Describe it** (optional, `js/describe.js`): type a description such as *"high-rise flared pants, fitted, floor length"* and the words override what was measured from the photo — garment type, rise (low / mid / high), leg cut (flared, bootcut, wide, straight, skinny, joggers), fit (tight → baggy), length (shorts → floor; mini / midi / maxi), skirt shape (pencil, A-line, flowy), top length (cropped, longline) and sleeves (sleeveless → long). Recognised terms show as chips; suggestion chips add terms with a tap. Keyword based, no AI service.
5. **Output**: *Send to Motion Studio* (IndexedDB hand-off; the studio skips its auto-placement for pre-fitted garments), *Rigged .glb* (Mixamo skeleton, skin weights from the body, texture embedded) or *OBJ (.zip)* with texture.

## Files
- `index.html` – UI
- `js/studio.js` – scene, motions, retargeting, camera moves, recording
- `js/autoskin.js` – garment extraction, fitting and weight transfer
- `js/exportrig.js` – rigged .glb export
- `js/poses.js` – procedural in-place model poses (two-bone IK)
- `assets/rigs/` – body (`Michelle.glb`) and motion library (`Xbot.glb`), Mixamo rigs from the three.js examples
- `poly.html`, `js/poly.js`, `js/polycore.js` – Poly Simplify (loading, simplification, OBJ/MTL writers)
- `js/quadmesh.js` – quad-preserving reduction; `js/uvunwrap.js` – automatic UV unwrap
- `image.html`, `js/img2model.js`, `js/garments.js`, `js/describe.js` – Image to Model; `js/handoff.js` – garment hand-off to Motion Studio
- `vendor/three/` – three.js r170 (MIT)
- `vendor/meshoptimizer/` – meshoptimizer 1.3.0 simplifier + decoder (MIT)
- `vendor/three-mesh-bvh/` – three-mesh-bvh 0.9.18 (MIT)

The page sits behind a client-side password gate (`js/gate.js`, stores only a SHA-256 hash). It keeps casual visitors out; the repo itself is public.

Run locally with any static server, e.g. `python3 -m http.server`.
