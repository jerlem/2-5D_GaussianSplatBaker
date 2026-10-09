/**
 * 2.5D Gaussian Splats - VAT 2D Multi-Resolution & Band-Strip Exporter (v2)
 * Features:
 * - Multi-Resolution Profiles: 1K (16k splats), 2K (65k splats), 4K (262k splats), 8K (1M splats)
 * - 2D Strip / Band Memory Layout (64 frames vertical bands)
 * - Exact Half-Texel GPU Sampling with zero seam bleeding
 * - Circumscribed Equilateral Triangle Mesh (OBJ + C# procedural generator with UInt16/UInt32 support)
 * - URP HLSL Billboard Shader with DecodeSplatVAT_float
 * - Multi-Instance C# Particle Pool with MaterialPropertyBlock instancing
 */

class VatTextureExporter {
    constructor() {
        this.targetFrameCount = 64;
    }

    /**
     * Get resolution configuration metrics for specified frame count (64, 128, or 256 frames)
     */
    static getProfileInfo(texRes, totalFrames = 64) {
        texRes = parseInt(texRes) || 2048;
        totalFrames = parseInt(totalFrames) || 64;
        if (![64, 128, 256].includes(totalFrames)) totalFrames = 64;

        const bandsCount = Math.floor(texRes / totalFrames);
        const splatsPerBand = texRes;
        const maxCapacity = bandsCount * splatsPerBand;

        return {
            texRes,
            totalFrames,
            bandsCount,
            splatsPerBand,
            maxCapacity,
            totalPixels: texRes * texRes,
            useUInt32Index: maxCapacity > 21845
        };
    }

    /**
     * Partition Alpha channel [0.0, 1.0]:
     * - [0.0, 0.5]: Smoke / passive opacity (0.0 -> 1.0)
     * - ]0.5, 1.0]: Fire / Incandescence emissive ratio (0.0 -> 1.0)
     */
    static encodeAlphaEmissive(opacity, emissiveRatio = 0.0) {
        if (emissiveRatio > 0.001) {
            const e = Math.min(Math.max(emissiveRatio, 0.0), 1.0);
            return 0.5 + e * 0.5;
        }
        const op = Math.min(Math.max(opacity, 0.0), 1.0);
        return op * 0.5;
    }

    /**
     * Resample and format baked splat data into 2D Strip / Band VAT layout (texRes x texRes)
     */
    sampleVatGrid(pipeline, texRes = 2048, totalFrames = 64, posMode = 'position') {
        if (!pipeline || !pipeline.splatsBase || !pipeline.splatsAnim) {
            throw new Error("Pipeline data not computed. Please bake first.");
        }

        const profile = VatTextureExporter.getProfileInfo(texRes, totalFrames);
        const N_src = pipeline.quadtreeCells ? pipeline.quadtreeCells.length : (pipeline.splatsBase.length / 8);
        const T_src = pipeline.frames ? pipeline.frames.length : 1;
        const N_target = Math.min(N_src, profile.maxCapacity);
        const T_target = profile.totalFrames; // 64, 128, or 256

        const posData = new Float32Array(profile.totalPixels * 4);   // X, Y, Z, Radius
        const colorData = new Uint8ClampedArray(profile.totalPixels * 4); // R, G, B, A (0..255)

        const baseSplats = pipeline.splatsBase;
        const animSplats = pipeline.splatsAnim;
        const isDisplacement = (posMode === 'displacement' || posMode === 'delta');

        let minX = Infinity, minY = Infinity, minZ = Infinity, minR = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity, maxR = -Infinity;

        // Populate VAT 2D textures using Band / Strip memory layout
        for (let t = 0; t < T_target; t++) {
            const s = (T_target > 1) ? (t / (T_target - 1)) : 0.0;
            const normalizedTime = s;
            const fFloat = s * Math.max(0, T_src - 1);
            const f0 = Math.floor(fFloat);
            const f1 = Math.min(T_src - 1, f0 + 1);
            const frac = fFloat - f0;

            const frame0 = (pipeline.frames && pipeline.frames[f0]) ? pipeline.frames[f0] : null;
            const frame1 = (pipeline.frames && pipeline.frames[f1]) ? pipeline.frames[f1] : null;
            const tracks0 = (pipeline.splatTracks && pipeline.splatTracks[f0]) ? pipeline.splatTracks[f0] : null;
            const tracks1 = (pipeline.splatTracks && pipeline.splatTracks[f1]) ? pipeline.splatTracks[f1] : null;

            for (let splatID = 0; splatID < N_target; splatID++) {
                // 2D Band-Strip Addressing:
                // col = splatID % texRes
                // bandIndex = Math.floor(splatID / texRes)
                // rowBase = bandIndex * 64
                // row = rowBase + t
                const col = splatID % profile.texRes;
                const bandIndex = Math.floor(splatID / profile.texRes);
                const row = bandIndex * T_target + t;
                const pixelIndex = (row * profile.texRes + col) * 4;

                const b = splatID * 8;
                const baseX = baseSplats[b + 0];
                const baseY = baseSplats[b + 1];
                const baseZ = baseSplats[b + 2];
                const baseRadius = baseSplats[b + 3];
                const baseAlpha = baseSplats[b + 7];

                const vatIdx0 = (f0 * N_src + splatID) * 4;
                const vatIdx1 = (f1 * N_src + splatID) * 4;

                // Interpolate delta translations & opacity
                const dx0 = animSplats[vatIdx0 + 0], dy0 = animSplats[vatIdx0 + 1], dz0 = animSplats[vatIdx0 + 2], op0 = animSplats[vatIdx0 + 3];
                const dx1 = animSplats[vatIdx1 + 0], dy1 = animSplats[vatIdx1 + 1], dz1 = animSplats[vatIdx1 + 2], op1 = animSplats[vatIdx1 + 3];

                const dx = dx0 + (dx1 - dx0) * frac;
                const dy = dy0 + (dy1 - dy0) * frac;
                const dz = dz0 + (dz1 - dz0) * frac;
                const opacity = Math.max(0.0, Math.min(1.0, op0 + (op1 - op0) * frac));

                let posX, posY, posZ, radius;
                if (opacity > 0.005) {
                    posX = isDisplacement ? dx : (baseX + dx);
                    posY = isDisplacement ? dy : (baseY + dy);
                    posZ = isDisplacement ? dz : (baseZ + dz);
                    radius = baseRadius;
                } else {
                    // For inactive splats: clamp safely to rest/zero
                    posX = isDisplacement ? 0.0 : baseX;
                    posY = isDisplacement ? 0.0 : baseY;
                    posZ = isDisplacement ? 0.0 : baseZ;
                    radius = 0.0;
                }

                posData[pixelIndex + 0] = posX;
                posData[pixelIndex + 1] = posY;
                posData[pixelIndex + 2] = posZ;
                posData[pixelIndex + 3] = radius;

                if (posX < minX) minX = posX; if (posX > maxX) maxX = posX;
                if (posY < minY) minY = posY; if (posY > maxY) maxY = posY;
                if (posZ < minZ) minZ = posZ; if (posZ > maxZ) maxZ = posZ;
                if (baseRadius < minR) minR = baseRadius; if (baseRadius > maxR) maxR = baseRadius;

                // Dynamic RGB color tracking
                let r = baseSplats[b + 4];
                let g = baseSplats[b + 5];
                let bCol = baseSplats[b + 6];

                if (frame0 && tracks0 && frame1 && tracks1) {
                    const u0 = Math.floor(tracks0[splatID * 2 + 0]);
                    const v0 = Math.floor(tracks0[splatID * 2 + 1]);
                    const u1 = Math.floor(tracks1[splatID * 2 + 0]);
                    const v1 = Math.floor(tracks1[splatID * 2 + 1]);

                    const p0 = (v0 * frame0.width + u0) * 4;
                    const p1 = (v1 * frame1.width + u1) * 4;

                    if (p0 >= 0 && p0 < frame0.data.length && p1 >= 0 && p1 < frame1.data.length) {
                        const r0 = frame0.data[p0] / 255.0, g0 = frame0.data[p0 + 1] / 255.0, b0_ = frame0.data[p0 + 2] / 255.0;
                        const r1 = frame1.data[p1] / 255.0, g1 = frame1.data[p1 + 1] / 255.0, b1_ = frame1.data[p1 + 2] / 255.0;
                        r = r0 + (r1 - r0) * frac;
                        g = g0 + (g1 - g0) * frac;
                        bCol = b0_ + (b1_ - b0_) * frac;
                    }
                }

                // HSV Mix Tint Effect
                const effectsMgr = (pipeline && pipeline.effectsManager) || (typeof effectsManager !== 'undefined' ? effectsManager : null);
                const hsvEffect = effectsMgr ? effectsMgr.getActiveEffects().find(e => e.type === 'hsv_mix_tint') : null;
                if (hsvEffect) {
                    const tinted = hsvEffect.applyColor(r, g, bCol, normalizedTime);
                    r = tinted.r;
                    g = tinted.g;
                    bCol = tinted.b;
                }

                // Dynamic Emissive Heat from Shaper effects
                let heat = 0.0;
                if (pipeline.splatsHeat) {
                    const heat0 = pipeline.splatsHeat[f0 * N_src + splatID] || 0.0;
                    const heat1 = pipeline.splatsHeat[f1 * N_src + splatID] || 0.0;
                    heat = heat0 + (heat1 - heat0) * frac;
                    if (heat > 0.001) {
                        r = Math.min(1.0, r + heat * 1.0);
                        g = Math.min(1.0, g + heat * 0.5);
                        bCol = Math.min(1.0, bCol + heat * 0.1);
                    }
                }

                const finalAlpha = Math.max(0.0, Math.min(1.0, baseAlpha * opacity));
                const encodedA = VatTextureExporter.encodeAlphaEmissive(finalAlpha, Math.min(1.0, heat));

                colorData[pixelIndex + 0] = Math.round(Math.max(0, Math.min(255, r * 255)));
                colorData[pixelIndex + 1] = Math.round(Math.max(0, Math.min(255, g * 255)));
                colorData[pixelIndex + 2] = Math.round(Math.max(0, Math.min(255, bCol * 255)));
                colorData[pixelIndex + 3] = Math.round(Math.max(0, Math.min(255, encodedA * 255)));
            }
        }

        if (minX === Infinity || minX === maxX) { minX = -1; maxX = 1; }
        if (minY === Infinity || minY === maxY) { minY = -1; maxY = 1; }
        if (minZ === Infinity || minZ === maxZ) { minZ = -0.5; maxZ = 0.5; }
        if (maxR <= 0.0001 || maxR === -Infinity) maxR = 0.15;

        return {
            posData,
            colorData,
            splatCount: N_target,
            texRes: profile.texRes,
            profile,
            posMode: isDisplacement ? 'displacement' : 'position',
            bounds: {
                min: [minX, minY, minZ],
                max: [maxX, maxY, maxZ],
                size: [maxX - minX, maxY - minY, maxZ - minZ],
                maxRadius: maxR
            },
            rotation: [pipeline.rotationX || 0, pipeline.rotationY || 0, pipeline.rotationZ || 0]
        };
    }

