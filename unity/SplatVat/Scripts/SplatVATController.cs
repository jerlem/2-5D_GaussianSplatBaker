// ============================================================================
// SplatVATController.cs - Controleur d'animation pour shader SplatVAT (URP)
// Anime la progression temporelle en boucle via MaterialPropertyBlock
// Compatible Play Mode et Preview dans l'Editeur (ExecuteAlways)
// ============================================================================
using UnityEngine;

[ExecuteAlways]
[RequireComponent(typeof(Renderer))]
[DisallowMultipleComponent]
public class SplatVATController : MonoBehaviour
{
    public enum LoopMode
    {
        Loop,
        PingPong,
        Once,
        Clamp
    }

    [Header("Animation & Timing")]
    [Tooltip("Duree complete d'un cycle d'animation en secondes")]
    [Min(0.01f)]
    public float effectDuration = 2.0f;

    [Tooltip("Multiplicateur de vitesse de lecture")]
    public float playbackSpeed = 1.0f;

    [Tooltip("Mode de bouclage")]
    public LoopMode loopMode = LoopMode.Loop;

    [Tooltip("Demarre l'animation automatiquement")]
    public bool playOnAwake = true;

    [Tooltip("Reinitialise l'animation a l'activation du GameObject")]
    public bool autoRestartOnEnable = true;

    [Tooltip("Decalage initial de temps normalise [0..1]")]
    [Range(0f, 1f)]
    public float timeOffset = 0.0f;

    [Header("Editeur")]
    [Tooltip("Apercu de l'animation en direct dans la vue Scene hors Play Mode")]
    public bool previewInEditMode = true;

    [Header("Ajustements Visuels par Instance (Optionnel)")]
    [Tooltip("Permet de surcharger les proprietes visuelles sur cette instance sans alterer le materiau partage")]
    public bool overrideMaterialProperties = false;

    [Range(0.01f, 10.0f)]
    public float sizeMultiplier = 1.0f;

    [Range(0.1f, 5.0f)]
    public float alphaMultiplier = 1.0f;

    public bool enableEmissive = true;

    [Range(0.0f, 10.0f)]
    public float emissionIntensity = 1.5f;

    [Range(0.0f, 1.0f)]
    public float emissionThreshold = 0.5f;

    [Range(0.0f, 2.0f)]
    public float coreGlow = 0.2f;

    // Progression normalisee interne (privee, masquee de l'inspecteur)
    private float _normalizedTime = 0.0f;

    // Shader Property IDs caches
    private static readonly int PropNormalizedTime = Shader.PropertyToID("_NormalizedTime");
    private static readonly int PropInstancedNormalizedTime = Shader.PropertyToID("_InstancedNormalizedTime");
    private static readonly int PropSizeMultiplier = Shader.PropertyToID("_SizeMultiplier");
    private static readonly int PropInstancedSizeMultiplier = Shader.PropertyToID("_InstancedSizeMultiplier");
    private static readonly int PropAlphaMultiplier = Shader.PropertyToID("_AlphaMultiplier");
    private static readonly int PropInstancedAlphaMultiplier = Shader.PropertyToID("_InstancedAlphaMultiplier");
    private static readonly int PropEnableEmissive = Shader.PropertyToID("_EnableEmissive");
    private static readonly int PropInstancedEnableEmissive = Shader.PropertyToID("_InstancedEnableEmissive");
    private static readonly int PropEmissionIntensity = Shader.PropertyToID("_EmissionIntensity");
    private static readonly int PropInstancedEmissionIntensity = Shader.PropertyToID("_InstancedEmissionIntensity");
    private static readonly int PropEmissionThreshold = Shader.PropertyToID("_EmissionThreshold");
    private static readonly int PropInstancedEmissionThreshold = Shader.PropertyToID("_InstancedEmissionThreshold");
    private static readonly int PropCoreGlow = Shader.PropertyToID("_CoreGlow");
    private static readonly int PropInstancedCoreGlow = Shader.PropertyToID("_InstancedCoreGlow");

    private Renderer _renderer;
    private MeshFilter _meshFilter;
    private MaterialPropertyBlock _propBlock;
    private bool _isPlaying = true;
    private float _pingPongDirection = 1.0f;
    private double _lastEditorTime = 0.0;

    public bool IsPlaying => _isPlaying;

    public float NormalizedTime
    {
        get => _normalizedTime;
        set
        {
            _normalizedTime = Mathf.Clamp01(value);
            ApplyProperties();
        }
    }

    private void Awake()
    {
        EnsureInitialized();

        Mesh targetMesh = GameManager.sharedMesh260k;
        if (targetMesh != null)
        {
            if (_meshFilter != null)
            {
                _meshFilter.sharedMesh = targetMesh;
            }
            else if (TryGetComponent<SkinnedMeshRenderer>(out var skinnedMeshRenderer))
            {
                skinnedMeshRenderer.sharedMesh = targetMesh;
            }
        }
    }

