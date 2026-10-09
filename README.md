# 2.5D Gaussian Splat Baker - Unity Offline Studio

A standalone, high-performance browser-based studio designed to convert 2D VFX video clips (explosions, magic impacts, fire, smoke, muzzle flashes) into **2.5D animated Gaussian Splat sequences** and **Vertex Animation Textures (VAT)** for real-time rendering in **Unity URP**.

---

## Key Features

- **100% Standalone & Client-Side**: No web server, Node.js, Python, or backend required. Runs directly in any modern browser by opening `index.html`.
- **Pre-Pass Matting & Color Grading**: Auto-detect, Black background luminance key, Green screen chroma key, or custom eyedropper with spill suppression, edge softness, and interior hole preservation controls.
- **Dense Optical Flow & Volumetric Advection**: Bilinear optical flow tracking, depth estimation, and 3D billboard splat positioning.
- **Modular Post-Pass FX Manager**:
  - *Height over time* (Y/Z depth curve modulation)
  - *Scale over time* (radial expansion/contraction curve)
  - *Emissive over time* (temporal incandescence curve)
  - *Luminance Emissive* (automatic heat/emissive based on brightness)
  - *HSV Mix Tint* (color tinting & blend modes)
  - *Temporal Smooth* (anti-stutter multi-frame filter)
  - *Spherify* (hemisphere dome projection)
  - *Isometric Proxy* (octagonal beveled box conform)
  - *Shapers In / Out* (interactive 3D primitive modifiers)
- **Compact VAT Package Export**: Generates a lightweight `.zip` containing strictly the necessary textures (`.png`) and detailed settings (`.txt`) with exact effects metadata.
- **Unity URP Integration**: Ready-to-copy `unity/` folder with complete URP shaders, an instanced animation controller, and 32-bit mesh generators.

---

## Quick Start (Running the Baker)

1. Navigate to `C:\Git\Divers\SplatBaker`.
2. Double-click **`index.html`** or drag-and-drop it into any modern browser (Google Chrome, Microsoft Edge, Firefox, Brave).
3. The application will load instantly with zero server setup.

---

## Step-by-Step Workflow

### 1. Load Source Video / Test FX
- Click **Load Video** on the video preview timeline to load your `.mp4` or `.webm` file.
- Alternatively, test procedural generation by executing `generateSampleExplosion()` in the developer console.
- Use the bracket timeline handles `[ ` and ` ]` to set the **IN** and **OUT** frames to trim your sequence.

### 2. Pre-Pass Matting & Background Removal
On the right settings panel under **Pre-Pass: Color & Matting**:
- **Keying Mode**:
  - `Auto-Detect`: Automatically analyzes frame borders to detect black or green backgrounds.
  - `Black Background`: Uses luminance alpha matting for black-background VFX.
  - `Green Screen`: Standard chroma keying.
  - `Custom Color`: Use the **Eyedropper** tool on the video preview canvas to select an arbitrary background color.
  - `Disabled`: Keeps all pixels intact.
- **Threshold & Softness**: Fine-tune background cutoff and edge feathering.
- **Garder zones intérieures (Fill Holes)**:
  - *Default: Disabled*. When enabled, uses a perimeter-seed flood-fill to preserve dark interior smoke pockets and cavities surrounded by bright edges.
- Click **⚡ Apply** to refresh the preview.

### 3. Splat 3D Transform & Parameters
Under **Bake & Render Settings**:
- **Max Splats (Budget)**: Total billboard particles generated (e.g. 16k, 32k, 65k, 262k).
- **Splat Rotation (3D Transform)**:
  - **X Rotation**: Default is **`-90°`** (aligns top-down planar footage with Unity Y-Up world coordinates).
  - **Y / Z Rotation**: Adjust yaw and roll if needed.
- **Depth Scale & Focal Length**: Control the volumetric depth extrusion along the view axis.
- **Origin Mode**: Choose origin alignment (`Center`, `Ground Pivot Y=0`, `Blast Origin`).

### 4. Post-Pass Animation Effects (Optional)
Under the middle 3D viewport in the **Animation Effects** card:
- Click **+ Add** and select an effect (e.g., *Height over time*, *Temporal Smooth*, *HSV Mix Tint*, *Shaper In*).
- Configure parameters in the detail view:
  - Adjust bezier/linear curves by dragging keypoints.
  - Enable/disable individual effects.
- Click **Apply** to bake the effects into the 3D viewport animation.

### 5. Preview & Full Bake
- Click the **Eye icon** (`Preview Frame`) in the bottom actions dock to inspect single-frame splat distributions quickly.
- Click **Bake Sequence** to execute dense advection across all timeline frames.
- Use the 3D viewport controls:
  - **Orbit / Pan / Zoom** with mouse controls.
  - Preset camera views: **Iso**, **Front**, **Top**, **Side**.
  - Toggle **Grid**, **Origin (0,0,0)**, **Bounds**, and **3D Effet** gizmos.

### 6. Export VAT Package
1. Click **Export** in the bottom-right actions dock.
2. Enter your desired sequence name (e.g., `Explosion_01`).
3. Choose the VAT mode:
   - **Positions Absolues** (World Space 3D Positions - Recommended).
   - **Vecteurs de Déplacement** (Motion Delta Vectors).