    /**
     * Generate _ColorTex as PNG Blob (Square texRes x texRes RGBA8)
     */
    async generateColorTextureBlob(colorData, texRes = 2048) {
        const canvas = document.createElement('canvas');
        canvas.width = texRes;
        canvas.height = texRes;
        const ctx = canvas.getContext('2d');
        const imgData = ctx.createImageData(texRes, texRes);
        imgData.data.set(colorData);
        ctx.putImageData(imgData, 0, 0);

        return new Promise(resolve => {
            canvas.toBlob(blob => resolve(blob), 'image/png');
        });
    }

    /**
     * Generate _PosTex as 16-bit Half-Float Binary (Square texRes x texRes RGBAHalf)
     */
    generatePosHalfFloatBinary(posData, texRes = 2048) {
        const totalPixels = texRes * texRes;
        const buffer = new ArrayBuffer(totalPixels * 4 * 2); // 4 channels * 2 bytes (Uint16)
        const uint16View = new Uint16Array(buffer);

        // IEEE 754 32-bit Float to 16-bit Half-Float converter
        function floatToHalf(val) {
            const f32 = new Float32Array(1);
            const u32 = new Uint32Array(f32.buffer);
            f32[0] = val;
            const x = u32[0];

            let sign = (x >> 31) & 1;
            let exp = (x >> 23) & 0xFF;
            let mant = x & 0x7FFFFF;

            if (exp === 255) {
                return (sign << 15) | (31 << 10) | (mant ? 1 : 0);
            }
            let newExp = exp - 127 + 15;
            if (newExp >= 31) {
                return (sign << 15) | (31 << 10);
            }
            if (newExp <= 0) {
                if (newExp < -10) return sign << 15;
                mant = (mant | 0x800000) >> (1 - newExp);
                return (sign << 15) | (mant >> 13);
            }
            return (sign << 15) | (newExp << 10) | (mant >> 13);
        }

        const totalChannels = totalPixels * 4;
        for (let i = 0; i < totalChannels; i++) {
            uint16View[i] = floatToHalf(posData[i]);
        }

        return buffer;
    }

    /**
     * Generate _PosTex as 16-bit Half-Float OpenEXR ArrayBuffer (texRes x texRes RGBAHalf)
     */
    generatePosExrBinary(posData, texRes = 2048) {
        function floatToHalf(val) {
            const f32 = new Float32Array(1);
            const u32 = new Uint32Array(f32.buffer);
            f32[0] = val;
            const x = u32[0];
            let sign = (x >> 31) & 1;
            let exp = (x >> 23) & 0xFF;
            let mant = x & 0x7FFFFF;
            if (exp === 255) return (sign << 15) | (31 << 10) | (mant ? 1 : 0);
            let newExp = exp - 127 + 15;
            if (newExp >= 31) return (sign << 15) | (31 << 10);
            if (newExp <= 0) {
                if (newExp < -10) return sign << 15;
                mant = (mant | 0x800000) >> (1 - newExp);
                return (sign << 15) | (mant >> 13);
            }
            return (sign << 15) | (newExp << 10) | (mant >> 13);
        }

        const width = texRes;
        const height = texRes;
        const channels = ['A', 'B', 'G', 'R']; // OpenEXR alphabetical ordering

        const headerBuf = [];
        function writeInt32(v) {
            headerBuf.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
        }
        function writeString(s) {
            for (let i = 0; i < s.length; i++) headerBuf.push(s.charCodeAt(i));
            headerBuf.push(0);
        }
        function writeAttr(name, type, valBytes) {
            writeString(name);
            writeString(type);
            writeInt32(valBytes.length);
            for (let b of valBytes) headerBuf.push(b);
        }

        // OpenEXR Magic & Version
        headerBuf.push(0x76, 0x2f, 0x31, 0x01); // Magic 0x01312f76
        headerBuf.push(0x02, 0x00, 0x00, 0x00); // Version 2 (single part scanline)

        // Attribute: channels (chlist)
        const chBytes = [];
        for (let ch of channels) {
            for (let i = 0; i < ch.length; i++) chBytes.push(ch.charCodeAt(i));
            chBytes.push(0);
            chBytes.push(1, 0, 0, 0); // pixel type: 1 = HALF (16-bit)
            chBytes.push(0, 0, 0, 0); // pLinear (1 byte) + 3 reserved
            chBytes.push(1, 0, 0, 0); // xSampling: 1
            chBytes.push(1, 0, 0, 0); // ySampling: 1
        }
        chBytes.push(0); // end of chlist
        writeAttr('channels', 'chlist', chBytes);

        // Attribute: compression (0 = NO_COMPRESSION)
        writeAttr('compression', 'compression', [0]);

        // Attribute: dataWindow & displayWindow
        const dw = [];
        function pushI32(arr, v) { arr.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff); }
        pushI32(dw, 0); pushI32(dw, 0); pushI32(dw, width - 1); pushI32(dw, height - 1);
        writeAttr('dataWindow', 'box2i', dw);
        writeAttr('displayWindow', 'box2i', dw);

        // Attributes: lineOrder, pixelAspectRatio, screenWindowCenter, screenWindowWidth
        writeAttr('lineOrder', 'lineOrder', [0]);
        writeAttr('pixelAspectRatio', 'float', [0, 0, 0x80, 0x3f]);
        writeAttr('screenWindowCenter', 'v2f', [0, 0, 0, 0, 0, 0, 0, 0]);
        writeAttr('screenWindowWidth', 'float', [0, 0, 0x80, 0x3f]);

