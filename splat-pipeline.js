/**
 * 2.5D Gaussian Splat Baking Pipeline (Offline / WebGPU / WASM)
 * Features:
 *  - Video frame extraction
 *  - Chroma Key / Green Screen / Background Matting Pré-Pass with Spill Suppression
 *  - Local Depth Estimation (Volumetric Alpha-Aware Depth / Depth Anything v2 ONNX)
 *  - Dense Optical Flow (Lucas-Kanade Pyramidal / RAFT ONNX)
 *  - Adaptive Quadtree Splat Generation with Zero-Background Filtering
 *  - Global 3D Volume Centering (Centroid across all frames aligned to 0,0,0)
 *  - Global Trajectory Bounding Box (Enclosing all animated frames without drifting)
 *  - Dynamic RGB Color Tracking & Peak Radiance Preservation
 *  - Monolithic `.bytes` Binary Packing & JSZip Exporter for Unity
 */

class BinaryMaxHeap {
    constructor() {
        this.data = [];
    }
    push(item) {
        this.data.push(item);
        this._up(this.data.length - 1);
    }
    pop() {
        const d = this.data;
        if (d.length === 0) return null;
        const top = d[0];
        const last = d.pop();
        if (d.length > 0) {
            d[0] = last;
            this._down(0);
        }
        return top;
    }
    get length() {
        return this.data.length;
    }
    _up(i) {
        const d = this.data;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (d[i].score > d[p].score) {
                const tmp = d[i]; d[i] = d[p]; d[p] = tmp;
                i = p;
            } else break;
        }
    }
    _down(i) {
        const d = this.data;
        const len = d.length;
        while (true) {
            let left = (i << 1) + 1;
            let right = left + 1;
            let best = i;
            if (left < len && d[left].score > d[best].score) best = left;
            if (right < len && d[right].score > d[best].score) best = right;
            if (best !== i) {
                const tmp = d[i]; d[i] = d[best]; d[best] = tmp;
                i = best;
            } else break;
        }
    }
}

class SplatBakingPipeline {
    constructor() {
        this.focalLength = 320.0;     // 3D projection focal length
        this.depthScale = 2.0;         // Z-extrusion scale
        this.invertDepth = false;      // Invert depth direction flag
        this.targetSplatCount = 12000; // Target total splats
        this.gradientThreshold = 0.35; // Sensitivity for Quadtree subdivision
        this.coarseSplatsRatio = 0.16; // ~2,000 coarse cells / 10,000 fine cells for 12k default
        this.maxQuadDepth = 8;
        this.referenceFrameIdx = -1;   // -1 = auto-detect peak explosion frame

        // Chroma Keying, Color Grading & Matting Pré-Pass
        this.keyingMode = 'auto';      // 'auto', 'green', 'black', 'magenta', 'custom', 'none'
        this.keyColor = [0, 200, 50];  // RGB Key Color
        this.keyThreshold = 0.05;      // Similarity/Cutoff threshold
        this.keySoftness = 0.08;       // Softness / edge falloff
        this.spillSuppression = 0.85;  // 0.0 to 1.0 anti-green spill factor
        this.videoBrightness = 1.0;    // Video brightness/exposure multiplier (0.2 to 3.0)
        this.videoContrast = 1.0;      // Video contrast (0.2 to 2.5)
        this.videoGamma = 1.0;         // Video gamma / shadow lift (0.4 to 3.0)
        this.videoBlackLevel = 0.0;    // Video black level pedestal subtraction (0.0 to 0.5)
        this.histIn = 0.02;            // Monochrome histogram low cutoff / black clip (0.0 to 0.5)
        this.histOut = 1.00;           // Monochrome histogram high cutoff / white clip (0.5 to 1.0)
        this.histGamma = 1.0;          // Monochrome histogram transfer curve gamma (0.2 to 3.0)
        this.colorCutoffThreshold = 0.02; // Noise / low luminance threshold
        this.keepInteriorZones = false; // Protect interior zones & fill hollow holes enclosed by silhouette
        this.autoCenter3D = true;      // Auto center splats in 3D volume at (0, 0, 0)
        this.originMode = 'center';    // 'origin' (Blast Origin), 'ground' (Ground Pivot Y=0), 'center' (Bounding Box), 'centroid' (Mass Center), 'none'
        this.offsetX = 0.0;            // Manual fine-tune origin offset X
        this.offsetY = 0.0;            // Manual fine-tune origin offset Y
        this.offsetZ = 0.0;            // Manual fine-tune origin offset Z
        this.centerOffset = [0, 0, 0]; // Computed global origin offset
        this.rotationX = -90;          // 3D Transform Euler Rotation X in degrees
        this.rotationY = 0;            // 3D Transform Euler Rotation Y in degrees
        this.rotationZ = 0;            // 3D Transform Euler Rotation Z in degrees
        this.enableSplatPooling = false; // Splat pooling & dynamic life-cycle recycling
        this.poolingSkipFrames = 0;    // Number of burst frames to skip recycling at start

        // Fade In / Fade Out (Frames)
        this.fadeInFrames = 6;         // Smooth fade in duration in frames
        this.fadeOutFrames = 12;       // Smooth fade out duration in frames

        // Frame Trim Range (In/Out markers)
        this.trimStart = 0;            // First active frame index
        this.trimEnd = -1;             // Last active frame index (-1 = all frames)

        // In-memory buffers
        this.rawFrames = [];           // Original ImageData [T_total]
        this.allKeyedFrames = [];      // Keyed ImageData with Alpha [T_total]
        this.frames = [];              // Active trimmed ImageData slice with Alpha [T_active]
        this.depthMaps = [];           // Array of Float32Array [T][W * H] (normalized 0..1)
        this.flowFields = [];          // Array of { u: Float32Array, v: Float32Array } [T-1][W * H]
        this.raw3D = null;             // Array of Float32Array [T][N * 3] (Unmodulated unprojected 3D coordinates)
        this.splatsBase = null;        // Float32Array [N * 8] : [posX, posY, posZ, size, r, g, b, baseAlpha]
        this.splatsAnim = null;        // Float32Array [T * N * 4] : [deltaX, deltaY, deltaZ, dynamicOpacity]
        this.splatsHeat = null;        // Float32Array [T * N] : Dynamic emissive heat boost
        this.splatTracks = null;       // Array of Float32Array [T][N * 2] (u, v screen coords for live color sampling)
        this.bakedData = null;         // Packed ArrayBuffer
        this.quadtreeCells = [];       // Visual quadtree cell boxes for 2D/3D debug view

        this.onnxSessionDepth = null;
        this.onnxSessionRaft = null;
    }

    // Set configuration
    configure(options = {}) {
        if (options.focalLength !== undefined) this.focalLength = options.focalLength;
        if (options.depthScale !== undefined) this.depthScale = options.depthScale;
        if (options.invertDepth !== undefined) this.invertDepth = !!options.invertDepth;
        if (options.targetSplatCount !== undefined) this.targetSplatCount = options.targetSplatCount;
        if (options.gradientThreshold !== undefined) this.gradientThreshold = options.gradientThreshold;
        if (options.maxQuadDepth !== undefined) this.maxQuadDepth = options.maxQuadDepth;
        if (options.referenceFrameIdx !== undefined) this.referenceFrameIdx = options.referenceFrameIdx;
        if (options.keyingMode !== undefined) this.keyingMode = options.keyingMode;
        if (options.keyColor !== undefined) this.keyColor = options.keyColor;
        if (options.keyThreshold !== undefined) this.keyThreshold = options.keyThreshold;
        if (options.keySoftness !== undefined) this.keySoftness = options.keySoftness;
        if (options.spillSuppression !== undefined) this.spillSuppression = options.spillSuppression;
        if (options.videoBrightness !== undefined) this.videoBrightness = options.videoBrightness;
        if (options.videoContrast !== undefined) this.videoContrast = options.videoContrast;
        if (options.videoGamma !== undefined) this.videoGamma = options.videoGamma;
        if (options.videoBlackLevel !== undefined) this.videoBlackLevel = options.videoBlackLevel;
        if (options.histIn !== undefined) this.histIn = options.histIn;
        if (options.histOut !== undefined) this.histOut = options.histOut;
        if (options.histGamma !== undefined) this.histGamma = options.histGamma;
        if (options.colorCutoffThreshold !== undefined) this.colorCutoffThreshold = options.colorCutoffThreshold;
        if (options.keepInteriorZones !== undefined) this.keepInteriorZones = !!options.keepInteriorZones;
        if (options.autoCenter3D !== undefined) this.autoCenter3D = options.autoCenter3D;
        if (options.originMode !== undefined) this.originMode = options.originMode;
        if (options.offsetX !== undefined) this.offsetX = options.offsetX;
        if (options.offsetY !== undefined) this.offsetY = options.offsetY;
        if (options.offsetZ !== undefined) this.offsetZ = options.offsetZ;
        if (options.rotationX !== undefined) this.rotationX = options.rotationX;
        if (options.rotationY !== undefined) this.rotationY = options.rotationY;
        if (options.rotationZ !== undefined) this.rotationZ = options.rotationZ;
        if (options.enableSplatPooling !== undefined) this.enableSplatPooling = !!options.enableSplatPooling;
        if (options.poolingSkipFrames !== undefined) this.poolingSkipFrames = Math.max(0, options.poolingSkipFrames);
        if (options.fadeInFrames !== undefined) this.fadeInFrames = Math.max(0, options.fadeInFrames);
        if (options.fadeOutFrames !== undefined) this.fadeOutFrames = Math.max(0, options.fadeOutFrames);
        if (options.trimStart !== undefined) this.trimStart = Math.max(0, options.trimStart);
        if (options.trimEnd !== undefined) this.trimEnd = options.trimEnd;
    }

    setTrimRange(start, end) {
        if (!this.rawFrames || this.rawFrames.length === 0) return;
        const total = this.rawFrames.length;
        this.trimStart = Math.max(0, Math.min(total - 1, start));
        this.trimEnd = (end >= 0) ? Math.max(this.trimStart, Math.min(total - 1, end)) : (total - 1);

        const sourceList = (this.allKeyedFrames && this.allKeyedFrames.length === total) 
            ? this.allKeyedFrames 
            : this.rawFrames;
        this.frames = sourceList.slice(this.trimStart, this.trimEnd + 1);
        console.log(`[TrimRange] Set active sequence: frames [${this.trimStart + 1} .. ${this.trimEnd + 1}] (${this.frames.length} active frames)`);
    }

    // ==========================================
    // 1. VIDEO EXTRACTION & SAMPLING
    // ==========================================
    async extractFramesFromVideo(videoElement, targetFps = 30, maxDuration = 10, onProgress) {
        return new Promise(async (resolve, reject) => {
            try {
                const duration = Math.min(videoElement.duration || 2.0, maxDuration);
                const totalFrames = Math.max(2, Math.floor(duration * targetFps));
                const width = videoElement.videoWidth || 384;
                const height = videoElement.videoHeight || 384;

                const maxDim = 480;
                let workW = width;
                let workH = height;
                if (workW > maxDim || workH > maxDim) {
                    const scale = maxDim / Math.max(workW, workH);
                    workW = Math.round(workW * scale);
                    workH = Math.round(workH * scale);
                }
                workW = Math.floor(workW / 2) * 2;
                workH = Math.floor(workH / 2) * 2;

                const canvas = document.createElement('canvas');
                canvas.width = workW;
                canvas.height = workH;
                const ctx = canvas.getContext('2d', { willReadFrequently: true });

                const rawExtracted = [];
                videoElement.pause();

                for (let i = 0; i < totalFrames; i++) {
                    const time = (i / totalFrames) * duration;
                    videoElement.currentTime = time;

                    await new Promise(r => {
                        const onSeeked = () => {
                            videoElement.removeEventListener('seeked', onSeeked);
                            r();
                        };
                        videoElement.addEventListener('seeked', onSeeked);
                    });

                    ctx.drawImage(videoElement, 0, 0, workW, workH);
                    const imgData = ctx.getImageData(0, 0, workW, workH);
                    rawExtracted.push(imgData);

                    if (onProgress) {
                        onProgress(i / totalFrames, `Extraction frame ${i + 1}/${totalFrames}`);
                    }
                }

                this.rawFrames = rawExtracted;
                this.applyChromaKeyingPass();
                resolve(this.frames);
            } catch (err) {
                reject(err);
            }
        });
    }

