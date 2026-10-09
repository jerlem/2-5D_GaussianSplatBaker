using UnityEngine;
#if UNITY_EDITOR
using UnityEditor;
#endif
public static class Generate32bitsMesh
{
    public const int SPLAT_COUNT = 262000;
    public static Mesh CreateSplatMesh(int splatCount)
    {
        Mesh mesh = new Mesh();
        mesh.name = $"SplatMesh_{splatCount}";
        // Déverrouille le format 32-bit pour dépasser 65535 sommets
        mesh.indexFormat = UnityEngine.Rendering.IndexFormat.UInt32;
        int vertexCount = splatCount * 3;
        Vector3[] vertices = new Vector3[vertexCount];
        Vector2[] uv0 = new Vector2[vertexCount];
        Vector2[] uv1 = new Vector2[vertexCount];
        int[] triangles = new int[vertexCount];
        float sqrt3 = Mathf.Sqrt(3.0f); // 1.7320508f
        Vector2 v0 = new Vector2(0f, 2.0f);
        Vector2 v1 = new Vector2(-sqrt3, -1.0f);
        Vector2 v2 = new Vector2(sqrt3, -1.0f);
        for (int i = 0; i < splatCount; i++)
        {
            int baseIdx = i * 3;
            float id = (float)i;
            vertices[baseIdx + 0] = new Vector3(v0.x, v0.y, 0f);
            vertices[baseIdx + 1] = new Vector3(v1.x, v1.y, 0f);
            vertices[baseIdx + 2] = new Vector3(v2.x, v2.y, 0f);
            uv0[baseIdx + 0] = v0;
            uv0[baseIdx + 1] = v1;
            uv0[baseIdx + 2] = v2;
            uv1[baseIdx + 0] = new Vector2(id, 0f);
            uv1[baseIdx + 1] = new Vector2(id, 0f);
            uv1[baseIdx + 2] = new Vector2(id, 0f);
            triangles[baseIdx + 0] = baseIdx + 0;
            triangles[baseIdx + 1] = baseIdx + 1;
            triangles[baseIdx + 2] = baseIdx + 2;
        }
        mesh.vertices = vertices;
        mesh.uv = uv0;
        mesh.uv2 = uv1;
        mesh.triangles = triangles;
        mesh.bounds = new Bounds(Vector3.zero, Vector3.one * 100f);
        return mesh;
    }
#if UNITY_EDITOR
    [MenuItem("Tools/2.5D Splats/Creer Mesh 32-bit (65536 Splats)")]
    public static void GenerateAsset()
    {
        Mesh mesh = CreateSplatMesh(SPLAT_COUNT);
        string path = $"Assets/SplatMesh_{SPLAT_COUNT}.asset";
        AssetDatabase.CreateAsset(mesh, path);
        AssetDatabase.SaveAssets();
        Selection.activeObject = mesh;
        Debug.Log($"[SplatMeshGenerator] Mesh généré avec succès en 32-bit : {path} ({mesh.vertexCount} sommets)");
    }
#endif
}