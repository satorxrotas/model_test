# Garment Motion Studio

Drop in an un-rigged 3D garment, auto-fit it onto a rigged body, play realistic motion, and record social-ready video straight from the browser.

## How it works
1. **Load** an `.obj`, `.glb/.gltf` or `.fbx` garment (drag & drop or file picker). Each material becomes a part with its own colour.
2. **Auto-fit** – the garment is scaled and placed on the body. *Garment type* (auto-detect, top only, bottoms only, full outfit) decides how: a full outfit is stretched collar → ankle; a top on its own is sized from its units and hung from the collar; bottoms on their own are sized from their units and hung from the waist. Auto-detect looks for legs (and where they join) and for a skirt's flare; arms and legs are posed to match the sleeves and hems; skin weights are copied from the nearest body surface, smoothed, and any part sitting inside the body is pushed out by the *Clearance* amount.
3. **Animate** – *Reference sway* is motion measured from a reference clip (optical-flow tracking of the garment, `js/refmotion.js`). *Model poses* are in-place looping poses (weight shift, hip pop, hand on hip, hands on hips, slow twist, knee pop, hand in hair, lean back) with both feet locked to the floor by IK. *Movement* clips (idle, walk, run, dance, nods) are mocap retargeted onto the body. *Seamless walk* is the walk re-timed to an exact 1-second cycle whose last frame matches its first, so it repeats with no hitch and whole-second recordings loop cleanly. The garment follows either way.
4. **Body** – *Women's body* (Michelle) or *Men's body* (Xbot), under Look. All motions are retargeted to whichever is chosen.
5. **Record** – pick 9:16, 4:5, 1:1 or 16:9, a camera move and a length, hit **Record** (or press `R`). Chrome saves H.264 MP4; other browsers may save WebM.

6. **Rigged file** – *Download rigged .glb* exports a clean armature (metres, Y-up, identity root) with the skinned garment, optional body, and the motions as named actions. In Blender: File › Import › glTF 2.0. Rest pose = the garment's own modelled pose. Plain glTF 2.0 (no extensions), passes the Khronos validator with 0 errors/warnings; tested in Blender 4.2 and 5.0, built for 3.5+.

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

**Body + templates**: pick *Women* (Michelle) or *Men* (Xbot) and start from a template (*Pants, Shorts, Skirt, T-shirt, Long sleeve, Hoodie*) or a photo. Templates are flat-lay drawings cut from the chosen body's own measurements (hips, waist, chest, leg and arm girth, landmarks), with fabric and construction details (waistband, fly, pockets, stitching, ribbing, kangaroo pocket, drawstrings) and a colour picker; they go through the same measure → build steps as a photo, so descriptions and sliders work on them. Hoodies get a hood (worn down). Men's cuts are straighter and roomier.

