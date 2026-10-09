/**
 * 3D Viewport & Gaussian Splats Interactive Player (Three.js WebGL)
 * Features:
 * - 45° Isometric Camera View + Free OrbitControls centered at (0, 0, 0)
 * - Dynamic RGB Color Sampling per Frame (Full vivid color for sparks, fire, smoke)
 * - 2.5D Animated Gaussian Splats Shader with soft radial bell curve alpha
 * - Scrubbing, Play/Pause, Step Forward/Back, Playback Speeds
 * - Global Trajectory Bounding Box Visualizer
 * - Real-time stats & performance monitoring
 */

class SplatViewer3D {
    constructor(containerElement) {
        this.container = containerElement;
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;

        // Splat mesh / points
        this.splatMesh = null;
        this.splatGeometry = null;
        this.splatMaterial = null;
        this.boundingBoxHelper = null;
        this.quadtreeHelper = null;
        this.gridHelper = null;
        this.originAxesHelper = null;
        this.originMarker = null;
        this.effectGizmo = null;

        // Playback state
        this.pipeline = null;
        this.frameCount = 0;
        this.splatCount = 0;
        this.currentFrame = 0;
        this.isPlaying = false;
        this.fps = 30.0;
        this.playbackSpeed = 1.0;
        this.lastFrameTime = 0;
        this.loop = true;

        // Display parameters
        this.sizeMultiplier = 2.0;
        this.alphaMultiplier = 1.0;
        this.brightnessMultiplier = 1.0;
        this.renderMode = 'gaussian'; // 'gaussian', 'points', 'additive'
        this.showQuadtree = false;
        this.showBoundingBox = true;
        this.showGrid = true;
        this.showOriginAxes = true;
        this.showEffectGizmo = true;

        // Animation frame handle
        this.animFrameId = null;

        // Callbacks
        this.onFrameChange = null;

        this.initThree();
    }

    initThree() {
        const width = this.container.clientWidth || 600;
        const height = this.container.clientHeight || 450;

        // 1. Scene
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x0a0c10);

        // 2. Camera: Standard Y-Up Perspective Camera (Up = +Y)
        this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
        this.camera.up.set(0, 1, 0);
        this.resetToIsometric();

        // 3. Renderer with antialiasing and alpha
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
        this.renderer.setSize(width, height);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.toneMapping = THREE.NoToneMapping; // Preserve exact vibrant RGB colors
        this.container.appendChild(this.renderer.domElement);

        // 4. Orbit Controls (Y-Up compatible)
        if (typeof THREE.OrbitControls !== 'undefined') {
            this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
            this.controls.enableDamping = true;
            this.controls.dampingFactor = 0.08;
            this.controls.screenSpacePanning = true;
            this.controls.target.set(0, 0, 0);
            this.controls.update();
        }

        // 5. Lights
        const ambLight = new THREE.AmbientLight(0xffffff, 1.0);
        this.scene.add(ambLight);

        // 6. Helpers (Grid Floor on XZ Horizontal Plane in Y-Up)
        this.gridHelper = new THREE.GridHelper(10, 20, 0x6366f1, 0x1e293b);
        this.gridHelper.position.set(0, 0, 0);
        this.scene.add(this.gridHelper);

        // 7. 3D Origin Pivot Axes (Red = X, Green = Y, Blue = Z at (0, 0, 0))
        this.originAxesHelper = new THREE.AxesHelper(0.85);
        this.originAxesHelper.renderOrder = 999;
        if (this.originAxesHelper.material) {
            this.originAxesHelper.material.depthTest = false;
            this.originAxesHelper.material.transparent = true;
            this.originAxesHelper.material.opacity = 0.90;
        }
        this.scene.add(this.originAxesHelper);

        // 8. Ground Origin Target Ring
        const ringGeom = new THREE.RingGeometry(0.06, 0.08, 32);
        const ringMat = new THREE.MeshBasicMaterial({ 
            color: 0xf59e0b, 
            side: THREE.DoubleSide, 
            transparent: true, 
            opacity: 0.85, 
            depthTest: false 
        });
        this.originMarker = new THREE.Mesh(ringGeom, ringMat);
        this.originMarker.rotation.x = Math.PI * 0.5;
        this.originMarker.position.set(0, 0, 0);
        this.scene.add(this.originMarker);