    // ==========================================
    // 2. CHROMA KEY & ALPHA EXTRACTION PRÉ-PASS
    // ==========================================
    applyChromaKeyingPass() {
        if (!this.rawFrames || this.rawFrames.length === 0) return;

        let effectiveMode = this.keyingMode;
        let detectedKeyColor = [...this.keyColor];

        if (effectiveMode === 'auto') {
            const firstFrame = this.rawFrames[0];
            const autoKey = this.detectDominantBackgroundColor(firstFrame);
            effectiveMode = autoKey.mode;
            detectedKeyColor = autoKey.color;
            console.log(`[ChromaKey Auto] Detected Background: ${effectiveMode}`, detectedKeyColor);
        }

        const T = this.rawFrames.length;
        this.allKeyedFrames = [];

        if (this.trimEnd < 0 || this.trimEnd >= T) {
            this.trimEnd = T - 1;
        }

        const brightness = Math.max(0.05, this.videoBrightness !== undefined ? this.videoBrightness : 1.0);
        const contrast = Math.max(0.1, this.videoContrast !== undefined ? this.videoContrast : 1.0);
        const gamma = Math.max(0.2, this.videoGamma !== undefined ? this.videoGamma : 1.0);
        const blackLvl = Math.max(0.0, Math.min(0.5, this.videoBlackLevel || 0.0));
        const invGamma = 1.0 / gamma;

        const thresh = Math.max(0.0, this.keyThreshold !== undefined ? this.keyThreshold : 0.05);
        const softness = Math.max(0.005, this.keySoftness !== undefined ? this.keySoftness : 0.08);
        const spill = this.spillSuppression !== undefined ? this.spillSuppression : 0.85;

        const kR = detectedKeyColor[0] / 255.0;
        const kG = detectedKeyColor[1] / 255.0;
        const kB = detectedKeyColor[2] / 255.0;

        for (let t = 0; t < T; t++) {
            const raw = this.rawFrames[t];
            const w = raw.width;
            const h = raw.height;

            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            const processed = ctx.createImageData(w, h);

            const src = raw.data;
            const dst = processed.data;
            const len = w * h;

            for (let i = 0; i < len; i++) {
                const p = i * 4;
                let r = src[p] / 255.0;
                let g = src[p + 1] / 255.0;
                let b = src[p + 2] / 255.0;
                const aSrc = src[p + 3] / 255.0;

                // 1. Black level pedestal subtract
                if (blackLvl > 0.001) {
                    r = Math.max(0.0, (r - blackLvl) / (1.0 - blackLvl));
                    g = Math.max(0.0, (g - blackLvl) / (1.0 - blackLvl));
                    b = Math.max(0.0, (b - blackLvl) / (1.0 - blackLvl));
                }

                // 2. Brightness / Exposure Gain
                if (brightness !== 1.0) {
                    r *= brightness;
                    g *= brightness;
                    b *= brightness;
                }

                // 3. Contrast adjustment around midtone (0.5)
                if (contrast !== 1.0) {
                    r = (r - 0.5) * contrast + 0.5;
                    g = (g - 0.5) * contrast + 0.5;
                    b = (b - 0.5) * contrast + 0.5;
                }

                // 4. Gamma Correction (Lifts dark smoke & shadow details without crushing blacks)
                if (gamma !== 1.0) {
                    r = Math.pow(Math.max(0.0, r), invGamma);
                    g = Math.pow(Math.max(0.0, g), invGamma);
                    b = Math.pow(Math.max(0.0, b), invGamma);
                }

                r = Math.max(0.0, Math.min(1.0, r));
                g = Math.max(0.0, Math.min(1.0, g));
                b = Math.max(0.0, Math.min(1.0, b));

                // 5. Background Matting & Alpha Keying
                let alpha = 1.0;

                if (effectiveMode === 'green') {
                    const maxRB = Math.max(r, b);
                    const gDiff = g - maxRB * 1.05;

                    if (gDiff > thresh) {
                        alpha = Math.max(0.0, Math.min(1.0, 1.0 - (gDiff - thresh) / softness));
                    } else {
                        alpha = 1.0;
                    }

                    // Green Spill Suppression
                    if (alpha > 0.0 && g > maxRB) {
                        const maxAllowed = ((r + b) * 0.5) * spill + maxRB * (1.0 - spill);
                        g = Math.min(g, maxAllowed);
                    }
                } else if (effectiveMode === 'black') {
                    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
                    if (lum <= thresh) {
                        alpha = 0.0;
                    } else if (lum < thresh + softness) {
                        // Smooth cubic Hermite ease-in-out curve
                        const tNorm = (lum - thresh) / softness;
                        alpha = tNorm * tNorm * (3.0 - 2.0 * tNorm);
                    } else {
                        alpha = 1.0;
                    }
                } else if (effectiveMode === 'magenta' || effectiveMode === 'custom') {
                    const dR = r - kR;
                    const dG = g - kG;
                    const dB = b - kB;
                    const dist = Math.sqrt((dR * dR + dG * dG + dB * dB) / 3.0);

                    if (dist < thresh + softness) {
                        alpha = Math.max(0.0, Math.min(1.0, (dist - thresh) / softness));
                    } else {
                        alpha = 1.0;
                    }

                    if (alpha > 0.0 && dist < thresh * 1.8) {
                        const blend = 1.0 - alpha;
                        g = g * (1.0 - blend * spill) + ((r + b) * 0.5) * (blend * spill);
                    }
                } else {
                    alpha = aSrc;
                }

                // 6. Monochrome Histogram In/Out Range & Transfer Curve Filtering
                const hIn = (this.histIn !== undefined) ? this.histIn : (this.colorCutoffThreshold || 0.02);
                const hOut = (this.histOut !== undefined) ? this.histOut : 1.00;
                const hGamma = (this.histGamma !== undefined) ? this.histGamma : 1.0;
                const lum = 0.299 * r + 0.587 * g + 0.114 * b;

                if (lum <= hIn) {
                    alpha = 0.0;
                } else if (hOut > hIn) {
                    const normLum = Math.max(0.0, Math.min(1.0, (lum - hIn) / (hOut - hIn)));
                    const curveMult = Math.pow(normLum, Math.max(0.1, hGamma));
                    alpha *= curveMult;
                }

                const finalAlpha = Math.max(0.0, Math.min(1.0, alpha * aSrc));

                dst[p] = Math.round(r * 255.0);
                dst[p + 1] = Math.round(g * 255.0);
                dst[p + 2] = Math.round(b * 255.0);
                dst[p + 3] = Math.round(finalAlpha * 255.0);
            }

            // 7. Interior Zone Preservation & Hollow Hole Filling (Perimeter-Seed Flood Fill)
            if (this.keepInteriorZones && effectiveMode !== 'none') {
                const isExteriorBg = new Uint8Array(len);
                const queue = new Int32Array(len);
                let head = 0;
                let tail = 0;

                const bgAlphaThreshold = 12; // ~0.05 * 255

                // Seed queue from the 4 frame corners (with fallback search if a corner is foreground)
                const corners = [
                    [0, 0],
                    [w - 1, 0],
                    [0, h - 1],
                    [w - 1, h - 1]
                ];

                for (const [cx, cy] of corners) {
                    const cIdx = cy * w + cx;
                    if (dst[cIdx * 4 + 3] <= bgAlphaThreshold && !isExteriorBg[cIdx]) {
                        isExteriorBg[cIdx] = 1;
                        queue[tail++] = cIdx;
                    } else {
                        // If exact corner is occluded, search in 4x4 corner margin
                        let found = false;
                        for (let dy = 0; dy < 4 && !found; dy++) {
                            for (let dx = 0; dx < 4 && !found; dx++) {
                                const sx = (cx === 0) ? dx : (w - 1 - dx);
                                const sy = (cy === 0) ? dy : (h - 1 - dy);
                                const sIdx = sy * w + sx;
                                if (dst[sIdx * 4 + 3] <= bgAlphaThreshold && !isExteriorBg[sIdx]) {
                                    isExteriorBg[sIdx] = 1;
                                    queue[tail++] = sIdx;
                                    found = true;
                                }
                            }
                        }
                    }
                }

                // 4-Connected BFS traversal to find all connected exterior background pixels
                while (head < tail) {
                    const curr = queue[head++];
                    const cx = curr % w;
                    const cy = (curr / w) | 0;

                    if (cy > 0) {
                        const nIdx = curr - w;
                        if (!isExteriorBg[nIdx] && dst[nIdx * 4 + 3] <= bgAlphaThreshold) {
                            isExteriorBg[nIdx] = 1;
                            queue[tail++] = nIdx;
                        }
                    }
                    if (cy < h - 1) {
                        const nIdx = curr + w;
                        if (!isExteriorBg[nIdx] && dst[nIdx * 4 + 3] <= bgAlphaThreshold) {
                            isExteriorBg[nIdx] = 1;
                            queue[tail++] = nIdx;
                        }
                    }
                    if (cx > 0) {
                        const nIdx = curr - 1;
                        if (!isExteriorBg[nIdx] && dst[nIdx * 4 + 3] <= bgAlphaThreshold) {
                            isExteriorBg[nIdx] = 1;
                            queue[tail++] = nIdx;
                        }
                    }
                    if (cx < w - 1) {
                        const nIdx = curr + 1;
                        if (!isExteriorBg[nIdx] && dst[nIdx * 4 + 3] <= bgAlphaThreshold) {
                            isExteriorBg[nIdx] = 1;
                            queue[tail++] = nIdx;
                        }
                    }
                }

                // Any pixel NOT reached from the exterior border is inside the foreground silhouette.
                // Restore full opacity for enclosed dark smoke pockets and interior cavities.
                for (let i = 0; i < len; i++) {
                    if (!isExteriorBg[i]) {
                        const p = i * 4;
                        if (dst[p + 3] < 255) {
                            const origA = src[p + 3];
                            dst[p + 3] = (origA > 0) ? origA : 255;
                        }
                    }
                }
            }

            this.allKeyedFrames.push(processed);
        }

        this.frames = this.allKeyedFrames.slice(this.trimStart, this.trimEnd + 1);
    }