4. Click **Download ZIP**.
5. The downloaded `.zip` archive contains:
   - `VAT_Color_<Name>.png`: RGBA texture (RGB = Base color, A = Encoded Alpha & HDR Emissive ratio).
   - `VAT_Pos_<Name>.png`: RGBA texture (RGB = Normalized 0..1 XYZ positions, A = Splat radius).
   - `VAT_Settings_<Name>.txt`: Complete configuration manifest including bounding boxes, shader properties, and exact settings for all active effects.

---

## Unity Integration Guide (`unity/` folder)

The `C:\Git\Divers\SplatBaker\unity\` directory contains ready-to-use assets for Unity Universal Render Pipeline (URP).

### Directory Structure

```
unity/SplatVat/
├── Scripts/
│   ├── Generate32bitsMesh.cs      # Editor utility to generate custom 32-bit splat meshes
│   └── SplatVATController.cs      # Real-time & editor animation controller (MaterialPropertyBlock)
├── ShaderRessources/
│   ├── SplatMesh_Placeholder.asset # Pre-baked 32-bit circumscribed triangle mesh (up to 262k splats)
│   ├── SplatVAT.shader            # URP VAT Gaussian Splat unlit billboard shader
│   └── SplatV2VAT.shader          # Optimized V2 variant with enhanced blending & lighting
├── Textures/                      # Sample baked VAT textures
└── VFX_Explosion.mat              # Pre-configured sample Material
```

---

### Step-by-Step Unity Setup

#### 1. Copy the `SplatVat` Folder
Copy `C:\Git\Divers\SplatBaker\unity\SplatVat` directly into your Unity project's `Assets/` directory:
```
YourUnityProject/Assets/SplatVat/
```

#### 2. Import Your Exported VAT Textures
1. Unzip your baked package and copy `VAT_Color_<Name>.png` and `VAT_Pos_<Name>.png` into your Unity project (e.g. in `Assets/SplatVat/Textures/`).
2. Select **`VAT_Color_<Name>.png`** in the Unity Project view:
   - **Texture Type**: `Default`
   - **sRGB (Color Texture)**: **Enabled (Checked)**
   - **Wrap Mode**: `Clamp`
   - **Filter Mode**: `Bilinear`
   - **Compression**: `High Quality` (or `None`)
3. Select **`VAT_Pos_<Name>.png`** in the Unity Project view:
   - **Texture Type**: `Default`
   - **sRGB (Color Texture)**: **DISABLED (Unchecked / Linear)**  
     *(CRITICAL: Position textures MUST be linear to prevent non-linear warping!)*
   - **Wrap Mode**: `Clamp`
   - **Filter Mode**: `Bilinear`
   - **Compression**: `None` or `High Quality`

#### 3. Configure the Material
1. Create a new Material (or duplicate `VFX_Explosion.mat`).
2. Set the shader to:
   - `Custom/2.5D_GaussianSplat_VAT_URP` (or `Custom/SplatV2VAT`).
3. Assign your textures:
   - **Color Texture (`_ColorTex`)**: Assign `VAT_Color_<Name>.png`.
   - **Position Texture (`_PosTex`)**: Assign `VAT_Pos_<Name>.png`.
4. Open the generated **`VAT_Settings_<Name>.txt`** file and copy the bounding box values into the Material Inspector:
   - `_BoundsMin`: Vector4 `(X, Y, Z, 0)`
   - `_BoundsSize`: Vector4 `(SizeX, SizeY, SizeZ, 0)`
   - `_MaxRadius`: Float value from the settings file
   - `_TexResolution`: e.g., `2048` or `4096`
   - `_TotalFrames`: e.g., `64`, `128`, or `256`
5. Enable **Enable GPU Instancing** at the bottom of the Material Inspector.

#### 4. Setup the GameObject & Mesh
1. In your Scene or Prefab, create an empty GameObject.
2. Add a **MeshFilter** component:
   - Assign `SplatMesh_Placeholder.asset` (or create a custom mesh via Unity menu **Tools > 2.5D Splats > Creer Mesh 32-bit**).
3. Add a **MeshRenderer** component:
   - Assign your configured Splat Material.
4. Add the **`SplatVATController`** component:
   - **Effect Duration**: Duration of one loop in seconds (e.g., `2.0`).
   - **Playback Speed**: Speed multiplier (default `1.0`).
   - **Loop Mode**: `Loop`, `Once`, `PingPong`, or `Clamp`.
   - **Play On Awake**: Checked.
   - **Preview In Edit Mode**: Checked (allows real-time scrubbing and playback directly in the Unity Scene View without entering Play Mode).

---

## Technical Specifications

| Parameter | Specification |
|---|---|
| **Architecture** | Pure client-side HTML5, Canvas 2D, WebGL 1.0/2.0 (Three.js r128) |
| **Server Requirements** | None (Runs under `file:///` and static hosts) |
| **Supported Video Formats** | `.mp4` (H.264), `.webm` (VP8/VP9) |
| **Splat Mesh Topology** | Circumscribed equilateral triangles (3 vertices per billboard splat) |
| **Vertex Index Format** | 32-bit `UInt32` (supports up to 1,048,576 splats per mesh) |
| **Color Texture Encoding** | RGBA8: RGB = Color tint, A [0.0 - 0.5] = Opacity, A ]0.5 - 1.0] = HDR Emissive |
| **Position Texture Encoding** | Normalized 0..1 RGB = Position in bounding box, A = Splat radius |
| **Unity Compatibility** | Unity 2021.3+, 2022.3+, 2023+, Unity 6+ (Universal Render Pipeline - URP) |