1. **Cut-out**: background colours are clustered from the photo's border (the garment may touch the frame); each cluster is tried as the background in a chroma-weighted colour space and the most central, least frame-touching result wins. Transparent PNGs use their alpha. *Background tolerance* adjusts it.
2. **Measure**: garment type guessed from the silhouette (pants / skirt / top). Pants: waistband, hips, crotch, each leg's width down to the hem (legs cross-checked for symmetry so anything touching the garment is ignored); hems cut off by the photo continue to the floor with the texture mirrored.
3. **Build**: clean quad garment on the Motion Studio body (T-pose, metres, +Z front), sized from the hips (flat width = half circumference), legs never narrower than a standard female leg. Pants have a proper crotch (shared seam between the legs); skirts clear both legs; tops get a torso and sleeves along the arms. The photo is wrapped on (front and back mirrored, no UV seams).
4. **Describe it** (optional, `js/describe.js`): type a description such as *"high-rise flared pants, fitted, floor length"* and the words override what was measured from the photo — garment type, rise (low / mid / high), leg cut (flared, bootcut, wide, straight, skinny, joggers), fit (tight → baggy), length (shorts → floor; mini / midi / maxi), skirt shape (pencil, A-line, flowy), top length (cropped, longline) and sleeves (sleeveless → long). Recognised terms show as chips; suggestion chips add terms with a tap. Keyword based, no AI service.
5. **Output**: *Send to Motion Studio* (IndexedDB hand-off; the studio opens on the same body and skips its auto-placement for pre-fitted garments; switching body there re-shapes the garment to the other body's proportions), *Rigged .glb* (Mixamo skeleton, skin weights from the body, texture embedded) or *OBJ (.zip)* with texture.

## Image to Blend (`blend.html`)
Fourth tab. An image in, a real `.blend` file out, written in the browser and opening directly in Blender 3.5 and newer. Tested in Blender 4.2 and 5.0; the file uses the 3.0 format, which 3.5 reads natively.

- **Object**: product photo → the outline is inflated into a rounded solid (Poisson height field, sqrt profile) with the photo on the front and mirrored on the back; height, thickness, flat/rounded back, optional surface relief from the photo's brightness; Subdivision modifier.
- **Logo**: graphic → every shape traced (marching squares, holes and islands kept), simplified, triangulated (earcut) and extruded; the front wears the artwork, sides take a colour; real Bevel modifier with auto smooth.
- **Scene** (3D scene, default): any photo is rebuilt as a 3D scene. Depth comes from Depth Anything V2 Small (int8 ONNX, 35 MB, run in the browser with ONNX Runtime Web / WASM, `js/depth.js`). Every pixel is projected through a camera with the photo's lens; sharp steps in depth split the surface into separate objects (each given thickness by pushing a back copy away from the camera along its rays), and the backdrop behind them is filled in (depth and colour) so the camera can move (`js/scene3d.js`). The Blender camera sits at the photo's viewpoint (it reproduces the photo exactly, Standard view transform for shadeless), with an optional 5-second camera-move loop. One photo can't show the backs of things, so small camera moves look best. *Flat picture* and *Sweep* layouts are still there for a plain picture plane or a studio sweep.
- **Garment**: the Image to Model pipeline (templates, women's/men's body, description) → garment with an armature built from the body's Mixamo skeleton (`mixamorig:*` bones, rest matrices computed Blender-style), vertex-group skin weights, Armature modifier, optional rigged body, and motions (reference sway, seamless walk, walk, idle, run, dance, model poses) baked as Blender actions. Every action carries Cycles F-modifiers so it repeats forever, and the scene's frame range covers whole cycles (seamless walk: 30-frame cycle, 150 frames).
- Every file gets a camera framed on the model, key/fill/rim area lights (Studio / Soft / Dramatic), a matching floor and world colour, Eevee or Cycles, packed textures, and viewports set to Material Preview.

How it works: `assets/blend/template.blend` is Blender's own factory-startup file from the 3.5 source tree (format 3.0, brushes removed). `js/blendfile.js` reads its SDNA (the struct catalogue every .blend carries) and reads/writes blocks by field name, keeping pointers valid by old address. `js/blendscene.js` adds meshes (legacy MVert/MEdge/MPoly/MLoop layers that every version converts on load), packed images, Principled materials with Image Texture nodes, objects, modifiers, lights and the camera. `js/blendrig.js` adds armatures, poses and actions. `js/blendgen.js` makes the geometry; `js/motionlib.js` holds the motion retargeting shared with Motion Studio.

## Files
- `index.html` – UI
- `js/studio.js` – scene, motions, retargeting, camera moves, recording
- `js/autoskin.js` – garment extraction, fitting and weight transfer
- `js/exportrig.js` – rigged .glb export
- `js/poses.js` – procedural in-place model poses (two-bone IK)
- `assets/rigs/` – body (`Michelle.glb`) and motion library (`Xbot.glb`), Mixamo rigs from the three.js examples
- `poly.html`, `js/poly.js`, `js/polycore.js` – Poly Simplify (loading, simplification, OBJ/MTL writers)
- `js/quadmesh.js` – quad-preserving reduction; `js/uvunwrap.js` – automatic UV unwrap
- `image.html`, `js/img2model.js`, `js/garments.js`, `js/describe.js`, `js/templates.js` – Image to Model; `js/bodies.js` – women's / men's body loading and garment re-shaping between them; `js/handoff.js` – garment hand-off to Motion Studio
- `vendor/three/` – three.js r170 (MIT)
- `vendor/meshoptimizer/` – meshoptimizer 1.3.0 simplifier + decoder (MIT)
- `vendor/three-mesh-bvh/` – three-mesh-bvh 0.9.18 (MIT)
- `vendor/earcut/` – earcut 3.0.1 (ISC)
- `vendor/onnxruntime-web/` – ONNX Runtime Web 1.20.1 (MIT)
- `assets/models/depth-anything-v2-small-q8.onnx` – Depth Anything V2 Small (Apache-2.0; ONNX export by fabio-sim/Depth-Anything-ONNX), inlined and int8-quantised
- `assets/blend/template.blend` – Blender's factory startup file (Blender 3.5 source, GPL), brushes and palettes removed
- `blend.html`, `js/img2blend.js`, `js/blendfile.js`, `js/blendscene.js`, `js/blendrig.js`, `js/blendgen.js`, `js/motionlib.js`, `js/depth.js`, `js/scene3d.js` – Image to Blend

The page sits behind a client-side password gate (`js/gate.js`, stores only a SHA-256 hash). It keeps casual visitors out; the repo itself is public.

Run locally with any static server, e.g. `python3 -m http.server`.