    /**
     * Compute 256-bin Monochrome Luminance Histogram for color/noise cutoff visualization
     */
    computeLuminanceHistogram(frameIndex = -1, numBins = 256) {
        let srcData = null;
        if (frameIndex >= 0 && this.allKeyedFrames && this.allKeyedFrames[frameIndex]) {
            srcData = this.allKeyedFrames[frameIndex].data;
        } else if (frameIndex >= 0 && this.rawFrames && this.rawFrames[frameIndex]) {
            srcData = this.rawFrames[frameIndex].data;
        } else if (this.allKeyedFrames && this.allKeyedFrames.length > 0) {
            const idx = (this.referenceFrameIdx >= 0 && this.referenceFrameIdx < this.allKeyedFrames.length) ? this.referenceFrameIdx : 0;
            srcData = this.allKeyedFrames[idx].data;
        } else if (this.rawFrames && this.rawFrames.length > 0) {
            srcData = this.rawFrames[0].data;
        }

        const binsLum = new Uint32Array(numBins);
        let maxBin = 0;
        let totalPixels = 0;
        let filteredPixels = 0;

        const hIn = (this.histIn !== undefined) ? this.histIn : (this.colorCutoffThreshold || 0.02);
        const cutoffByte = Math.round(hIn * 255);

        if (!srcData) {
            return { binsLum, maxBin: 1, totalPixels: 0, filteredPixels: 0, cutoffByte, numBins, histIn: hIn, histOut: this.histOut || 1.0, histGamma: this.histGamma || 1.0 };
        }

        const len = srcData.length / 4;
        totalPixels = len;

        for (let i = 0; i < len; i++) {
            const p = i * 4;
            const r = srcData[p];
            const g = srcData[p + 1];
            const b = srcData[p + 2];
            const a = srcData[p + 3];

            const lum = Math.min(255, Math.max(0, Math.round(0.299 * r + 0.587 * g + 0.114 * b)));
            const binIdx = Math.min(numBins - 1, Math.floor((lum / 256) * numBins));

            binsLum[binIdx]++;

            if (lum <= cutoffByte || a <= 2) {
                filteredPixels++;
            }

            if (binsLum[binIdx] > maxBin) maxBin = binsLum[binIdx];
        }

        return { 
            binsLum, 
            maxBin, 
            totalPixels, 
            filteredPixels, 
            cutoffByte, 
            numBins,
            histIn: hIn,
            histOut: (this.histOut !== undefined) ? this.histOut : 1.0,
            histGamma: (this.histGamma !== undefined) ? this.histGamma : 1.0
        };
    }

    detectDominantBackgroundColor(imgData) {
        const w = imgData.width;
        const h = imgData.height;
        const d = imgData.data;

        const samplePoints = [
            0, 4, 8, w * 4,
            (w - 1) * 4, (w - 2) * 4,
            ((h - 1) * w) * 4, ((h - 1) * w + 1) * 4,
            ((h - 1) * w + w - 1) * 4, ((h - 1) * w + w - 2) * 4
        ];

        let avgR = 0, avgG = 0, avgB = 0, count = 0;
        for (const idx of samplePoints) {
            if (idx >= 0 && idx < d.length - 4) {
                avgR += d[idx];
                avgG += d[idx + 1];
                avgB += d[idx + 2];
                count++;
            }
        }
        avgR /= count;
        avgG /= count;
        avgB /= count;

        const maxRB = Math.max(avgR, avgB);
        if (avgG > 90 && avgG > maxRB * 1.25) {
            return { mode: 'green', color: [Math.round(avgR), Math.round(avgG), Math.round(avgB)] };
        } else if (Math.max(avgR, avgG, avgB) < 50) {
            return { mode: 'black', color: [0, 0, 0] };
        } else if (avgR > 100 && avgB > 100 && avgG < 60) {
            return { mode: 'magenta', color: [Math.round(avgR), Math.round(avgG), Math.round(avgB)] };
        }

        return { mode: 'none', color: [Math.round(avgR), Math.round(avgG), Math.round(avgB)] };
    }

    // ==========================================
    // 3. DEPTH ESTIMATION PASS (ALPHA-AWARE)
    // ==========================================
    async computeDepthPass(onProgress) {
        if (!this.frames || this.frames.length === 0) throw new Error("No frames loaded.");
        const total = this.frames.length;
        this.depthMaps = [];

        for (let i = 0; i < total; i++) {
            const frame = this.frames[i];
            let depthMap;

            if (this.onnxSessionDepth) {
                depthMap = await this.inferDepthOnnx(frame);
            } else {
                depthMap = this.computeFastVolumetricDepth(frame);
            }

            this.depthMaps.push(depthMap);

            if (onProgress) {
                onProgress((i + 1) / total, `Depth Pass : Frame ${i + 1}/${total}`);
            }
            await new Promise(r => setTimeout(r, 0));
        }

        return this.depthMaps;
    }

    computeFastVolumetricDepth(imageData) {
        const w = imageData.width;
        const h = imageData.height;
        const data = imageData.data;
        const depth = new Float32Array(w * h);

        // 1. Calculate centroid and bounding radius of active foreground pixels
        let sumA = 0, sumAX = 0, sumAY = 0;
        for (let y = 0; y < h; y += 2) {
            const rowOff = y * w;
            for (let x = 0; x < w; x += 2) {
                const a = data[(rowOff + x) * 4 + 3] / 255.0;
                if (a > 0.05) {
                    sumA += a;
                    sumAX += x * a;
                    sumAY += y * a;
                }
            }
        }

        const cx = sumA > 0 ? (sumAX / sumA) : (w * 0.5);
        const cy = sumA > 0 ? (sumAY / sumA) : (h * 0.5);

        // Find 96th percentile radius
        let maxR2 = 100.0;
        for (let y = 0; y < h; y += 2) {
            const rowOff = y * w;
            for (let x = 0; x < w; x += 2) {
                const a = data[(rowOff + x) * 4 + 3] / 255.0;
                if (a > 0.15) {
                    const dx = x - cx;
                    const dy = y - cy;
                    const d2 = dx * dx + dy * dy;
                    if (d2 > maxR2) maxR2 = d2;
                }
            }
        }
        const maxR = Math.max(15.0, Math.sqrt(maxR2));

        // 2. Compute smooth volumetric hemispherical depth + subtle surface relief
        for (let y = 0; y < h; y++) {
            const rowOff = y * w;
            for (let x = 0; x < w; x++) {
                const idx = rowOff + x;
                const pIdx = idx * 4;
                const a = data[pIdx + 3] / 255.0;

                if (a < 0.03) {
                    depth[idx] = 0.0;
                    continue;
                }

                const r = data[pIdx] / 255.0;
                const g = data[pIdx + 1] / 255.0;
                const b = data[pIdx + 2] / 255.0;
                const lum = 0.299 * r + 0.587 * g + 0.114 * b;

                const dist = Math.hypot(x - cx, y - cy) / maxR;
                const rNorm = Math.min(1.0, dist);
                // Hemispherical dome: 1.0 at center, 0.0 at edge
                const dome = Math.sqrt(Math.max(0.0, 1.0 - rNorm * rNorm));

                // Subtle surface puffiness (flame billows)
                const relief = (lum - 0.5) * 0.15;

                depth[idx] = Math.max(0.0, Math.min(1.0, (dome * 0.85 + relief + 0.15 * lum) * Math.pow(a, 0.6)));
            }
        }

        // 3. Smooth depth with 3x3 filter
        const smoothed = new Float32Array(w * h);
        const radius = 2;
        for (let y = radius; y < h - radius; y++) {
            for (let x = radius; x < w - radius; x++) {
                const idx = y * w + x;
                if (data[idx * 4 + 3] < 8) {
                    smoothed[idx] = 0.0;
                    continue;
                }

                let sum = 0;
                let count = 0;
                for (let ky = -radius; ky <= radius; ky++) {
                    for (let kx = -radius; kx <= radius; kx++) {
                        const nIdx = (y + ky) * w + (x + kx);
                        if (data[nIdx * 4 + 3] > 8) {
                            sum += depth[nIdx];
                            count++;
                        }
                    }
                }
                smoothed[idx] = count > 0 ? (sum / count) : depth[idx];
            }
        }

        return smoothed;
    }

    async inferDepthOnnx(imageData) {
        return this.computeFastVolumetricDepth(imageData);
    }

    // ==========================================
    // 4. OPTICAL FLOW PASS
    // ==========================================
    async computeOpticalFlowPass(onProgress) {
        if (!this.frames || this.frames.length < 2) throw new Error("At least 2 frames required for optical flow.");
        const total = this.frames.length - 1;
        this.flowFields = [];

        for (let i = 0; i < total; i++) {
            const f0 = this.frames[i];
            const f1 = this.frames[i + 1];

            const flow = this.computePyramidalLucasKanadeFlow(f0, f1);
            this.flowFields.push(flow);

            if (onProgress) {
                onProgress((i + 1) / total, `Flux Optique : Pair ${i + 1}/${total}`);
            }
            await new Promise(r => setTimeout(r, 0));
        }

        return this.flowFields;
    }

    computePyramidalLucasKanadeFlow(img0, img1) {
        const w = img0.width;
        const h = img0.height;

        const I0 = this.toGrayscaleFloat(img0);
        const I1 = this.toGrayscaleFloat(img1);
        const a0 = img0.data;

        const u = new Float32Array(w * h);
        const v = new Float32Array(w * h);

        const Ix = new Float32Array(w * h);
        const Iy = new Float32Array(w * h);
        const It = new Float32Array(w * h);

        for (let y = 1; y < h - 1; y++) {
            for (let x = 1; x < w - 1; x++) {
                const idx = y * w + x;
                Ix[idx] = (I0[idx + 1] - I0[idx - 1] + I1[idx + 1] - I1[idx - 1]) * 0.25;
                Iy[idx] = (I0[idx + w] - I0[idx - w] + I1[idx + w] - I1[idx - w]) * 0.25;
                It[idx] = (I1[idx] - I0[idx]);
            }
        }

        const win = 4;
        for (let y = win; y < h - win; y++) {
            for (let x = win; x < w - win; x++) {
                const cIdx = y * w + x;
                if (a0[cIdx * 4 + 3] < 15) {
                    u[cIdx] = 0;
                    v[cIdx] = 0;
                    continue;
                }

                let Sxx = 0, Syy = 0, Sxy = 0, Sxt = 0, Syt = 0;
                for (let wy = -win; wy <= win; wy++) {
                    const rowOff = (y + wy) * w;
                    for (let wx = -win; wx <= win; wx++) {
                        const kIdx = rowOff + (x + wx);
                        const ix = Ix[kIdx];
                        const iy = Iy[kIdx];
                        const it = It[kIdx];

                        Sxx += ix * ix;
                        Syy += iy * iy;
                        Sxy += ix * iy;
                        Sxt += ix * it;
                        Syt += iy * it;
                    }
                }

                const det = Sxx * Syy - Sxy * Sxy + 0.001;
                const invDet = 1.0 / det;

                const du = -(Syy * Sxt - Sxy * Syt) * invDet;
                const dv = -(Sxx * Syt - Sxy * Sxt) * invDet;

                u[cIdx] = Math.max(-25.0, Math.min(25.0, du));
                v[cIdx] = Math.max(-25.0, Math.min(25.0, dv));
            }
        }

        return { u, v, width: w, height: h };
    }

    toGrayscaleFloat(imgData) {
        const d = imgData.data;
        const len = imgData.width * imgData.height;
        const gray = new Float32Array(len);
        for (let i = 0; i < len; i++) {
            const p = i * 4;
            const a = d[p + 3] / 255.0;
            gray[i] = ((d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114) / 255.0) * a;
        }
        return gray;
    }

