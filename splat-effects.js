/**
 * 2.5D Gaussian Splats - Modular Post-Pass Animation Effects System
 * Features:
 * - Height over time (formerly Depth Curve) with min scale 0.2x and interactive curve editor
 * - Shaper In (Primitive modifier at beginning of animation)
 * - Shaper Out (Primitive modifier at end of animation)
 * - Half-Sphere (Demi-Sphère) 3D primitive with modes: Échauffement (Emissive), Attract, Repulsion, Échauffement+Attract, Échauffement+Repulsion
 * - Magnitude, Portée (Range), Atténuation (Falloff), Chaleur (Heat/Emissive), Position (X,Y,Z), Rayon, Orientation
 * - Smooth multi-shaper temporal and spatial blending & interpolation
 * - Apply button workflow (non-immediate baking for fast responsive editing)
 */

class BaseSplatEffect {
    constructor(id, type, name) {
        this.id = id || `eff_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        this.type = type; // 'height_over_time', 'scale_over_time', 'emissive_over_time', 'luminance_emissive', 'spherify', 'isometric_proxy', 'shaper_in', 'shaper_out'
        this.name = name;
        this.enabled = true;
        this.showGizmo = true; // Afficher / masquer dans la vue 3D
    }

    getSummary() {
        return "Effect";
    }
}

/**
 * 1. Height Over Time Effect (Z Depth/Height modulation curve)
 */
class HeightOverTimeEffect extends BaseSplatEffect {
    constructor(id) {
        super(id, 'height_over_time', 'Height over time');
        this.axis = 'y'; // Axe de modulation: 'y' (Hauteur Y-Up par défaut), 'z' (Profondeur Z), 'x' (Largeur X), 'xyz' (Tous)
        this.minY = 0.2; // Minimum scale requested: 0.2
        this.maxY = 2.5;
        this.points = [
            { x: 0.0, y: 1.0 },
            { x: 1.0, y: 1.0 }
        ];
    }

    getSummary() {
        const ax = (this.axis || 'y').toUpperCase();
        return `Axe ${ax} • ${this.minY.toFixed(1)}x - ${this.maxY.toFixed(1)}x`;
    }

    reset() {
        this.points = [
            { x: 0.0, y: 1.0 },
            { x: 1.0, y: 1.0 }
        ];
    }

    setPreset(name) {
        if (name === 'flat') {
            this.points = [
                { x: 0.0, y: 1.0 },
                { x: 1.0, y: 1.0 }
            ];
        } else if (name === 'burst') {
            this.points = [
                { x: 0.0, y: 0.25 },
                { x: 0.15, y: 2.2 },
                { x: 0.45, y: 1.3 },
                { x: 1.0, y: 0.8 }
            ];
        } else if (name === 'rise') {
            this.points = [
                { x: 0.0, y: 0.2 },
                { x: 0.5, y: 1.2 },
                { x: 1.0, y: 2.1 }
            ];
        } else if (name === 'fall') {
            this.points = [
                { x: 0.0, y: 2.1 },
                { x: 0.5, y: 1.1 },
                { x: 1.0, y: 0.2 }
            ];
        } else if (name === 'bell') {
            this.points = [
                { x: 0.0, y: 0.3 },
                { x: 0.5, y: 2.2 },
                { x: 1.0, y: 0.3 }
            ];
        }
        this.sortPoints();
    }

    sortPoints() {
        this.points.sort((a, b) => a.x - b.x);
        this.points[0].x = 0.0;
        this.points[this.points.length - 1].x = 1.0;
        for (let i = 0; i < this.points.length; i++) {
            this.points[i].y = Math.max(this.minY, Math.min(this.maxY, this.points[i].y));
        }
    }

    evaluate(t) {
        t = Math.max(0.0, Math.min(1.0, t));
        const pts = this.points;
        const n = pts.length;
        if (n === 0) return 1.0;
        if (n === 1) return pts[0].y;
        if (t <= pts[0].x) return pts[0].y;
        if (t >= pts[n - 1].x) return pts[n - 1].y;

        // Find segment
        let i = 0;
        while (i < n - 1 && pts[i + 1].x < t) {
            i++;
        }

        const p0 = pts[Math.max(0, i - 1)];
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const p3 = pts[Math.min(n - 1, i + 2)];

        const dx = p2.x - p1.x;
        if (dx <= 0.00001) return p1.y;

        const s = (t - p1.x) / dx;

        // Slopes for cubic Hermite
        const m1 = (p2.y - p0.y) / Math.max(0.0001, p2.x - p0.x);
        const m2 = (p3.y - p1.y) / Math.max(0.0001, p3.x - p1.x);

        const s2 = s * s;
        const s3 = s2 * s;

        const h00 = 2 * s3 - 3 * s2 + 1;
        const h10 = s3 - 2 * s2 + s;
        const h01 = -2 * s3 + 3 * s2;
        const h11 = s3 - s2;

        const val = h00 * p1.y + h10 * dx * m1 + h01 * p2.y + h11 * dx * m2;
        return Math.max(this.minY, Math.min(3.0, val));
    }
}

/**
 * 2. Scale Over Time Effect (Radial 3D distance modulation curve)
 */
class ScaleOverTimeEffect extends BaseSplatEffect {
    constructor(id) {
        super(id, 'scale_over_time', 'Scale over time');
        this.minY = 0.2; // Minimum scale: 0.2
        this.maxY = 2.5;
        this.points = [
            { x: 0.0, y: 1.0 },
            { x: 1.0, y: 1.0 }
        ];
    }

    getSummary() {
        return `Scale ${this.minY.toFixed(1)}x - ${this.maxY.toFixed(1)}x`;
    }

    reset() {
        this.points = [
            { x: 0.0, y: 1.0 },
            { x: 1.0, y: 1.0 }
        ];
    }

    setPreset(name) {
        if (name === 'flat') {
            this.points = [
                { x: 0.0, y: 1.0 },
                { x: 1.0, y: 1.0 }
            ];
        } else if (name === 'burst') {
            this.points = [
                { x: 0.0, y: 0.25 },
                { x: 0.15, y: 2.2 },
                { x: 0.45, y: 1.3 },
                { x: 1.0, y: 0.8 }
            ];
        } else if (name === 'rise') {
            this.points = [
                { x: 0.0, y: 0.2 },
                { x: 0.5, y: 1.2 },
                { x: 1.0, y: 2.1 }
            ];
        } else if (name === 'fall') {
            this.points = [
                { x: 0.0, y: 2.1 },
                { x: 0.5, y: 1.1 },
                { x: 1.0, y: 0.2 }
            ];
        } else if (name === 'bell') {
            this.points = [
                { x: 0.0, y: 0.3 },
                { x: 0.5, y: 2.2 },
                { x: 1.0, y: 0.3 }
            ];
        }
        this.sortPoints();
    }

    sortPoints() {
        this.points.sort((a, b) => a.x - b.x);
        this.points[0].x = 0.0;
        this.points[this.points.length - 1].x = 1.0;
        for (let i = 0; i < this.points.length; i++) {
            this.points[i].y = Math.max(this.minY, Math.min(this.maxY, this.points[i].y));
        }
    }

    evaluate(t) {
        t = Math.max(0.0, Math.min(1.0, t));
        const pts = this.points;
        const n = pts.length;
        if (n === 0) return 1.0;
        if (n === 1) return pts[0].y;
        if (t <= pts[0].x) return pts[0].y;
        if (t >= pts[n - 1].x) return pts[n - 1].y;

        // Find segment
        let i = 0;
        while (i < n - 1 && pts[i + 1].x < t) {
            i++;
        }

        const p0 = pts[Math.max(0, i - 1)];
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const p3 = pts[Math.min(n - 1, i + 2)];

        const dx = p2.x - p1.x;
        if (dx <= 0.00001) return p1.y;

        const s = (t - p1.x) / dx;

        // Slopes for cubic Hermite
        const m1 = (p2.y - p0.y) / Math.max(0.0001, p2.x - p0.x);
        const m2 = (p3.y - p1.y) / Math.max(0.0001, p3.x - p1.x);

        const s2 = s * s;
        const s3 = s2 * s;

        const h00 = 2 * s3 - 3 * s2 + 1;
        const h10 = s3 - 2 * s2 + s;
        const h01 = -2 * s3 + 3 * s2;
        const h11 = s3 - s2;

        const val = h00 * p1.y + h10 * dx * m1 + h01 * p2.y + h11 * dx * m2;
        return Math.max(this.minY, Math.min(3.0, val));
    }
}

/**
 * 3. Emissive Over Time Effect (0.0 to 1.0 curve modulation over animation sequence)
 */
class EmissiveOverTimeEffect extends BaseSplatEffect {
    constructor(id) {
        super(id, 'emissive_over_time', 'Emissive over time');
        this.minY = 0.0; // Echelle 0.0 à 1.0
        this.maxY = 1.0;
        this.points = [
            { x: 0.0, y: 1.0 },
            { x: 0.35, y: 0.65 },
            { x: 1.0, y: 0.0 }
        ];
    }

    getSummary() {
        return `Emissive 0.0 - 1.0 (Curve)`;
    }

    reset() {
        this.points = [
            { x: 0.0, y: 1.0 },
            { x: 1.0, y: 0.0 }
        ];
    }

    setPreset(name) {
        if (name === 'burst') {
            this.points = [
                { x: 0.0, y: 1.0 },
                { x: 0.15, y: 0.85 },
                { x: 0.45, y: 0.30 },
                { x: 1.0, y: 0.0 }
            ];
        } else if (name === 'rise') {
            this.points = [
                { x: 0.0, y: 0.0 },
                { x: 0.5, y: 0.5 },
                { x: 1.0, y: 1.0 }
            ];
        } else if (name === 'bell') {
            this.points = [
                { x: 0.0, y: 0.0 },
                { x: 0.3, y: 1.0 },
                { x: 0.7, y: 0.7 },
                { x: 1.0, y: 0.0 }
            ];
        } else if (name === 'flat_1') {
            this.points = [
                { x: 0.0, y: 1.0 },
                { x: 1.0, y: 1.0 }
            ];
        } else if (name === 'flat_0') {
            this.points = [
                { x: 0.0, y: 0.0 },
                { x: 1.0, y: 0.0 }
            ];
        }
        this.sortPoints();
    }

    sortPoints() {
        this.points.sort((a, b) => a.x - b.x);
        this.points[0].x = 0.0;
        this.points[this.points.length - 1].x = 1.0;
        for (let i = 0; i < this.points.length; i++) {
            this.points[i].y = Math.max(this.minY, Math.min(this.maxY, this.points[i].y));
        }
    }

    evaluate(t) {
        t = Math.max(0.0, Math.min(1.0, t));
        const pts = this.points;
        const n = pts.length;
        if (n === 0) return 0.0;
        if (n === 1) return pts[0].y;
        if (t <= pts[0].x) return pts[0].y;
        if (t >= pts[n - 1].x) return pts[n - 1].y;

        let i = 0;
        while (i < n - 1 && pts[i + 1].x < t) {
            i++;
        }

        const p0 = pts[Math.max(0, i - 1)];
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const p3 = pts[Math.min(n - 1, i + 2)];

        const dx = p2.x - p1.x;
        if (dx <= 0.00001) return p1.y;

        const s = (t - p1.x) / dx;

        const m1 = (p2.y - p0.y) / Math.max(0.0001, p2.x - p0.x);
        const m2 = (p3.y - p1.y) / Math.max(0.0001, p3.x - p1.x);

        const s2 = s * s;
        const s3 = s2 * s;

        const h00 = 2 * s3 - 3 * s2 + 1;
        const h10 = s3 - 2 * s2 + s;
        const h01 = -2 * s3 + 3 * s2;
        const h11 = s3 - s2;

        const val = h00 * p1.y + h10 * dx * m1 + h01 * p2.y + h11 * dx * m2;
        return Math.max(this.minY, Math.min(this.maxY, val));
    }
}

/**
 * 4. Luminance Emissive Effect (Automatic Emissive based on Splat Brightness / Luminance)
 */
class LuminanceEmissiveEffect extends BaseSplatEffect {
    constructor(id) {
        super(id, 'luminance_emissive', 'Luminance Emissive');
        this.threshold = 0.55;        // Seuil de luminance (0.0 à 1.0, default 0.55)
        this.intensity = 1.0;        // Boost / intensité d'émissive (0.0 à 3.0, default 1.0)
        this.colorFilter = '#ffffff'; // Couleur cible / luminance (défaut blanc)
        this.softness = 0.15;         // Lissage du seuil (0.0 à 0.5)
    }

    getSummary() {
        return `Seuil: ${Math.round(this.threshold * 100)}% • Boost: ${this.intensity.toFixed(1)}x`;
    }

    /**
     * Compute auto-emissive contribution from splat RGB color (0..1)
     */
    evaluateColor(r, g, b) {
        // Standard perceived luminance (Rec. 601 / 709)
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        const th = Math.max(0.0, Math.min(0.99, this.threshold));
        const soft = Math.max(0.01, this.softness);

        if (lum <= (th - soft)) {
            return 0.0;
        }

        let normFactor = 0.0;
        if (lum >= (th + soft)) {
            normFactor = (lum - th) / Math.max(0.01, 1.0 - th);
        } else {
            // Smoothstep transition in knee zone
            const progress = (lum - (th - soft)) / (2.0 * soft);
            const smooth = progress * progress * (3.0 - 2.0 * progress);
            normFactor = smooth * (soft / Math.max(0.01, 1.0 - th));
        }

        return Math.max(0.0, Math.min(1.0, normFactor * this.intensity));
    }
}

/**
 * 5. HSV Mix Tint Effect (Dynamic Color Tint, Blend Modes, and HSV Color Grading)
 */
class HsvMixTintEffect extends BaseSplatEffect {
    constructor(id) {
        super(id, 'hsv_mix_tint', 'HSV Mix Tint');
        this.color = '#38bdf8';       // Couleur de teinte cible (hex string)
        this.blendMode = 'colorize';  // 'colorize', 'mix', 'multiply', 'screen', 'overlay', 'add', 'soft_light', 'hue_shift'
        this.mix = 0.80;              // % de mix (0.0 à 1.0, défaut 80%)
        this.satBoost = 1.0;          // Saturation Boost (0.0 à 3.0, défaut 1.0x)
        this.valBoost = 1.0;          // Brightness / Value Boost (0.0 à 2.0, défaut 1.0x)
    }

    getSummary() {
        const modeLabels = {
            colorize: 'Colorize (HSV)',
            mix: 'Mix (Normal)',
            multiply: 'Multiply',
            screen: 'Screen',
            overlay: 'Overlay',
            add: 'Additive',
            soft_light: 'Soft Light',
            hue_shift: 'Hue Shift'
        };
        const pct = Math.round((this.mix !== undefined ? this.mix : 0.8) * 100);
        return `Tint ${this.color} (${modeLabels[this.blendMode] || this.blendMode} • ${pct}%)`;
    }

    /**
     * Helper: Convert Hex color string (#RRGGBB) to [r, g, b] in [0, 1]
     */
    static hexToRgb(hex) {
        if (!hex) return [1, 1, 1];
        let c = String(hex).replace('#', '').trim();
        if (c.length === 3) {
            c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
        }
        const num = parseInt(c, 16);
        if (isNaN(num)) return [1, 1, 1];
        return [
            ((num >> 16) & 255) / 255.0,
            ((num >> 8) & 255) / 255.0,
            (num & 255) / 255.0
        ];
    }

    /**
     * Helper: RGB [0,1] to HSV [h (0..1), s (0..1), v (0..1)]
     */
    static rgbToHsv(r, g, b) {
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const d = max - min;
        let h = 0;
        const s = max === 0 ? 0 : d / max;
        const v = max;

        if (max !== min) {
            if (max === r) {
                h = (g - b) / d + (g < b ? 6 : 0);
            } else if (max === g) {
                h = (b - r) / d + 2;
            } else if (max === b) {
                h = (r - g) / d + 4;
            }
            h /= 6;
        }

        return [h, s, v];
    }

    /**
     * Helper: HSV [h (0..1), s (0..1), v (0..1)] to RGB [0,1]
     */
    static hsvToRgb(h, s, v) {
        h = (h % 1.0 + 1.0) % 1.0;
        s = Math.max(0, Math.min(1, s));
        v = Math.max(0, Math.min(1, v));

        const i = Math.floor(h * 6);
        const f = h * 6 - i;
        const p = v * (1 - s);
        const q = v * (1 - f * s);
        const t = v * (1 - (1 - f) * s);

        let r = 0, g = 0, b = 0;
        switch (i % 6) {
            case 0: r = v; g = t; b = p; break;
            case 1: r = q; g = v; b = p; break;
            case 2: r = p; g = v; b = t; break;
            case 3: r = p; g = q; b = v; break;
            case 4: r = t; g = p; b = v; break;
            case 5: r = v; g = p; b = q; break;
        }
        return [r, g, b];
    }

    /**
     * Apply HSV tint & blend mode to splat RGB (r, g, b in 0..1)
     * Returns { r, g, b } in [0, 1]
     */
    applyColor(r, g, b, t01 = 0) {
        const mixVal = Math.max(0.0, Math.min(1.0, this.mix !== undefined ? this.mix : 0.80));
        if (mixVal <= 0.0001) {
            return { r, g, b };
        }

        const [tr, tg, tb] = HsvMixTintEffect.hexToRgb(this.color || '#38bdf8');
        const [th, ts, tv] = HsvMixTintEffect.rgbToHsv(tr, tg, tb);
        const [origH, origS, origV] = HsvMixTintEffect.rgbToHsv(r, g, b);

        const satMult = this.satBoost !== undefined ? this.satBoost : 1.0;
        const valMult = this.valBoost !== undefined ? this.valBoost : 1.0;

        let blendR = r;
        let blendG = g;
        let blendB = b;

        const mode = this.blendMode || 'colorize';

        if (mode === 'colorize') {
            // Replaces Hue with target Hue, modulates Saturation, preserves original Luminosity/Value
            const targetS = Math.min(1.0, ts * satMult);
            const targetV = Math.min(1.0, origV * valMult);
            const rgb = HsvMixTintEffect.hsvToRgb(th, targetS, targetV);
            blendR = rgb[0];
            blendG = rgb[1];
            blendB = rgb[2];
        } else if (mode === 'hue_shift') {
            // Shifts original hue by target hue
            const shiftedH = (origH + th) % 1.0;
            const targetS = Math.min(1.0, origS * satMult);
            const targetV = Math.min(1.0, origV * valMult);
            const rgb = HsvMixTintEffect.hsvToRgb(shiftedH, targetS, targetV);
            blendR = rgb[0];
            blendG = rgb[1];
            blendB = rgb[2];
        } else if (mode === 'mix') {
            // Standard normal interpolation
            blendR = tr * valMult;
            blendG = tg * valMult;
            blendB = tb * valMult;
        } else if (mode === 'multiply') {
            blendR = r * tr * valMult;
            blendG = g * tg * valMult;
            blendB = b * tb * valMult;
        } else if (mode === 'screen') {
            blendR = (1.0 - (1.0 - r) * (1.0 - tr)) * valMult;
            blendG = (1.0 - (1.0 - g) * (1.0 - tg)) * valMult;
            blendB = (1.0 - (1.0 - b) * (1.0 - tb)) * valMult;
        } else if (mode === 'overlay') {
            const ov = (c, tc) => (c < 0.5) ? (2.0 * c * tc) : (1.0 - 2.0 * (1.0 - c) * (1.0 - tc));
            blendR = ov(r, tr) * valMult;
            blendG = ov(g, tg) * valMult;
            blendB = ov(b, tb) * valMult;
        } else if (mode === 'add') {
            blendR = Math.min(1.0, r + tr * valMult);
            blendG = Math.min(1.0, g + tg * valMult);
            blendB = Math.min(1.0, b + tb * valMult);
        } else if (mode === 'soft_light') {
            const sl = (c, tc) => (1.0 - 2.0 * tc) * c * c + 2.0 * tc * c;
            blendR = sl(r, tr) * valMult;
            blendG = sl(g, tg) * valMult;
            blendB = sl(b, tb) * valMult;
        }

        // Apply mix strength
        const finalR = Math.max(0.0, Math.min(1.0, r + (blendR - r) * mixVal));
        const finalG = Math.max(0.0, Math.min(1.0, g + (blendG - g) * mixVal));
        const finalB = Math.max(0.0, Math.min(1.0, b + (blendB - b) * mixVal));

        return { r: finalR, g: finalG, b: finalB };
    }
}

/**
 * 6. Temporal Smooth Effect (Position smoothing over timeline frames to eliminate stutter/jitter)
 */
class SmoothEffect extends BaseSplatEffect {
    constructor(id) {
        super(id, 'smooth', 'Temporal Smooth');
        this.frames = 5;              // Nombre de frames de la fenêtre (1 à 15, default 5 frames)
        this.kernel = 'gaussian';     // 'gaussian' (Lissage gaussien - naturel), 'exponential' (Filtre EMA bidirectionnel), 'moving_average' (Moyenne mobile uniforme)
        this.strength = 1.0;          // Force du lissage (0.0 à 1.0, default 100%)
        this.axis = 'xyz';            // 'xyz' (Tous axes), 'z' (Profondeur Z uniquement), 'xy' (Plan XY), 'y' (Hauteur Y), 'x' (Largeur X)
    }

    getSummary() {
        const kernelLabels = {
            gaussian: 'Gaussian',
            moving_average: 'Box Average',
            exponential: 'Bidirectional EMA'
        };
        const axisLabels = {
            xyz: 'XYZ',
            z: 'Z (Depth)',
            xy: 'XY (Plane)',
            y: 'Y (Height)',
            x: 'X (Width)'
        };
        const pct = Math.round((this.strength !== undefined ? this.strength : 1.0) * 100);
        return `${this.frames || 5} Frames (${kernelLabels[this.kernel] || this.kernel} • ${axisLabels[this.axis] || this.axis} • ${pct}%)`;
    }

    /**
     * Apply temporal smoothing across T frames for N splats.
     * positions: Float32Array of size T * N * 3 [t * N * 3 + i * 3 + 0..2]
     */
    applySmoothing(positions, N, T) {
        if (!positions || T <= 1 || N <= 0) return;

        const numFrames = Math.max(1, Math.min(21, Math.round(this.frames || 5)));
        const strength = Math.max(0.0, Math.min(1.0, this.strength !== undefined ? this.strength : 1.0));
        if (numFrames <= 1 || strength <= 0.0001) return;

        const radius = Math.max(1, Math.floor(numFrames / 2));
        const kernel = this.kernel || 'gaussian';
        const axis = this.axis || 'xyz';

        const smoothX = (axis === 'xyz' || axis === 'xy' || axis === 'x');
        const smoothY = (axis === 'xyz' || axis === 'xy' || axis === 'y');
        const smoothZ = (axis === 'xyz' || axis === 'z');

        // Precompute weights for window [-radius, +radius]
        const windowSize = 2 * radius + 1;
        const weights = new Float32Array(windowSize);

        if (kernel === 'gaussian') {
            const sigma = Math.max(0.5, radius / 2.0);
            const twoSigmaSq = 2.0 * sigma * sigma;
            let sumW = 0.0;
            for (let k = -radius; k <= radius; k++) {
                const w = Math.exp(-(k * k) / twoSigmaSq);
                weights[k + radius] = w;
                sumW += w;
            }
            for (let k = 0; k < windowSize; k++) {
                weights[k] /= sumW;
            }
        } else if (kernel === 'moving_average') {
            const uniformW = 1.0 / windowSize;
            weights.fill(uniformW);
        }

        // Temporary trajectory buffer for 1 splat across T frames
        const trajX = new Float32Array(T);
        const trajY = new Float32Array(T);
        const trajZ = new Float32Array(T);

        const outTrajX = new Float32Array(T);
        const outTrajY = new Float32Array(T);
        const outTrajZ = new Float32Array(T);

        for (let i = 0; i < N; i++) {
            // Extract trajectory for splat i
            for (let t = 0; t < T; t++) {
                const idx = (t * N + i) * 3;
                trajX[t] = positions[idx + 0];
                trajY[t] = positions[idx + 1];
                trajZ[t] = positions[idx + 2];
            }

            if (kernel === 'exponential') {
                // Zero-phase Bidirectional EMA
                const alpha = 2.0 / (numFrames + 1.0);
                const oneMinusAlpha = 1.0 - alpha;

                // Forward pass
                outTrajX[0] = trajX[0];
                outTrajY[0] = trajY[0];
                outTrajZ[0] = trajZ[0];
                for (let t = 1; t < T; t++) {
                    outTrajX[t] = alpha * trajX[t] + oneMinusAlpha * outTrajX[t - 1];
                    outTrajY[t] = alpha * trajY[t] + oneMinusAlpha * outTrajY[t - 1];
                    outTrajZ[t] = alpha * trajZ[t] + oneMinusAlpha * outTrajZ[t - 1];
                }

                // Backward pass
                for (let t = T - 2; t >= 0; t--) {
                    outTrajX[t] = alpha * outTrajX[t] + oneMinusAlpha * outTrajX[t + 1];
                    outTrajY[t] = alpha * outTrajY[t] + oneMinusAlpha * outTrajY[t + 1];
                    outTrajZ[t] = alpha * outTrajZ[t] + oneMinusAlpha * outTrajZ[t + 1];
                }
            } else {
                // Weighted moving window (Gaussian / Box)
                for (let t = 0; t < T; t++) {
                    let accX = 0, accY = 0, accZ = 0;
                    let normW = 0;
                    for (let k = -radius; k <= radius; k++) {
                        const frame = Math.max(0, Math.min(T - 1, t + k));
                        const w = weights[k + radius];
                        accX += trajX[frame] * w;
                        accY += trajY[frame] * w;
                        accZ += trajZ[frame] * w;
                        normW += w;
                    }
                    outTrajX[t] = accX / normW;
                    outTrajY[t] = accY / normW;
                    outTrajZ[t] = accZ / normW;
                }
            }

            // Write back interpolated positions with strength mix
            for (let t = 0; t < T; t++) {
                const idx = (t * N + i) * 3;
                if (smoothX) {
                    positions[idx + 0] = trajX[t] + (outTrajX[t] - trajX[t]) * strength;
                }
                if (smoothY) {
                    positions[idx + 1] = trajY[t] + (outTrajY[t] - trajY[t]) * strength;
                }
                if (smoothZ) {
                    positions[idx + 2] = trajZ[t] + (outTrajZ[t] - trajZ[t]) * strength;
                }
            }
        }
    }
}

/**
 * 7. Spherify Effect (Conform splats on the surface of a half-sphere / demi-sphère with 3D non-uniform scaling)
 */
class SpherifyEffect extends BaseSplatEffect {
    constructor(id) {
        super(id, 'spherify', 'Spherify');
        this.radius = 2.0;            // Rayon de la demi-sphère (min 0.1, max 10.0, default 2.0)
        this.scale = { x: 1.0, y: 1.0, z: 1.0 }; // Echelle 3D non-uniforme (X, Y, Z)
        this.mode = 'dome';           // 'dome' (Dome Height / Z-Depth Projection), 'polar_wrap' (Smooth Polar Conformal Wrap), 'radial' (3D Sphere Cast)
        this.curvature = 'convex';    // 'convex' (+ Dome), 'concave' (- Bowl / Inverted)
        this.strength = 0.5;          // Force de conform (défaut 50%)
        this.position = { x: 0.0, y: 0.0, z: 0.0 }; // Centre 3D
    }

    getSummary() {
        const modeLabels = {
            dome: 'Dome Height',
            polar_wrap: 'Polar Wrap',
            radial: '3D Sphere'
        };
        const curvLabel = this.curvature === 'concave' ? 'Concave' : 'Convex';
        const sx = (this.scale && this.scale.x !== undefined) ? this.scale.x : 1.0;
        const sy = (this.scale && this.scale.y !== undefined) ? this.scale.y : 1.0;
        const sz = (this.scale && this.scale.z !== undefined) ? this.scale.z : 1.0;
        const isScaled = (Math.abs(sx - 1.0) > 0.01 || Math.abs(sy - 1.0) > 0.01 || Math.abs(sz - 1.0) > 0.01);
        const scaleStr = isScaled ? ` • S:[${sx.toFixed(1)},${sy.toFixed(1)},${sz.toFixed(1)}]` : '';
        return `Hemisphere R:${this.radius.toFixed(2)}m${scaleStr} (${modeLabels[this.mode] || this.mode} • ${curvLabel})`;
    }

    /**
     * Projects a 2.5D splat point (px, py, pz) onto the surface of a hemisphere dome with 3D non-uniform scale
     */
    evaluateAt(px, py, pz, t01) {
        const str = Math.max(0.0, Math.min(1.0, (this.strength !== undefined ? this.strength : 0.5)));
        if (str <= 0.0001) {
            return { x: px, y: py, z: pz };
        }

        const cx = (this.position && this.position.x !== undefined) ? this.position.x : 0.0;
        const cy = (this.position && this.position.y !== undefined) ? this.position.y : 0.0;
        const cz = (this.position && this.position.z !== undefined) ? this.position.z : 0.0;

        const sx = Math.max(0.001, (this.scale && this.scale.x !== undefined) ? this.scale.x : 1.0);
        const sy = Math.max(0.001, (this.scale && this.scale.y !== undefined) ? this.scale.y : 1.0);
        const sz = Math.max(0.001, (this.scale && this.scale.z !== undefined) ? this.scale.z : 1.0);

        const R = Math.max(0.05, this.radius);

        const vx = px - cx;
        const vy = py - cy;
        const vz = pz - cz;

        const sign = (this.curvature === 'concave') ? -1.0 : 1.0;

        let targetX = px;
        let targetY = py;
        let targetZ = pz;

        if (this.mode === 'radial') {
            // Full 3D radial sphere / ellipsoid conform
            const nx = vx / sx;
            const ny = vy / sy;
            const nz = vz / sz;
            const distNorm = Math.sqrt(nx * nx + ny * ny + nz * nz);
            if (distNorm > 0.0001) {
                targetX = cx + (nx / distNorm) * R * sx;
                targetY = cy + (ny / distNorm) * R * sy;
                targetZ = cz + (nz / distNorm) * R * sz * sign;
            }
        } else if (this.mode === 'polar_wrap') {
            // Smooth conformal polar wrap over ellipsoid dome
            const nx = vx / sx;
            const ny = vy / sy;
            const rNorm = Math.sqrt(nx * nx + ny * ny);

            if (rNorm > 0.0001) {
                const phi = Math.min(1.0, rNorm / R) * (Math.PI * 0.5); // 0 (pole) to pi/2 (equator)
                const sinPhi = Math.sin(phi);
                const cosPhi = Math.cos(phi);
                const uX = nx / rNorm;
                const uY = ny / rNorm;

                targetX = cx + (R * sinPhi * uX) * sx;
                targetY = cy + (R * sinPhi * uY) * sy;
                targetZ = cz + (R * cosPhi * sign) * sz;
            } else {
                targetX = cx;
                targetY = cy;
                targetZ = cz + (R * sign) * sz;
            }
        } else {
            // Default 'dome': Height-only projection onto ellipsoid dome surface
            const nx = vx / (R * sx);
            const ny = vy / (R * sy);
            const rNormSq = nx * nx + ny * ny;

            let heightOnDome = 0.0;
            if (rNormSq < 1.0) {
                heightOnDome = Math.sqrt(1.0 - rNormSq) * R * sz;
            }
            targetX = px;
            targetY = py;
            targetZ = cz + heightOnDome * sign;
        }

        return {
            x: px + (targetX - px) * str,
            y: py + (targetY - py) * str,
            z: pz + (targetZ - pz) * str
        };
    }
}

/**
 * 6. Isometric Box Proxy Effect (Beveled Cube Corner Geometry Projection)
 * Inspired by Spherify & 3D Isometric Projection Specification:
 * - Lower vertical walls (Pans verticaux 90° du sol, Y=0 to Y_wall)
 * - Upper 45° beveled chamfer (Chanfrein intermédiaire face caméra isométrique)
/**
 * Isometric Beveled Octagonal Dome Proxy Effect
 * Conforms 3D splats towards a beveled octagonal dome volume (Blender Isometric Proxy):
 * - 8 vertical wall facets (octagonal prism base)
 * - 4 sloped quad trapezoids on cardinal sides
 * - 4 sloped corner triangles converging to the top square corners
 * - 1 flat horizontal square top roof
 * - Default conform strength: 50% (0.50)
 */
class IsometricProxyEffect extends BaseSplatEffect {
    constructor(id) {
        super(id, 'isometric_proxy', 'Isometric Box Proxy');
        this.width = 2.0;            // Base Width / Diameter in XZ (0.1 à 10.0m, default 2.0)
        this.height = 2.0;           // Total Height in Y (0.1 à 10.0m, default 2.0)
        this.wallRatio = 0.40;       // Vertical wall height ratio (10% à 80%, default 40%)
        this.topRatio = 0.50;        // Top square roof size ratio relative to base width (10% à 90%, default 50%)
        this.chamfer = 0.50;         // Base corner chamfer / bevel ratio (10% à 80%, default 50%)
        this.strength = 0.5;         // Conform strength (0.0 to 1.0, default 50%)
        this.position = { x: 0.0, y: 0.0, z: 0.0 }; // 3D Center
    }

    getSummary() {
        return `Proxy W:${this.width.toFixed(1)}m H:${this.height.toFixed(1)}m (Conform ${Math.round(this.strength * 100)}%)`;
    }

    /**
     * Projects splat (px, py, pz) towards the 3D Beveled Octagonal Dome Proxy shell
     */
    evaluateAt(px, py, pz, t01) {
        const str = Math.max(0.0, Math.min(1.0, (this.strength !== undefined ? this.strength : 0.5)));
        if (str <= 0.0001) {
            return { x: px, y: py, z: pz };
        }

        const cx = (this.position && this.position.x !== undefined) ? this.position.x : 0.0;
        const cy = (this.position && this.position.y !== undefined) ? this.position.y : 0.0;
        const cz = (this.position && this.position.z !== undefined) ? this.position.z : 0.0;

        const W = Math.max(0.05, (this.width || 2.0) * 0.5); // Half-width (radius)
        const H = Math.max(0.1, this.height || 2.0);
        const wallH = H * Math.max(0.05, Math.min(0.95, this.wallRatio !== undefined ? this.wallRatio : 0.40));
        const topRatio = Math.max(0.05, Math.min(0.95, this.topRatio !== undefined ? this.topRatio : 0.50));
        const chamferRatio = Math.max(0.05, Math.min(0.95, this.chamfer !== undefined ? this.chamfer : 0.50));

        const W_top = W * topRatio;
        const k_base = W * (1.0 - chamferRatio);

        const yBase = -H * 0.5;
        const yWall = yBase + wallH;
        const yTop = H * 0.5;

        // Relative coordinates from 3D center
        const vx = px - cx;
        const vy = py - cy;
        const vz = pz - cz;

        // Vertical clamping / target Y
        const clampedY = Math.max(yBase, Math.min(yTop, vy));
        let targetY = clampedY;

        // Compute cross-section dimensions at clampedY
        let W_curr = W;
        let k_curr = k_base;

        if (clampedY > yWall) {
            const u = (clampedY - yWall) / Math.max(0.001, yTop - yWall); // 0 (at wall top) -> 1 (at roof top)
            W_curr = (1.0 - u) * W + u * W_top;
            k_curr = (1.0 - u) * k_base + u * W_top;
        }

        // Horizontal projection on the octagonal perimeter at (W_curr, k_curr)
        const ax = Math.abs(vx);
        const az = Math.abs(vz);
        const sx = vx >= 0 ? 1 : -1;
        const sz = vz >= 0 ? 1 : -1;

        let tx = 0, tz = 0;
        if (ax <= 0.0001 && az <= 0.0001) {
            tx = 0;
            tz = 0;
        } else if (az <= (k_curr / Math.max(0.001, W_curr)) * ax) {
            // Hits East/West wall
            tx = sx * W_curr;
            tz = sz * (az / ax) * W_curr;
        } else if (ax <= (k_curr / Math.max(0.001, W_curr)) * az) {
            // Hits North/South wall
            tz = sz * W_curr;
            tx = sx * (ax / az) * W_curr;
        } else {
            // Hits 45° Corner chamfer: x + z = W_curr + k_curr
            const sum = ax + az;
            const scale = (W_curr + k_curr) / Math.max(0.001, sum);
            tx = sx * (ax * scale);
            tz = sz * (az * scale);
        }

        // Top roof flat cap check
        if (vy >= yTop - 0.02 && ax <= W_top && az <= W_top) {
            targetY = yTop;
            tx = vx;
            tz = vz;
        }

        return {
            x: px + (tx + cx - px) * str,
            y: py + (targetY + cy - py) * str,
            z: pz + (tz + cz - pz) * str
        };
    }
}

/**
 * 4. Shaper Effect (Shaper In / Shaper Out with Half-Sphere Primitive)
 */
class ShaperEffect extends BaseSplatEffect {
    constructor(id, type = 'shaper_in') {
        const isOut = (type === 'shaper_out');
        super(id, type, isOut ? 'Shaper Out' : 'Shaper In');

        this.primitive = 'half_sphere'; // 'half_sphere'
        this.mode = 'heat_attract';     // 'heat', 'attract', 'repulse', 'heat_attract', 'heat_repulse'
        this.magnitude = 0.8;           // Force d'attraction / répulsion
        this.range = 0.9;               // Portée de l'effet
        this.falloffType = 'smoothstep';// 'smoothstep', 'linear', 'quadratic'
        this.heat = 1.0;                // Valeur d'émissive / chaleur
        
        // Transform 3D
        this.position = { x: 0.0, y: 0.0, z: 0.0 };
        this.radius = 0.9;
        this.direction = 'up';          // 'up' (+Y), 'down' (-Y), 'forward' (+Z), 'back' (-Z), 'right' (+X), 'left' (-X)

        // Time envelope
        if (isOut) {
            this.timeStart = 0.65;      // Start at 65% of sequence
            this.timeEnd = 1.0;
            this.fadeDuration = 0.20;
        } else {
            this.timeStart = 0.0;
            this.timeEnd = 0.35;        // Active until 35% of sequence
            this.fadeDuration = 0.15;
        }
    }

    getSummary() {
        const modeNames = {
            heat: 'Emissive Heat',
            attract: 'Attract',
            repulse: 'Repulsion',
            heat_attract: 'Heat + Attract',
            heat_repulse: 'Heat + Repulsion'
        };
        return `Half-Sphere • ${modeNames[this.mode] || this.mode}`;
    }

    /**
     * Compute time envelope weight w(t) in [0, 1] for current frame progress t01
     */
    getTimeWeight(t01) {
        t01 = Math.max(0.0, Math.min(1.0, t01));
        const fade = Math.max(0.01, this.fadeDuration);

        if (this.type === 'shaper_in') {
            // Active at start, fades out towards timeEnd
            if (t01 >= this.timeEnd) return 0.0;
            if (t01 <= (this.timeEnd - fade)) return 1.0;
            const progress = (t01 - (this.timeEnd - fade)) / fade;
            // Smoothstep fade out: 1 -> 0
            return 1.0 - (progress * progress * (3.0 - 2.0 * progress));
        } else {
            // Active at end, fades in starting from timeStart
            if (t01 <= this.timeStart) return 0.0;
            if (t01 >= (this.timeStart + fade)) return 1.0;
            const progress = (t01 - this.timeStart) / fade;
            // Smoothstep fade in: 0 -> 1
            return progress * progress * (3.0 - 2.0 * progress);
        }
    }

    /**
     * Get 3D normal vector corresponding to dome direction
     */
    getDirectionVector() {
        switch (this.direction) {
            case 'up':      return { x: 0, y: 1, z: 0 };
            case 'down':    return { x: 0, y: -1, z: 0 };
            case 'forward': return { x: 0, y: 0, z: 1 };
            case 'back':    return { x: 0, y: 0, z: -1 };
            case 'right':   return { x: 1, y: 0, z: 0 };
            case 'left':    return { x: -1, y: 0, z: 0 };
            default:        return { x: 0, y: 1, z: 0 };
        }
    }

    /**
     * Evaluate spatial displacement and heat contribution for a single splat at (px, py, pz) and time t01
     */
    evaluateAt(px, py, pz, t01) {
        const timeWeight = this.getTimeWeight(t01);
        if (timeWeight <= 0.0001) {
            return { dx: 0, dy: 0, dz: 0, heat: 0 };
        }

        const cx = this.position.x;
        const cy = this.position.y;
        const cz = this.position.z;
        const R = Math.max(0.05, this.radius);
        const range = Math.max(0.05, this.range);
        const D = this.getDirectionVector();

        // Vector from half-sphere center to point
        const vx = px - cx;
        const vy = py - cy;
        const vz = pz - cz;
        const distFromCenter = Math.sqrt(vx * vx + vy * vy + vz * vz);

        // Dot product with dome normal axis
        const h = vx * D.x + vy * D.y + vz * D.z;

        // Direction unit vector from center
        let ux = D.x, uy = D.y, uz = D.z;
        if (distFromCenter > 0.0001) {
            ux = vx / distFromCenter;
            uy = vy / distFromCenter;
            uz = vz / distFromCenter;
        }

        let distToSurface = 0.0;
        let targetX = cx, targetY = cy, targetZ = cz;
        let pushDirX = ux, pushDirY = uy, pushDirZ = uz;

        if (h >= 0) {
            // Front dome hemisphere
            distToSurface = Math.abs(distFromCenter - R);
            targetX = cx + ux * R;
            targetY = cy + uy * R;
            targetZ = cz + uz * R;
            pushDirX = ux;
            pushDirY = uy;
            pushDirZ = uz;
        } else {
            // Flat base circular cap or behind dome plane
            const radProjX = vx - h * D.x;
            const radProjY = vy - h * D.y;
            const radProjZ = vz - h * D.z;
            const radDist = Math.sqrt(radProjX * radProjX + radProjY * radProjY + radProjZ * radProjZ);

            if (radDist <= R) {
                distToSurface = Math.abs(h);
                targetX = cx + radProjX;
                targetY = cy + radProjY;
                targetZ = cz + radProjZ;
                pushDirX = -D.x;
                pushDirY = -D.y;
                pushDirZ = -D.z;
            } else {
                const excessRad = radDist - R;
                distToSurface = Math.sqrt(h * h + excessRad * excessRad);
                const rNorm = (radDist > 0.0001) ? (1.0 / radDist) : 0.0;
                targetX = cx + radProjX * rNorm * R;
                targetY = cy + radProjY * rNorm * R;
                targetZ = cz + radProjZ * rNorm * R;
                pushDirX = ux;
                pushDirY = uy;
                pushDirZ = uz;
            }
        }

        // Out of influence range
        if (distToSurface > range) {
            return { dx: 0, dy: 0, dz: 0, heat: 0 };
        }

        // Attenuation curve across range
        const uDist = distToSurface / range; // 0 (at surface) -> 1 (at range boundary)
        let falloff = 0.0;
        if (this.falloffType === 'linear') {
            falloff = 1.0 - uDist;
        } else if (this.falloffType === 'quadratic') {
            const f = 1.0 - uDist;
            falloff = f * f;
        } else {
            // Smoothstep
            falloff = 1.0 - (uDist * uDist * (3.0 - 2.0 * uDist));
        }

        const totalStrength = timeWeight * falloff;
        let dx = 0.0, dy = 0.0, dz = 0.0, heatVal = 0.0;

        const isAttract = (this.mode === 'attract' || this.mode === 'heat_attract');
        const isRepulse = (this.mode === 'repulse' || this.mode === 'heat_repulse');
        const isHeat = (this.mode === 'heat' || this.mode === 'heat_attract' || this.mode === 'heat_repulse');

        if (isAttract) {
            const pullFactor = this.magnitude * totalStrength;
            dx += (targetX - px) * pullFactor;
            dy += (targetY - py) * pullFactor;
            dz += (targetZ - pz) * pullFactor;
        } else if (isRepulse) {
            const pushFactor = this.magnitude * range * totalStrength;
            dx += pushDirX * pushFactor;
            dy += pushDirY * pushFactor;
            dz += pushDirZ * pushFactor;
        }

        if (isHeat) {
            heatVal = this.heat * totalStrength;
        }

        return { dx, dy, dz, heat: heatVal };
    }
}

/**
 * 3. Interactive Canvas Renderer for Height Over Time
 */
class HeightOverTimeCanvas {
    constructor(canvasElement, effectInstance, onPointChange) {
        this.canvas = canvasElement;
        this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
        this.effect = effectInstance;
        this.onPointChange = onPointChange;

        this.padding = { top: 10, bottom: 12, left: 24, right: 18 };
        this.hoveredPoint = -1;
        this.draggingPoint = -1;
        this.playheadT = 0.0;

        this.initEvents();
        this.resize();
    }

    setEffect(effectInstance) {
        this.effect = effectInstance;
        this.draw();
    }

    resize() {
        if (!this.canvas) return;
        const rect = this.canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = Math.max(100, Math.floor(rect.width * dpr));
        this.canvas.height = Math.max(50, Math.floor(rect.height * dpr));
        this.draw();
    }

    worldToScreen(x, y) {
        if (!this.effect) return { x: 0, y: 0 };
        const dpr = window.devicePixelRatio || 1;
        const w = this.canvas.width / dpr;
        const h = this.canvas.height / dpr;
        const pad = this.padding;

        const plotW = w - pad.left - pad.right;
        const plotH = h - pad.top - pad.bottom;

        const sx = pad.left + x * plotW;
        const sy = pad.top + (1.0 - (y - this.effect.minY) / (this.effect.maxY - this.effect.minY)) * plotH;
        return { x: sx * dpr, y: sy * dpr };
    }

    screenToWorld(sx, sy) {
        if (!this.effect) return { x: 0, y: 1 };
        const dpr = window.devicePixelRatio || 1;
        const w = this.canvas.width / dpr;
        const h = this.canvas.height / dpr;
        const pad = this.padding;

        const plotW = w - pad.left - pad.right;
        const plotH = h - pad.top - pad.bottom;

        const clientX = sx / dpr;
        const clientY = sy / dpr;

        const x = Math.max(0.0, Math.min(1.0, (clientX - pad.left) / plotW));
        const yNorm = 1.0 - (clientY - pad.top) / plotH;
        const y = Math.max(this.effect.minY, Math.min(this.effect.maxY, this.effect.minY + yNorm * (this.effect.maxY - this.effect.minY)));
        return { x, y };
    }

    setPlayhead(currentFrame, totalFrames) {
        if (!totalFrames || totalFrames <= 1) {
            this.playheadT = 0.0;
        } else {
            this.playheadT = Math.max(0.0, Math.min(1.0, currentFrame / (totalFrames - 1)));
        }
        this.draw();

        if (this.effect) {
            const curVal = this.effect.evaluate(this.playheadT);
            const lblVal = document.getElementById('lbl-curve-current-val');
            if (lblVal) {
                if (this.effect.minY === 0.0 && this.effect.maxY === 1.0) {
                    lblVal.textContent = `${Math.round(curVal * 100)}% (${curVal.toFixed(2)})`;
                } else {
                    lblVal.textContent = curVal.toFixed(2) + 'x';
                }
            }
        }
        const lblNeedle = document.getElementById('lbl-curve-needle');
        if (lblNeedle) lblNeedle.textContent = `F: ${currentFrame + 1} / ${totalFrames}`;
    }

    draw() {
        if (!this.canvas || !this.ctx || !this.effect) return;
        const ctx = this.ctx;
        const dpr = window.devicePixelRatio || 1;
        const w = this.canvas.width;
        const h = this.canvas.height;

        ctx.clearRect(0, 0, w, h);

        const isEmissive = (this.effect.type === 'emissive_over_time' || (this.effect.minY === 0.0 && this.effect.maxY === 1.0));
        const isScale = (this.effect.type === 'scale_over_time');

        let strokeColor = '#06b6d4';
        let gradColorStart = 'rgba(6, 182, 212, 0.22)';
        let gradColorEnd = 'rgba(6, 182, 212, 0.01)';
        let pointHoverColor = '#38bdf8';
        let pointBorderColor = '#0891b2';

        if (isEmissive) {
            strokeColor = '#f59e0b';
            gradColorStart = 'rgba(245, 158, 11, 0.28)';
            gradColorEnd = 'rgba(245, 158, 11, 0.01)';
            pointHoverColor = '#fde68a';
            pointBorderColor = '#d97706';
        } else if (isScale) {
            strokeColor = '#10b981';
            gradColorStart = 'rgba(16, 185, 129, 0.22)';
            gradColorEnd = 'rgba(16, 185, 129, 0.01)';
            pointHoverColor = '#6ee7b7';
            pointBorderColor = '#059669';
        }

        // 1. Grid lines and labels
        ctx.lineWidth = 1 * dpr;
        ctx.font = `${Math.round(10 * dpr)}px 'JetBrains Mono', monospace`;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';

        const guideValues = isEmissive ? [0.0, 0.5, 1.0] : [0.2, 1.0, 2.0];
        for (const gv of guideValues) {
            const p = this.worldToScreen(0, gv);
            const isBase = isEmissive ? (gv === 1.0 || gv === 0.0) : (gv === 1.0);

            ctx.strokeStyle = isBase ? (isEmissive ? 'rgba(245, 158, 11, 0.35)' : 'rgba(6, 182, 212, 0.35)') : 'rgba(255, 255, 255, 0.07)';
            ctx.setLineDash(isBase ? [3 * dpr, 3 * dpr] : []);
            ctx.beginPath();
            ctx.moveTo(this.padding.left * dpr, p.y);
            ctx.lineTo(w - this.padding.right * dpr, p.y);
            ctx.stroke();

            const lblText = isEmissive ? `${Math.round(gv * 100)}%` : `${gv.toFixed(1)}x`;
            ctx.fillText(lblText, 2 * dpr, p.y + 3 * dpr);
        }
        ctx.setLineDash([]);

        // 2. Sample and draw smooth curve path
        const samples = 80;
        const pathPoints = [];
        for (let j = 0; j <= samples; j++) {
            const t = j / samples;
            const y = this.effect.evaluate(t);
            pathPoints.push(this.worldToScreen(t, y));
        }

        // Fill area under curve
        const bottomPt = this.worldToScreen(0, this.effect.minY).y;
        const grad = ctx.createLinearGradient(0, this.worldToScreen(0, this.effect.maxY).y, 0, bottomPt);
        grad.addColorStop(0, gradColorStart);
        grad.addColorStop(1, gradColorEnd);

        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(pathPoints[0].x, bottomPt);
        for (let j = 0; j <= samples; j++) {
            ctx.lineTo(pathPoints[j].x, pathPoints[j].y);
        }
        ctx.lineTo(pathPoints[samples].x, bottomPt);
        ctx.closePath();
        ctx.fill();

        // Stroke curve line
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = 2.0 * dpr;
        ctx.shadowColor = strokeColor;
        ctx.shadowBlur = 5 * dpr;
        ctx.beginPath();
        for (let j = 0; j <= samples; j++) {
            if (j === 0) ctx.moveTo(pathPoints[j].x, pathPoints[j].y);
            else ctx.lineTo(pathPoints[j].x, pathPoints[j].y);
        }
        ctx.stroke();
        ctx.shadowBlur = 0;

        // 3. Playhead needle
        if (this.playheadT !== undefined) {
            const playScreen = this.worldToScreen(this.playheadT, this.effect.minY);
            ctx.strokeStyle = isEmissive ? '#fbbf24' : '#f59e0b';
            ctx.lineWidth = 1.4 * dpr;
            ctx.setLineDash([3 * dpr, 2 * dpr]);
            ctx.beginPath();
            ctx.moveTo(playScreen.x, this.padding.top * dpr);
            ctx.lineTo(playScreen.x, bottomPt);
            ctx.stroke();
            ctx.setLineDash([]);

            // Marker diamond on curve
            const curY = this.effect.evaluate(this.playheadT);
            const playHeadPos = this.worldToScreen(this.playheadT, curY);
            ctx.fillStyle = isEmissive ? '#fbbf24' : '#f59e0b';
            ctx.beginPath();
            ctx.arc(playHeadPos.x, playHeadPos.y, 3.2 * dpr, 0, Math.PI * 2);
            ctx.fill();
        }

        // 4. Control point handles
        const pts = this.effect.points;
        for (let k = 0; k < pts.length; k++) {
            const pt = pts[k];
            const sp = this.worldToScreen(pt.x, pt.y);
            const isHover = (this.hoveredPoint === k || this.draggingPoint === k);

            ctx.fillStyle = isHover ? pointHoverColor : '#ffffff';
            ctx.strokeStyle = isHover ? '#ffffff' : pointBorderColor;
            ctx.lineWidth = (isHover ? 2.4 : 1.6) * dpr;

            ctx.beginPath();
            ctx.arc(sp.x, sp.y, (isHover ? 5.2 : 4.0) * dpr, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }
    }

    initEvents() {
        const canvas = this.canvas;
        if (!canvas) return;

        const getPos = (e) => {
            const rect = canvas.getBoundingClientRect();
            const clientX = (e.touches && e.touches.length > 0) ? e.touches[0].clientX : e.clientX;
            const clientY = (e.touches && e.touches.length > 0) ? e.touches[0].clientY : e.clientY;
            const dpr = window.devicePixelRatio || 1;
            const sx = (clientX - rect.left) * dpr;
            const sy = (clientY - rect.top) * dpr;
            return { sx, sy, world: this.screenToWorld(sx, sy) };
        };

        const findPointNear = (sx, sy, maxDistPx = 14) => {
            if (!this.effect) return -1;
            const dpr = window.devicePixelRatio || 1;
            const pts = this.effect.points;
            for (let i = 0; i < pts.length; i++) {
                const sp = this.worldToScreen(pts[i].x, pts[i].y);
                const dist = Math.hypot(sp.x - sx, sp.y - sy) / dpr;
                if (dist <= maxDistPx) return i;
            }
            return -1;
        };

        canvas.addEventListener('mousemove', (e) => {
            if (!this.effect) return;
            const pos = getPos(e);
            if (this.draggingPoint >= 0) {
                const idx = this.draggingPoint;
                const pts = this.effect.points;
                if (idx === 0) {
                    pts[0].y = pos.world.y;
                } else if (idx === pts.length - 1) {
                    pts[idx].y = pos.world.y;
                } else {
                    const minX = pts[idx - 1].x + 0.02;
                    const maxX = pts[idx + 1].x - 0.02;
                    pts[idx].x = Math.max(minX, Math.min(maxX, pos.world.x));
                    pts[idx].y = pos.world.y;
                }
                this.draw();
                if (this.onPointChange) this.onPointChange();
            } else {
                const near = findPointNear(pos.sx, pos.sy);
                if (near !== this.hoveredPoint) {
                    this.hoveredPoint = near;
                    canvas.style.cursor = (near >= 0) ? 'pointer' : 'crosshair';
                    this.draw();
                }
            }
        });

        canvas.addEventListener('mousedown', (e) => {
            if (!this.effect) return;
            const pos = getPos(e);
            const near = findPointNear(pos.sx, pos.sy);
            const pts = this.effect.points;

            if ((e.shiftKey || e.altKey) && near > 0 && near < pts.length - 1) {
                pts.splice(near, 1);
                this.hoveredPoint = -1;
                this.draggingPoint = -1;
                this.draw();
                if (this.onPointChange) this.onPointChange();
                return;
            }

            if (near >= 0) {
                this.draggingPoint = near;
            } else {
                if (pts.length < 8 && pos.world.x > 0.02 && pos.world.x < 0.98) {
                    pts.push({ x: pos.world.x, y: pos.world.y });
                    this.effect.sortPoints();
                    this.draggingPoint = pts.findIndex(p => Math.abs(p.x - pos.world.x) < 0.001);
                    this.draw();
                    if (this.onPointChange) this.onPointChange();
                }
            }
        });

        canvas.addEventListener('dblclick', (e) => {
            if (!this.effect) return;
            const pos = getPos(e);
            const near = findPointNear(pos.sx, pos.sy);
            const pts = this.effect.points;
            if (near > 0 && near < pts.length - 1) {
                pts.splice(near, 1);
                this.hoveredPoint = -1;
                this.draggingPoint = -1;
                this.draw();
                if (this.onPointChange) this.onPointChange();
            }
        });

        window.addEventListener('mouseup', () => {
            if (this.draggingPoint >= 0) {
                this.draggingPoint = -1;
                this.draw();
            }
        });
    }
}

/**
 * 4. Main Effects Manager: Multi-effect state, UI binding, and pipeline application
 */
class SplatEffectsManager {
    constructor() {
        this.effects = [];
        this.activeEffectId = null;
        this.isDirty = false;
        this.curveCanvas = null;

        // Callbacks
        this.onApplyNeeded = null;
        this.onGizmoUpdate = null;

        // Add default Height Over Time effect
        const defaultHeight = new HeightOverTimeEffect('height_default');
        this.effects.push(defaultHeight);
        this.activeEffectId = defaultHeight.id;
    }

    getActiveEffects() {
        return this.effects.filter(e => e.enabled);
    }

    getEffect(id) {
        return this.effects.find(e => e.id === id);
    }

    getSelectedEffect() {
        return this.effects.find(e => e.id === this.activeEffectId);
    }

    selectEffect(id) {
        this.activeEffectId = id;
        this.renderUI();
        this.notifyGizmo();
    }

    toggleGizmo(id, event) {
        if (event) event.stopPropagation();
        const eff = this.getEffect(id);
        if (eff) {
            eff.showGizmo = (eff.showGizmo === false) ? true : false;
            this.renderUI();
            this.notifyGizmo();
        }
    }

    addEffect(type) {
        let newEff = null;
        if (type === 'height_over_time') {
            newEff = new HeightOverTimeEffect();
        } else if (type === 'scale_over_time') {
            newEff = new ScaleOverTimeEffect();
        } else if (type === 'emissive_over_time') {
            newEff = new EmissiveOverTimeEffect();
        } else if (type === 'luminance_emissive') {
            newEff = new LuminanceEmissiveEffect();
        } else if (type === 'hsv_mix_tint') {
            newEff = new HsvMixTintEffect();
        } else if (type === 'smooth' || type === 'temporal_smooth') {
            newEff = new SmoothEffect();
        } else if (type === 'spherify') {
            newEff = new SpherifyEffect();
        } else if (type === 'isometric_proxy') {
            newEff = new IsometricProxyEffect();
        } else if (type === 'shaper_in') {
            newEff = new ShaperEffect(null, 'shaper_in');
        } else if (type === 'shaper_out') {
            newEff = new ShaperEffect(null, 'shaper_out');
        }

        if (newEff) {
            this.effects.push(newEff);
            this.activeEffectId = newEff.id;
            this.markDirty();
            this.renderUI();
            this.notifyGizmo();
        }
    }

    removeEffect(id, event) {
        if (event) event.stopPropagation();
        const idx = this.effects.findIndex(e => e.id === id);
        if (idx >= 0) {
            this.effects.splice(idx, 1);
            if (this.activeEffectId === id) {
                this.activeEffectId = (this.effects.length > 0) ? this.effects[0].id : null;
            }
            this.markDirty();
            this.renderUI();
            this.notifyGizmo();
        }
    }

    toggleEffect(id, event) {
        if (event) event.stopPropagation();
        const eff = this.getEffect(id);
        if (eff) {
            eff.enabled = !eff.enabled;
            this.markDirty();
            this.renderUI();
            this.notifyGizmo();
        }
    }

    updateEffectParam(id, param, value) {
        const eff = this.getEffect(id);
        if (eff) {
            eff[param] = value;
            this.markDirty();
            this.notifyGizmo();
        }
    }

    updateEffectPos(id, axis, value) {
        const eff = this.getEffect(id);
        if (eff && eff.position) {
            eff.position[axis] = parseFloat(value) || 0.0;
            this.markDirty();
            this.notifyGizmo();
        }
    }

    updateEffectScale(id, axis, value) {
        const eff = this.getEffect(id);
        if (eff) {
            if (!eff.scale) eff.scale = { x: 1.0, y: 1.0, z: 1.0 };
            eff.scale[axis] = Math.max(0.01, parseFloat(value) || 1.0);
            this.markDirty();
            this.notifyGizmo();
        }
    }

    updateEffectTiming(id, val01) {
        const eff = this.getEffect(id);
        if (eff) {
            if (eff.type === 'shaper_out') {
                eff.timeStart = Math.max(0.05, Math.min(0.95, val01));
            } else {
                eff.timeEnd = Math.max(0.05, Math.min(0.95, val01));
            }
            this.markDirty();
            this.notifyGizmo();
        }
    }

    markDirty() {
        this.isDirty = true;
        if (typeof document === 'undefined') return;
        const statusEl = document.getElementById('lbl-effects-status');
        if (statusEl) {
            statusEl.textContent = "● Unapplied changes";
            statusEl.style.color = "#f59e0b";
        }
        const btnApply = document.getElementById('btn-apply-effects');
        if (btnApply) {
            btnApply.classList.add('pulse-highlight');
        }
    }

    clearDirty() {
        this.isDirty = false;
        if (typeof document === 'undefined') return;
        const statusEl = document.getElementById('lbl-effects-status');
        if (statusEl) {
            statusEl.textContent = "✓ Up to date";
            statusEl.style.color = "#10b981";
        }
        const btnApply = document.getElementById('btn-apply-effects');
        if (btnApply) {
            btnApply.classList.remove('pulse-highlight');
        }
    }

    notifyGizmo() {
        if (this.onGizmoUpdate) {
            this.onGizmoUpdate(this.getSelectedEffect());
        }
        if (typeof viewer3D !== 'undefined' && viewer3D && viewer3D.pipeline && viewer3D.splatGeometry) {
            viewer3D.updateToFrame(viewer3D.currentFrame);
        }
    }

    /**
     * Apply all enabled effects to the SplatBakingPipeline data
     */
    applyToPipeline(pipeline) {
        if (!pipeline || !pipeline.raw3D) return;
        pipeline.applyEffects(this);
        this.clearDirty();
    }

    /**
     * Render the 30% / 70% UI layout
     */
    renderUI() {
        if (typeof document === 'undefined') return;
        const listEl = document.getElementById('effects-items-list');
        const detailEl = document.getElementById('effects-detail-col');
        if (!listEl || !detailEl) return;

        // 1. Render Left List (30%)
        listEl.innerHTML = '';
        if (this.effects.length === 0) {
            listEl.innerHTML = `
                <div style="padding: 12px; text-align: center; color: #64748b; font-size: 0.73rem;">
                    No active effects.<br>Click <b>+ Add</b> above.
                </div>
            `;
        } else {
            this.effects.forEach(eff => {
                const isSelected = (eff.id === this.activeEffectId);
                const item = document.createElement('div');
                item.className = `effect-item-card ${isSelected ? 'active' : ''} ${!eff.enabled ? 'disabled' : ''}`;
                item.onclick = () => this.selectEffect(eff.id);

                let icon = '📈';
                if (eff.type === 'scale_over_time') icon = '📏';
                else if (eff.type === 'emissive_over_time') icon = '🔥';
                else if (eff.type === 'luminance_emissive') icon = '✨';
                else if (eff.type === 'hsv_mix_tint') icon = '🎨';
                else if (eff.type === 'smooth' || eff.type === 'temporal_smooth') icon = '🌊';
                else if (eff.type === 'spherify') icon = '🌐';
                else if (eff.type === 'isometric_proxy') icon = '📦';
                else if (eff.type === 'shaper_in') icon = '💥';
                else if (eff.type === 'shaper_out') icon = '💫';

                const isGizmoVisible = (eff.showGizmo !== false);
                const eyeSvg = isGizmoVisible
                    ? `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`
                    : `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

                item.innerHTML = `
                    <input type="checkbox" ${eff.enabled ? 'checked' : ''} title="${eff.enabled ? 'Disable calculation' : 'Enable calculation'}" onclick="effectsManager.toggleEffect('${eff.id}', event)">
                    <button class="effect-item-eye ${!isGizmoVisible ? 'hidden-gizmo' : ''}" title="${isGizmoVisible ? 'Masquer la vue 3D de cet effet' : 'Afficher la vue 3D de cet effet'}" onclick="effectsManager.toggleGizmo('${eff.id}', event)">
                        ${eyeSvg}
                    </button>
                    <div class="effect-item-info">
                        <div class="effect-item-title">${icon} ${eff.name}</div>
                        <div class="effect-item-subtitle">${eff.getSummary()}</div>
                    </div>
                    <button class="effect-item-del" title="Delete this effect" onclick="effectsManager.removeEffect('${eff.id}', event)">✕</button>
                `;
                listEl.appendChild(item);
            });
        }

        // 2. Render Right Details (70%)
        const selected = this.getSelectedEffect();
        if (!selected) {
            detailEl.innerHTML = `
                <div style="flex:1; display:flex; align-items:center; justify-content:center; color:#64748b; font-size:0.78rem;">
                    Select an effect in the list on the left to configure its parameters.
                </div>
            `;
            return;
        }

        if (selected.type === 'height_over_time' || selected.type === 'scale_over_time' || selected.type === 'emissive_over_time') {
            const isHeight = (selected.type === 'height_over_time');
            const isScale = (selected.type === 'scale_over_time');
            const isEmissive = (selected.type === 'emissive_over_time');
            
            let headerTitle = '📈 Height over time';
            let headerColor = '#38bdf8';
            let defaultValDisplay = '1.00x';
            let infoSubtext = 'Click: add • Drag: move • Dbl-click: del • Scale: 0.2x to 2.5x';

            if (isScale) {
                headerTitle = '📏 Scale over time (Radial Distance)';
                headerColor = '#34d399';
            } else if (isEmissive) {
                headerTitle = '🔥 Emissive over time (Timeline 0.0 - 1.0)';
                headerColor = '#f59e0b';
                defaultValDisplay = '100% (1.00)';
                infoSubtext = 'Click: add • Drag: move • Dbl-click: del • Emissive: 0.0 à 1.0 (0% - 100%)';
            }

            let presetsHtml = '';
            if (isEmissive) {
                presetsHtml = `
                    <button class="curve-preset-btn" onclick="effectsManager.getEffect('${selected.id}').setPreset('burst'); effectsManager.curveCanvas.draw(); effectsManager.markDirty();">Burst (1→0)</button>
                    <button class="curve-preset-btn" onclick="effectsManager.getEffect('${selected.id}').setPreset('rise'); effectsManager.curveCanvas.draw(); effectsManager.markDirty();">Rise (0→1)</button>
                    <button class="curve-preset-btn" onclick="effectsManager.getEffect('${selected.id}').setPreset('bell'); effectsManager.curveCanvas.draw(); effectsManager.markDirty();">Flash (Bell)</button>
                    <button class="curve-preset-btn" onclick="effectsManager.getEffect('${selected.id}').setPreset('flat_1'); effectsManager.curveCanvas.draw(); effectsManager.markDirty();">Flat (1.0)</button>
                    <button class="curve-preset-btn" onclick="effectsManager.getEffect('${selected.id}').setPreset('flat_0'); effectsManager.curveCanvas.draw(); effectsManager.markDirty();">Flat (0.0)</button>
                    <button class="curve-preset-btn" style="margin-left: auto;" onclick="effectsManager.getEffect('${selected.id}').reset(); effectsManager.curveCanvas.draw(); effectsManager.markDirty();">Reset</button>
                `;
            } else {
                presetsHtml = `
                    <button class="curve-preset-btn" onclick="effectsManager.getEffect('${selected.id}').setPreset('flat'); effectsManager.curveCanvas.draw(); effectsManager.markDirty();">Flat (1x)</button>
                    <button class="curve-preset-btn" onclick="effectsManager.getEffect('${selected.id}').setPreset('burst'); effectsManager.curveCanvas.draw(); effectsManager.markDirty();">Burst</button>
                    <button class="curve-preset-btn" onclick="effectsManager.getEffect('${selected.id}').setPreset('rise'); effectsManager.curveCanvas.draw(); effectsManager.markDirty();">Rise</button>
                    <button class="curve-preset-btn" onclick="effectsManager.getEffect('${selected.id}').setPreset('fall'); effectsManager.curveCanvas.draw(); effectsManager.markDirty();">Fall</button>
                    <button class="curve-preset-btn" onclick="effectsManager.getEffect('${selected.id}').setPreset('bell'); effectsManager.curveCanvas.draw(); effectsManager.markDirty();">Bell</button>
                    <button class="curve-preset-btn" style="margin-left: auto;" onclick="effectsManager.getEffect('${selected.id}').reset(); effectsManager.curveCanvas.draw(); effectsManager.markDirty();">Reset</button>
                `;
            }

            let axisSelectorHtml = '';
            if (isHeight) {
                const curAxis = selected.axis || 'y';
                axisSelectorHtml = `
                    <div style="display: flex; align-items: center; gap: 4px; margin-left: 6px;">
                        <span style="font-size: 0.70rem; color: #94a3b8; font-weight: 500;">Axe :</span>
                        <select class="control-select-sm" style="width: auto; padding: 1px 4px; font-size: 0.72rem; font-weight: 600; color: #38bdf8; background: #0e1117;" onchange="effectsManager.updateEffectParam('${selected.id}', 'axis', this.value); effectsManager.renderUI();">
                            <option value="y" ${curAxis==='y'?'selected':''}>Y (Hauteur / Height)</option>
                            <option value="z" ${curAxis==='z'?'selected':''}>Z (Profondeur / Depth)</option>
                            <option value="x" ${curAxis==='x'?'selected':''}>X (Largeur / Width)</option>
                            <option value="xyz" ${curAxis==='xyz'?'selected':''}>XYZ (Tous les axes)</option>
                        </select>
                    </div>
                `;
            }

            detailEl.innerHTML = `
                <div class="effect-header-row" style="display: flex; justify-content: space-between; align-items: center; gap: 6px;">
                    <div style="display: flex; align-items: center; gap: 4px;">
                        <span style="font-size: 0.80rem; font-weight: 600; color: ${headerColor};">${headerTitle}</span>
                        ${axisSelectorHtml}
                    </div>
                    <span id="lbl-curve-current-val" style="font-family: 'JetBrains Mono', monospace; font-size: 0.76rem; color: #94a3b8; font-weight: 500;">${defaultValDisplay}</span>
                </div>
                <div class="curve-presets-bar">
                    ${presetsHtml}
                </div>
                <div class="curve-editor-container" id="curve-canvas-wrapper" title="${infoSubtext}">
                    <canvas class="curve-editor-canvas" id="canvas-depth-curve"></canvas>
                </div>
                <div class="curve-info-row">
                    <span>${infoSubtext}</span>
                    <span id="lbl-curve-needle">F: 1 / 0</span>
                </div>
            `;

            // Initialize canvas
            const canvasEl = document.getElementById('canvas-depth-curve');
            if (canvasEl) {
                this.curveCanvas = new HeightOverTimeCanvas(canvasEl, selected, () => {
                    this.markDirty();
                });
            }
        } else if (selected.type === 'luminance_emissive') {
            detailEl.innerHTML = `
                <div class="effect-header-row" style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.06); padding-bottom: 4px;">
                    <span style="font-size: 0.80rem; font-weight: 600; color: #fbbf24;">
                        ✨ Luminance Emissive (Auto Brightness Detection)
                    </span>
                    <span style="font-size: 0.72rem; color: #94a3b8; font-family: 'JetBrains Mono', monospace;">
                        Per-Frame Splat Color
                    </span>
                </div>

                <div class="shaper-params-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px 10px; font-size: 0.74rem;">
                    <!-- Luminance Threshold -->
                    <div class="control-row" style="margin-bottom: 0;">
                        <div class="control-label-group">
                            <span class="control-label">Luminance Threshold:</span>
                            <input type="number" class="control-num-input" value="${Math.round(selected.threshold * 100)}" step="1" min="0" max="100" onchange="effectsManager.updateEffectParam('${selected.id}', 'threshold', parseFloat(this.value)/100); this.closest('.control-row').querySelector('input[type=range]').value=parseFloat(this.value)/100; effectsManager.renderUI();">
                        </div>
                        <input type="range" min="0.0" max="1.0" step="0.01" value="${selected.threshold}" oninput="effectsManager.updateEffectParam('${selected.id}', 'threshold', parseFloat(this.value)); this.closest('.control-row').querySelector('input[type=number]').value=Math.round(parseFloat(this.value)*100);">
                    </div>

                    <!-- Emissive Boost / Intensity -->
                    <div class="control-row" style="margin-bottom: 0;">
                        <div class="control-label-group">
                            <span class="control-label">Emissive Boost:</span>
                            <input type="number" class="control-num-input" value="${selected.intensity}" step="0.1" min="0.0" max="3.0" onchange="effectsManager.updateEffectParam('${selected.id}', 'intensity', parseFloat(this.value)); this.closest('.control-row').querySelector('input[type=range]').value=this.value;">
                        </div>
                        <input type="range" min="0.0" max="3.0" step="0.05" value="${selected.intensity}" oninput="effectsManager.updateEffectParam('${selected.id}', 'intensity', parseFloat(this.value)); this.closest('.control-row').querySelector('input[type=number]').value=parseFloat(this.value).toFixed(1);">
                    </div>

                    <!-- Target Luminance Color / Tint (Default White) -->
                    <div class="control-row" style="margin-bottom: 0;">
                        <span class="control-label">Target Luminance Tint:</span>
                        <div style="display: flex; align-items: center; gap: 6px;">
                            <input type="color" value="${selected.colorFilter || '#ffffff'}" style="width: 28px; height: 22px; padding: 0; border: 1px solid rgba(255,255,255,0.15); border-radius: 3px; background: transparent; cursor: pointer;" onchange="effectsManager.updateEffectParam('${selected.id}', 'colorFilter', this.value)">
                            <button class="btn btn-sm" style="padding: 1px 6px; font-size: 0.68rem;" onclick="effectsManager.updateEffectParam('${selected.id}', 'colorFilter', '#ffffff'); effectsManager.renderUI();">White (Default)</button>
                            <button class="btn btn-sm" style="padding: 1px 6px; font-size: 0.68rem; color: #f59e0b;" onclick="effectsManager.updateEffectParam('${selected.id}', 'colorFilter', '#ff9900'); effectsManager.renderUI();">Fire</button>
                        </div>
                    </div>

                    <!-- Threshold Softness (Knee) -->
                    <div class="control-row" style="margin-bottom: 0;">
                        <div class="control-label-group">
                            <span class="control-label">Threshold Softness:</span>
                            <input type="number" class="control-num-input" value="${Math.round(selected.softness * 100)}" step="1" min="1" max="50" onchange="effectsManager.updateEffectParam('${selected.id}', 'softness', parseFloat(this.value)/100); this.closest('.control-row').querySelector('input[type=range]').value=parseFloat(this.value)/100;">
                        </div>
                        <input type="range" min="0.01" max="0.5" step="0.01" value="${selected.softness}" oninput="effectsManager.updateEffectParam('${selected.id}', 'softness', parseFloat(this.value)); this.closest('.control-row').querySelector('input[type=number]').value=Math.round(parseFloat(this.value)*100);">
                    </div>
                </div>

                <div style="margin-top: 6px; padding: 6px 8px; background: rgba(251, 191, 36, 0.05); border: 1px solid rgba(251, 191, 36, 0.15); border-radius: 4px; font-size: 0.70rem; color: #94a3b8;">
                    💡 <b>Info:</b> Les splats dont la luminance dépasse <b>${Math.round(selected.threshold * 100)}%</b> reçoivent automatiquement un boost d'incandescence (emissive) proportionnel à leur éclat.
                </div>
            `;
        } else if (selected.type === 'hsv_mix_tint') {
            detailEl.innerHTML = `
                <div class="effect-header-row" style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.06); padding-bottom: 4px;">
                    <span style="font-size: 0.80rem; font-weight: 600; color: #c084fc;">
                        🎨 HSV Mix Tint (Color Grading & Blending)
                    </span>
                    <span style="font-size: 0.72rem; color: #94a3b8; font-family: 'JetBrains Mono', monospace;">
                        All Frames & Texture Bake
                    </span>
                </div>

                <div class="shaper-params-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px 10px; font-size: 0.74rem;">
                    <!-- Color Picker + Hex Input -->
                    <div class="control-row" style="margin-bottom: 0;">
                        <span class="control-label">Tint Color:</span>
                        <div style="display: flex; align-items: center; gap: 6px;">
                            <input type="color" value="${selected.color || '#38bdf8'}" style="width: 32px; height: 23px; padding: 0; border: 1px solid rgba(255,255,255,0.18); border-radius: 4px; background: transparent; cursor: pointer;" oninput="effectsManager.updateEffectParam('${selected.id}', 'color', this.value); this.parentElement.querySelector('input[type=text]').value=this.value.toUpperCase();">
                            <input type="text" class="control-num-input" style="width: 68px; text-transform: uppercase; font-family: 'JetBrains Mono', monospace; font-size: 0.70rem;" value="${(selected.color || '#38bdf8').toUpperCase()}" onchange="effectsManager.updateEffectParam('${selected.id}', 'color', this.value); this.parentElement.querySelector('input[type=color]').value=this.value;">
                        </div>
                    </div>

                    <!-- Blend Mode Dropdown -->
                    <div class="control-row" style="margin-bottom: 0;">
                        <span class="control-label">Blend Mode:</span>
                        <select class="control-select-sm" onchange="effectsManager.updateEffectParam('${selected.id}', 'blendMode', this.value); effectsManager.renderUI();">
                            <option value="colorize" ${selected.blendMode==='colorize'?'selected':''}>Colorize (HSV Shading)</option>
                            <option value="mix" ${selected.blendMode==='mix'?'selected':''}>Mix (Normal Blend)</option>
                            <option value="multiply" ${selected.blendMode==='multiply'?'selected':''}>Multiply (Produit)</option>
                            <option value="screen" ${selected.blendMode==='screen'?'selected':''}>Screen (Superposition)</option>
                            <option value="overlay" ${selected.blendMode==='overlay'?'selected':''}>Overlay (Incrustation)</option>
                            <option value="add" ${selected.blendMode==='add'?'selected':''}>Additive (Addition)</option>
                            <option value="soft_light" ${selected.blendMode==='soft_light'?'selected':''}>Soft Light (Lumière douce)</option>
                            <option value="hue_shift" ${selected.blendMode==='hue_shift'?'selected':''}>Hue Shift (Rotation teinte)</option>
                        </select>
                    </div>

                    <!-- Mix Strength % -->
                    <div class="control-row" style="margin-bottom: 0;">
                        <div class="control-label-group">
                            <span class="control-label">Mix % (Strength):</span>
                            <input type="number" class="control-num-input" value="${Math.round((selected.mix !== undefined ? selected.mix : 0.8) * 100)}" step="5" min="0" max="100" onchange="effectsManager.updateEffectParam('${selected.id}', 'mix', parseFloat(this.value)/100); this.closest('.control-row').querySelector('input[type=range]').value=parseFloat(this.value)/100;">
                        </div>
                        <input type="range" min="0.0" max="1.0" step="0.01" value="${selected.mix !== undefined ? selected.mix : 0.8}" oninput="effectsManager.updateEffectParam('${selected.id}', 'mix', parseFloat(this.value)); this.closest('.control-row').querySelector('input[type=number]').value=Math.round(parseFloat(this.value)*100);">
                    </div>

                    <!-- Saturation Boost -->
                    <div class="control-row" style="margin-bottom: 0;">
                        <div class="control-label-group">
                            <span class="control-label">Saturation Boost:</span>
                            <input type="number" class="control-num-input" value="${selected.satBoost !== undefined ? selected.satBoost : 1.0}" step="0.1" min="0.0" max="3.0" onchange="effectsManager.updateEffectParam('${selected.id}', 'satBoost', parseFloat(this.value)); this.closest('.control-row').querySelector('input[type=range]').value=this.value;">
                        </div>
                        <input type="range" min="0.0" max="2.5" step="0.05" value="${selected.satBoost !== undefined ? selected.satBoost : 1.0}" oninput="effectsManager.updateEffectParam('${selected.id}', 'satBoost', parseFloat(this.value)); this.closest('.control-row').querySelector('input[type=number]').value=parseFloat(this.value).toFixed(1);">
                    </div>

                    <!-- Value / Brightness Multiplier -->
                    <div class="control-row" style="margin-bottom: 0;">
                        <div class="control-label-group">
                            <span class="control-label">Brightness Boost:</span>
                            <input type="number" class="control-num-input" value="${selected.valBoost !== undefined ? selected.valBoost : 1.0}" step="0.1" min="0.0" max="2.0" onchange="effectsManager.updateEffectParam('${selected.id}', 'valBoost', parseFloat(this.value)); this.closest('.control-row').querySelector('input[type=range]').value=this.value;">
                        </div>
                        <input type="range" min="0.2" max="2.0" step="0.05" value="${selected.valBoost !== undefined ? selected.valBoost : 1.0}" oninput="effectsManager.updateEffectParam('${selected.id}', 'valBoost', parseFloat(this.value)); this.closest('.control-row').querySelector('input[type=number]').value=parseFloat(this.value).toFixed(1);">
                    </div>
                </div>

                <!-- Presets Bar -->
                <div class="curve-presets-bar" style="margin-top: 6px; padding-top: 4px; border-top: 1px solid rgba(255,255,255,0.06);">
                    <button class="curve-preset-btn" style="color: #00e5ff;" onclick="effectsManager.updateEffectParam('${selected.id}', 'color', '#00e5ff'); effectsManager.updateEffectParam('${selected.id}', 'blendMode', 'colorize'); effectsManager.updateEffectParam('${selected.id}', 'mix', 0.85); effectsManager.renderUI();">⚡ Cyber Cyan</button>
                    <button class="curve-preset-btn" style="color: #ff007f;" onclick="effectsManager.updateEffectParam('${selected.id}', 'color', '#ff007f'); effectsManager.updateEffectParam('${selected.id}', 'blendMode', 'colorize'); effectsManager.updateEffectParam('${selected.id}', 'mix', 0.85); effectsManager.renderUI();">🌸 Neon Pink</button>
                    <button class="curve-preset-btn" style="color: #ff9900;" onclick="effectsManager.updateEffectParam('${selected.id}', 'color', '#ff9900'); effectsManager.updateEffectParam('${selected.id}', 'blendMode', 'overlay'); effectsManager.updateEffectParam('${selected.id}', 'mix', 0.75); effectsManager.renderUI();">🔥 Amber Gold</button>
                    <button class="curve-preset-btn" style="color: #00ff66;" onclick="effectsManager.updateEffectParam('${selected.id}', 'color', '#00ff66'); effectsManager.updateEffectParam('${selected.id}', 'blendMode', 'colorize'); effectsManager.updateEffectParam('${selected.id}', 'mix', 0.90); effectsManager.renderUI();">🧪 Matrix Green</button>
                    <button class="curve-preset-btn" style="color: #a855f7;" onclick="effectsManager.updateEffectParam('${selected.id}', 'color', '#8b5cf6'); effectsManager.updateEffectParam('${selected.id}', 'blendMode', 'multiply'); effectsManager.updateEffectParam('${selected.id}', 'mix', 0.70); effectsManager.renderUI();">🔮 Deep Violet</button>
                    <button class="curve-preset-btn" style="margin-left: auto;" onclick="effectsManager.updateEffectParam('${selected.id}', 'color', '#38bdf8'); effectsManager.updateEffectParam('${selected.id}', 'blendMode', 'colorize'); effectsManager.updateEffectParam('${selected.id}', 'mix', 0.0); effectsManager.renderUI();">Reset (0%)</button>
                </div>

                <div style="margin-top: 6px; padding: 6px 8px; background: rgba(192, 132, 252, 0.06); border: 1px solid rgba(192, 132, 252, 0.18); border-radius: 4px; font-size: 0.70rem; color: #94a3b8;">
                    🎨 <b>Info:</b> La teinte HSV modifie dynamiquement la couleur des splats dans le viewport 3D et sera directement incrustée dans la texture VAT <code>_ColorTex</code> lors du bake.
                </div>
            `;
        } else if (selected.type === 'smooth' || selected.type === 'temporal_smooth') {
            detailEl.innerHTML = `
                <div class="effect-header-row" style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.06); padding-bottom: 4px;">
                    <span style="font-size: 0.80rem; font-weight: 600; color: #38bdf8;">
                        🌊 Temporal Smooth (Position Anti-Stutter & Anti-Jitter)
                    </span>
                    <span style="font-size: 0.72rem; color: #94a3b8; font-family: 'JetBrains Mono', monospace;">
                        Multi-Frame Window Filter
                    </span>
                </div>

                <div class="shaper-params-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px 10px; font-size: 0.74rem;">
                    <!-- Frame Window Size -->
                    <div class="control-row" style="margin-bottom: 0;">
                        <div class="control-label-group">
                            <span class="control-label">Smooth Window (Frames):</span>
                            <input type="number" class="control-num-input" value="${selected.frames || 5}" step="1" min="1" max="15" onchange="effectsManager.updateEffectParam('${selected.id}', 'frames', parseInt(this.value)); this.closest('.control-row').querySelector('input[type=range]').value=this.value;">
                        </div>
                        <input type="range" min="1" max="15" step="1" value="${selected.frames || 5}" oninput="effectsManager.updateEffectParam('${selected.id}', 'frames', parseInt(this.value)); this.closest('.control-row').querySelector('input[type=number]').value=this.value;">
                    </div>

                    <!-- Filter Kernel / Algorithm -->
                    <div class="control-row" style="margin-bottom: 0;">
                        <span class="control-label">Filter Algorithm:</span>
                        <select class="control-select-sm" onchange="effectsManager.updateEffectParam('${selected.id}', 'kernel', this.value); effectsManager.renderUI();">
                            <option value="gaussian" ${selected.kernel==='gaussian'?'selected':''}>Gaussian (Smooth & Natural)</option>
                            <option value="exponential" ${selected.kernel==='exponential'?'selected':''}>Bidirectional EMA (Zero Lag)</option>
                            <option value="moving_average" ${selected.kernel==='moving_average'?'selected':''}>Box Average (Uniform Window)</option>
                        </select>
                    </div>

                    <!-- Strength % -->
                    <div class="control-row" style="margin-bottom: 0;">
                        <div class="control-label-group">
                            <span class="control-label">Smoothing Strength:</span>
                            <input type="number" class="control-num-input" value="${Math.round((selected.strength !== undefined ? selected.strength : 1.0) * 100)}" step="5" min="0" max="100" onchange="effectsManager.updateEffectParam('${selected.id}', 'strength', parseFloat(this.value)/100); this.closest('.control-row').querySelector('input[type=range]').value=parseFloat(this.value)/100;">
                        </div>
                        <input type="range" min="0.0" max="1.0" step="0.01" value="${selected.strength !== undefined ? selected.strength : 1.0}" oninput="effectsManager.updateEffectParam('${selected.id}', 'strength', parseFloat(this.value)); this.closest('.control-row').querySelector('input[type=number]').value=Math.round(parseFloat(this.value)*100);">
                    </div>

                    <!-- Target Axes -->
                    <div class="control-row" style="margin-bottom: 0;">
                        <span class="control-label">Target Axes:</span>
                        <select class="control-select-sm" onchange="effectsManager.updateEffectParam('${selected.id}', 'axis', this.value); effectsManager.renderUI();">
                            <option value="xyz" ${selected.axis==='xyz'?'selected':''}>XYZ (All 3D Axes)</option>
                            <option value="z" ${selected.axis==='z'?'selected':''}>Z Only (Depth / Relief Noise)</option>
                            <option value="xy" ${selected.axis==='xy'?'selected':''}>XY Only (Screen Plane)</option>
                            <option value="y" ${selected.axis==='y'?'selected':''}>Y Only (Height)</option>
                            <option value="x" ${selected.axis==='x'?'selected':''}>X Only (Width)</option>
                        </select>
                    </div>
                </div>

                <!-- Presets Bar -->
                <div class="curve-presets-bar" style="margin-top: 6px; padding-top: 4px; border-top: 1px solid rgba(255,255,255,0.06);">
                    <button class="curve-preset-btn" onclick="effectsManager.updateEffectParam('${selected.id}', 'frames', 3); effectsManager.updateEffectParam('${selected.id}', 'kernel', 'gaussian'); effectsManager.updateEffectParam('${selected.id}', 'strength', 0.70); effectsManager.updateEffectParam('${selected.id}', 'axis', 'xyz'); effectsManager.renderUI();">Subtle (3F)</button>
                    <button class="curve-preset-btn" onclick="effectsManager.updateEffectParam('${selected.id}', 'frames', 5); effectsManager.updateEffectParam('${selected.id}', 'kernel', 'gaussian'); effectsManager.updateEffectParam('${selected.id}', 'strength', 1.00); effectsManager.updateEffectParam('${selected.id}', 'axis', 'xyz'); effectsManager.renderUI();">Balanced (5F)</button>
                    <button class="curve-preset-btn" onclick="effectsManager.updateEffectParam('${selected.id}', 'frames', 7); effectsManager.updateEffectParam('${selected.id}', 'kernel', 'gaussian'); effectsManager.updateEffectParam('${selected.id}', 'strength', 1.00); effectsManager.updateEffectParam('${selected.id}', 'axis', 'xyz'); effectsManager.renderUI();">Strong (7F)</button>
                    <button class="curve-preset-btn" onclick="effectsManager.updateEffectParam('${selected.id}', 'frames', 5); effectsManager.updateEffectParam('${selected.id}', 'kernel', 'gaussian'); effectsManager.updateEffectParam('${selected.id}', 'strength', 1.00); effectsManager.updateEffectParam('${selected.id}', 'axis', 'z'); effectsManager.renderUI();">Z Depth Only</button>
                    <button class="curve-preset-btn" onclick="effectsManager.updateEffectParam('${selected.id}', 'frames', 7); effectsManager.updateEffectParam('${selected.id}', 'kernel', 'exponential'); effectsManager.updateEffectParam('${selected.id}', 'strength', 1.00); effectsManager.updateEffectParam('${selected.id}', 'axis', 'xyz'); effectsManager.renderUI();">Flow (EMA)</button>
                    <button class="curve-preset-btn" style="margin-left: auto;" onclick="effectsManager.updateEffectParam('${selected.id}', 'strength', 0.0); effectsManager.renderUI();">Off (0%)</button>
                </div>

                <div style="margin-top: 6px; padding: 6px 8px; background: rgba(56, 189, 248, 0.06); border: 1px solid rgba(56, 189, 248, 0.18); border-radius: 4px; font-size: 0.70rem; color: #94a3b8;">
                    🌊 <b>Info:</b> Lisse les trajectoires 3D de chaque splat le long de la timeline sur une fenêtre temporelle glissante de <b>${selected.frames || 5} frames</b> pour éliminer tout stuttering / sautillement.
                </div>
            `;
        } else if (selected.type === 'spherify') {
            detailEl.innerHTML = `
                <div class="effect-header-row" style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.06); padding-bottom: 4px;">
                    <span style="font-size: 0.80rem; font-weight: 600; color: #38bdf8;">
                        🌐 Spherify (Dome & Sphere Surface Projection)
                    </span>
                    <span style="font-size: 0.72rem; color: #94a3b8; font-family: 'JetBrains Mono', monospace;">
                        Entire Animation (100%)
                    </span>
                </div>

                <div class="shaper-params-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 5px 10px; font-size: 0.74rem;">
                    <!-- Radius & Mode -->
                    <div class="control-row" style="margin-bottom: 0;">
                        <div class="control-label-group">
                            <span class="control-label">Radius:</span>
                            <input type="number" class="control-num-input" value="${selected.radius}" step="0.05" min="0.1" max="15.0" onchange="effectsManager.updateEffectParam('${selected.id}', 'radius', parseFloat(this.value)); this.closest('.control-row').querySelector('input[type=range]').value=this.value;">
                        </div>
                        <input type="range" min="0.1" max="8.0" step="0.05" value="${selected.radius}" oninput="effectsManager.updateEffectParam('${selected.id}', 'radius', parseFloat(this.value)); this.closest('.control-row').querySelector('input[type=number]').value=this.value;">
                    </div>
                    <div class="control-row" style="margin-bottom: 0;">
                        <span class="control-label">Projection Mode:</span>
                        <select class="control-select-sm" onchange="effectsManager.updateEffectParam('${selected.id}', 'mode', this.value)">
                            <option value="dome" ${selected.mode==='dome'?'selected':''}>Dome Height (Relief Projection)</option>
                            <option value="polar_wrap" ${selected.mode==='polar_wrap'?'selected':''}>Polar Wrap (Uniform Hemisphere)</option>
                            <option value="radial" ${selected.mode==='radial'?'selected':''}>Radial 3D (Sphere Cast)</option>
                        </select>
                    </div>

                    <!-- Curvature & Conform Strength (Default 50%) -->
                    <div class="control-row" style="margin-bottom: 0;">
                        <span class="control-label">Curvature:</span>
                        <select class="control-select-sm" onchange="effectsManager.updateEffectParam('${selected.id}', 'curvature', this.value)">
                            <option value="convex" ${selected.curvature==='convex'?'selected':''}>Convex (+ Dome / Bulge Outward)</option>
                            <option value="concave" ${selected.curvature==='concave'?'selected':''}>Concave (- Bowl / Inverted)</option>
                        </select>
                    </div>
                    <div class="control-row" style="margin-bottom: 0;">
                        <div class="control-label-group">
                            <span class="control-label">Conform Strength:</span>
                            <input type="number" class="control-num-input" value="${Math.round((selected.strength !== undefined ? selected.strength : 0.5) * 100)}" step="5" min="0" max="100" onchange="effectsManager.updateEffectParam('${selected.id}', 'strength', parseFloat(this.value)/100); this.closest('.control-row').querySelector('input[type=range]').value=parseFloat(this.value)/100;">
                        </div>
                        <input type="range" min="0" max="1" step="0.01" value="${selected.strength !== undefined ? selected.strength : 0.5}" oninput="effectsManager.updateEffectParam('${selected.id}', 'strength', parseFloat(this.value)); this.closest('.control-row').querySelector('input[type=number]').value=Math.round(parseFloat(this.value)*100);">
                    </div>

                    <!-- Scale 3D (X, Y, Z) - Compact on single line -->
                    <div class="control-row" style="grid-column: span 2; margin-bottom: 0;">
                        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 2px;">
                            <span class="control-label">3D Scale (X, Y, Z):</span>
                            <button class="btn btn-sm" style="padding: 0 4px; font-size: 0.65rem; line-height: 1.2;" onclick="effectsManager.updateEffectScale('${selected.id}', 'x', 1.0); effectsManager.updateEffectScale('${selected.id}', 'y', 1.0); effectsManager.updateEffectScale('${selected.id}', 'z', 1.0); effectsManager.renderUI();">Reset (1.0)</button>
                        </div>
                        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; align-items: center;">
                            <div style="display: flex; align-items: center; gap: 3px;">
                                <span style="color: #ef4444; font-weight: bold; font-size: 0.70rem; width: 10px;">X</span>
                                <input type="number" class="control-num-input" style="width: 36px; padding: 1px 2px; font-size: 0.70rem;" value="${(selected.scale ? selected.scale.x : 1.0).toFixed(2)}" step="0.05" min="0.1" max="5.0" onchange="effectsManager.updateEffectScale('${selected.id}', 'x', this.value); this.parentElement.querySelector('input[type=range]').value=this.value;">
                                <input type="range" style="flex: 1; min-width: 0;" min="0.1" max="3.0" step="0.05" value="${selected.scale ? selected.scale.x : 1.0}" oninput="effectsManager.updateEffectScale('${selected.id}', 'x', this.value); this.parentElement.querySelector('input[type=number]').value=parseFloat(this.value).toFixed(2);">
                            </div>
                            <div style="display: flex; align-items: center; gap: 3px;">
                                <span style="color: #10b981; font-weight: bold; font-size: 0.70rem; width: 10px;">Y</span>
                                <input type="number" class="control-num-input" style="width: 36px; padding: 1px 2px; font-size: 0.70rem;" value="${(selected.scale ? selected.scale.y : 1.0).toFixed(2)}" step="0.05" min="0.1" max="5.0" onchange="effectsManager.updateEffectScale('${selected.id}', 'y', this.value); this.parentElement.querySelector('input[type=range]').value=this.value;">
                                <input type="range" style="flex: 1; min-width: 0;" min="0.1" max="3.0" step="0.05" value="${selected.scale ? selected.scale.y : 1.0}" oninput="effectsManager.updateEffectScale('${selected.id}', 'y', this.value); this.parentElement.querySelector('input[type=number]').value=parseFloat(this.value).toFixed(2);">
                            </div>
                            <div style="display: flex; align-items: center; gap: 3px;">
                                <span style="color: #3b82f6; font-weight: bold; font-size: 0.70rem; width: 10px;">Z</span>
                                <input type="number" class="control-num-input" style="width: 36px; padding: 1px 2px; font-size: 0.70rem;" value="${(selected.scale ? selected.scale.z : 1.0).toFixed(2)}" step="0.05" min="0.1" max="5.0" onchange="effectsManager.updateEffectScale('${selected.id}', 'z', this.value); this.parentElement.querySelector('input[type=range]').value=this.value;">
                                <input type="range" style="flex: 1; min-width: 0;" min="0.1" max="3.0" step="0.05" value="${selected.scale ? selected.scale.z : 1.0}" oninput="effectsManager.updateEffectScale('${selected.id}', 'z', this.value); this.parentElement.querySelector('input[type=number]').value=parseFloat(this.value).toFixed(2);">
                            </div>
                        </div>
                    </div>

                    <!-- Position 3D (X, Y, Z) - Compact on single line -->
                    <div class="control-row" style="grid-column: span 2; margin-bottom: 0;">
                        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 2px;">
                            <span class="control-label">3D Center (Position):</span>
                            <button class="btn btn-sm" style="padding: 0 4px; font-size: 0.65rem; line-height: 1.2;" onclick="effectsManager.updateEffectPos('${selected.id}', 'x', 0); effectsManager.updateEffectPos('${selected.id}', 'y', 0); effectsManager.updateEffectPos('${selected.id}', 'z', 0); effectsManager.renderUI();">Reset (0,0,0)</button>
                        </div>
                        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; align-items: center;">
                            <div style="display: flex; align-items: center; gap: 3px;">
                                <span style="color: #ef4444; font-weight: bold; font-size: 0.70rem; width: 10px;">X</span>
                                <input type="number" class="control-num-input" style="width: 36px; padding: 1px 2px; font-size: 0.70rem;" value="${selected.position.x.toFixed(2)}" step="0.05" onchange="effectsManager.updateEffectPos('${selected.id}', 'x', this.value); this.parentElement.querySelector('input[type=range]').value=this.value;">
                                <input type="range" style="flex: 1; min-width: 0;" min="-3.0" max="3.0" step="0.05" value="${selected.position.x}" oninput="effectsManager.updateEffectPos('${selected.id}', 'x', this.value); this.parentElement.querySelector('input[type=number]').value=parseFloat(this.value).toFixed(2);">
                            </div>
                            <div style="display: flex; align-items: center; gap: 3px;">
                                <span style="color: #10b981; font-weight: bold; font-size: 0.70rem; width: 10px;">Y</span>
                                <input type="number" class="control-num-input" style="width: 36px; padding: 1px 2px; font-size: 0.70rem;" value="${selected.position.y.toFixed(2)}" step="0.05" onchange="effectsManager.updateEffectPos('${selected.id}', 'y', this.value); this.parentElement.querySelector('input[type=range]').value=this.value;">
                                <input type="range" style="flex: 1; min-width: 0;" min="-3.0" max="3.0" step="0.05" value="${selected.position.y}" oninput="effectsManager.updateEffectPos('${selected.id}', 'y', this.value); this.parentElement.querySelector('input[type=number]').value=parseFloat(this.value).toFixed(2);">
                            </div>
                            <div style="display: flex; align-items: center; gap: 3px;">
                                <span style="color: #3b82f6; font-weight: bold; font-size: 0.70rem; width: 10px;">Z</span>
                                <input type="number" class="control-num-input" style="width: 36px; padding: 1px 2px; font-size: 0.70rem;" value="${selected.position.z.toFixed(2)}" step="0.05" onchange="effectsManager.updateEffectPos('${selected.id}', 'z', this.value); this.parentElement.querySelector('input[type=range]').value=this.value;">
                                <input type="range" style="flex: 1; min-width: 0;" min="-3.0" max="3.0" step="0.05" value="${selected.position.z}" oninput="effectsManager.updateEffectPos('${selected.id}', 'z', this.value); this.parentElement.querySelector('input[type=number]').value=parseFloat(this.value).toFixed(2);">
                            </div>
                        </div>
                    </div>
                </div>
            `;
        } else if (selected.type === 'isometric_proxy') {
            detailEl.innerHTML = `
                <div class="effect-header-row" style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.06); padding-bottom: 4px;">
                    <span style="font-size: 0.80rem; font-weight: 600; color: #38bdf8;">
                        📦 Isometric Box Proxy (Beveled Octagonal Dome)
                    </span>
                    <span style="font-size: 0.72rem; color: #94a3b8; font-family: 'JetBrains Mono', monospace;">
                        Blender Proxy Volume
                    </span>
                </div>

                <div class="shaper-params-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 5px 10px; font-size: 0.74rem;">
                    <!-- Width & Total Height -->
                    <div class="control-row" style="margin-bottom: 0;">
                        <div class="control-label-group">
                            <span class="control-label">Width (Size):</span>
                            <input type="number" class="control-num-input" value="${selected.width}" step="0.05" min="0.1" max="8.0" onchange="effectsManager.updateEffectParam('${selected.id}', 'width', parseFloat(this.value)); this.closest('.control-row').querySelector('input[type=range]').value=this.value;">
                        </div>
                        <input type="range" min="0.1" max="8.0" step="0.05" value="${selected.width}" oninput="effectsManager.updateEffectParam('${selected.id}', 'width', parseFloat(this.value)); this.closest('.control-row').querySelector('input[type=number]').value=this.value;">
                    </div>
                    <div class="control-row" style="margin-bottom: 0;">
                        <div class="control-label-group">
                            <span class="control-label">Total Height:</span>
                            <input type="number" class="control-num-input" value="${selected.height}" step="0.05" min="0.1" max="8.0" onchange="effectsManager.updateEffectParam('${selected.id}', 'height', parseFloat(this.value)); this.closest('.control-row').querySelector('input[type=range]').value=this.value;">
                        </div>
                        <input type="range" min="0.1" max="8.0" step="0.05" value="${selected.height}" oninput="effectsManager.updateEffectParam('${selected.id}', 'height', parseFloat(this.value)); this.closest('.control-row').querySelector('input[type=number]').value=this.value;">
                    </div>

                    <!-- Wall Height Ratio (10%-80%, default 40%) & Top Roof Size (10%-90%, default 50%) -->
                    <div class="control-row" style="margin-bottom: 0;">
                        <div class="control-label-group">
                            <span class="control-label">Wall Height (Ground):</span>
                            <input type="number" class="control-num-input" value="${Math.round((selected.wallRatio !== undefined ? selected.wallRatio : 0.40) * 100)}" step="5" min="10" max="80" onchange="effectsManager.updateEffectParam('${selected.id}', 'wallRatio', parseFloat(this.value)/100); this.closest('.control-row').querySelector('input[type=range]').value=parseFloat(this.value)/100;">
                        </div>
                        <input type="range" min="0.1" max="0.8" step="0.05" value="${selected.wallRatio !== undefined ? selected.wallRatio : 0.40}" oninput="effectsManager.updateEffectParam('${selected.id}', 'wallRatio', parseFloat(this.value)); this.closest('.control-row').querySelector('input[type=number]').value=Math.round(parseFloat(this.value)*100);">
                    </div>
                    <div class="control-row" style="margin-bottom: 0;">
                        <div class="control-label-group">
                            <span class="control-label">Top Roof Size:</span>
                            <input type="number" class="control-num-input" value="${Math.round((selected.topRatio !== undefined ? selected.topRatio : 0.50) * 100)}" step="5" min="10" max="90" onchange="effectsManager.updateEffectParam('${selected.id}', 'topRatio', parseFloat(this.value)/100); this.closest('.control-row').querySelector('input[type=range]').value=parseFloat(this.value)/100;">
                        </div>
                        <input type="range" min="0.1" max="0.9" step="0.05" value="${selected.topRatio !== undefined ? selected.topRatio : 0.50}" oninput="effectsManager.updateEffectParam('${selected.id}', 'topRatio', parseFloat(this.value)); this.closest('.control-row').querySelector('input[type=number]').value=Math.round(parseFloat(this.value)*100);">
                    </div>

                    <!-- Corner Chamfer (10%-80%, default 50%) & Conform Strength (Default 50%) -->
                    <div class="control-row" style="margin-bottom: 0;">
                        <div class="control-label-group">
                            <span class="control-label">Corner Chamfer:</span>
                            <input type="number" class="control-num-input" value="${Math.round((selected.chamfer !== undefined ? selected.chamfer : 0.50) * 100)}" step="5" min="10" max="80" onchange="effectsManager.updateEffectParam('${selected.id}', 'chamfer', parseFloat(this.value)/100); this.closest('.control-row').querySelector('input[type=range]').value=parseFloat(this.value)/100;">
                        </div>
                        <input type="range" min="0.1" max="0.8" step="0.05" value="${selected.chamfer !== undefined ? selected.chamfer : 0.50}" oninput="effectsManager.updateEffectParam('${selected.id}', 'chamfer', parseFloat(this.value)); this.closest('.control-row').querySelector('input[type=number]').value=Math.round(parseFloat(this.value)*100);">
                    </div>
                    <div class="control-row" style="margin-bottom: 0;">
                        <div class="control-label-group">
                            <span class="control-label">Conform Strength:</span>
                            <input type="number" class="control-num-input" value="${Math.round((selected.strength !== undefined ? selected.strength : 0.5) * 100)}" step="5" min="0" max="100" onchange="effectsManager.updateEffectParam('${selected.id}', 'strength', parseFloat(this.value)/100); this.closest('.control-row').querySelector('input[type=range]').value=parseFloat(this.value)/100;">
                        </div>
                        <input type="range" min="0" max="1" step="0.01" value="${selected.strength !== undefined ? selected.strength : 0.5}" oninput="effectsManager.updateEffectParam('${selected.id}', 'strength', parseFloat(this.value)); this.closest('.control-row').querySelector('input[type=number]').value=Math.round(parseFloat(this.value)*100);">
                    </div>

                    <!-- Position 3D (X, Y, Z) - Compact on single line -->
                    <div class="control-row" style="grid-column: span 2; margin-bottom: 0;">
                        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 2px;">
                            <span class="control-label">3D Center (Position):</span>
                        </div>
                        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; align-items: center;">
                            <div style="display: flex; align-items: center; gap: 3px;">
                                <span style="color: #ef4444; font-weight: bold; font-size: 0.70rem; width: 10px;">X</span>
                                <input type="number" class="control-num-input" style="width: 36px; padding: 1px 2px; font-size: 0.70rem;" value="${selected.position.x.toFixed(2)}" step="0.05" onchange="effectsManager.updateEffectPos('${selected.id}', 'x', this.value); this.parentElement.querySelector('input[type=range]').value=this.value;">
                                <input type="range" style="flex: 1; min-width: 0;" min="-3.0" max="3.0" step="0.05" value="${selected.position.x}" oninput="effectsManager.updateEffectPos('${selected.id}', 'x', this.value); this.parentElement.querySelector('input[type=number]').value=parseFloat(this.value).toFixed(2);">
                            </div>
                            <div style="display: flex; align-items: center; gap: 3px;">
                                <span style="color: #10b981; font-weight: bold; font-size: 0.70rem; width: 10px;">Y</span>
                                <input type="number" class="control-num-input" style="width: 36px; padding: 1px 2px; font-size: 0.70rem;" value="${selected.position.y.toFixed(2)}" step="0.05" onchange="effectsManager.updateEffectPos('${selected.id}', 'y', this.value); this.parentElement.querySelector('input[type=range]').value=this.value;">
                                <input type="range" style="flex: 1; min-width: 0;" min="-3.0" max="3.0" step="0.05" value="${selected.position.y}" oninput="effectsManager.updateEffectPos('${selected.id}', 'y', this.value); this.parentElement.querySelector('input[type=number]').value=parseFloat(this.value).toFixed(2);">
                            </div>
                            <div style="display: flex; align-items: center; gap: 3px;">
                                <span style="color: #3b82f6; font-weight: bold; font-size: 0.70rem; width: 10px;">Z</span>
                                <input type="number" class="control-num-input" style="width: 36px; padding: 1px 2px; font-size: 0.70rem;" value="${selected.position.z.toFixed(2)}" step="0.05" onchange="effectsManager.updateEffectPos('${selected.id}', 'z', this.value); this.parentElement.querySelector('input[type=range]').value=this.value;">
                                <input type="range" style="flex: 1; min-width: 0;" min="-3.0" max="3.0" step="0.05" value="${selected.position.z}" oninput="effectsManager.updateEffectPos('${selected.id}', 'z', this.value); this.parentElement.querySelector('input[type=number]').value=parseFloat(this.value).toFixed(2);">
                            </div>
                        </div>
                    </div>
                </div>
            `;
        } else if (selected.type === 'shaper_in' || selected.type === 'shaper_out') {
            const isOut = (selected.type === 'shaper_out');
            detailEl.innerHTML = `
                <div class="effect-header-row" style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.06); padding-bottom: 4px;">
                    <span style="font-size: 0.80rem; font-weight: 600; color: ${isOut ? '#a855f7' : '#f59e0b'};">
                        ${isOut ? '✨ Shaper Out (Animation End)' : '💥 Shaper In (Animation Start)'}
                    </span>
                    <span style="font-size: 0.72rem; color: #94a3b8; font-family: 'JetBrains Mono', monospace;">
                        ${isOut ? 'Frames End → 100%' : 'Frames 0 → Start'}
                    </span>
                </div>

                <div class="shaper-params-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 5px 10px; font-size: 0.74rem;">
                    <!-- Primitive & Mode -->
                    <div class="control-row" style="margin-bottom: 0;">
                        <span class="control-label">Primitive:</span>
                        <select class="control-select-sm" onchange="effectsManager.updateEffectParam('${selected.id}', 'primitive', this.value)">
                            <option value="half_sphere" selected>Half-Sphere (Dome)</option>
                        </select>
                    </div>
                    <div class="control-row" style="margin-bottom: 0;">
                        <span class="control-label">Mode:</span>
                        <select class="control-select-sm" onchange="effectsManager.updateEffectParam('${selected.id}', 'mode', this.value); effectsManager.renderUI();">
                            <option value="heat" ${selected.mode==='heat'?'selected':''}>Emissive Heat</option>
                            <option value="attract" ${selected.mode==='attract'?'selected':''}>Attract</option>
                            <option value="repulse" ${selected.mode==='repulse'?'selected':''}>Repulsion</option>
                            <option value="heat_attract" ${selected.mode==='heat_attract'?'selected':''}>Heat + Attract</option>
                            <option value="heat_repulse" ${selected.mode==='heat_repulse'?'selected':''}>Heat + Repulsion</option>
                        </select>
                    </div>

                    <!-- Magnitude & Range -->
                    <div class="control-row" style="margin-bottom: 0;">
                        <div class="control-label-group">
                            <span class="control-label">Magnitude:</span>
                            <input type="number" class="control-num-input" value="${selected.magnitude}" step="0.1" min="-3" max="3" onchange="effectsManager.updateEffectParam('${selected.id}', 'magnitude', parseFloat(this.value)); this.closest('.control-row').querySelector('input[type=range]').value=this.value;">
                        </div>
                        <input type="range" min="-3" max="3" step="0.1" value="${selected.magnitude}" oninput="effectsManager.updateEffectParam('${selected.id}', 'magnitude', parseFloat(this.value)); this.closest('.control-row').querySelector('input[type=number]').value=this.value;">
                    </div>
                    <div class="control-row" style="margin-bottom: 0;">
                        <div class="control-label-group">
                            <span class="control-label">Range:</span>
                            <input type="number" class="control-num-input" value="${selected.range}" step="0.05" min="0.1" max="4" onchange="effectsManager.updateEffectParam('${selected.id}', 'range', parseFloat(this.value)); this.closest('.control-row').querySelector('input[type=range]').value=this.value;">
                        </div>
                        <input type="range" min="0.1" max="4" step="0.05" value="${selected.range}" oninput="effectsManager.updateEffectParam('${selected.id}', 'range', parseFloat(this.value)); this.closest('.control-row').querySelector('input[type=number]').value=this.value;">
                    </div>

                    <!-- Falloff & Emissive Heat -->
                    <div class="control-row" style="margin-bottom: 0;">
                        <span class="control-label">Falloff:</span>
                        <select class="control-select-sm" onchange="effectsManager.updateEffectParam('${selected.id}', 'falloffType', this.value)">
                            <option value="smoothstep" ${selected.falloffType==='smoothstep'?'selected':''}>Smoothstep (Soft)</option>
                            <option value="linear" ${selected.falloffType==='linear'?'selected':''}>Linear</option>
                            <option value="quadratic" ${selected.falloffType==='quadratic'?'selected':''}>Quadratic</option>
                        </select>
                    </div>
                    <div class="control-row" style="margin-bottom: 0;">
                        <div class="control-label-group">
                            <span class="control-label">Emissive Heat:</span>
                            <input type="number" class="control-num-input" value="${selected.heat}" step="0.1" min="0" max="5" onchange="effectsManager.updateEffectParam('${selected.id}', 'heat', parseFloat(this.value)); this.closest('.control-row').querySelector('input[type=range]').value=this.value;">
                        </div>
                        <input type="range" min="0" max="5" step="0.1" value="${selected.heat}" oninput="effectsManager.updateEffectParam('${selected.id}', 'heat', parseFloat(this.value)); this.closest('.control-row').querySelector('input[type=number]').value=this.value;">
                    </div>

                    <!-- Position 3D (X, Y, Z) - Compact on single line -->
                    <div class="control-row" style="grid-column: span 2; margin-bottom: 0;">
                        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 2px;">
                            <span class="control-label">3D Position:</span>
                        </div>
                        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; align-items: center;">
                            <div style="display: flex; align-items: center; gap: 3px;">
                                <span style="color: #ef4444; font-weight: bold; font-size: 0.70rem; width: 10px;">X</span>
                                <input type="number" class="control-num-input" style="width: 36px; padding: 1px 2px; font-size: 0.70rem;" value="${selected.position.x.toFixed(2)}" step="0.05" onchange="effectsManager.updateEffectPos('${selected.id}', 'x', this.value); this.parentElement.querySelector('input[type=range]').value=this.value;">
                                <input type="range" style="flex: 1; min-width: 0;" min="-2.5" max="2.5" step="0.05" value="${selected.position.x}" oninput="effectsManager.updateEffectPos('${selected.id}', 'x', this.value); this.parentElement.querySelector('input[type=number]').value=parseFloat(this.value).toFixed(2);">
                            </div>
                            <div style="display: flex; align-items: center; gap: 3px;">
                                <span style="color: #10b981; font-weight: bold; font-size: 0.70rem; width: 10px;">Y</span>
                                <input type="number" class="control-num-input" style="width: 36px; padding: 1px 2px; font-size: 0.70rem;" value="${selected.position.y.toFixed(2)}" step="0.05" onchange="effectsManager.updateEffectPos('${selected.id}', 'y', this.value); this.parentElement.querySelector('input[type=range]').value=this.value;">
                                <input type="range" style="flex: 1; min-width: 0;" min="-2.5" max="2.5" step="0.05" value="${selected.position.y}" oninput="effectsManager.updateEffectPos('${selected.id}', 'y', this.value); this.parentElement.querySelector('input[type=number]').value=parseFloat(this.value).toFixed(2);">
                            </div>
                            <div style="display: flex; align-items: center; gap: 3px;">
                                <span style="color: #3b82f6; font-weight: bold; font-size: 0.70rem; width: 10px;">Z</span>
                                <input type="number" class="control-num-input" style="width: 36px; padding: 1px 2px; font-size: 0.70rem;" value="${selected.position.z.toFixed(2)}" step="0.05" onchange="effectsManager.updateEffectPos('${selected.id}', 'z', this.value); this.parentElement.querySelector('input[type=range]').value=this.value;">
                                <input type="range" style="flex: 1; min-width: 0;" min="-2.5" max="2.5" step="0.05" value="${selected.position.z}" oninput="effectsManager.updateEffectPos('${selected.id}', 'z', this.value); this.parentElement.querySelector('input[type=number]').value=parseFloat(this.value).toFixed(2);">
                            </div>
                        </div>
                    </div>

                    <!-- Radius & Orientation -->
                    <div class="control-row" style="margin-bottom: 0;">
                        <div class="control-label-group">
                            <span class="control-label">Radius:</span>
                            <input type="number" class="control-num-input" value="${selected.radius}" step="0.05" min="0.1" max="4" onchange="effectsManager.updateEffectParam('${selected.id}', 'radius', parseFloat(this.value)); this.closest('.control-row').querySelector('input[type=range]').value=this.value;">
                        </div>
                        <input type="range" min="0.1" max="4" step="0.05" value="${selected.radius}" oninput="effectsManager.updateEffectParam('${selected.id}', 'radius', parseFloat(this.value)); this.closest('.control-row').querySelector('input[type=number]').value=this.value;">
                    </div>
                    <div class="control-row" style="margin-bottom: 0;">
                        <span class="control-label">Orientation:</span>
                        <select class="control-select-sm" onchange="effectsManager.updateEffectParam('${selected.id}', 'direction', this.value)">
                            <option value="up" ${selected.direction==='up'?'selected':''}>Up (+Y)</option>
                            <option value="down" ${selected.direction==='down'?'selected':''}>Down (-Y)</option>
                            <option value="forward" ${selected.direction==='forward'?'selected':''}>Forward (+Z)</option>
                            <option value="back" ${selected.direction==='back'?'selected':''}>Back (-Z)</option>
                            <option value="right" ${selected.direction==='right'?'selected':''}>Right (+X)</option>
                            <option value="left" ${selected.direction==='left'?'selected':''}>Left (-X)</option>
                        </select>
                    </div>

                    <!-- Timeline range -->
                    <div class="control-row" style="grid-column: span 2; margin-bottom: 0; display: flex; align-items: center; gap: 8px;">
                        <span class="control-label" style="min-width: 90px;">${isOut ? 'Effect Start:' : 'Effect End:'}</span>
                        <input type="range" style="flex:1;" min="5" max="95" step="1" value="${Math.round((isOut ? selected.timeStart : selected.timeEnd) * 100)}" oninput="effectsManager.updateEffectTiming('${selected.id}', parseInt(this.value) / 100); this.nextElementSibling.textContent=this.value + '%';">
                        <span style="font-family: 'JetBrains Mono', monospace; font-size: 0.74rem; color: #e2e8f0; width: 38px;">${Math.round((isOut ? selected.timeStart : selected.timeEnd) * 100)}%</span>
                        <span style="color: #94a3b8; font-size: 0.70rem;">(${isOut ? 'Smooth Fade In' : 'Smooth Fade Out'})</span>
                    </div>
                </div>
            `;
        }
    }
}

if (typeof window !== 'undefined') {
    window.BaseSplatEffect = BaseSplatEffect;
    window.HeightOverTimeEffect = HeightOverTimeEffect;
    window.ScaleOverTimeEffect = ScaleOverTimeEffect;
    window.EmissiveOverTimeEffect = EmissiveOverTimeEffect;
    window.LuminanceEmissiveEffect = LuminanceEmissiveEffect;
    window.HsvMixTintEffect = HsvMixTintEffect;
    window.SmoothEffect = SmoothEffect;
    window.SpherifyEffect = SpherifyEffect;
    window.IsometricProxyEffect = IsometricProxyEffect;
    window.ShaperEffect = ShaperEffect;
    window.HeightOverTimeCanvas = HeightOverTimeCanvas;
    window.SplatEffectsManager = SplatEffectsManager;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        BaseSplatEffect,
        HeightOverTimeEffect,
        ScaleOverTimeEffect,
        EmissiveOverTimeEffect,
        LuminanceEmissiveEffect,
        HsvMixTintEffect,
        SmoothEffect,
        SpherifyEffect,
        IsometricProxyEffect,
        ShaperEffect,
        HeightOverTimeCanvas,
        SplatEffectsManager
    };
}
