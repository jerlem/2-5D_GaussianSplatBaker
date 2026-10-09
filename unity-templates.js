/**
 * Unity Integration Templates & Zip Package Exporter
 * Generates:
 * - splats_config.json
 * - splats_base.bytes
 * - splats_vat.bin
 * - SplatUnpack.hlsl
 * - SplatVisualizer.cs
 * - SplatGaussianHDRP.shader
 * - README_UNITY.md
 */

const UnityTemplates = {
    getHLSL() {
        return `// ============================================================================
// 2.5D Gaussian Splats Unpack Include for Unity (HDRP / URP / Custom Shaders)
// ============================================================================
#ifndef SPLAT_UNPACK_INCLUDED
#define SPLAT_UNPACK_INCLUDED

struct SplatBaseData
{
    float3 position;     // Static initial 3D position
    float  size;         // Splat radius
    float3 color;        // Base RGB color (HDR/LDR)
    float  baseAlpha;    // Base reference opacity
};

struct SplatAnimData
{
    float3 delta;          // Delta translation offset (dx, dy, dz)
    float  dynamicOpacity; // Life / visibility factor (0.0 to 1.0)
};

#if defined(UNITY_PROCEDURAL_INSTANCING_ENABLED) || defined(SHADER_STAGE_COMPUTE)
StructuredBuffer<SplatBaseData> _SplatsBaseBuffer;
StructuredBuffer<SplatAnimData> _SplatsAnimBuffer;
#endif

uint  _SplatCount;
uint  _FrameCount;
float _AnimTime;
float _AnimDuration;
float _Fps;

// ============================================================================
// Sample Splat in World/Local Space with Frame Interpolation
// ============================================================================
void SampleSplat_float(
    uint splatId, 
    float normalizedTime, 
    out float3 localPos, 
    out float splatSize, 
    out float4 splatColor)
{
#if defined(UNITY_PROCEDURAL_INSTANCING_ENABLED) || defined(SHADER_STAGE_COMPUTE)
    if (splatId >= _SplatCount)
    {
        localPos = float3(0, 0, 0);
        splatSize = 0.0;
        splatColor = float4(0, 0, 0, 0);
        return;
    }

    SplatBaseData baseData = _SplatsBaseBuffer[splatId];

    // Compute continuous frame index
    float frameFloat = clamp(normalizedTime, 0.0, 1.0) * (_FrameCount - 1);
    uint frame0 = (uint)floor(frameFloat);
    uint frame1 = min(frame0 + 1, _FrameCount - 1);
    float frac = frameFloat - (float)frame0;

    // Frame-Major memory layout indexing: [Frame t][Splat i]
    uint animIdx0 = frame0 * _SplatCount + splatId;
    uint animIdx1 = frame1 * _SplatCount + splatId;

    SplatAnimData anim0 = _SplatsAnimBuffer[animIdx0];
    SplatAnimData anim1 = _SplatsAnimBuffer[animIdx1];

    // Smooth linear interpolation between keyframes
    float3 delta = lerp(anim0.delta, anim1.delta, frac);
    float dynOpacity = lerp(anim0.dynamicOpacity, anim1.dynamicOpacity, frac);

    localPos = baseData.position + delta;
    splatSize = baseData.size;
    splatColor = float4(baseData.color, baseData.baseAlpha * dynOpacity);
#else
    localPos = float3(0, 0, 0);
    splatSize = 1.0;
    splatColor = float4(1, 1, 1, 1);
#endif
}

// ============================================================================
// Gaussian Falloff Evaluation for Billboards: exp(-2.5 * r^2)
// ============================================================================
float EvaluateGaussianAlpha_float(float2 uv)
{
    float2 centered = uv - float2(0.5, 0.5);
    float r2 = dot(centered, centered) * 4.0; // 0 at center, 1 at quad edge
    if (r2 > 1.0) return 0.0;
    return exp(-2.5 * r2);
}

#endif // SPLAT_UNPACK_INCLUDED
`;
    },

    getVisualizerCS() {
        return `// ============================================================================
// 2.5D Gaussian Splat Visualizer for Unity (HDRP / URP)
// Directly loads monolithic 'explosion_splats.bytes' TextAsset into GPU Buffers
// ============================================================================
using System;
using System.IO;
using System.Runtime.InteropServices;
using UnityEngine;

[ExecuteAlways]
public class SplatVisualizer : MonoBehaviour
{
    [Header("Data Asset")]
    [Tooltip("Monolithic .bytes binary file exported from 2.5D Splat Baker WebApp")]
    public TextAsset splatBinaryAsset;

    [Header("Rendering Material")]
    public Material splatMaterial;
    public Mesh quadMesh;

    [Header("Playback Settings")]
    [Range(0f, 1f)]
    public float normalizedTime = 0f;
    public bool autoPlay = true;
    public float playbackSpeed = 1.0f;
    public bool loop = true;

    [Header("Visual Tweaks")]
    [Range(0.1f, 5.0f)]
    public float sizeMultiplier = 1.0f;
    [Range(0.1f, 5.0f)]
    public float alphaMultiplier = 1.0f;
    public bool additiveBlend = false;

    // Header structure (32 bytes)
    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    public struct SplatHeader
    {
        public uint magic;        // 0x53504C54 ("SPLT")
        public uint version;      // 1
        public uint splatCount;   // N
        public uint frameCount;   // T
        public float fps;         // Target FPS
        public float duration;    // Duration in seconds
        public uint reserved0;
        public uint reserved1;
    }

    // Static Base Splat Data (32 bytes per splat)
    [StructLayout(LayoutKind.Sequential)]
    public struct SplatBaseData
    {
        public Vector3 position;
        public float size;
        public Vector3 color;
        public float baseAlpha;
    }

    // Dynamic Animation Data (16 bytes per frame-splat)
    [StructLayout(LayoutKind.Sequential)]
    public struct SplatAnimData
    {
        public Vector3 delta;
        public float dynamicOpacity;
    }

    private ComputeBuffer _baseBuffer;
    private ComputeBuffer _animBuffer;
    private SplatHeader _header;
    private bool _isLoaded = false;
    private float _timer = 0f;

    void OnEnable()
    {
        LoadSplatData();
    }

    void OnDisable()
    {
        ReleaseBuffers();
    }

    void OnDestroy()
    {
        ReleaseBuffers();
    }

    public void LoadSplatData()
    {
        ReleaseBuffers();

        if (splatBinaryAsset == null || splatBinaryAsset.bytes == null || splatBinaryAsset.bytes.Length < 32)
        {
            _isLoaded = false;
            return;
        }

        byte[] rawBytes = splatBinaryAsset.bytes;

        using (MemoryStream ms = new MemoryStream(rawBytes))
        using (BinaryReader reader = new BinaryReader(ms))
        {
            // Read 32-byte header
            _header.magic = reader.ReadUInt32();
            _header.version = reader.ReadUInt32();
            _header.splatCount = reader.ReadUInt32();
            _header.frameCount = reader.ReadUInt32();
            _header.fps = reader.ReadSingle();
            _header.duration = reader.ReadSingle();
            _header.reserved0 = reader.ReadUInt32();
            _header.reserved1 = reader.ReadUInt32();

            // Magic check "SPLT" (0x53504C54)
            if (_header.magic != 0x53504C54)
            {
                Debug.LogError("[SplatVisualizer] Invalid magic header. Expected 'SPLT'.");
                return;
            }

            int N = (int)_header.splatCount;
            int T = (int)_header.frameCount;

            // 1. Read Base Splats (Block 1: N * 32 bytes)
            SplatBaseData[] baseArray = new SplatBaseData[N];
            for (int i = 0; i < N; i++)
            {
                baseArray[i].position = new Vector3(reader.ReadSingle(), reader.ReadSingle(), reader.ReadSingle());
                baseArray[i].size = reader.ReadSingle();
                baseArray[i].color = new Vector3(reader.ReadSingle(), reader.ReadSingle(), reader.ReadSingle());
                baseArray[i].baseAlpha = reader.ReadSingle();
            }

            // 2. Read VAT Animation Trajectories (Block 2: T * N * 16 bytes)
            int totalAnimElements = T * N;
            SplatAnimData[] animArray = new SplatAnimData[totalAnimElements];
            for (int i = 0; i < totalAnimElements; i++)
            {
                animArray[i].delta = new Vector3(reader.ReadSingle(), reader.ReadSingle(), reader.ReadSingle());
                animArray[i].dynamicOpacity = reader.ReadSingle();
            }

            // Allocate GPU Compute Buffers
            _baseBuffer = new ComputeBuffer(N, Marshal.SizeOf(typeof(SplatBaseData)));
            _baseBuffer.SetData(baseArray);

            _animBuffer = new ComputeBuffer(totalAnimElements, Marshal.SizeOf(typeof(SplatAnimData)));
            _animBuffer.SetData(animArray);

            _isLoaded = true;
            Debug.Log($"[SplatVisualizer] Successfully loaded {N} splats over {T} frames ({_header.duration:F2}s @ {_header.fps} fps).");
        }
    }

    void Update()
    {
        if (!_isLoaded) return;

        if (autoPlay && Application.isPlaying)
        {
            _timer += Time.deltaTime * playbackSpeed;
            if (_header.duration > 0f)
            {
                normalizedTime = _timer / _header.duration;
                if (normalizedTime > 1.0f)
                {
                    if (loop)
                    {
                        _timer = 0f;
                        normalizedTime = 0f;
                    }
                    else
                    {
                        normalizedTime = 1.0f;
                    }
                }
            }
        }

        DrawSplats();
    }

    private void DrawSplats()
    {
        if (!_isLoaded || splatMaterial == null || _baseBuffer == null || _animBuffer == null)
            return;

        // Bind GPU Buffers & Parameters
        splatMaterial.SetBuffer("_SplatsBaseBuffer", _baseBuffer);
        splatMaterial.SetBuffer("_SplatsAnimBuffer", _animBuffer);
        splatMaterial.SetInt("_SplatCount", (int)_header.splatCount);
        splatMaterial.SetInt("_FrameCount", (int)_header.frameCount);
        splatMaterial.SetFloat("_NormalizedTime", normalizedTime);
        splatMaterial.SetFloat("_SizeMultiplier", sizeMultiplier);
        splatMaterial.SetFloat("_AlphaMultiplier", alphaMultiplier);
        splatMaterial.SetMatrix("_ObjectToWorld", transform.localToWorldMatrix);

        // Procedural instancing draw call for N quads (2 triangles = 6 vertices per splat)
        Graphics.DrawProcedural(
            splatMaterial,
            new Bounds(transform.position, Vector3.one * 50f),
            MeshTopology.Triangles,
            6,
            (int)_header.splatCount,
            null,
            null,
            UnityEngine.Rendering.ShadowCastingMode.Off,
            false,
            gameObject.layer
        );
    }

    private void ReleaseBuffers()
    {
        if (_baseBuffer != null)
        {
            _baseBuffer.Release();
            _baseBuffer = null;
        }
        if (_animBuffer != null)
        {
            _animBuffer.Release();
            _animBuffer = null;
        }
        _isLoaded = false;
    }
}
`;
    },

    getShader() {
        return `Shader "Custom/2.5D_GaussianSplat"
{
    Properties
    {
        _SizeMultiplier ("Size Multiplier", Range(0.1, 5.0)) = 1.0
        _AlphaMultiplier ("Alpha Multiplier", Range(0.1, 5.0)) = 1.0
        _CoreGlow ("HDR Core Glow", Range(0.0, 3.0)) = 0.5
        [Toggle] _AdditiveBlend ("Additive Blend", Float) = 0
    }

    SubShader
    {
        Tags { "Queue"="Transparent" "RenderType"="Transparent" "IgnoreProjector"="True" }
        LOD 100

        Pass
        {
            Blend SrcAlpha OneMinusSrcAlpha
            Cull Off
            ZWrite Off
            ZTest LEqual

            CGPROGRAM
            #pragma target 5.0
            #pragma vertex vert
            #pragma fragment frag
            #include "UnityCG.cginc"

            struct SplatBaseData
            {
                float3 position;
                float size;
                float3 color;
                float baseAlpha;
            };

            struct SplatAnimData
            {
                float3 delta;
                float dynamicOpacity;
            };

            #if defined(SHADER_API_D3D11) || defined(SHADER_API_METAL) || defined(SHADER_API_VULKAN) || defined(SHADER_API_GLCORE)
            StructuredBuffer<SplatBaseData> _SplatsBaseBuffer;
            StructuredBuffer<SplatAnimData> _SplatsAnimBuffer;
            #endif

            uint _SplatCount;
            uint _FrameCount;
            float _NormalizedTime;
            float _SizeMultiplier;
            float _AlphaMultiplier;
            float _CoreGlow;
            float4x4 _ObjectToWorld;

            struct v2f
            {
                float4 pos : SV_POSITION;
                float2 uv : TEXCOORD0;
                float4 color : COLOR0;
            };

            v2f vert(uint vertexID : SV_VertexID, uint instanceID : SV_InstanceID)
            {
                v2f o;

                // Quad vertex offsets (6 vertices for 2 triangles)
                float2 quadOffsets[6] = {
                    float2(-0.5, -0.5),
                    float2( 0.5, -0.5),
                    float2( 0.5,  0.5),
                    float2(-0.5, -0.5),
                    float2( 0.5,  0.5),
                    float2(-0.5,  0.5)
                };

                float2 quadUVs[6] = {
                    float2(0, 0),
                    float2(1, 0),
                    float2(1, 1),
                    float2(0, 0),
                    float2(1, 1),
                    float2(0, 1)
                };

                float2 offset = quadOffsets[vertexID];
                o.uv = quadUVs[vertexID];

                // Fetch Splat Base & VAT Animation
                SplatBaseData baseData = _SplatsBaseBuffer[instanceID];

                float frameFloat = clamp(_NormalizedTime, 0.0, 1.0) * (_FrameCount - 1);
                uint f0 = (uint)floor(frameFloat);
                uint f1 = min(f0 + 1, _FrameCount - 1);
                float frac = frameFloat - (float)f0;

                uint animIdx0 = f0 * _SplatCount + instanceID;
                uint animIdx1 = f1 * _SplatCount + instanceID;

                SplatAnimData a0 = _SplatsAnimBuffer[animIdx0];
                SplatAnimData a1 = _SplatsAnimBuffer[animIdx1];

                float3 delta = lerp(a0.delta, a1.delta, frac);
                float opacity = lerp(a0.dynamicOpacity, a1.dynamicOpacity, frac);

                // Local splat position
                float3 localPos = baseData.position + delta;
                float4 worldCenter = mul(_ObjectToWorld, float4(localPos, 1.0));

                // Camera Billboard computation
                float3 camRight = UNITY_MATRIX_V[0].xyz;
                float3 camUp    = UNITY_MATRIX_V[1].xyz;

                float splatRadius = baseData.size * _SizeMultiplier;
                float3 billboardWorldPos = worldCenter.xyz + 
                                           (camRight * offset.x + camUp * offset.y) * splatRadius * 2.0;

                o.pos = mul(UNITY_MATRIX_VP, float4(billboardWorldPos, 1.0));
                o.color = float4(baseData.color, baseData.baseAlpha * opacity * _AlphaMultiplier);

                return o;
            }

            fixed4 frag(v2f i) : SV_Target
            {
                // Gaussian Soft Radial Falloff: exp(-2.5 * r^2)
                float2 centered = i.uv - float2(0.5, 0.5);
                float r2 = dot(centered, centered) * 4.0;
                if (r2 > 1.0) discard;

                float gaussian = exp(-2.5 * r2);
                float alpha = i.color.a * gaussian;
                if (alpha < 0.01) discard;

                // Core glow HDR boost
                float3 col = i.color.rgb * (1.0 + gaussian * _CoreGlow);

                return fixed4(col, alpha);
            }
            ENDCG
        }
    }
    FallBack Off
}
`;
    },

    getReadme() {
        return `# 2.5D Gaussian Splats Animation Package for Unity (HDRP / URP)

## 📦 Included Files
- \`explosion_splats.bytes\`: Monolithic binary data (Header + Base Splats + VAT Animation Tracks).
- \`splats_config.json\`: Pipeline metadata, focal length, depth scale, and 3D Bounding Box.
- \`splats_base.bytes\`: Float32 binary buffer for base reference splats.
- \`splats_vat.bin\`: Float32 binary buffer for 3D advection animation trajectories.
- \`SplatUnpack.hlsl\`: Shader include containing unpack and interpolation utilities.
- \`SplatVisualizer.cs\`: Ready-to-use Unity C# component with GPU procedural instancing.
- \`SplatGaussianHDRP.shader\`: GPU-instanced Gaussian Billboard Shader with HDR radiance.

## 🚀 Quick Unity Setup
1. Drag and drop the extracted folder into your Unity project (\`Assets/Splats/\`).
2. Create an empty GameObject in your scene (e.g., \`Explosion_Splat\`).
3. Attach the \`SplatVisualizer.cs\` script to this GameObject.
4. Create a Material using the \`Custom/2.5D_GaussianSplat\` shader and assign it to the \`Splat Material\` field.
5. Drag your \`explosion_splats.bytes\` file (recognized as TextAsset) into the \`Splat Binary Asset\` field.
6. Press Play in Unity! The Gaussian Splats animate smoothly with continuous temporal interpolation.

## ⚙️ Inspector Properties
- **Normalized Time**: Timeline scrubber (0.0 to 1.0).
- **Playback Speed**: Playback multiplier (e.g. 0.5 for slow-motion).
- **Size Multiplier**: Adjusts splat radius / density.
- **Alpha Multiplier**: Overall opacity multiplier for embers, fire, and smoke.
`;
    },

    // Build and download complete ZIP package using JSZip
    async generateZipPackage(pipeline, fps = 30.0, zipFilename = "explosion_splats_unity_package.zip") {
        if (typeof JSZip === 'undefined') {
            throw new Error("JSZip library not loaded.");
        }

        const zip = new JSZip();

        // 1. Pack monolithic binary
        const monolithicInfo = pipeline.packMonolithicBinary(fps);
        zip.file("explosion_splats.bytes", pipeline.bakedData);

        // 2. Base splats buffer
        zip.file("splats_base.bytes", pipeline.splatsBase.buffer);

        // 3. VAT animation buffer
        zip.file("splats_vat.bin", pipeline.splatsAnim.buffer);

        // 4. Metadata JSON
        const bbox = pipeline.computeBoundingBox();
        const config = {
            format: "2.5D Gaussian Splats Animation",
            version: 1,
            splatCount: pipeline.quadtreeCells ? pipeline.quadtreeCells.length : (pipeline.splatsBase.length / 8),
            frameCount: pipeline.frames.length,
            fps: fps,
            duration: pipeline.frames.length / fps,
            referenceFrame: pipeline.referenceFrameIdx,
            focalLength: pipeline.focalLength,
            depthScale: pipeline.depthScale,
            originMode: pipeline.originMode || 'origin',
            originOffset: [pipeline.offsetX || 0, pipeline.offsetY || 0, pipeline.offsetZ || 0],
            centerOffset: pipeline.centerOffset || [0, 0, 0],
            boundingBox: bbox,
            exportDate: new Date().toISOString()
        };
        zip.file("splats_config.json", JSON.stringify(config, null, 2));

        // 5. Shader include & C# scripts
        zip.file("SplatUnpack.hlsl", this.getHLSL());
        zip.file("SplatVisualizer.cs", this.getVisualizerCS());
        zip.file("SplatGaussianHDRP.shader", this.getShader());
        zip.file("README_UNITY.md", this.getReadme());

        // Generate Zip blob
        const blob = await zip.generateAsync({ type: "blob" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = zipFilename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    },

    getVatURPShader(texRes = 2048, totalFrames = 64, bounds = null) {
        const exp = new VatTextureExporter();
        return exp.getVatShaderURP(texRes, totalFrames, bounds);
    },

    getVatMeshGenerator(splatCount = 16384) {
        const exp = new VatTextureExporter();
        return exp.getMeshGeneratorCS(splatCount);
    },

    getVatSpawnerCS(texRes = 2048, totalFrames = 64) {
        const exp = new VatTextureExporter();
        return exp.getParticlePoolCS(texRes, totalFrames);
    },

    getVatSettingsTxt(texRes = 2048, totalFrames = 64, vatGrid = null, baseName = null) {
        const exp = new VatTextureExporter();
        return exp.generateUnitySettingsTxt(vatGrid || {}, texRes, totalFrames, baseName);
    },

    getVatParticlePool(texRes = 2048, totalFrames = 64) {
        return this.getVatSpawnerCS(texRes, totalFrames);
    }
};

window.UnityTemplates = UnityTemplates;