    sampleFlowBilinear(flow, x, y) {
        const w = flow.width;
        const h = flow.height;
        if (x < 0 || x >= w - 1 || y < 0 || y >= h - 1) return { u: 0, v: 0 };

        const x0 = Math.floor(x);
        const y0 = Math.floor(y);
        const x1 = Math.min(w - 1, x0 + 1);
        const y1 = Math.min(h - 1, y0 + 1);

        const fx = x - x0;
        const fy = y - y0;

        const i00 = y0 * w + x0;
        const i10 = y0 * w + x1;
        const i01 = y1 * w + x0;
        const i11 = y1 * w + x1;

        const uVal = (1 - fx) * (1 - fy) * flow.u[i00] +
                     fx * (1 - fy) * flow.u[i10] +
                     (1 - fx) * fy * flow.u[i01] +
                     fx * fy * flow.u[i11];

        const vVal = (1 - fx) * (1 - fy) * flow.v[i00] +
                     fx * (1 - fy) * flow.v[i10] +
                     (1 - fx) * fy * flow.v[i01] +
                     fx * fy * flow.v[i11];

        return { u: uVal, v: vVal };
    }

    sampleDepthBilinear(depthMap, w, h, x, y) {
        if (x < 0) x = 0;
        if (x >= w - 1) x = w - 1;
        if (y < 0) y = 0;
        if (y >= h - 1) y = h - 1;

        const x0 = Math.floor(x);
        const y0 = Math.floor(y);
        const x1 = Math.min(w - 1, x0 + 1);
        const y1 = Math.min(h - 1, y0 + 1);

        const fx = x - x0;
        const fy = y - y0;

        const d00 = depthMap[y0 * w + x0];
        const d10 = depthMap[y0 * w + x1];
        const d01 = depthMap[y1 * w + x0];
        const d11 = depthMap[y1 * w + x1];

        return (1 - fx) * (1 - fy) * d00 +
               fx * (1 - fy) * d10 +
               (1 - fx) * fy * d01 +
               fx * fy * d11;
    }

    // ==========================================
    // 5. ADAPTIVE QUADTREE SPLAT GENERATION
    // ==========================================
    generateAdaptiveSplats(refFrameIdx = null) {
        const T = this.frames.length;
        if (T === 0) throw new Error("No frames available.");

        let refIdx = refFrameIdx !== null && refFrameIdx >= 0 ? refFrameIdx : this.referenceFrameIdx;
        if (refIdx < 0 || refIdx >= T) {
            refIdx = this.detectPeakExplosionFrame();
        }
        this.referenceFrameIdx = refIdx;

        const frame = this.frames[refIdx];
        const depth = this.depthMaps[refIdx];
        const w = frame.width;
        const h = frame.height;

        const energyMap = this.computeCombinedGradientEnergy(frame, depth);

        const targetTotal = this.targetSplatCount;
        const leaves = this.decomposeQuadtree(energyMap, frame, w, h, targetTotal);
        this.quadtreeCells = leaves;

        const N = leaves.length;
        const splatsBase = new Float32Array(N * 8);

        for (let i = 0; i < N; i++) {
            const cell = leaves[i];
            const cx = (cell.cx !== undefined) ? cell.cx : (cell.x + (cell.w || cell.size) * 0.5);
            const cy = (cell.cy !== undefined) ? cell.cy : (cell.y + (cell.h || cell.size) * 0.5);

            const ix = Math.max(0, Math.min(w - 1, Math.floor(cx)));
            const iy = Math.max(0, Math.min(h - 1, Math.floor(cy)));
            let pxIdx = (iy * w + ix) * 4;

            let r = frame.data[pxIdx] / 255.0;
            let g = frame.data[pxIdx + 1] / 255.0;
            let b = frame.data[pxIdx + 2] / 255.0;
            let a = frame.data[pxIdx + 3] / 255.0;

            // If sampled center has low alpha, check immediate 3x3 neighborhood for foreground pixel
            if (a < 0.08) {
                const x0 = Math.max(0, ix - 1);
                const y0 = Math.max(0, iy - 1);
                const x1 = Math.min(w, ix + 2);
                const y1 = Math.min(h, iy + 2);
                let maxA = a;

                for (let sy = y0; sy < y1; sy++) {
                    const row = sy * w;
                    for (let sx = x0; sx < x1; sx++) {
                        const p = (row + sx) * 4;
                        const pa = frame.data[p + 3] / 255.0;
                        if (pa > maxA) {
                            maxA = pa;
                            r = frame.data[p] / 255.0;
                            g = frame.data[p + 1] / 255.0;
                            b = frame.data[p + 2] / 255.0;
                            a = pa;
                        }
                    }
                }
            }

            const zNorm = this.sampleDepthBilinear(depth, w, h, cx, cy);
            const effectiveZ = this.invertDepth ? (1.0 - zNorm) : zNorm;

            // Standard Unity / Three.js Y-Up Coordinate System:
            // X = Horizontal (Right/Left across screen)
            // Y = Vertical Height (Up/Down)
            // Z = Forward Depth / Extrusion into scene
            const depthWorld = (effectiveZ - 0.5) * this.depthScale;
            const xWorld = (cx - w * 0.5) / this.focalLength;
            const yWorld = -(cy - h * 0.5) / this.focalLength;
            const zWorld = depthWorld;

            const cellSize = Math.max(cell.w || cell.size, cell.h || cell.size);
            const splatRadius = Math.max(0.0035, (Math.max(1.2, cellSize) / this.focalLength) * 1.3);

            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            const baseAlpha = Math.max(0.0, Math.min(1.0, a > 0.05 ? a : 0.8));

            const baseOffset = i * 8;
            splatsBase[baseOffset + 0] = xWorld;
            splatsBase[baseOffset + 1] = yWorld;
            splatsBase[baseOffset + 2] = zWorld;
            splatsBase[baseOffset + 3] = splatRadius;
            splatsBase[baseOffset + 4] = r;
            splatsBase[baseOffset + 5] = g;
            splatsBase[baseOffset + 6] = b;
            splatsBase[baseOffset + 7] = baseAlpha;

            cell.u0 = cx;
            cell.v0 = cy;
            cell.z0 = depthWorld;
            cell.splatRadius = splatRadius;
            cell.splatIndex = i;
        }

        this.splatsBase = splatsBase;
        return { splatCount: N, referenceFrame: refIdx, leaves };
    }

    detectPeakExplosionFrame() {
        if (!this.frames || this.frames.length === 0) return 0;
        const T = this.frames.length;
        let bestScore = -1;
        let peakIdx = 0;

        for (let t = 0; t < T; t++) {
            const d = this.frames[t].data;
            const len = d.length;
            let sumRad = 0;
            let count = 0;

            for (let j = 0; j < len; j += 16) {
                const r = d[j] / 255.0;
                const g = d[j + 1] / 255.0;
                const b = d[j + 2] / 255.0;
                const a = d[j + 3] / 255.0;

                if (a > 0.05) {
                    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
                    // Strongly weight bright explosive core
                    sumRad += (Math.pow(lum, 1.8) * 2.0 + (r + g * 0.8) * 0.5) * a;
                    count++;
                }
            }

            // Early-burst bias: explosion flash typically happens in first 40% of video
            const timeDecay = Math.max(0.4, 1.0 - (t / Math.max(1, T)) * 0.45);
            const score = sumRad * timeDecay;

            if (score > bestScore) {
                bestScore = score;
                peakIdx = t;
            }
        }

        console.log(`[PeakExplosion] Auto-detected reference peak frame: ${peakIdx + 1} / ${T}`);
        return peakIdx;
    }

    computeCombinedGradientEnergy(frame, depthMap) {
        const w = frame.width;
        const h = frame.height;
        const energy = new Float32Array(w * h);
        const gray = this.toGrayscaleFloat(frame);
        const d = frame.data;

        for (let y = 1; y < h - 1; y++) {
            for (let x = 1; x < w - 1; x++) {
                const idx = y * w + x;
                const a = d[idx * 4 + 3] / 255.0;

                if (a < 0.04) {
                    energy[idx] = 0;
                    continue;
                }

                const r = d[idx * 4] / 255.0;
                const g = d[idx * 4 + 1] / 255.0;
                const b = d[idx * 4 + 2] / 255.0;
                const lum = 0.299 * r + 0.587 * g + 0.114 * b;

                // Sobel 2D Gradient on RGB
                const gx = (gray[idx + 1 + w] + 2 * gray[idx + 1] + gray[idx + 1 - w]) -
                           (gray[idx - 1 + w] + 2 * gray[idx - 1] + gray[idx - 1 - w]);
                const gy = (gray[idx + w - 1] + 2 * gray[idx + w] + gray[idx + w + 1]) -
                           (gray[idx - w - 1] + 2 * gray[idx - w] + gray[idx - w + 1]);
                const gradRgb = Math.hypot(gx, gy);

                // Laplacian 2D on Depth
                const lapDepth = Math.abs(
                    4 * depthMap[idx] -
                    depthMap[idx - 1] - depthMap[idx + 1] -
                    depthMap[idx - w] - depthMap[idx + w]
                );

                // Guaranteed foreground importance: Base 0.40 ensures solid core fireball coverage,
                // while gradient + laplacian boost fine fumerolles and sparks
                energy[idx] = a * (0.40 + 0.60 * lum + 1.25 * gradRgb + 0.85 * lapDepth);
            }
        }
        return energy;
    }

