// Procedural Explosion & FX Generator for testing 2.5D Gaussian Splats Baker
// Generates realistic multi-phase explosion sequences (Ignition -> Fireball -> Smoke Plumes & Tendrils -> Sparks & Shockwave -> Dissipation)

class SampleExplosionGenerator {
    constructor() {
        this.width = 384;
        this.height = 384;
        this.frameCount = 60;
        this.fps = 30;
    }

    // Generate procedural frames on an offscreen canvas
    generateSequence(onProgress) {
        return new Promise((resolve) => {
            const canvas = document.createElement('canvas');
            canvas.width = this.width;
            canvas.height = this.height;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });

            const frames = [];
            const particles = [];
            const numParticles = 140;

            // Initialize simulation particles for explosion
            for (let i = 0; i < numParticles; i++) {
                const angle = Math.random() * Math.PI * 2;
                const speed = 1.2 + Math.random() * 5.5;
                const size = 12 + Math.random() * 32;
                const lift = -0.4 - Math.random() * 1.8; // Upward buoyant draft
                const delay = Math.random() * 10;
                const temp = 0.8 + Math.random() * 0.4;
                const type = Math.random() > 0.3 ? 'smoke' : 'spark';

                particles.push({
                    x: this.width / 2 + (Math.random() - 0.5) * 16,
                    y: this.height * 0.58 + (Math.random() - 0.5) * 16,
                    vx: Math.cos(angle) * speed,
                    vy: Math.sin(angle) * speed + lift,
                    baseSize: size,
                    size: size,
                    delay: delay,
                    temp: temp,
                    type: type,
                    spin: (Math.random() - 0.5) * 0.1,
                    angle: Math.random() * Math.PI * 2
                });
            }

            // Shockwave rings
            const shockwaves = [
                { startFrame: 4, maxRadius: 180, duration: 25 },
                { startFrame: 9, maxRadius: 140, duration: 20 }
            ];

            let currentFrame = 0;

            const renderFrame = () => {
                if (currentFrame >= this.frameCount) {
                    resolve(frames);
                    return;
                }

                const t = currentFrame;
                const progress = t / (this.frameCount - 1);

                // Background: dark transparent or pure black
                ctx.fillStyle = '#000000';
                ctx.fillRect(0, 0, this.width, this.height);

                // Phase 1: Initial Flash (Frames 0 to 8)
                if (t < 12) {
                    const flashRadius = Math.sin((t / 12) * Math.PI) * 120;
                    const flashGrad = ctx.createRadialGradient(
                        this.width / 2, this.height * 0.58, 0,
                        this.width / 2, this.height * 0.58, flashRadius + 20
                    );
                    flashGrad.addColorStop(0, 'rgba(255, 255, 230, 0.95)');
                    flashGrad.addColorStop(0.3, 'rgba(255, 180, 50, 0.8)');
                    flashGrad.addColorStop(0.7, 'rgba(255, 70, 10, 0.4)');
                    flashGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
                    ctx.fillStyle = flashGrad;
                    ctx.beginPath();
                    ctx.arc(this.width / 2, this.height * 0.58, flashRadius + 20, 0, Math.PI * 2);
                    ctx.fill();
                }

                // Phase 2: Shockwaves
                for (const sw of shockwaves) {
                    if (t >= sw.startFrame && t < sw.startFrame + sw.duration) {
                        const swAge = (t - sw.startFrame) / sw.duration;
                        const r = swAge * sw.maxRadius;
                        const alpha = (1 - swAge) * 0.5;
                        ctx.strokeStyle = `rgba(255, 200, 120, ${alpha})`;
                        ctx.lineWidth = 4 * (1 - swAge);
                        ctx.beginPath();
                        ctx.arc(this.width / 2, this.height * 0.58, r, 0, Math.PI * 2);
                        ctx.stroke();
                    }
                }

                // Phase 3: Volumetric Particles & Smoke Plumes
                particles.sort((a, b) => (b.type === 'smoke' ? 1 : -1));

                for (const p of particles) {
                    if (t < p.delay) continue;
                    const age = (t - p.delay) / (this.frameCount - p.delay);
                    if (age >= 1.0) continue;

                    // Physics update
                    const drag = 0.94;
                    const currentVx = p.vx * Math.pow(drag, t - p.delay);
                    const currentVy = p.vy * Math.pow(drag, t - p.delay) - 0.4 * age; // buoyancy
                    const px = p.x + currentVx * (t - p.delay);
                    const py = p.y + currentVy * (t - p.delay);

                    p.size = p.baseSize * (1.0 + age * 2.5); // Plume expansion

                    if (p.type === 'smoke') {
                        // Temperature cools from fire orange to dark smoky charcoal
                        const temp = Math.max(0, p.temp - age * 1.3);
                        let r, g, b, a;

                        if (temp > 0.5) {
                            // Fire core
                            const f = (temp - 0.5) / 0.5;
                            r = 255;
                            g = Math.floor(100 + 155 * f);
                            b = Math.floor(20 + 80 * f);
                            a = (1.0 - age * 0.7) * 0.9;
                        } else if (temp > 0.1) {
                            // Glowing ember smoke
                            const f = (temp - 0.1) / 0.4;
                            r = Math.floor(180 * f + 60 * (1 - f));
                            g = Math.floor(60 * f + 40 * (1 - f));
                            b = Math.floor(20 * f + 30 * (1 - f));
                            a = (1.0 - age * 0.8) * 0.85;
                        } else {
                            // Billowing smoke fumerolle
                            const shade = Math.floor(50 + 40 * Math.sin(p.angle));
                            r = shade;
                            g = shade - 5;
                            b = shade - 5;
                            a = (1.0 - age) * 0.75;
                        }

                        // Draw soft gradient cloud
                        const radGrad = ctx.createRadialGradient(
                            px, py, 0,
                            px, py, p.size
                        );
                        radGrad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${a})`);
                        radGrad.addColorStop(0.5, `rgba(${Math.floor(r * 0.7)}, ${Math.floor(g * 0.7)}, ${Math.floor(b * 0.7)}, ${a * 0.6})`);
                        radGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');

                        ctx.fillStyle = radGrad;
                        ctx.beginPath();
                        ctx.arc(px, py, p.size, 0, Math.PI * 2);
                        ctx.fill();
                    } else {
                        // Sparks / Debris tendril
                        const sparkAlpha = (1.0 - age) * 0.95;
                        ctx.fillStyle = `rgba(255, 240, 150, ${sparkAlpha})`;
                        ctx.beginPath();
                        ctx.arc(px, py, 2.5 + (1 - age) * 2, 0, Math.PI * 2);
                        ctx.fill();

                        // Spark trail
                        ctx.strokeStyle = `rgba(255, 120, 20, ${sparkAlpha * 0.5})`;
                        ctx.lineWidth = 1.5;
                        ctx.beginPath();
                        ctx.moveTo(px, py);
                        ctx.lineTo(px - currentVx * 2.0, py - currentVy * 2.0);
                        ctx.stroke();
                    }
                }

                // Phase 4: Core Fireball Turbulence
                if (t >= 3 && t < 35) {
                    const coreAge = (t - 3) / 32;
                    const coreRadius = Math.sin(coreAge * Math.PI * 0.8) * 65 + 10;
                    const coreAlpha = (1 - coreAge * 0.9) * 0.75;

                    const coreGrad = ctx.createRadialGradient(
                        this.width / 2 + Math.sin(t * 0.3) * 6,
                        this.height * 0.56 - t * 0.5,
                        0,
                        this.width / 2,
                        this.height * 0.56 - t * 0.5,
                        coreRadius
                    );
                    coreGrad.addColorStop(0, `rgba(255, 255, 200, ${coreAlpha})`);
                    coreGrad.addColorStop(0.4, `rgba(255, 140, 30, ${coreAlpha * 0.8})`);
                    coreGrad.addColorStop(0.8, `rgba(180, 40, 10, ${coreAlpha * 0.3})`);
                    coreGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');

                    ctx.fillStyle = coreGrad;
                    ctx.beginPath();
                    ctx.arc(this.width / 2, this.height * 0.56 - t * 0.5, coreRadius, 0, Math.PI * 2);
                    ctx.fill();
                }

                // Capture frame as ImageData
                const imgData = ctx.getImageData(0, 0, this.width, this.height);
                frames.push(imgData);

                currentFrame++;
                if (onProgress) {
                    onProgress(currentFrame / this.frameCount);
                }

                // Schedule next frame
                setTimeout(renderFrame, 4);
            };

            renderFrame();
        });
    }

    // Convert frames to a downloadable MP4 or WebM blob or sequence
    createVideoBlob(frames) {
        return new Promise((resolve) => {
            const canvas = document.createElement('canvas');
            canvas.width = this.width;
            canvas.height = this.height;
            const ctx = canvas.getContext('2d');

            const stream = canvas.captureStream(this.fps);
            let mediaRecorder;
            try {
                mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm; codecs=vp9' });
            } catch (e) {
                try {
                    mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
                } catch (e2) {
                    mediaRecorder = new MediaRecorder(stream);
                }
            }

            const chunks = [];
            mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) chunks.push(e.data);
            };

            mediaRecorder.onstop = () => {
                const blob = new Blob(chunks, { type: mediaRecorder.mimeType || 'video/webm' });
                resolve(blob);
            };

            mediaRecorder.start();

            let idx = 0;
            const interval = 1000 / this.fps;
            const drawInterval = setInterval(() => {
                if (idx >= frames.length) {
                    clearInterval(drawInterval);
                    setTimeout(() => mediaRecorder.stop(), 200);
                    return;
                }
                ctx.putImageData(frames[idx], 0, 0);
                idx++;
            }, interval);
        });
    }
}

window.SampleExplosionGenerator = SampleExplosionGenerator;
