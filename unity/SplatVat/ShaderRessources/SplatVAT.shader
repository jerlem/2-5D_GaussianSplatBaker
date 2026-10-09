// ============================================================================
// 2.5D Gaussian Splats VAT Shader (URP / Band-Strip 2D Multi-Resolution)
// Features:
// - Integration fidele et intuitive de la taille des splats (MaxRadius * SizeMultiplier * TransformScale)
// - Modulation dynamique de taille par le canal Alpha/Densite de la texture (_SizeByAlpha)
// - Interpolation sous-frame continue a 2 echantillons (lerp fluide 60fps+)
// - Prise en compte complete des coordonnees du Transform et de la hierarchie parente
// - Decodage Alpha / Emissif equilibre (Fumee sombre 0% emissive, Flammes HDR dosees)
// - Decoupe circulaire gaussienne douce naturelle
// - Culling GPU zero-cout sur fin de vie ou rayon <= 0
// - Support GPU Instancing complet & MaterialPropertyBlock dynamique
// ============================================================================
Shader "Custom/2.5D_GaussianSplat_VAT_URP"
{
    Properties
    {
        [Header(VAT 2D Animation Textures)]
        [NoScaleOffset] _ColorTex ("Color & Alpha/Emissive VAT Texture (PNG)", 2D) = "white" {}
        [NoScaleOffset] _PosTex ("Position / Displacement VAT Texture (PNG)", 2D) = "black" {}

        [Header(VAT Configuration)]
        _TexResolution ("Texture Resolution Value", Int) = 4096
        _TotalFrames ("Total VAT Frames (64 for 4K Nova)", Int) = 64
        _VerticesPerSplat ("Vertices Per Splat (3=Triangles, 1=Points)", Int) = 3
        [Toggle] _FlipV ("Flip V Coordinate (Canvas/Top-Left to Unity)", Float) = 1
        [Toggle] _IsNormalized ("Is 0..1 Normalized PNG Map", Float) = 1
        [Toggle] _IsDisplacement ("Mode: 0=Absolute Position, 1=Displacement on Mesh", Float) = 0

        [Header(Volumetric Bounding Box for Normalized Map)]
        _BoundsMin ("Bounds Min (XYZ)", Vector) = (-0.6219, -0.0669, -0.5445, 0.0)
        _BoundsSize ("Bounds Size (XYZ)", Vector) = (1.2443, 0.0904, 1.0857, 0.0)
        _PosOffset ("Origin Offset (XYZ)", Vector) = (0.0, 0.0, 0.0, 0.0)

        [Header(Splat Sizing and Scale)]
        _MaxRadius ("Base Splat Radius (Meters)", Float) = 0.0049
        _SizeMultiplier ("Size Multiplier", Range(0.01, 10.0)) = 1.0
        _SizeByAlpha ("Size Derived from Texture Density/Alpha", Range(0.0, 1.0)) = 0.85
        [Toggle] _InheritParentScale ("Inherit Transform / GameObject Scale", Float) = 1

        [Header(Playback)]
        _NormalizedTime ("Animation Progress", Range(0.0, 1.0)) = 0.0

        [Header(Visual Adjustments and Emission)]
        _AlphaMultiplier ("Alpha Multiplier", Range(0.1, 5.0)) = 1.0
        [Toggle] _EnableEmissive ("Enable HDR Emission", Float) = 1
        _EmissionIntensity ("Emission Intensity (HDR)", Range(0.0, 10.0)) = 1.5
        _EmissionThreshold ("Emission Threshold (Smoke vs Fire)", Range(0.0, 1.0)) = 0.5
        _CoreGlow ("Core Glow Intensity", Range(0.0, 2.0)) = 0.2
        [Toggle] _CircumscribedClip ("Clip Circumscribed Triangle Circle", Float) = 1

        [Header(Blending and Render State)]
        [Enum(UnityEngine.Rendering.BlendMode)] _SrcBlend ("Src Blend", Float) = 5
        [Enum(UnityEngine.Rendering.BlendMode)] _DstBlend ("Dst Blend", Float) = 10
        [Enum(Off,0,On,1)] _ZWrite ("Z Write", Float) = 0
        [Enum(UnityEngine.Rendering.CullMode)] _Cull ("Cull Mode", Float) = 0
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

            Blend [_SrcBlend] [_DstBlend]
            ZWrite [_ZWrite]
            Cull [_Cull]

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
                int    _VerticesPerSplat;
                float  _FlipV;
                float  _IsNormalized;
                float  _IsDisplacement;
                float4 _BoundsMin;
                float4 _BoundsSize;
                float4 _PosOffset;
                float  _MaxRadius;
                float  _SizeMultiplier;
                float  _SizeByAlpha;
                float  _InheritParentScale;
                float  _NormalizedTime;
                float  _AlphaMultiplier;
                float  _EnableEmissive;
                float  _EmissionIntensity;
                float  _EmissionThreshold;
                float  _CoreGlow;
                float  _CircumscribedClip;
            CBUFFER_END

            UNITY_INSTANCING_BUFFER_START(Props)
                UNITY_DEFINE_INSTANCED_PROP(float, _InstancedNormalizedTime)
                UNITY_DEFINE_INSTANCED_PROP(float, _InstancedSizeMultiplier)
                UNITY_DEFINE_INSTANCED_PROP(float, _InstancedAlphaMultiplier)
                UNITY_DEFINE_INSTANCED_PROP(float, _InstancedMaxRadius)
                UNITY_DEFINE_INSTANCED_PROP(float, _InstancedEnableEmissive)
                UNITY_DEFINE_INSTANCED_PROP(float, _InstancedEmissionIntensity)
                UNITY_DEFINE_INSTANCED_PROP(float, _InstancedEmissionThreshold)
                UNITY_DEFINE_INSTANCED_PROP(float, _InstancedCoreGlow)
            UNITY_INSTANCING_BUFFER_END(Props)

            struct Attributes
            {
                float3 positionOS : POSITION;
                float3 normalOS   : NORMAL;
                float2 uv0        : TEXCOORD0; // Coordonnees locales 2D pour billboard (V0, V1, V2)
                float2 uv1        : TEXCOORD1; // uv1.x = Splat ID explicite (si renseigne)
                uint   vertexID   : SV_VertexID;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float2 uv0        : TEXCOORD0;
                float4 color      : COLOR0; // RGB: Couleur, A: Alpha brut encode
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            // ========================================================================
            // Decodage VAT 2D Band-Strip avec interpolation temporelle fluide (lerp)
            // ========================================================================
            void DecodeSplatVAT_float(
                uint splatID,
                float normalizedTime,
                uint texRes,
                uint totalFrames,
                float maxRadius,
                out float3 localPos,
                out float splatRadius,
                out float4 splatColor)
            {
                if (totalFrames == 0u) totalFrames = 64u;
                if (texRes == 0u) texRes = 4096u;

                // 1. Decomposition en bande 2D
                uint col = splatID % texRes;
                uint bandIndex = splatID / texRes;
                uint bandRowStart = bandIndex * totalFrames;

                // 2. Calcul des frames encadrantes pour interpolation continue
                float frameContinuous = saturate(normalizedTime) * (float)(totalFrames - 1u);
                uint frame0 = (uint)floor(frameContinuous);
                uint frame1 = min(frame0 + 1u, totalFrames - 1u);
                float frameFrac = frac(frameContinuous);

                // 3. Coordonnees UV exactes au centre des texels
                float u = (float(col) + 0.5) / float(texRes);

                float row0 = float(bandRowStart + frame0);
                float rawV0 = (row0 + 0.5) / float(texRes);
                float v0 = (_FlipV > 0.5) ? (1.0 - rawV0) : rawV0;

                float row1 = float(bandRowStart + frame1);
                float rawV1 = (row1 + 0.5) / float(texRes);
                float v1 = (_FlipV > 0.5) ? (1.0 - rawV1) : rawV1;

                // 4. Double echantillonnage LOD 0
                float4 pos0 = SAMPLE_TEXTURE2D_LOD(_PosTex, sampler_PosTex, float2(u, v0), 0);
                float4 col0 = SAMPLE_TEXTURE2D_LOD(_ColorTex, sampler_ColorTex, float2(u, v0), 0);

                float4 pos1 = SAMPLE_TEXTURE2D_LOD(_PosTex, sampler_PosTex, float2(u, v1), 0);
                float4 col1 = SAMPLE_TEXTURE2D_LOD(_ColorTex, sampler_ColorTex, float2(u, v1), 0);

                // 5. Interpolation temporelle lineaire continue (60fps+)
                float4 posData = lerp(pos0, pos1, frameFrac);
                float4 colorData = lerp(col0, col1, frameFrac);

                // 6. Decodage position
                if (_IsNormalized > 0.5)
                {
                    localPos = posData.xyz * _BoundsSize.xyz + _BoundsMin.xyz + _PosOffset.xyz;
                }
                else
                {
                    localPos = posData.xyz + _PosOffset.xyz;
                }

                // 7. Decodage rayon du splat pilote par posData.w et la densite de colorData.a
                float rawW = posData.w;
                float baseRadius = 0.0;
                if (_IsNormalized > 0.5)
                {
                    baseRadius = rawW * maxRadius;
                }
                else
                {
                    baseRadius = (rawW > 0.001) ? (maxRadius > 0.0 ? rawW * maxRadius : rawW) : 0.0;
                }

                if (normalizedTime >= 1.0 || colorData.a <= 0.001 || rawW <= 0.001)
                {
                    baseRadius = 0.0;
                }

                splatRadius = baseRadius;
                splatColor = colorData;
            }

            Varyings vert(Attributes input)
            {
                Varyings output = (Varyings)0;
                UNITY_SETUP_INSTANCE_ID(input);
                UNITY_TRANSFER_INSTANCE_ID(input, output);

                #ifdef UNITY_INSTANCING_ENABLED
                    float instT = UNITY_ACCESS_INSTANCED_PROP(Props, _InstancedNormalizedTime);
                    float animT = (instT >= 0.0) ? instT : _NormalizedTime;
                    float instSize = UNITY_ACCESS_INSTANCED_PROP(Props, _InstancedSizeMultiplier);
                    float activeSizeMult = (instSize > 0.0) ? instSize : _SizeMultiplier;
                    float instMaxR = UNITY_ACCESS_INSTANCED_PROP(Props, _InstancedMaxRadius);
                    float activeMaxRadius = (instMaxR > 0.0) ? instMaxR : _MaxRadius;
                #else
                    float animT = _NormalizedTime;
                    float activeSizeMult = _SizeMultiplier;
                    float activeMaxRadius = _MaxRadius;
                #endif

                uint texRes = (_TexResolution > 0) ? (uint)_TexResolution : 4096u;
                uint frames = (_TotalFrames > 0) ? (uint)_TotalFrames : 64u;
                uint vPerSplat = (_VerticesPerSplat > 0) ? (uint)_VerticesPerSplat : 3u;

                // Splat ID : utilise uv1.x si renseigne (> 0), sinon deduit du vertexID
                uint splatID = (input.uv1.x > 0.0) ? (uint)(input.uv1.x + 0.5) : (input.vertexID / vPerSplat);

                float3 localCenter;
                float splatRadius;
                float4 colorData;

                DecodeSplatVAT_float(splatID, animT, texRes, frames, activeMaxRadius, localCenter, splatRadius, colorData);

                // Mode Deplacement : addition a la position du mesh
                if (_IsDisplacement > 0.5)
                {
                    localCenter = input.positionOS.xyz + localCenter;
                }

                // Echelle du Transform parent pour adapter la taille des splats en continu
                float objectScale = 1.0;
                if (_InheritParentScale > 0.5)
                {
                    float scaleX = length(TransformObjectToWorldDir(float3(1.0, 0.0, 0.0)));
                    float scaleY = length(TransformObjectToWorldDir(float3(0.0, 1.0, 0.0)));
                    float scaleZ = length(TransformObjectToWorldDir(float3(0.0, 0.0, 1.0)));
                    objectScale = (scaleX + scaleY + scaleZ) / 3.0;
                }

                // Variation individuelle de taille selon la densite encodee dans colorData.a
                float normDensity = saturate(colorData.a / max(0.01, _EmissionThreshold));
                float densityScale = lerp(1.0, sqrt(max(0.04, normDensity)), _SizeByAlpha);

                // Rayon final du billboard = splatRadius * SizeMultiplier * TransformScale * densityScale
                float finalRadius = splatRadius * activeSizeMult * objectScale * densityScale;

                // Culling GPU : si le rayon <= 0 ou splat invisible, triangle reduit a 0
                if (finalRadius <= 0.00001 || colorData.a <= 0.001)
                {
                    output.positionCS = float4(0, 0, 0, 0);
                    output.uv0 = float2(0, 0);
                    output.color = float4(0, 0, 0, 0);
                    return output;
                }

                // Transformation Object Space -> World Space (Transform & Parents)
                float3 worldCenter = TransformObjectToWorld(localCenter);

                // Orientation Billboard face camera dans l'espace Monde (normalisee)
                float3 camRight = normalize(UNITY_MATRIX_V[0].xyz);
                float3 camUp    = normalize(UNITY_MATRIX_V[1].xyz);

                float3 billboardOffset = (camRight * input.uv0.x + camUp * input.uv0.y) * finalRadius;
                float3 worldPos = worldCenter + billboardOffset;

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

                // 1. Decoupage circulaire du triangle circonscrit (R = 1.0)
                if (_CircumscribedClip > 0.5 && distSq > 1.0)
                {
                    clip(1.0 - distSq);
                }

                #ifdef UNITY_INSTANCING_ENABLED
                    float instAlphaMult = UNITY_ACCESS_INSTANCED_PROP(Props, _InstancedAlphaMultiplier);
                    float activeAlphaMult = (instAlphaMult > 0.0) ? instAlphaMult : _AlphaMultiplier;
                    float instEnableEmiss = UNITY_ACCESS_INSTANCED_PROP(Props, _InstancedEnableEmissive);
                    float activeEnableEmiss = (instEnableEmiss >= 0.0) ? instEnableEmiss : _EnableEmissive;
                    float instEmissIntens = UNITY_ACCESS_INSTANCED_PROP(Props, _InstancedEmissionIntensity);
                    float activeEmissIntens = (instEmissIntens >= 0.0) ? instEmissIntens : _EmissionIntensity;
                    float instEmissThresh = UNITY_ACCESS_INSTANCED_PROP(Props, _InstancedEmissionThreshold);
                    float activeEmissThresh = (instEmissThresh >= 0.0) ? instEmissThresh : _EmissionThreshold;
                    float instCoreGlow = UNITY_ACCESS_INSTANCED_PROP(Props, _InstancedCoreGlow);
                    float activeCoreGlow = (instCoreGlow >= 0.0) ? instCoreGlow : _CoreGlow;
                #else
                    float activeAlphaMult = _AlphaMultiplier;
                    float activeEnableEmiss = _EnableEmissive;
                    float activeEmissIntens = _EmissionIntensity;
                    float activeEmissThresh = _EmissionThreshold;
                    float activeCoreGlow = _CoreGlow;
                #endif

                // 2. Decodage Alpha & Emissif : Separation stricte Fumee vs Flammes
                float rawA = input.color.a;
                float thresh = max(0.01, activeEmissThresh);

                float isFire = saturate((rawA - thresh) * 1000.0);
                float smokeAlpha = saturate(rawA / thresh);
                float outAlpha = lerp(smokeAlpha, 1.0, isFire);

                float fireRatio = saturate((rawA - thresh) / max(0.001, 1.0 - thresh));
                float emissiveMult = (activeEnableEmiss > 0.5) ? (fireRatio * activeEmissIntens) : 0.0;

                // 3. Decroissance gaussienne douce radiale : exp(-3.0 * distSq) avec attenuation douce au bord
                float smoothEdge = saturate((1.0 - distSq) * 3.0);
                float gaussian = exp(-3.0 * distSq) * smoothEdge;
                float finalAlpha = outAlpha * activeAlphaMult * gaussian;
                if (finalAlpha < 0.003 && emissiveMult < 0.01) discard;

                // 4. Couleur finale : Fumee sombre naturelle + Lueur HDR dosee pour les flammes
                float3 baseRgb = input.color.rgb;
                float3 emissiveBoost = baseRgb * (emissiveMult * (1.0 + gaussian * activeCoreGlow));
                float3 finalRgb = baseRgb + emissiveBoost;

                return half4(finalRgb, saturate(finalAlpha));
            }
            ENDHLSL
        }
    }
    FallBack "Hidden/Universal Render Pipeline/FallbackError"
}