        // Resize Listener
        window.addEventListener('resize', () => this.onResize());

        // Start render loop
        this.animate = this.animate.bind(this);
        this.animFrameId = requestAnimationFrame(this.animate);
    }

    resetToIsometric() {
        const dist = 3.5;
        this.camera.up.set(0, 1, 0);
        this.camera.position.set(dist * 0.70, dist * 0.55, dist * 0.70);
        this.camera.lookAt(0, 0, 0);
        if (this.controls) {
            this.controls.target.set(0, 0, 0);
            this.controls.update();
        }
    }

    setCameraPreset(preset) {
        if (!this.camera) return;
        const dist = 3.5;
        this.camera.up.set(0, 1, 0);

        if (preset === 'isometric') {
            this.resetToIsometric();
        } else if (preset === 'front') {
            // Front view looking along -Z axis with +Y as Up
            this.camera.position.set(0, 0, dist);
            this.camera.lookAt(0, 0, 0);
            if (this.controls) {
                this.controls.target.set(0, 0, 0);
                this.controls.update();
            }
        } else if (preset === 'top') {
            // Top view looking down +Y axis
            this.camera.position.set(0, dist, 0.001);
            this.camera.lookAt(0, 0, 0);
            if (this.controls) {
                this.controls.target.set(0, 0, 0);
                this.controls.update();
            }
        } else if (preset === 'side') {
            // Side view looking along +X axis
            this.camera.position.set(dist, 0, 0);
            this.camera.lookAt(0, 0, 0);
            if (this.controls) {
                this.controls.target.set(0, 0, 0);
                this.controls.update();
            }
        }
    }

    onResize() {
        if (!this.container || !this.renderer || !this.camera) return;
        const width = this.container.clientWidth;
        const height = this.container.clientHeight;
        if (width === 0 || height === 0) return;

        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(width, height);
    }

    // Load baked data from pipeline
    loadPipelineData(pipeline) {
        this.pipeline = pipeline;
        if (!pipeline.splatsBase || !pipeline.splatsAnim) return;

        this.splatCount = pipeline.quadtreeCells.length;
        this.frameCount = pipeline.frames.length;
        this.currentFrame = pipeline.referenceFrameIdx || 0;

        if (this.splatMesh) {
            this.scene.remove(this.splatMesh);
            if (this.splatGeometry) this.splatGeometry.dispose();
            if (this.splatMaterial) this.splatMaterial.dispose();
        }

        const N = this.splatCount;
        this.splatGeometry = new THREE.BufferGeometry();

        const positions = new Float32Array(N * 3);
        const colors = new Float32Array(N * 3);
        const sizes = new Float32Array(N);
        const rawAlphas = new Float32Array(N);

        for (let i = 0; i < N; i++) {
            const b = i * 8;
            positions[i * 3 + 0] = pipeline.splatsBase[b + 0];
            positions[i * 3 + 1] = pipeline.splatsBase[b + 1];
            positions[i * 3 + 2] = pipeline.splatsBase[b + 2];

            sizes[i] = pipeline.splatsBase[b + 3];

            colors[i * 3 + 0] = pipeline.splatsBase[b + 4];
            colors[i * 3 + 1] = pipeline.splatsBase[b + 5];
            colors[i * 3 + 2] = pipeline.splatsBase[b + 6];

            const baseA = pipeline.splatsBase[b + 7];
            rawAlphas[i] = (typeof VatTextureExporter !== 'undefined' && VatTextureExporter.encodeAlphaEmissive)
                ? VatTextureExporter.encodeAlphaEmissive(baseA, 0.0)
                : (baseA * 0.5);
        }

        this.splatGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        this.splatGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        this.splatGeometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
        this.splatGeometry.setAttribute('rawAlpha', new THREE.BufferAttribute(rawAlphas, 1));

        this.splatMaterial = this.createGaussianShaderMaterial();

        this.splatMesh = new THREE.Points(this.splatGeometry, this.splatMaterial);
        this.scene.add(this.splatMesh);

        this.updateHelpers();
        this.updateToFrame(this.currentFrame);
    }

    createGaussianShaderMaterial() {
        return new THREE.ShaderMaterial({
            uniforms: {
                uSizeMultiplier: { value: this.sizeMultiplier },
                uAlphaMultiplier: { value: this.alphaMultiplier },
                uBrightnessMultiplier: { value: this.brightnessMultiplier },
                uMaxEmission: { value: 15.0 },
                uIsAdditive: { value: this.renderMode === 'additive' ? 1.0 : 0.0 }
            },
            vertexShader: `
                attribute float size;
                attribute float rawAlpha;
                attribute vec3 color;

                varying vec3 vColor;
                varying float vRawAlpha;

                uniform float uSizeMultiplier;
                uniform float uBrightnessMultiplier;

                void main() {
                    vColor = color * uBrightnessMultiplier;
                    vRawAlpha = rawAlpha;

                    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                    gl_Position = projectionMatrix * mvPosition;

                    // Projected billboard diameter with smooth perspective falloff
                    float dist = max(0.5, -mvPosition.z);
                    float pointSize = (size * 820.0 * uSizeMultiplier) / dist;
                    gl_PointSize = clamp(pointSize, 2.5, 300.0);
                }
            `,
            fragmentShader: `
                varying vec3 vColor;
                varying float vRawAlpha;

                uniform float uAlphaMultiplier;
                uniform float uMaxEmission;
                uniform float uIsAdditive;

                void main() {
                    vec2 coord = gl_PointCoord - vec2(0.5);
                    float r2 = dot(coord, coord) * 4.0;
                    if (r2 > 1.0) discard;

                    // Decode partitioned single-channel Alpha / Emissive
                    // [0.0, 0.5] = Smoke / Passive Opacity (0.0 -> 1.0)
                    // ]0.5, 1.0] = Fire / Incandescence Emissive (Ratio 0.0 -> 1.0)
                    float isFire = clamp((vRawAlpha - 0.5) * 1000.0, 0.0, 1.0);
                    float smokeAlpha = clamp(vRawAlpha * 2.0, 0.0, 1.0);
                    float outAlpha = mix(smokeAlpha, 1.0, isFire);

                    float fireRatio = clamp((vRawAlpha - 0.5) * 2.0, 0.0, 1.0);
                    float outEmissive = fireRatio * uMaxEmission;

                    // Smooth Gaussian bell-curve falloff
                    float gaussian = exp(-2.2 * r2);
                    float finalAlpha = outAlpha * uAlphaMultiplier * gaussian;
                    if (finalAlpha < 0.005 && outEmissive < 0.01) discard;

                    // Rich HDR color preservation with emissive & volumetric core boost
                    vec3 emissiveRgb = vColor + (vColor * outEmissive);
                    vec3 finalColor = emissiveRgb * (1.0 + gaussian * 0.3);

                    gl_FragColor = vec4(finalColor, clamp(finalAlpha, 0.0, 1.0));
                }
            `,
            transparent: true,
            depthWrite: false,
            blending: this.renderMode === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending
        });
    }

    // Dynamic Frame Update: Position + Opacity + Dynamic Color
    updateToFrame(frameIdx) {
        if (!this.pipeline || !this.splatGeometry || !this.pipeline.splatsAnim) return;

        const N = this.splatCount;
        const T = this.frameCount;
        frameIdx = Math.max(0, Math.min(T - 1, frameIdx));
        this.currentFrame = frameIdx;

        const posAttr = this.splatGeometry.getAttribute('position');
        const rawAlphaAttr = this.splatGeometry.getAttribute('rawAlpha');
        const colorAttr = this.splatGeometry.getAttribute('color');

        const baseSplats = this.pipeline.splatsBase;
        const animSplats = this.pipeline.splatsAnim;
        const frameData = this.pipeline.frames[frameIdx];
        const tracks = this.pipeline.splatTracks ? this.pipeline.splatTracks[frameIdx] : null;
        const w = frameData ? frameData.width : 384;
        const h = frameData ? frameData.height : 384;

        const effectsMgr = (this.pipeline && this.pipeline.effectsManager) || (typeof effectsManager !== 'undefined' ? effectsManager : null);
        const hsvEffect = effectsMgr ? effectsMgr.getActiveEffects().find(e => e.type === 'hsv_mix_tint') : null;
        const t01 = (T > 1) ? (frameIdx / (T - 1)) : 0.0;

        for (let i = 0; i < N; i++) {
            const b = i * 8;
            const vatIdx = (frameIdx * N + i) * 4;

            const baseX = baseSplats[b + 0];
            const baseY = baseSplats[b + 1];
            const baseZ = baseSplats[b + 2];

            const deltaX = animSplats[vatIdx + 0];
            const deltaY = animSplats[vatIdx + 1];
            const deltaZ = animSplats[vatIdx + 2];
            const opacity = animSplats[vatIdx + 3];
            const baseA = baseSplats[b + 7];

            posAttr.setXYZ(i, baseX + deltaX, baseY + deltaY, baseZ + deltaZ);

            // Dynamic RGB Color Sampling per Frame
            let curR = baseSplats[b + 4];
            let curG = baseSplats[b + 5];
            let curB = baseSplats[b + 6];

            if (frameData && tracks) {
                const u = Math.floor(tracks[i * 2 + 0]);
                const v = Math.floor(tracks[i * 2 + 1]);
                if (u >= 0 && u < w && v >= 0 && v < h) {
                    const px = (v * w + u) * 4;
                    const r = frameData.data[px] / 255.0;
                    const g = frameData.data[px + 1] / 255.0;
                    const bCol = frameData.data[px + 2] / 255.0;
                    const a = frameData.data[px + 3] / 255.0;

                    if (a > 0.05 && (r + g + bCol) > 0.05) {
                        curR = r;
                        curG = g;
                        curB = bCol;
                    }
                }
            }

            // HSV Mix Tint Effect
            if (hsvEffect) {
                const tinted = hsvEffect.applyColor(curR, curG, curB, t01);
                curR = tinted.r;
                curG = tinted.g;
                curB = tinted.b;
            }

            // Dynamic Emissive Heat contribution from Shaper effects
            let heat = 0.0;
            if (this.pipeline.splatsHeat) {
                heat = this.pipeline.splatsHeat[frameIdx * N + i] || 0.0;
                if (heat > 0.001) {
                    curR = Math.min(1.0, curR + heat * 1.0);
                    curG = Math.min(1.0, curG + heat * 0.5);
                    curB = Math.min(1.0, curB + heat * 0.1);
                }
            }

            const finalOpacity = Math.max(0.0, Math.min(1.0, baseA * opacity));
            const encodedA = (typeof VatTextureExporter !== 'undefined' && VatTextureExporter.encodeAlphaEmissive)
                ? VatTextureExporter.encodeAlphaEmissive(finalOpacity, Math.min(1.0, heat))
                : (heat > 0.001 ? (0.5 + Math.min(1.0, heat) * 0.5) : (finalOpacity * 0.5));

            if (rawAlphaAttr) rawAlphaAttr.setX(i, encodedA);
            colorAttr.setXYZ(i, curR, curG, curB);
        }

        posAttr.needsUpdate = true;
        if (rawAlphaAttr) rawAlphaAttr.needsUpdate = true;
        if (colorAttr) colorAttr.needsUpdate = true;

        if (this.onFrameChange) {
            this.onFrameChange(this.currentFrame, this.frameCount);
        }
    }

    /**
     * Update 3D Visualizer Gizmo for Shaper Primitive (Half-Sphere)
     */
    updateEffectGizmo(effect) {
        if (this.effectGizmo) {
            this.scene.remove(this.effectGizmo);
            this.effectGizmo.traverse(child => {
                if (child.geometry) child.geometry.dispose();
                if (child.material) {
                    if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
                    else child.material.dispose();
                }
            });
            this.effectGizmo = null;
        }

        if (!effect || !effect.enabled || effect.showGizmo === false || this.showEffectGizmo === false || 
            (effect.type !== 'shaper_in' && effect.type !== 'shaper_out' && effect.type !== 'spherify' && effect.type !== 'isometric_proxy')) {
            return;
        }

        const group = new THREE.Group();

        if (effect.type === 'isometric_proxy') {
            const W = Math.max(0.05, (effect.width || 2.0) * 0.5); // Half-width (radius)
            const H = Math.max(0.1, effect.height || 2.0);
            const wallH = H * Math.max(0.05, Math.min(0.95, effect.wallRatio !== undefined ? effect.wallRatio : 0.40));
            const topRatio = Math.max(0.05, Math.min(0.95, effect.topRatio !== undefined ? effect.topRatio : 0.50));
            const chamferRatio = Math.max(0.05, Math.min(0.95, effect.chamfer !== undefined ? effect.chamfer : 0.50));

            const W_top = W * topRatio;
            const k = W * (1.0 - chamferRatio);

            const yBase = -H * 0.5;
            const yWall = yBase + wallH;
            const yTop = H * 0.5;

            // 20 Vertices for the Beveled Octagonal Dome (8 base + 8 wall + 4 top)
            const verts = [
                // Bottom Octagon Ring (0..7)
                 W, yBase,  k,   // 0: East-North
                 k, yBase,  W,   // 1: North-East
                -k, yBase,  W,   // 2: North-West
                -W, yBase,  k,   // 3: West-North
                -W, yBase, -k,   // 4: West-South
                -k, yBase, -W,   // 5: South-West
                 k, yBase, -W,   // 6: South-East
                 W, yBase, -k,   // 7: East-South

                // Middle Octagon Ring (8..15 at wall height)
                 W, yWall,  k,   // 8
                 k, yWall,  W,   // 9
                -k, yWall,  W,   // 10
                -W, yWall,  k,   // 11
                -W, yWall, -k,   // 12
                -k, yWall, -W,   // 13
                 k, yWall, -W,   // 14
                 W, yWall, -k,   // 15

                // Top Square Roof (16..19 at top height)
                 W_top, yTop,  W_top, // 16: North-East Corner
                -W_top, yTop,  W_top, // 17: North-West Corner
                -W_top, yTop, -W_top, // 18: South-West Corner
                 W_top, yTop, -W_top  // 19: South-East Corner
            ];

            const tris = [
                // 1. 8 Vertical Wall Quads (16 triangles)
                7, 0, 8,   7, 8, 15,
                0, 1, 9,   0, 9, 8,
                1, 2, 10,  1, 10, 9,
                2, 3, 11,  2, 11, 10,
                3, 4, 12,  3, 12, 11,
                4, 5, 13,  4, 13, 12,
                5, 6, 14,  5, 14, 13,
                6, 7, 15,  6, 15, 14,

                // 2. 4 Sloped Roof Trapezoids (8 triangles)
                9, 10, 17,  9, 17, 16,
                11, 12, 18, 11, 18, 17,
                13, 14, 19, 13, 19, 18,
                15, 8, 16,  15, 16, 19,

                // 3. 4 Sloped Corner Triangles (4 triangles)
                8, 9, 16,
                10, 11, 17,
                12, 13, 18,
                14, 15, 19,

                // 4. Top Roof Square Quad (2 triangles)
                16, 17, 18,  16, 18, 19,

                // 5. Bottom Floor (6 triangles)
                0, 7, 6,  0, 6, 5,  0, 5, 4,  0, 4, 3,  0, 3, 2,  0, 2, 1
            ];

            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
            geom.setIndex(tris);
            geom.computeVertexNormals();

            // 1. Translucent active shell
            const meshMat = new THREE.MeshBasicMaterial({
                color: 0x38bdf8,
                transparent: true,
                opacity: 0.22,
                side: THREE.DoubleSide,
                depthWrite: false
            });
            const proxyMesh = new THREE.Mesh(geom, meshMat);
            group.add(proxyMesh);

            // 2. Wireframe overlay
            const wireMat = new THREE.MeshBasicMaterial({
                color: 0x38bdf8,
                wireframe: true,
                transparent: true,
                opacity: 0.45
            });
            const wireMesh = new THREE.Mesh(geom, wireMat);
            group.add(wireMesh);

            // 3. Highlight boundary edges
            const lineIndices = [
                // Bottom Octagon
                0,1, 1,2, 2,3, 3,4, 4,5, 5,6, 6,7, 7,0,
                // 8 Vertical Wall Seams
                0,8, 1,9, 2,10, 3,11, 4,12, 5,13, 6,14, 7,15,
                // Middle Octagon Ring
                8,9, 9,10, 10,11, 11,12, 12,13, 13,14, 14,15, 15,8,
                // Sloped Roof Chamfer Ridge Lines
                8,16, 9,16,
                10,17, 11,17,
                12,18, 13,18,
                14,19, 15,19,
                // Top Square Roof
                16,17, 17,18, 18,19, 19,16
            ];

            const linePositions = [];
            for (let li = 0; li < lineIndices.length; li++) {
                const vi = lineIndices[li] * 3;
                linePositions.push(verts[vi], verts[vi + 1], verts[vi + 2]);
            }

            const lineGeom = new THREE.BufferGeometry();
            lineGeom.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
            const lineMat = new THREE.LineBasicMaterial({
                color: 0x38bdf8,
                transparent: true,
                opacity: 0.95
            });
            const lineSegments = new THREE.LineSegments(lineGeom, lineMat);
            group.add(lineSegments);
        } else {
            const radius = Math.max(0.05, effect.radius || (effect.type === 'spherify' ? 1.2 : 0.9));
            const range = Math.max(0.05, effect.range || 0.8);
            const isHeat = effect.mode && effect.mode.includes('heat');
            let colorHex = 0x38bdf8; // Spherify default cyan
            if (effect.type === 'shaper_in') {
                colorHex = isHeat ? 0xf97316 : 0xf59e0b;
            } else if (effect.type === 'shaper_out') {
                colorHex = isHeat ? 0xd946ef : 0x06b6d4;
            }

            // 1. Translucent half-sphere dome
            const domeGeom = new THREE.SphereGeometry(radius, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.5);
            const domeMat = new THREE.MeshBasicMaterial({
                color: colorHex,
                transparent: true,
                opacity: 0.22,
                side: THREE.DoubleSide,
                depthWrite: false
            });
            const domeMesh = new THREE.Mesh(domeGeom, domeMat);
            group.add(domeMesh);

            // 2. Wireframe dome overlay
            const wireMat = new THREE.MeshBasicMaterial({
                color: colorHex,
                wireframe: true,
                transparent: true,
                opacity: 0.60
            });
            const wireMesh = new THREE.Mesh(domeGeom, wireMat);
            group.add(wireMesh);

            // 3. Base circle ring
            const ringGeom = new THREE.RingGeometry(radius * 0.96, radius, 32);
            const ringMat = new THREE.MeshBasicMaterial({
                color: colorHex,
                side: THREE.DoubleSide,
                transparent: true,
                opacity: 0.85
            });
            const ringMesh = new THREE.Mesh(ringGeom, ringMat);
            ringMesh.rotation.x = Math.PI * 0.5;
            group.add(ringMesh);

            // 4. Influence range outer dome (for shaper effects)
            if (effect.type === 'shaper_in' || effect.type === 'shaper_out') {
                const outerGeom = new THREE.SphereGeometry(radius + range, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.5);
                const outerMat = new THREE.MeshBasicMaterial({
                    color: colorHex,
                    wireframe: true,
                    transparent: true,
                    opacity: 0.18
                });
                const outerMesh = new THREE.Mesh(outerGeom, outerMat);
                group.add(outerMesh);
            }

            // Orientation & Scale
            if (effect.type === 'spherify') {
                const isConcave = (effect.curvature === 'concave');
                group.rotation.x = isConcave ? -Math.PI * 0.5 : Math.PI * 0.5;
                const sx = (effect.scale && effect.scale.x !== undefined) ? effect.scale.x : 1.0;
                const sy = (effect.scale && effect.scale.y !== undefined) ? effect.scale.y : 1.0;
                const sz = (effect.scale && effect.scale.z !== undefined) ? effect.scale.z : 1.0;
                group.scale.set(sx, sz, sy);
            } else {
                const dir = effect.direction || 'up';
                if (dir === 'up') {
                    // default (+Y)
                } else if (dir === 'down') {
                    group.rotation.x = Math.PI;
                } else if (dir === 'forward') {
                    group.rotation.x = Math.PI * 0.5;
                } else if (dir === 'back') {
                    group.rotation.x = -Math.PI * 0.5;
                } else if (dir === 'right') {
                    group.rotation.z = -Math.PI * 0.5;
                } else if (dir === 'left') {
                    group.rotation.z = Math.PI * 0.5;
                }
            }
        }

        // Position 3D
        const pos = effect.position || { x: 0, y: 0, z: 0 };
        group.position.set(pos.x, pos.y, pos.z);

        // Apply pipeline transform Euler rotation so gizmo matches rotated splats
        if (this.pipeline) {
            const rotX = (this.pipeline.rotationX || 0) * Math.PI / 180;
            const rotY = (this.pipeline.rotationY || 0) * Math.PI / 180;
            const rotZ = (this.pipeline.rotationZ || 0) * Math.PI / 180;

            if (rotX !== 0 || rotY !== 0 || rotZ !== 0) {
                const pipeEuler = new THREE.Euler(rotX, rotY, rotZ, 'XYZ');
                const pipeQuat = new THREE.Quaternion().setFromEuler(pipeEuler);
                const gizmoQuat = new THREE.Quaternion().setFromEuler(group.rotation);
                pipeQuat.multiply(gizmoQuat);
                group.setRotationFromQuaternion(pipeQuat);
            }
        }

        this.effectGizmo = group;
        this.scene.add(this.effectGizmo);
    }

    updateHelpers() {
        // 1. Origin Axes & Ground Target Ring
        if (this.originAxesHelper) {
            this.originAxesHelper.visible = !!this.showOriginAxes;
        }
        if (this.originMarker) {
            this.originMarker.visible = !!this.showOriginAxes;
        }

        // 2. Global Bounding Box Helper & Grid Floor
        if (this.boundingBoxHelper) {
            this.scene.remove(this.boundingBoxHelper);
            this.boundingBoxHelper = null;
        }

        if (this.pipeline) {
            const bounds = this.pipeline.computeBoundingBox();
            if (bounds) {
                if (this.showBoundingBox) {
                    const box = new THREE.Box3(
                        new THREE.Vector3(...bounds.min),
                        new THREE.Vector3(...bounds.max)
                    );
                    this.boundingBoxHelper = new THREE.Box3Helper(box, 0x818cf8);
                    this.scene.add(this.boundingBoxHelper);
                }

                // Center ground grid below bounding box on the XZ Horizontal plane (Y is Up)
                if (this.gridHelper) {
                    this.gridHelper.visible = !!this.showGrid;
                    const groundY = Math.min(0, bounds.min[1] - 0.01);
                    this.gridHelper.position.set(0, groundY, 0);
                }
            } else if (this.gridHelper) {
                this.gridHelper.visible = !!this.showGrid;
                this.gridHelper.position.set(0, 0, 0);
            }
        }

        // 3. Quadtree wireframe debug boxes in 3D
        if (this.quadtreeHelper) {
            this.scene.remove(this.quadtreeHelper);
            this.quadtreeHelper = null;
        }

        if (this.showQuadtree && this.pipeline && this.pipeline.quadtreeCells) {
            const cells = this.pipeline.quadtreeCells;
            const linePositions = [];
            const focal = this.pipeline.focalLength || 320.0;

            for (let i = 0; i < Math.min(cells.length, 3000); i++) {
                const c = cells[i];
                const b = i * 8;
                const x0 = this.pipeline.splatsBase[b + 0];
                const y0 = this.pipeline.splatsBase[b + 1];
                const z0 = this.pipeline.splatsBase[b + 2];
                const hs = (c.size / focal) * 0.45;

                linePositions.push(
                    x0 - hs, y0, z0 - hs,  x0 + hs, y0, z0 - hs,
                    x0 + hs, y0, z0 - hs,  x0 + hs, y0, z0 + hs,
                    x0 + hs, y0, z0 + hs,  x0 - hs, y0, z0 + hs,
                    x0 - hs, y0, z0 + hs,  x0 - hs, y0, z0 - hs
                );
            }

            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
            const mat = new THREE.LineBasicMaterial({ color: 0x06b6d4, transparent: true, opacity: 0.35 });
            this.quadtreeHelper = new THREE.LineSegments(geom, mat);
            this.scene.add(this.quadtreeHelper);
        }
    }

    setOriginAxesVisible(visible) {
        this.showOriginAxes = !!visible;
        if (this.originAxesHelper) this.originAxesHelper.visible = this.showOriginAxes;
        if (this.originMarker) this.originMarker.visible = this.showOriginAxes;
    }

    setGridVisible(visible) {
        this.showGrid = !!visible;
        if (this.gridHelper) this.gridHelper.visible = this.showGrid;
    }

    setBoundingBoxVisible(visible) {
        this.showBoundingBox = !!visible;
        this.updateHelpers();
    }

    setQuadtreeVisible(visible) {
        this.showQuadtree = !!visible;
        this.updateHelpers();
    }

    setEffectGizmoVisible(visible) {
        this.showEffectGizmo = !!visible;
        if (typeof effectsManager !== 'undefined' && effectsManager) {
            this.updateEffectGizmo(effectsManager.getSelectedEffect());
        }
    }

    setRenderMode(mode) {
        this.renderMode = mode;
        if (this.splatMaterial) {
            this.splatMaterial.blending = (mode === 'additive') ? THREE.AdditiveBlending : THREE.NormalBlending;
            this.splatMaterial.uniforms.uIsAdditive.value = (mode === 'additive') ? 1.0 : 0.0;
            this.splatMaterial.needsUpdate = true;
        }
    }

    setSizeMultiplier(val) {
        this.sizeMultiplier = val;
        if (this.splatMaterial) {
            this.splatMaterial.uniforms.uSizeMultiplier.value = val;
        }
    }

    setAlphaMultiplier(val) {
        this.alphaMultiplier = val;
        if (this.splatMaterial) {
            this.splatMaterial.uniforms.uAlphaMultiplier.value = val;
        }
    }

    setBrightnessMultiplier(val) {
        this.brightnessMultiplier = val;
        if (this.splatMaterial) {
            this.splatMaterial.uniforms.uBrightnessMultiplier.value = val;
        }
    }

    togglePlay() {
        this.isPlaying = !this.isPlaying;
        this.lastFrameTime = performance.now();
        return this.isPlaying;
    }

    play() {
        this.isPlaying = true;
        this.lastFrameTime = performance.now();
    }

    pause() {
        this.isPlaying = false;
    }

    stepForward() {
        this.pause();
        if (this.frameCount > 0) {
            this.updateToFrame((this.currentFrame + 1) % this.frameCount);
        }
    }

    stepBackward() {
        this.pause();
        if (this.frameCount > 0) {
            this.updateToFrame((this.currentFrame - 1 + this.frameCount) % this.frameCount);
        }
    }

    setSpeed(spd) {
        this.playbackSpeed = spd;
    }

    animate(timestamp) {
        this.animFrameId = requestAnimationFrame(this.animate);

        if (this.controls) this.controls.update();

        if (this.isPlaying && this.frameCount > 0) {
            const delta = timestamp - this.lastFrameTime;
            const interval = 1000.0 / (this.fps * this.playbackSpeed);

            if (delta >= interval) {
                this.lastFrameTime = timestamp - (delta % interval);
                let nextFrame = this.currentFrame + 1;
                if (nextFrame >= this.frameCount) {
                    if (this.loop) {
                        nextFrame = 0;
                    } else {
                        nextFrame = this.frameCount - 1;
                        this.isPlaying = false;
                    }
                }
                this.updateToFrame(nextFrame);
            }
        }

        if (this.renderer && this.scene && this.camera) {
            this.renderer.render(this.scene, this.camera);
        }
    }

    dispose() {
        if (this.animFrameId) cancelAnimationFrame(this.animFrameId);
        if (this.splatGeometry) this.splatGeometry.dispose();
        if (this.splatMaterial) this.splatMaterial.dispose();
        if (this.effectGizmo) {
            this.scene.remove(this.effectGizmo);
            this.effectGizmo = null;
        }
        if (this.renderer) {
            this.renderer.dispose();
            this.renderer.domElement.remove();
        }
    }
}

window.SplatViewer3D = SplatViewer3D;