    decomposeQuadtree(energyMap, frame, w, h, targetCount) {
        let leaves = [];
        const heap = new BinaryMaxHeap();
        const maxDepth = 14;

        // 1. Initial Root Grid Tiling with fine rootBlockSize (16px)
        const rootBlockSize = 16;
        for (let y = 0; y < h; y += rootBlockSize) {
            for (let x = 0; x < w; x += rootBlockSize) {
                const bw = Math.min(rootBlockSize, w - x);
                const bh = Math.min(rootBlockSize, h - y);
                const stats = this.computeCellAlphaStats(frame, energyMap, w, h, x, y, bw, bh);

                if (stats.maxAlpha >= 0.015 || stats.avgAlpha >= 0.003) {
                    const cell = {
                        x, y,
                        size: Math.max(bw, bh),
                        w: bw, h: bh,
                        depth: 0,
                        energy: stats.avgEnergy,
                        maxAlpha: stats.maxAlpha,
                        avgAlpha: stats.avgAlpha,
                        cx: x + bw * 0.5,
                        cy: y + bh * 0.5
                    };
                    cell.score = (bw * bh) * (stats.avgEnergy * 2.0 + stats.avgAlpha * 1.5 + 0.1);
                    heap.push(cell);
                }
            }
        }

        if (heap.length === 0) {
            return [];
        }

        // 2. High-Performance Adaptive Subdivision using Binary Max Heap
        while (heap.length > 0) {
            const cell = heap.pop();

            const canSubdivide = (cell.w >= 1 && cell.h >= 1);
            const needsMoreSplats = (leaves.length + heap.length + 3 <= targetCount);
            const isTooLarge = cell.size >= 4 && cell.maxAlpha > 0.05;

            if (canSubdivide && cell.depth < maxDepth && (needsMoreSplats || isTooLarge)) {
                const hw = cell.w * 0.5;
                const hh = cell.h * 0.5;
                const nextDepth = cell.depth + 1;

                // 4 Quadrants
                const subQuads = [
                    { x: cell.x,      y: cell.y,      w: hw, h: hh, size: Math.max(hw, hh), depth: nextDepth, cx: cell.x + hw * 0.5, cy: cell.y + hh * 0.5 },
                    { x: cell.x + hw, y: cell.y,      w: hw, h: hh, size: Math.max(hw, hh), depth: nextDepth, cx: cell.x + hw * 1.5, cy: cell.y + hh * 0.5 },
                    { x: cell.x,      y: cell.y + hh, w: hw, h: hh, size: Math.max(hw, hh), depth: nextDepth, cx: cell.x + hw * 0.5, cy: cell.y + hh * 1.5 },
                    { x: cell.x + hw, y: cell.y + hh, w: hw, h: hh, size: Math.max(hw, hh), depth: nextDepth, cx: cell.x + hw * 1.5, cy: cell.y + hh * 1.5 }
                ];

                for (const sq of subQuads) {
                    if (sq.x < w && sq.y < h) {
                        const subStats = this.computeCellAlphaStats(frame, energyMap, w, h, Math.floor(sq.x), Math.floor(sq.y), Math.max(1, Math.ceil(sq.w)), Math.max(1, Math.ceil(sq.h)));
                        if (subStats.maxAlpha >= 0.01 || subStats.avgAlpha >= 0.002) {
                            sq.energy = subStats.avgEnergy;
                            sq.maxAlpha = subStats.maxAlpha;
                            sq.avgAlpha = subStats.avgAlpha;
                            sq.score = (sq.w * sq.h) * (sq.energy * 2.0 + sq.avgAlpha * 1.5 + 0.1);
                            heap.push(sq);
                        }
                    }
                }
            } else {
                if (cell.maxAlpha >= 0.01) {
                    leaves.push(cell);
                }
            }

            // Target splat count reached check
            if (leaves.length + heap.length >= targetCount) {
                while (heap.length > 0 && leaves.length < targetCount) {
                    const c = heap.pop();
                    if (c.maxAlpha >= 0.01) leaves.push(c);
                }
                break;
            }
        }

        // Add any remaining active cells if target count is not yet reached
        while (heap.length > 0 && leaves.length < targetCount) {
            const c = heap.pop();
            if (c.maxAlpha >= 0.01) leaves.push(c);
        }

        // 3. Exact target enforcement: Repeat subdivision on highest scoring leaves until leaves.length === targetCount
        if (leaves.length < targetCount && leaves.length > 0) {
            while (leaves.length < targetCount) {
                const needed = targetCount - leaves.length;
                leaves.sort((a, b) => b.score - a.score);
                const toSplit = Math.min(needed, Math.max(1, Math.floor(leaves.length / 2)));
                const nextLeaves = [];

                for (let i = 0; i < leaves.length; i++) {
                    const l = leaves[i];
                    if (i < toSplit && nextLeaves.length + (leaves.length - i) <= targetCount) {
                        const hw = l.w * 0.5;
                        const hh = l.h * 0.5;
                        const nextDepth = l.depth + 1;
                        nextLeaves.push({ x: l.x,      y: l.y,      w: hw, h: hh, size: Math.max(hw, hh), depth: nextDepth, cx: l.x + hw * 0.5, cy: l.y + hh * 0.5, energy: l.energy, maxAlpha: l.maxAlpha, avgAlpha: l.avgAlpha, score: l.score * 0.25 });
                        nextLeaves.push({ x: l.x + hw, y: l.y,      w: hw, h: hh, size: Math.max(hw, hh), depth: nextDepth, cx: l.x + hw * 1.5, cy: l.y + hh * 0.5, energy: l.energy, maxAlpha: l.maxAlpha, avgAlpha: l.avgAlpha, score: l.score * 0.25 });
                        nextLeaves.push({ x: l.x,      y: l.y + hh, w: hw, h: hh, size: Math.max(hw, hh), depth: nextDepth, cx: l.x + hw * 0.5, cy: l.y + hh * 1.5, energy: l.energy, maxAlpha: l.maxAlpha, avgAlpha: l.avgAlpha, score: l.score * 0.25 });
                        nextLeaves.push({ x: l.x + hw, y: l.y + hh, w: hw, h: hh, size: Math.max(hw, hh), depth: nextDepth, cx: l.x + hw * 1.5, cy: l.y + hh * 1.5, energy: l.energy, maxAlpha: l.maxAlpha, avgAlpha: l.avgAlpha, score: l.score * 0.25 });
                    } else {
                        nextLeaves.push(l);
                    }
                }
                leaves = nextLeaves;
            }
        }

        // If leaves > targetCount, keep top targetCount
        if (leaves.length > targetCount) {
            leaves.length = targetCount;
        }

        console.log(`[Quadtree] Decomposed into exactly ${leaves.length} splat cells (Target: ${targetCount})`);
        return leaves;
    }

    computeCellAlphaStats(frame, energyMap, w, h, x, y, cw, ch) {
        let sumA = 0;
        let maxA = 0;
        let sumEnergy = 0;
        let count = 0;
        const d = frame.data;

        const maxX = Math.min(w, x + cw);
        const maxY = Math.min(h, y + ch);

        for (let cy = y; cy < maxY; cy++) {
            const rowOff = cy * w;
            for (let cx = x; cx < maxX; cx++) {
                const idx = rowOff + cx;
                const a = d[idx * 4 + 3] / 255.0;
                sumA += a;
                if (a > maxA) maxA = a;
                if (energyMap) sumEnergy += energyMap[idx] || 0;
                count++;
            }
        }

        return {
            avgAlpha: count > 0 ? (sumA / count) : 0,
            maxAlpha: maxA,
            avgEnergy: count > 0 ? (sumEnergy / count) : 0.5
        };
    }