        headerBuf.push(0); // End of header

        const headerLength = headerBuf.length;
        const tableOffset = headerLength;
        const tableLength = height * 8;
        const scanlineDataSize = 8 + 4 * width * 2;
        const totalFileSize = headerLength + tableLength + height * scanlineDataSize;

        const buffer = new ArrayBuffer(totalFileSize);
        const u8 = new Uint8Array(buffer);
        const dataView = new DataView(buffer);

        // Copy header bytes
        u8.set(headerBuf, 0);

        // Table & scanline data
        let curDataOffset = headerLength + tableLength;
        const channelOrderIndices = [3, 2, 1, 0]; // A (index 3), B (2), G (1), R (0)

        for (let y = 0; y < height; y++) {
            // Offset table entry (uint64 little-endian)
            dataView.setUint32(tableOffset + y * 8, curDataOffset, true);
            dataView.setUint32(tableOffset + y * 8 + 4, 0, true);

            // Scanline header: y (int32), dataSize (int32)
            dataView.setInt32(curDataOffset, y, true);
            dataView.setInt32(curDataOffset + 4, 4 * width * 2, true);

            let ptr = curDataOffset + 8;
            const rowStart = y * width * 4;

            for (let c = 0; c < 4; c++) {
                const ch = channelOrderIndices[c];
                for (let x = 0; x < width; x++) {
                    const val = posData[rowStart + x * 4 + ch];
                    dataView.setUint16(ptr, floatToHalf(val), true);
                    ptr += 2;
                }
            }

            curDataOffset += scanlineDataSize;
        }

