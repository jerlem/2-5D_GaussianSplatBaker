// ============================================================================
// 2.5D Gaussian Splats VAT Shader (Unity URP)
// Avec contrôle de Vitesse de Lecture automatique et boucle
// ============================================================================
Shader "Custom/2.5D_GaussianSplat_VAT_URP"
{
    Properties
    {
        [Header(VAT_Textures)]
        [NoScaleOffset] _ColorTex ("Color and Alpha Emissive VAT (PNG)", 2D) = "white" {}
        [NoScaleOffset] _PosTex   ("Position and Radius VAT (PNG)", 2D) = "black" {}

        [Header(VAT_Configuration)]
        _SplatCount    ("Nombre Exact de Splats", Int) = 262144
        _TotalFrames   ("Total Frames VAT", Int) = 64
        _TexResolution ("Resolution Texture (ex: 2048 ou 4096)", Int) = 4096

        [Header(Bounding_Box)]
        _BoundsMin  ("Bounds Min (XYZ)", Vector) = (-1.0, -1.0, -1.0, 0.0)
        _BoundsSize ("Bounds Size (XYZ)", Vector) = (2.0, 2.0, 2.0, 0.0)
        _MaxRadius  ("Max Splat Radius", Float) = 0.15

        [Header(Animation_et_Vitesse)]
        _PlaybackSpeed  ("Vitesse de Lecture (0 = Manuel)", Float) = 1.0
        _Fps            ("FPS Animation", Float) = 30.0
        [Toggle] _Loop  ("Boucler l'Animation", Float) = 1
        _NormalizedTime ("Curseur Manuel (si Vitesse = 0)", Range(0.0, 1.0)) = 0.0

        [Header(Visual_Adjustments)]
        _SizeMultiplier    ("Multiplicateur Taille", Range(0.01, 5.0)) = 1.0
        _AlphaMultiplier   ("Multiplicateur Opacite", Range(0.0, 5.0)) = 1.0
        _EmissionIntensity ("Intensite Emissive HDR", Range(0.0, 50.0)) = 15.0
        _CoreGlow          ("Intensite Coeur Chaud", Range(0.0, 2.0)) = 0.3
    }

    SubShader
    {
        Tags 
        { 
            "RenderType"     = "Transparent" 
            "Queue"          = "Transparent" 
            "RenderPipeline" = "UniversalPipeline" 
            "IgnoreProjector"= "True" 
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
                int    _SplatCount;
                int    _TotalFrames;
                int    _TexResolution;
                float4 _BoundsMin;
                float4 _BoundsSize;
                float  _MaxRadius;
                float  _PlaybackSpeed;
                float  _Fps;
                float  _Loop;
                float  _NormalizedTime;
                float  _SizeMultiplier;
                float  _AlphaMultiplier;
                float  _EmissionIntensity;
                float  _CoreGlow;
            CBUFFER_END

            UNITY_INSTANCING_BUFFER_START(Props)
                UNITY_DEFINE_INSTANCED_PROP(float, _InstancedNormalizedTime)
            UNITY_INSTANCING_BUFFER_END(Props)

            struct Attributes
            {
                float3 positionOS : POSITION;
                float2 uv0        : TEXCOORD0; // Coordonnees 2D locales du triangle circonscrit
                float2 uv1        : TEXCOORD1; // uv1.x = SplatID
                uint   vertexID   : SV_VertexID;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float2 uv0        : TEXCOORD0;
                float4 color      : COLOR0; // RGB: Couleur, A: Alpha brut
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            void SampleSplatVAT(
                uint splatID,
                float animTime,
                uint texRes,
                uint totalFrames,
                out float3 localPos,
                out float splatRadius,
                out float4 splatColor)
            {
                // Decompression de la bande 2D
                uint col = splatID % texRes;
                uint bandIndex = splatID / texRes;
                uint rowStart = bandIndex * totalFrames;

                // Frames encadrantes pour lerp temporel continu (60fps+)
                float continuousFrame = saturate(animTime) * (float)(totalFrames - 1u);
                uint frame0 = (uint)floor(continuousFrame);
                uint frame1 = min(frame0 + 1u, totalFrames - 1u);
                float frameFrac = frac(continuousFrame);

                // UVs centre-texel avec inversion V Canvas Top-Left -> Unity
                float u = (float(col) + 0.5) / float(texRes);
                float v0 = 1.0 - (float(rowStart + frame0) + 0.5) / float(texRes);
                float v1 = 1.0 - (float(rowStart + frame1) + 0.5) / float(texRes);

                float4 pos0 = SAMPLE_TEXTURE2D_LOD(_PosTex, sampler_PosTex, float2(u, v0), 0);
                float4 col0 = SAMPLE_TEXTURE2D_LOD(_ColorTex, sampler_ColorTex, float2(u, v0), 0);
                float4 pos1 = SAMPLE_TEXTURE2D_LOD(_PosTex, sampler_PosTex, float2(u, v1), 0);
                float4 col1 = SAMPLE_TEXTURE2D_LOD(_ColorTex, sampler_ColorTex, float2(u, v1), 0);

                float4 posData = lerp(pos0, pos1, frameFrac);
                splatColor     = lerp(col0, col1, frameFrac);

                localPos    = posData.xyz * _BoundsSize.xyz + _BoundsMin.xyz;
                splatRadius = posData.w * _MaxRadius;
            }

            Varyings vert(Attributes input)
            {
                Varyings output = (Varyings)0;
                UNITY_SETUP_INSTANCE_ID(input);
                UNITY_TRANSFER_INSTANCE_ID(input, output);

                uint texRes    = (_TexResolution > 0) ? (uint)_TexResolution : 4096u;
                uint frames    = (_TotalFrames > 0) ? (uint)_TotalFrames : 64u;
                uint maxSplats = (_SplatCount > 0) ? (uint)_SplatCount : 262144u;

                // Calcul du temps d'animation (Vitesse automatique ou Manuel)
                float animT = _NormalizedTime;

                #ifdef UNITY_INSTANCING_ENABLED
                    float instTime = UNITY_ACCESS_INSTANCED_PROP(Props, _InstancedNormalizedTime);
                    if (instTime >= 0.0)
                    {
                        animT = instTime;
                    }
                    else if (_PlaybackSpeed != 0.0)
                    {
                        float fps = (_Fps > 0.0) ? _Fps : 30.0;
                        float duration = (float)frames / fps;
                        float elapsed = (_Time.y * _PlaybackSpeed) / max(0.001, duration);
                        animT = (_Loop > 0.5) ? frac(elapsed) : saturate(elapsed);
                    }
                #else
                    if (_PlaybackSpeed != 0.0)
                    {
                        float fps = (_Fps > 0.0) ? _Fps : 30.0;
                        float duration = (float)frames / fps;
                        float elapsed = (_Time.y * _PlaybackSpeed) / max(0.001, duration);
                        animT = (_Loop > 0.5) ? frac(elapsed) : saturate(elapsed);
                    }
                #endif

                // SplatID fiable : uv1.x ou vertexID/3 (triangles)
                uint splatID = (uint)(input.uv1.x + 0.5);
                if (splatID == 0u && input.vertexID >= 3u)
                {
                    splatID = input.vertexID / 3u;
                }

                // Culling strict : rejette les sommets au-dela du nombre exact de splats
                if (splatID >= maxSplats)
                {
                    output.positionCS = float4(0, 0, 0, 0);
                    return output;
                }

                float3 localCenter;
                float splatRadius;
                float4 colorData;
                SampleSplatVAT(splatID, animT, texRes, frames, localCenter, splatRadius, colorData);

                // Prise en compte de l'echelle du Transform parent
                float objectScale = length(TransformObjectToWorldDir(float3(1.0, 0.0, 0.0)));
                float finalRadius = splatRadius * _SizeMultiplier * objectScale;

                // Culling GPU si rayon nul ou particule invisible
                if (finalRadius <= 0.00001 || colorData.a <= 0.001)
                {
                    output.positionCS = float4(0, 0, 0, 0);
                    return output;
                }

                float3 worldCenter = TransformObjectToWorld(localCenter);

                // Billboard face camera
                float3 camRight = UNITY_MATRIX_V[0].xyz;
                float3 camUp    = UNITY_MATRIX_V[1].xyz;

                float3 billboardOffset = (camRight * input.uv0.x + camUp * input.uv0.y) * finalRadius;
                float3 worldPos = worldCenter + billboardOffset;

                output.positionCS = TransformWorldToHClip(worldPos);
                output.uv0        = input.uv0;
                output.color      = colorData;

                return output;
            }

            half4 frag(Varyings input) : SV_Target
            {
                UNITY_SETUP_INSTANCE_ID(input);

                float2 coord = input.uv0;
                float distSq = dot(coord, coord);

                // 1. Decoupage circulaire (cercle inscrit au triangle circonscrit R=1.0)
                clip(1.0 - distSq);

                // 2. Decodage Alpha & Emissif selon la specification du Baking Tool :
                //    [0.0, 0.5] = Fumee (opacite passive 0->1)
                //    ]0.5, 1.0] = Flamme (emissive incandescente 0->1)
                float rawA = input.color.a;

                float isFire     = saturate((rawA - 0.5) * 1000.0);
                float smokeAlpha = saturate(rawA * 2.0);
                float outAlpha   = lerp(smokeAlpha, 1.0, isFire);

                float fireRatio   = saturate((rawA - 0.5) * 2.0);
                float outEmissive = fireRatio * _EmissionIntensity;

                // 3. Falloff Gaussien doux naturel (identique au WebGL Three.js)
                float gaussian = saturate((exp(-2.5 * distSq) - 0.082) / 0.918);
                float finalAlpha = outAlpha * _AlphaMultiplier * gaussian;

                if (finalAlpha < 0.003 && outEmissive < 0.01) discard;

                // 4. Couleur finale : RGB de base + Lueur Emissive HDR au coeur du splat
                float3 baseRgb     = input.color.rgb;
                float3 emissiveRgb = baseRgb + (baseRgb * outEmissive);
                float3 finalRgb    = emissiveRgb * (1.0 + gaussian * _CoreGlow);

                return half4(finalRgb, saturate(finalAlpha));
            }
            ENDHLSL
        }
    }
    FallBack "Hidden/Universal Render Pipeline/FallbackError"
}