    // ==========================================
    // 6. 3D ADVECTION & TEMPORAL SPLAT POOLING (ACROSS ALL FRAMES)
    // ==========================================
    async compute3DAdvectionPass(onProgress) {
        if (!this.splatsBase) throw new Error("Splats not generated yet.");
        const N = this.quadtreeCells.length;
        const T = this.frames.length;
        const w = this.frames[0].width;
        const h = this.frames[0].height;
        const refIdx = (this.referenceFrameIdx >= 0 && this.referenceFrameIdx < T) ? this.referenceFrameIdx : 0;

        // Splat track coordinates [T][N * 2] (u, v in screen space)
        this.splatTracks = new Array(T);
        const raw3D = new Array(T);
        for (let t = 0; t < T; t++) {
            this.splatTracks[t] = new Float32Array(N * 2);
            raw3D[t] = new Float32Array(N * 3);
        }

        this.splatsAnim = new Float32Array(T * N * 4);

        if (!this.enableSplatPooling) {
            // --- CLASSIC NON-POOLED ADVECTION ---
            for (let i = 0; i < N; i++) {
                this.splatTracks[refIdx][i * 2 + 0] = this.quadtreeCells[i].u0;
                this.splatTracks[refIdx][i * 2 + 1] = this.quadtreeCells[i].v0;
            }

            for (let t = refIdx; t < T - 1; t++) {
                const flow = this.flowFields[t];
                const currTracks = this.splatTracks[t];
                const nextTracks = this.splatTracks[t + 1];
                for (let i = 0; i < N; i++) {
                    const u = currTracks[i * 2 + 0];
                    const v = currTracks[i * 2 + 1];
                    const fSample = this.sampleFlowBilinear(flow, u, v);
                    nextTracks[i * 2 + 0] = Math.max(0, Math.min(w - 1, u + fSample.u));
                    nextTracks[i * 2 + 1] = Math.max(0, Math.min(h - 1, v + fSample.v));
                }
            }

            for (let t = refIdx - 1; t >= 0; t--) {
                const flow = this.flowFields[t];
                const nextTracks = this.splatTracks[t + 1];
                const prevTracks = this.splatTracks[t];
                for (let i = 0; i < N; i++) {
                    const u = nextTracks[i * 2 + 0];
                    const v = nextTracks[i * 2 + 1];
                    const fSample = this.sampleFlowBilinear(flow, u, v);
                    prevTracks[i * 2 + 0] = Math.max(0, Math.min(w - 1, u - fSample.u));
                    prevTracks[i * 2 + 1] = Math.max(0, Math.min(h - 1, v - fSample.v));
                }
            }

            for (let t = 0; t < T; t++) {
                const frame = this.frames[t];
                const tracks = this.splatTracks[t];
                const depth = this.depthMaps[t];

                let fadeFactor = 1.0;
                if (this.fadeInFrames > 0 && t < this.fadeInFrames) {
                    const f = t / Math.max(1, this.fadeInFrames);
                    fadeFactor *= f * f * (3.0 - 2.0 * f);
                }
                if (this.fadeOutFrames > 0 && t > (T - 1 - this.fadeOutFrames)) {
                    const f = Math.max(0, (T - 1 - t) / Math.max(1, this.fadeOutFrames));
                    fadeFactor *= f * f * (3.0 - 2.0 * f);
                }

                for (let i = 0; i < N; i++) {
                    const u = tracks[i * 2 + 0];
                    const v = tracks[i * 2 + 1];
                    const zNorm = this.sampleDepthBilinear(depth, w, h, u, v);
                    const effectiveZ = this.invertDepth ? (1.0 - zNorm) : zNorm;
                    raw3D[t][i * 3 + 0] = (u - w * 0.5) / this.focalLength;
                    raw3D[t][i * 3 + 1] = -(v - h * 0.5) / this.focalLength;
                    raw3D[t][i * 3 + 2] = (effectiveZ - 0.5) * this.depthScale;

                    let dynamicOpacity = 0.0;
                    if (u >= 0 && u < w && v >= 0 && v < h) {
                        const px = (Math.floor(v) * w + Math.floor(u)) * 4;
                        const a = frame.data[px + 3] / 255.0;
                        dynamicOpacity = Math.max(0.0, Math.min(1.0, a * fadeFactor));
                    }
                    this.splatsAnim[(t * N + i) * 4 + 3] = dynamicOpacity;
                }
            }
        } else {
            // --- TEMPORAL SPLAT POOLING & DYNAMIC RECYCLING ---
            const splatStates = new Array(N);
            const freePool = [];
            const skipRecycleFrames = Math.max(0, this.poolingSkipFrames || 0);

            for (let i = 0; i < N; i++) {
                splatStates[i] = {
                    active: false,
                    birthFrame: -1,
                    deathFrame: -1,
                    u: 0, v: 0,
                    radius: 0.02,
                    r: 1, g: 1, b: 1,
                    alpha: 0,
                    lastX: 0, lastY: 0, lastZ: 0
                };
                freePool.push(i);
            }

            // 1. Initial Seeding at Frame 0 from Quadtree
            const N0 = Math.min(this.quadtreeCells.length, N);
            for (let c = 0; c < N0 && freePool.length > 0; c++) {
                const cell = this.quadtreeCells[c];
                const id = freePool.pop();
                const state = splatStates[id];

                state.active = true;
                state.birthFrame = 0;
                state.u = cell.u0;
                state.v = cell.v0;
                state.radius = cell.splatRadius || ((Math.max(1.2, cell.size) / this.focalLength) * 1.3);
                state.r = this.splatsBase[c * 8 + 4];
                state.g = this.splatsBase[c * 8 + 5];
                state.b = this.splatsBase[c * 8 + 6];
                state.alpha = this.splatsBase[c * 8 + 7];
            }

            // 2. Sequential Temporal Forward Pass with Dynamic Life-cycle Pooling
            for (let t = 0; t < T; t++) {
                const frame = this.frames[t];
                const depth = this.depthMaps[t];
                const flowPrev = (t > 0 && this.flowFields[t - 1]) ? this.flowFields[t - 1] : null;

                // Fade In / Fade Out multiplier
                let fadeFactor = 1.0;
                if (this.fadeInFrames > 0 && t < this.fadeInFrames) {
                    const f = t / Math.max(1, this.fadeInFrames);
                    fadeFactor *= f * f * (3.0 - 2.0 * f);
                }
                if (this.fadeOutFrames > 0 && t > (T - 1 - this.fadeOutFrames)) {
                    const f = Math.max(0, (T - 1 - t) / Math.max(1, this.fadeOutFrames));
                    fadeFactor *= f * f * (3.0 - 2.0 * f);
                }

                // Phase 2.1: Advect & evaluate active splats
                for (let i = 0; i < N; i++) {
                    const state = splatStates[i];
                    if (!state.active) {
                        // Inactive: preserve last known coordinates with 0 opacity
                        raw3D[t][i * 3 + 0] = state.lastX;
                        raw3D[t][i * 3 + 1] = state.lastY;
                        raw3D[t][i * 3 + 2] = state.lastZ;
                        this.splatTracks[t][i * 2 + 0] = state.u;
                        this.splatTracks[t][i * 2 + 1] = state.v;
                        this.splatsAnim[(t * N + i) * 4 + 3] = 0.0;
                        continue;
                    }

                    let u = state.u;
                    let v = state.v;

                    if (t > 0 && flowPrev) {
                        const fSample = this.sampleFlowBilinear(flowPrev, u, v);
                        u = u + fSample.u;
                        v = v + fSample.v;
                    }

                    const isOOB = (u < 0 || u >= w - 1 || v < 0 || v >= h - 1);
                    let a = 0.0;
                    let r = state.r, g = state.g, b = state.b;

                    if (!isOOB) {
                        const px = (Math.floor(v) * w + Math.floor(u)) * 4;
                        r = frame.data[px] / 255.0;
                        g = frame.data[px + 1] / 255.0;
                        b = frame.data[px + 2] / 255.0;
                        a = frame.data[px + 3] / 255.0;
                    }

                    // If splat moved into background (alpha <= 0.015) or out of frame, recycle it!
                    if (isOOB || a <= 0.015) {
                        state.active = false;
                        state.deathFrame = t;
                        freePool.push(i);

                        raw3D[t][i * 3 + 0] = state.lastX;
                        raw3D[t][i * 3 + 1] = state.lastY;
                        raw3D[t][i * 3 + 2] = state.lastZ;
                        this.splatTracks[t][i * 2 + 0] = state.u;
                        this.splatTracks[t][i * 2 + 1] = state.v;
                        this.splatsAnim[(t * N + i) * 4 + 3] = 0.0;
                        continue;
                    }

                    // Splat remains active
                    state.u = u;
                    state.v = v;
                    state.r = r; state.g = g; state.b = b; state.alpha = a;

                    const zNorm = this.sampleDepthBilinear(depth, w, h, u, v);
                    const effectiveZ = this.invertDepth ? (1.0 - zNorm) : zNorm;
                    const depthWorld = (effectiveZ - 0.5) * this.depthScale;
                    const xWorld = (u - w * 0.5) / this.focalLength;
                    const yWorld = -(v - h * 0.5) / this.focalLength;
                    const zWorld = depthWorld;

                    state.lastX = xWorld;
                    state.lastY = yWorld;
                    state.lastZ = zWorld;

                    raw3D[t][i * 3 + 0] = xWorld;
                    raw3D[t][i * 3 + 1] = yWorld;
                    raw3D[t][i * 3 + 2] = zWorld;
                    this.splatTracks[t][i * 2 + 0] = u;
                    this.splatTracks[t][i * 2 + 1] = v;

                    this.splatsAnim[(t * N + i) * 4 + 3] = Math.max(0.0, Math.min(1.0, a * fadeFactor));
                }

                // Phase 2.2: Recycle free splats to cover new bursts & emerging foreground regions
                if (freePool.length > 0 && t >= skipRecycleFrames && t < T) {
                    const energy = this.computeCombinedGradientEnergy(frame, depth);
                    const blockSize = 16;
                    const gridW = Math.ceil(w / blockSize);
                    const gridH = Math.ceil(h / blockSize);
                    const coverage = new Uint16Array(gridW * gridH);

                    // Mark active splats coverage
                    for (let i = 0; i < N; i++) {
                        if (splatStates[i].active) {
                            const gx = Math.min(gridW - 1, Math.floor(splatStates[i].u / blockSize));
                            const gy = Math.min(gridH - 1, Math.floor(splatStates[i].v / blockSize));
                            coverage[gy * gridW + gx]++;
                        }
                    }

                    // Find uncovered high-energy blocks
                    const candidates = [];
                    for (let gy = 0; gy < gridH; gy++) {
                        for (let gx = 0; gx < gridW; gx++) {
                            const cov = coverage[gy * gridW + gx];
                            if (cov >= 3) continue;

                            const bx = gx * blockSize;
                            const by = gy * blockSize;
                            const bw = Math.min(blockSize, w - bx);
                            const bh = Math.min(blockSize, h - by);
                            const stats = this.computeCellAlphaStats(frame, energy, w, h, bx, by, bw, bh);

                            if (stats.maxAlpha >= 0.05) {
                                candidates.push({
                                    x: bx, y: by, w: bw, h: bh,
                                    cx: bx + bw * 0.5, cy: by + bh * 0.5,
                                    score: (stats.avgEnergy * 2.0 + stats.avgAlpha) / (cov + 1),
                                    alpha: stats.maxAlpha
                                });
                            }
                        }
                    }

                    candidates.sort((a, b) => b.score - a.score);

                    for (let c = 0; c < candidates.length && freePool.length > 0; c++) {
                        const cand = candidates[c];
                        const j = freePool.pop();
                        const state = splatStates[j];

                        const u0 = cand.cx;
                        const v0 = cand.cy;
                        const zNorm = this.sampleDepthBilinear(depth, w, h, u0, v0);
                        const effectiveZ = this.invertDepth ? (1.0 - zNorm) : zNorm;
                        const depthWorld = (effectiveZ - 0.5) * this.depthScale;
                        const xWorld = (u0 - w * 0.5) / this.focalLength;
                        const yWorld = -(v0 - h * 0.5) / this.focalLength;
                        const zWorld = depthWorld;

                        const px = (Math.floor(v0) * w + Math.floor(u0)) * 4;
                        const r = frame.data[px] / 255.0;
                        const g = frame.data[px + 1] / 255.0;
                        const b = frame.data[px + 2] / 255.0;
                        const a = frame.data[px + 3] / 255.0;

                        state.active = true;
                        state.birthFrame = t;
                        state.deathFrame = -1;
                        state.u = u0;
                        state.v = v0;
                        state.radius = (Math.max(1.2, cand.w) / this.focalLength) * 1.3;
                        state.r = r; state.g = g; state.b = b; state.alpha = a;
                        state.lastX = xWorld; state.lastY = yWorld; state.lastZ = zWorld;

                        // Fill past frames with spawn position & 0 opacity for smooth GPU interpolation
                        for (let pastT = 0; pastT < t; pastT++) {
                            raw3D[pastT][j * 3 + 0] = xWorld;
                            raw3D[pastT][j * 3 + 1] = yWorld;
                            raw3D[pastT][j * 3 + 2] = zWorld;
                            this.splatTracks[pastT][j * 2 + 0] = u0;
                            this.splatTracks[pastT][j * 2 + 1] = v0;
                            this.splatsAnim[(pastT * N + j) * 4 + 3] = 0.0;
                        }

                        // Current frame
                        raw3D[t][j * 3 + 0] = xWorld;
                        raw3D[t][j * 3 + 1] = yWorld;
                        raw3D[t][j * 3 + 2] = zWorld;
                        this.splatTracks[t][j * 2 + 0] = u0;
                        this.splatTracks[t][j * 2 + 1] = v0;
                        this.splatsAnim[(t * N + j) * 4 + 3] = Math.max(0.0, Math.min(1.0, a * fadeFactor));
                    }
                }

                if (onProgress) {
                    onProgress(0.5 + 0.25 * (t / (T - 1)), `Temporal Splat Pooling & Advection: Frame ${t + 1}/${T}`);
                }
                await new Promise(r => setTimeout(r, 0));
            }
        }

        this.raw3D = raw3D;

        // 3. Compute 3D Origin & Centering Offset based on originMode and manual offsets
        this.computeCenterOffset();
        const [globalCenterX, globalCenterY, globalCenterZ] = this.centerOffset;

        // 4. Populate splatsBase
        for (let i = 0; i < N; i++) {
            const b = i * 8;
            const refX = raw3D[refIdx][i * 3 + 0] - globalCenterX;
            const refY = raw3D[refIdx][i * 3 + 1] - globalCenterY;
            const refZ = raw3D[refIdx][i * 3 + 2] - globalCenterZ;

            this.splatsBase[b + 0] = refX;
            this.splatsBase[b + 1] = refY;
            this.splatsBase[b + 2] = refZ;
        }

        // 5. Structure dynamic VAT deltas [T, N, 4]
        for (let t = 0; t < T; t++) {
            for (let i = 0; i < N; i++) {
                const b = i * 8;
                const baseX = this.splatsBase[b + 0];
                const baseY = this.splatsBase[b + 1];
                const baseZ = this.splatsBase[b + 2];

                const currentX = raw3D[t][i * 3 + 0] - globalCenterX;
                const currentY = raw3D[t][i * 3 + 1] - globalCenterY;
                const currentZ = raw3D[t][i * 3 + 2] - globalCenterZ;

                const vatIdx = (t * N + i) * 4;
                this.splatsAnim[vatIdx + 0] = currentX - baseX;
                this.splatsAnim[vatIdx + 1] = currentY - baseY;
                this.splatsAnim[vatIdx + 2] = currentZ - baseZ;
                // dynamicOpacity was already set in splatsAnim[vatIdx + 3]
            }

            if (onProgress) {
                onProgress(0.75 + 0.25 * (t / (T - 1)), `Finalisation Trajectoires VAT : Frame ${t + 1}/${T}`);
            }
        }

        return this.splatsAnim;
    }