        return buffer;
    }

    /**
     * Generate _PosTex as 16-bit Half-Float OpenEXR Blob
     */
    generatePosExrBlob(posData, texRes = 2048) {
        const buffer = this.generatePosExrBinary(posData, texRes);
        return new Blob([buffer], { type: 'image/x-exr' });
    }

    /**
     * Generate normalized position texture fallback (Square texRes x texRes PNG)
     */
    async generateNormalizedPosTextureBlob(posData, bounds, texRes = 2048) {
        const canvas = document.createElement('canvas');
        canvas.width = texRes;
        canvas.height = texRes;
        const ctx = canvas.getContext('2d');
        const imgData = ctx.createImageData(texRes, texRes);
        const dst = imgData.data;

        const sizeX = Math.max(0.0001, bounds.size[0]);
        const sizeY = Math.max(0.0001, bounds.size[1]);
        const sizeZ = Math.max(0.0001, bounds.size[2]);
        const maxR = Math.max(0.0001, bounds.maxRadius);

        const total = texRes * texRes;
        for (let i = 0; i < total; i++) {
            const p = i * 4;
            const px = Math.max(0.0, Math.min(1.0, (posData[p + 0] - bounds.min[0]) / sizeX));
            const py = Math.max(0.0, Math.min(1.0, (posData[p + 1] - bounds.min[1]) / sizeY));
            const pz = Math.max(0.0, Math.min(1.0, (posData[p + 2] - bounds.min[2]) / sizeZ));
            const pr = Math.max(0.0, Math.min(1.0, posData[p + 3] / maxR));

            dst[p + 0] = Math.round(px * 255);
            dst[p + 1] = Math.round(py * 255);
            dst[p + 2] = Math.round(pz * 255);
            dst[p + 3] = Math.round(pr * 255);
        }

        ctx.putImageData(imgData, 0, 0);
        return new Promise(resolve => {
            canvas.toBlob(blob => resolve(blob), 'image/png');
        });
    }

    /**
     * Generate Wavefront OBJ Mesh file containing N circumscribed equilateral triangles
     * UV0: 2D local vertex offset (V0, V1, V2)
     * UV1: Raw Splat ID (splatID as float)
     */
    generateCircumscribedTrianglesOBJ(splatCount = 16384) {
        let obj = "# 2.5D Gaussian Splats Circumscribed Triangles Mesh (v2 Band-Strip VAT)\n";
        obj += "# Primitive: Equilateral Triangles circumscribed to unit circle R=1\n";
        obj += `# Splats: ${splatCount} (Vertices: ${splatCount * 3}, Faces: ${splatCount})\n\n`;

        const sqrt3 = Math.sqrt(3.0); // 1.7320508075688772

        // 1. Vertices (v x y z) - local coordinates
        for (let i = 0; i < splatCount; i++) {
            obj += `v 0.000000 2.000000 0.000000\n`;
            obj += `v -${sqrt3.toFixed(6)} -1.000000 0.000000\n`;
            obj += `v ${sqrt3.toFixed(6)} -1.000000 0.000000\n`;
        }

        // 2. UV0: 2D local vertex coordinates (Vx, Vy)
        for (let i = 0; i < splatCount; i++) {
            obj += `vt 0.000000 2.000000\n`;
            obj += `vt -${sqrt3.toFixed(6)} -1.000000\n`;
            obj += `vt ${sqrt3.toFixed(6)} -1.000000\n`;
        }

        // 3. Faces (f v1/vt1 v2/vt2 v3/vt3)
        for (let i = 0; i < splatCount; i++) {
            const v1 = i * 3 + 1;
            const v2 = i * 3 + 2;
            const v3 = i * 3 + 3;
            obj += `f ${v1}/${v1} ${v2}/${v2} ${v3}/${v3}\n`;
        }

        return obj;
    }

    /**
     * Generate C# Procedural Mesh Generator Script for Unity with UInt16/UInt32 support
     */
    getMeshGeneratorCS(splatCount = 16384) {
        const useUInt32 = splatCount > 21845;
        return `// ============================================================================
// 2.5D Gaussian Splats - Circumscribed Triangles Mesh Generator (v2)
// Generates an N-Triangle Equilateral Mesh with Local UV0 and Raw SplatID UV1
// ============================================================================
using UnityEngine;
#if UNITY_EDITOR
using UnityEditor;
#endif

public static class SplatMeshGenerator
{
    public const int DEFAULT_SPLAT_COUNT = ${splatCount};

    public static Mesh CreateCircumscribedTrianglesMesh(int splatCount = DEFAULT_SPLAT_COUNT)
    {
        Mesh mesh = new Mesh();
        mesh.name = $"SplatCircumscribedTriangles_{splatCount}";
        
        // Use UInt32 index format when vertices exceed 65,535 (splats > 21,845)
        mesh.indexFormat = (splatCount > 21845) 
            ? UnityEngine.Rendering.IndexFormat.UInt32 
            : UnityEngine.Rendering.IndexFormat.UInt16;

        int vertexCount = splatCount * 3;
        Vector3[] vertices = new Vector3[vertexCount];
        Vector2[] uv0 = new Vector2[vertexCount]; // Local 2D coordinates for radial falloff & clipping
        Vector2[] uv1 = new Vector2[vertexCount]; // uv1.x = Raw integer splatID as float
        int[] triangles = new int[vertexCount];

        float sqrt3 = Mathf.Sqrt(3.0f); // 1.7320508f

        // Local vertices of equilateral triangle circumscribing the unit circle R=1
        Vector2 v0_local = new Vector2(0f, 2.0f);
        Vector2 v1_local = new Vector2(-sqrt3, -1.0f);
        Vector2 v2_local = new Vector2(sqrt3, -1.0f);

        for (int i = 0; i < splatCount; i++)
        {
            int baseIdx = i * 3;
            float rawSplatID = (float)i;

            // Vertices
            vertices[baseIdx + 0] = new Vector3(v0_local.x, v0_local.y, 0f);
            vertices[baseIdx + 1] = new Vector3(v1_local.x, v1_local.y, 0f);
            vertices[baseIdx + 2] = new Vector3(v2_local.x, v2_local.y, 0f);

            // UV0: Local 2D coordinates
            uv0[baseIdx + 0] = v0_local;
            uv0[baseIdx + 1] = v1_local;
            uv0[baseIdx + 2] = v2_local;

            // UV1: Raw splatID in X channel
            uv1[baseIdx + 0] = new Vector2(rawSplatID, 0f);
            uv1[baseIdx + 1] = new Vector2(rawSplatID, 0f);
            uv1[baseIdx + 2] = new Vector2(rawSplatID, 0f);

            // Triangles (Clockwise)
            triangles[baseIdx + 0] = baseIdx + 0;
            triangles[baseIdx + 1] = baseIdx + 1;
            triangles[baseIdx + 2] = baseIdx + 2;
        }

        mesh.vertices = vertices;
        mesh.uv = uv0;
        mesh.uv2 = uv1;
        mesh.triangles = triangles;
        
        // Artificially large bounding box to prevent premature frustum culling
        mesh.bounds = new Bounds(Vector3.zero, Vector3.one * 100f);

        return mesh;
    }

#if UNITY_EDITOR
    [MenuItem("Tools/2.5D Splats/Generate Triangle Mesh Asset (${splatCount} Splats)")]
    public static void SaveMeshAsset()
    {
        Mesh mesh = CreateCircumscribedTrianglesMesh(DEFAULT_SPLAT_COUNT);
        string path = $"Assets/Splats_CircumscribedTriangles_{DEFAULT_SPLAT_COUNT}.asset";
        AssetDatabase.CreateAsset(mesh, path);
        AssetDatabase.SaveAssets();
        Selection.activeObject = mesh;
        Debug.Log($"[SplatMeshGenerator] Saved {DEFAULT_SPLAT_COUNT} triangle mesh ({DEFAULT_SPLAT_COUNT * 3} vertices, IndexFormat: {mesh.indexFormat}) to {path}");
    }
#endif
}
`;
    }

    /**
     * Generate URP HLSL Billboard Shader with DecodeSplatVAT_float function
     */
    /**
     * Generate URP HLSL Billboard Shader with DecodeSplatVAT_float function
     */
    getVatShaderURP(texRes = 2048, totalFrames = 64, bounds = null) {
        texRes = parseInt(texRes) || 2048;
        totalFrames = parseInt(totalFrames) || 64;
        if (![64, 128, 256].includes(totalFrames)) totalFrames = 64;

        const bMin = bounds ? `float4(${bounds.min[0].toFixed(4)}, ${bounds.min[1].toFixed(4)}, ${bounds.min[2].toFixed(4)}, 0.0)` : `float4(-1.5, -1.5, -1.5, 0.0)`;
        const bSize = bounds ? `float4(${bounds.size[0].toFixed(4)}, ${bounds.size[1].toFixed(4)}, ${bounds.size[2].toFixed(4)}, 0.0)` : `float4(3.0, 3.0, 3.0, 0.0)`;
        const maxR = (bounds && bounds.maxRadius != null) ? bounds.maxRadius.toFixed(4) : `0.1500`;

        return `// ============================================================================
// 2.5D Gaussian Splats VAT Shader (URP / Band-Strip 2D Multi-Resolution)
// Features:
// - 2D Band-Strip VAT Addressing (${totalFrames} frames vertical bands)
// - Supports 0..1 Normalized PNG Position Maps and Raw Half-Float Maps (EXR)
// - Dual Mode: Absolute Position Map or Relative Displacement Vector Map
// - Optional sRGB Inverse Gamma Compensation
// - Single-Channel Partitioned Alpha/Emissive Decoding:
//     * [0.0, 0.5] = Smoke / Passive Opacity (0.0 -> 1.0)
//     * ]0.5, 1.0] = Fire / Incandescence Emissive (Ratio 0.0 -> 1.0)
// - DecodeSplatVAT_float with half-texel offset for seam-free sampling
// - Camera-facing billboard rotation via View Right and View Up vectors
// - Circular clipping of circumscribed equilateral triangles: clip(1.0 - distSq)
// - Soft Gaussian bell-curve radial opacity: exp(-3.0 * distSq)
// - Zero-cost GPU culling on end-of-life or radius <= 0
// - GPU Instancing & MaterialPropertyBlock support
// ============================================================================
Shader "Custom/2.5D_GaussianSplat_VAT_URP"
{
    Properties
    {
        [Header(VAT 2D Animation Textures)]
        [NoScaleOffset] _ColorTex ("Color & Alpha/Emissive VAT Texture (PNG)", 2D) = "white" {}
        [NoScaleOffset] _PosTex ("Position / Displacement VAT Texture (PNG)", 2D) = "black" {}

        [Header(VAT Configuration)]
        _TexResolution ("Texture Resolution Value", Int) = ${texRes}
        _TotalFrames ("Total VAT Frames", Int) = ${totalFrames}
        [Toggle] _IsNormalized ("Is 0..1 Normalized PNG Map", Float) = 1
        [Toggle] _FlipV ("Flip V Coordinate (Canvas to Unity)", Float) = 1
        [Toggle] _IsDisplacement ("Mode: 0=Position, 1=Displacement Vector", Float) = 0
        [Toggle] _SRGBCompensate ("Compensate sRGB Gamma (If PNG imported as sRGB)", Float) = 0

        [Header(Volumetric Bounding Box for Normalized Map)]
        _BoundsMin ("Bounds Min (XYZ)", Vector) = ${bMin}
        _BoundsSize ("Bounds Size (XYZ)", Vector) = ${bSize}
        _MaxRadius ("Max Splat Radius", Float) = ${maxR}

        [Header(Playback)]
        _NormalizedTime ("Animation Progress", Range(0.0, 1.0)) = 0.0

        [Header(Visual Adjustments)]
        _SizeMultiplier ("Size Multiplier", Range(0.01, 3.0)) = 1.0
        _AlphaMultiplier ("Alpha Multiplier", Range(0.1, 5.0)) = 1.0
        _MaxEmissionIntensity ("Max Emission Intensity (HDR)", Range(0.0, 50.0)) = 15.0
        _CoreGlow ("HDR Core Glow", Range(0.0, 3.0)) = 0.5
        [Toggle] _AdditiveBlend ("Additive Blending", Float) = 0
    }

    SubShader
    {
        Tags 
        { 
            "RenderType" = "Transparent" 
            "Queue" = "Transparent" 
            "RenderPipeline" = "UniversalPipeline" 
            "IgnoreProjector" = "True" 
        }

        Pass
        {
            Name "ForwardLit"
            Tags { "LightMode" = "UniversalForward" }

            Blend SrcAlpha OneMinusSrcAlpha
            ZWrite Off
            Cull Off

            HLSLPROGRAM
            #pragma target 4.5
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile_instancing

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            TEXTURE2D(_ColorTex);
            SAMPLER(sampler_ColorTex);

            TEXTURE2D(_PosTex);
            SAMPLER(sampler_PosTex);

            CBUFFER_START(UnityPerMaterial)
                int    _TexResolution;
                int    _TotalFrames;
                float  _IsNormalized;
                float  _FlipV;
                float  _IsDisplacement;
                float  _SRGBCompensate;
                float4 _BoundsMin;
                float4 _BoundsSize;
                float  _MaxRadius;
                float  _NormalizedTime;
                float  _SizeMultiplier;
                float  _AlphaMultiplier;
                float  _MaxEmissionIntensity;
                float  _CoreGlow;
            CBUFFER_END

            UNITY_INSTANCING_BUFFER_START(Props)
                UNITY_DEFINE_INSTANCED_PROP(float, _InstancedNormalizedTime)
            UNITY_INSTANCING_BUFFER_END(Props)

            struct Attributes
            {
                float3 positionOS : POSITION;
                float2 uv0        : TEXCOORD0; // Local 2D coordinates (V0, V1, V2)
                float2 uv1        : TEXCOORD1; // uv1.x = Raw Splat ID
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float2 uv0        : TEXCOORD0;
                float4 color      : COLOR0; // RGB: Base Color, A: Raw Encoded Alpha/Emissive
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            // ========================================================================
            // 2D Band-Strip VAT Decoding Function
            // ========================================================================
            void DecodeSplatVAT_float(
                float splatID_raw,
                float normalizedTime,
                uint texRes,
                uint totalFrames,
                out float3 localPos,
                out float splatRadius,
                out float4 splatColor)
            {
                uint splatID = (uint)splatID_raw;
                if (totalFrames == 0u) totalFrames = ${totalFrames}u;

                // 2D Band-Strip Decomposition
                uint col = splatID % texRes;
                uint bandIndex = splatID / texRes;
                float rowBase = (float)(bandIndex * totalFrames);

                // Continuous frame coordinate on totalFrames [0.0, totalFrames - 1]
                float frameCoord = saturate(normalizedTime) * (float)(totalFrames - 1u);

                // Normalized UV coordinates with half-texel offset and Canvas->Unity V-flip
                float u = (float(col) + 0.5) / float(texRes);
                float rawV = (rowBase + frameCoord + 0.5) / float(texRes);
                float v = (_FlipV > 0.5) ? (1.0 - rawV) : rawV;
                float2 uv = float2(u, v);

                // Sample VAT textures
                float4 posData   = SAMPLE_TEXTURE2D_LOD(_PosTex, sampler_PosTex, uv, 0);
                float4 colorData = SAMPLE_TEXTURE2D_LOD(_ColorTex, sampler_ColorTex, uv, 0);

                // Inverse sRGB gamma correction if texture was accidentally imported as sRGB
                float3 rawPos = posData.xyz;
                if (_SRGBCompensate > 0.5)
                {
                    rawPos = pow(saturate(rawPos), 1.0 / 2.2);
                }

                // Decode position & radius
                if (_IsNormalized > 0.5)
                {
                    localPos = rawPos * _BoundsSize.xyz + _BoundsMin.xyz;
                    splatRadius = (normalizedTime >= 1.0 || colorData.a <= 0.001) ? 0.0 : (posData.w * _MaxRadius);
                }
                else
                {
                    localPos = rawPos;
                    splatRadius = (normalizedTime >= 1.0 || colorData.a <= 0.001) ? 0.0 : posData.w;
                }

                splatColor = colorData;
            }

            // ========================================================================
            // Alpha & Emissive Decoding: Partitioned Single Channel (A)
            // Range [0.0, 0.5] = Smoke / Passive Opacity (0.0 -> 1.0)
            // Range ]0.5, 1.0] = Fire / Incandescence Emissive (Ratio 0.0 -> 1.0)
            // ========================================================================
            void DecodeAlphaEmissive(
                float rawA,
                float maxEmission,
                out float outAlpha,
                out float outEmissive)
            {
                float isFire = saturate((rawA - 0.5) * 1000.0);
                float smokeAlpha = saturate(rawA * 2.0);
                outAlpha = lerp(smokeAlpha, 1.0, isFire);

                float fireRatio = saturate((rawA - 0.5) * 2.0);
                outEmissive = fireRatio * maxEmission;
            }

            Varyings vert(Attributes input)
            {
                Varyings output = (Varyings)0;
                UNITY_SETUP_INSTANCE_ID(input);
                UNITY_TRANSFER_INSTANCE_ID(input, output);

                // Fetch normalized time (instanced or global)
                #ifdef UNITY_INSTANCING_ENABLED
                    float animT = UNITY_ACCESS_INSTANCED_PROP(Props, _InstancedNormalizedTime);
                #else
                    float animT = _NormalizedTime;
                #endif

                uint texRes = (_TexResolution > 0) ? (uint)_TexResolution : ${texRes}u;
                uint frames = (_TotalFrames > 0) ? (uint)_TotalFrames : ${totalFrames}u;

                float3 localCenter;
                float splatRadius;
                float4 colorData;

                DecodeSplatVAT_float(input.uv1.x, animT, texRes, frames, localCenter, splatRadius, colorData);

                // If Displacement mode, add displacement vector to vertex base position
                if (_IsDisplacement > 0.5)
                {
                    localCenter = input.positionOS.xyz + localCenter;
                }

                // Culling: If radius <= 0 or raw alpha <= 0.001, collapse triangle to degenerate point
                float radius = splatRadius * _SizeMultiplier;
                if (radius <= 0.0001 || colorData.a <= 0.001)
                {
                    output.positionCS = float4(0, 0, 0, 0);
                    output.uv0 = float2(0, 0);
                    output.color = float4(0, 0, 0, 0);
                    return output;
                }

                // Billboard orientation face camera
                float4 worldCenter = mul(GetObjectToWorldMatrix(), float4(localCenter, 1.0));

                // Camera orientation vectors in world space
                float3 camRight = UNITY_MATRIX_V[0].xyz;
                float3 camUp    = UNITY_MATRIX_V[1].xyz;

                float3 billboardOffset = (camRight * input.uv0.x + camUp * input.uv0.y) * radius;
                float3 worldPos = worldCenter.xyz + billboardOffset;

                output.positionCS = TransformWorldToHClip(worldPos);
                output.uv0 = input.uv0;
                output.color = colorData;

                return output;
            }

            half4 frag(Varyings input) : SV_Target
            {
                UNITY_SETUP_INSTANCE_ID(input);

                float2 centered = input.uv0;
                float distSq = dot(centered, centered);

                // 1. Clip outer corners of circumscribed triangle outside unit circle
                clip(1.0 - distSq);

                // 2. Decode partitioned Alpha channel into Opacity and Emissive
                float rawA = input.color.a;
                float outAlpha, outEmissive;
                DecodeAlphaEmissive(rawA, _MaxEmissionIntensity, outAlpha, outEmissive);

                // 3. Smooth Gaussian bell-curve radial falloff: exp(-3.0 * distSq)
                float gaussian = exp(-3.0 * distSq);
                float finalAlpha = outAlpha * _AlphaMultiplier * gaussian;
                if (finalAlpha < 0.005 && outEmissive < 0.01) discard;

                // 4. Volumetric core glow & Emissive HDR boost
                float3 baseRgb = input.color.rgb;
                float3 emissiveRgb = baseRgb + (baseRgb * outEmissive);
                float3 finalRgb = emissiveRgb * (1.0 + gaussian * _CoreGlow);

                return half4(finalRgb, saturate(finalAlpha));
            }
            ENDHLSL
        }
    }
    FallBack "Hidden/Universal Render Pipeline/FallbackError"
}
`;
    }

    /**
     * Generate SplatVATSpawner.cs with Key 'N' in-game spawn & GPU Instanced particle manager
     */
    getParticlePoolCS(texRes = 2048, totalFrames = 64) {
        totalFrames = parseInt(totalFrames) || 64;
        const durationSec = (totalFrames / 30.0).toFixed(2);

        return `// ============================================================================
// 2.5D Gaussian Splats VAT Spawner & Animation Controller (Unity URP / C#)
// Compatible with both New Input System and Legacy Input Manager
// ============================================================================
using System.Collections.Generic;
using UnityEngine;

#if ENABLE_INPUT_SYSTEM
using UnityEngine.InputSystem;
#endif

public class SplatVATSpawner : MonoBehaviour
{
    [Header("Rendering Assets")]
    [Tooltip("Circumscribed equilateral triangle mesh created by SplatMeshGenerator or imported OBJ")]
    public Mesh splatMesh;

    [Tooltip("Material using Custom/2.5D_GaussianSplat_VAT_URP shader")]
    public Material splatMaterial;

    [Header("Playback & Timing")]
    [Tooltip("Total animation frames baked into the VAT texture")]
    public int totalFrames = ${totalFrames};

    [Tooltip("Target effect duration in seconds")]
    public float effectDuration = ${durationSec}f; // ${totalFrames} frames @ 30 FPS

    [Tooltip("Playback speed multiplier")]
    public float playbackSpeed = 1.0f;

    [Header("Spawn Settings")]
    [Tooltip("Default scale multiplier for spawned explosions")]
    public float defaultScale = 1.0f;

    [Tooltip("Distance in front of Camera when pressing spawn key")]
    public float spawnDistance = 4.0f;

#if ENABLE_LEGACY_INPUT_MANAGER
    [Tooltip("Key to trigger explosion in Play Mode (Legacy Input)")]
    public KeyCode spawnKey = KeyCode.N;
#endif

    [Tooltip("Maximum simultaneous active instances in GPU batch")]
    public int maxConcurrentInstances = 64;

    [Header("GUI Test Overlay")]
    public bool showTestUI = true;

    private class SplatInstance
    {
        public bool active;
        public float normalizedTime;
        public Vector3 position;
        public Quaternion rotation;
        public Vector3 scale;
        public Matrix4x4 matrix;
    }

    private List<SplatInstance> _pool;
    private MaterialPropertyBlock _propBlock;
    private float[] _timeArray;
    private Matrix4x4[] _matrixArray;

    private static readonly int NormalizedTimeProp = Shader.PropertyToID("_InstancedNormalizedTime");

    void Awake()
    {
        if (splatMesh == null)
        {
            splatMesh = CreateCircumscribedTrianglesMesh(65536);
        }

        _propBlock = new MaterialPropertyBlock();
        _pool = new List<SplatInstance>(maxConcurrentInstances);
        _timeArray = new float[maxConcurrentInstances];
        _matrixArray = new Matrix4x4[maxConcurrentInstances];

        for (int i = 0; i < maxConcurrentInstances; i++)
        {
            _pool.Add(new SplatInstance
            {
                active = false,
                normalizedTime = 1.0f,
                position = Vector3.zero,
                rotation = Quaternion.identity,
                scale = Vector3.one,
                matrix = Matrix4x4.identity
            });
        }
    }

    void Update()
    {
        // 1. Trigger spawn on Key press (Supports both New and Legacy Input Systems)
        if (IsSpawnKeyPressed())
        {
            SpawnInFrontOfCamera();
        }

        // 2. Advance active animations
        int activeCount = 0;
        float dtNormalized = (Time.deltaTime * playbackSpeed) / Mathf.Max(0.01f, effectDuration);

        for (int i = 0; i < _pool.Count; i++)
        {
            var inst = _pool[i];
            if (inst.active)
            {
                inst.normalizedTime += dtNormalized;
                if (inst.normalizedTime >= 1.0f)
                {
                    inst.active = false;
                    inst.normalizedTime = 1.0f;
                    continue;
                }

                _matrixArray[activeCount] = inst.matrix;
                _timeArray[activeCount] = inst.normalizedTime;
                activeCount++;
            }
        }

        // 3. Render all active instances with GPU instancing
        if (activeCount > 0 && splatMaterial != null && splatMesh != null)
        {
            _propBlock.SetFloatArray(NormalizedTimeProp, _timeArray);

            Graphics.DrawMeshInstanced(
                splatMesh,
                0,
                splatMaterial,
                _matrixArray,
                activeCount,
                _propBlock,
                UnityEngine.Rendering.ShadowCastingMode.Off,
                false
            );
        }
    }

    /// <summary>
    /// Checks if the [N] spawn key was pressed across Input Systems.
    /// </summary>
    private bool IsSpawnKeyPressed()
    {
#if ENABLE_INPUT_SYSTEM
        if (Keyboard.current != null && Keyboard.current.nKey.wasPressedThisFrame)
        {
            return true;
        }
#endif

#if ENABLE_LEGACY_INPUT_MANAGER
        if (Input.GetKeyDown(spawnKey))
        {
            return true;
        }
#endif

        return false;
    }

    /// <summary>
    /// Spawns an explosion at the specified world position and scale.
    /// </summary>
    public void Spawn(Vector3 worldPos, float scale = 1.0f)
    {
        for (int i = 0; i < _pool.Count; i++)
        {
            if (!_pool[i].active)
            {
                var inst = _pool[i];
                inst.active = true;
                inst.normalizedTime = 0.0f;
                inst.position = worldPos;
                inst.rotation = Quaternion.identity;
                inst.scale = Vector3.one * (scale > 0 ? scale : defaultScale);
                inst.matrix = Matrix4x4.TRS(inst.position, inst.rotation, inst.scale);
                return;
            }
        }
        Debug.LogWarning("[SplatVATSpawner] Maximum concurrent instances reached. Consider increasing maxConcurrentInstances.");
    }

    /// <summary>
    /// Spawns an explosion in front of the active camera.
    /// </summary>
    public void SpawnInFrontOfCamera()
    {
        Camera cam = Camera.main;
        Vector3 spawnPos = transform.position;

        if (cam != null)
        {
            spawnPos = cam.transform.position + cam.transform.forward * spawnDistance;
        }

        Spawn(spawnPos, defaultScale);
    }

    void OnGUI()
    {
        if (!showTestUI || !Application.isPlaying) return;

        GUILayout.BeginArea(new Rect(15, 15, 240, 115), "2.5D Splat VAT Spawner", GUI.skin.window);
        GUILayout.Label("Press [N] to Spawn");
        if (GUILayout.Button("Spawn Explosion [N]", GUILayout.Height(32)))
        {
            SpawnInFrontOfCamera();
        }
        GUILayout.Label($"Active Instances: {GetActiveCount()} / {maxConcurrentInstances}");
        GUILayout.EndArea();
    }

    private int GetActiveCount()
    {
        int count = 0;
        if (_pool != null)
        {
            for (int i = 0; i < _pool.Count; i++)
            {
                if (_pool[i].active) count++;
            }
        }
        return count;
    }

    /// <summary>
    /// Generates circumscribed equilateral triangles mesh for VAT billboards.
    /// </summary>
    public static Mesh CreateCircumscribedTrianglesMesh(int count = 65536)
    {
        Mesh mesh = new Mesh();
        mesh.name = "SplatCircumscribedTriangles_" + count;
        mesh.indexFormat = (count > 21845) 
            ? UnityEngine.Rendering.IndexFormat.UInt32 
            : UnityEngine.Rendering.IndexFormat.UInt16;

        int vertexCount = count * 3;
        Vector3[] vertices = new Vector3[vertexCount];
        Vector2[] uv0 = new Vector2[vertexCount]; // Local 2D coordinates (V0, V1, V2)
        Vector2[] uv1 = new Vector2[vertexCount]; // uv1.x = SplatID float
        int[] triangles = new int[vertexCount];

        float sqrt3 = Mathf.Sqrt(3.0f);
        Vector2 v0 = new Vector2(0f, 2.0f);
        Vector2 v1 = new Vector2(-sqrt3, -1.0f);
        Vector2 v2 = new Vector2(sqrt3, -1.0f);

        for (int i = 0; i < count; i++)
        {
            int b = i * 3;
            float id = (float)i;

            vertices[b + 0] = new Vector3(v0.x, v0.y, 0f);
            vertices[b + 1] = new Vector3(v1.x, v1.y, 0f);
            vertices[b + 2] = new Vector3(v2.x, v2.y, 0f);

            uv0[b + 0] = v0;
            uv0[b + 1] = v1;
            uv0[b + 2] = v2;

            uv1[b + 0] = new Vector2(id, 0f);
            uv1[b + 1] = new Vector2(id, 0f);
            uv1[b + 2] = new Vector2(id, 0f);

            triangles[b + 0] = b + 0;
            triangles[b + 1] = b + 1;
            triangles[b + 2] = b + 2;
        }

        mesh.vertices = vertices;
        mesh.uv = uv0;
        mesh.uv2 = uv1;
        mesh.triangles = triangles;
        mesh.bounds = new Bounds(Vector3.zero, Vector3.one * 100f);

        return mesh;
    }
}
`;
    }

    /**
     * Generate structured TXT summary with all settings for Unity
     */
    /**
     * Format active and configured animation effects and their parameters for the TXT export
     */
    formatEffectsTxt(pipeline) {
        const effectsMgr = (pipeline && pipeline.effectsManager) || (typeof effectsManager !== 'undefined' ? effectsManager : null);
        if (!effectsMgr || !effectsMgr.effects || effectsMgr.effects.length === 0) {
            return "No animation effects configured (None).\n";
        }

        const allEffects = effectsMgr.effects;
        const activeEffects = allEffects.filter(e => e.enabled);

        let out = `Active Effects Count : ${activeEffects.length} active (Total configured: ${allEffects.length})\n\n`;

        allEffects.forEach((eff, idx) => {
            const status = eff.enabled ? "ENABLED [Active]" : "DISABLED [Bypassed]";
            out += `[Effect #${idx + 1}] ${eff.name || eff.type} (${eff.type})\n`;
            out += `  - Status             : ${status}\n`;

            switch (eff.type) {
                case 'height_over_time': {
                    const ax = (eff.axis || 'y').toUpperCase();
                    out += `  - Modulation Axis    : ${ax}\n`;
                    out += `  - Min Scale (minY)   : ${(eff.minY !== undefined ? eff.minY : 0.2).toFixed(2)}x\n`;
                    out += `  - Max Scale (maxY)   : ${(eff.maxY !== undefined ? eff.maxY : 2.5).toFixed(2)}x\n`;
                    if (eff.points && eff.points.length > 0) {
                        const ptsStr = eff.points.map(p => `(t=${p.x.toFixed(2)}: ${p.y.toFixed(2)}x)`).join(', ');
                        out += `  - Curve Keyframes    : ${ptsStr}\n`;
                    }
                    break;
                }
                case 'scale_over_time': {
                    out += `  - Min Scale (minY)   : ${(eff.minY !== undefined ? eff.minY : 0.2).toFixed(2)}x\n`;
                    out += `  - Max Scale (maxY)   : ${(eff.maxY !== undefined ? eff.maxY : 2.5).toFixed(2)}x\n`;
                    if (eff.points && eff.points.length > 0) {
                        const ptsStr = eff.points.map(p => `(t=${p.x.toFixed(2)}: ${p.y.toFixed(2)}x)`).join(', ');
                        out += `  - Curve Keyframes    : ${ptsStr}\n`;
                    }
                    break;
                }
                case 'emissive_over_time': {
                    out += `  - Min Emissive       : ${(eff.minY !== undefined ? eff.minY : 0.0).toFixed(2)}\n`;
                    out += `  - Max Emissive       : ${(eff.maxY !== undefined ? eff.maxY : 1.0).toFixed(2)}\n`;
                    if (eff.points && eff.points.length > 0) {
                        const ptsStr = eff.points.map(p => `(t=${p.x.toFixed(2)}: ${p.y.toFixed(2)})`).join(', ');
                        out += `  - Curve Keyframes    : ${ptsStr}\n`;
                    }
                    break;
                }
                case 'luminance_emissive': {
                    out += `  - Luminance Threshold: ${Math.round((eff.threshold !== undefined ? eff.threshold : 0.55) * 100)}%\n`;
                    out += `  - Boost Intensity    : ${(eff.intensity !== undefined ? eff.intensity : 1.0).toFixed(2)}x\n`;
                    out += `  - Softness (Knee)    : ${(eff.softness !== undefined ? eff.softness : 0.15).toFixed(2)}\n`;
                    out += `  - Color Filter       : ${eff.colorFilter || '#ffffff'}\n`;
                    break;
                }
                case 'hsv_mix_tint': {
                    out += `  - Target Tint Color  : ${eff.color || '#38bdf8'}\n`;
                    out += `  - Blend Mode         : ${eff.blendMode || 'colorize'}\n`;
                    out += `  - Mix Percentage     : ${Math.round((eff.mix !== undefined ? eff.mix : 0.8) * 100)}%\n`;
                    out += `  - Saturation Boost   : ${(eff.satBoost !== undefined ? eff.satBoost : 1.0).toFixed(2)}x\n`;
                    out += `  - Value / Brightness : ${(eff.valBoost !== undefined ? eff.valBoost : 1.0).toFixed(2)}x\n`;
                    break;
                }
                case 'smooth': {
                    out += `  - Window Size        : ${eff.frames || 5} frames\n`;
                    out += `  - Filter Kernel      : ${eff.kernel || 'gaussian'}\n`;
                    out += `  - Strength           : ${Math.round((eff.strength !== undefined ? eff.strength : 1.0) * 100)}%\n`;
                    out += `  - Filter Axis        : ${(eff.axis || 'xyz').toUpperCase()}\n`;
                    break;
                }
                case 'spherify': {
                    out += `  - Radius             : ${(eff.radius !== undefined ? eff.radius : 2.0).toFixed(2)}m\n`;
                    const sx = eff.scale ? (eff.scale.x || 1.0) : 1.0;
                    const sy = eff.scale ? (eff.scale.y || 1.0) : 1.0;
                    const sz = eff.scale ? (eff.scale.z || 1.0) : 1.0;
                    out += `  - 3D Non-Uniform Scale: X:${sx.toFixed(2)}, Y:${sy.toFixed(2)}, Z:${sz.toFixed(2)}\n`;
                    out += `  - Projection Mode    : ${eff.mode || 'dome'}\n`;
                    out += `  - Curvature          : ${eff.curvature || 'convex'}\n`;
                    out += `  - Conform Strength   : ${Math.round((eff.strength !== undefined ? eff.strength : 0.5) * 100)}%\n`;
                    const px = eff.position ? (eff.position.x || 0.0) : 0.0;
                    const py = eff.position ? (eff.position.y || 0.0) : 0.0;
                    const pz = eff.position ? (eff.position.z || 0.0) : 0.0;
                    out += `  - Center Position    : X:${px.toFixed(2)}, Y:${py.toFixed(2)}, Z:${pz.toFixed(2)}\n`;
                    break;
                }
                case 'isometric_proxy': {
                    out += `  - Base Width         : ${(eff.width !== undefined ? eff.width : 2.0).toFixed(2)}m\n`;
                    out += `  - Total Height       : ${(eff.height !== undefined ? eff.height : 2.0).toFixed(2)}m\n`;
                    out += `  - Wall Height Ratio  : ${Math.round((eff.wallRatio !== undefined ? eff.wallRatio : 0.4) * 100)}%\n`;
                    out += `  - Top Roof Ratio     : ${Math.round((eff.topRatio !== undefined ? eff.topRatio : 0.5) * 100)}%\n`;
                    out += `  - Corner Chamfer     : ${Math.round((eff.chamfer !== undefined ? eff.chamfer : 0.5) * 100)}%\n`;
                    out += `  - Conform Strength   : ${Math.round((eff.strength !== undefined ? eff.strength : 0.5) * 100)}%\n`;
                    const px = eff.position ? (eff.position.x || 0.0) : 0.0;
                    const py = eff.position ? (eff.position.y || 0.0) : 0.0;
                    const pz = eff.position ? (eff.position.z || 0.0) : 0.0;
                    out += `  - Center Position    : X:${px.toFixed(2)}, Y:${py.toFixed(2)}, Z:${pz.toFixed(2)}\n`;
                    break;
                }
                case 'shaper_in':
                case 'shaper_out': {
                    out += `  - 3D Primitive       : ${eff.primitive || 'half_sphere'}\n`;
                    out += `  - Mode               : ${eff.mode || 'heat_attract'}\n`;
                    out += `  - Force Magnitude    : ${(eff.magnitude !== undefined ? eff.magnitude : 0.8).toFixed(2)}\n`;
                    out += `  - Radius / Range     : ${(eff.radius !== undefined ? eff.radius : 0.9).toFixed(2)}m (range factor: ${(eff.range !== undefined ? eff.range : 0.9).toFixed(2)})\n`;
                    out += `  - Falloff Curve      : ${eff.falloffType || 'smoothstep'}\n`;
                    out += `  - Emissive Heat      : ${(eff.heat !== undefined ? eff.heat : 1.0).toFixed(2)}\n`;
                    out += `  - Orientation Normal : ${eff.direction || 'up'}\n`;
                    const px = eff.position ? (eff.position.x || 0.0) : 0.0;
                    const py = eff.position ? (eff.position.y || 0.0) : 0.0;
                    const pz = eff.position ? (eff.position.z || 0.0) : 0.0;
                    out += `  - Center Position    : X:${px.toFixed(2)}, Y:${py.toFixed(2)}, Z:${pz.toFixed(2)}\n`;
                    out += `  - Active Interval    : t=[${(eff.timeStart || 0.0).toFixed(2)} -> ${(eff.timeEnd || 1.0).toFixed(2)}] (fade: ${(eff.fadeDuration || 0.15).toFixed(2)})\n`;
                    break;
                }
                default: {
                    out += `  - Settings Summary   : ${eff.getSummary ? eff.getSummary() : 'Custom effect'}\n`;
                    break;
                }
            }
            out += '\n';
        });

        return out;
    }

    /**
     * Generate structured TXT summary with all settings for Unity
     */
    generateUnitySettingsTxt(vatGrid, texRes = 2048, totalFrames = 64, baseName = null, pipeline = null) {
        const b = vatGrid.bounds || { min: [-1.5, -1.5, -1.5], max: [1.5, 1.5, 1.5], size: [3.0, 3.0, 3.0], maxRadius: 0.15 };
        const durationSec = (totalFrames / 30.0).toFixed(2);
        const splatCount = vatGrid.splatCount || 16384;
        const vertexCount = splatCount * 3;
        const triangleCount = splatCount;
        const indexFormat = (splatCount > 21845) ? "IndexFormat.UInt32" : "IndexFormat.UInt16";
        const splatsInK = Math.max(1, Math.round(splatCount / 1000));
        const name = (baseName && baseName.trim()) ? baseName.trim() : `vat_f${totalFrames}s_${splatsInK}k`;
        const modeStr = (vatGrid.posMode === 'displacement') ? "Vecteurs de Deplacement (Motion Delta Vectors)" : "Positions Absolues (World Space 3D Positions)";

        const pipe = pipeline || (typeof window !== 'undefined' && window.pipeline ? window.pipeline : null);
        const effectsTxt = this.formatEffectsTxt(pipe);

        return `================================================================================
UNITY 2.5D GAUSSIAN SPLAT VAT CONFIGURATION & SETTINGS
================================================================================
Generated Date       : ${new Date().toISOString()}
Sequence Name        : ${name}
VAT Mode             : ${modeStr}
Texture Resolution   : ${texRes} x ${texRes}
Animation Frames     : ${totalFrames} frames (${durationSec}s @ 30 FPS)
Active Splat Count   : ${splatCount.toLocaleString('en-US')}
Splat Euler Rotation : X: ${(vatGrid.rotation ? vatGrid.rotation[0] : 0)}° | Y: ${(vatGrid.rotation ? vatGrid.rotation[1] : 0)}° | Z: ${(vatGrid.rotation ? vatGrid.rotation[2] : 0)}°
Origin Center Offset : [${(pipe && pipe.centerOffset ? pipe.centerOffset.map(v => v.toFixed(3)).join(', ') : '0.000, 0.000, 0.000')}]
Chroma Key Mode      : ${pipe ? (pipe.keyingMode || 'auto') : 'auto'} (Keep Interior: ${pipe && pipe.keepInteriorZones ? 'ON' : 'OFF'})

--------------------------------------------------------------------------------
1. MESH GENERATION (Splat Generator / SplatMeshGenerator)
--------------------------------------------------------------------------------
Splat Count          : ${splatCount}
Vertex Count         : ${vertexCount.toLocaleString('en-US')} (3 vertices per billboard splat)
Triangle Count       : ${triangleCount.toLocaleString('en-US')}
Index Format         : ${indexFormat}
Bounding Box Size    : 100 (prevents premature frustum culling)
Output Folder        : Assets/VFX/Splats (or your project VFX folder)

--------------------------------------------------------------------------------
2. SHADER MATERIAL SETUP (Custom/2.5D_GaussianSplat_VAT_URP)
--------------------------------------------------------------------------------
Textures :
  - _ColorTex (Color & Alpha/Emissive) : VAT_Color_${name}.png
  - _PosTex (Position or Motion Deltas): VAT_Pos_${name}.png

VAT Parameters :
  - _TexResolution                     : ${texRes}
  - _TotalFrames                       : ${totalFrames}
  - _IsNormalized                      : 1 (Normalized 0..1 PNG Map)
  - _IsDisplacement                    : ${(vatGrid.posMode === 'displacement' ? 1 : 0)} (${vatGrid.posMode === 'displacement' ? 'Displacement Mode enabled' : 'Absolute Position Mode'})
  - _SRGBCompensate                    : 0 (Set to 1 only if PNG map is mistakenly imported as sRGB)

Volumetric Bounding Box (Required for PNG Mode) :
  - _BoundsMin (XYZ)                   : Vector4(${b.min[0].toFixed(4)}, ${b.min[1].toFixed(4)}, ${b.min[2].toFixed(4)}, 0.0)
  - _BoundsSize (XYZ)                  : Vector4(${b.size[0].toFixed(4)}, ${b.size[1].toFixed(4)}, ${b.size[2].toFixed(4)}, 0.0)
  - _MaxRadius                         : ${(b.maxRadius || 0.15).toFixed(4)}

Visual Adjustments :
  - _SizeMultiplier                    : 1.0
  - _AlphaMultiplier                   : 1.0
  - _MaxEmissionIntensity              : 15.0 (Max HDR emissive fire/heat intensity)
  - _CoreGlow                          : 0.5
  - _AdditiveBlend                     : 0 (or 1 for energy/pure flame additive blend)

Alpha Layer Partitioning (_ColorTex.A) :
  - [0.0 - 0.5] : Passive Smoke / Opacity (Opacity 0.0 -> 1.0, Emissive = 0)
  - ]0.5 - 1.0] : Fire / Incandescence (Opacity = 1.0, Emissive Ratio 0.0 -> 1.0)
  - Automatically decoded by the URP SplatVAT shader.

Advanced Options :
  - Enable GPU Instancing              : YES (CHECK IN MATERIAL INSPECTOR)

--------------------------------------------------------------------------------
3. ANIMATION EFFECTS & POST-PASS SETTINGS
--------------------------------------------------------------------------------
${effectsTxt}--------------------------------------------------------------------------------
4. SPAWNER COMPONENT (SplatVATSpawner.cs)
--------------------------------------------------------------------------------
  - Splat Mesh                         : Splats_CircumscribedTriangles_${splatCount}.asset
  - Splat Material                     : Configured material from step 2
  - Splat Count                        : ${splatCount}
  - Total Frames                       : ${totalFrames}
  - Effect Duration                    : ${durationSec}s
  - Playback Speed                     : 1.0
  - Spawn Key                          : N (trigger in Play Mode)
  - Spawn Distance                     : 4.0 (meters in front of camera)
  - Default Scale                      : 1.0
  - Max Concurrent Instances           : 64

--------------------------------------------------------------------------------
5. TEXTURE IMPORT SETTINGS IN UNITY (CRITIQUE)
--------------------------------------------------------------------------------
For VAT_Color_${name}.png (_ColorTex) :
  - Texture Type                       : Default
  - Texture Shape                      : 2D
  - sRGB (Color Texture)               : ENABLED (True)
  - Wrap Mode                          : Clamp
  - Filter Mode                        : Bilinear
  - Compression                        : High Quality or None

For VAT_Pos_${name}.png (_PosTex) :
  - Texture Type                       : Default
  - Texture Shape                      : 2D
  - sRGB (Color Texture)               : DISABLED (Linear / False)  <-- TRES IMPORTANT (évite la déformation en cuvette)
  - Wrap Mode                          : Clamp
  - Filter Mode                        : Bilinear
  - Compression                        : None / High Quality (sans perte pour préserver les coordonnées)

================================================================================
`;
    }

    /**
     * Generate VAT ZIP Package using JSZip (contains PNG textures and TXT settings only)
     */
    async generateVatZipPackage(pipeline, texRes = 2048, totalFrames = 64, zipFilename = null, baseName = null, posMode = 'position') {
        if (typeof JSZip === 'undefined') {
            throw new Error("JSZip library not loaded.");
        }

        texRes = parseInt(texRes) || 2048;
        totalFrames = parseInt(totalFrames) || 64;
        if (![64, 128, 256].includes(totalFrames)) totalFrames = 64;

        const vatGrid = this.sampleVatGrid(pipeline, texRes, totalFrames, posMode);
        const splatsInK = Math.max(1, Math.round(vatGrid.splatCount / 1000));
        const name = (baseName && baseName.trim()) ? baseName.trim() : `vat_f${totalFrames}s_${splatsInK}k`;

        const colorFilename = `VAT_Color_${name}.png`;
        const posPngFilename = `VAT_Pos_${name}.png`;
        const settingsFilename = `VAT_Settings_${name}.txt`;

        if (!zipFilename) {
            zipFilename = `${name}_VAT_Package.zip`;
        }

        const zip = new JSZip();

        // 1. Generate _ColorTex.png (Square texRes x texRes)
        const colorBlob = await this.generateColorTextureBlob(vatGrid.colorData, texRes);
        zip.file(colorFilename, colorBlob);

        // 2. Generate _PosTex.png (Normalized 0..1 Position & Radius PNG Map)
        const posPngBlob = await this.generateNormalizedPosTextureBlob(vatGrid.posData, vatGrid.bounds, texRes);
        zip.file(posPngFilename, posPngBlob);

        // 3. Generate Settings TXT File for Unity (includes active effects & settings)
        zip.file(settingsFilename, this.generateUnitySettingsTxt(vatGrid, texRes, totalFrames, name, pipeline));

        // Build Zip & trigger download (Strictly contains PNGs and TXT only)
        const zipBlob = await zip.generateAsync({ type: "blob" });
        const url = URL.createObjectURL(zipBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = zipFilename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
}

if (typeof window !== 'undefined') {
    window.VatTextureExporter = VatTextureExporter;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { VatTextureExporter };
}