    private void OnEnable()
    {
        EnsureInitialized();

        if (autoRestartOnEnable)
        {
            Restart();
        }

        _isPlaying = playOnAwake;
        _lastEditorTime = Time.realtimeSinceStartupAsDouble;
        ApplyProperties();
    }

    private void EnsureInitialized()
    {
        if (_renderer == null)
        {
            _renderer = GetComponent<Renderer>();
        }

        if (_meshFilter == null)
        {
            _meshFilter = GetComponent<MeshFilter>();
        }

        if (_propBlock == null)
        {
            _propBlock = new MaterialPropertyBlock();
        }
    }

    private void Update()
    {
        float dt;

        if (Application.isPlaying)
        {
            if (!_isPlaying) return;
            dt = Time.deltaTime;
        }
        else
        {
            if (!previewInEditMode) return;
            double currentEditorTime = Time.realtimeSinceStartupAsDouble;
            dt = (float)(currentEditorTime - _lastEditorTime);
            _lastEditorTime = currentEditorTime;

            // Protection contre les deltas anormaux lors des clics d'editeur
            if (dt > 0.2f || dt < 0f) dt = 0.016f;

#if UNITY_EDITOR
            UnityEditor.EditorApplication.QueuePlayerLoopUpdate();
            UnityEditor.SceneView.RepaintAll();
#endif
        }

        float duration = Mathf.Max(0.01f, effectDuration);
        float step = (dt * playbackSpeed) / duration;

        switch (loopMode)
        {
            case LoopMode.Loop:
                _normalizedTime = Mathf.Repeat(_normalizedTime + step, 1.0f);
                break;

            case LoopMode.PingPong:
                _normalizedTime += step * _pingPongDirection;
                if (_normalizedTime >= 1.0f)
                {
                    _normalizedTime = 1.0f;
                    _pingPongDirection = -1.0f;
                }
                else if (_normalizedTime <= 0.0f)
                {
                    _normalizedTime = 0.0f;
                    _pingPongDirection = 1.0f;
                }
                break;

            case LoopMode.Once:
                _normalizedTime += step;
                if (_normalizedTime >= 1.0f)
                {
                    _normalizedTime = 1.0f;
                    _isPlaying = false;
                }
                break;

            case LoopMode.Clamp:
                _normalizedTime = Mathf.Clamp01(_normalizedTime + step);
                break;
        }

        ApplyProperties();
    }

    /// <summary>
    /// Applique les valeurs au Renderer via MaterialPropertyBlock sans instancier de materiau.
    /// </summary>
    public void ApplyProperties()
    {
        EnsureInitialized();
        if (_renderer == null) return;

        _renderer.GetPropertyBlock(_propBlock);

        _propBlock.SetFloat(PropNormalizedTime, _normalizedTime);
        _propBlock.SetFloat(PropInstancedNormalizedTime, _normalizedTime);

        if (overrideMaterialProperties)
        {
            _propBlock.SetFloat(PropSizeMultiplier, sizeMultiplier);
            _propBlock.SetFloat(PropInstancedSizeMultiplier, sizeMultiplier);
            _propBlock.SetFloat(PropAlphaMultiplier, alphaMultiplier);
            _propBlock.SetFloat(PropInstancedAlphaMultiplier, alphaMultiplier);
            _propBlock.SetFloat(PropEnableEmissive, enableEmissive ? 1f : 0f);
            _propBlock.SetFloat(PropInstancedEnableEmissive, enableEmissive ? 1f : 0f);
            _propBlock.SetFloat(PropEmissionIntensity, emissionIntensity);
            _propBlock.SetFloat(PropInstancedEmissionIntensity, emissionIntensity);
            _propBlock.SetFloat(PropEmissionThreshold, emissionThreshold);
            _propBlock.SetFloat(PropInstancedEmissionThreshold, emissionThreshold);
            _propBlock.SetFloat(PropCoreGlow, coreGlow);
            _propBlock.SetFloat(PropInstancedCoreGlow, coreGlow);
        }
        else
        {
            _propBlock.SetFloat(PropInstancedSizeMultiplier, -1f);
            _propBlock.SetFloat(PropInstancedAlphaMultiplier, -1f);
            _propBlock.SetFloat(PropInstancedEnableEmissive, -1f);
            _propBlock.SetFloat(PropInstancedEmissionIntensity, -1f);
            _propBlock.SetFloat(PropInstancedEmissionThreshold, -1f);
            _propBlock.SetFloat(PropInstancedCoreGlow, -1f);
        }

        _renderer.SetPropertyBlock(_propBlock);
    }

    public void Play()
    {
        _isPlaying = true;
    }

    public void Pause()
    {
        _isPlaying = false;
    }

    public void Stop()
    {
        _isPlaying = false;
        _normalizedTime = 0f;
        ApplyProperties();
    }

    public void Restart()
    {
        _normalizedTime = Mathf.Clamp01(timeOffset);
        _pingPongDirection = 1.0f;
        _isPlaying = true;
        ApplyProperties();
    }

    private void OnValidate()
    {
        effectDuration = Mathf.Max(0.01f, effectDuration);
        ApplyProperties();
    }
}