    /**
     * Compute 3D Origin & Centering Offset
     * Modes:
     * - 'origin' (Blast Origin): Center of explosion at reference peak frame is aligned to (0, 0, 0)
     * - 'ground' (Ground Pivot): Lowest Y point of blast at reference frame is at Y=0, X & Z centered
     * - 'center' (Bounding Box): Midpoint of global 3D trajectory bounding box is at (0, 0, 0)
     * - 'centroid' (Mass Center): Global 3D weighted centroid across all frames is at (0, 0, 0)
     * - 'none' (Raw Camera Space): Unprojected camera coordinate system
     */
    computeCenterOffset() {
        if (!this.raw3D || this.raw3D.length === 0) {
            this.centerOffset = [-(this.offsetX || 0), -(this.offsetY || 0), -(this.offsetZ || 0)];
            return this.centerOffset;
        }

        const T = this.raw3D.length;
        const N = this.raw3D[0].length / 3;
        const refIdx = (this.referenceFrameIdx >= 0 && this.referenceFrameIdx < T) ? this.referenceFrameIdx : 0;

        if (!this.autoCenter3D || this.originMode === 'none') {
            this.centerOffset = [-(this.offsetX || 0), -(this.offsetY || 0), -(this.offsetZ || 0)];
            return this.centerOffset;
        }

        // 1. Reference / Blast Frame Centroid & Bounds
        let refMinX = Infinity, refMinY = Infinity, refMinZ = Infinity;
        let refMaxX = -Infinity, refMaxY = -Infinity, refMaxZ = -Infinity;
        let refSumX = 0, refSumY = 0, refSumZ = 0, refSumW = 0;

        const rawRef = this.raw3D[refIdx];
        for (let i = 0; i < N; i++) {
            const op = this.splatsAnim ? this.splatsAnim[(refIdx * N + i) * 4 + 3] : 1.0;
            if (op > 0.03) {
                const x = rawRef[i * 3 + 0];
                const y = rawRef[i * 3 + 1];
                const z = rawRef[i * 3 + 2];
                if (x < refMinX) refMinX = x; if (x > refMaxX) refMaxX = x;
                if (y < refMinY) refMinY = y; if (y > refMaxY) refMaxY = y;
                if (z < refMinZ) refMinZ = z; if (z > refMaxZ) refMaxZ = z;

                const w = op * op;
                refSumX += x * w;
                refSumY += y * w;
                refSumZ += z * w;
                refSumW += w;
            }
        }

        if (refMinX === Infinity) {
            refMinX = -0.5; refMaxX = 0.5; refMinY = -0.5; refMaxY = 0.5; refMinZ = -0.5; refMaxZ = 0.5;
            refSumX = 0; refSumY = 0; refSumZ = 0; refSumW = 1;
        }

        const refCentroidX = refSumW > 0 ? (refSumX / refSumW) : (refMinX + refMaxX) * 0.5;
        const refCentroidY = refSumW > 0 ? (refSumY / refSumW) : (refMinY + refMaxY) * 0.5;
        const refCentroidZ = refSumW > 0 ? (refSumZ / refSumW) : (refMinZ + refMaxZ) * 0.5;

        // 2. Global Trajectory Bounds & Mass Centroid across all active frames
        let globMinX = Infinity, globMinY = Infinity, globMinZ = Infinity;
        let globMaxX = -Infinity, globMaxY = -Infinity, globMaxZ = -Infinity;
        let globSumX = 0, globSumY = 0, globSumZ = 0, globSumW = 0;

        for (let t = 0; t < T; t++) {
            const rawT = this.raw3D[t];
            for (let i = 0; i < N; i++) {
                const op = this.splatsAnim ? this.splatsAnim[(t * N + i) * 4 + 3] : 1.0;
                if (op > 0.02) {
                    const x = rawT[i * 3 + 0];
                    const y = rawT[i * 3 + 1];
                    const z = rawT[i * 3 + 2];
                    if (x < globMinX) globMinX = x; if (x > globMaxX) globMaxX = x;
                    if (y < globMinY) globMinY = y; if (y > globMaxY) globMaxY = y;
                    if (z < globMinZ) globMinZ = z; if (z > globMaxZ) globMaxZ = z;

                    const w = op;
                    globSumX += x * w;
                    globSumY += y * w;
                    globSumZ += z * w;
                    globSumW += w;
                }
            }
        }

        if (globMinX === Infinity) {
            globMinX = -1; globMaxX = 1; globMinY = -1; globMaxY = 1; globMinZ = -1; globMaxZ = 1;
            globSumX = 0; globSumY = 0; globSumZ = 0; globSumW = 1;
        }

        const globCenterX = (globMinX + globMaxX) * 0.5;
        const globCenterY = (globMinY + globMaxY) * 0.5;
        const globCenterZ = (globMinZ + globMaxZ) * 0.5;

        const globCentroidX = globSumW > 0 ? (globSumX / globSumW) : globCenterX;
        const globCentroidY = globSumW > 0 ? (globSumY / globSumW) : globCenterY;
        const globCentroidZ = globSumW > 0 ? (globSumZ / globSumW) : globCenterZ;

        let baseCenterX = 0;
        let baseCenterY = 0;
        let baseCenterZ = 0;

        const mode = this.originMode || 'center';
        if (mode === 'origin' || mode === 'blast') {
            // Blast Origin: Center of reference/initial explosion at (0, 0, 0)
            baseCenterX = refCentroidX;
            baseCenterY = refCentroidY;
            baseCenterZ = refCentroidZ;
        } else if (mode === 'ground' || mode === 'bottom') {
            // Ground Pivot: lowest point of blast at Y = 0, X and Z centered on blast
            baseCenterX = refCentroidX;
            baseCenterY = refMinY;
            baseCenterZ = refCentroidZ;
        } else if (mode === 'center' || mode === 'volume') {
            // Global 3D Bounding Box midpoint
            baseCenterX = globCenterX;
            baseCenterY = globCenterY;
            baseCenterZ = globCenterZ;
        } else if (mode === 'centroid') {
            // Global weighted mass centroid
            baseCenterX = globCentroidX;
            baseCenterY = globCentroidY;
            baseCenterZ = globCentroidZ;
        }

        // Apply manual user offset (subtracting offset shifts splats in +direction)
        const finalCenterX = baseCenterX - (this.offsetX || 0);
        const finalCenterY = baseCenterY - (this.offsetY || 0);
        const finalCenterZ = baseCenterZ - (this.offsetZ || 0);

        this.centerOffset = [finalCenterX, finalCenterY, finalCenterZ];
        return this.centerOffset;
    }

    // ==========================================
    // 7. POST-PASS: MODULAR ANIMATION EFFECTS & TRANSFORM ROTATION OVER TIME
    // ==========================================
    applyEffects(effectsManager = null) {
        if (!this.raw3D || !this.splatsBase || !this.splatsAnim) return;
        const N = this.quadtreeCells ? this.quadtreeCells.length : (this.splatsBase.length / 8);
        const T = this.raw3D.length;
        if (N === 0 || T === 0) return;

        const refIdx = (this.referenceFrameIdx >= 0 && this.referenceFrameIdx < T) ? this.referenceFrameIdx : 0;
        this.computeCenterOffset();
        const globalCenterX = this.centerOffset[0];
        const globalCenterY = this.centerOffset[1];
        const globalCenterZ = this.centerOffset[2];

        // Extract active effects
        let effects = [];
        if (effectsManager) {
            if (typeof effectsManager.getActiveEffects === 'function') {
                effects = effectsManager.getActiveEffects();
            } else if (Array.isArray(effectsManager)) {
                effects = effectsManager.filter(e => e && e.enabled !== false);
            }
        }

        const heightEffect = effects.find(e => e.type === 'height_over_time' && e.enabled);
        const scaleEffect = effects.find(e => e.type === 'scale_over_time' && e.enabled);
        const spherifyEffect = effects.find(e => e.type === 'spherify' && e.enabled);
        const proxyEffect = effects.find(e => e.type === 'isometric_proxy' && e.enabled);
        const shaperEffects = effects.filter(e => (e.type === 'shaper_in' || e.type === 'shaper_out') && e.enabled);
        const emissiveEffect = effects.find(e => e.type === 'emissive_over_time' && e.enabled);
        const luminanceEffect = effects.find(e => e.type === 'luminance_emissive' && e.enabled);
        const hsvEffect = effects.find(e => e.type === 'hsv_mix_tint' && e.enabled);
        const smoothEffect = effects.find(e => (e.type === 'smooth' || e.type === 'temporal_smooth') && e.enabled);

        // Backup original base splats array (geometry + color) if not cached
        if (!this.splatsBaseOrig && this.splatsBase) {
            this.splatsBaseOrig = new Float32Array(this.splatsBase);
        }

        // 3D Euler Rotation Matrix (R = Rz * Ry * Rx)
        const radX = (this.rotationX || 0) * Math.PI / 180.0;
        const radY = (this.rotationY || 0) * Math.PI / 180.0;
        const radZ = (this.rotationZ || 0) * Math.PI / 180.0;

        const cx = Math.cos(radX), sx = Math.sin(radX);
        const cy = Math.cos(radY), sy = Math.sin(radY);
        const cz = Math.cos(radZ), sz = Math.sin(radZ);

        const m00 = cy * cz, m01 = sx * sy * cz - cx * sz, m02 = cx * sy * cz + sx * sz;
        const m10 = cy * sz, m11 = sx * sy * sz + cx * cz, m12 = cx * sy * sz - sx * cz;
        const m20 = -sy,     m21 = sx * cy,                m22 = cx * cy;

        // Allocate or clear splatsHeat array
        if (!this.splatsHeat || this.splatsHeat.length !== T * N) {
            this.splatsHeat = new Float32Array(T * N);
        } else {
            this.splatsHeat.fill(0.0);
        }

        // Point evaluation function for a single splat at frame t
        const evaluateSplatAtFrame = (splatIdx, frameIdx) => {
            const t01 = (T > 1) ? (frameIdx / (T - 1)) : 0.0;
            let px = this.raw3D[frameIdx][splatIdx * 3 + 0] - globalCenterX;
            let py = this.raw3D[frameIdx][splatIdx * 3 + 1] - globalCenterY;
            let pz = this.raw3D[frameIdx][splatIdx * 3 + 2] - globalCenterZ;

            // 1. Height over time (Axis modulation: Y by default, Z, X, or XYZ)
            if (heightEffect) {
                const mult = Math.max(0.2, heightEffect.evaluate(t01));
                const axis = heightEffect.axis || 'y';
                if (axis === 'y') {
                    py = py * mult;
                } else if (axis === 'z') {
                    pz = pz * mult;
                } else if (axis === 'x') {
                    px = px * mult;
                } else if (axis === 'xyz' || axis === 'all') {
                    px = px * mult;
                    py = py * mult;
                    pz = pz * mult;
                }
            }

            // 2. Scale over time (Radial 3D distance modulation)
            if (scaleEffect) {
                const scaleMult = Math.max(0.01, scaleEffect.evaluate(t01));
                px = px * scaleMult;
                py = py * scaleMult;
                pz = pz * scaleMult;
            }

            // 3. Spherify (Conform splats on half-sphere dome)
            if (spherifyEffect) {
                const sph = spherifyEffect.evaluateAt(px, py, pz, t01);
                px = sph.x;
                py = sph.y;
                pz = sph.z;
            }

            // 4. Isometric Box Proxy (Beveled Cube Corner Geometry Conform)
            if (proxyEffect) {
                const prox = proxyEffect.evaluateAt(px, py, pz, t01);
                px = prox.x;
                py = prox.y;
                pz = prox.z;
            }

            // 5. Shaper modifiers (In, Out, etc.)
            let totalDx = 0, totalDy = 0, totalDz = 0, totalHeat = 0;
            if (shaperEffects.length > 0) {
                for (let k = 0; k < shaperEffects.length; k++) {
                    const shaper = shaperEffects[k];
                    const res = shaper.evaluateAt(px, py, pz, t01);
                    totalDx += res.dx;
                    totalDy += res.dy;
                    totalDz += res.dz;
                    totalHeat += res.heat;
                }
            }

            px += totalDx;
            py += totalDy;
            pz += totalDz;

            // 6. Emissive Over Time (Curve 0.0 - 1.0)
            if (emissiveEffect) {
                totalHeat += emissiveEffect.evaluate(t01);
            }

            // 7. Luminance Emissive (Auto Incandescence Detection from RGB)
            if (luminanceEffect) {
                const b = splatIdx * 8;
                let curR = this.splatsBaseOrig ? this.splatsBaseOrig[b + 4] : this.splatsBase[b + 4];
                let curG = this.splatsBaseOrig ? this.splatsBaseOrig[b + 5] : this.splatsBase[b + 5];
                let curB = this.splatsBaseOrig ? this.splatsBaseOrig[b + 6] : this.splatsBase[b + 6];

                const frameData = (this.frames && this.frames[frameIdx]) ? this.frames[frameIdx] : null;
                const tracks = (this.splatTracks && this.splatTracks[frameIdx]) ? this.splatTracks[frameIdx] : null;
                if (frameData && tracks) {
                    const w = frameData.width;
                    const h = frameData.height;
                    const u = Math.floor(tracks[splatIdx * 2 + 0]);
                    const v = Math.floor(tracks[splatIdx * 2 + 1]);
                    if (u >= 0 && u < w && v >= 0 && v < h) {
                        const pxl = (v * w + u) * 4;
                        const r = frameData.data[pxl] / 255.0;
                        const g = frameData.data[pxl + 1] / 255.0;
                        const bCol = frameData.data[pxl + 2] / 255.0;
                        const a = frameData.data[pxl + 3] / 255.0;
                        if (a > 0.05 && (r + g + bCol) > 0.05) {
                            curR = r;
                            curG = g;
                            curB = bCol;
                        }
                    }
                }
                if (hsvEffect) {
                    const tinted = hsvEffect.applyColor(curR, curG, curB, t01);
                    curR = tinted.r;
                    curG = tinted.g;
                    curB = tinted.b;
                }
                totalHeat += luminanceEffect.evaluateColor(curR, curG, curB);
            }

            totalHeat = Math.max(0.0, Math.min(1.0, totalHeat));

            // 8. Apply Euler rotation
            const rotX = m00 * px + m01 * py + m02 * pz;
            const rotY = m10 * px + m11 * py + m12 * pz;
            const rotZ = m20 * px + m21 * py + m22 * pz;

            return { x: rotX, y: rotY, z: rotZ, heat: totalHeat };
        };

        // 1. Evaluate all positions and heat across all frames
        const allPositions = new Float32Array(T * N * 3);
        for (let t = 0; t < T; t++) {
            for (let i = 0; i < N; i++) {
                const res = evaluateSplatAtFrame(i, t);
                const posIdx = (t * N + i) * 3;
                allPositions[posIdx + 0] = res.x;
                allPositions[posIdx + 1] = res.y;
                allPositions[posIdx + 2] = res.z;
                this.splatsHeat[t * N + i] = res.heat;
            }
        }

        // 2. Apply Temporal Position Smoothing across frames (Anti-Stutter)
        if (smoothEffect && T > 1) {
            smoothEffect.applySmoothing(allPositions, N, T);
        }

        // 3. Update splatsBase for reference frame
        for (let i = 0; i < N; i++) {
            const b = i * 8;
            const refPosIdx = (refIdx * N + i) * 3;
            this.splatsBase[b + 0] = allPositions[refPosIdx + 0];
            this.splatsBase[b + 1] = allPositions[refPosIdx + 1];
            this.splatsBase[b + 2] = allPositions[refPosIdx + 2];

            // Apply HSV Tint to reference frame splatsBase colors
            const origR = this.splatsBaseOrig ? this.splatsBaseOrig[b + 4] : this.splatsBase[b + 4];
            const origG = this.splatsBaseOrig ? this.splatsBaseOrig[b + 5] : this.splatsBase[b + 5];
            const origB = this.splatsBaseOrig ? this.splatsBaseOrig[b + 6] : this.splatsBase[b + 6];
            if (hsvEffect) {
                const refT01 = (T > 1) ? (refIdx / (T - 1)) : 0.0;
                const tinted = hsvEffect.applyColor(origR, origG, origB, refT01);
                this.splatsBase[b + 4] = tinted.r;
                this.splatsBase[b + 5] = tinted.g;
                this.splatsBase[b + 6] = tinted.b;
            } else {
                this.splatsBase[b + 4] = origR;
                this.splatsBase[b + 5] = origG;
                this.splatsBase[b + 6] = origB;
            }
        }

        // 4. Update splatsAnim deltas for all frames
        for (let t = 0; t < T; t++) {
            for (let i = 0; i < N; i++) {
                const b = i * 8;
                const baseX = this.splatsBase[b + 0];
                const baseY = this.splatsBase[b + 1];
                const baseZ = this.splatsBase[b + 2];

                const posIdx = (t * N + i) * 3;
                const curX = allPositions[posIdx + 0];
                const curY = allPositions[posIdx + 1];
                const curZ = allPositions[posIdx + 2];

                const vatIdx = (t * N + i) * 4;
                this.splatsAnim[vatIdx + 0] = curX - baseX;
                this.splatsAnim[vatIdx + 1] = curY - baseY;
                this.splatsAnim[vatIdx + 2] = curZ - baseZ;
            }
        }

        // Invalidate cached binary package so exports use the updated animation
        this.bakedData = null;
    }

    applyPostPass(depthCurveEvaluator = null) {
        if (typeof depthCurveEvaluator === 'object' && depthCurveEvaluator !== null) {
            return this.applyEffects(depthCurveEvaluator);
        }

        const heightWrapper = {
            type: 'height_over_time',
            enabled: true,
            evaluate: (typeof depthCurveEvaluator === 'function') ? depthCurveEvaluator : (() => 1.0)
        };
        this.applyEffects([heightWrapper]);
    }

    // ==========================================
    // 7. BINARY MONOLITHIC PACKER
    // ==========================================
    packMonolithicBinary(fps = 30.0) {
        if (!this.splatsBase || !this.splatsAnim) {
            throw new Error("Pipeline data not computed.");
        }

        const N = this.quadtreeCells.length;
        const T = this.frames.length;
        const duration = T / fps;

        const headerSize = 32;
        const baseDataSize = N * 8 * 4;
        const animDataSize = T * N * 4 * 4;
        const totalBytes = headerSize + baseDataSize + animDataSize;

        const buffer = new ArrayBuffer(totalBytes);
        const dataView = new DataView(buffer);

        // Header (32 bytes)
        dataView.setUint32(0, 0x53504C54, true); // "SPLT"
        dataView.setUint32(4, 1, true);          // version 1
        dataView.setUint32(8, N, true);          // splatCount
        dataView.setUint32(12, T, true);         // frameCount
        dataView.setFloat32(16, fps, true);      // fps
        dataView.setFloat32(20, duration, true); // duration
        dataView.setUint32(24, 0, true);
        dataView.setUint32(28, 0, true);

        // Block 1: Splats Base Data
        const baseFloatView = new Float32Array(buffer, headerSize, N * 8);
        baseFloatView.set(this.splatsBase);

        // Block 2: Animation Trajectory Data
        const animFloatView = new Float32Array(buffer, headerSize + baseDataSize, T * N * 4);
        animFloatView.set(this.splatsAnim);

        this.bakedData = buffer;
        return {
            buffer,
            splatCount: N,
            frameCount: T,
            fps,
            duration,
            totalBytes,
            headerSize,
            baseDataSize,
            animDataSize
        };
    }

    downloadMonolithicBinary(filename = "explosion_splats.bytes", fps = 30.0) {
        if (!this.bakedData) {
            this.packMonolithicBinary(fps);
        }
        const blob = new Blob([this.bakedData], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // Global Bounding Box across all frames
    computeBoundingBox() {
        if (!this.splatsBase || !this.splatsAnim) return null;
        const N = this.quadtreeCells ? this.quadtreeCells.length : (this.splatsBase.length / 8);
        const T = this.frames ? this.frames.length : 1;
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        for (let t = 0; t < T; t++) {
            for (let i = 0; i < N; i++) {
                const b = i * 8;
                const vat = (t * N + i) * 4;
                const op = this.splatsAnim[vat + 3];
                if (op < 0.02) continue;

                const x = this.splatsBase[b + 0] + this.splatsAnim[vat + 0];
                const y = this.splatsBase[b + 1] + this.splatsAnim[vat + 1];
                const z = this.splatsBase[b + 2] + this.splatsAnim[vat + 2];

                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
                if (z < minZ) minZ = z;
                if (z > maxZ) maxZ = z;
            }
        }

        if (minX === Infinity) {
            minX = -1; maxX = 1; minY = -1; maxY = 1; minZ = -1; maxZ = 1;
        }

        let maxR = 0.05;
        for (let i = 0; i < N; i++) {
            const r = this.splatsBase[i * 8 + 3];
            if (r > maxR) maxR = r;
        }

        return {
            min: [minX, minY, minZ],
            max: [maxX, maxY, maxZ],
            size: [maxX - minX, maxY - minY, maxZ - minZ],
            center: [(minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5],
            maxRadius: maxR
        };
    }

    // Fast Single Frame 3D Gaussian Splats Preview (Instant generation)
    previewSingleFrame(frameIdx = 0) {
        if (!this.rawFrames || this.rawFrames.length === 0) {
            throw new Error("No video frames loaded.");
        }
        const T = this.rawFrames.length;
        frameIdx = Math.max(0, Math.min(T - 1, frameIdx));

        this.applyChromaKeyingPass();
        const activeFrame = (this.allKeyedFrames && this.allKeyedFrames[frameIdx]) ?
                            this.allKeyedFrames[frameIdx] : this.rawFrames[frameIdx];

        this.frames = [activeFrame];
        this.trimStart = frameIdx;
        this.trimEnd = frameIdx;
        this.referenceFrameIdx = 0;

        // 1. Single frame depth map
        const depthMap = this.computeFastVolumetricDepth(activeFrame);
        this.depthMaps = [depthMap];
        this.flowFields = [];

        // 2. Generate splats
        this.generateAdaptiveSplats(0);

        const N = this.quadtreeCells.length;
        const w = activeFrame.width;
        const h = activeFrame.height;

        this.splatTracks = [new Float32Array(N * 2)];
        for (let i = 0; i < N; i++) {
            this.splatTracks[0][i * 2 + 0] = this.quadtreeCells[i].u0;
            this.splatTracks[0][i * 2 + 1] = this.quadtreeCells[i].v0;
        }

        // 3. Static 1-frame animation buffer & raw3D cache
        this.raw3D = [new Float32Array(N * 3)];
        for (let i = 0; i < N; i++) {
            const b = i * 8;
            this.raw3D[0][i * 3 + 0] = this.splatsBase[b + 0];
            this.raw3D[0][i * 3 + 1] = this.splatsBase[b + 1];
            this.raw3D[0][i * 3 + 2] = this.splatsBase[b + 2];
        }

        this.splatsAnim = new Float32Array(1 * N * 4);
        for (let i = 0; i < N; i++) {
            const b = i * 8;
            const u = Math.max(0, Math.min(w - 1, Math.floor(this.quadtreeCells[i].u0)));
            const v = Math.max(0, Math.min(h - 1, Math.floor(this.quadtreeCells[i].v0)));
            const pxIdx = (v * w + u) * 4;
            const a = activeFrame.data[pxIdx + 3] / 255.0;
            this.splatsAnim[i * 4 + 0] = 0;
            this.splatsAnim[i * 4 + 1] = 0;
            this.splatsAnim[i * 4 + 2] = 0;
            this.splatsAnim[i * 4 + 3] = a > 0.05 ? a : this.splatsBase[b + 7];
        }

        // 4. Compute origin offset & center base
        this.computeCenterOffset();
        const [globalCenterX, globalCenterY, globalCenterZ] = this.centerOffset;

        for (let i = 0; i < N; i++) {
            const b = i * 8;
            this.splatsBase[b + 0] = this.raw3D[0][i * 3 + 0] - globalCenterX;
            this.splatsBase[b + 1] = this.raw3D[0][i * 3 + 1] - globalCenterY;
            this.splatsBase[b + 2] = this.raw3D[0][i * 3 + 2] - globalCenterZ;
        }

        this.applyPostPass();

        return { splatCount: N, frameCount: 1, frameIdx };
    }
}

if (typeof window !== 'undefined') {
    window.SplatBakingPipeline = SplatBakingPipeline;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { SplatBakingPipeline, BinaryMaxHeap };
}
